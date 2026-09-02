# TokEMS 生产推送与 Docker 发布规范

本文规定 TokEMS 从本地开发、GitHub 合并到生产服务器切换的完整流程。适用环境为宝塔面板管理的阿里云 ECS、Docker Compose 运行时和外部 Nginx 反向代理。

本文保存稳定规则。每次发布的提交、迁移、备份、异常和验证结果写入 `docs/release-records/`，不能用历史记录代替当前检查。

## 1. 固定拓扑和目录

| 项目                      | 固定值或用途                                  |
| ------------------------- | --------------------------------------------- |
| 唯一上游仓库              | `https://github.com/yaojingang/TokEMS.git`    |
| GitHub 发布分支           | `main`                                        |
| 服务器运行分支            | `production`，跟踪 `origin/main`              |
| 服务器源码与 Compose 目录 | `/www/wwwroot/TokEMS`                         |
| 宝塔站点与反向代理目录    | `/www/dk_project/wwwroot/hui.ailingdaoli.com` |
| 生产备份根目录            | `/www/backup/TokEMS`                          |
| 生产环境文件              | `/etc/tokems/production.env`                  |
| Compose 项目名            | `tokems`                                      |
| Gateway 宿主机入口        | `127.0.0.1:8088`                              |
| 大会前台                  | `https://hui.ailingdaoli.com/`                |
| 运营后台                  | `https://admin.hui.ailingdaoli.com/admin/`    |
| 支付页面                  | `https://www.ailingdaoli.com/pay/hui/`        |
| 健康接口                  | `https://hui.ailingdaoli.com/api/v1/health`   |
| 版本接口                  | `https://hui.ailingdaoli.com/version.json`    |

`/www/wwwroot/TokEMS` 保存 Git 源码和 `docker-compose.yml`，所有迁移、构建和容器操作都从这里执行。生产环境文件独立保存在 `/etc/tokems/production.env`，仅允许 root 读取和原子更新。

`/www/dk_project/wwwroot/hui.ailingdaoli.com` 属于宝塔和外部 Nginx 层。该目录不承载 TokEMS 源码，也不进入应用容器。修改其中的 Nginx 配置时，先运行 `nginx -t`，测试通过后再重载。

## 2. Docker 构建和运行特点

TokEMS 使用根目录多阶段 `Dockerfile` 构建以下应用镜像：

| 镜像                             | 运行服务             | 说明                                              |
| -------------------------------- | -------------------- | ------------------------------------------------- |
| `tokems-api:local`               | `api`、`db-init`     | API 和一次性数据库迁移任务共用镜像                |
| `tokems-worker:local`            | `worker`             | BullMQ 异步任务和通知处理                         |
| `tokems-web:local`               | `web`、`payment-web` | 大会前台和支付前台共用镜像，运行时 base path 不同 |
| `tokems-admin:local`             | `admin`              | Nginx 承载的后台静态产物                          |
| `tokems-gateway:local`           | `gateway`            | 按域名和路径代理 API、Web、Admin、支付页面        |
| `tokems-notification-sink:local` | `notification-sink`  | 当前 Compose 中的通知接收服务                     |

长期基础服务包括 PostgreSQL、Redis、MinIO 和 Mailpit。一次性任务 `db-init`、`minio-init` 正常结束状态为 `Exited (0)`。

标准生产镜像由 `.github/workflows/publish-images.yml` 在官方 `main push` 的 `tokems-ci` 成功完成后构建，统一写入私有包 `ghcr.io/yaojingang/tokems-production`。历史公开包 `ghcr.io/yaojingang/tokems` 不得用于生产发布。六个服务镜像全部完成并生成 GitHub provenance 后，工作流最后发布 `release-<SHA>` descriptor。schema 2 descriptor 固定四项构建身份、生产平台、六个 digest，以及目标提交的完整 Git Bundle 和 verifier SHA-256，是完整可部署版本的唯一标志。生产机通过 GitHub API 核对 `main`、PR 和 CI，通过 GHCR 获取并证明源码与镜像；标准路径不要求生产机直连 `github.com` Git Smart HTTP。

持久数据卷为：

- `tokems-postgres`
- `tokems-redis`
- `tokems-minio`

常规发布禁止删除这些卷。应用容器默认使用只读根文件系统、受限 tmpfs、`no-new-privileges`、全部 capability drop 和轮转 JSON 日志。Gateway 只绑定回环地址，由宿主机 Nginx 提供公网 80/443 和 TLS。

## 3. 三种发布动作

| 动作         | 结果                                                               | 何时使用                                           |
| ------------ | ------------------------------------------------------------------ | -------------------------------------------------- |
| 源码推送     | 校验本地规范大会快照后，本地分支通过 PR 合并到 GitHub `main`       | 所有代码、文档、规范快照、模板种子和迁移变更       |
| 应用发布     | Actions 构建镜像；服务器拉取 digest，迁移并切换容器                | GitHub 主分支需要进入生产运行时                    |
| 规范模板同步 | 把仓库中的 `geo-conference`、`tokems26` 规范模板幂等写入生产数据库 | 仓库模板、前台文案、大会设置或规范发布快照发生变化 |

代码变更进入 `main` 后不会自动出现在当前服务器。当前阶段使用仓库内 `tooling/production-deploy.sh` 作为服务器单命令发布入口；GitHub Actions 负责镜像构建和证明。带 Production Environment 审批的 SSH 自动部署会在三个不同 SHA 的预构建生产发布成功后进入独立 PR。

后台直接修改默认大会时，保存操作会生成新的不可变发布快照并切换公开版本。修改完成后必须运行 `pnpm canonical:export` 回写仓库规范快照；最迟在下一次 GitHub 推送前完成。生产后台发生独立修改时，先同步回本地规范大会并确认公开页面，再更新仓库快照。

## 4. 强制发布规则

