# 运行、迁移与发布手册

本文件说明通用运行、迁移和发布能力。`hui.ailingdaoli.com` 当前生产环境的固定目录、GitHub 推送规则、Docker 构建身份、备份、模板同步、验收和回滚流程见[生产推送与 Docker 发布规范](production-deployment-runbook.md)。每次正式发布的事实记录保存在 [`release-records/`](release-records/)。

## 生产服务器单命令发布

生产服务器源码与 Compose 固定在 `/www/wwwroot/TokEMS`，Git 分支 `production` 跟踪 `origin/main`。部署入口安装为 root 所有的 `/usr/local/sbin/tokems-deploy`；GitHub 主分支合并并完成 CI 后，在服务器运行：

```bash
sudo /usr/local/sbin/tokems-deploy check
sudo /usr/local/sbin/tokems-deploy deploy
```

首次启用前，把现有生产环境文件一次性安装到 `/etc/tokems/production.env`，目录权限为 `root:root 0700`，文件权限为 `root:root 0600`。同时把仅有 `read:packages` 权限的 GHCR PAT classic 安装到 `/etc/tokems/ghcr-read-token`，保持 `root:root 0600`。脚本会为每次运行固定 root-only 环境快照，并在 `/run` 中使用临时 Docker 登录目录；服务器工作区仍由 `ecs-user` 管理，运行过程不读取工作区中的实时 `.env`。

历史失败发布导致 `.env` 构建身份与健康运行容器不一致时，先运行 `repair-identity`。该模式验证五类服务和数据库后备份并修正四项 `BUILD_*`，不会重启容器：

```bash
sudo /usr/local/sbin/tokems-deploy repair-identity
```

恢复标记存在时，使用已合并并通过 CI 的前向修复继续发布；独立人工恢复完成后可复核写权限、Worker ready、生产数据子集和首页投影并归档标记：

```bash
sudo /usr/local/sbin/tokems-deploy recover-interrupted
sudo /usr/local/sbin/tokems-deploy deploy --resume-recovery
sudo /usr/local/sbin/tokems-deploy resolve-recovery
```

脚本不依赖宿主机 Node.js 或 pnpm。它会验证目标提交来自已合并 PR，官方 main push 的 `quality-and-flows` 成功，独立 `tokems-image-publish` 工作流成功，并验证 `release-<SHA>` descriptor 及六个服务镜像的 GitHub provenance。schema 2 descriptor 固定 Git Bundle、verifier、构建时间、最高迁移、迁移哈希、目标平台和六个镜像 digest；服务器验证两份 payload 的 SHA-256、Bundle 固定 ref、精确目标 SHA 和 Fast-forward 历史后更新 `origin/main`，标准路径不依赖 `github.com` Git Smart HTTP。六个候选镜像全部拉取并验证完成后才更新 `tokems-*:local`。随后脚本证明运行 API、目标 Compose 和备份操作使用同一个 PostgreSQL 实例，并通过只读导出核对线上完整规范状态与目标快照。Git 快照发生变化或线上已存在漂移时，规范同步会自动启用。标准发布依次执行源码证明与导入、构建开始备份、镜像回滚标签、root-only 源码与环境快照、Fast-forward、digest 镜像拉取、写冻结后的最终数据库备份、迁移、规范模板同步、应用容器切换和完整验收。自动检测到规范漂移或显式执行 `deploy --sync-canonical` 时，目标规范快照与运行提交一致、差异仅限部署控制和文档，脚本会复用当前镜像，并执行两轮数据库备份、写冻结、规范同步、数据保护和完整验收。验收包含公开首页和生产数据库重新导出的脱敏完整后台模板快照。备份与日志保存在 `/www/backup/TokEMS/<时间戳>`，容量检查直接读取这个目录实际所在的文件系统。任何资源、Git、CI、镜像证明、Compose、Nginx、数据保护或健康门禁失败都会终止发布。首次修改源码、环境或镜像前会持久化 `RECOVERY_REQUIRED`；数据库写冻结后把阶段更新为 `write-freeze`，完整发布通过后才归档。`pre-write` 阶段的硬中断使用保存于发布备份中的精确恢复脚本离线恢复；受保护窗口由独立的 systemd 监督单元持续守护，部署控制器退出且恢复标记仍存在时反复停止 API/Worker，再由恢复流程收集数据库迁移证据并恢复应用。数据库不可用时继续保留标记并保持 API/Worker 停止。

