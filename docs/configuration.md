# 配置参考

配置通过环境变量注入。复制根目录的 `.env.example` 为 `.env`，并替换其中所有 `change-me` 占位值。部署前请使用长随机密码和令牌，并限制 `.env` 的读取权限。

## Docker Compose

### 必填凭据

| 变量 | 用途 |
|---|---|
| `POSTGRES_PASSWORD` | PostgreSQL 密码 |
| `SESSION_SECRET` | 保留的会话配置项（当前应用代码未读取，Compose 以 `:?` 强制非空防误配）；设置为长随机值 |
| `BOOTSTRAP_ADMIN_PASSWORD` | 首次启动创建的管理员密码 |
| `BOOTSTRAP_REQUESTER_PASSWORD` | 首次启动创建的普通用户密码 |
| `OCR_INTERNAL_TOKEN` | API 调用 OCR 服务时的内部令牌 |
| `MINIO_ACCESS_KEY` | MinIO 用户名，3–20 个字符 |
| `MINIO_SECRET_KEY` | MinIO 密码，8–40 个字符 |

### 常用选项

| 变量 | 默认值 | 说明 |
|---|---|---|
| `POSTGRES_DB` / `POSTGRES_USER` | `inventory` | 数据库与数据库用户 |
| `POSTGRES_PORT` | `127.0.0.1:5432` | PostgreSQL 宿主机映射端口（缺省仅绑回环） |
| `API_PORT` | `127.0.0.1:8000` | API 宿主机映射端口（缺省仅绑回环；**必须保持回环**——API 以 `--forwarded-allow-ips=*` 信任代理头，直接暴露会允许伪造审计 IP） |
| `WEB_PORT` | `127.0.0.1:18080` | Web 容器宿主机映射；推荐由前置 HTTPS 网关访问 |
| `WEB_DOCKERFILE` | `Dockerfile` | Web 镜像构建方式；可选 `Dockerfile.remote` |
| `ERP_COOKIE_PATH` | `/` | Cookie 路径；通过 `/erp/` 子路径访问时设为 `/erp` |
| `ERP_SECURE_COOKIES` | `0` | 会话/CSRF Cookie 的 `Secure` 标志；部署到 TLS 网关后置 `1`（Compose 已透传） |
| `ERP_DB_POOL_MIN` | `1` | 每个 API worker 建池时创建并在归还后保留的连接数；`0` 表示不保留闲置连接，归还即关闭 |
| `ERP_DB_POOL_MAX` | `30` | 每个 API worker 同时使用的连接上限；默认两个 worker 合计最多 60 条连接 |
| `ERP_FORBID_NEGATIVE_STOCK` | `0` | 置 `1` 后业务单据、OA 放行、清点减少及红冲的来源侧移动均逐行校验库存余额，不足整单回滚并返回 422；默认维持允许负库存的设计 |
| `ERP_DISABLE_DOCS` | Compose 为 `1` | 关闭 `/docs`、`/redoc`、`/openapi.json`；本地裸跑默认开启便于调试 |
| `ERP_BOOTSTRAP_STRICT` | Compose 固定为 `1`，裸跑默认为 `0` | 置 `1` 时初始账号创建失败会中止 API 启动；Compose 中需修改服务配置才能改变该值 |
| `CORS_ORIGINS` | `http://localhost` | 允许的来源，多个值用逗号分隔 |
| `MINIO_BUCKET` | `erp-product-images` | 商品图片存储桶 |
| `MINIO_CONSOLE_PORT` | `127.0.0.1:19001` | MinIO 控制台映射端口 |
| `OCR_PROXY_TIMEOUT_SECONDS` | `25` | API 到 OCR 服务的超时 |

`ERP_COOKIE_PATH`、`ERP_SECURE_COOKIES`、`CORS_ORIGINS` 和 `WEB_PORT` 应与实际公开 URL、HTTPS 网关配置匹配。容器内部服务地址由 Compose 网络提供。

连接池配置必须为整数，满足 `0 ≤ ERP_DB_POOL_MIN ≤ ERP_DB_POOL_MAX` 且最大值至少为 `1`；非法配置会在 API 启动时以中文报错，`ERP_BOOTSTRAP_STRICT=0` 也不会忽略配置错误。默认保留一条闲置连接用于复用；显式设为 `0` 会放弃复用。配置修改后需重启 API，连接预算应给其他客户端预留空间。

## API 固定运行参数

以下参数由 `api/Dockerfile` 和 `api/db.py` 定义，当前没有对应的 `.env` 配置项：

| 参数 | 当前值 | 说明 |
|---|---|---|
| uvicorn worker 数 | 容器为 `2` | 裸跑示例未指定 `--workers`，使用单进程 |
| 建连超时 | `5` 秒 | 限制单次连接建立的等待 |
| 查询超时 | `30` 秒 | PostgreSQL `statement_timeout=30000`，防止慢语句长期占用连接 |

借出连接前探活，扩容建连或探活中断最多尝试三次；池构造时首次建连失败、池耗尽或探活最终失败，运行期均返回 `503` 与 `Retry-After: 5`。严格 bootstrap 模式下启动阶段建连失败会中止 API 启动。

## 前端构建

| 变量 | 默认值 | 说明 |
|---|---|---|
| `VITE_BASE_PATH` | 开发为 `/`，部署示例为 `/erp/` | Vite 构建的公开基路径 |

基路径适配集中在 `web/src/app-path.js`。部署到域名根路径时，可在构建时将 `VITE_BASE_PATH` 设为 `/`，并同步配置 Cookie 路径和网关规则。

## 部署脚本

裸跑 API 或使用 `scripts/seed_inventory.py --apply` 时，必须通过 `DATABASE_URL` 显式指定数据库连接串。Docker Compose 会根据 PostgreSQL 变量为 API 容器构造该值。

`deploy/deploy_remote.sh` 不包含默认服务器或目录。必须通过参数或环境变量提供目标：

| 变量 | 命令行参数 | 说明 |
|---|---|---|
| `DEPLOY_HOST` | `--host` | SSH 主机名或地址 |
| `DEPLOY_USER` | `--user` | SSH 用户名 |
| `DEPLOY_DIR` | `--remote-dir` | 远端绝对部署目录 |

脚本可使用 `--env-file` 上传配置文件。导入工作簿时，使用 `--seed-workbook` 和 `--mapping`，并通过 `IMPORT_WORKBOOK_PASSWORD` 提供工作簿密码；未设置时脚本会在终端提示输入。

完整部署流程见[部署指南](deployment.md)。
