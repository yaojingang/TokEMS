# TokEMS 项目协作规则

## 生产发布

- 生产发布前必须阅读 `docs/production-deployment-runbook.md`。
- 唯一上游仓库为 `https://github.com/yaojingang/TokEMS.git`，生产代码只允许来自已合并且 CI 通过的 `origin/main`。
- 生产服务器源码目录为 `/www/wwwroot/TokEMS`。宝塔站点目录 `/www/dk_project/wwwroot/hui.ailingdaoli.com` 只承载站点和反向代理配置，禁止在该目录拉取代码、构建镜像或执行数据库迁移。
- 生产环境文件固定为 `/etc/tokems/production.env`，目录权限为 `root:root 0700`，文件权限为 `root:root 0600`。生产 Compose 和发布脚本禁止读取 Git 工作区中的实时 `.env`。
- 服务器分支 `production` 跟踪 `origin/main`。发布前确认工作区干净，并确认服务器 `HEAD` 与 `origin/main` 完全一致。
- 每次生产变更都要先创建数据库备份、记录当前提交和容器状态，并为当前应用镜像添加 `rollback-<时间戳>` 标签。
- Docker 构建和运行必须使用同一组 `BUILD_SHA`、`BUILD_TIME`、`BUILD_MIGRATION`、`BUILD_MIGRATION_HASH`。任何值为 `unknown` 时禁止切换生产流量。
- 常规发布固定使用 `SEED_DEMO_DATA=false`。只有已确认需要同步仓库规范模板时，才允许按 Runbook 的“规范模板同步”流程临时运行 `SEED_DEMO_DATA=true`。
- 自动检测到规范漂移或显式执行 `deploy --sync-canonical` 时，目标规范快照与当前运行提交完全一致，且目标差异仅包含部署脚本、部署测试、协作文档或运维文档，脚本允许复用当前已验证镜像完成规范同步。该流程仍要执行数据库备份、写冻结、生产数据保护和完整验收；其余目标继续执行标准镜像构建与 10 GiB 内存门禁。
- 自动发布预检必须以只读数据库连接导出生产完整规范快照并与目标提交比较；Git 快照变化或生产状态漂移时都要启用规范同步，`--skip-canonical` 不得跳过漂移修复。
- 规范模板的组织 slug 为 `geo-conference`，大会 slug 为 `tokems26`。线上报名、订单、票、发票、库存销量和用户数据必须保留。
- 本地 `http://127.0.0.1:8088/` 当前实际展示的 `geo-conference` / `tokems26` 是唯一规范大会模板。首页文案或关联后台设置发生任何变化后，推送 GitHub 前必须运行 `pnpm canonical:export`，并提交完整规范快照 `packages/contracts/src/canonical-homepage.snapshot.json` 及前台派生快照 `packages/contracts/src/canonical-homepage.public.json`。
- 每次推送 GitHub 前都必须运行 `pnpm canonical:check`。本地首页、数据库或当前发布快照不可读取，快照存在漂移，或脱敏校验失败时禁止推送。
- `pnpm install` 会启用仓库内 `.githooks/pre-push` 门禁。门禁会核对实时规范状态、受保护文件的工作区清洁度，以及实际待推送提交中的快照与同步逻辑；禁止绕过该门禁推送。
- 规范快照包含当前公开发布内容，以及大会基础设置、模板草稿、当前指针引用的发布版本、首页绑定、票种定义与容量、报名表、嘉宾、议程、FAQ、SEO、公开站点设置、蓝图、核销清单、通知模板、AI 文案提示、模板素材和所有被纳入模板定义引用的 HTML 文档。未被当前发布、绑定或默认设置引用的历史版本，以及销量、报名用户、会员资料、订单、支付、票证、发票和审计记录不得进入快照。
- 管理员账号、姓名、邮箱、密码、权限身份，以及 API 地址、密钥、令牌、Cookie、第三方集成、支付、短信和对象存储凭据不得进入规范快照。管理员信息继续只从部署环境读取。
- 禁止把 `git reset --hard`、`git clean`、`docker system prune`、`docker compose down -v`、删卷、清库或数据库覆盖恢复写入常规发布流程。
- 解除生产写冻结前必须启动独立的 systemd 监督单元；恢复标记仍存在且部署控制器退出时，该单元持续停止 API 和 Worker，直至确认写容器已经停止。
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