每次标准发布都使用短暂写冻结：候选镜像拉取并验证完成后停止 API/Worker，重新生成包含准备期间新增交易的最终 dump 和业务基线。稳定业务表按主键索引逐表流式取证；带保留期自动清理的数据在只读阶段单独比对，恢复 Worker 后允许既定清理策略运行。迁移与可选规范同步完成后，以只读 API 和暂停 Worker 的状态验收，随后恢复目标 API/Worker。Worker 完成启动维护后会在容器 tmpfs 写入带构建身份的持久 ready 文件，脚本核对该身份后再复核生产主键、计数和销量。窗口内报名、支付回调、后台保存和异步任务需要依赖调用方重试，正式操作安排在业务低峰。

4 核 8G 生产机的默认发布路径只拉取预构建镜像，跳过 10 GiB 构建内存门禁，继续执行 Docker 磁盘、备份盘、数据库证明、数据保护和验收门禁。人工应急时可显式运行 `check --build-on-host` 与 `deploy --build-on-host`；该路径仍要求至少 10 GiB 的 `MemAvailable + SwapFree`，且源码文件系统和 Docker 数据目录各有 12 GiB 可用空间。符合兼容条件的 `--sync-canonical` 规范修复复用当前镜像。备份盘预检按四倍当前数据库体积加 4 GiB 保留空间计算；构建开始的主键证据生成后，脚本会用实测文件大小重新预算最终备份、只读验收和恢复写入后的证据，并在每个大文件阶段前复核。数据库证明、查询、dump 和迁移均有超时上限。标准入口会拒绝 Compose 基础设施变更；此类发布使用单独维护窗口。脚本保留历史备份与回滚镜像，清理策略由运维在恢复验证和观察期后单独执行。完整首次安装命令、手工等价步骤和数据库恢复边界见生产 Runbook。

## 本地 Docker 完整部署

```bash
pnpm install
pnpm docker:deploy
```

`docker:deploy` 依次完成以下工作：

1. 使用根目录多阶段 `Dockerfile` 构建 API、Worker、Nuxt、Admin 和本地通知接收器镜像。
2. 启动 PostgreSQL、Redis、MinIO、Mailpit 与通知接收器并等待健康检查。
3. 运行一次性 `db-init`，执行 54 个 Drizzle 迁移；仅在 `SEED_DEMO_DATA=true` 时写入幂等演示数据。
4. 运行一次性 `minio-init`，创建私有 `conference-assets` 桶。
5. 按依赖顺序启动 API、Worker、Web 和 Admin。
6. 启动 Gateway，在同一 IP 和端口上按主机名代理前台、后台和 API。
7. 执行 `tooling/docker-smoke.mjs`，验证数据库、正式大会、OpenAPI、后台登录、前后台页面、CORS、MinIO、Mailpit 与通知 Webhook。

构建脚本会按镜像目标顺序执行并共享 BuildKit 缓存。这一策略可规避 Docker Desktop 在多目标共享构建上下文中偶发的 Bake 会话冲突，后续启动阶段使用 `--no-build` 保证运行镜像与刚完成的构建结果一致。

Compose 顶层名称固定为 `tokems`，目录中的中文和空格不会改变容器、网络或数据卷命名。Docker 技术标识统一使用小写，因此容器显示为 `tokems-api-1`、`tokems-web-1`、`tokems-admin-1` 等，产品名称继续显示为 `TokEMS`。

默认入口：

| 服务               | 本机地址                                  |
| ------------------ | ----------------------------------------- |
| 大会前台           | <http://localhost:8088>                   |
| 运营后台           | <http://admin.localhost:8088/admin/login> |
| API / Swagger      | `localhost:8088/api/v1` / `/api/docs`     |
| PostgreSQL         | `localhost:15432`                         |
| Redis              | `localhost:16379`                         |
| MinIO / Console    | `localhost:19000` / `localhost:19001`     |
| Mailpit SMTP / Web | `localhost:1025` / `localhost:8025`       |
| 本地通知接收器     | <http://localhost:4080/health>            |

本机端口冲突时，复制环境模板并修改对应变量：

