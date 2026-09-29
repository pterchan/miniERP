# 系统架构

miniERP 是一个面向小团队的进销存与 OA 审批系统：FastAPI + PostgreSQL 后端、React SPA 前端、独立的离线 OCR 识别服务，全部以 Docker Compose 编排。

## 总体拓扑（生产）

宿主机 Nginx 网关是唯一公网入口，应用端口全部只绑回环地址：

```
浏览器
  │  http://<host>/            落地页（业务系统选择卡片）
  │  http://<host>/erp/        ERP 应用
  ▼
宿主机 Nginx 网关 :80 ──────────────── deploy/gateway/nginx.conf
  │  /      → 由部署者配置的静态落地页
  │  /erp/  → 去掉前缀转发到 127.0.0.1:18080（X-Forwarded-Prefix: /erp）
  ▼
Web 容器 :8080（宿主机映射 127.0.0.1:18080）── web/nginx.conf 或 web/serve.py
  │  静态 SPA（Vite 构建，base=/erp/）
  │  /api/ → 反向代理
  ▼
API 容器 :8000 ────────────────────── api/main.py（FastAPI + uvicorn）
  ├─ PostgreSQL :5432（容器间互通；宿主机可选映射）
  ├─ MinIO :9000（仅容器网络内 expose；控制台映射 127.0.0.1:19001）
  └─ OCR 服务 :8010（仅容器网络内 expose）
```

开发模式没有网关：`web/` 下 `npm run dev` 起 Vite 开发服务器（:5173，`/api` 代理到 `localhost:8000`），基路径为 `/`；生产构建的基路径为 `/erp/`（`web/vite.config.js` 读取 `VITE_BASE_PATH`）。前端对基路径的全部适配集中在 [web/src/app-path.js](../web/src/app-path.js)。

### 端口分配

| 端口 | 归属 | 宿主机映射 | 说明 |
|---|---|---|---|
| 80 | 宿主机 Nginx 网关 | 直接监听 | 唯一入口：落地页 + `/erp/` 前缀转发 |
| 8080 | Web 容器内部 | `127.0.0.1:18080` | nginx（Dockerfile）或 serve.py（Dockerfile.remote）监听 |
| 8000 | API 容器 | 本地默认 `8000`，远端 `127.0.0.1:18001` | FastAPI/uvicorn |
| 5432 | PostgreSQL 容器 | 本地默认 `5432`，远端 `127.0.0.1:15432` | |
| 9000 | MinIO | 不映射（仅 expose） | 货品图片字节存储 |
| 9001 | MinIO 控制台 | `127.0.0.1:19001` | 仅内网诊断 |
| 8010 | OCR 容器 | 不映射（仅 expose） | RapidOCR 离线服务 |

本地 `docker compose up` 时可按 `.env` 配置宿主机映射。公开部署建议将应用端口绑定到回环地址，再由 HTTPS 网关转发。详见[部署](deployment.md)与[配置参考](configuration.md)。

## 后端（`api/`，FastAPI + 原生 psycopg2）

无 ORM：`api/db.py` 用 `ThreadedConnectionPool(0, 30)` 直接执行参数化 SQL。启动时 `ensure_bootstrap_users()` 保证初始账号存在、`ensure_bucket()` 保证 MinIO 桶存在；两者失败都不阻断 API 启动（compose 中 `ERP_BOOTSTRAP_STRICT=1` 时 bootstrap 失败才中止）。

| 模块 | 职责 |
|---|---|
| `main.py` | 应用装配、CORS、Cookie 路径、`/healthz`、认证（`/api/auth/*`）、货品、库存余额/清点、单位/库位、用户管理、申请审批（`/api/stock-requests/*`）、冲突中心（`/api/conflicts/*`）、审计查询、OCR 薄代理挂载 |
| `documents.py` | 通用业务单据引擎：采购/销售/库存三大组共 11 种 `doc_type` 的列表/创建/修改/提交/**过账**/**红冲**/附件；过账写不可变 `inventory_movement` 与 `ar_ap_entry` |
| `master.py` | 主数据：商品分类、客户、供应商、价格档、部门 |
| `reports.py` | 报表：采购对账、应收应付汇总/明细、库存成本 |
| `serial_tracking.py` | SN/UUID 台账：列表/导出/详情/解析/文件导入（`/api/serial-ledger/*`），复用 001 迁移中休眠的 `asset` 资产域 |
| `images.py` / `image_utils.py` | 货品图片：字节存 MinIO、元数据存 `product_image` 表 |
| `storage.py` | MinIO 客户端封装 |
| `ocr_client.py` | 向 OCR 服务转发 `/v1/extract` 的薄代理（内部令牌鉴权、超时/重试语义） |
| `permissions.py` | 5 种角色、`DOC_TYPE_META` 单据权限矩阵、会话/CSRF 校验依赖 |
| `security.py` | 密码哈希（argon2）、随机令牌与令牌哈希 |
| `db.py` | 连接池、审计上下文（`set_config('app.actor_id', ...)`）、`audit()` 写 `audit_event` |
| `schemas.py` / `export.py` / `list_params.py` / `search.py` / `helpers.py` | 请求模型、CSV 导出、分页/排序/过滤参数、模糊搜索、公共助手 |

