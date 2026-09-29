-- 001_inventory.sql
--
-- Initial PostgreSQL model for mapped inventory imports. Source
-- workbook's 编号 is deliberately stored as an identifier observation and is
-- never used as the primary key for product.  Every business entity uses an
-- internal BIGINT identity key; source identifiers and serial numbers remain
-- TEXT so that leading zeroes and mixed formats survive the import.

BEGIN;

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

CREATE TABLE record_status (
    status_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code            TEXT NOT NULL UNIQUE,
    display_name    TEXT NOT NULL,
    status_group    TEXT NOT NULL DEFAULT 'general'
        CHECK (status_group IN ('general', 'import', 'resolution', 'movement', 'asset')),
    is_terminal     BOOLEAN NOT NULL DEFAULT FALSE,
    description     TEXT
);

CREATE TABLE movement_type (
    movement_type_id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code                            TEXT NOT NULL UNIQUE,
    display_name                    TEXT NOT NULL,
    requires_source_location        BOOLEAN NOT NULL DEFAULT FALSE,
    requires_destination_location   BOOLEAN NOT NULL DEFAULT FALSE,
    allows_both_locations           BOOLEAN NOT NULL DEFAULT FALSE,
    affects_company_inventory       BOOLEAN NOT NULL DEFAULT TRUE,
    description                     TEXT
);

CREATE TABLE inventory_condition (
    condition_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code            TEXT NOT NULL UNIQUE,
    display_name    TEXT NOT NULL,
    description     TEXT
);

INSERT INTO record_status (code, display_name, status_group, is_terminal) VALUES
    ('imported',       'Imported',        'import',     FALSE),
    ('observed',       'Observed',        'import',     FALSE),
    ('pending_review', 'Pending review',  'resolution', FALSE),
    ('approved',       'Approved',        'resolution', FALSE),
    ('resolved',       'Resolved',        'resolution', TRUE),
    ('duplicate',      'Duplicate',       'resolution', TRUE),
    ('ignored',        'Ignored',         'resolution', TRUE),
    ('draft',          'Draft',           'movement',   FALSE),
    ('posted',         'Posted',          'movement',   TRUE),
    ('reversed',       'Reversed',        'movement',   TRUE),
    ('rejected',       'Rejected',        'movement',   TRUE),
    ('active',         'Active',          'asset',      FALSE),
    ('retired',        'Retired',         'asset',      TRUE),
    ('lost',           'Lost',            'asset',      TRUE)
ON CONFLICT (code) DO NOTHING;

INSERT INTO movement_type
    (code, display_name, requires_source_location, requires_destination_location,
     allows_both_locations, affects_company_inventory)
VALUES
    ('OPENING',          'Opening balance', FALSE, TRUE,  FALSE, TRUE),
    ('RECEIPT',          'Receipt',         FALSE, TRUE,  FALSE, TRUE),
    -- Outbound issues may optionally name an external/customer destination;
    -- the source location remains mandatory for a posted issue.
    ('ISSUE_OTHER',      'Issue - other',   TRUE,  FALSE, TRUE,  TRUE),
    ('ISSUE_SALE',      'Issue - sale',    TRUE,  FALSE, TRUE,  TRUE),
    ('ISSUE_CONSUMPTION','Issue - consume', TRUE,  FALSE, TRUE,  TRUE),
    ('ISSUE_GIFT',      'Issue - gift',    TRUE,  FALSE, TRUE,  TRUE),
    ('ISSUE_SCRAP',     'Issue - scrap',   TRUE,  FALSE, TRUE,  TRUE),
    ('TRANSFER',        'Transfer',         TRUE,  TRUE,  TRUE,  TRUE),
    ('RETURN',          'Return',           FALSE, TRUE,  FALSE, TRUE),
    ('ADJUSTMENT',      'Adjustment',       FALSE, FALSE, TRUE,  TRUE)
ON CONFLICT (code) DO NOTHING;