```bash
cp .env.example .env
# 例如：GATEWAY_PORT=9088 POSTGRES_PORT=25432 REDIS_PORT=26379
# 同步修改 PUBLIC_ORIGIN / ADMIN_ORIGIN / PAYMENT_PUBLIC_* / DATABASE_URL / REDIS_URL / S3_*ENDPOINT
pnpm docker:deploy
```

Docker 浏览器请求固定使用 `/api/v1`，Nuxt 服务端使用 `http://api:4100/api/v1`。`PUBLIC_ORIGIN` 是前台、站点链接与支付回调的外部来源，`ADMIN_ORIGIN` 是后台的独立来源。两个域名进入同一个 Gateway 端口；后台域名按 `admin.<前台域名>` 配置。修改后需要重新执行 `pnpm docker:deploy`。

本地 Docker 调试会在 `.env.tokems.local` 中配置两套隔离身份：前台使用任意有效中国大陆手机号和固定演示验证码 `123456`，运营后台使用 `admin / admin`。前台配置要求 `DEPLOYMENT_MODE=local`、`CUSTOMER_OTP_MODE=fake`，并校验前后台地址均为本机回环地址；后台本地种子账号继续使用 `ALLOW_INSECURE_LOCAL_AUTH=true` 和 `VITE_SIMPLE_AUTH=true`。正式环境使用 `DEPLOYMENT_MODE=production`、`CUSTOMER_OTP_MODE=provider`，关闭后台简化认证并配置强密码。

部署状态与日志：

```bash
pnpm docker:status
pnpm docker:verify
node tooling/docker-compose.mjs logs --tail=200 api worker
node tooling/docker-compose.mjs logs db-init minio-init
```

`db-init` 和 `minio-init` 正常状态为 `Exited (0)`。其余长期服务应显示 `Up` 与 `healthy`。

部署脚本会从当前 Git 提交和迁移目录生成 `BUILD_SHA`、`BUILD_TIME`、`BUILD_MIGRATION` 与 `BUILD_MIGRATION_HASH`。API 健康检查会比较构建迁移哈希和数据库最新已应用哈希；不一致时返回 `degraded`，Worker 会拒绝启动。Web、Admin、Gateway 与 Worker 的版本信息也必须一致。`pnpm release:manifest` 会把逐文件 SHA-256、镜像摘要、OpenAPI 摘要和脱敏环境指纹写入 `test-results/remediation/<run-id>/manifest.json`。

### 停止、更新与数据卷

```bash
pnpm docker:stop  # 停止服务并保留容器、网络与数据卷
pnpm docker:down  # 删除容器与网络并保留数据卷
pnpm docker:deploy # 重新构建变更镜像并恢复服务
```

具名卷包括 `tokems-postgres`、`tokems-redis` 和 `tokems-minio`。执行 `node tooling/docker-compose.mjs down -v` 会永久删除本地数据库、队列和对象存储数据，仅适用于明确需要全量重置的场景。

### 源码热更新模式

需要调试源码时可以仅启动依赖容器，并让 Node.js 服务运行在宿主机：

```bash
cp .env.example .env
node tooling/docker-compose.mjs up -d postgres redis minio minio-init mailpit notification-sink
pnpm db:migrate
pnpm db:seed
pnpm dev
```

此模式使用 `.env` 中的 `DATABASE_URL=postgresql://conference:conference@localhost:15432/conference` 与 `REDIS_URL=redis://localhost:16379`。前台、后台和 API 的源码开发地址依次为 `localhost:3000`、`localhost:3200/admin/` 和 `localhost:4100`。

## 环境变量

### Agent Access 灰度

Agent Access 首发状态为 `experimental`，三个开关默认均为 `false`。按以下顺序灰度，每一步完成安全指标、审计和撤销演练后再继续：

1. 配置独立的 32 字节 base64 `AGENT_ACCESS_TOKEN_SECRET`，只开启 `TOKEMS_AGENT_ACCESS_ENABLED`，验证发现、设备授权、只读、DPoP、轮换与撤销。
2. 开启 `TOKEMS_AGENT_WRITES_ENABLED`，验证受控审批、前态冲突、幂等策略、发布后真实页面与 `unknown` reconcile。
3. 开启 `TOKEMS_AGENT_CRITICAL_ACTIONS_ENABLED`，验证退款、PII 导出、删除、管理员权限、集成 secret 和关键发票文件的 step-up。

