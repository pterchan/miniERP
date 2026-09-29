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
| OCR | `/api/ocr` | POST `extract` | 转发到独立 OCR 服务的薄代理（内部令牌鉴权） |
| 货品 | `/api/products` | 列表 `q`/模糊搜索、`stock`、`export`、详情、POST、PUT | 搜索命中不佳时回退模糊匹配（`api/search.py`） |
| 库存 | `/api/inventory` | GET `balance`、`balance/export`、`balance/{product}/{location}/{condition}/{uom}`、POST `adjust` | 清点=按实盘数覆写，写调整流水 |
| 单位/库位 | `/api/uoms`、`/api/locations` | 列表/导出/详情/增改 | |
| 业务单据 | `/api/documents` | 列表、`export`、详情、POST、PUT、`submit`、`withdraw`、`reject`、`post`、`reverse`、`attachments` | 采购/销售/库存 11 种 `doc_type` 通用引擎；过账写不可变流水 + 往来台账，红冲净额归零 |
| 附件 | `/api/attachments/{id}` | GET 下载 | 单据附件 BYTEA 存库；上传走单据的 `attachments` 端点 |
| 货品图片 | `/api/products/{id}/images`、`/api/product-images/{image_id}` | 列表/上传/取图/改排序/删除 | 字节存 MinIO，单图 ≤20MB |
| 主数据 | `/api` | `categories`、`customers`、`suppliers`、`departments`、`products/{id}/price-tiers` | 各带导出/增改 |
| 申请审批 | `/api/stock-requests` | 列表、`export`、详情、POST、PUT、`submit`/`withdraw`/`approve`/`reject`/`release` | OA 流 |
| 冲突中心 | `/api/conflicts` | 列表、`export`、详情、`link-product`/`create-product`/`edit-product`/`resolve` | 导入冲突的人工裁决 |
| SN 台账 | `/api/serial-ledger` | 列表、`export`、详情、POST `parse`、POST `import-file` | SN/UUID 流向（复用 asset 域） |
| 报表 | `/api/reports` | `purchase-reconciliation`、`ar-ap-summary`、`receivables`、`payables`、`inventory-cost` | |
| 用户管理 | `/api/admin/users` | 列表、`export`、详情、增改、重置密码 | ADMIN |
| 审计 | `/api/audit` | 列表、`export`、详情 | ADMIN/FINANCE |

## 通用约定

- **列表分页**：`page`（默认 1）、`page_size`（默认 30，上限 500）、`sort`/`order`（列名白名单）；响应统一为 `{items, page, page_size, total}`。
- **筛选**：`f` 参数，格式 `列:操作:值`，可重复；操作符 `contains`（ILIKE 模糊）/`eq`/`ne`/`gt`/`gte`/`lt`/`lte`/`in`（逗号分隔）。列名与操作符全部走白名单，值一律绑定参数，杜绝注入（`api/list_params.py`）。
- **导出与视图一致**：每个 `/export` 端点复用列表接口的同一套筛选/排序构造器，"当前视图 = 导出结果"；CSV 带 utf-8-sig BOM（Excel 中文不乱码），也支持 XLSX（openpyxl），单次导出上限 5 万行（`api/export.py`）。
- **写操作全量审计**：CREATE/EDIT/DELETE 连同 before/after 与字段 diff 写入 `audit_event`（见[数据模型](data-model.md#审计机制)）。
