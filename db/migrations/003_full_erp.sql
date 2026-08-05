-- 003_full_erp.sql
--
-- 进销存一体系统扩展：RBAC 四类角色 + 同事、商品分类/价格、客户/供应商档案、
-- 泛型业务单据（采购/销售/库存）、应收应付台账、附件。
-- 在 001 / 002 之后按文件名顺序应用。

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. 角色：扩为 ADMIN / WAREHOUSE / SALES / FINANCE / COLLEAGUE
--    PostgreSQL 对内联 CHECK 自动命名为 app_user_role_check。
-- ---------------------------------------------------------------------------
ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_role_check;
-- app_user is protected by the append-only audit trigger from migration 002.
-- Record the one-time role migration before updating existing accounts.
SELECT set_config('app.actor_id', 'SYSTEM', true);
SELECT set_config('app.audit_action', 'MIGRATE_003_ROLES', true);
INSERT INTO audit_event (actor_user_id, actor_role, action, target_table, target_id, after_data)
VALUES (NULL, 'SYSTEM', 'MIGRATE_003_ROLES', 'app_user', NULL,
        '{"migration":"003_full_erp","change":"WAREHOUSE_ADMIN/REQUESTER -> ADMIN/COLLEAGUE"}'::jsonb);
UPDATE app_user SET role = 'ADMIN'     WHERE role = 'WAREHOUSE_ADMIN';
UPDATE app_user SET role = 'COLLEAGUE' WHERE role = 'REQUESTER';
ALTER TABLE app_user
    ADD CONSTRAINT app_user_role_check
    CHECK (role IN ('ADMIN','WAREHOUSE','SALES','FINANCE','COLLEAGUE'));

-- ---------------------------------------------------------------------------
-- 2. 部门（先建表，app_user.department_id 再引用）
-- ---------------------------------------------------------------------------
CREATE TABLE department (
    department_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name            TEXT NOT NULL CHECK (length(btrim(name)) > 0),
    sort_order      INTEGER NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE
);

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS department_id BIGINT REFERENCES department(department_id);

-- ---------------------------------------------------------------------------
-- 3. 商品分类（树）
-- ---------------------------------------------------------------------------
CREATE TABLE product_category (
    category_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parent_category_id  BIGINT REFERENCES product_category(category_id),
    name                TEXT NOT NULL CHECK (length(btrim(name)) > 0),
    sort_order          INTEGER NOT NULL DEFAULT 0,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE
);

-- ---------------------------------------------------------------------------
-- 4. 商品价格/分类列
-- ---------------------------------------------------------------------------
ALTER TABLE product ADD COLUMN IF NOT EXISTS category_id         BIGINT REFERENCES product_category(category_id);
ALTER TABLE product ADD COLUMN IF NOT EXISTS purchase_cost_price NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (purchase_cost_price >= 0);
ALTER TABLE product ADD COLUMN IF NOT EXISTS sales_price         NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (sales_price >= 0);

-- 多阶梯批发价：min_quantity 达标即按该档价格销售
CREATE TABLE product_price_tier (
    price_tier_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id     BIGINT NOT NULL REFERENCES product(product_id) ON DELETE CASCADE,
    tier_name      TEXT NOT NULL,
    min_quantity   NUMERIC(18,3) NOT NULL DEFAULT 0 CHECK (min_quantity >= 0),
    price          NUMERIC(18,2) NOT NULL CHECK (price >= 0),
    UNIQUE (product_id, tier_name)
);

