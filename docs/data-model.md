# 数据模型与迁移

数据库是 PostgreSQL 16，schema 全部由 `db/migrations/` 下的纯 SQL 文件定义。**没有迁移框架**：文件按文件名顺序执行，靠 `IF NOT EXISTS` / `ON CONFLICT DO NOTHING` 等写法保证幂等（可安全重复执行）。

## 迁移的两种执行方式

- **最低版本**：PostgreSQL ≥ 14（迁移使用 `CREATE OR REPLACE TRIGGER`）。
- **幂等性**：001-010 全部语句可重复执行（`IF NOT EXISTS` / `CREATE OR REPLACE TRIGGER` / DO 块判存在 / 视图存在即跳过）；重放正确性由 `tests/test_migrations_idempotent.py` 持续验证。
- **全新卷**：postgres 容器首次初始化时，`docker-compose.yml` 把 `db/migrations` 只读挂载到 `/docker-entrypoint-initdb.d`，由官方镜像入口按文件名顺序自动执行 001→010。
- **已有卷**（本地升级或测试环境）：`docker-entrypoint-initdb.d` 不会重跑，需要手动或由 `deploy/deploy_remote.sh` 幂等补跑新增迁移。已应用 001–009 的库，先执行以下命令再启动新 API；货品搜索直接依赖 010 的生成列：

  ```sh
  docker compose exec postgres psql -v ON_ERROR_STOP=1 -U inventory -d inventory \
    -f /docker-entrypoint-initdb.d/010_perf_indexes.sql
  ```

  用户名/库名以 `.env` 中 `POSTGRES_USER`/`POSTGRES_DB` 为准；更早版本需按文件名顺序补齐全部缺失迁移。远程脚本会重放全部迁移，需等脚本完成；其先前的健康检查只确认数据库连通，不确认生成列已经就绪。

## 迁移清单

| 迁移 | 内容 |
|---|---|
| `001_inventory.sql` | 首版数据模型：参考数据（`record_status`、`movement_type`、`inventory_condition`、`uom`）、货品（`product` + `product_identifier`/`product_name_alias`）、组织与库位（`organization`、`location` + `location_alias`）、不可变库存流水 `inventory_movement`、快照对账表 `inventory_snapshot`、暂存/导入审计层（`import_batch`、`source_record`、`product_observation`、`movement_candidate`、`asset_observation`、`resolution_case`、`data_quality_issue`）、资产域（`asset`、`asset_identifier`、`asset_component_assignment`、`asset_event`）、四个查询视图（余额、组织库存、资产现状、迁移对账）。来源编号只作标识观察，主键一律是内部 `BIGINT identity`。 |
| `002_erp_oa.sql` | 用户与会话（`app_user`、`app_session`）、审计基础设施（`audit_event` + `require_audit_context` 触发器）、仓管审批的申请单（`stock_request`/`stock_request_line`/`stock_request_action`）、`source_uom_raw` 列与单位字典扩展（M/KG/L）；不做隐式单位换算。 |
| `003_full_erp.sql` | 进销存一体扩展：RBAC 扩为五角色（ADMIN/WAREHOUSE/SALES/FINANCE/COLLEAGUE）、`department`、`product_category`、`product_price_tier`、`customer`、`supplier`、通用业务单据（`business_document` + `business_document_line`，覆盖采购/销售/库存 11 种 doc_type）、应收应付台账 `ar_ap_entry`、客户/供应商余额视图、BYTEA 附件 `document_attachment`。 |
| `004_product_images.sql` | `product_image` 表：图片字节存 MinIO（`object_key` 形如 `products/{pid}/{uuid}.{ext}`，永不下发客户端），库内只存元数据，带审计触发器；单图 ≤20MB。 |
| `005_search_indexes.sql` | 搜索性能：`pg_trgm` 扩展 + 与 `api/main.py` `_product_where` 的 LIKE 左值**逐字节一致**的表达式 trgm 索引（名称/厂家/型号）、缩略图列。幂等，可在已有库安全重跑。（表达式索引已被 010 的生成列索引取代并删除，`pg_trgm` 扩展与缩略图列仍生效。） |
| `007_login_throttle.sql` | 登录防爆破：`login_attempt`（用户名哈希+IP+结果）与查询索引。幂等。 |
| `008_hardening.sql` | 加固：audit_event 的 TRUNCATE 防护触发器；多态 party 的存在性触发器（business_document/ar_ap_entry）；外键列索引；`posted_by_user_id`/`reversed_by_user_id` 用户外键；`uom.decimal_scale` 收敛 0-3。幂等。 |
| `009_price_tier_uq.sql` | 批发档 (product_id, min_quantity) 唯一索引：同一起订数量两档并存会让命中价不确定。幂等。 |
| `006_serial_tracking.sql` | SN/UUID 流向追踪：激活 001 的资产域。`product.serialized` 是货品级软开关（登记可选，不填 SN 仍可过账）；单件以 `asset` + `asset_identifier(product_serial)` 建档，流向记 `asset_event`，经 `inventory_movement_asset` 关联流水；SN 按货品唯一（复用 001 的部分唯一索引）。重定义 `v_asset_current_state`、新增 `v_serial_ledger` 视图——注意 `CREATE OR REPLACE VIEW` 只能追加列，不能改变既有列顺序。 |
| `010_perf_indexes.sql` | 性能修复（2026-09 压测结论）：`product(display_name)` 排序 btree；搜索左值物化为 STORED 生成列（`product.search_display_name/search_manufacturer/search_specification`、`product_identifier.search_value`、`product_name_alias.search_alias`，表达式与原查询左值一致）+ 列上 trgm GIN，取代并删除 005 的表达式索引；登录热路径 GC 索引（`app_session(expires_at)`、`login_attempt(attempted_at)`）。幂等；新增 STORED 列会重写上述三张表，建立索引也需时间，大库低峰补跑。 |

