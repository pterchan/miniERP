FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY api/requirements.txt /app/api/requirements.txt
RUN pip install --no-cache-dir -r /app/api/requirements.txt
COPY api /app/api
COPY db /app/db
COPY scripts /app/scripts
# 非 root 运行：解码库出现解析漏洞时限制爆炸半径
RUN useradd --system --no-create-home --uid 10001 appuser && chown -R appuser /app
USER appuser
EXPOSE 8000
# --proxy-headers：容器内 API 只从 compose 网络收到 web/网关代理流量，
# 信任 X-Forwarded-For/Proto 让审计记录真实客户端 IP 而不是代理容器地址。
# --workers 2：单进程同步端点受 GIL 限制（压测 ~120 RPS 封顶），双 worker 实测
# 吞吐 +62%；每进程独立连接池 30，合计 60 连接 < PostgreSQL 默认 max_connections=100。
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2", "--proxy-headers", "--forwarded-allow-ips", "*"]
