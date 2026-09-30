# 部署指南

miniERP 提供 Docker Compose 本地部署和可选的远程 SSH 部署。也可以把 Web 服务挂在 Nginx 的 /erp/ 子路径下。

## 本地部署

    cp .env.example .env
    # 将示例密码和令牌替换为随机值
    docker compose up --build

浏览器入口为 http://127.0.0.1:18080/erp/。PostgreSQL 首次初始化会按文件名顺序执行数据库迁移。升级已有数据库时，按[数据模型](data-model.md)说明幂等补跑新增迁移。

升级已有数据库时先停止 API/Web，按[数据模型](data-model.md)补跑迁移，成功后再启动新版应用。升级到包含货品搜索性能修复的版本时，需补跑 `010_perf_indexes.sql`；新查询直接读取该迁移的生成列。迁移涉及 `product`、`product_identifier` 和 `product_name_alias` 三张表的生成列及索引，大库应安排低峰维护窗口。

开发热更模式可单独启动依赖服务，再运行 API 与 Vite：

    docker compose up -d postgres minio ocr
    pip install -r api/requirements.txt
    DATABASE_URL='postgresql://inventory:<密码>@localhost:5432/inventory' uvicorn api.main:app --reload --port 8000
    cd web && npm ci && npm run dev

## 远程部署

远程部署目标必须显式提供，不含任何预设主机、账户或服务器路径：

    deploy/deploy_remote.sh --host <主机> --user <用户> --remote-dir <绝对路径>

也可通过 DEPLOY_HOST、DEPLOY_USER、DEPLOY_DIR 环境变量提供相同配置。脚本在本地构建 Web 资源，经 SSH 上传代码，在远端生成随机 .env（若未上传自定义配置）。远端须安装 Docker Compose 插件、curl、openssl，并可拉取 Docker 镜像。

发布采用短暂停机升级，顺序为：

1. 校验 Compose 配置并构建 API、OCR、Web 镜像，构建失败不会暂停旧应用。
2. 停止 API/Web，仅启动 PostgreSQL，最多等待 120 秒使最终 TCP 实例就绪。首次初始化的临时实例只监听 Unix socket，不会提前通过这个探活。
3. 在 PostgreSQL 容器内按文件名顺序幂等重放全部 SQL 迁移，任一迁移失败立即停止发布。
4. 迁移全部成功后启动完整应用栈，通过 `docker compose port web 8080` 获取实际公布端口并检查 `/api/healthz`；每次健康请求的连接超时为 2 秒、总超时为 5 秒。API 保持 `ERP_BOOTSTRAP_STRICT=1`，初始账号在 schema 就绪后创建。

全新卷先由 PostgreSQL 完成自动迁移，再幂等重放；旧卷通过这次重放补齐 schema。停机阶段之后的迁移、启动或健康检查失败时，脚本退出非零并再次停止 API/Web，保留数据库供排查，不自动回退迁移或恢复旧应用。修复故障后重新运行脚本；若 Docker 无法停止应用，脚本会明确报告并要求手动处理。

首次部署可使用私有 dotenv 文件：

    deploy/deploy_remote.sh --host <主机> --user <用户> --remote-dir <绝对路径> --env-file <本地.env>

导入历史库存时同时提供工作簿、映射文件和密码；映射及工作簿会以只读方式挂载给一次性容器，运行结束后从远端删除：

    IMPORT_WORKBOOK_PASSWORD='<密码>' deploy/deploy_remote.sh \
      --host <主机> --user <用户> --remote-dir <绝对路径> \
      --seed-workbook <工作簿.xlsx> --mapping <导入映射.json>

## Nginx 子路径网关

deploy/gateway/nginx.conf 演示如何把 /erp/ 转发到 Web 容器的回环高位端口。应用默认端口为 127.0.0.1:18080，Cookie 路径应设置为 /erp。先按实际系统修改 Nginx 的 server_name 与证书，再安装配置：

    sudo mkdir -p /var/www/mini-erp
    sudo cp deploy/gateway/index.html /var/www/mini-erp/index.html
    sudo cp deploy/gateway/nginx.conf /etc/nginx/conf.d/mini-erp.conf
    sudo nginx -t
    sudo systemctl reload nginx

如果只部署 miniERP，可以将 Nginx server_name 改为自己的域名，并把 / 根路径转发至 /erp/ 或提供自己的静态页。

两层 Nginx 与 Python Web 变体均保留浏览器的完整 `Host`（包括公开端口）；Nginx 反代使用 `$http_host`。这样非标准端口上的浏览器 `Origin` 与 API 收到的 Host 一致，登录同源校验仍拒绝跨站请求。

## 故障排查

| 症状 | 检查 |
|---|---|
| 页面打不开 | 检查 docker compose ps 与 Nginx 配置；直连入口为 http://127.0.0.1:18080/erp/ |
| API 不通 | 检查 Web 到 API 的 /api 反代，并访问 http://127.0.0.1:18080/api/healthz |
| OCR 未就绪 | 查看 docker compose logs ocr；服务在模型加载完成后才通过 /readyz |
| 登录后立即 401 | ERP_COOKIE_PATH 必须与浏览器访问前缀一致；/erp/ 对应 /erp |
| Vite 开发登录提示来源不一致 | `/api` 代理需保留 `changeOrigin: false`，使原始 Host 与浏览器 Origin 一致 |
| 图片上传失败 | 检查 MinIO 健康状态、访问密钥和桶名 |
| 数据库缺少迁移 | 按数据模型文档补跑幂等迁移（010 的生成列涉及 product、product_identifier、product_name_alias 三张表，大库需安排低峰维护窗口） |
| 数据库连接数逼近上限 | 默认 API 为 2 worker，每个 worker 上限为 `ERP_DB_POOL_MAX=30`；为其他客户端保留连接预算，配置详见[配置参考](configuration.md) |
| 发布失败后应用停止 | 排查对应构建、迁移或健康检查错误，修复后重新运行脚本；停机后的失败不会自动启动旧应用 |
