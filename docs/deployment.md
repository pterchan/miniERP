# 部署指南

miniERP 提供 Docker Compose 本地部署和可选的远程 SSH 部署。也可以把 Web 服务挂在 Nginx 的 /erp/ 子路径下。

## 本地部署

    cp .env.example .env
    # 将示例密码和令牌替换为随机值
    docker compose up --build

浏览器入口为 http://127.0.0.1:18080/erp/。PostgreSQL 首次初始化会按文件名顺序执行数据库迁移。升级已有数据库时，按[数据模型](data-model.md)说明幂等补跑新增迁移。

升级到包含货品搜索性能修复的版本时，需先补跑 `010_perf_indexes.sql`，再启动新 API；新查询直接读取该迁移的生成列。迁移涉及 `product`、`product_identifier` 和 `product_name_alias` 三张表的生成列及索引，大库应安排低峰维护窗口。

开发热更模式可单独启动依赖服务，再运行 API 与 Vite：

    docker compose up -d postgres minio ocr
    pip install -r api/requirements.txt
    DATABASE_URL='postgresql://inventory:<密码>@localhost:5432/inventory' uvicorn api.main:app --reload --port 8000
    cd web && npm ci && npm run dev

## 远程部署

远程部署目标必须显式提供，不含任何预设主机、账户或服务器路径：

    deploy/deploy_remote.sh --host <主机> --user <用户> --remote-dir <绝对路径>

也可通过 DEPLOY_HOST、DEPLOY_USER、DEPLOY_DIR 环境变量提供相同配置。脚本在本地构建 Web 资源，经 SSH 上传代码，在远端生成随机 .env（若未上传自定义配置），启动 Compose 服务并检查健康状态。远端须安装 Docker Compose 插件、curl、openssl，并可拉取 Docker 镜像。

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
| 数据库连接数逼近上限 | API 以 2 worker × 30 连接运行（合计 60）；再上调 worker 数前先调大 postgres `max_connections` |
