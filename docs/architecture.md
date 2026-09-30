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

无 ORM：`api/db.py` 用 `ThreadedConnectionPool` 直接执行参数化 SQL，默认最小 `1`、最大 `30`，分别由 `ERP_DB_POOL_MIN` / `ERP_DB_POOL_MAX` 配置。默认归还后保留一条闲置连接用于复用；最小值 `0` 明确表示归还即关闭。连接在借出时探活（`SELECT 1`），失效连接会被替换；构造建连失败或池耗尽等运行期故障返回 503。容器内 uvicorn 保持 `--workers 2`，默认连接预算为 2 × 30 = 60。启动先校验连接池配置，再由 `ensure_bootstrap_users()` 保证初始账号存在（事务级咨询锁串行化多 worker 并发建号）、`ensure_bucket()` 保证 MinIO 桶存在；非法池配置始终中止启动，Compose 中 `ERP_BOOTSTRAP_STRICT=1` 时 bootstrap 失败也中止。远端发布先构建、暂停 API/Web、等待数据库并迁移，成功后才启动新版应用。

| 模块 | 职责 |
|---|---|
| `main.py` | 应用装配、CORS、Cookie 路径、`/healthz`、认证（`/api/auth/*`）、货品、库存余额/清点、单位/库位、用户管理、申请审批（`/api/stock-requests/*`）、冲突中心（`/api/conflicts/*`）、审计查询、OCR 薄代理挂载 |
| `documents.py` | 通用业务单据引擎：采购/销售/库存三大组共 11 种 `doc_type` 的列表/创建/修改/提交/**过账**/**红冲**/附件；过账写不可变 `inventory_movement` 与 `ar_ap_entry` |
| `inventory_posting.py` | 业务单据、OA 放行、快速清点和红冲共用的库存守卫、审计与数量/SN 流水写入 |
| `master.py` | 主数据：商品分类、客户、供应商、价格档、部门 |
| `reports.py` | 报表：采购对账、应收应付汇总/明细、库存成本 |
| `workspace.py` | 工作台只读汇总与全局分组搜索，沿用各业务域的角色权限与申请所有权 |
| `read_lists.py` | 报表和审计的共享查询：筛选、排序、分页、完整结果合计及 CSV/XLSX 导出 |
| `serial_tracking.py` | SN/UUID 台账：列表/导出/详情/解析/文件导入（`/api/serial-ledger/*`），复用 001 迁移中休眠的 `asset` 资产域 |
| `images.py` / `image_utils.py` | 货品图片：字节存 MinIO、元数据存 `product_image` 表 |
| `storage.py` | MinIO 客户端封装 |
| `ocr_client.py` | 向 OCR 服务转发 `/v1/extract` 的薄代理（内部令牌鉴权、超时/重试语义） |
| `permissions.py` | 5 种角色、`DOC_TYPE_META` 单据权限矩阵、会话/CSRF 校验依赖 |
| `security.py` | 密码哈希（argon2）、随机令牌与令牌哈希 |
| `db.py` | 连接池、审计上下文（`set_config('app.actor_id', ...)`）、`audit()` 写 `audit_event` |
| `schemas.py` / `export.py` / `list_params.py` / `search.py` / `helpers.py` | 请求模型、CSV/XLSX 导出、分页/排序/过滤参数、模糊搜索、公共助手 |

货品普通分页先查询本页货品，再仅对返回的货品批量补库存汇总，避免为被 OFFSET 跳过的行重复聚合；导出复用该取数方式。模糊候选池仍使用 LATERAL 汇总。搜索通过 010 迁移的 STORED 生成列与 trgm 索引匹配，保留原有文本规范化及模糊回退语义。连接借出探活或扩容建连中断时最多尝试三次，连接仍不可用或池耗尽时返回 503 和 `Retry-After: 5`；业务事务本身不会自动重试。

### 单据生命周期与过账模型

```
草稿(draft) → 提交(submitted) → 过账(posted) ──过账时──▶ inventory_movement（不可变库存流水）
                                 │                        ar_ap_entry（应收应付台账，按 doc_type 效果）
                                 └─ 红冲(reverse) → 生成反向单据，两单净额归零，原始记录不修改
```

