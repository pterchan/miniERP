# 开发指南

## 开发环境

两种方式，按需选择：

**A. 全栈容器**（最省事，改后端/前端代码需 rebuild）：

```sh
cp .env.example .env   # 填必填项（随机密码/令牌）
scripts/dev_up.sh --build   # 校验占位密码后启动
# 入口 http://127.0.0.1:18080/erp/
```

**B. 依赖进容器、前后端裸跑**（热重载，日常开发推荐）：

```sh
docker compose up -d postgres minio ocr      # 只起依赖
pip install -r api/requirements.txt
DATABASE_URL='postgresql://inventory:<密码>@localhost:5432/inventory' \
  uvicorn api.main:app --reload --port 8000
cd web && npm ci && npm run dev              # :5173，/api 代理到 localhost:8000
```

注意：裸跑 API 时 compose 里的 `DATABASE_URL`/`ERP_CORS_ORIGINS` 等映射不会生效，需要按[配置参考](configuration.md)自行设置容器层变量名（`ERP_*`）。

## 测试

| 套件 | 命令 | 说明 |
|---|---|---|
| 后端 | `python3 -m unittest discover -s tests -v` | 静态契约 + 纯函数测试；不依赖外部数据库 |
| 后端（行为测试） | 见下方「行为测试与一次性测试库」 | TestClient + 真实 PostgreSQL，复现后端缺陷 |
| 前端 | `cd web && npm test` | Vitest + Testing Library，测试与源码同目录 |
| OCR 服务 | `python3 -m unittest discover -s ocr_service/tests -t .` | 契约/字段/几何/图像 IO/模型金标 |

导入器测试使用运行时生成的合成 XLSX 与 JSON 映射，不需要真实业务数据；运行该模块需要 `cryptography` 与 `openpyxl`（已在 `api/requirements.txt`）。

### 行为测试与一次性测试库

后端行为测试（登录/CSRF/过账/红冲/SN 状态机等）需要真实 PostgreSQL，走独立的
一次性测试库，与主栈数据完全隔离：

```sh
docker compose -f docker-compose.test.yml up -d --wait   # 起 127.0.0.1:15433 的一次性库
python3 -m unittest discover -s tests -v                 # 行为测试自动启用
docker compose -f docker-compose.test.yml down -v        # 测试完销毁
```

- 连接串由 `TEST_DATABASE_URL` 控制，默认 `postgresql://erp_test:erp_test@127.0.0.1:15433/erp_test`。
- 测试库不可达时行为测试整类跳过（`tests/support/testdb.py`），静态/纯函数测试不受影响。
- 每个测试类重建一次库：DROP SCHEMA 后按序重放 `db/migrations/*.sql`——
  这本身就是迁移幂等性的持续回归验证（`tests/test_migrations_idempotent.py`）。
- 公共基建：`tests/support/testdb.py`（建库/建用户/连接池切换）、`tests/support/api_client.py`
  （TestClient 封装：登录、CSRF 双提交头、多角色身份）。

## 静态契约测试（本项目特有的防线）

`tests/test_*_static.py` 大多**不运行业务逻辑，而是把源码当文本读进来断言关键不变量**。它们是部署拓扑与跨层契约的"可执行规范"——因为这套系统跨 5 个容器 + 宿主机网关 + 前后端，很多约定无法靠单一模块的类型检查守住。

| 测试 | 读哪些文件 | 守什么 |
|---|---|---|
| `test_gateway_static.py` | compose、两个 web Dockerfile、`web/nginx.conf`、`serve.py`、`app-path.js`、`api.js`、`ui.jsx`、`api/main.py`、`deploy/gateway/*`、`deploy_remote.sh` | `/erp` 前缀拓扑全套：容器 8080、回环 18080、Cookie path、构建基路径、网关转发 |
| `test_schema_static.py` | `001_inventory.sql` | 内部主键、来源编号非唯一、标识符唯一索引等模型底线 |
| `test_backend_static.py` | 002/003 DDL、`main.py`、`seed_inventory.py` | 审计/角色/申请单的后端契约 |
| `test_erp_static.py` | 003 DDL、permissions/documents/master/reports/schemas | 单据权限矩阵与路由的一致性 |
| `test_export_static.py` | export/list_params、各列表模块、`data-table.jsx` | 列表视图 = 导出视图，白名单防注入 |
| `test_images_static.py` | images/storage/004 迁移等 | 图片走 MinIO、元数据入库、大小限制 |
| `test_ocr_static.py` | `ocr_service/contracts.py`、pipeline、`api/main.py`、compose | OCR 传输契约与代理封装 |
| `test_serial_static.py` | 006 迁移、serial_tracking、documents、前端 serial 页 | SN 台账跨层契约 |

行为型测试（真正跑逻辑）只有成本低、无需数据库的几类：`test_search.py`（模糊搜索）、`test_list_params.py`、`test_inventory_import.py`（xlsx 解析）、`test_ocr_proxy.py`（假 httpx 客户端）。

**规则：改了被断言的文件，必须同步更新对应静态测试**——反过来，这些测试失败时先怀疑是跨层约定被破坏，而不是测试过时。

## 常见改动清单

**新增后端端点**：`api/main.py`（或对应 router 文件）→ 用 `require_roles(...)` 声明权限、写操作调 `audit()` → `schemas.py` 加请求模型 → 涉及前端则同步 `web/src/api.js` 与页面 → 涉及列表/导出则遵守 `list_params.py` 白名单模式并补 `test_export_static.py` 断言。

**新增前端页面**：`web/src/` 新建组件 → `main.jsx` 的 `routeView()` 加路径映射 → `roles.js` 的 `PAGE_ACCESS` 声明可见角色（记得这只是 UX，后端权限才是强制层）→ 补 vitest。

**新增迁移**：见[数据模型·迁移约定](data-model.md#迁移约定新增迁移时)（幂等、补跑路径、同步 `test_schema_static.py`/相关静态测试）。

**新增单据类型**：`api/permissions.py` 的 `DOC_TYPE_META`（前缀/角色/库存与往来效果）→ 003 迁移的字典/约束 → `test_erp_static.py` → 前端 `documents.jsx`。

**改部署拓扑**（端口、前缀、代理链）：compose / `web/nginx.conf` / `serve.py` / `deploy_remote.sh` / `deploy/gateway/*` 一组文件要一起改，并同步 `test_gateway_static.py`；同时检查 [配置参考](configuration.md) 与 [部署指南](deployment.md) 是否仍然准确。

## 代码风格

- 后端中文注释与中文错误信息（`{"detail": "中文说明"}`）；模块/函数 docstring 说明设计意图。
- SQL 一律绑定参数；列名/操作符走白名单。
- 前端无路由/状态库，遵循现有 hooks 风格；用户可见文案为中文。