密钥轮换时先把旧值放入 `AGENT_ACCESS_TOKEN_PREVIOUS_SECRET`，再发布新主密钥。旧密钥只保留 15 分钟验证窗口，窗口结束后清空并重新发布。紧急处置优先在组织后台执行全部连接撤销，再关闭总开关；数据库中的 operation 与代理审计记录继续保留。

| 变量                                       | 用途                                                         |
| ------------------------------------------ | ------------------------------------------------------------ |
| `DATABASE_URL`                             | PostgreSQL 连接，生产环境必填                                |
| `DATABASE_POOL_SIZE`                       | API、Worker 单实例数据库连接池上限                           |
| `DEPLOYMENT_MODE`                          | 部署边界，正式环境为 `production`                            |
| `PUBLIC_ORIGIN`                            | 前台、API、站点链接和回调的外部 HTTPS 来源                   |
| `ADMIN_ORIGIN`                             | 后台独立的外部 HTTPS 来源                                    |
| `GATEWAY_BIND_ADDRESS` / `GATEWAY_PORT`    | 统一网关的宿主机监听地址与端口                               |
| `POSTGRES_PORT` / `REDIS_PORT`             | 数据服务宿主机映射端口                                       |
| `MINIO_API_PORT` / `MINIO_CONSOLE_PORT`    | MinIO API / Console 宿主机映射端口                           |
| `MAILPIT_SMTP_PORT` / `MAILPIT_WEB_PORT`   | Mailpit SMTP / Web 宿主机映射端口                            |
| `NOTIFICATION_SINK_HOST_PORT`              | 本地通知接收器宿主机映射端口（容器内固定 4080）              |
| `WEB_PORT` / `ADMIN_PORT` / `API_PORT`     | 源码开发模式的服务端口                                       |
| `REDIS_URL`                                | BullMQ 连接，生产 Worker 必填                                |
| `JWT_SECRET`                               | JWT 签名，生产环境至少 32 字符                               |
| `INVOICE_DOWNLOAD_SIGNING_SECRET`          | 发票与导出下载链接签名密钥                                   |
| `CUSTOMER_OTP_PEPPER`                      | 普通用户验证码摘要密钥，生产环境至少 32 字符                 |
| `CUSTOMER_SESSION_SECRET`                  | 普通用户会话与 CSRF 密钥，生产环境至少 32 字符               |
| `NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET`   | 通知短期敏感载荷加密密钥，生产环境至少 32 字符               |
| `CUSTOMER_OTP_ORG_DAILY_LIMIT`             | 单组织每日验证码请求上限，默认 10000                         |
| `CUSTOMER_OTP_PLATFORM_HOURLY_LIMIT`       | 单手机号跨组织每小时验证码请求上限，默认 8                   |
| `CUSTOMER_OTP_MODE`                        | 前台验证码模式：本地 `fake`、正式 `provider`                 |
| `ALLOW_INSECURE_LOCAL_AUTH`                | 本地后台种子弱密码许可，生产环境关闭                         |
| `VITE_SIMPLE_AUTH`                         | 运营后台的本地简化登录界面开关                               |
| `SEED_DEMO_DATA`                           | 是否写入仓库规范大会快照和环境提供的管理员，生产环境默认关闭 |
| `ADMIN_USERNAME`                           | 运营后台登录用户名，本地默认为 `admin`                       |
| `ADMIN_USER_ID`                            | 超级管理员的固定用户 UUID，默认使用种子管理员 ID             |
| `ADMIN_PASSWORD`                           | 管理员初始密码，正式环境至少 16 字符                         |
| `PUBLIC_WEB_URL` / `ADMIN_WEB_URL`         | 源码开发模式的 CORS 来源                                     |
| `PUBLIC_ORGANIZATION_SLUG`                 | 默认公开组织                                                 |
| `PUBLIC_SITE_URL`                          | 候补邀请注册链接根地址                                       |
| `TRUST_PROXY`                              | 逗号分隔的受信代理 IP 或网段                                 |
| `API_RATE_LIMIT_PER_MINUTE`                | API 全局单实例限流上限                                       |
| `PAYMENT_WEBHOOK_SECRET`                   | 通用支付回调 HMAC 密钥                                       |
| `PAYMENT_WEBHOOK_SECRET_<PROVIDER>`        | 渠道专用回调密钥，优先级更高                                 |
| `ENABLE_LOCAL_PAYMENT_SIMULATION`          | 本地容器模拟支付开关                                         |
| `LOCAL_PAYMENT_SIMULATION_MOBILES`         | 允许本机模拟支付的手机号白名单，逗号分隔                     |
| `NOTIFICATION_WEBHOOK_URL`                 | 邮件及通用通知提供商 HTTP 入口                               |
| `NOTIFICATION_WEBHOOK_TOKEN`               | 通知提供商 Bearer Token                                      |
| `SMS_RECEIPT_INTERVAL_MS`                  | 阿里云短信送达状态查询周期，默认 30000 毫秒                  |
| `AI_API_URL` / `AI_API_KEY` / `AI_MODEL`   | AI 内容服务                                                  |
| `HTML_TEMPLATE_IMPORT_ENABLED`             | HTML 模板导入总开关，本地默认开启                            |
| `HTML_TEMPLATE_IMPORT_ORG_ALLOWLIST`       | 允许导入的组织 UUID，逗号分隔，空值表示全部组织              |
| `HTML_TEMPLATE_ORG_ASSET_BYTES`            | 单组织模板资产容量上限，默认 2 GiB                           |
| `HTML_TEMPLATE_ORG_ASSET_COUNT`            | 单组织模板资产数量上限，默认 10000                           |
| `HTML_TEMPLATE_AI_MAPPING_ENABLED`         | AI 变量识别独立开关，默认关闭                                |
| `HTML_TEMPLATE_AI_ORG_MINUTE_LIMIT`        | 单组织每分钟 AI 变量识别上限，默认 5                         |
| `HTML_TEMPLATE_AI_ORG_DAILY_LIMIT`         | 单组织每日 AI 变量识别上限，默认 100                         |
| `DOCKER_DATABASE_URL` / `DOCKER_REDIS_URL` | Compose 内部连接地址                                         |
| `DOCKER_S3_ENDPOINT`                       | Compose 容器访问对象存储的内部地址                           |
| `BUILD_SHA` / `BUILD_TIME`                 | 构建对应的提交和 UTC 时间                                    |
| `BUILD_MIGRATION`                          | 构建对应的最高数据库迁移文件                                 |
| `BUILD_MIGRATION_HASH`                     | 构建对应的最高数据库迁移 SHA-256                             |
| `API_BIND_ADDRESS`                         | 源码 API 监听地址，本地假验证码模式必须为回环地址            |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`  | 本地对象存储凭据                                             |
| `S3_PUBLIC_ENDPOINT` / `S3_REGION`         | 浏览器可访问的对象存储入口与签名区域                         |
| `WORKER_TMPFS_SIZE`                        | 异步 CSV 分页生成时的临时磁盘上限，默认 `512m`               |
| `NOTIFICATION_SINK_PORT`                   | 兼容旧名；优先使用 `NOTIFICATION_SINK_HOST_PORT`             |

机密值应进入部署平台的 Secret Manager。`.env` 仅用于本地开发。

`pnpm docker:deploy` 在本地模式首次运行时生成独立随机凭据，并保存到被版本控制忽略的 `.env.tokems.local`。当 `.env` 或进程环境显式设置 `DEPLOYMENT_MODE=production` 时，部署脚本忽略该本地文件，强制关闭简化认证、开发验证码响应和前后台简化登录界面，并使用生产环境提供的管理员凭据与密钥。缺少核心认证密钥时 Compose 会在启动前终止。

部署完成后的自动验收会在生产模式跳过演示大会、管理员密码和通知投递检查，只验证健康状态、公开页面、后台页面、Swagger、CORS、来源隔离及基础依赖，避免读取生产凭据或向真实通知渠道发送测试消息。

## 迁移策略

`packages/database/drizzle/` 包含 54 个已版本化迁移。`pnpm db:migrate` 通过 Drizzle 迁移记录识别待执行版本。

```bash
# 修改 packages/database/src/schema.ts 后生成迁移
pnpm db:generate