1. **唯一来源**：生产只使用 `yaojingang/TokEMS` 的 `origin/main`。`majin72/TokEMS` 仅保留为历史 fork，不再接收生产推送。
2. **PR 先行**：功能分支使用 `codex/*` 或项目约定的功能分支，经 PR、评审和 CI 后合并。服务器禁止直接部署未合并提交。
3. **干净构建**：Actions 和人工应急构建都只能读取精确目标提交。生产发布前 Git 工作区必须干净，源码导入后再次核对 `HEAD` 和工作区。
4. **一个发布进程**：服务器同一时间只运行一个拉取、构建、迁移或切换任务。
5. **先备份再写入**：数据库迁移、规范模板同步和容器切换前，必须创建可读取的数据库备份并记录回滚镜像。
6. **四项构建身份完整**：`BUILD_SHA`、`BUILD_TIME`、`BUILD_MIGRATION`、`BUILD_MIGRATION_HASH` 必须在构建和运行阶段保持一致，任何值都不能为 `unknown`。
7. **常规发布不写种子**：默认保持 `SEED_DEMO_DATA=false`。规范模板同步需单独确认并执行专用步骤。
8. **生产业务数据保留**：报名、订单、票、发票、用户、库存销量和配额销量不得随模板同步清空或重置。
9. **迁移先于应用**：先运行 `db-init` 并确认成功，再重建 API、Worker、Web、Admin 和 Gateway。
10. **优先应用回滚**：当前迁移采用增量兼容策略，故障时优先回滚镜像和环境。数据库覆盖恢复只用于明确的数据损坏或已批准的整库回退。
11. **安全输出**：终端和发布记录只输出允许公开的环境键。禁止打印 `.env` 全文、连接串、密码、私钥、Cookie 或第三方令牌。
12. **逐层验证**：发布结论需要同时满足 GitHub、容器、数据库、本机 HTTP、公网 HTTP 和版本身份六层验证。
13. **规范快照随推送**：`pnpm install` 会启用仓库内的 `pre-push` 门禁，每次 GitHub 推送自动运行 `pnpm canonical:check`。默认大会或后台设置有变化时先运行 `pnpm canonical:export`。检查失败时禁止推送。
14. **快照严格脱敏**：规范快照只包含模板及可复用后台设置。管理员身份、凭据、API/第三方集成配置、个人数据、交易数据、销量和审计记录不得进入 Git。
15. **原子源码与镜像集合**：`release-<SHA>` descriptor 在完整 Git Bundle、verifier、六个服务镜像与构建证明全部完成后发布。同一 SHA 的有效 descriptor 只允许复用，禁止覆盖。服务器导入 Bundle 前必须核对 provenance、payload SHA-256、固定 ref 和目标 SHA；仅允许 Fast-forward 更新 `origin/main`。
16. **私有 registry 最小权限**：生产机只使用 `/etc/tokems/ghcr-read-token` 中的 `read:packages` PAT classic。登录配置只存在于 root-only `/run` 临时目录。

## 5. 发布类型判断

| 变更范围                             | 数据库备份 | `db-init` | `SEED_DEMO_DATA=true` | 额外检查                 |
| ------------------------------------ | ---------- | --------- | --------------------- | ------------------------ |
| 代码或依赖                           | 必须       | 必须      | 否                    | 全服务构建、版本一致性   |
| 新增数据库迁移                       | 必须       | 必须      | 否                    | 迁移文件名和 SHA-256     |
| 仓库规范模板、前台文案或大会默认设置 | 必须       | 必须      | 经确认后临时使用      | 业务计数、票种和配额销量 |
| 后台编辑当前大会内容                 | 按业务风险 | 无需      | 否                    | 新发布快照、公开页面     |
| Nginx 或域名代理                     | 配置备份   | 无需      | 否                    | `nginx -t`、域名和 TLS   |

## 6. 本地推送到 GitHub

### 6.1 发布前检查

在本地项目目录执行：

```bash
git status --short --branch -uall
git fetch origin --prune
git remote -v
git diff --check
pnpm check
pnpm audit:security
pnpm canonical:check
```

如果本地默认大会或关联后台设置发生过变化，先生成仓库规范快照，再执行完整检查：

```bash
pnpm canonical:export
git diff -- packages/contracts/src/canonical-homepage.snapshot.json packages/contracts/src/canonical-homepage.public.json
pnpm canonical:check
pnpm check
```

`canonical:export` 只接受回环地址数据库，并同时核对 `http://127.0.0.1:8088/api/v1/homepage`。一次性挑战证明会确认首页 API 与直连地址使用同一个 PostgreSQL 运行实例。生成结果会固定运行态指标为零，剔除销量、用户、交易、管理员身份和所有凭据。完整快照仅供服务端规范同步；前台只消费派生快照，后台通知、AI 提示及素材二进制不会进入浏览器包。单个素材上限 8 MiB，总素材上限 16 MiB，完整 JSON 上限 24 MiB。导出期间会对规范配置表持有共享锁，连续读取两次并要求结果一致，同时核对公开页面的大会内容、模板版本、票种、嘉宾、议程和报名表投影。所有被纳入模板定义引用的 HTML 文档及关联素材都会随快照同步。`canonical:check` 会重新读取本地首页与后台状态；内容与任一已提交快照不一致时返回失败。

仓库的 `pre-push` 门禁还会读取 Git 提供的待推送 ref/SHA，要求受保护的规范文件在工作区和暂存区保持干净，并确认每个实际待推送提交包含刚刚校验过的快照、导出器、同步器和 API 实例证明逻辑。推送其他分支或标签时同样执行此规则。

涉及支付、通知、报名、订单、发票、票务、数据库迁移或权限时，还要运行对应专项验收。涉及前台和后台界面时运行视觉验收。

### 6.2 PR 和合并

```bash
git push -u origin <feature-branch>
gh pr create --base main --head <feature-branch>
gh pr checks <pr-number> --watch
```

合并前确认：

- PR 内容只包含本轮目标文件。
- `pnpm canonical:check` 成功，规范快照与本地默认大会及后台设置一致。
- 规范快照中没有管理员身份、API/第三方凭据、个人数据、交易数据、销量或审计记录。
- 所有必需检查成功。
- 没有未解决的高风险评审意见。
- 新迁移、生成文件、文档和测试全部纳入提交。
- `origin/main` 没有尚未处理的冲突或更新。

合并后记录目标提交：

```bash
git fetch origin main
git rev-parse origin/main
gh run list --repo yaojingang/TokEMS --branch main --limit 5
```

