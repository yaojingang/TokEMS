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
| Compose 项目名            | `tokems`                                      |
| Gateway 宿主机入口        | `127.0.0.1:8088`                              |
| 大会前台                  | `https://hui.ailingdaoli.com/`                |
| 运营后台                  | `https://admin.hui.ailingdaoli.com/admin/`    |
| 支付页面                  | `https://www.ailingdaoli.com/pay/hui/`        |
| 健康接口                  | `https://hui.ailingdaoli.com/api/v1/health`   |
| 版本接口                  | `https://hui.ailingdaoli.com/version.json`    |

`/www/wwwroot/TokEMS` 保存 Git 源码、`.env` 和 `docker-compose.yml`，所有迁移、构建和容器操作都从这里执行。

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

持久数据卷为：

- `tokems-postgres`
- `tokems-redis`
- `tokems-minio`

常规发布禁止删除这些卷。应用容器默认使用只读根文件系统、受限 tmpfs、`no-new-privileges`、全部 capability drop 和轮转 JSON 日志。Gateway 只绑定回环地址，由宿主机 Nginx 提供公网 80/443 和 TLS。

## 3. 三种发布动作

| 动作         | 结果                                                               | 何时使用                                           |
| ------------ | ------------------------------------------------------------------ | -------------------------------------------------- |
| 源码推送     | 本地分支通过 PR 合并到 GitHub `main`                               | 所有代码、文档、模板种子和迁移变更                 |
| 应用发布     | 服务器拉取 `origin/main`，构建镜像，迁移并切换容器                 | GitHub 主分支需要进入生产运行时                    |
| 规范模板同步 | 把仓库中的 `geo-conference`、`tokems26` 规范模板幂等写入生产数据库 | 仓库模板、前台文案、大会设置或规范发布快照发生变化 |

代码变更进入 `main` 后不会自动出现在当前服务器。当前环境尚未配置 GitHub Actions 自动部署，正式上线仍需执行本手册的服务器流程。

后台直接修改已上线大会时，保存操作会生成新的不可变发布快照并切换公开版本。这类内容更新不需要运行仓库种子。

## 4. 强制发布规则

1. **唯一来源**：生产只使用 `yaojingang/TokEMS` 的 `origin/main`。`majin72/TokEMS` 仅保留为历史 fork，不再接收生产推送。
2. **PR 先行**：功能分支使用 `codex/*` 或项目约定的功能分支，经 PR、评审和 CI 后合并。服务器禁止直接部署未合并提交。
3. **干净构建**：本地和服务器发布构建前，Git 工作区必须干净。构建开始后再次核对 `HEAD` 和工作区，避免镜像混入未提交文件。
4. **一个发布进程**：服务器同一时间只运行一个拉取、构建、迁移或切换任务。
5. **先备份再写入**：数据库迁移、规范模板同步和容器切换前，必须创建可读取的数据库备份并记录回滚镜像。
6. **四项构建身份完整**：`BUILD_SHA`、`BUILD_TIME`、`BUILD_MIGRATION`、`BUILD_MIGRATION_HASH` 必须在构建和运行阶段保持一致，任何值都不能为 `unknown`。
7. **常规发布不写种子**：默认保持 `SEED_DEMO_DATA=false`。规范模板同步需单独确认并执行专用步骤。
8. **生产业务数据保留**：报名、订单、票、发票、用户、库存销量和配额销量不得随模板同步清空或重置。
9. **迁移先于应用**：先运行 `db-init` 并确认成功，再重建 API、Worker、Web、Admin 和 Gateway。
10. **优先应用回滚**：当前迁移采用增量兼容策略，故障时优先回滚镜像和环境。数据库覆盖恢复只用于明确的数据损坏或已批准的整库回退。
11. **安全输出**：终端和发布记录只输出允许公开的环境键。禁止打印 `.env` 全文、连接串、密码、私钥、Cookie 或第三方令牌。
12. **逐层验证**：发布结论需要同时满足 GitHub、容器、数据库、本机 HTTP、公网 HTTP 和版本身份六层验证。

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
```

涉及支付、通知、报名、订单、发票、票务、数据库迁移或权限时，还要运行对应专项验收。涉及前台和后台界面时运行视觉验收。

### 6.2 PR 和合并

```bash
git push -u origin <feature-branch>
gh pr create --base main --head <feature-branch>
gh pr checks <pr-number> --watch
```

合并前确认：

- PR 内容只包含本轮目标文件。
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

## 7. 服务器标准发布流程

以下命令以生产目录和当前 `ecs-user` Git 所有权为准。执行过程中出现非预期输出时停止发布，先定位当前层级。

### 7.1 只读预检

```bash
cd /www/wwwroot/TokEMS || exit 1

