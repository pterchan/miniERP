# miniERP

miniERP 是面向小团队的进销存与 OA 审批系统，支持采购、销售、库存单据与过账、应收应付、货品主数据、冲突处理、SN/UUID 序列号追踪、图片、OCR 扫描、导出和审计。

本项目由一个私有项目派生而来，原项目的组织与部署标识已去除。欢迎使用，也欢迎提出 Issue、反馈问题和建议。

## 快速开始

    cp .env.example .env
    # 编辑 .env，为所有密码和令牌设置随机值
    docker compose up --build

打开 <http://127.0.0.1:18080/erp/>。PostgreSQL 首次启动时会按顺序运行数据库迁移。配置说明见[配置参考](docs/configuration.md)。

## 功能与架构

- FastAPI、PostgreSQL 和原生参数化 SQL；React 与 Vite 前端。
- 采购、销售和库存单据；过账后库存流水不可变，纠错使用红冲。
- OA 申请审批、角色权限、冲突处理、应收应付和全量审计。
- MinIO 货品图片与独立离线 RapidOCR 服务。
- XLSX 导入支持 JSON 列映射；默认干运行，数据经人工审核后才进入正式账。
- Docker Compose 本地部署；可选 Nginx 子路径部署。

## 目录

    api/            FastAPI 后端
    web/            React + Vite 前端
    ocr_service/    离线 OCR 服务
    db/migrations/  PostgreSQL SQL 迁移
    scripts/        XLSX 干运行与审核导入工具
    deploy/         Compose 远程部署与 Nginx 示例
    docs/           架构、配置、开发、导入和部署文档
    tests/          后端及跨层契约测试

更多说明：

- [架构](docs/architecture.md)
- [API](docs/api.md)
- [数据模型与迁移](docs/data-model.md)
- [配置参考](docs/configuration.md)
- [部署](docs/deployment.md)
- [开发指南](docs/development.md)
- [XLSX 数据导入](docs/data-import.md)
- [OCR 服务](ocr_service/README.md)

## 许可证

本项目采用 MIT 许可证，第三方组件与 OCR 模型的归属信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