# 审阅 SQL 并在隔离数据库验证
pnpm db:migrate
pnpm db:seed

# 执行质量门禁
pnpm check
```

生产迁移先备份，再由单实例发布任务执行。应用实例在迁移成功后滚动更新。涉及容量、唯一约束和大表索引时，需在预发布环境验证锁等待和执行时长。

普通用户升级会为既有报名补写规范化手机号和邮箱，并创建跨组织外键及有效报名唯一索引。`0013` 到 `0019` 对锁等待设置了 5 秒上限，无法及时获取表锁时会安全终止，发布任务可在业务低峰重试。

报名、订单或用户表数据量较大时，应安排维护窗口，并在生产数据副本记录迁移执行时长。`0015` 会预检同一大会的重复有效手机号，`0019` 会预检报名、订单和发票的组织及大会关系；预检失败时先修复报告中的错配数据。`0017` 需要数据库账号具备启用 `pg_trgm` 扩展的权限。超出窗口预算时，将数据补写拆成分批任务，并单独安排索引变更。

`0042` 先增加报名归并字段与支付成功时间，不受历史重复报名阻塞。`0043` 在建立“同一用户或手机号、同一大会一条报名”的唯一索引前执行预检。出现重复时按以下顺序处理：

```bash
# 默认只预览，输出会脱敏
pnpm db:repair-registration-identities