## 核心对象速览

- **主数据**：`product`、`product_identifier`（编号观察，含 is_primary/is_verified/is_exclusive）、`uom`、`location`、`product_category`、`customer`、`supplier`、`product_price_tier`、`department`
- **库存**：`inventory_movement`（不可变流水，唯一余额来源）、`v_inventory_balance` / `v_company_inventory_balance`（只算已过账）、`inventory_snapshot`（用于与导入快照对账）
- **单据**：`business_document` + `business_document_line`（doc_type 前缀：PO/CG/CT/SO/XS/XT/DB/PD/BS/RK/CK）、`document_attachment`（BYTEA 存库）
- **资金往来**：`ar_ap_entry`、`v_customer_balance`、`v_supplier_balance`
- **OA**：`stock_request` + `stock_request_line` + `stock_request_action`
- **SN 追踪**：`asset`、`asset_identifier`、`asset_event`、`inventory_movement_asset`、`v_serial_ledger`
- **账号/审计**：`app_user`（五角色）、`app_session`（令牌与 CSRF 哈希）、`audit_event`
- **导入暂存**：`import_batch`、`source_record`、`product_observation`、`movement_candidate`、`asset_observation`、`resolution_case`、`data_quality_issue`

## 迁移约定（新增迁移时）

1. 新文件命名 `00N_主题.sql`，放在 `db/migrations/`，按顺序编号；文件头写清目的与设计约定。
2. **必须幂等**：`CREATE TABLE IF NOT EXISTS`、`ALTER TABLE ADD COLUMN IF NOT EXISTS`、`INSERT ... ON CONFLICT DO NOTHING`；视图重定义只能追加列。
3. 全新卷自动执行；已有卷需要补跑——要么在部署说明中记录命令，要么（涉及远程）在 `deploy/deploy_remote.sh` 中追加幂等补跑步骤。
4. 同步更新 `tests/test_schema_static.py` 等静态契约测试（见[开发指南](development.md)）。
5. 迁移只建结构与参考数据，**不凭空生成可信期初余额**；期初数据一律走[导入流程](data-import.md)人工审核切账。

## 审计机制

- 代码层：`api/db.py` 的 `audit()`（经 `set_audit_context`/`set_config`）在事务内声明操作者并写入 `audit_event`；`connection()` 本身不设置审计上下文。
- 数据库层：002 迁移给业务表挂载 `require_audit_context` 触发器——缺少审计上下文的写事务直接失败，绕过 API 的写入也会被拦下。