首次启用镜像工作流前，先从生产机执行 `uname -m`。`x86_64` 对应仓库变量 `PRODUCTION_PLATFORM=linux/amd64`，`aarch64` 或 `arm64` 对应 `linux/arm64`。该变量缺失或超出允许值时，`tokems-image-publish` 会在构建前失败。GHCR 包保持 Private；仓库 Actions 只拥有当前工作流需要的 `contents: read`、`packages: write`、`id-token: write` 和 `attestations: write`。

恢复 SSH 后连续执行三轮只读网络与鉴权探测，记录时间和结果：访问 `https://ghcr.io/v2/`、通过临时 Docker 配置执行 GHCR 登录、读取已发布 descriptor 或最小测试镜像的 manifest。三轮都失败时，在合并本方案前把相同 descriptor 接口切换到阿里云 ACR。一次生产发布固定使用一个 registry。

## 7. 服务器标准发布流程

以下命令以生产目录和当前 `ecs-user` Git 所有权为准。执行过程中出现非预期输出时停止发布，先定位当前层级。

### 服务器单命令入口

部署脚本在 GitHub 仓库中的固定位置是 `tooling/production-deploy.sh`。成功发布后，对应服务器文件为 `/www/wwwroot/TokEMS/tooling/production-deploy.sh`。`/www/dk_project/wwwroot/hui.ailingdaoli.com` 只保存站点和反向代理配置，不放置部署脚本、源码或构建产物。

首次安装时不要把脚本直接复制到 `/www/wwwroot/TokEMS/tooling/`。服务器 `production` 仍停留在旧提交时，这样会产生未跟踪文件，Git 清洁门禁会拒绝继续。使用下面的 SCP 固定引导流程，从本地已经合并且 CI 成功的 `origin/main` 导出精确目标脚本。

需要通过 SCP 上传时，先在本地从已合并的 `origin/main` 导出脚本，再上传到服务器 `/tmp`。将 `<生产服务器>` 替换为实际 SSH 主机：

```bash
cd /path/to/TokEMS
git fetch origin main
target_sha="$(git rev-parse origin/main)"
git show "${target_sha}:tooling/production-deploy.sh" > /tmp/tokems-production-deploy.sh
shasum -a 256 /tmp/tokems-production-deploy.sh
scp /tmp/tokems-production-deploy.sh ecs-user@<生产服务器>:/tmp/tokems-production-deploy.sh
```

登录服务器后核对 SHA-256，把临时文件安装成 root 持有的稳定入口。服务器输出应与本地校验值完全一致：

```bash
sha256sum /tmp/tokems-production-deploy.sh
sudo install -o root -g root -m 0755 \
  /tmp/tokems-production-deploy.sh /usr/local/sbin/tokems-deploy
sudo /usr/local/sbin/tokems-deploy --help
```

`/usr/local/sbin/tokems-deploy` 每次启动都会从 GitHub API 解析最新 `main`，复核合并 PR、官方 main push CI、`quality-and-flows` 与镜像发布工作流，再从经过证明的 GHCR descriptor 导入目标 Git Bundle 并读取目标脚本。日常发布也使用这个 root 所有的入口，避免 root 直接执行由 `ecs-user` 管理的工作区文件。首次基线依次执行以下命令，每一步成功后再继续：

```bash
sudo install -d -o root -g root -m 0700 /etc/tokems
sudo install -o root -g root -m 0600 \
  /www/wwwroot/TokEMS/.env /etc/tokems/production.env
# 在本机安全准备只含 read:packages 的 PAT 文件后安装；不要把 Token 写入命令行或日志。
sudo install -o root -g root -m 0600 \
  /tmp/tokems-ghcr-read-token /etc/tokems/ghcr-read-token
sudo /usr/local/sbin/tokems-deploy repair-identity --target-sha <origin-main-full-sha>
sudo /usr/local/sbin/tokems-deploy check --target-sha <origin-main-full-sha>
sudo /usr/local/sbin/tokems-deploy deploy --target-sha <origin-main-full-sha>
```

`/etc/tokems` 必须保持 `root:root 0700`，`production.env` 与 `ghcr-read-token` 必须保持 `root:root 0600`。脚本取得发布锁后立即创建 root-only 会话快照，后续 Compose 只读取受保护快照；发布成功或身份修复成功后再原子写回 `/etc/tokems/production.env`。GHCR 登录通过 `password-stdin` 完成，临时 Docker 配置在退出路径清除。不要把生产环境文件或 Token 上传到 GitHub，也不要在终端输出其内容。确认新入口连续完成 `repair-identity`、`check` 和一次正式 `deploy` 后，可按既有凭据销毁流程处理工作区旧 `.env`。

4 核 8G 生产主机的标准 `check` 和 `deploy` 使用预构建镜像，不执行 Docker 构建，也不应用 10 GiB 构建内存门禁。Docker 磁盘、备份容量、数据库和数据保护门禁保持启用。人工应急构建使用 `--build-on-host`，资源不足时会在备份、迁移和容器切换前停止。目标规范快照与当前运行提交完全一致，且目标差异仅包含部署控制与文档时，可显式执行 `check --sync-canonical` 和 `deploy --sync-canonical`；脚本复用当前已验证镜像，并继续执行备份、写冻结、规范同步、生产数据保护和完整验收。

服务器已经首次安装 root 所有的稳定入口后，日常发布使用以下两个命令：

```bash
sudo /usr/local/sbin/tokems-deploy check
sudo /usr/local/sbin/tokems-deploy deploy
```

`repair-identity` 是一次性、可审计的基线修复入口。它会同时读取 Gateway、Web、Admin、API、Worker 和数据库迁移身份，确认代码提交、构建时间和数据库健康一致后，先备份 `.env`，再只更新四项 `BUILD_*` 和兼容回滚标记，不重启容器：

```bash
sudo /usr/local/sbin/tokems-deploy repair-identity
```

出现 `/www/backup/TokEMS/RECOVERY_REQUIRED` 时，常规 `check` 和 `deploy` 会停止。已合并前向修复时运行：

```bash
sudo /usr/local/sbin/tokems-deploy deploy --resume-recovery
```

标记中的 `phase=pre-write` 表示中断发生在数据库操作前。这个阶段使用发布前回滚镜像和 `.env` 自动恢复应用，不执行数据库恢复：

```bash
sudo /usr/local/sbin/tokems-deploy recover-interrupted
```

