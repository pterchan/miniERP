#!/usr/bin/env python3
"""Idempotently load the protected workbook into the ERP staging/seed model.

The command deliberately posts only unambiguous, valid historical receipts and
issues.  Transfer rows without a reviewed destination and all invalid source
rows remain candidates/conflicts.  Run with --apply to mutate PostgreSQL;
without it the source is parsed and a summary is printed.
"""

from __future__ import annotations

import argparse
import json
import os
import unicodedata
from collections import defaultdict
from datetime import date
from pathlib import Path
from typing import Any

import psycopg2
from psycopg2.extras import Json

from import_inventory import build_report, normalize_identifier, normalize_text, parse_quantity


def db_url() -> str:
    return os.environ.get("DATABASE_URL", "postgresql://inventory:<password>@localhost:5432/inventory")


def norm(value: Any) -> str | None:
    return normalize_identifier(value)


def source_unit(source: dict[str, Any]) -> str | None:
    """Return a whitelisted source unit cell without exposing unrelated fields."""
    for key, value in source.items():
        if value is not None and ("单位" in str(key) or str(key).lower() in {"uom", "unit"}):
            return str(value)
    return None


def uom_id_for(conn: Any, raw: str | None, fallback: int) -> int:
    """Resolve a source unit to the dictionary; never perform a quantity conversion."""
    value = normalize_text(raw) if raw is not None else None
    if not value:
        return fallback
    aliases = {
        "个": "EA", "件": "EA", "台": "EA", "只": "EA", "部": "EA", "块": "EA", "枚": "EA", "支": "EA",
        "盒": "BOX", "箱": "BOX", "包": "BOX", "套": "SET", "米": "M", "m": "M",
        "公斤": "KG", "千克": "KG", "升": "L",
    }
    code = aliases.get(value, value.upper())
    row = one(conn, "SELECT uom_id FROM uom WHERE code=%s AND is_active", (code,))
    return int(row["uom_id"]) if row else fallback


def set_context(conn: Any, action: str) -> None:
    with conn.cursor() as cur:
        cur.execute("SELECT set_config('app.actor_id','SYSTEM',true), set_config('app.audit_action',%s,true)", (action,))


def audit(conn: Any, action: str, table: str, target_id: int | None = None, after: Any = None, source_batch: int | None = None) -> None:
    set_context(conn, action)
    with conn.cursor() as cur:
        cur.execute("""INSERT INTO audit_event(actor_role,action,target_table,target_id,after_data,import_batch_id)
                       VALUES ('SYSTEM',%s,%s,%s,%s,%s)""", (action, table, target_id, Json(after) if after is not None else None, source_batch))


def one(conn: Any, sql: str, args: tuple[Any, ...] = ()) -> dict[str, Any] | None:
    with conn.cursor() as cur:
        cur.execute(sql, args)
        row = cur.fetchone()
        if row is None:
            return None
        return dict(zip([d.name for d in cur.description], row))


def source_record(conn: Any, batch_id: int, item: dict[str, Any], sheet: str, block: str, row_number: int, status_id: int) -> int:
    row_hash = __import__("hashlib").sha256(json.dumps(item, ensure_ascii=False, sort_keys=True, default=str).encode()).hexdigest()
    with conn.cursor() as cur:
        cur.execute("""INSERT INTO source_record(import_batch_id,sheet_name,block_name,source_row_number,row_hash,raw_values,display_values,normalized_values,parse_status_id)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                       ON CONFLICT (import_batch_id,sheet_name,block_name,source_row_number)
                       DO UPDATE SET row_hash=EXCLUDED.row_hash,raw_values=EXCLUDED.raw_values,display_values=EXCLUDED.display_values,normalized_values=EXCLUDED.normalized_values
                       RETURNING source_record_id""", (batch_id, sheet, block, row_number, row_hash, Json(item), Json(item), Json(item), status_id))
        return int(cur.fetchone()[0])


def open_case(conn: Any, source_record_id: int, case_type: str, status_id: int, notes: str, source_batch: int | None = None) -> bool:
    """Open one pending case per source row/type so re-imports stay idempotent."""
    if one(conn, "SELECT resolution_case_id FROM resolution_case WHERE source_record_id=%s AND case_type=%s AND status_id=%s", (source_record_id, case_type, status_id)):
        return False
    audit(conn, "OPEN_CONFLICT", "resolution_case", after={"source_record_id": source_record_id, "case_type": case_type}, source_batch=source_batch)
    with conn.cursor() as cur:
        cur.execute("INSERT INTO resolution_case(source_record_id,case_type,status_id,resolution_notes) VALUES (%s,%s,%s,%s)", (source_record_id, case_type, status_id, notes))
    return True