- 过账是唯一产生库存/往来影响的动作；余额视图只计算已过账流水。
- 已过账单据不可编辑或删除，纠错走红冲。
- 申请单（stock_request）是独立 OA 流：submit → withdraw/approve/reject → release。

所有库存入口在同一事务内先按货品 ID 升序加锁，再逐条读取余额、检查并写入，后续明细可看到本单前面的库存变化。默认允许负库存；开启 `ERP_FORBID_NEGATIVE_STOCK=1` 后，业务单据、OA、清点减少和红冲的来源侧均检查余额。任一明细失败时，库存、SN 事件、往来台账及单据状态整单回滚。

SN 仍可选；一旦填写，校验追踪开关、归一化重复、整数数量及登记数量，减少或调拨还核对当前库位、成色和流水单位，不做跨单位换算。OA 明细通过 011 迁移保存可空的 SN 数组。红冲按原库存流水倒序处理，原 SN 事件必须是最新有效事件；后续事件逆序撤销后才能继续红冲，反向事件恢复原事件前的状态。历史已过账数据不自动回写。

### 审计

写操作通过 `audit()` 在事务内设置 `set_config('app.actor_id', ...)` 审计上下文；`connection()` 本身不声明操作者。代码层审计与数据库层 `require_audit_context` 触发器（002 迁移挂载）共同约束写入，没有审计上下文的业务写事务会直接失败。`audit_event` 记录 before/after 与字段级 diff。

## 鉴权与权限

- **会话**：登录后签发 HttpOnly Cookie `erp_session`（随机令牌，库里只存哈希）与可读 Cookie `erp_csrf`；写请求必须带 `X-CSRF-Token` 头且与会话内哈希匹配。Cookie 的 `path` 由 `ERP_COOKIE_PATH` 控制（`/erp/` 挂载时必须设为 `/erp`），`secure` 由 `ERP_SECURE_COOKIES` 控制，有效期 12 小时。
- **RBAC**：`ADMIN / WAREHOUSE / SALES / FINANCE / COLLEAGUE`（管理员/仓管/销售/财务/同事）。11 种单据类型在 `permissions.py` 的 `DOC_TYPE_META` 中分别声明可见/开单/过账角色，以及库存效果（IN/OUT/TRANSFER/COUNT）与往来效果（应收/应付增减）。
- **前端页面级控制**：`web/src/roles.js` 的 `PAGE_ACCESS` 决定导航可见性，仅是 UX；后端对每个端点独立强制。

## 前端（`web/`，React 19 + Vite 8）

- **无路由库、无状态库**：`ui.jsx` 提供 `RouterContext`/`Link`，`main.jsx` 的 `routeView()` 按路径前缀手写映射到页面组件。筛选用 `replaceState`、页面导航用 `pushState`，详情保留来源列表的筛选；组件状态使用 hooks。
- `workspace.jsx`：八模块导航、按角色可处理待办、异常深链、快捷新建与全局搜索；财务的销售入口仅开放客户档案。
- `api.js`：fetch 封装（自动附 CSRF 头、15 秒超时）、XHR 上传进度、60 秒库存与工作台缓存。换账号清空缓存，成功业务写操作刷新工作台；请求记录会话代际，旧会话迟到的 401 不退出当前账号。
- `data-table.jsx` / `table-state.js`：客户端与服务端列表、URL 筛选/排序/分页/列显隐、按用户与角色隔离的本机保存视图、固定表头和导出。报表分页合计覆盖当前筛选的全部结果。
- `ui.jsx` / `status.js`：统一状态文案和色彩、确认条、菜单、Tabs、Drawer、Toast、骨架、详情加载与字段差异；表单保留脏保护和防重复提交。
- 页面模块：`main.jsx`（库存余额/货品/扫码拣货/申请/清点/冲突/审计/管理）、`documents.jsx`（业务单据与操作历史）、`master-data.jsx`（客户/供应商共用完整编辑和抽屉表单）、`reports.jsx`、`serial.jsx`（SN 台账）、`scan-ui.jsx`（OCR 扫码）、`product-gallery.jsx`。
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