每个恢复标记都固定协议版本、目标提交、目标镜像标签，并引用发布目录中 root-only 的精确恢复脚本及 SHA-256。`recover-interrupted` 可以在 GitHub 或外网不可用时从本机备份恢复；稳定入口会先校验并转交给该次发布保存的脚本。`write-freeze` 阶段恢复会等待遗留的 `db-init` 容器结束，验证当前迁移哈希属于备份基线到目标之间的有序链，再选择回滚镜像或目标镜像继续。

人工恢复已经独立完成时，让脚本验证正常 API 写权限、标准 Worker 启动命令与持久 ready 身份，并把当前生产主键、计数、销量及首页投影重新对照恢复基线；全部通过后才归档恢复标记：

```bash
sudo /usr/local/sbin/tokems-deploy resolve-recovery
```

2026-08-24 的失败发布记录明确指出：线上容器已经回到 `01c7b490bb690e4e12695dba2996f7d2864566f4` / `0053_mute_vulcan.sql`，服务器 `.env` 仍留有失败目标的构建身份。首次使用本脚本时先执行 `repair-identity`，再执行 `check` 和 `deploy`。修复证据保存到 `/www/backup/TokEMS/identity-repair-<时间戳>`。

`check` 检查当前运行版本、Git 工作区、官方远端、`production → origin/main`、GitHub 合并 PR、`quality-and-flows`、`tokems-image-publish`、descriptor、源码 Bundle 与服务镜像 provenance、Compose、Nginx、容器、镜像标签、生产环境固定项、平台和磁盘。它可能把经过证明的 Bundle 对象导入 `.git` 并 Fast-forward 远端跟踪 ref，不更新工作树、环境文件、运行容器或数据库。`--build-on-host` 额外检查构建内存。`deploy` 在相同门禁通过后自动完成以下流程：

1. 验证 descriptor provenance、Git Bundle 与 verifier SHA-256，确认 Bundle 只公开固定 ref 的精确目标 SHA，且服务器当前 `origin/main`、`production` 都是其祖先；随后 Fast-forward 远端跟踪 ref，工作树保持不变。
2. 创建构建开始时的 PostgreSQL custom dump、生产数据证据、旧 `.env`、旧 Compose 配置、运行状态证据和目标提交的 root-only 源码快照，并给六个当前应用镜像添加 `rollback-<时间戳>` 标签。
3. Fast-forward 服务器 `production` 到已验证目标，按 descriptor digest 拉取六个镜像，逐个校验平台、服务标签、四项构建身份和源码迁移哈希。全部候选验证成功后写入 descriptor 的四项 `BUILD_*`，再成组更新本机发布标签；中途失败由既有 rollback handler 恢复整组旧标签。`--build-on-host` 应急路径继续使用 root-only 构建上下文和 `COMPOSE_PARALLEL_LIMIT=1` 串行构建。
4. 所有发布在数据库写入前先把 API/Worker 的 Docker 重启策略持久改为 `no`，启动持续重试的写阻断 guard，再落盘 `RECOVERY_REQUIRED` 并停止写服务。随后重新生成最终 PostgreSQL dump、生产主键、计数与销量基线，再以 `SEED_DEMO_DATA=false` 执行迁移；规范快照变化时继续执行受保护的 `geo-conference` / `tokems26` 同步。稳定业务表按主键索引流式取证，带自动保留期的数据在 Worker 暂停的阶段单独比对。
5. 使用 `--no-build --no-deps --force-recreate --wait` 切换应用容器，不协调 PostgreSQL、Redis、MinIO 等基础设施。验收阶段以数据库只读模式启动 API，并暂停 Worker 任务。
6. 在写冻结窗口验证容器、迁移、五类构建身份、本机与公网 HTTP、公开首页投影，以及从生产数据库重新导出的脱敏完整规范大会与后台设置；冻结期生产主键集合、计数和票种/配额销量必须精确一致。验证通过后以 `restart: no` 和正常数据库权限重建 API/Worker。Worker 的两类 BullMQ 消费者都完成 Redis ready 后才写入包含 SHA、构建时间和迁移身份的 `/tmp/tokems-worker-ready.json`；脚本核对并观察稳定后恢复 `unless-stopped`，再检查健康、数据库实例和允许正常新增的生产数据。
7. 失败时先停止 API/Worker，再读取数据库迁移证据并恢复发布前镜像标签与 `.env`。迁移证据不可读取时，旧镜像和环境已经恢复，API/Worker 保持停止，`RECOVERY_REQUIRED` 继续阻止下一次普通发布。数据库 dump 始终保留，脚本不会自动覆盖恢复数据库。

脚本会先通过 GitHub API 验证最新 `main` 对应的合并 PR、CI 和镜像发布工作流，再从 descriptor digest 读取目标源码与最新版部署脚本。服务器首次启用使用本节前面的 SCP 固定引导流程：本地只从已合并的 `origin/main` 导出脚本，核对 SHA-256 后安装到 `/usr/local/sbin/tokems-deploy`。这一步不要求生产机连接 `github.com` Git Smart HTTP；安装后的稳定入口负责完成其余外部证明和 Bundle 导入。

默认模板策略为自动判断。两个规范快照相对当前线上提交发生变化时，脚本强制同步规范模板；快照未变化时，预检仍会使用只读数据库连接导出线上完整规范状态，并与目标快照逐项比较，发现存量漂移后自动触发同步。`--sync-canonical` 可主动重跑幂等同步；`--skip-canonical` 仅在 Git 快照未变化且线上完整规范状态已经匹配时通过。常规发布的 `SEED_DEMO_DATA` 始终为 `false`；规范同步阶段才会向一次性 `db-init` 进程临时传入 `SEED_DEMO_DATA=true`。

当线上运行镜像已经包含目标规范快照，且运行提交到目标提交之间的差异仅限 `AGENTS.md`、`docs/`、生产部署脚本及其测试时，自动检测到的规范漂移或显式 `--sync-canonical` 会进入规范修复流程。该流程先复核合并 PR、CI、运行身份、数据库实例和规范目标，再创建两轮数据库备份与镜像回滚标签、Fast-forward 服务器源码、冻结 API/Worker 写入、运行幂等规范同步，并在恢复写入前后核对公开首页、完整后台规范快照、业务主键、计数和销量。当前镜像和数据库迁移身份保持不变，因此无需镜像构建资源。任一运行相关文件或规范快照发生变化时，脚本回到标准预构建镜像流程。

