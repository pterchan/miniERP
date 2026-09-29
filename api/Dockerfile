FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY api/requirements.txt /app/api/requirements.txt
RUN pip install --no-cache-dir -r /app/api/requirements.txt
COPY api /app/api
COPY db /app/db
COPY scripts /app/scripts
EXPOSE 8000
# --proxy-headers：容器内 API 只从 compose 网络收到 web/网关代理流量，
# 信任 X-Forwarded-For/Proto 让审计记录真实客户端 IP 而不是代理容器地址。
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