sudo -u ecs-user git status --short --branch -uall
sudo -u ecs-user git rev-parse HEAD
sudo -u ecs-user git branch --show-current
sudo -u ecs-user git remote -v

docker --version
docker compose version
docker compose config --quiet
docker compose ps
nginx -t
df -h / /var/lib/docker
free -h
```

允许继续发布的条件：

- Git 工作区干净。
- 当前分支为 `production`。
- `origin` 指向官方仓库。
- Compose 配置和 Nginx 配置通过。
- 磁盘、内存和 Docker 状态满足构建需要。
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
  > "$backup_dir/conference.dump"

docker compose exec -T postgres pg_restore --list \
  < "$backup_dir/conference.dump" \
  > "$backup_dir/conference.dump.list"

docker compose exec -T postgres sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "," -c "select id,sold from ticket_types order by id"' \
  > "$backup_dir/ticket-types-sold.csv"

docker compose exec -T postgres sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "," -c "select id,sold from ticket_quotas order by id"' \
  > "$backup_dir/ticket-quotas-sold.csv"

test -s "$backup_dir/conference.dump"
test -s "$backup_dir/conference.dump.list"
sha256sum "$backup_dir/conference.dump" > "$backup_dir/conference.dump.sha256"
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

### 7.3 同步官方主分支

```bash
cd /www/wwwroot/TokEMS || exit 1

test -z "$(sudo -u ecs-user git status --porcelain --untracked-files=all)"
sudo -u ecs-user git switch production
sudo -u ecs-user git fetch --prune origin main
sudo -u ecs-user git pull --ff-only origin main

