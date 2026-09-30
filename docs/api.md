# API 概览

后端是 FastAPI 应用（`api/main.py` 装配），所有业务接口挂在 `/api/` 前缀下，经 Web 容器反向代理（`/api/` → `api:8000/api/`）暴露。本文只写分组与约定；**逐端点的请求/响应结构以交互式文档为准**：

- FastAPI 自动生成 OpenAPI 文档，位于 **API 服务自身**的 `/docs` 与 `/openapi.json`（未自定义路径）。
- 它**不在** `/erp/api/` 代理路径上（Web 容器只代理 `/api/` 前缀），需通过本地 API 宿主机端口访问，例如 `http://127.0.0.1:8000/docs`。远程部署时，可按实际配置通过 SSH 隧道访问对应端口。

## 鉴权模型

- 登录（`POST /api/auth/login`）成功后签发两个 Cookie：`erp_session`（HttpOnly，库里只存令牌哈希，12 小时）与 `erp_csrf`（前端可读）。
- 所有**非 GET/HEAD/OPTIONS** 请求必须带 `X-CSRF-Token` 头，值等于 `erp_csrf` Cookie，且与会话内哈希匹配，否则 403。
- Cookie 的 `path` 取环境变量 `ERP_COOKIE_PATH`（`/erp/` 挂载时必须为 `/erp`），`secure` 由 `ERP_SECURE_COOKIES=1` 开启（内网 HTTP 部署默认关闭）。
- 未登录/过期返回 401（"登录已失效"），权限不足返回 403，校验失败返回 FastAPI 标准 422；错误体统一为 `{"detail": "中文说明"}`。
- 角色与单据权限矩阵定义在 `api/permissions.py`（5 角色 × 11 单据类型的可见/开单/过账权限，以及库存/往来效果），前端页面级控制在 `web/src/roles.js` 的 `PAGE_ACCESS`——后者仅控制导航可见性，服务端才是强制层。

## 路由分组

| 分组 | 前缀 | 主要端点 | 说明 |
|---|---|---|---|
| 健康 | `/healthz` | GET | 探活（含一次 DB 查询）；Web 容器把 `/api/healthz` 特判到这里 |
| 认证 | `/api/auth` | `login`、`logout`、`me`、`change-password` | |
| 工作台 | `/api/workbench/summary` | GET | 当前用户可处理事项、本人申请进度及异常统计 |
| 全局搜索 | `/api/search` | GET `q`/`limit` | 按角色与所有权裁剪的分组搜索 |
| OCR | `/api/ocr` | POST `extract` | 转发到独立 OCR 服务的薄代理（内部令牌鉴权） |
| 货品 | `/api/products` | 列表 `q`/模糊搜索、`stock`、`export`、详情、POST、PUT | 搜索命中不佳时回退模糊匹配（`api/search.py`） |
| 库存 | `/api/inventory` | GET `balance`、`balance/export`、`balance/{product}/{location}/{condition}/{uom}`、POST `adjust` | 清点=按实盘数覆写，写调整流水 |
| 单位/库位 | `/api/uoms`、`/api/locations` | 列表/导出/详情/增改 | |
| 业务单据 | `/api/documents` | 列表、`export`、详情、`{id}/history`、POST、PUT、`submit`、`withdraw`、`reject`、`post`、`reverse`、`attachments` | 采购/销售/库存 11 种 `doc_type` 通用引擎；过账写不可变流水 + 往来台账，红冲净额归零 |
| 附件 | `/api/attachments/{id}` | GET 下载 | 单据附件 BYTEA 存库；上传走单据的 `attachments` 端点 |
| 货品图片 | `/api/products/{id}/images`、`/api/product-images/{image_id}` | 列表/上传/取图/改排序/删除 | 字节存 MinIO，单图 ≤20MB |
| 主数据 | `/api` | `categories`、`customers`、`suppliers`、`departments`、`products/{id}/price-tiers` | 各带导出/增改 |
| 申请审批 | `/api/stock-requests` | 列表、`export`、详情、POST、PUT、`submit`/`withdraw`/`approve`/`reject`/`release` | OA 流 |
| 冲突中心 | `/api/conflicts` | 列表、`export`、详情、`link-product`/`create-product`/`edit-product`/`resolve` | 导入冲突的人工裁决 |
| SN 台账 | `/api/serial-ledger` | 列表、`export`、详情、POST `parse`、POST `import-file` | SN/UUID 流向（复用 asset 域） |
| 报表 | `/api/reports` | `purchase-reconciliation`、`ar-ap-summary`、`receivables`、`payables`、`inventory-cost` | FINANCE/ADMIN；原 GET 路径支持分页和导出 |
| 用户管理 | `/api/admin/users` | 列表、`export`、详情、增改、重置密码 | ADMIN |
| 审计 | `/api/audit` | 列表、`export`、详情 | ADMIN/FINANCE |

## 列表、报表与导出