### 单据生命周期与过账模型

```
草稿(draft) → 提交(submitted) → 过账(posted) ──过账时──▶ inventory_movement（不可变库存流水）
                                 │                        ar_ap_entry（应收应付台账，按 doc_type 效果）
                                 └─ 红冲(reverse) → 生成反向单据，两单净额归零，原始记录不修改
```

- 过账是唯一产生库存/往来影响的动作；余额视图只计算已过账流水。
- 已过账单据不可编辑或删除，纠错走红冲。
- 申请单（stock_request）是独立 OA 流：submit → withdraw/approve/reject → release。

### 审计

每次连接在事务内通过 `set_config('app.actor_id', ...)` 声明操作者；代码层 `audit()` 与数据库层 `require_audit_context` 触发器（002 迁移挂载）双保险——没有审计上下文的写事务会直接失败。`audit_event` 记录 before/after 与字段级 diff。

## 鉴权与权限

- **会话**：登录后签发 HttpOnly Cookie `erp_session`（随机令牌，库里只存哈希）与可读 Cookie `erp_csrf`；写请求必须带 `X-CSRF-Token` 头且与会话内哈希匹配。Cookie 的 `path` 由 `ERP_COOKIE_PATH` 控制（`/erp/` 挂载时必须设为 `/erp`），`secure` 由 `ERP_SECURE_COOKIES` 控制，有效期 12 小时。
- **RBAC**：`ADMIN / WAREHOUSE / SALES / FINANCE / COLLEAGUE`（管理员/仓管/销售/财务/同事）。11 种单据类型在 `permissions.py` 的 `DOC_TYPE_META` 中分别声明可见/开单/过账角色，以及库存效果（IN/OUT/TRANSFER/COUNT）与往来效果（应收/应付增减）。
- **前端页面级控制**：`web/src/roles.js` 的 `PAGE_ACCESS` 决定导航可见性，仅是 UX；后端对每个端点独立强制。

## 前端（`web/`，React 19 + Vite 8）

- **无路由库、无状态库**：`ui.jsx` 提供 `RouterContext`/`Link`，`main.jsx` 的 `routeView()` 按路径前缀手写映射到页面组件；状态全部是组件内 hooks。
- `api.js`：fetch 封装（自动附 CSRF 头、15 秒超时）、XHR 带进度的附件/图片上传（面向 2Mbps 弱网上行）、会话级库存余额缓存（过账类操作后失效）。
- 页面模块：`main.jsx`（总览/货品/扫码拣货/申请/清点/冲突/审计/管理）、`documents.jsx`（业务单据）、`master-data.jsx`、`reports.jsx`、`serial.jsx`（SN 台账）、`scan-ui.jsx`（OCR 扫码）、`product-gallery.jsx`、`data-table.jsx`（通用表格 + 服务端导出）。
- **两种 Web 容器变体**（`WEB_DOCKERFILE` 选择）：
  - `Dockerfile`：多阶段 Node 构建 → nginx:1.27（`web/nginx.conf`，含 `/erp/` 前缀回退处理）；
  - `Dockerfile.remote`：直接拷贝预构建 `dist/` → 零依赖 Python 静态服务器 `web/serve.py`（自带同源 `/api` 反代与 `/erp` 前缀剥离），用于无法访问 Docker Hub / 不便跑 Node 构建的目标机。

## OCR 服务（`ocr_service/`）

独立 FastAPI 进程，与 ERP 仅通过内网 HTTP 交互：ERP 端唯一入口是 `/api/ocr/extract` 薄代理。RapidOCR 3.9.2（PP-OCRv6 / ONNX，CPU-only），模型随 wheel 打包并以 `MODEL_MANIFEST.txt` 校验和固定；运行期无网络、不访问数据库、不写磁盘。接口契约（`/healthz`、`/readyz`、`POST /v1/extract` + `X-Internal-Token`）见 [ocr_service/README.md](../ocr_service/README.md) 与 `ocr_service/contracts.py`。

## 关键设计决策

1. **来源编号不做主键**：导入表中的编号只保存为可冲突的标识观察（`product_identifier`），正式主键是数据库生成的 `product_id`；序列号同样保留 `TEXT`，避免前导零/混合格式丢失。
2. **不可变流水 + 红冲**：过账后不修改任何历史行，纠错生成反向记录净额归零，审计链完整。
3. **不做隐式单位换算**：数量始终带字典 `uom_id` 与来源单位 `source_uom_raw`；盒/套/米不会自动折算成"个"。
4. **不虚构期初**：迁移与导入只建立结构与候选数据，可信期初必须人工审核后切账（`--post-opening --cutover-date`）。
5. **冲突留人工**：无法安全解析的行进入 `resolution_case` 冲突中心，由管理员逐条裁决，绝不猜测。
6. **保守内网部署**：应用端口全部绑回环高位端口，宿主机网关 80 端口是唯一入口，为后续接入更多业务系统预留统一平台（见[部署](deployment.md)）。