指定目标提交时使用完整 SHA。低内存服务器先运行只读预检，再执行同步：

```bash
sudo /usr/local/sbin/tokems-deploy check \
  --target-sha <origin-main-full-sha> \
  --sync-canonical
sudo /usr/local/sbin/tokems-deploy deploy \
  --target-sha <origin-main-full-sha> \
  --sync-canonical
```

生产主机曾在 Docker BuildKit 构建期间发生 OOM 并导致同机服务中断。标准发布从 GHCR 拉取固定镜像摘要。`--build-on-host` 应急构建要求 `MemAvailable + SwapFree` 至少 10 GiB，并要求源码文件系统和 Docker 实际 `DockerRootDir` 各有至少 12 GiB 可用空间。受保护的规范修复流程跳过构建资源门禁，备份与验收容量门禁保持启用。备份文件系统的初始门禁按四倍当前数据库体积加至少 4 GiB 计算；构建开始的稳定主键与保留期主键证据生成后，后续门禁使用这些文件的实测大小预算最终 dump、只读验收和 post-thaw 证据。预检从 `/www/backup/TokEMS` 的最深现存父目录读取设备号，创建发布目录后再次核对同一设备，每个大文件阶段前直接检查该发布目录。任一适用资源不足时会在备份、迁移和容器变更前停止。

标准单命令发布拒绝 `docker-compose.yml` 变化。数据库、缓存、对象存储、卷、端口和服务拓扑变更进入单独评审的基础设施维护窗口。

每次标准发布都有短暂写冻结窗口：六个候选镜像拉取并验证完成后停止 API 和 Worker，持久化恢复标记，在静止写入状态重新生成最终数据库备份与业务基线，再执行迁移和可选的规范同步。语义验收期间 API 仅允许数据库读取，Worker 暂停消费。只读验收阶段公开浏览恢复；报名、支付回调、后台保存及异步任务会在窗口内失败或重试。脚本在恢复正常 API/Worker、核对持久 ready 身份和数据复验后归档恢复标记并记录成功。选择业务低峰执行，并确认支付渠道具备回调重试。

数据库实例证明、查询、dump 和迁移都设置了进程级超时；连接串指向不可达地址或数据库停止响应时，脚本会失败退出并进入受控恢复。脚本保留全部备份和回滚镜像，不会自动清理历史文件。运维侧应按已验证的恢复演练和容量预算另行制定保留周期，删除前确认目标发布已过观察期且仍有可用备份。

下面各节保留为脚本实现依据和人工审计清单。标准发布固定使用单命令脚本；故障处置中的手工命令需要负责人审批并逐项记录结果。

### 7.1 只读预检

```bash
cd /www/wwwroot/TokEMS || exit 1

sudo -u ecs-user git status --short --branch -uall
sudo -u ecs-user git rev-parse HEAD
sudo -u ecs-user git branch --show-current
sudo -u ecs-user git remote -v

docker --version
docker compose version
docker buildx version
gh --version
gh attestation verify --help >/dev/null
docker compose config --quiet
docker compose ps
nginx -t
docker info --format '{{.DockerRootDir}}'
df -h / /www/backup "$(docker info --format '{{.DockerRootDir}}')"
free -h
uname -m
sudo stat -c '%U:%G %a %n' /etc/tokems/ghcr-read-token
```

允许继续发布的条件：

- Git 工作区干净。
- 当前分支为 `production`。
- `origin` 指向官方仓库。
- Compose 配置和 Nginx 配置通过。
- 生产平台与仓库变量 `PRODUCTION_PLATFORM` 一致，值为 `linux/amd64` 或 `linux/arm64`。
- 预构建模式的磁盘、备份容量、Docker、Buildx、GitHub CLI 和 GHCR 只读凭据满足要求。
- `api.github.com` 与 `ghcr.io` 可访问；`github.com` Git Smart HTTP 不属于标准发布依赖。
- `--build-on-host` 应急模式额外满足 10 GiB 内存与构建磁盘门禁。
- 没有其他构建或发布进程。

### 7.2 创建备份和镜像回滚点

```bash
cd /www/wwwroot/TokEMS || exit 1

release_stamp=$(date +%Y%m%d-%H%M%S)
backup_dir="/www/backup/TokEMS/$release_stamp"
rollback_tag="rollback-$release_stamp"

install -d -m 700 "$backup_dir"
cp -a .env "$backup_dir/.env"
chmod 600 "$backup_dir/.env"
cp -a docker-compose.yml "$backup_dir/docker-compose.yml"

sudo -u ecs-user git rev-parse HEAD > "$backup_dir/source-commit.txt"
docker compose ps > "$backup_dir/compose-ps.txt"
curl -fsS http://127.0.0.1:8088/version.json > "$backup_dir/version-before.json"
curl -fsS http://127.0.0.1:8088/api/v1/health > "$backup_dir/health-before.json"

docker compose exec -T postgres sh -lc \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl' \
  > "$backup_dir/conference-build-start.dump"

docker compose exec -T postgres pg_restore --list \
  < "$backup_dir/conference-build-start.dump" \
  > "$backup_dir/conference-build-start.dump.list"

docker compose exec -T postgres sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "," -c "select id,sold from ticket_types order by id"' \
  > "$backup_dir/ticket-types-sold-build-start.csv"

docker compose exec -T postgres sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "," -c "select id,sold from ticket_quotas order by id"' \
  > "$backup_dir/ticket-quotas-sold-build-start.csv"

test -s "$backup_dir/conference-build-start.dump"
test -s "$backup_dir/conference-build-start.dump.list"
sha256sum "$backup_dir/conference-build-start.dump" > "$backup_dir/conference-build-start.dump.sha256"
printf '%s\n' "$backup_dir" > /www/backup/TokEMS/LATEST
chmod 600 /www/backup/TokEMS/LATEST

for image in \
  tokems-api \
  tokems-admin \
  tokems-web \
  tokems-worker \
  tokems-gateway \
  tokems-notification-sink
do
  docker image inspect "$image:local" >/dev/null
  docker tag "$image:local" "$image:$rollback_tag"
done

docker image inspect \
  tokems-api:"$rollback_tag" \
  tokems-admin:"$rollback_tag" \
  tokems-web:"$rollback_tag" \
  tokems-worker:"$rollback_tag" \
  tokems-gateway:"$rollback_tag" \
  tokems-notification-sink:"$rollback_tag" \
  > "$backup_dir/images-before.json"
```

