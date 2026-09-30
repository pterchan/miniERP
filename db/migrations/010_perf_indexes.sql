-- 010: 性能修复索引（幂等，可在已有库上安全重复执行）。
-- 依据 2026-09 压测：货品列表 420ms 的根因是 ORDER BY display_name 无索引导致
-- stock LATERAL 对全表逐行求值；子串搜索 105ms 的根因是查询期逐行 NFKC+正则。
-- 修复：排序 btree + 搜索左值物化为 STORED 生成列（表达式与原查询左值逐字节一致）。
-- 注意：ADD COLUMN ... STORED 会重写 product 表（当前规模毫秒级；大表上线注意锁窗口）。
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. 货品列表默认排序：ORDER BY display_name 原为全表排序后再 LIMIT。
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS product_display_name_order_idx ON product (display_name);

-- ---------------------------------------------------------------------------
-- 2. 搜索左值物化：原查询在扫描时对每行做 NFKC + regexp_replace + lower，
--    planner 在多分支 OR 下弃用 005 的表达式 GIN 后退化为逐行 CPU 过滤。
--    生成列把求值挪到写入期，新 GIN 直接打在列上。
--    表达式与 api/main.py `_product_where`/`_fuzzy_pool_where` 的匹配左值一致。
-- ---------------------------------------------------------------------------
ALTER TABLE product ADD COLUMN IF NOT EXISTS search_display_name TEXT
    GENERATED ALWAYS AS (lower(regexp_replace(pg_catalog.normalize(coalesce(display_name, ''),'NFKC'), '[[:space:]]', '', 'g'))) STORED;
ALTER TABLE product ADD COLUMN IF NOT EXISTS search_manufacturer TEXT
    GENERATED ALWAYS AS (lower(regexp_replace(pg_catalog.normalize(coalesce(manufacturer, ''),'NFKC'), '[[:space:]]', '', 'g'))) STORED;
ALTER TABLE product ADD COLUMN IF NOT EXISTS search_specification TEXT
    GENERATED ALWAYS AS (lower(regexp_replace(pg_catalog.normalize(coalesce(specification, ''),'NFKC'), '[[:space:]]', '', 'g'))) STORED;
-- value_normalized / alias_normalized 写入期已 NFKC + casefold，这里只补去空白。
ALTER TABLE product_identifier ADD COLUMN IF NOT EXISTS search_value TEXT
    GENERATED ALWAYS AS (regexp_replace(value_normalized, '[[:space:]]', '', 'g')) STORED;
ALTER TABLE product_name_alias ADD COLUMN IF NOT EXISTS search_alias TEXT
    GENERATED ALWAYS AS (regexp_replace(alias_normalized, '[[:space:]]', '', 'g')) STORED;

CREATE INDEX IF NOT EXISTS product_display_name_search_gin
    ON product USING gin (search_display_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS product_manufacturer_search_gin
    ON product USING gin (search_manufacturer gin_trgm_ops);
CREATE INDEX IF NOT EXISTS product_specification_search_gin
    ON product USING gin (search_specification gin_trgm_ops);
CREATE INDEX IF NOT EXISTS product_identifier_search_value_gin
    ON product_identifier USING gin (search_value gin_trgm_ops);
CREATE INDEX IF NOT EXISTS product_name_alias_search_alias_gin
    ON product_name_alias USING gin (search_alias gin_trgm_ops);

-- 005 的表达式索引已被上面的列索引取代（查询已改打生成列），删除以降低货品写放大。
DROP INDEX IF EXISTS product_search_display_name_trgm_idx;
DROP INDEX IF EXISTS product_search_manufacturer_trgm_idx;
DROP INDEX IF EXISTS product_search_specification_trgm_idx;
DROP INDEX IF EXISTS product_identifier_search_trgm_idx;
DROP INDEX IF EXISTS product_name_alias_search_trgm_idx;

-- ---------------------------------------------------------------------------
-- 3. 登录热路径 GC：login 成功时按 expires_at / attempted_at 清理过期行，
--    原为全表扫描；两列均非既有复合索引的前导列，补单列 btree。
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS app_session_expires_idx ON app_session (expires_at);
CREATE INDEX IF NOT EXISTS login_attempt_attempted_idx ON login_attempt (attempted_at);

COMMIT;