# 仅在预览没有阻塞组后执行
pnpm db:repair-registration-identities -- --apply

# 建立最终唯一索引
pnpm db:migrate
```

归并命令保留原报名、订单及审计历史，冗余报名会清空身份键并关联到主报名。含多条业务事实、多个未关闭订单、关联订单缺失或交叉身份的组会返回退出码 2，交由人工核对。

### 多次单票迁移与灰度

`0047_multi_purchase_foundation.sql` 为订单增加购票人、购买快照和购买意图，为报名增加独立认领令牌，并为大会增加追加购买开关与单人有效席位上限。`0048_registration_purchase_attempts.sql` 增加持久化购买尝试与购买意图唯一约束，用于跨实例限流和幂等重试。两次迁移均为增量迁移；升级顺序为先执行迁移，再发布 API 与 Worker，最后发布前台和后台。

灰度初始保持 `additionalPurchaseEnabled=false` 和 `maxActiveSeatsPerPurchaser=5`。先选择内部大会开启，验证本人购买、代购、认领、退款、发票、通知和 CSV，再逐场开放。重点监控 `paidOrders`、`paidSeats`、`purchasers`、净收入、购买尝试 429/409、认领失败率、Outbox 延迟与通知失败率。

应用回滚时关闭追加购买开关并回退应用版本，保留 `0047`、`0048` 新增列和表。已创建的订单、席位、认领令牌及审计记录继续保留。出现异常时暂停新代购，继续允许本人订单恢复、支付完成、退款和票务履约。

## 生产构建与启动

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm db:migrate
pnpm --filter @conference/api start
pnpm --filter @conference/worker start
node apps/web/.output/server/index.mjs
```

运营后台静态产物位于 `apps/admin/dist/`，默认发布在 `/admin/`，需要配置 SPA 回退到 `index.html`。项目 Gateway 已包含该路径代理。

本地 Docker 镜像使用相同生产构建入口。`pnpm deploy --prod` 为 API 与 Worker 生成独立运行目录，Nuxt 使用 Nitro 产物，Admin 使用 Nginx 静态运行时。正式环境必须设置 HTTPS `PUBLIC_ORIGIN` 和 `ADMIN_ORIGIN`，例如 `https://conference.example.com` 与 `https://admin.conference.example.com`。两个域名的 DNS 指向同一服务器，宿主机反向代理或云负载均衡器保留原始 Host 并将流量转发到 Gateway，仅向公网开放 80/443。Compose 中的本地通知接收器用于接收邮件和通用通知；正式环境需要使用这些渠道时，应把 `NOTIFICATION_WEBHOOK_URL` 指向真实通知平台。

正式环境还需要把 `S3_PUBLIC_ENDPOINT` 设置为浏览器可访问的 HTTPS 对象存储地址，并按对象存储服务设置 `S3_REGION`。保留本机 `localhost` 默认值会让用户浏览器无法上传模板图片或下载发票文件。

模板图片通过 10 分钟预签名地址上传。未完成登记的暂存对象会在上传窗口结束后执行首次删除，并保留预留记录 24 小时后再次删除和确认，再释放组织容量。正式环境建议同时为 `templates/` 下的 `staged/` 暂存对象配置对象存储生命周期，作为长期兜底清理策略。

生产启动会校验数据库、Redis、通知提供商和 JWT 密钥。支付回调密钥由首次接入渠道时的发布门禁校验。

