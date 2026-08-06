-- 006_serial_tracking.sql
--
-- 货品唯一编码（SN/UUID）流向追踪：激活并复用 001 迁移的休眠 asset 资产域。
--
-- 设计约定：
--   * product.serialized 是货品级开关；登记可选（软约束），不填 SN 仍可过账。
--   * 每个启用 SN 的货品，其单件以 asset 行 + asset_identifier(product_serial) 建档，
--     流向通过 asset_event 记录，并与 inventory_movement 经 inventory_movement_asset 关联。
--   * SN 唯一性：product_serial 标识一律 is_verified/is_exclusive=TRUE，
--     namespace 编码货品（'product_serial.{product_id}'），
--     复用 001 的部分唯一索引 asset_identifier_verified_exclusive_uq 实现按货品唯一。
--   * asset 系列表的 require_audit_context 审计触发器已在 002 挂载，此处不重复创建。
--
-- 幂等：新库由 docker-entrypoint-initdb.d 按文件名自动执行；
--       已有库在 deploy/deploy_remote.sh 手动补跑一次（可重复执行）。

BEGIN;

-- 1) 货品启用开关
ALTER TABLE product ADD COLUMN IF NOT EXISTS serialized BOOLEAN NOT NULL DEFAULT FALSE;

-- 2) asset 挂到货品（存量历史资产 product_id 留 NULL，视图 LEFT JOIN 兼容）
ALTER TABLE asset ADD COLUMN IF NOT EXISTS product_id BIGINT REFERENCES product(product_id);
CREATE INDEX IF NOT EXISTS asset_product_idx ON asset(product_id);

-- 3) asset_identifier.identifier_type 允许 product_serial
--    PostgreSQL 对内联列 CHECK 自动命名为 <table>_<column>_check。
ALTER TABLE asset_identifier DROP CONSTRAINT IF EXISTS asset_identifier_identifier_type_check;
ALTER TABLE asset_identifier ADD CONSTRAINT asset_identifier_identifier_type_check
    CHECK (identifier_type IN ('host_serial','component_serial','source_serial','imei','asset_tag','product_serial','other'));

-- 4) 单据明细草稿期捕获 SN（软约束：NULL/空即不登记）
ALTER TABLE business_document_line ADD COLUMN IF NOT EXISTS serial_numbers TEXT[];

-- 5) 扩展 v_asset_current_state：加 product_id / product_name（保留原列语义）
CREATE OR REPLACE VIEW v_asset_current_state AS
WITH latest_event AS (
    SELECT DISTINCT ON (ae.asset_id)
        ae.asset_id,
        ae.asset_event_id,
        ae.event_type,
        ae.event_date,
        ae.status_id,
        ae.condition_id,
        ae.from_location_id,
        ae.to_location_id,
        ae.inventory_movement_id,
        ae.notes
    FROM asset_event ae
    ORDER BY ae.asset_id, ae.event_date DESC, ae.asset_event_id DESC
), state AS (
    SELECT
        a.asset_id,
        a.product_id,
        a.asset_type,
        a.manufacturer,
        a.model,
        COALESCE(le.status_id, a.status_id) AS status_id,
        COALESCE(le.condition_id, a.condition_id) AS condition_id,
        CASE
            -- An issue/retirement/loss can leave the company without a known
            -- destination; do not report the former source as current.
            WHEN le.event_type IN ('issued', 'retired', 'lost') THEN le.to_location_id
            ELSE COALESCE(le.to_location_id, le.from_location_id)
        END AS current_location_id,
        le.asset_event_id AS latest_asset_event_id,
        le.event_type AS latest_event_type,
        le.event_date AS latest_event_date,
        le.inventory_movement_id AS latest_inventory_movement_id,
        le.notes AS latest_event_notes
    FROM asset a
    LEFT JOIN latest_event le ON le.asset_id = a.asset_id
)
SELECT
    s.asset_id,
    s.product_id,
    p.display_name AS product_name,
    s.asset_type,
    s.manufacturer,
    s.model,
    ai.value_normalized AS primary_identifier,
    s.status_id,
    rs.code AS status_code,
    s.condition_id,
    ic.code AS condition_code,
    s.current_location_id,
    l.name AS current_location_name,
    s.latest_asset_event_id,
    s.latest_event_type,
    s.latest_event_date,
    s.latest_inventory_movement_id,
    s.latest_event_notes
FROM state s
LEFT JOIN product p ON p.product_id = s.product_id
LEFT JOIN record_status rs ON rs.status_id = s.status_id
LEFT JOIN inventory_condition ic ON ic.condition_id = s.condition_id
LEFT JOIN location l ON l.location_id = s.current_location_id
LEFT JOIN LATERAL (
    SELECT ai0.value_normalized
    FROM asset_identifier ai0
    WHERE ai0.asset_id = s.asset_id
      AND ai0.is_primary
    ORDER BY ai0.asset_identifier_id
    LIMIT 1
) ai ON TRUE;

-- 6) 序列台账视图：仅暴露挂到货品的资产（排除遗留设备资产）
CREATE OR REPLACE VIEW v_serial_ledger AS
SELECT
    cs.asset_id,
    cs.product_id,
    cs.product_name,
    cs.primary_identifier AS serial_number,
    cs.current_location_id,
    cs.current_location_name,
    cs.status_code,
    cs.condition_code,
    cs.latest_event_type,
    cs.latest_event_date,
    cs.latest_inventory_movement_id
FROM v_asset_current_state cs
WHERE cs.product_id IS NOT NULL;

COMMENT ON COLUMN product.serialized IS '货品需 SN 追踪开关；登记可选（软约束），不填 SN 仍可过账。';
COMMENT ON COLUMN asset.product_id IS '序列号所属货品；存量历史资产可为 NULL。';
COMMENT ON COLUMN business_document_line.serial_numbers IS '草稿期捕获的序列号数组；过账时按 (product, SN) 建/复用 asset 并写资产事件。';

COMMIT;
