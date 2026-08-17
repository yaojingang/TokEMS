# TokEMS 项目协作规则

## 生产发布

- 生产发布前必须阅读 `docs/production-deployment-runbook.md`。
- 唯一上游仓库为 `https://github.com/yaojingang/TokEMS.git`，生产代码只允许来自已合并且 CI 通过的 `origin/main`。
- 生产服务器源码目录为 `/www/wwwroot/TokEMS`。宝塔站点目录 `/www/dk_project/wwwroot/hui.ailingdaoli.com` 只承载站点和反向代理配置，禁止在该目录拉取代码、构建镜像或执行数据库迁移。
- 服务器分支 `production` 跟踪 `origin/main`。发布前确认工作区干净，并确认服务器 `HEAD` 与 `origin/main` 完全一致。
- 每次生产变更都要先创建数据库备份、记录当前提交和容器状态，并为当前应用镜像添加 `rollback-<时间戳>` 标签。
- Docker 构建和运行必须使用同一组 `BUILD_SHA`、`BUILD_TIME`、`BUILD_MIGRATION`、`BUILD_MIGRATION_HASH`。任何值为 `unknown` 时禁止切换生产流量。
- 常规发布固定使用 `SEED_DEMO_DATA=false`。只有已确认需要同步仓库规范模板时，才允许按 Runbook 的“规范模板同步”流程临时运行 `SEED_DEMO_DATA=true`。
- 规范模板的组织 slug 为 `geo-conference`，大会 slug 为 `tokems26`。线上报名、订单、票、发票、库存销量和用户数据必须保留。
- 禁止把 `git reset --hard`、`git clean`、`docker system prune`、`docker compose down -v`、删卷、清库或数据库覆盖恢复写入常规发布流程。
- 发布完成后必须同时验证容器健康、服务器本机 HTTP、公网 HTTP、构建版本、迁移哈希、公开大会内容和生产数据计数。
- `.env`、数据库连接、密钥、令牌和第三方凭据不得写入 Git、日志、Issue、PR 或发布记录。检查环境时只输出允许公开的键。

## 发布记录

- 每次正式发布从 `docs/release-records/TEMPLATE.md` 创建一份日期化记录。
- 发布记录包含目标提交、最高迁移、备份位置、镜像回滚标签、执行结果、验证证据、异常和剩余风险。
- 历史记录只描述当次事实。后续发布以当前 Git、CI、服务器健康接口和 `docs/production-deployment-runbook.md` 为准。

## 网站统计隔离

- 报名、账户、订单、发票、票证、独立支付、后台和 API 路径禁止加载网站统计脚本。
- 公开区域与敏感区域之间的前端导航必须创建新文档，避免已执行的第三方脚本或敏感页面内存跨越边界。
- 新增或调整公开路由时同步更新统计路径分类、整页边界测试和真实 Head 验收。