## 支付渠道接入

### 通用 HMAC 渠道（非微信）

1. 为渠道分配小写标识，例如 `stripe-like`。
2. 配置 `PAYMENT_WEBHOOK_SECRET_<PROVIDER>`。
3. 渠道把毫秒时间戳写入 `X-Payment-Timestamp`。
4. 按 `<timestamp>.<raw-json-body>` 计算 HMAC-SHA256 十六进制签名。
5. 把签名写入 `X-Payment-Signature` 并调用 `/api/v1/payments/webhook/<provider>`。
6. 验证成功、重复回调、金额错误、过期时间戳和伪造签名五类用例。

模拟支付只在 `DEPLOYMENT_MODE=local`、前后台及支付入口均为本机回环地址、`ENABLE_LOCAL_PAYMENT_SIMULATION=true` 时开放。调用方还需持有订单访问令牌，订单必须绑定有效客户账号，报名手机号与客户手机号必须一致并命中 `LOCAL_PAYMENT_SIMULATION_MOBILES`。正式部署固定拒绝该能力。

### 微信支付三通道（Native / JSAPI / H5）

TokEMS 将大会主站与支付入口拆分：

| 用途                                  | 域名 / 路径                                                        |
| ------------------------------------- | ------------------------------------------------------------------ |
| 大会官网、报名、用户中心              | `PUBLIC_ORIGIN`（例如 `https://hui.ailingdaoli.com`）              |
| 订单支付、OAuth、H5 回跳、票券结果    | `PAYMENT_PUBLIC_URL`（例如 `https://www.ailingdaoli.com/pay/hui`） |
| 微信支付 notify（稳定、不可单独撤销） | `{PUBLIC_ORIGIN}/api/v1/payments/wechat/notify/{organizationId}`   |

必填环境变量：

- `PAYMENT_PUBLIC_ORIGIN`：支付入口 origin，必须与 `PUBLIC_ORIGIN` 不同
- `PAYMENT_PUBLIC_BASE_PATH`：默认 `/pay/hui`
- `PAYMENT_PUBLIC_URL`：完整支付入口 URL，须与 origin + base path 一致

微信商户凭据（AppID、商户号、证书序列号、商户私钥、APIv3 密钥、微信支付公钥、公众号 AppSecret、通道开关）全部在管理后台「支付服务」加密入库，**不要**使用 `.env` 中的 `WEIXIN_*` / `MERCHANT_*`（这些变量不会被代码读取）。

微信平台侧需确认：

1. 公众号 AppID 已绑定商户号，并具备网页授权能力。
2. 网页授权域名 / H5 支付域名为 `www.ailingdaoli.com`。
3. JSAPI 支付授权目录为 `https://www.ailingdaoli.com/pay/`（`/pay/hui/` 及其子路径均在目录内）。
4. Native、JSAPI、H5 产品权限均已开通。

外部 Nginx 仅代理 `www` 的 `/pay/hui` 前缀到 Gateway，参见 `docker/payment-entry.nginx.conf.example`。Gateway 会把无尾斜杠的 `/pay/hui` 308 到 `/pay/hui/`，并将页面与 `/pay/hui/_nuxt/` 转到 `payment-web`，将 `/pay/hui/api/` 去前缀后转到 API。

上线与回滚详见 `docs/wechat-pay-rollout.md`。

## 通知与候补

已验证的阿里云短信配置会由 Worker 直接调用官方 SDK，组织下全部大会共享同一配置。发送请求使用通知投递 ID 作为稳定 `OutId`，`Code=OK` 表示阿里云已受理；Worker 随后调用 `QuerySendDetails` 更新最终送达或失败状态。网络结果不明确的请求会先查询状态，不会直接重发。

邮件、未接入阿里云的短信和其他通用通知继续调用 `NOTIFICATION_WEBHOOK_URL`，请求会传递 JSON 正文、`Idempotency-Key: notification:<deliveryId>` 和可选 Bearer Token。提供商返回 2xx 即视为接收成功，可在 `X-Message-Id` 返回渠道流水。

通知按角色分流。报名提交、支付、退款、发票和审核通过后的支付链接发送给购票人；审核通过或拒绝结果、参会认领邀请和电子票发送给参会人。审核结果消息不包含订单访问令牌、金额或发票入口。每个业务事件使用确定性投递 ID，重复消费会复用原投递记录。历史事件缺少 `recipientRole` 时，Worker 按订单购买快照处理财务通知，并只对同时缺少现代购买意图的历史订单回退参会人联系方式。

