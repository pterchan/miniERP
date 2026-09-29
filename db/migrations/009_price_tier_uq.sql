-- 009_price_tier_uq.sql
--
-- 批发档 (product_id, min_quantity) 唯一：同一起订数量两档并存时命中哪档
-- 取决于不稳定排序。幂等。

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS product_price_tier_min_qty_uq
    ON product_price_tier(product_id, min_quantity);

COMMIT;
