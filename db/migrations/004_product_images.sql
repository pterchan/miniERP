-- 货品附图（图片字节存 MinIO 对象存储，仅元数据入库）
BEGIN;

CREATE TABLE IF NOT EXISTS product_image (
    image_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id    BIGINT NOT NULL REFERENCES product(product_id) ON DELETE CASCADE,
    object_key    TEXT NOT NULL,          -- MinIO 内键（products/{pid}/{uuid}.{ext}），永不下发给客户端
    bucket        TEXT NOT NULL,          -- MinIO bucket 名
    filename      TEXT NOT NULL,
    content_type  TEXT NOT NULL,
    size          INTEGER NOT NULL CHECK (size >= 0 AND size <= 20971520),  -- 单图 ≤20MB
    sort_order    INTEGER NOT NULL DEFAULT 0,
    uploaded_by   BIGINT NOT NULL REFERENCES app_user(user_id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_image_product_idx ON product_image(product_id, sort_order, image_id);

CREATE OR REPLACE TRIGGER product_image_audit_trg
    BEFORE INSERT OR UPDATE OR DELETE ON product_image
    FOR EACH ROW EXECUTE FUNCTION require_audit_context();

COMMENT ON TABLE product_image IS '货品附图元数据；图片字节存 MinIO，按 object_key 访问，客户端只见 image_id';

COMMIT;