如果发布涉及 MinIO 配置、模板图片或发票文件存储，增加 MinIO 卷快照或对象存储备份，并把备份标识写入本次发布记录。Redis 卷不随发布删除。

### 7.3 Fast-forward 到已验证源码

标准入口已经通过 descriptor provenance 和源码 Bundle 更新 `origin/main`。手工等价操作只允许把 `production` Fast-forward 到同一个已批准 SHA；这一阶段不再访问远端 Git Smart HTTP。

```bash
cd /www/wwwroot/TokEMS || exit 1

test -z "$(sudo -u ecs-user git status --porcelain --untracked-files=all)"
sudo -u ecs-user git switch production
approved_sha=<origin-main-full-sha>
origin_sha="$(sudo -u ecs-user git rev-parse origin/main)"
test "$approved_sha" = "$origin_sha"
sudo -u ecs-user git merge-base --is-ancestor HEAD "$approved_sha"
sudo -u ecs-user git merge --ff-only "$approved_sha"
test "$(sudo -u ecs-user git rev-parse HEAD)" = "$approved_sha"
```

禁止使用 `git reset --hard` 或删除服务器工作区来解决分支分歧。出现分歧时停止发布，查明服务器提交来源。

### 7.4 验证并持久化构建身份

标准发布从 `release-<SHA>` descriptor 读取 `BUILD_SHA`、`BUILD_TIME`、`BUILD_MIGRATION`、`BUILD_MIGRATION_HASH`。脚本验证 descriptor 与六个服务镜像的 source、revision、service、platform 和 GitHub provenance，并把迁移名称与目标提交中的迁移文件 SHA-256 对照。四项值随后写入 root-only 发布环境快照；生产机不会重新生成构建时间。

以下手工生成方式只用于显式 `--build-on-host` 应急路径。

生产服务器当前没有 Node.js 和 pnpm，不能直接运行 `pnpm docker:deploy`。手工 Compose 发布需要显式生成与持久化四项构建身份：

```bash
cd /www/wwwroot/TokEMS || exit 1

backup_dir=$(cat /www/backup/TokEMS/LATEST)
case "$backup_dir" in
  /www/backup/TokEMS/*) ;;
  *) exit 1 ;;
esac
test -s "$backup_dir/.env"

BUILD_SHA=$(sudo -u ecs-user git rev-parse HEAD)
BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BUILD_MIGRATION=$(
  find packages/database/drizzle -maxdepth 1 -type f \
    -name '[0-9][0-9][0-9][0-9]_*.sql' -printf '%f\n' \
  | sort \
  | tail -n 1
)
BUILD_MIGRATION_HASH=$(sha256sum "packages/database/drizzle/$BUILD_MIGRATION" | awk '{print $1}')

test -n "$BUILD_SHA"
test -n "$BUILD_TIME"
test -n "$BUILD_MIGRATION"
test -n "$BUILD_MIGRATION_HASH"

set_env() {
  key="$1"
  value="$2"
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*$|${key}=${value}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

set_env BUILD_SHA "$BUILD_SHA"
set_env BUILD_TIME "$BUILD_TIME"
set_env BUILD_MIGRATION "$BUILD_MIGRATION"
set_env BUILD_MIGRATION_HASH "$BUILD_MIGRATION_HASH"

chown --reference="$backup_dir/.env" .env
chmod --reference="$backup_dir/.env" .env

export BUILD_SHA BUILD_TIME BUILD_MIGRATION BUILD_MIGRATION_HASH
docker compose config --quiet
```

构建变量要在镜像构建前写入 `.env`。同一文件也供后续 `docker compose up` 使用，避免新终端丢失 Shell 临时变量。

### 7.5 拉取预构建镜像

标准发布按 descriptor 中的 digest 拉取 API、Worker、Web、Admin、Gateway 与 notification-sink。六个候选镜像全部完成本地标签与架构复核前，脚本不会改变任何 `tokems-*:local` 标签。候选集合完整后，脚本为当前镜像保留 `rollback-<时间戳>`，再更新 `:local` 和本次 `release-<时间戳>` 标签。拉取或验证失败会留下下载缓存与审计文件，运行容器和发布标签保持原状。

`--build-on-host` 应急路径使用以下串行构建等价步骤：

```bash
cd /www/wwwroot/TokEMS || exit 1

before_build_sha=$(sudo -u ecs-user git rev-parse HEAD)

docker compose build \
  notification-sink api worker web admin gateway

after_build_sha=$(sudo -u ecs-user git rev-parse HEAD)
test "$before_build_sha" = "$after_build_sha"
test -z "$(sudo -u ecs-user git status --porcelain --untracked-files=all)"
```

`payment-web` 使用 `tokems-web:local`，无需单独构建镜像。

### 7.6 写冻结、最终备份与迁移

镜像构建完成后，所有发布都要停止 API 和 Worker 写入，并在静止写入状态重新生成最终备份、业务主键、计数和销量基线。仓库脚本会自动生成 `business-counts-before.csv`、`protected-business-ids-before.csv`、`ticket-types-sold-before.csv` 和 `ticket-quotas-sold-before.csv`。完整主键导出与失败恢复由脚本统一处理。

以下片段展示最终 dump 与迁移的关键顺序，供审计发布日志：

```bash
cd /www/wwwroot/TokEMS || exit 1
backup_dir=$(cat /www/backup/TokEMS/LATEST)
docker compose stop --timeout 30 api worker
docker compose exec -T postgres sh -lc \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl' \
  > "$backup_dir/conference.dump"
docker compose exec -T postgres pg_restore --list \
  < "$backup_dir/conference.dump" \
  > "$backup_dir/conference.dump.list"
test -s "$backup_dir/conference.dump"
test -s "$backup_dir/conference.dump.list"
sha256sum "$backup_dir/conference.dump" > "$backup_dir/conference.dump.sha256"
SEED_DEMO_DATA=false docker compose run --rm --no-deps db-init
```

