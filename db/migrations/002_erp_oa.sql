-- ERP/OA POC extension. Apply after 001_inventory.sql.
BEGIN;

ALTER TABLE product ADD COLUMN IF NOT EXISTS source_uom_raw TEXT;
ALTER TABLE inventory_movement ADD COLUMN IF NOT EXISTS source_uom_raw TEXT;

-- Additional dictionary values used by the workbook.  Quantities remain in
-- their source unit; no conversion factors are implied by these rows.
INSERT INTO uom (code, display_name, decimal_scale)
VALUES ('M', 'Meter', 3), ('KG', 'Kilogram', 3), ('L', 'Litre', 3)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE app_user (
    user_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username TEXT NOT NULL UNIQUE CHECK (length(btrim(username)) >= 3),
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('WAREHOUSE_ADMIN', 'REQUESTER')),
    password_hash TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE app_session (
    session_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_token_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at)
);
CREATE INDEX app_session_active_idx ON app_session(token_hash, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE audit_event (
    audit_event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_user_id BIGINT REFERENCES app_user(user_id),
    actor_role TEXT,
    action TEXT NOT NULL,
    target_table TEXT NOT NULL,
    target_id BIGINT,
    request_id TEXT,
    ip_address INET,
    user_agent TEXT,
    before_data JSONB,
    after_data JSONB,
    field_diff JSONB,
    import_batch_id BIGINT REFERENCES import_batch(import_batch_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_event_target_idx ON audit_event(target_table, target_id, created_at DESC);
CREATE INDEX audit_event_actor_idx ON audit_event(actor_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION forbid_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_event is append-only';
END; $$;
CREATE TRIGGER audit_event_immutable_trg
    BEFORE UPDATE OR DELETE ON audit_event FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();

-- Every write path must set app.actor_id and insert an audit_event in the same
-- transaction first. The nullable target_id permits auditing a new identity row.
CREATE OR REPLACE FUNCTION require_audit_context() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor TEXT; action_name TEXT; has_audit BOOLEAN;
BEGIN
    actor := current_setting('app.actor_id', true);
    action_name := current_setting('app.audit_action', true);
    IF actor IS NULL OR actor = '' OR action_name IS NULL OR action_name = '' THEN
        RAISE EXCEPTION 'production write requires app.actor_id and app.audit_action';
    END IF;
    SELECT EXISTS (
        SELECT 1 FROM audit_event ae
        WHERE ae.target_table = TG_TABLE_NAME
          AND ae.created_at >= transaction_timestamp()
    ) INTO has_audit;
    IF NOT has_audit THEN
        RAISE EXCEPTION 'production write on % requires an audit_event first', TG_TABLE_NAME;
    END IF;
    RETURN COALESCE(NEW, OLD);
END; $$;

CREATE TABLE stock_request (
    stock_request_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_no TEXT NOT NULL UNIQUE,
    request_type TEXT NOT NULL CHECK (request_type IN ('RECEIPT','ISSUE_OTHER','ISSUE_SALE','ISSUE_CONSUMPTION','ISSUE_GIFT','ISSUE_SCRAP','TRANSFER','RETURN')),
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','RELEASED','WITHDRAWN')),
    requester_user_id BIGINT NOT NULL REFERENCES app_user(user_id),
    source_location_id BIGINT REFERENCES location(location_id),
    destination_location_id BIGINT REFERENCES location(location_id),
    reason TEXT,
    rejection_reason TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    submitted_at TIMESTAMPTZ,
    approved_at TIMESTAMPTZ,
    released_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (source_location_id IS NULL OR destination_location_id IS NULL OR source_location_id <> destination_location_id)
);
CREATE INDEX stock_request_queue_idx ON stock_request(status, created_at DESC);

CREATE TABLE stock_request_line (
    stock_request_line_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stock_request_id BIGINT NOT NULL REFERENCES stock_request(stock_request_id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES product(product_id),
    quantity NUMERIC(18,3) NOT NULL CHECK (quantity > 0),
    uom_id BIGINT NOT NULL REFERENCES uom(uom_id),
    source_uom_raw TEXT,
    condition_id BIGINT NOT NULL REFERENCES inventory_condition(condition_id),
    source_location_id BIGINT REFERENCES location(location_id),
    destination_location_id BIGINT REFERENCES location(location_id),
    notes TEXT,
    UNIQUE(stock_request_id, stock_request_line_id)
);

CREATE TABLE stock_request_action (
    stock_request_action_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stock_request_id BIGINT NOT NULL REFERENCES stock_request(stock_request_id) ON DELETE CASCADE,
    actor_user_id BIGINT NOT NULL REFERENCES app_user(user_id),
    action TEXT NOT NULL CHECK (action IN ('CREATE','EDIT','SUBMIT','WITHDRAW','APPROVE','REJECT','RELEASE')),
    from_status TEXT,
    to_status TEXT,
    comment TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX resolution_case_open_idx ON resolution_case(status_id, opened_at DESC);

-- Units are first-class values.  The importer preserves the source unit in
-- source_uom_raw and selects a dictionary row when it can identify one.  No
-- implicit BOX/SET/M/ML -> EA conversion is performed by this POC.

-- Attach audit guards to production-domain writes. API/import transactions must
-- insert audit_event first and set the local GUCs documented above.
CREATE TRIGGER app_user_audit_trg BEFORE INSERT OR UPDATE OR DELETE ON app_user
    FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER app_session_audit_trg BEFORE INSERT OR UPDATE OR DELETE ON app_session
    FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER product_audit_trg BEFORE INSERT OR UPDATE OR DELETE ON product
    FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER uom_audit_trg BEFORE INSERT OR UPDATE OR DELETE ON uom
    FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER organization_audit_trg BEFORE INSERT OR UPDATE OR DELETE ON organization
    FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER location_audit_trg BEFORE INSERT OR UPDATE OR DELETE ON location
    FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER product_identifier_audit_trg BEFORE INSERT OR UPDATE OR DELETE ON product_identifier
    FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER product_name_alias_audit_trg BEFORE INSERT OR UPDATE OR DELETE ON product_name_alias
    FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER location_alias_audit_trg BEFORE INSERT OR UPDATE OR DELETE ON location_alias
    FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER asset_audit_trg BEFORE INSERT OR UPDATE OR DELETE ON asset
    FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER asset_identifier_audit_trg BEFORE INSERT OR UPDATE OR DELETE ON asset_identifier
    FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER asset_component_assignment_audit_trg BEFORE INSERT OR UPDATE OR DELETE ON asset_component_assignment
    FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER asset_event_audit_trg BEFORE INSERT OR UPDATE OR DELETE ON asset_event
    FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER inventory_movement_audit_trg BEFORE INSERT OR UPDATE OR DELETE ON inventory_movement
    FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER inventory_snapshot_audit_trg BEFORE INSERT OR UPDATE OR DELETE ON inventory_snapshot
    FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER inventory_movement_asset_audit_trg BEFORE INSERT OR UPDATE OR DELETE ON inventory_movement_asset
    FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER stock_request_audit_trg BEFORE INSERT OR UPDATE OR DELETE ON stock_request
    FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER stock_request_line_audit_trg BEFORE INSERT OR UPDATE OR DELETE ON stock_request_line
    FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER stock_request_action_audit_trg BEFORE INSERT OR UPDATE OR DELETE ON stock_request_action
    FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER resolution_case_audit_trg BEFORE INSERT OR UPDATE OR DELETE ON resolution_case
    FOR EACH ROW EXECUTE FUNCTION require_audit_context();
CREATE TRIGGER data_quality_issue_audit_trg BEFORE INSERT OR UPDATE OR DELETE ON data_quality_issue
    FOR EACH ROW EXECUTE FUNCTION require_audit_context();

COMMENT ON TABLE audit_event IS 'Append-only audit trail; production writes require a same-transaction audit event.';
COMMENT ON TABLE stock_request IS 'OA stock request and approval state machine.';
COMMENT ON COLUMN stock_request_line.source_uom_raw IS 'Original source unit text; no automatic conversion is applied.';

COMMIT;
