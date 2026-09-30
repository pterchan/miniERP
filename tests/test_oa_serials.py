"""OA 可选 SN 的草稿往返、数量账联动及失败原子性。"""
from __future__ import annotations

from pathlib import Path
from uuid import uuid4

from api.db import connection, fetch_one
from tests.support.api_client import api_for
from tests.support.testdb import DbTestCase


class OaSerialTests(DbTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.admin, cls.warehouse, cls.colleague = (api_for(name) for name in ("admin", "warehouse", "colleague"))
        cls.uom_id = next(row["uom_id"] for row in cls.admin.get("/api/uoms").json() if row["code"] == "EA")
        cls.other_uom_id = next(row["uom_id"] for row in cls.admin.get("/api/uoms").json() if row["code"] == "KG")
        cls.locations = [cls.admin.post("/api/locations", json={"code": f"OASN{i}", "name": f"OA 序列库位{i}"}).json()["location_id"] for i in (1, 2)]
        with connection() as conn:
            cls.new_condition = fetch_one(conn, "SELECT condition_id FROM inventory_condition WHERE code='new'")["condition_id"]
            cls.used_condition = fetch_one(conn, "SELECT condition_id FROM inventory_condition WHERE code='used'")["condition_id"]

    def product(self, serialized=True):
        response = self.admin.post("/api/products", json={"display_name": f"OA序列货品-{uuid4().hex[:8]}", "default_uom_id": self.uom_id, "serialized": serialized})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["product_id"]

    def line(self, product_id, serials=None, quantity=1, condition=None):
        result = {"product_id": product_id, "quantity": quantity, "uom_id": self.uom_id, "condition_id": condition or self.new_condition}
        if serials is not None:
            result["serial_numbers"] = serials
        return result

    def request(self, kind, lines, source=None, dest=None, approve=True):
        response = self.colleague.post("/api/stock-requests", json={"request_type": kind, "source_location_id": source, "destination_location_id": dest, "lines": lines})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        if approve:
            rid = data["stock_request_id"]
            self.assertEqual(self.colleague.post(f"/api/stock-requests/{rid}/submit").status_code, 200)
            response = self.warehouse.post(f"/api/stock-requests/{rid}/approve")
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
        return data

    def release(self, request, status=200):
        response = self.warehouse.post(f"/api/stock-requests/{request['stock_request_id']}/release")
        self.assertEqual(response.status_code, status, response.text)
        return response

    def counts(self, product_id):
        with connection() as conn:
            return fetch_one(conn, """SELECT
                (SELECT count(*) FROM inventory_movement WHERE product_id=%s) AS movements,
                (SELECT count(*) FROM asset_event e JOIN asset a USING(asset_id) WHERE a.product_id=%s) AS events,
                (SELECT count(*) FROM inventory_movement_asset ma JOIN inventory_movement m USING(inventory_movement_id) WHERE m.product_id=%s) AS links""", (product_id,) * 3)

    def state(self, product_id, serial):
        with connection() as conn:
            return fetch_one(conn, "SELECT status_code,current_location_id,condition_id FROM v_asset_current_state WHERE product_id=%s AND primary_identifier=%s", (product_id, serial.lower()))

    def assert_rejected_without_writes(self, request, product_id):
        before = self.counts(product_id)
        self.release(request, 422)
        self.assertEqual(self.counts(product_id), before)
        detail = self.colleague.get(f"/api/stock-requests/{request['stock_request_id']}").json()
        self.assertEqual(detail["status"], "APPROVED")
        self.assertNotIn("RELEASE", [action["action"] for action in detail["actions"]])

    def test_serials_survive_create_edit_and_detail(self):
        pid = self.product()
        data = self.request("RECEIPT", [self.line(pid, ["000123", "ABC-2"], 2, self.used_condition)], dest=self.locations[0], approve=False)
        self.assertTrue(data["lines"][0]["serialized"])
        self.assertEqual(data["lines"][0]["serial_numbers"], ["000123", "ABC-2"])
        response = self.colleague.put(f"/api/stock-requests/{data['stock_request_id']}", json={"version": data["version"], "lines": [self.line(pid, ["000123", "XYZ-3"], 2, self.used_condition)]})
        self.assertEqual(response.status_code, 200, response.text)
        detail = self.colleague.get(f"/api/stock-requests/{data['stock_request_id']}").json()
        self.assertEqual(detail["lines"][0]["serial_numbers"], ["000123", "XYZ-3"])
        self.assertEqual(detail["lines"][0]["condition_id"], self.used_condition)
        self.assertEqual(detail["version"], data["version"] + 1)

    def test_receipt_issue_return_transfer_and_duplicate_release(self):
        pid, serial = self.product(), "000123"
        loc1, loc2 = self.locations
        receipt = self.request("RECEIPT", [self.line(pid, [serial])], dest=loc1)
        self.release(receipt)
        self.release(receipt, 409)
        self.assertEqual(self.state(pid, serial)["current_location_id"], loc1)
        self.release(self.request("ISSUE_OTHER", [self.line(pid, [serial])], source=loc1))
        self.assertEqual(self.state(pid, serial)["status_code"], "retired")
        self.release(self.request("RETURN", [self.line(pid, [serial])], dest=loc1))
        self.assertEqual(self.state(pid, serial)["status_code"], "active")
        self.release(self.request("TRANSFER", [self.line(pid, [serial])], source=loc1, dest=loc2))
        self.assertEqual(self.state(pid, serial)["current_location_id"], loc2)
        wrong = self.request("ISSUE_OTHER", [self.line(pid, [serial])], source=loc1)
        self.assert_rejected_without_writes(wrong, pid)
        self.release(self.request("ISSUE_OTHER", [self.line(pid, [serial])], source=loc2))
        self.assertEqual(self.counts(pid), {"movements": 5, "events": 5, "links": 5})

    def test_invalid_serial_inputs_roll_back_release(self):
        cases = [(True, ["A", "ａ"], 2), (True, ["A"], 2), (True, ["A"], "1.5"), (False, ["A"], 1)]
        for serialized, serials, quantity in cases:
            with self.subTest(serialized=serialized, serials=serials, quantity=quantity):
                pid = self.product(serialized)
                request = self.request("RECEIPT", [self.line(pid, serials, quantity)], dest=self.locations[0])
                self.assert_rejected_without_writes(request, pid)

    def test_wrong_condition_and_missing_sn_roll_back(self):
        pid = self.product()
        self.release(self.request("RECEIPT", [self.line(pid, ["SN-NEW"])], dest=self.locations[0]))
        for serial, condition in (("SN-NEW", self.used_condition), ("SN-MISSING", self.new_condition)):
            with self.subTest(serial=serial):
                request = self.request("ISSUE_OTHER", [self.line(pid, [serial], condition=condition)], source=self.locations[0])
                self.assert_rejected_without_writes(request, pid)
        self.assertEqual(self.state(pid, "SN-NEW")["condition_id"], self.new_condition)

    def test_issue_does_not_become_transfer_when_destination_was_filled(self):
        pid = self.product()
        loc1, loc2 = self.locations
        self.release(self.request("RECEIPT", [self.line(pid, ["SN-OUT"])], dest=loc1))
        self.release(self.request("ISSUE_OTHER", [self.line(pid, ["SN-OUT"])], source=loc1, dest=loc2))
        with connection() as conn:
            movement = fetch_one(conn, "SELECT source_location_id,destination_location_id FROM inventory_movement WHERE product_id=%s ORDER BY inventory_movement_id DESC LIMIT 1", (pid,))
            destination = fetch_one(conn, "SELECT on_hand_quantity FROM v_inventory_balance WHERE product_id=%s AND location_id=%s", (pid, loc2))
        self.assertEqual(movement, {"source_location_id": loc1, "destination_location_id": None})
        self.assertIsNone(destination)
        self.assertEqual(self.state(pid, "SN-OUT"), {"status_code": "retired", "current_location_id": None, "condition_id": self.new_condition})

    def test_out_and_transfer_reject_serial_in_another_unit(self):
        pid = self.product()
        loc1, loc2 = self.locations
        self.release(self.request("RECEIPT", [self.line(pid, ["SN-EA"])], dest=loc1))
        for kind in ("ISSUE_OTHER", "TRANSFER"):
            with self.subTest(kind=kind):
                line = {**self.line(pid, ["SN-EA"]), "uom_id": self.other_uom_id}
                request = self.request(kind, [line], source=loc1, dest=loc2 if kind == "TRANSFER" else None)
                self.assert_rejected_without_writes(request, pid)
        self.assertEqual(self.state(pid, "SN-EA")["status_code"], "active")

    def test_second_line_failure_restores_first_serial_event(self):
        pid = self.product()
        self.release(self.request("RECEIPT", [self.line(pid, ["SN-A"])], dest=self.locations[0]))
        request = self.request("ISSUE_OTHER", [self.line(pid, ["SN-A"]), self.line(pid, ["SN-NOT-FOUND"])], source=self.locations[0])
        self.assert_rejected_without_writes(request, pid)
        self.assertEqual(self.state(pid, "SN-A")["status_code"], "active")

    def test_old_client_without_serials_remains_compatible(self):
        pid = self.product()
        request = self.request("RECEIPT", [self.line(pid)], dest=self.locations[0])
        self.assertIsNone(request["lines"][0]["serial_numbers"])
        self.release(request)
        self.assertEqual(self.counts(pid), {"movements": 1, "events": 0, "links": 0})


class OaSerialMigrationTests(DbTestCase):
    def test_legacy_line_stays_null_after_repeated_migration(self):
        admin = api_for("admin")
        uom_id = next(row["uom_id"] for row in admin.get("/api/uoms").json() if row["code"] == "EA")
        pid = admin.post("/api/products", json={"display_name": "旧申请货品", "default_uom_id": uom_id}).json()["product_id"]
        request = admin.post("/api/stock-requests", json={"request_type": "RECEIPT", "lines": [{"product_id": pid, "quantity": 1}]}).json()
        sql = Path(__file__).parents[1].joinpath("db/migrations/011_oa_serial_numbers.sql").read_text()
        with connection() as conn:
            with conn.cursor() as cur:
                cur.execute("ALTER TABLE stock_request_line DROP COLUMN serial_numbers")
        # 模拟升级前的表结构，并验证重放不会改写旧行。
        with connection() as conn:
            with conn.cursor() as cur:
                cur.execute(sql)
                cur.execute(sql)
        detail = admin.get(f"/api/stock-requests/{request['stock_request_id']}").json()
        self.assertIsNone(detail["lines"][0]["serial_numbers"])
        self.assertEqual(detail["status"], "DRAFT")