- **OA 序列号登记**：创建和编辑申请的明细接受可选 `serial_numbers: list[str] | null`，详情返回该字段及货品的 `serialized` 标志。不传或空清单维持原有可选语义；填写后，放行时校验数量、重复、货品追踪开关以及 SN 的在库状态、来源库位、成色和单位。SN 减少或调拨的单位必须与当前流水一致，单位未知时也拒绝，不进行换算。失败不改变申请状态或库存。OA 仍为库存申请，不自动产生应收应付。
- **清点序列号**：登记数量对应清点差额的绝对值；差额为零时填写非空 SN 返回 422，避免忽略未关联的登记。OA 出库仅扣减来源库存，库内移货使用调拨申请。
- **采购对账口径**：仅统计有效的已过账采购入库、采购退货，`total_amount` 在入库时为正、退货时为负。已红冲原单及反向单均排除，追溯使用单据详情与历史；列表、筛选、合计和导出保持同一口径，现有响应结构不变。
- **现有分页列表**：货品、单据、SN 台账接受 `page`（默认 1）、`page_size`（默认 30，上限 500）、`sort`/`order`，返回 `{items, page, page_size, total}`。其他原有数组列表保持兼容，不自动改为分页。
- **搜索与筛选**：`q` 为搜索词；单据列表及导出搜索单号或往来方名称，并支持 `mine=true` 仅保留本人创建的记录。支持筛选的端点使用可重复的 `f=列:操作:值`；操作符包括 `contains`、`eq`、`ne`、`gt`、`gte`、`lt`、`lte`、`in`（逗号分隔），以各端点白名单为准。排序列也使用白名单，筛选值全部绑定参数。
- **报表与审计分页**：五个报表 GET 和 `/api/audit` 增加 `paginated=true`，接受 `page`、`page_size`、`q`、`f`、`sort`、`order`，返回 `{items, total, page, page_size, summary}`。`summary` 覆盖完整筛选结果，审计为 `{}`；审计的 `q` 匹配操作人、角色、动作、目标表或请求编号，列表与详情均返回 `actor_name`。
- **兼容响应**：未启用分页时，采购对账仍返回 `{rows}`，应收应付汇总仍返回 `{customers, suppliers}`，应收明细、应付明细、库存成本与审计仍返回数组。审计旧 `limit` 默认 100、最多 500；分页模式忽略 `limit`。应收应付汇总旧模式仍返回双方完整汇总，分页或导出时使用 `party_type=customer|supplier`（默认 `customer`）选择一方。
- **导出**：报表直接在原 GET 路径传 `fmt=csv|xlsx`；审计沿用 `/api/audit/export`，单据沿用 `/api/documents/export`。这些端点复用列表筛选及排序，不受当前页限制；可用 `ids` 限定选中记录，库存成本使用 `product_id:uom_id` 复合键。原有客户端数组列表导出通过 `ids` 传递筛选后的记录。CSV 带 UTF-8 BOM，也支持 XLSX，单次上限 5 万行。

| 报表 | 完整筛选合计 | 补充查询参数 |
|---|---|---|
| `purchase-reconciliation` | `total_amount` | `supplier_id`、`start_date`、`end_date` |
| `ar-ap-summary` | `receivable_balance` 或 `payable_balance` | `party_type` |
| `receivables` / `payables` | `amount`、`amount_up`、`amount_down`、`balance`（增加减减少） | `party_id`、`start_date`、`end_date` |
| `inventory-cost` | `cost_value` | — |

采购对账、应收应付明细与客户/供应商详情的历史交易补充 `document_id`，用于按权限下钻；往来方历史仍只返回最近 50 条。申请详情补充表头的 `source_location_name`、`destination_location_name`。

## 新增只读接口

本次仅新增以下三个 GET；均需登录，不改变原有业务状态机或角色权限。

| 接口 | 响应与权限 |
|---|---|
| `/api/workbench/summary` | 返回工作台统计对象；单据待办按当前角色的 `post_roles` 裁剪，申请审批和放行限 WAREHOUSE/ADMIN |
| `/api/search?q=...&limit=5` | 返回 `{q, groups: [{kind, label, items}]}`；每项包含 `id`、`title`、`subtitle`、`href`，适用时包含 `status` |
| `/api/documents/{document_id}/history` | 沿用对应单据类型的 `view_roles`；返回按时间、事件编号正序排列的事件数组 |

**工作台口径**：`pending_documents` 按单据类型返回 `{doc_type, group, label, count}`；`my_draft_documents` 与 `my_draft_documents_by_group: [{group, count}]` 统计本人可查看的草稿。`pending_requests` 对仓管/管理员统计全部待审批申请，其他角色统计本人审批中的申请，后者不应计入可处理待办角标；`approved_requests` 仅对仓管/管理员统计待放行申请；`my_draft_requests` 为本人草稿。`pending_conflicts` 仅 ADMIN 返回，`over_credit_customers` 仅 FINANCE/ADMIN 返回（信用上限大于 0 且应收超过上限）。`zero_stock_products` 对所有角色返回，按任一库存余额行 ≤0 的货品去重，不跨单位抵消。

**搜索口径**：`q` 使用 NFKC、去空白及大小写归一化，空查询返回空分组；每组默认 5 条、最多 10 条。货品复用现有精确/模糊搜索；单据按类型查看权限裁剪；申请仅本人及 WAREHOUSE/ADMIN 可见；客户限 SALES/FINANCE/ADMIN，供应商限 WAREHOUSE/FINANCE/ADMIN，序列号搜索限 WAREHOUSE/ADMIN。未授权组不返回，单据及申请编号前缀命中优先。

**历史口径**：事件包含 `audit_event_id`、`action`、中文 `label`、`actor_name`、`created_at` 与 `field_diff`。除直接关联事件，还按唯一单号补关联旧创建事件，并关联附件上传事件。旧编辑审计未保存业务变化时，`field_diff` 保持空对象，不将版本号变化展示为业务变更。

## 写入约定

- **写操作全量审计**：CREATE/EDIT/DELETE 写入 `audit_event`，按现有操作保存 before/after 与字段 diff（见[数据模型](data-model.md#审计机制)）。历史字段不足时只展示已记录事实。