-- ---------------------------------------------------------------------------
-- 5. 客户 / 供应商档案
-- ---------------------------------------------------------------------------
CREATE TABLE customer (
    customer_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name               TEXT NOT NULL CHECK (length(btrim(name)) > 0),
    contact_person     TEXT,
    phone              TEXT,
    address            TEXT,
    settlement_method  TEXT NOT NULL DEFAULT '现结' CHECK (settlement_method IN ('现结','月结')),
    level              TEXT,
    credit_limit       NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
    is_active          BOOLEAN NOT NULL DEFAULT TRUE,
    notes              TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE supplier (
    supplier_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name              TEXT NOT NULL CHECK (length(btrim(name)) > 0),
    contact_person    TEXT,
    phone             TEXT,
    address           TEXT,
    settlement_days   INTEGER NOT NULL DEFAULT 0 CHECK (settlement_days >= 0),
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    notes             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 6. 采购/销售等新流水类型（调拨复用 TRANSFER、盘点复用 ADJUSTMENT）
-- ---------------------------------------------------------------------------
INSERT INTO movement_type
    (code, display_name, requires_source_location, requires_destination_location,
     allows_both_locations, affects_company_inventory)
VALUES
    ('PURCHASE_IN',     '采购入库', FALSE, TRUE,  FALSE, TRUE),
    ('PURCHASE_RETURN', '采购退货', TRUE,  FALSE, FALSE, TRUE),
    ('SALES_OUT',       '销售出库', TRUE,  FALSE, TRUE,  TRUE),
    ('SALES_RETURN',    '销售退货', FALSE, TRUE,  FALSE, TRUE),
    ('STOCK_LOSS',      '报损出库', TRUE,  FALSE, FALSE, TRUE),
    ('OTHER_IN',        '其他入库', FALSE, TRUE,  FALSE, TRUE),
    ('OTHER_OUT',       '其他出库', TRUE,  FALSE, TRUE,  TRUE)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 7. 单据编号序列（sequence 无需审计触发器）
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS document_no_seq;

-- ---------------------------------------------------------------------------
-- 8. 业务单据：表头 + 明细
-- ---------------------------------------------------------------------------
CREATE TABLE business_document (
    document_id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    doc_type                TEXT NOT NULL CHECK (doc_type IN
        ('PURCHASE_ORDER','PURCHASE_RECEIPT','PURCHASE_RETURN',
         'SALES_ORDER','SALES_DELIVERY','SALES_RETURN',
         'STOCK_TRANSFER','STOCK_COUNT','STOCK_LOSS','OTHER_IN','OTHER_OUT')),
    doc_no                  TEXT NOT NULL UNIQUE,
    status                  TEXT NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT','SUBMITTED','POSTED','REVERSED')),
    doc_date                DATE NOT NULL DEFAULT current_date
        CHECK (doc_date BETWEEN DATE '1900-01-01' AND DATE '2200-01-01'),
    party_type              TEXT CHECK (party_type IN ('CUSTOMER','SUPPLIER')),
    party_id                BIGINT,
    source_location_id      BIGINT REFERENCES location(location_id),
    destination_location_id BIGINT REFERENCES location(location_id),
    deposit_amount          NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),
    total_amount            NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
    notes                   TEXT,
    version                 INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_by              BIGINT NOT NULL REFERENCES app_user(user_id),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    submitted_at            TIMESTAMPTZ,
    posted_by               TEXT,
    posted_at               TIMESTAMPTZ,
    reversed_by             TEXT,
    reversed_at             TIMESTAMPTZ,
    reversal_of_document_id BIGINT REFERENCES business_document(document_id),
    CHECK (party_type IS NULL OR party_id IS NOT NULL),
    CHECK (source_location_id IS NULL OR destination_location_id IS NULL
           OR source_location_id <> destination_location_id),
    CHECK (reversal_of_document_id IS NULL OR reversal_of_document_id <> document_id)
);
CREATE INDEX business_document_type_status_idx ON business_document(doc_type, status, created_at DESC);
CREATE INDEX business_document_party_idx ON business_document(party_type, party_id);

CREATE TABLE business_document_line (
    document_line_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id             BIGINT NOT NULL REFERENCES business_document(document_id) ON DELETE CASCADE,
    line_no                 INTEGER NOT NULL CHECK (line_no > 0),
    product_id              BIGINT NOT NULL REFERENCES product(product_id),
    uom_id                  BIGINT NOT NULL REFERENCES uom(uom_id),
    quantity                NUMERIC(18,3) NOT NULL CHECK (quantity > 0),
    price                   NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
    amount                  NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
    condition_id            BIGINT REFERENCES inventory_condition(condition_id),
    source_location_id      BIGINT REFERENCES location(location_id),
    destination_location_id BIGINT REFERENCES location(location_id),
    -- 盘点：用户录入的实盘数量 / 过账时捕获的账面数量
    counted_quantity        NUMERIC(18,3),
    book_quantity           NUMERIC(18,3),
    notes                   TEXT,
    UNIQUE (document_id, line_no)
);

-- 单据与库存流水挂钩，供红冲按原单找流水
ALTER TABLE inventory_movement ADD COLUMN IF NOT EXISTS document_id BIGINT REFERENCES business_document(document_id);
CREATE INDEX inventory_movement_document_idx ON inventory_movement(document_id);

-- ---------------------------------------------------------------------------
-- 9. 应收应付台账 + 余额视图
-- ---------------------------------------------------------------------------
CREATE TABLE ar_ap_entry (
    ar_ap_entry_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    party_type      TEXT NOT NULL CHECK (party_type IN ('CUSTOMER','SUPPLIER')),
    party_id        BIGINT NOT NULL,
    entry_type      TEXT NOT NULL CHECK (entry_type IN ('INVOICE','DEPOSIT')),
    direction       TEXT NOT NULL CHECK (direction IN ('UP','DOWN')),
    amount          NUMERIC(18,2) NOT NULL CHECK (amount >= 0),
    document_id     BIGINT NOT NULL REFERENCES business_document(document_id),
    created_by      BIGINT NOT NULL REFERENCES app_user(user_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ar_ap_party_idx ON ar_ap_entry(party_type, party_id, created_at);

CREATE OR REPLACE VIEW v_customer_balance AS
SELECT c.customer_id, c.name, c.is_active,
       COALESCE(SUM(ae.amount) FILTER (WHERE ae.direction='UP'),0)
     - COALESCE(SUM(ae.amount) FILTER (WHERE ae.direction='DOWN'),0) AS receivable_balance
FROM customer c
LEFT JOIN ar_ap_entry ae ON ae.party_type='CUSTOMER' AND ae.party_id=c.customer_id
GROUP BY c.customer_id, c.name, c.is_active;

CREATE OR REPLACE VIEW v_supplier_balance AS
SELECT s.supplier_id, s.name, s.is_active,
       COALESCE(SUM(ae.amount) FILTER (WHERE ae.direction='UP'),0)
     - COALESCE(SUM(ae.amount) FILTER (WHERE ae.direction='DOWN'),0) AS payable_balance
FROM supplier s
LEFT JOIN ar_ap_entry ae ON ae.party_type='SUPPLIER' AND ae.party_id=s.supplier_id
GROUP BY s.supplier_id, s.name, s.is_active;

-- ---------------------------------------------------------------------------
-- 10. 附件（BYTEA，存库；受代理 14MB 限制，单文件 ≤10MB）
-- ---------------------------------------------------------------------------
CREATE TABLE document_attachment (
    attachment_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id    BIGINT NOT NULL REFERENCES business_document(document_id) ON DELETE CASCADE,
    filename       TEXT NOT NULL,
    content_type   TEXT NOT NULL,
    size           INTEGER NOT NULL CHECK (size >= 0 AND size <= 10485760),
    data           BYTEA NOT NULL,
    uploaded_by    BIGINT NOT NULL REFERENCES app_user(user_id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 11. 审计触发器：每个新业务表都必须先写 audit_event 再写库
-- ---------------------------------------------------------------------------
CREATE TRIGGER business_document_audit_trg     BEFORE INSERT OR UPDATE OR DELETE ON business_document     FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER business_document_line_audit_trg BEFORE INSERT OR UPDATE OR DELETE ON business_document_line FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER ar_ap_entry_audit_trg           BEFORE INSERT OR UPDATE OR DELETE ON ar_ap_entry           FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER document_attachment_audit_trg   BEFORE INSERT OR UPDATE OR DELETE ON document_attachment   FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER product_category_audit_trg      BEFORE INSERT OR UPDATE OR DELETE ON product_category      FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER customer_audit_trg              BEFORE INSERT OR UPDATE OR DELETE ON customer              FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER supplier_audit_trg              BEFORE INSERT OR UPDATE OR DELETE ON supplier              FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER department_audit_trg            BEFORE INSERT OR UPDATE OR DELETE ON department            FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER product_price_tier_audit_trg    BEFORE INSERT OR UPDATE OR DELETE ON product_price_tier    FOR EACH ROW EXECUTE FUNCTION require_audit_context();

COMMENT ON TABLE business_document IS '泛型业务单据表头：状态机 DRAFT/SUBMITTED/POSTED/REVERSED，已过账仅可红冲。';
COMMENT ON TABLE ar_ap_entry IS '应收/应付/定金台账；余额 = SUM(UP) - SUM(DOWN)，负数表示预收/预付。';

COMMIT;
