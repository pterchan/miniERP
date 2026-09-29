# Nginx 子路径示例

此目录提供单个 miniERP 应用的 Nginx 子路径配置示例。按实际域名、TLS 证书、静态目录和监听策略调整后再安装。

    sudo mkdir -p /var/www/mini-erp
    sudo cp deploy/gateway/index.html /var/www/mini-erp/index.html
    sudo cp deploy/gateway/nginx.conf /etc/nginx/conf.d/mini-erp.conf
    sudo nginx -t
    sudo systemctl reload nginx

Nginx 将 /erp/ 转发到本机 127.0.0.1:18080，并移除转发路径前缀。Compose Web 服务默认只绑定回环地址。部署到 TLS 终止代理后，将 ERP_SECURE_COOKIES=1 打开（Compose 与 `deploy/deploy_remote.sh` 生成的环境文件均已透传该变量）。