target_sha=$(sudo -u ecs-user git rev-parse HEAD)
origin_sha=$(sudo -u ecs-user git rev-parse origin/main)
test "$target_sha" = "$origin_sha"
```

禁止使用 `git reset --hard` 或删除服务器工作区来解决分支分歧。出现分歧时停止发布，查明服务器提交来源。

### 7.4 生成并持久化构建身份

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

### 7.5 构建镜像

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

### 7.6 迁移数据库

常规发布：

```bash
cd /www/wwwroot/TokEMS || exit 1
SEED_DEMO_DATA=false docker compose run --rm db-init
```

Docker Compose v2.27 的 `docker compose run` 不支持 `--no-build`。此处不要添加该参数。

### 7.7 同步规范模板

只有发布范围包含仓库规范模板、前台文案或大会默认设置，并且已完成数据库备份与数据保护检查时执行本节。

先确认当前目标：

- 组织 slug 为 `geo-conference`。
- 大会 slug 为 `tokems26`。
- 票种和配额使用稳定 ID。
- 报名、订单、票、发票和用户记录继续保留。
- `ticket-types-sold.csv` 与 `ticket-quotas-sold.csv` 已生成且格式有效。

新终端需要先恢复并校验备份目录变量：

```bash
backup_dir=$(cat /www/backup/TokEMS/LATEST)
case "$backup_dir" in
  /www/backup/TokEMS/*) ;;
  *) exit 1 ;;
esac
test -s "$backup_dir/conference.dump"
test -s "$backup_dir/ticket-types-sold.csv"
test -s "$backup_dir/ticket-quotas-sold.csv"
```

执行幂等模板同步：

```bash
cd /www/wwwroot/TokEMS || exit 1
SEED_DEMO_DATA=true docker compose run --rm db-init
```

恢复生产销量计数：

```bash
{
  printf 'BEGIN;\n'
  sed -E "s/^([[:xdigit:]-]+),([0-9]+)$/UPDATE ticket_types SET sold = \2, updated_at = now() WHERE id = '\''\1'\''::uuid;/" \
    "$backup_dir/ticket-types-sold.csv"
  sed -E "s/^([[:xdigit:]-]+),([0-9]+)$/UPDATE ticket_quotas SET sold = \2, updated_at = now() WHERE id = '\''\1'\''::uuid;/" \
    "$backup_dir/ticket-quotas-sold.csv"
  printf 'COMMIT;\n'
} | docker compose exec -T postgres sh -lc \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

每条恢复语句都应返回 `UPDATE 1`。执行后立即检查报名、订单、票种、销量和配额。若规范模板变更会替换稳定 ID、删除票种或改变既有交易关系，应停止使用种子同步，改用经过评审的数据迁移或后台发布流程。

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

应用回滚优先使用发布前的 `rollback-<时间戳>` 镜像标签，并恢复该版本对应的 `.env` 构建身份：

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
  --force-recreate \
  --wait \
  --wait-timeout 300 \
  notification-sink api worker web payment-web admin gateway
```

发布前的 `docker-compose.yml` 与 `.env` 必须一起使用，避免新版本 Compose 合约驱动旧镜像。回滚后执行与发布相同的容器、数据库、本机 HTTP、公网 HTTP 和版本验证。

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
- 生产 `.env`：`PUBLIC_ORGANIZATION_SLUG=geo-conference`
- Nuxt 构建参数：`NUXT_PUBLIC_ORGANIZATION_SLUG=geo-conference`
- 生产常态：`DEPLOYMENT_MODE=production`、`SEED_DEMO_DATA=false`
- 历史模板 `tokems-demo`、`tokems-demo-2026` 不再作为 GitHub 或生产默认模板
- 线上真实报名、订单、票、发票、用户、销量和库存状态持续保留

模板更新进入生产有两条受控路径：

1. 仓库规范模板变更通过 PR 合并，随后执行本手册的规范模板同步。
2. 运营后台修改当前大会并保存，由系统生成不可变发布快照。

两条路径都要验证公开首页。仓库种子同步前还要确认稳定 ID 与生产交易关系。

## 12. 发布记录要求

每次生产发布从 `docs/release-records/TEMPLATE.md` 创建日期化 Markdown 记录，至少包含：

- 发布日期、操作者、目标环境和目标域名
- GitHub PR、CI、目标提交和最高迁移
- 构建时间、迁移文件 SHA-256 和镜像摘要
- 备份目录、数据库 dump SHA-256 和回滚标签
- 是否执行规范模板同步
- 发布前后的组织、大会、票种、报名、订单数据摘要
- 容器、本机 HTTP、公网 HTTP 和版本验证结果
- 发布中的异常、诊断、回滚和最终处理
- 已知风险、未完成项和下次发布前要处理的事项

发布记录不得包含 `.env` 全文、密码、密钥、令牌、私钥或用户隐私数据。

## 13. 当前环境待改进项

- 服务器没有 Node.js 和 pnpm，当前使用手工 Docker Compose 发布。后续可以建设基于 GitHub Actions、受保护生产环境和固定镜像摘要的自动发布。
- 当前 `.env` 由服务器权限保护。后续应把生产密钥迁移到 Secret Manager 或等价的受控密钥系统。
- 服务器操作系统安全更新需要独立维护窗口处理，不能与应用发布混在同一次变更中。
- MinIO 资产恢复演练和定期备份仍需形成独立记录。
- 自动发布完成前，每次 GitHub 合并后都要人工执行并记录服务器发布流程。