Docker Compose v2.27 的 `docker compose run` 不支持 `--no-build`。此处不要添加该参数。

### 7.7 同步规范模板

只有发布范围包含仓库规范快照、前台文案或大会默认设置，并且已完成数据库备份与数据保护检查时执行本节。生产同步读取 `packages/contracts/src/canonical-homepage.snapshot.json`，同时恢复当前公开发布内容和脱敏后的关联后台标准设置。同步按可串行化事务执行；同版本的模板、报名表或大会发布内容若与生产现存记录不同会立即中止，避免改写历史。快照外票种会停用，通知与 AI 提示会归档，嘉宾、公开短地址和议程会按规范清单协调；已有销量的票额与已有核销记录的核销清单作为生产事实保留。

先确认当前目标：

- 组织 slug 为 `geo-conference`。
- 大会 slug 为 `tokems26`。
- 票种和配额使用稳定 ID。
- 报名、订单、票、发票和用户记录继续保留。
- `ticket-types-sold-before.csv` 与 `ticket-quotas-sold-before.csv` 已在写冻结后生成且格式有效。

新终端需要先恢复并校验备份目录变量：

```bash
backup_dir=$(cat /www/backup/TokEMS/LATEST)
case "$backup_dir" in
  /www/backup/TokEMS/*) ;;
  *) exit 1 ;;
esac
test -s "$backup_dir/conference.dump"
test -s "$backup_dir/ticket-types-sold-before.csv"
test -s "$backup_dir/ticket-quotas-sold-before.csv"
```

执行幂等模板同步：

```bash
cd /www/wwwroot/TokEMS || exit 1
SEED_DEMO_DATA=true docker compose run --rm db-init
```

核对同步前后的生产销量计数。种子同步在事务中保留实时 `sold`，并验证票种容量不低于已售、有效占用和候补邀请总量；配额容量不低于已售数量。任一容量下限不满足时同步整体中止。

```bash
docker compose exec -T postgres sh -lc \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select id,capacity,sold from ticket_types order by id; select id,capacity,sold from ticket_quotas order by id;"'
```

将查询结果与备份 CSV 对照，当前数量可以因备份后新增交易而上升，禁止用备份 CSV 回写销量。执行后立即检查报名、订单、票种、销量和配额。若规范模板变更会删除已有交易引用的票种或改变既有交易关系，应停止使用种子同步，改用经过评审的数据迁移或后台发布流程。

`.env` 中的 `SEED_DEMO_DATA` 保持 `false`。命令行临时值只用于本次同步。

### 7.8 切换应用容器

```bash
cd /www/wwwroot/TokEMS || exit 1

docker compose up -d \
  --no-build \
  --force-recreate \
  --wait \
  --wait-timeout 300 \
  notification-sink api worker web payment-web admin gateway
```

任何容器未达到 healthy 时停止后续变更，保存日志和 inspect 结果，再进入诊断或回滚。

## 8. 发布验证

### 8.1 容器和数据库

```bash
cd /www/wwwroot/TokEMS || exit 1

docker compose ps
docker compose logs --no-color --tail=200 api worker db-init gateway

docker compose exec -T postgres sh -lc '
psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off \
  -c "select id, slug, name from organizations order by id;" \
  -c "select id, organization_id, slug, name, status from events order by id;" \
  -c "select event_id, name, capacity, sold from ticket_types order by event_id, id;" \
  -c "select count(*) as registrations from registrations;" \
  -c "select count(*) as orders from orders;"
'
```

### 8.2 服务器本机 HTTP

```bash
curl -fsS http://127.0.0.1:8088/version.json
curl -fsS http://127.0.0.1:8088/api/v1/health
curl -fsS http://127.0.0.1:8088/api/v1/homepage
```

验收条件：

- `version.json.sha` 等于本次 `BUILD_SHA`。
- 健康接口 `status` 为 `ok`。
- `database.ok` 和 `database.migration.ok` 均为 `true`。
- `expected` 与 `applied` 迁移哈希一致。
- 当前大会为 `tokems26`。
- 公开大会名称、文案、票种、嘉宾、议程、FAQ、报名表和大会设置符合本次发布目标。

### 8.3 公网检查

从服务器外部执行：

```bash
curl -fsS https://hui.ailingdaoli.com/version.json
curl -fsS https://hui.ailingdaoli.com/api/v1/health
curl -fsS https://hui.ailingdaoli.com/api/v1/homepage
curl -fsSI https://hui.ailingdaoli.com/
curl -fsSI https://admin.hui.ailingdaoli.com/admin/
curl -fsSI https://www.ailingdaoli.com/pay/hui/
```

对比本地模板与线上模板时，先比较完整结构，再单独解释实时业务字段。线上 `remaining`、`sold`、报名数、订单数和时间戳可以因真实业务数据与本地不同。模板结构、文案、大会设置、嘉宾、议程、FAQ、票种定义和报名表应保持一致。

## 9. 构建身份和 unhealthy 诊断

API 健康检查会比较镜像携带的迁移身份和数据库实际迁移。以下任一情况都会阻止发布：

- `BUILD_SHA`、`BUILD_TIME`、`BUILD_MIGRATION` 或 `BUILD_MIGRATION_HASH` 为 `unknown`。
- API 的预期迁移哈希与数据库已应用迁移哈希不同。
- API、Worker、Web、Admin 和 Gateway 使用了不同构建身份。

诊断命令：

```bash
cd /www/wwwroot/TokEMS || exit 1

docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' tokems-api-1 \
  | grep '^BUILD_'

docker exec tokems-api-1 node -e \
  "fetch('http://127.0.0.1:4100/api/v1/health').then(r => r.text()).then(console.log)"

docker compose logs --no-color --tail=200 api db-init gateway
docker inspect tokems-api-1
```

健康接口显示 `expected: "unknown"` 且数据库 `applied` 有真实哈希时，说明 Compose 重建容器时没有获得构建元数据。重新从构建所用提交和迁移文件生成四项值，写入 `.env`，然后重建相关容器。禁止手工填写无法追溯到构建源码的哈希。

## 10. 回滚规则

