-- 005: 搜索性能索引 + 缩略图列（幂等，可在已有库上安全重复执行）。
-- 全新库：docker-entrypoint-initdb.d 自动执行；已有库：deploy_remote.sh 用 psql 执行一次。
BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 与 api/main.py `_product_where` 的 LIKE 左值逐字节一致，否则 planner 不会命中。
CREATE INDEX IF NOT EXISTS product_search_display_name_trgm_idx
    ON product USING gin (lower(regexp_replace(pg_catalog.normalize(coalesce(display_name,''),'NFKC'),'[[:space:]]','','g')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS product_search_manufacturer_trgm_idx
    ON product USING gin (lower(regexp_replace(pg_catalog.normalize(coalesce(manufacturer,''),'NFKC'),'[[:space:]]','','g')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS product_search_specification_trgm_idx
    ON product USING gin (lower(regexp_replace(pg_catalog.normalize(coalesce(specification,''),'NFKC'),'[[:space:]]','','g')) gin_trgm_ops);
-- *_normalized 写入期已 casefold，无需再 lower。
CREATE INDEX IF NOT EXISTS product_identifier_search_trgm_idx
    ON product_identifier USING gin (regexp_replace(value_normalized,'[[:space:]]','','g') gin_trgm_ops);
CREATE INDEX IF NOT EXISTS product_name_alias_search_trgm_idx
    ON product_name_alias USING gin (regexp_replace(alias_normalized,'[[:space:]]','','g') gin_trgm_ops);

-- v_inventory_balance 对全量流水聚合，状态过滤可借此索引下推。
CREATE INDEX IF NOT EXISTS inventory_movement_status_idx
    ON inventory_movement(status_id);

-- 货品图缩略图列（存量行保持 NULL，前端回退原图）。
ALTER TABLE product_image ADD COLUMN IF NOT EXISTS thumb_object_key TEXT;
ALTER TABLE product_image ADD COLUMN IF NOT EXISTS thumb_size INTEGER;

COMMIT;