def record_quality_issue(conn: Any, source_record_id: int, issue_code: str, status_id: int, message: str, raw_value: str | None = None, product_observation_id: int | None = None, movement_candidate_id: int | None = None, source_batch: int | None = None) -> bool:
    if one(conn, "SELECT data_quality_issue_id FROM data_quality_issue WHERE source_record_id=%s AND issue_code=%s AND status_id=%s", (source_record_id, issue_code, status_id)):
        return False
    audit(conn, "QUALITY_ISSUE", "data_quality_issue", after={"source_record_id": source_record_id, "issue_code": issue_code}, source_batch=source_batch)
    with conn.cursor() as cur:
        cur.execute("""INSERT INTO data_quality_issue(source_record_id,product_observation_id,movement_candidate_id,issue_code,severity,status_id,message,raw_value)
                     VALUES (%s,%s,%s,%s,'error',%s,%s,%s)""", (source_record_id, product_observation_id, movement_candidate_id, issue_code, status_id, message, raw_value))
    return True


def key_from_product(row: dict[str, Any]) -> tuple[str | None, str | None]:
    return row.get("identifier_normalized"), row.get("name_normalized")


def load(args: argparse.Namespace) -> dict[str, Any]:
    report = build_report(Path(args.input), args.password)
    if not args.apply:
        return {"mode": "dry-run", **report["summary"]}
    conn = psycopg2.connect(db_url())
    conn.autocommit = False
    counts: defaultdict[str, int] = defaultdict(int)
    try:
        with conn.cursor() as cur:
            status_imported = one(conn, "SELECT status_id FROM record_status WHERE code='imported'")["status_id"]
            status_observed = one(conn, "SELECT status_id FROM record_status WHERE code='observed'")["status_id"]
            status_review = one(conn, "SELECT status_id FROM record_status WHERE code='pending_review'")["status_id"]
            status_active = one(conn, "SELECT status_id FROM record_status WHERE code='active'")["status_id"]
            posted_id = one(conn, "SELECT status_id FROM record_status WHERE code='posted'")["status_id"]
            new_condition = one(conn, "SELECT condition_id FROM inventory_condition WHERE code='new'")["condition_id"]
            # Keep dictionary units and source text separately; no implicit
            # BOX/SET/M/ML conversion is performed by the seed.
            unknown_uom = int(one(conn, "SELECT uom_id FROM uom WHERE code='UNKNOWN'")["uom_id"])
            cur.execute("""INSERT INTO import_batch(source_file_name,source_sha256,source_file_size,password_protected,status_id,importer_version)
                           VALUES (%s,%s,%s,%s,%s,%s)
                           ON CONFLICT (source_sha256) DO UPDATE SET source_file_name=EXCLUDED.source_file_name
                           RETURNING import_batch_id""", (report["summary"]["source_file_name"], report["summary"]["source_sha256"], Path(args.input).stat().st_size, True, status_imported, "erp-poc-0.1"))
            batch_id = int(cur.fetchone()[0])

            # Main warehouse is the only implicit formal location.
            org = one(conn, "SELECT organization_id FROM organization WHERE organization_type='company' AND name='公司'")
            if not org:
                audit(conn, "SEED_ORGANIZATION", "organization", after={"name": "公司"}, source_batch=batch_id)
                cur.execute("INSERT INTO organization(organization_type,name,is_company_entity) VALUES ('company','公司',true) RETURNING organization_id")
                org = {"organization_id": cur.fetchone()[0]}
            location = one(conn, "SELECT location_id FROM location WHERE code='MAIN'")
            if not location:
                audit(conn, "SEED_LOCATION", "location", after={"code": "MAIN", "name": "主仓库"}, source_batch=batch_id)
                cur.execute("INSERT INTO location(organization_id,location_type,code,name,is_company_inventory) VALUES (%s,'warehouse','MAIN','主仓库',true) RETURNING location_id", (org["organization_id"],))
                location = {"location_id": cur.fetchone()[0]}
            main_location = int(location["location_id"])

            product_ids: dict[tuple[str | None, str | None], int] = {}
            product_uoms: dict[int, int] = {}
            source_ids: dict[tuple[str, str, int], int] = {}
            # Asset and intentionally non-posting sheets are still retained as
            # safe observations, never as inventory movements.
            for asset_obs in report["asset_observations"]:
                sid = source_record(conn, batch_id, asset_obs.get("source", {}), asset_obs["sheet"], "assets", asset_obs["source_row_number"], status_observed)
                serials = asset_obs.get("serial_candidates", [])
                serial_raw = " | ".join(str(x) for x in serials) or None
                cur.execute("""INSERT INTO asset_observation(source_record_id,observation_ordinal,serial_raw,serial_normalized,resolution_status_id,notes)
                             VALUES (%s,1,%s,%s,%s,%s)
                             ON CONFLICT (source_record_id,observation_ordinal) DO UPDATE SET serial_raw=EXCLUDED.serial_raw,serial_normalized=EXCLUDED.serial_normalized,notes=EXCLUDED.notes""", (sid, serial_raw, norm(serials[0]) if serials else None, status_observed, "序列号仅作为观察，待厂家命名空间审核后关联"))
                counts["asset_observations_loaded"] += 1
            for staged in report["stage_only"]:
                source_record(conn, batch_id, staged.get("source", {}), staged["sheet"], "stage_only", staged["source_row_number"], status_observed)
                counts["stage_only_loaded"] += 1
            for obs in report["product_observations"]:
                sid = source_record(conn, batch_id, obs.get("source", {}), obs["sheet"], "products", obs["source_row_number"], status_observed)
                source_ids[(obs["sheet"], "products", obs["source_row_number"])] = sid
                key = key_from_product(obs)
                src = obs.get("source", {})
                raw_uom = source_unit(src)
                opening, opening_issue = parse_quantity(src.get("期初库存"))
                existing_qty, existing_issue = parse_quantity(src.get("现有库存"))
                observation_status = status_active if obs.get("resolution_status") == "candidate_exact" else status_review
                cur.execute("""INSERT INTO product_observation(source_record_id,observation_ordinal,source_identifier_raw,source_identifier_normalized,source_name_raw,source_name_normalized,uom_raw,opening_quantity_raw,opening_quantity,existing_quantity_raw,existing_quantity,resolution_status_id,match_method)
                             VALUES (%s,1,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                             ON CONFLICT (source_record_id,observation_ordinal) DO UPDATE SET source_identifier_raw=EXCLUDED.source_identifier_raw,source_identifier_normalized=EXCLUDED.source_identifier_normalized,source_name_raw=EXCLUDED.source_name_raw,source_name_normalized=EXCLUDED.source_name_normalized,uom_raw=EXCLUDED.uom_raw,opening_quantity_raw=EXCLUDED.opening_quantity_raw,opening_quantity=EXCLUDED.opening_quantity,existing_quantity_raw=EXCLUDED.existing_quantity_raw,existing_quantity=EXCLUDED.existing_quantity,resolution_status_id=EXCLUDED.resolution_status_id,match_method=EXCLUDED.match_method
                             RETURNING product_observation_id""", (sid, str(obs.get("identifier_raw")) if obs.get("identifier_raw") is not None else None, obs.get("identifier_normalized"), str(obs.get("name_raw")) if obs.get("name_raw") is not None else None, obs.get("name_normalized"), raw_uom, str(src.get("期初库存")) if src.get("期初库存") is not None else None, opening, str(src.get("现有库存")) if src.get("现有库存") is not None else None, existing_qty, observation_status, obs.get("match_method")))
                product_observation_id = int(cur.fetchone()[0])
                counts["product_observations_loaded"] += 1
                for issue_code, raw in ((opening_issue, src.get("期初库存")), (existing_issue, src.get("现有库存"))):
                    if issue_code and record_quality_issue(conn, sid, issue_code, status_review, "库存汇总数量需要仓管复核", str(raw) if raw is not None else None, product_observation_id=product_observation_id, source_batch=batch_id):
                        counts["quality_issues"] += 1
                if obs.get("resolution_status") != "candidate_exact":
                    if open_case(conn, sid, "identifier_collision", status_review, "货品编号对应多个规范名称，需仓管拆分/确认", batch_id):
                        counts["product_conflicts"] += 1
                    continue
                if key in product_ids:
                    continue
                display_name = obs.get("name_raw") or "未命名货品"
                if obs.get("identifier_normalized"):
                    existing = one(conn, """SELECT p.product_id FROM product p
                                      JOIN product_identifier pi ON pi.product_id=p.product_id
                                      WHERE p.display_name=%s AND pi.namespace='workbook.xlsx'
                                        AND pi.identifier_type='source_number' AND pi.value_normalized=%s""",
                                   (str(display_name), obs["identifier_normalized"]))
                else:
                    existing = one(conn, "SELECT product_id FROM product WHERE display_name=%s", (str(display_name),))
                if existing:
                    product_id = int(existing["product_id"])
                else:
                    audit(conn, "SEED_PRODUCT", "product", after={"display_name": display_name, "source_record_id": sid}, source_batch=batch_id)
                    raw_uom = source_unit(src)
                    resolved_uom = uom_id_for(conn, raw_uom, unknown_uom)
                    cur.execute("INSERT INTO product(display_name,default_uom_id,default_condition_id,status_id,source_uom_raw) VALUES (%s,%s,%s,%s,%s) RETURNING product_id", (str(display_name), resolved_uom, new_condition, status_active, raw_uom))
                    product_id = int(cur.fetchone()[0]); counts["products"] += 1
                product_ids[key] = product_id
                product_uoms[product_id] = int(one(conn, "SELECT COALESCE(default_uom_id,%s) AS uom_id FROM product WHERE product_id=%s", (unknown_uom, product_id))["uom_id"])
                identifier = obs.get("identifier_raw")
                if identifier is not None:
                    exists = one(conn, "SELECT product_identifier_id FROM product_identifier WHERE product_id=%s AND identifier_type='source_number' AND namespace='workbook.xlsx' AND value_normalized=%s", (product_id, obs["identifier_normalized"]))
                    if not exists:
                        audit(conn, "SEED_PRODUCT_IDENTIFIER", "product_identifier", after={"product_id": product_id, "value": str(identifier)}, source_batch=batch_id)
                        cur.execute("INSERT INTO product_identifier(product_id,identifier_type,namespace,value_raw,value_normalized,is_primary,source_record_id) VALUES (%s,'source_number','workbook.xlsx',%s,%s,true,%s)", (product_id, str(identifier), obs["identifier_normalized"], sid))

                cur.execute("UPDATE product_observation SET resolved_product_id=%s,resolution_status_id=%s WHERE source_record_id=%s AND observation_ordinal=1", (product_id, status_active, sid))
                if existing_qty is not None and existing_issue in (None, "zero_quantity", "negative_quantity"):
                    audit(conn, "SEED_SNAPSHOT", "inventory_snapshot", after={"product_id": product_id, "quantity": existing_qty}, source_batch=batch_id)
                    cur.execute("INSERT INTO inventory_snapshot(snapshot_date,product_id,location_id,condition_id,uom_id,reported_quantity,source_record_id) VALUES (NULL,%s,%s,%s,%s,%s,%s) ON CONFLICT (source_record_id,source_line_no) DO NOTHING", (product_id, main_location, new_condition, product_uoms[product_id], existing_qty, sid))
                    counts["snapshots"] += cur.rowcount
                if opening is not None and opening > 0 and opening_issue is None and getattr(args, "post_opening", False):
                    audit(conn, "SEED_OPENING", "inventory_movement", after={"product_id": product_id, "quantity": opening}, source_batch=batch_id)
                    cur.execute("INSERT INTO inventory_movement(movement_type_id,status_id,movement_date,product_id,quantity,uom_id,condition_id,destination_location_id,source_record_id,posted_at,posted_by,source_uom_raw) SELECT movement_type_id,%s,%s,%s,%s,%s,%s,%s,%s,now(),'migration',%s FROM movement_type WHERE code='OPENING' ON CONFLICT (source_record_id,source_line_no) DO NOTHING", (posted_id, args.cutover_date, product_id, opening, product_uoms[product_id], new_condition, main_location, sid, source_unit(src)))
                    counts["opening"] += cur.rowcount
                elif opening is not None and opening > 0 and opening_issue is None:
                    counts["opening_deferred"] += 1

            # Preserve all core movement rows in source_record. Only clean
            # receipts/issues with a resolved product are replayed here.
            for candidate in report["movement_candidates"]:
                block = candidate.get("block", candidate["sheet"])
                sid = source_record(conn, batch_id, candidate.get("source", {}), candidate["sheet"], block, candidate["source_row_number"], status_observed)
                source_ids[(candidate["sheet"], block, candidate["source_row_number"])] = sid
                src = candidate.get("source", {})
                name = next((v for k, v in src.items() if "名称" in str(k) or str(k) == "品名"), None)
                product_key = (candidate.get("identifier_normalized"), norm(name))
                product_id = product_ids.get(product_key)
                clean = candidate.get("movement_date") and candidate.get("quantity") is not None and candidate.get("quantity") > 0 and not candidate.get("data_quality_issues")
                movement_type = candidate.get("movement_type_candidate")
                movement_type_id = one(conn, "SELECT movement_type_id FROM movement_type WHERE code=%s", (movement_type,))["movement_type_id"] if movement_type in {"OPENING", "RECEIPT", "ISSUE_OTHER", "ISSUE_SALE", "ISSUE_CONSUMPTION", "ISSUE_GIFT", "ISSUE_SCRAP", "TRANSFER", "RETURN", "ADJUSTMENT"} else None
                raw_uom = source_unit(src)
                candidate_uom = uom_id_for(conn, raw_uom, product_uoms.get(product_id, unknown_uom))
                candidate_status = status_active if product_id and clean and movement_type else status_review
                cur.execute("""INSERT INTO movement_candidate(source_record_id,candidate_ordinal,candidate_kind,movement_type_id,product_id,movement_date_raw,movement_date,quantity_raw,quantity,uom_id,condition_id,resolution_status_id,classification_method,notes)
                             VALUES (%s,1,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                             ON CONFLICT (source_record_id,candidate_ordinal) DO UPDATE SET candidate_kind=EXCLUDED.candidate_kind,movement_type_id=EXCLUDED.movement_type_id,product_id=EXCLUDED.product_id,movement_date_raw=EXCLUDED.movement_date_raw,movement_date=EXCLUDED.movement_date,quantity_raw=EXCLUDED.quantity_raw,quantity=EXCLUDED.quantity,uom_id=EXCLUDED.uom_id,condition_id=EXCLUDED.condition_id,resolution_status_id=EXCLUDED.resolution_status_id,classification_method=EXCLUDED.classification_method,notes=EXCLUDED.notes
                             RETURNING movement_candidate_id""", (sid, "inventory" if clean and product_id else "review", movement_type_id, product_id, candidate.get("movement_date_raw"), candidate.get("movement_date"), candidate.get("quantity_raw"), candidate.get("quantity"), candidate_uom, new_condition, candidate_status, candidate.get("classification_method"), "; ".join(candidate.get("data_quality_issues", [])) or None))
                movement_candidate_id = int(cur.fetchone()[0])
                counts["movement_candidates_loaded"] += 1
                for issue_code in candidate.get("data_quality_issues", []):
                    if record_quality_issue(conn, sid, issue_code, status_review, "历史流水日期/数量需要仓管复核", str(candidate.get("quantity_raw") or candidate.get("movement_date_raw") or ""), movement_candidate_id=movement_candidate_id, source_batch=batch_id):
                        counts["quality_issues"] += 1
                if not product_id or not clean or movement_type not in {"RECEIPT", "ISSUE_OTHER", "ISSUE_SALE", "ISSUE_CONSUMPTION", "ISSUE_GIFT", "ISSUE_SCRAP"}:
                    if open_case(conn, sid, "other", status_review, "历史流水未满足自动过账条件，需仓管复核", batch_id):
                        counts["movement_conflicts"] += 1
                    continue
                movement_id = one(conn, "SELECT movement_type_id FROM movement_type WHERE code=%s", (movement_type,))["movement_type_id"]
                movement_uom = candidate_uom
                source_location = main_location if movement_type.startswith("ISSUE_") else None
                destination_location = main_location if movement_type == "RECEIPT" else None
                audit(conn, "SEED_MOVEMENT", "inventory_movement", after={"product_id": product_id, "quantity": candidate["quantity"], "source_record_id": sid}, source_batch=batch_id)
                cur.execute("INSERT INTO inventory_movement(movement_type_id,status_id,movement_date,product_id,quantity,uom_id,condition_id,source_location_id,destination_location_id,source_record_id,posted_at,posted_by,source_uom_raw) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now(),'migration',%s) ON CONFLICT (source_record_id,source_line_no) DO NOTHING", (movement_id, posted_id, candidate["movement_date"], product_id, candidate["quantity"], movement_uom, new_condition, source_location, destination_location, sid, raw_uom))
                counts["movements"] += cur.rowcount
        conn.commit()
        return {"mode": "applied", "source_sha256": report["summary"]["source_sha256"], "counts": dict(counts), "source_counts": report["summary"]["counts"]}
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--password-env", default="IMPORT_WORKBOOK_PASSWORD")
    parser.add_argument("--apply", action="store_true", help="write to DATABASE_URL; default is dry-run")
    parser.add_argument("--post-opening", action="store_true", help="post reviewed positive opening quantities; requires --cutover-date")
    parser.add_argument("--cutover-date", help="ISO date for approved OPENING movements")
    args = parser.parse_args()
    if args.post_opening and not args.cutover_date:
        parser.error("--post-opening requires --cutover-date")
    password = os.environ.get(args.password_env)
    if not password:
        parser.error(f"environment variable {args.password_env} is empty")
    print(json.dumps(load(argparse.Namespace(input=args.input, password=password, apply=args.apply, post_opening=args.post_opening, cutover_date=args.cutover_date)), ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
