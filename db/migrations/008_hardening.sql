-- 008_hardening.sql
--
-- 安全与完整性加固：
--   1) audit_event 补 BEFORE TRUNCATE 防护（行级触发器不响应 TRUNCATE 的旁路）；
--   2) 多态 party 外键（NOT VALID 先行，不扫描存量；新写入立即受约束）；
--   3) 补关键外键列索引（join 与删除校验性能）；
--   4) posted_by_user_id/reversed_by_user_id：审计可追责的用户外键（保留原 TEXT 列作迁移来源标记）；
--   5) uom.decimal_scale 收敛到 0-3（与数量列 NUMERIC(18,3) 一致，避免入库四舍五入）。
-- 幂等：全部语句可重复执行。

BEGIN;

-- 1) 审计表 TRUNCATE 防护 --------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_audit_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_event is append-only';
END; $$;

DROP TRIGGER IF EXISTS audit_event_truncate_trg ON audit_event;
CREATE TRIGGER audit_event_truncate_trg
    BEFORE TRUNCATE ON audit_event EXECUTE FUNCTION forbid_audit_truncate();

REVOKE TRUNCATE ON audit_event FROM PUBLIC;

-- 2) 多态 party 引用完整性（触发器校验）-------------------------------------
-- PostgreSQL 不支持带 WHERE 的外键，复合 FK 无法表达「按 party_type 选择目标表」；
-- 用 BEFORE 触发器对新增/更新行做存在性校验，杜绝孤儿 party。
CREATE OR REPLACE FUNCTION require_valid_party() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE found_id BIGINT;
BEGIN
    IF NEW.party_type IS NULL AND NEW.party_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF NEW.party_type = 'CUSTOMER' THEN
        SELECT customer_id INTO found_id FROM customer WHERE customer_id = NEW.party_id;
    ELSIF NEW.party_type = 'SUPPLIER' THEN
        SELECT supplier_id INTO found_id FROM supplier WHERE supplier_id = NEW.party_id;
    ELSE
        RAISE EXCEPTION 'party_type 必须是 CUSTOMER 或 SUPPLIER（设置 party_id 时）';
    END IF;
    IF found_id IS NULL THEN
        RAISE EXCEPTION 'party % % 不存在', NEW.party_type, NEW.party_id;
    END IF;
    RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS business_document_party_trg ON business_document;
CREATE TRIGGER business_document_party_trg
    BEFORE INSERT OR UPDATE ON business_document
    FOR EACH ROW EXECUTE FUNCTION require_valid_party();

DROP TRIGGER IF EXISTS ar_ap_entry_party_trg ON ar_ap_entry;
CREATE TRIGGER ar_ap_entry_party_trg
    BEFORE INSERT OR UPDATE ON ar_ap_entry
    FOR EACH ROW EXECUTE FUNCTION require_valid_party();

-- 3) 外键列索引 -------------------------------------------------------------
CREATE INDEX IF NOT EXISTS asset_event_asset_date_idx ON asset_event(asset_id, event_date DESC, asset_event_id DESC);
CREATE INDEX IF NOT EXISTS organization_parent_idx ON organization(parent_organization_id) WHERE parent_organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS location_parent_idx ON location(parent_location_id) WHERE parent_location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inventory_movement_reversal_idx ON inventory_movement(reversal_of_movement_id) WHERE reversal_of_movement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS asset_event_movement_idx ON asset_event(inventory_movement_id) WHERE inventory_movement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_request_requester_idx ON stock_request(requester_user_id);
CREATE INDEX IF NOT EXISTS app_session_user_idx ON app_session(user_id);
CREATE INDEX IF NOT EXISTS business_document_creator_idx ON business_document(created_by);
CREATE INDEX IF NOT EXISTS ar_ap_entry_document_idx ON ar_ap_entry(document_id);
CREATE INDEX IF NOT EXISTS movement_candidate_product_idx ON movement_candidate(product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS movement_candidate_source_idx ON movement_candidate(source_location_id) WHERE source_location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS movement_candidate_dest_idx ON movement_candidate(destination_location_id) WHERE destination_location_id IS NOT NULL;

-- 4) 过账/红冲操作人的用户外键（可追责）--------------------------------------
ALTER TABLE inventory_movement ADD COLUMN IF NOT EXISTS posted_by_user_id BIGINT REFERENCES app_user(user_id);
ALTER TABLE business_document ADD COLUMN IF NOT EXISTS posted_by_user_id BIGINT REFERENCES app_user(user_id);
ALTER TABLE business_document ADD COLUMN IF NOT EXISTS reversed_by_user_id BIGINT REFERENCES app_user(user_id);

-- 5) 单位小数位与数量列精度一致 ----------------------------------------------
-- 先收敛存量（001 旧约束允许 0-6），否则 ADD CONSTRAINT 全表校验失败会回滚整个迁移
UPDATE uom SET decimal_scale = 3 WHERE decimal_scale > 3;
ALTER TABLE uom DROP CONSTRAINT IF EXISTS uom_decimal_scale_check;
ALTER TABLE uom ADD CONSTRAINT uom_decimal_scale_check CHECK (decimal_scale BETWEEN 0 AND 3);

COMMIT;