通知失败会把投递状态写为 `retrying` 并交给 BullMQ 重试。候补邀请失败不会丢失原队列记录。候补占位过期后，Worker 会标记当前邀请并调度下一位。

Worker 每六小时分批清理已过期 24 小时以上的验证码挑战、已过期或撤销 7 天以上的普通用户会话和幂等记录、已发布 24 小时以上的验证码 Outbox 事件，以及 30 天以上的终态验证码投递。每类清理有执行时间与批次数上限，避免长期事务占用数据库。用户资料、授权同意、报名、订单和发票记录继续按业务留存策略保存。

## 核销设备运行

1. 在运营后台登记设备代码和名称。
2. 立即保存响应中的明文设备令牌，该值只显示一次。
3. 设备同步时同时传 Bearer Token 和 `X-Device-Token`。
4. 每个离线批次使用全局唯一 `batchKey`，每条记录使用设备内唯一 `localId`。
5. 令牌泄露时停用旧设备记录并重新登记。

## 发布前门禁

```bash
pnpm check
pnpm test:persistent
pnpm test:operations
pnpm test:waitlist
pnpm test:checkin-load
pnpm test:visual
pnpm audit:security
node tooling/docker-compose.mjs config --quiet
pnpm docker:verify
```

视觉脚本覆盖前台首页、FAQ、报名、订单和票证，以及后台登录、管理中心入口、模板编辑、图片资源、大会配置、报名、订单、内容、现场、通知和审计等桌面与移动端场景。脚本运行结果会列出本次实际检查的完整场景清单。

HTML 原型导入默认只检查差异，不写入工作区。显式应用会先把旧文件备份到 `tmp/prototype-import-backups/`，再以临时文件完成原子替换：

```bash
node tooling/import-conference-prototype.mjs
node tooling/import-conference-prototype.mjs --output-dir /tmp/tokems-prototype-preview
node tooling/import-conference-prototype.mjs --apply
```

## 健康与观测

- API 与数据库：`GET /api/v1/health`，确认 `database.migration.ok=true`
- PostgreSQL：`pg_isready`
- Redis：`redis-cli ping`
- MinIO：`GET /minio/health/live`
- Mailpit：`GET /livez`
- Admin：`GET /healthz`
- Worker：容器健康状态、BullMQ completed、failed 和连接日志
- 本地通知接收器：`GET /health`
- Outbox：未发布时间数量、最早事件延迟和 attempts
- 交易：库存保留超时、支付签名失败、金额冲突和退款失败
- 候补：等待数、邀请占位数、过期率和领取率
- 核销：重复核销、设备鉴权失败和批次冲突

应用日志避免输出参会人正文、通知正文、支付载荷和设备令牌。集中日志系统应按 `traceId`、事件 ID、订单 ID 和 Outbox ID 建立索引。

## 故障处理

### 支付成功且未收到票

1. 按订单号检查 `orders.status` 和金额快照。
2. 检查同一 `registration_id` 的 `tickets`。
3. 检查 `TicketIssued` Outbox 的 `published_at` 和 `attempts`。
4. 检查 BullMQ 失败任务和通知投递状态。
5. 在业务事实完整时使用原 Outbox ID 重试投递。

### 候补名额未递补

1. 检查库存保留是否已标记 `released_at`。
2. 检查退款是否为全额成功。
3. 检查同票种有效邀请占位和过期时间。
4. 检查 Worker 的候补周期任务和 `NotificationRequested` Outbox。

### 现场核销异常

1. 验证设备状态和设备令牌。
2. 根据票号检查电子票状态。
3. 按 `ticket_id + checkin_list_id` 查询首次成功记录。
4. 按设备 ID、批次键和正文哈希核对离线同步。
5. 人工修复必须同步写入审计记录。

## 备份与恢复演练

PostgreSQL 生产实例应启用自动备份、时间点恢复和慢查询观测。每季度从最新备份恢复到隔离环境，执行全部迁移、关键订单抽样、票证唯一性、候补状态、设备令牌哈希和 Outbox 积压检查。恢复报告记录 RTO、RPO、数据校验结果和人工修复步骤。
