FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
# nginx 主进程需 root 绑定特权端口与写 cache/pid；worker 以 nginx 用户运行，
# 8080 非特权端口 + 只读静态目录已最小化暴露面
EXPOSE 8080