### 10.1 应用镜像回滚

进入写冻结后，部署脚本先持久化恢复标记。失败处理会先停止 API/Worker、恢复旧镜像和旧 `.env`，再读取数据库当前迁移哈希。数据库已经前移时，脚本把运行环境的迁移字段对齐到数据库当前值，并以 API 只读、Worker 暂停的状态提供受控访问。数据库迁移身份暂时不可读取时，API/Worker 保持停止，恢复标记和已有证据继续保留。审计证据包括：

- `automatic-rollback-identity.txt`
- `automatic-rollback-migration-state.txt`
- `automatic-rollback-health.json`
- `automatic-rollback.log`
- `/www/backup/TokEMS/RECOVERY_REQUIRED`

这个受保护恢复状态使用旧应用提交和当前数据库迁移，数据库身份可确认时提供只读公开访问；身份不可确认时保持应用写服务停止。常规 `check` 与 `deploy` 会返回失败，防止把暂停写入误判为健康基线。修复代码已经合并并通过 CI 后，使用 `deploy --resume-recovery` 继续前向发布；人工完成独立恢复后，使用 `resolve-recovery` 复核正常写权限、Worker 持久 ready 身份、生产数据子集及首页投影并清除标记。静态 Gateway/Web/Admin 保留旧镜像内的迁移信息；API/Worker 使用当前数据库迁移信息。提交和构建时间必须保持一致，审计标记必须与两组迁移身份吻合。

以下手工流程只适用于数据库迁移哈希仍等于备份 `.env` 中 `BUILD_MIGRATION_HASH` 的情况：

```bash
cd /www/wwwroot/TokEMS || exit 1

backup_dir="/www/backup/TokEMS/<release-stamp>"
rollback_tag="rollback-<release-stamp>"

for image in \
  tokems-api \
  tokems-admin \
  tokems-web \
  tokems-worker \
  tokems-gateway \
  tokems-notification-sink
do
  docker image inspect "$image:$rollback_tag" >/dev/null
  docker tag "$image:$rollback_tag" "$image:local"
done

cp -a "$backup_dir/.env" .env
docker compose \
  -f "$backup_dir/docker-compose.yml" \
  --env-file .env \
  config --quiet

docker compose \
  -f "$backup_dir/docker-compose.yml" \
  --env-file .env \
  up -d \
  --no-build \
  --no-deps \
  --force-recreate \
  --wait \
  --wait-timeout 300 \
  notification-sink api worker web payment-web admin gateway
```

发布前的 `docker-compose.yml` 与 `.env` 必须一起使用，避免新版本 Compose 合约驱动旧镜像。数据库哈希已经变化时，不执行上述简单手工流程；使用脚本生成的受保护恢复证据继续诊断和前向发布。回滚后执行与发布相同的容器、数据库、本机 HTTP、公网 HTTP 和版本验证。

### 10.2 数据库恢复

数据库覆盖恢复会改写生产业务数据，只能在以下条件全部满足时执行：

- 已确认应用回滚无法恢复服务或数据已被错误写入。
- 已停止 API、Worker 和所有写入服务。
- 已对故障现场再做一份数据库备份。
- 已验证目标 dump 的 SHA-256 和 `pg_restore --list`。
- 已获得本次恢复的明确批准。

当前迁移以增量兼容为原则。普通应用故障不执行数据库覆盖恢复，也不删除新表、新列或数据卷。

## 11. 规范模板不变量

- 公开组织 slug：`geo-conference`
- 当前规范大会 slug：`tokems26`
- 生产环境文件 `/etc/tokems/production.env`：`PUBLIC_ORGANIZATION_SLUG=geo-conference`
- Nuxt 构建参数：`NUXT_PUBLIC_ORGANIZATION_SLUG=geo-conference`
- 生产常态：`DEPLOYMENT_MODE=production`、`SEED_DEMO_DATA=false`
- 历史模板 `tokems-demo`、`tokems-demo-2026` 不再作为 GitHub 或生产默认模板
- 线上真实报名、订单、票、发票、用户、销量和库存状态持续保留

模板更新进入生产有两条受控路径：

1. 仓库规范模板变更通过 PR 合并，随后执行本手册的规范模板同步。
2. 运营后台修改当前大会并保存，由系统生成不可变发布快照；随后运行 `pnpm canonical:export`，将最新规范状态回写 GitHub。

两条路径都要验证公开首页。仓库种子同步前还要确认稳定 ID 与生产交易关系。每次源码推送均需通过 `pnpm canonical:check`，与大会无关的代码变更也不能跳过该检查。

## 12. 发布记录要求

每次生产发布从 `docs/release-records/TEMPLATE.md` 创建日期化 Markdown 记录，至少包含：

- 发布日期、操作者、目标环境和目标域名
- GitHub PR、CI、目标提交和最高迁移
- 构建时间、迁移文件 SHA-256 和镜像摘要
- Release descriptor digest、源码 Bundle SHA-256、verifier SHA-256、目标平台和六个服务 digest
- 备份目录、数据库 dump SHA-256 和回滚标签
- 是否执行规范模板同步
- 发布前后的组织、大会、票种、报名、订单数据摘要
- 容器、本机 HTTP、公网 HTTP 和版本验证结果
- 发布中的异常、诊断、回滚和最终处理
- 已知风险、未完成项和下次发布前要处理的事项

发布记录不得包含 `.env` 全文、密码、密钥、令牌、私钥或用户隐私数据。

## 13. 当前环境待改进项

- GitHub Actions 已负责固定镜像摘要的外部构建。完成三个不同 SHA 的真实预构建生产发布后，再通过独立 PR 增加 `production` Environment 审批、专用受限 SSH Key、root-owned 强制命令入口和 `deploy-production.yml`。规范修复复用旧镜像的发布不计入三次验证。
- 当前 `.env` 由服务器权限保护。后续应把生产密钥迁移到 Secret Manager 或等价的受控密钥系统。
- 服务器操作系统安全更新需要独立维护窗口处理，不能与应用发布混在同一次变更中。
- MinIO 资产恢复演练和定期备份仍需形成独立记录。
- 带批准的 GitHub Actions 自动部署完成前，每次镜像发布成功后都要人工执行服务器部署脚本，并按模板补充日期化发布记录。
