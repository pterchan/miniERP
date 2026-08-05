# ERP 数据模型

这是受密码保护的库存工作簿的首版迁移骨架。`编号`只作为可冲突的来源标识，正式主键是数据库生成的 `product_id`；序列号同样保留为 `TEXT`，在审核后关联设备资产。

## 文件

- `db/migrations/001_inventory.sql`：PostgreSQL DDL、暂存审计层、货品/库位、库存流水、序列资产及四个查询视图。
- `db/migrations/002_erp_oa.sql`：用户/会话、仓管审批、申请单、不可变审计和单位字典扩展；不做隐式单位换算。
- `api/`：FastAPI API；HttpOnly 会话 Cookie + CSRF、仓管/申请人角色、产品搜索、申请审批/放行、冲突和审计接口。
- `ocr_service/`：独立离线 RapidOCR 产品标签识别服务；不访问商品库、不写数据库，ERP 只通过 `/api/ocr/extract` 薄代理调用。
- `web/`：Vite/React 响应式桌面/手机界面。
- `scripts/import_inventory.py`：只读解密、列白名单抽取、规范化、日期/数量质量检查、调货语义候选和安全干运行器。
- `scripts/seed_inventory.py`：幂等导入到暂存、冲突、快照及可安全重放的历史流水；默认只 dry-run，`--apply` 才写库。
- `tests/`：不依赖外部数据库的解析/安全测试，以及 DDL 静态验收。

## 运行

先设置密码环境变量（不会写入文件、日志或报告），再运行干运行器：

```sh
IMPORT_WORKBOOK_PASSWORD='在此输入密码' \
python3 scripts/import_inventory.py \
  --input /path/to/workbook.xlsx \
  --output /tmp/inventory-dry-run \
  --password-env IMPORT_WORKBOOK_PASSWORD
```

输出包括 `report.json` 和四个 JSONL 暂存文件。脚本不会把任何行直接标记为已过账；缺失/非法日期、超范围日期、缺失或非数值数量、零/负数量，以及未能安全判断的调货都保留为质量问题或 `REVIEW` 候选。未映射工作表只在摘要中报告名称和非空行数；stage_only 工作表只导出映射列并按规则脱敏。

解密副本只存在于操作系统临时目录，并在读取完成后删除。脚本只抽取映射字段，并对凭据、联系方式、财务字段和备注中的敏感内容脱敏。

## 建库

```sh
psql "$DATABASE_URL" -f db/migrations/001_inventory.sql
psql "$DATABASE_URL" -f db/migrations/002_erp_oa.sql
```

迁移只创建结构和参考数据，不会凭空生成可信期初余额。审核产品解析、库位、切账日期和期初量后，才可把候选流水转为 `status_id = posted`。余额视图只计算已过账流水；`inventory_snapshot` 仅用于与工作簿现有库存对账。

## 验证

```sh
python3 -m unittest discover -s tests -v
python3 -m py_compile scripts/import_inventory.py
```

## Docker POC

复制 `.env.example` 为 `.env`，设置数据库、会话和两个初始账号密码后启动：

```sh
docker compose up --build
```

浏览器打开 `http://localhost`。数据库容器首次初始化会按文件名顺序执行两份迁移；后续使用同一持久化卷不会重复执行。需要导入工作簿时，在能访问数据库的环境执行：

```sh
IMPORT_WORKBOOK_PASSWORD='在此输入密码' \
DATABASE_URL='postgresql://inventory:密码@localhost:5432/inventory' \
python3 scripts/seed_inventory.py --input /path/to/workbook.xlsx --apply
```

`--apply` 会把产品观察、流水候选、资产观察、质量问题、可安全解析的产品、快照和历史流水写入，并将冲突行保留在 `resolution_case`；同一文件按 SHA-256 和来源行幂等。正期初量默认只计入待切账统计，不会虚构日期；审核切账日后使用：

```sh
IMPORT_WORKBOOK_PASSWORD='在此输入密码' \
DATABASE_URL='postgresql://inventory:密码@localhost:5432/inventory' \
python3 scripts/seed_inventory.py --input /path/to/workbook.xlsx \
  --apply --post-opening --cutover-date 2026-08-01
```

正式切账前请先审核冲突与期初余额。产品、申请行和流水均保存字典 `uom_id` 与 `source_uom_raw`；盒、套、米等单位不会自动换算成“个”。

使用仓库附带的 Python 运行时可对真实工作簿做完整干运行；测试不包含密码、电话、客户资料或工作簿内容。

## 远程部署（示例配置）

`deploy/deploy_remote.sh` 使用 SSH 将当前代码上传到 `${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_DIR}`，在本地构建前端静态资源，再启动 PostgreSQL、OCR、API 和 Web 四个服务。目标机不需要从 Docker Hub 拉取 Node/Nginx 镜像；Web 使用已缓存的 Python 基础镜像提供静态文件并反代 `/api`。

首次部署并导入加密工作簿：

```sh
IMPORT_WORKBOOK_PASSWORD='在此输入密码' \
deploy/deploy_remote.sh --seed-workbook /path/to/workbook.xlsx
```

脚本没有 `--env-file` 时会在远端生成随机数据库、会话、OCR 和初始账号密码，保存为权限 `600` 的 `${DEPLOY_DIR}/.env`；也可先复制 `deploy/remote.env.example`，填入长随机值后用 `--env-file` 上传。工作簿和密码只读挂载给一次性导入容器，导入完成即从远端删除。默认访问地址为 `https://erp.example.invalid`，API 仅绑定目标机回环地址 `18001`，PostgreSQL 仅绑定 `15432`。