INSERT INTO inventory_condition (code, display_name) VALUES
    ('new',          'New'),
    ('used',         'Used'),
    ('refurbished',  'Refurbished'),
    ('damaged',      'Damaged'),
    ('scrapped',     'Scrapped'),
    ('unknown',      'Unknown')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE uom (
    uom_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code            TEXT NOT NULL UNIQUE,
    display_name    TEXT NOT NULL,
    decimal_scale   SMALLINT NOT NULL DEFAULT 3 CHECK (decimal_scale BETWEEN 0 AND 6),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO uom (code, display_name, decimal_scale) VALUES
    ('EA', 'Each', 0),
    ('BOX', 'Box', 0),
    ('SET', 'Set', 0),
    ('ML', 'Millilitre', 3),
    ('UNKNOWN', 'Unknown unit', 3)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Master data: products, organisations and locations
-- ---------------------------------------------------------------------------

CREATE TABLE product (
    product_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    system_sku          TEXT UNIQUE,
    display_name        TEXT NOT NULL CHECK (length(btrim(display_name)) > 0),
    manufacturer        TEXT,
    specification       TEXT,
    default_uom_id      BIGINT REFERENCES uom (uom_id),
    default_condition_id BIGINT REFERENCES inventory_condition (condition_id),
    status_id           BIGINT REFERENCES record_status (status_id),
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE organization (
    organization_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_type   TEXT NOT NULL DEFAULT 'company'
        CHECK (organization_type IN ('company', 'hospital', 'department', 'customer', 'supplier', 'external', 'other')),
    name                TEXT NOT NULL CHECK (length(btrim(name)) > 0),
    parent_organization_id BIGINT REFERENCES organization (organization_id),
    is_company_entity   BOOLEAN NOT NULL DEFAULT FALSE,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    notes               TEXT,
    UNIQUE (organization_type, name)
);

CREATE TABLE location (
    location_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id     BIGINT REFERENCES organization (organization_id),
    parent_location_id  BIGINT REFERENCES location (location_id),
    location_type       TEXT NOT NULL DEFAULT 'warehouse'
        CHECK (location_type IN ('warehouse', 'hospital', 'department', 'customer', 'external', 'transit', 'other')),
    code                TEXT,
    name                TEXT NOT NULL CHECK (length(btrim(name)) > 0),
    is_company_inventory BOOLEAN NOT NULL DEFAULT FALSE,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    notes               TEXT,
    UNIQUE (organization_id, code)
);

-- A source number can be shared by multiple products while it is unverified.
-- The partial index below enforces uniqueness only after human review marks an
-- identifier as both verified and exclusive.
CREATE TABLE product_identifier (
    product_identifier_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id          BIGINT NOT NULL REFERENCES product (product_id),
    identifier_type     TEXT NOT NULL DEFAULT 'source_number'
        CHECK (identifier_type IN ('source_number', 'internal_sku', 'manufacturer_code', 'barcode', 'legacy_number', 'other')),
    namespace           TEXT NOT NULL DEFAULT 'mapped_xlsx',
    value_raw           TEXT NOT NULL,
    value_normalized    TEXT NOT NULL CHECK (length(btrim(value_normalized)) > 0),
    is_primary          BOOLEAN NOT NULL DEFAULT FALSE,
    is_verified         BOOLEAN NOT NULL DEFAULT FALSE,
    is_exclusive        BOOLEAN NOT NULL DEFAULT FALSE,
    source_record_id    BIGINT,
    notes               TEXT,
    UNIQUE (product_id, identifier_type, namespace, value_normalized)
);

CREATE UNIQUE INDEX product_identifier_verified_exclusive_uq
    ON product_identifier (namespace, identifier_type, value_normalized)
    WHERE is_verified AND is_exclusive;

CREATE TABLE product_name_alias (
    product_name_alias_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id          BIGINT NOT NULL REFERENCES product (product_id),
    alias_raw           TEXT NOT NULL,
    alias_normalized    TEXT NOT NULL CHECK (length(btrim(alias_normalized)) > 0),
    source_record_id    BIGINT,
    is_verified         BOOLEAN NOT NULL DEFAULT FALSE,
    is_exclusive        BOOLEAN NOT NULL DEFAULT FALSE,
    notes               TEXT,
    UNIQUE (product_id, alias_normalized)
);

CREATE UNIQUE INDEX product_name_alias_verified_exclusive_uq
    ON product_name_alias (alias_normalized)
    WHERE is_verified AND is_exclusive;

CREATE TABLE location_alias (
    location_alias_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    location_id         BIGINT NOT NULL REFERENCES location (location_id),
    alias_raw           TEXT NOT NULL,
    alias_normalized    TEXT NOT NULL CHECK (length(btrim(alias_normalized)) > 0),
    source_record_id    BIGINT,
    is_verified         BOOLEAN NOT NULL DEFAULT FALSE,
    is_exclusive        BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (location_id, alias_normalized)
);

CREATE UNIQUE INDEX location_alias_verified_exclusive_uq
    ON location_alias (alias_normalized)
    WHERE is_verified AND is_exclusive;

-- ---------------------------------------------------------------------------
-- Staging and audit records
-- ---------------------------------------------------------------------------

CREATE TABLE import_batch (
    import_batch_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_file_name    TEXT NOT NULL,
    source_sha256       TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9A-Fa-f]{64}$'),
    source_file_size    BIGINT CHECK (source_file_size IS NULL OR source_file_size >= 0),
    password_protected  BOOLEAN NOT NULL DEFAULT FALSE,
    imported_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    status_id           BIGINT NOT NULL REFERENCES record_status (status_id),
    importer_version    TEXT,
    notes               TEXT,
    UNIQUE (source_sha256)
);

CREATE TABLE source_record (
    source_record_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    import_batch_id     BIGINT NOT NULL REFERENCES import_batch (import_batch_id),
    sheet_name          TEXT NOT NULL,
    block_name          TEXT NOT NULL DEFAULT 'default',
    source_row_number   INTEGER NOT NULL CHECK (source_row_number > 0),
    row_hash            TEXT NOT NULL CHECK (length(btrim(row_hash)) > 0),
    raw_values          JSONB,
    display_values      JSONB,
    normalized_values   JSONB,
    parse_status_id     BIGINT NOT NULL REFERENCES record_status (status_id),
    duplicate_of_source_record_id BIGINT REFERENCES source_record (source_record_id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (duplicate_of_source_record_id IS NULL OR duplicate_of_source_record_id <> source_record_id),
    UNIQUE (import_batch_id, sheet_name, block_name, source_row_number)
);

CREATE INDEX source_record_row_hash_idx
    ON source_record (import_batch_id, sheet_name, block_name, row_hash);

-- These FKs are added after source_record because product/location master
-- tables are created before the staging layer.
ALTER TABLE product_identifier
    ADD CONSTRAINT product_identifier_source_record_fk
    FOREIGN KEY (source_record_id) REFERENCES source_record (source_record_id);

ALTER TABLE product_name_alias
    ADD CONSTRAINT product_name_alias_source_record_fk
    FOREIGN KEY (source_record_id) REFERENCES source_record (source_record_id);

ALTER TABLE location_alias
    ADD CONSTRAINT location_alias_source_record_fk
    FOREIGN KEY (source_record_id) REFERENCES source_record (source_record_id);

CREATE TABLE product_observation (
    product_observation_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_record_id    BIGINT NOT NULL REFERENCES source_record (source_record_id),
    observation_ordinal INTEGER NOT NULL DEFAULT 1 CHECK (observation_ordinal > 0),
    source_identifier_raw TEXT,
    source_identifier_normalized TEXT,
    source_name_raw     TEXT,
    source_name_normalized TEXT,
    manufacturer_raw    TEXT,
    manufacturer_normalized TEXT,
    specification_raw   TEXT,
    specification_normalized TEXT,
    uom_raw             TEXT,
    opening_quantity_raw TEXT,
    opening_quantity    NUMERIC(18,3),
    existing_quantity_raw TEXT,
    existing_quantity   NUMERIC(18,3),
    resolved_product_id BIGINT REFERENCES product (product_id),
    resolution_status_id BIGINT NOT NULL REFERENCES record_status (status_id),
    match_method        TEXT,
    notes               TEXT,
    UNIQUE (source_record_id, observation_ordinal)
);

CREATE TABLE movement_candidate (
    movement_candidate_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_record_id    BIGINT NOT NULL REFERENCES source_record (source_record_id),
    candidate_ordinal   INTEGER NOT NULL DEFAULT 1 CHECK (candidate_ordinal > 0),
    candidate_kind      TEXT NOT NULL DEFAULT 'inventory'
        CHECK (candidate_kind IN ('inventory', 'ignore', 'duplicate', 'review')),
    movement_type_id    BIGINT REFERENCES movement_type (movement_type_id),
    product_id          BIGINT REFERENCES product (product_id),
    movement_date_raw   TEXT,
    movement_date       DATE,
    quantity_raw        TEXT,
    quantity            NUMERIC(18,3),
    uom_id              BIGINT REFERENCES uom (uom_id),
    source_location_raw TEXT,
    destination_location_raw TEXT,
    source_location_id  BIGINT REFERENCES location (location_id),
    destination_location_id BIGINT REFERENCES location (location_id),
    condition_id        BIGINT REFERENCES inventory_condition (condition_id),
    resolution_status_id BIGINT NOT NULL REFERENCES record_status (status_id),
    classification_method TEXT,
    notes               TEXT,
    UNIQUE (source_record_id, candidate_ordinal)
);

CREATE TABLE asset_observation (
    asset_observation_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_record_id    BIGINT NOT NULL REFERENCES source_record (source_record_id),
    observation_ordinal INTEGER NOT NULL DEFAULT 1 CHECK (observation_ordinal > 0),
    manufacturer_raw    TEXT,
    asset_type_raw      TEXT,
    model_raw           TEXT,
    serial_raw          TEXT,
    serial_normalized   TEXT,
    host_serial_raw     TEXT,
    component_serial_raw TEXT,
    observed_status_raw TEXT,
    resolved_asset_id   BIGINT,
    resolution_status_id BIGINT NOT NULL REFERENCES record_status (status_id),
    match_method        TEXT,
    notes               TEXT,
    UNIQUE (source_record_id, observation_ordinal)
);

CREATE TABLE resolution_case (
    resolution_case_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_record_id   BIGINT REFERENCES source_record (source_record_id),
    product_observation_id BIGINT REFERENCES product_observation (product_observation_id),
    movement_candidate_id BIGINT REFERENCES movement_candidate (movement_candidate_id),
    asset_observation_id BIGINT REFERENCES asset_observation (asset_observation_id),
    case_type          TEXT NOT NULL
        CHECK (case_type IN ('missing_identifier', 'identifier_collision', 'name_conflict', 'invalid_date', 'invalid_quantity', 'ambiguous_location', 'duplicate', 'credential_exclusion', 'other')),
    status_id          BIGINT NOT NULL REFERENCES record_status (status_id),
    opened_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at        TIMESTAMPTZ,
    assigned_to        TEXT,
    resolution_notes   TEXT,
    CHECK (resolved_at IS NULL OR resolved_at >= opened_at),
    CHECK (source_record_id IS NOT NULL OR product_observation_id IS NOT NULL OR movement_candidate_id IS NOT NULL OR asset_observation_id IS NOT NULL)
);

CREATE TABLE data_quality_issue (
    data_quality_issue_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_record_id   BIGINT REFERENCES source_record (source_record_id),
    product_observation_id BIGINT REFERENCES product_observation (product_observation_id),
    movement_candidate_id BIGINT REFERENCES movement_candidate (movement_candidate_id),
    asset_observation_id BIGINT REFERENCES asset_observation (asset_observation_id),
    issue_code         TEXT NOT NULL,
    severity           TEXT NOT NULL DEFAULT 'warning'
        CHECK (severity IN ('info', 'warning', 'error', 'critical')),
    status_id          BIGINT NOT NULL REFERENCES record_status (status_id),
    message            TEXT NOT NULL,
    raw_value          TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at        TIMESTAMPTZ,
    resolution_notes   TEXT,
    CHECK (resolved_at IS NULL OR resolved_at >= created_at)
);

-- ---------------------------------------------------------------------------
-- Assets and serial-number history
-- ---------------------------------------------------------------------------

CREATE TABLE asset (
    asset_id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    asset_type         TEXT NOT NULL CHECK (length(btrim(asset_type)) > 0),
    manufacturer       TEXT,
    model              TEXT,
    status_id          BIGINT REFERENCES record_status (status_id),
    condition_id       BIGINT REFERENCES inventory_condition (condition_id),
    acquired_date      DATE,
    source_record_id   BIGINT REFERENCES source_record (source_record_id),
    notes              TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (acquired_date IS NULL OR acquired_date BETWEEN DATE '1900-01-01' AND DATE '2200-01-01')
);

ALTER TABLE asset_observation
    ADD CONSTRAINT asset_observation_resolved_asset_fk
    FOREIGN KEY (resolved_asset_id) REFERENCES asset (asset_id);

CREATE TABLE asset_identifier (
    asset_identifier_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    asset_id           BIGINT NOT NULL REFERENCES asset (asset_id),
    identifier_type    TEXT NOT NULL
        CHECK (identifier_type IN ('host_serial', 'component_serial', 'source_serial', 'imei', 'asset_tag', 'other')),
    namespace          TEXT NOT NULL,
    value_raw          TEXT NOT NULL,
    value_normalized   TEXT NOT NULL CHECK (length(btrim(value_normalized)) > 0),
    component_role     TEXT,
    is_primary         BOOLEAN NOT NULL DEFAULT FALSE,
    is_verified        BOOLEAN NOT NULL DEFAULT FALSE,
    is_exclusive       BOOLEAN NOT NULL DEFAULT FALSE,
    source_record_id   BIGINT REFERENCES source_record (source_record_id),
    notes              TEXT,
    UNIQUE (asset_id, identifier_type, namespace, value_normalized)
);

CREATE UNIQUE INDEX asset_identifier_verified_exclusive_uq
    ON asset_identifier (namespace, identifier_type, value_normalized)
    WHERE is_verified AND is_exclusive;

CREATE TABLE asset_component_assignment (
    asset_component_assignment_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parent_asset_id    BIGINT NOT NULL REFERENCES asset (asset_id),
    component_asset_id BIGINT NOT NULL REFERENCES asset (asset_id),
    component_role     TEXT NOT NULL CHECK (length(btrim(component_role)) > 0),
    valid_from         DATE NOT NULL,
    valid_to           DATE,
    source_record_id   BIGINT REFERENCES source_record (source_record_id),
    notes              TEXT,
    CHECK (parent_asset_id <> component_asset_id),
    CHECK (valid_to IS NULL OR valid_to >= valid_from),
    CHECK (valid_from BETWEEN DATE '1900-01-01' AND DATE '2200-01-01'),
    CHECK (valid_to IS NULL OR valid_to BETWEEN DATE '1900-01-01' AND DATE '2200-01-01'),
    UNIQUE (parent_asset_id, component_asset_id, component_role, valid_from)
);

CREATE UNIQUE INDEX asset_component_active_role_uq
    ON asset_component_assignment (parent_asset_id, component_role)
    WHERE valid_to IS NULL;

CREATE UNIQUE INDEX asset_component_active_component_uq
    ON asset_component_assignment (component_asset_id)
    WHERE valid_to IS NULL;

CREATE TABLE asset_event (
    asset_event_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    asset_id           BIGINT NOT NULL REFERENCES asset (asset_id),
    event_type         TEXT NOT NULL
        CHECK (event_type IN ('observed', 'received', 'issued', 'transferred', 'returned', 'component_attached', 'component_removed', 'repaired', 'retired', 'lost', 'adjusted')),
    event_date         DATE NOT NULL,
    status_id          BIGINT REFERENCES record_status (status_id),
    condition_id       BIGINT REFERENCES inventory_condition (condition_id),
    from_location_id   BIGINT REFERENCES location (location_id),
    to_location_id     BIGINT REFERENCES location (location_id),
    inventory_movement_id BIGINT,
    source_record_id   BIGINT REFERENCES source_record (source_record_id),
    notes              TEXT,
    CHECK (event_date BETWEEN DATE '1900-01-01' AND DATE '2200-01-01'),
    CHECK (from_location_id IS NULL OR to_location_id IS NULL OR from_location_id <> to_location_id)
);

-- ---------------------------------------------------------------------------
-- Inventory ledger and snapshots
-- ---------------------------------------------------------------------------

CREATE TABLE inventory_movement (
    inventory_movement_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    movement_type_id    BIGINT NOT NULL REFERENCES movement_type (movement_type_id),
    status_id           BIGINT NOT NULL REFERENCES record_status (status_id),
    movement_date       DATE NOT NULL,
    product_id          BIGINT NOT NULL REFERENCES product (product_id),
    quantity            NUMERIC(18,3) NOT NULL CHECK (quantity > 0),
    uom_id              BIGINT NOT NULL REFERENCES uom (uom_id),
    condition_id        BIGINT NOT NULL REFERENCES inventory_condition (condition_id),
    source_location_id  BIGINT REFERENCES location (location_id),
    destination_location_id BIGINT REFERENCES location (location_id),
    source_record_id    BIGINT REFERENCES source_record (source_record_id),
    source_line_no      INTEGER NOT NULL DEFAULT 1 CHECK (source_line_no > 0),
    reversal_of_movement_id BIGINT REFERENCES inventory_movement (inventory_movement_id),
    external_reference  TEXT,
    notes               TEXT,
    posted_at           TIMESTAMPTZ,
    posted_by           TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (movement_date BETWEEN DATE '1900-01-01' AND DATE '2200-01-01'),
    CHECK (source_location_id IS NOT NULL OR destination_location_id IS NOT NULL),
    CHECK (source_location_id IS NULL OR destination_location_id IS NULL OR source_location_id <> destination_location_id),
    CHECK (reversal_of_movement_id IS NULL OR reversal_of_movement_id <> inventory_movement_id),
    UNIQUE (source_record_id, source_line_no)
);

-- CHECK constraints above validate scalar values.  This trigger validates the
-- location shape against the selected lookup row once a movement is posted;
-- drafts may remain incomplete while an importer resolves their location.
CREATE OR REPLACE FUNCTION validate_posted_inventory_movement()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
    v_status_code       TEXT;
    v_requires_source   BOOLEAN;
    v_requires_target   BOOLEAN;
    v_allows_both       BOOLEAN;
BEGIN
    SELECT rs.code
      INTO v_status_code
      FROM record_status rs
     WHERE rs.status_id = NEW.status_id;

    IF v_status_code = 'posted' THEN
        SELECT mt.requires_source_location,
               mt.requires_destination_location,
               mt.allows_both_locations
          INTO v_requires_source, v_requires_target, v_allows_both
          FROM movement_type mt
         WHERE mt.movement_type_id = NEW.movement_type_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Movement type % does not exist', NEW.movement_type_id;
        END IF;

        IF v_requires_source AND NEW.source_location_id IS NULL THEN
            RAISE EXCEPTION 'Posted % movement requires a source location', NEW.movement_type_id;
        END IF;
        IF v_requires_target AND NEW.destination_location_id IS NULL THEN
            RAISE EXCEPTION 'Posted % movement requires a destination location', NEW.movement_type_id;
        END IF;
        IF NOT v_allows_both
           AND NEW.source_location_id IS NOT NULL
           AND NEW.destination_location_id IS NOT NULL THEN
            RAISE EXCEPTION 'Movement type % cannot have both source and destination locations', NEW.movement_type_id;
        END IF;
    END IF;

    RETURN NEW;
END;
$function$;

CREATE TRIGGER inventory_movement_posted_shape_trg
    BEFORE INSERT OR UPDATE OF movement_type_id, status_id,
        source_location_id, destination_location_id
    ON inventory_movement
    FOR EACH ROW
    EXECUTE FUNCTION validate_posted_inventory_movement();

-- Each source row/line can be posted at most once.  A NULL source row is
-- allowed for a manually entered opening/adjustment and is intentionally not
-- covered by the unique constraint semantics of PostgreSQL.
CREATE INDEX inventory_movement_product_date_idx
    ON inventory_movement (product_id, movement_date);

CREATE INDEX inventory_movement_location_date_idx
    ON inventory_movement (source_location_id, destination_location_id, movement_date);

CREATE TABLE inventory_snapshot (
    inventory_snapshot_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    snapshot_date       DATE,
    product_id          BIGINT NOT NULL REFERENCES product (product_id),
    location_id         BIGINT NOT NULL REFERENCES location (location_id),
    condition_id        BIGINT NOT NULL REFERENCES inventory_condition (condition_id),
    uom_id              BIGINT NOT NULL REFERENCES uom (uom_id),
    -- Reported workbook quantities are kept verbatim for reconciliation; an
    -- unexpected negative value is a data-quality finding, not a load failure.
    reported_quantity   NUMERIC(18,3) NOT NULL,
    source_record_id    BIGINT REFERENCES source_record (source_record_id),
    source_line_no      INTEGER NOT NULL DEFAULT 1 CHECK (source_line_no > 0),
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (snapshot_date IS NULL OR snapshot_date BETWEEN DATE '1900-01-01' AND DATE '2200-01-01'),
    UNIQUE (source_record_id, source_line_no)
);

CREATE TABLE inventory_movement_asset (
    inventory_movement_asset_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inventory_movement_id BIGINT NOT NULL REFERENCES inventory_movement (inventory_movement_id),
    asset_id           BIGINT NOT NULL REFERENCES asset (asset_id),
    asset_role         TEXT NOT NULL DEFAULT 'primary',
    quantity           NUMERIC(18,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
    notes              TEXT,
    UNIQUE (inventory_movement_id, asset_id, asset_role)
);

-- The inventory_movement -> asset_event foreign key is defined after both
-- tables exist, so asset events can point back to the ledger without cycles
-- during table creation.

ALTER TABLE asset_event
    ADD CONSTRAINT asset_event_inventory_movement_fk
    FOREIGN KEY (inventory_movement_id) REFERENCES inventory_movement (inventory_movement_id);

-- ---------------------------------------------------------------------------
-- Reporting views
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_inventory_balance AS
WITH posted_movements AS (
    SELECT
        im.product_id,
        im.condition_id,
        im.uom_id,
        im.destination_location_id AS location_id,
        im.quantity AS quantity_delta
    FROM inventory_movement im
    JOIN record_status rs ON rs.status_id = im.status_id AND rs.code = 'posted'
    WHERE im.destination_location_id IS NOT NULL

    UNION ALL

    SELECT
        im.product_id,
        im.condition_id,
        im.uom_id,
        im.source_location_id AS location_id,
        -im.quantity AS quantity_delta
    FROM inventory_movement im
    JOIN record_status rs ON rs.status_id = im.status_id AND rs.code = 'posted'
    WHERE im.source_location_id IS NOT NULL
)
SELECT
    pm.product_id,
    p.display_name AS product_name,
    pm.location_id,
    l.name AS location_name,
    pm.condition_id,
    ic.code AS condition_code,
    pm.uom_id,
    u.code AS uom_code,
    SUM(pm.quantity_delta)::NUMERIC(18,3) AS on_hand_quantity
FROM posted_movements pm
JOIN product p ON p.product_id = pm.product_id
JOIN location l ON l.location_id = pm.location_id
JOIN inventory_condition ic ON ic.condition_id = pm.condition_id
JOIN uom u ON u.uom_id = pm.uom_id
GROUP BY pm.product_id, p.display_name, pm.location_id, l.name,
         pm.condition_id, ic.code, pm.uom_id, u.code;

CREATE OR REPLACE VIEW v_company_inventory_balance AS
SELECT
    b.product_id,
    b.product_name,
    b.condition_id,
    b.condition_code,
    b.uom_id,
    b.uom_code,
    SUM(b.on_hand_quantity)::NUMERIC(18,3) AS company_on_hand_quantity
FROM v_inventory_balance b
JOIN location l ON l.location_id = b.location_id
WHERE l.is_company_inventory
GROUP BY b.product_id, b.product_name, b.condition_id, b.condition_code, b.uom_id, b.uom_code;

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

CREATE OR REPLACE VIEW v_migration_reconciliation AS
WITH latest_snapshot AS (
    SELECT DISTINCT ON (s.product_id, s.location_id, s.condition_id, s.uom_id)
        s.inventory_snapshot_id,
        s.snapshot_date,
        s.product_id,
        s.location_id,
        s.condition_id,
        s.uom_id,
        s.reported_quantity
    FROM inventory_snapshot s
    ORDER BY s.product_id, s.location_id, s.condition_id, s.uom_id,
             s.snapshot_date DESC NULLS LAST, s.inventory_snapshot_id DESC
), ledger AS (
    SELECT product_id, location_id, condition_id, uom_id, on_hand_quantity
    FROM v_inventory_balance
)
SELECT
    COALESCE(ls.product_id, le.product_id) AS product_id,
    p.display_name AS product_name,
    COALESCE(ls.location_id, le.location_id) AS location_id,
    l.name AS location_name,
    COALESCE(ls.condition_id, le.condition_id) AS condition_id,
    ic.code AS condition_code,
    COALESCE(ls.uom_id, le.uom_id) AS uom_id,
    u.code AS uom_code,
    ls.snapshot_date,
    ls.reported_quantity AS source_snapshot_quantity,
    le.on_hand_quantity AS ledger_quantity,
    (COALESCE(le.on_hand_quantity, 0) - COALESCE(ls.reported_quantity, 0))::NUMERIC(18,3) AS quantity_delta,
    CASE
        WHEN ls.inventory_snapshot_id IS NULL THEN 'MISSING_SNAPSHOT'
        WHEN le.product_id IS NULL THEN 'MISSING_LEDGER'
        WHEN le.on_hand_quantity = ls.reported_quantity THEN 'MATCH'
        ELSE 'DIFFERENCE'
    END AS reconciliation_status
FROM latest_snapshot ls
FULL OUTER JOIN ledger le
    ON le.product_id = ls.product_id
   AND le.location_id = ls.location_id
   AND le.condition_id = ls.condition_id
   AND le.uom_id = ls.uom_id
JOIN product p ON p.product_id = COALESCE(ls.product_id, le.product_id)
JOIN location l ON l.location_id = COALESCE(ls.location_id, le.location_id)
JOIN inventory_condition ic ON ic.condition_id = COALESCE(ls.condition_id, le.condition_id)
JOIN uom u ON u.uom_id = COALESCE(ls.uom_id, le.uom_id);

-- Column-level comments document the intentional distinction between source
-- identifiers and stable internal keys.
COMMENT ON TABLE product IS 'Canonical product records; source 编号 values live in product_identifier and are not product keys.';
COMMENT ON TABLE product_identifier IS 'Observed/source identifiers, retaining leading zeroes and allowing reviewed collisions.';
COMMENT ON TABLE source_record IS 'Immutable source row audit record used for idempotent imports and traceability.';
COMMENT ON TABLE inventory_movement IS 'Posted or pending inventory ledger entries; balances are derived only from posted rows.';
COMMENT ON TABLE inventory_snapshot IS 'Reported workbook quantity retained for migration reconciliation, not a ledger mutation.';
COMMENT ON VIEW v_company_inventory_balance IS 'Product-level balance restricted to locations marked as company inventory.';

COMMIT;
