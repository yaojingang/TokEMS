# 2026-08-16 tokems26 正式同步记录

> 记录类型：生产发布历史
>
> 执行时间：2026-08-16
>
> 发布后外部复核：2026-08-16
>
> 文档归档复核：2026-08-17
>
> 长期规则：`docs/production-deployment-runbook.md`

## 1. 发布目标

本次发布将本地规范大会模板 `tokems26` 设为 GitHub 和生产环境的唯一默认模板，替换线上历史模板 `tokems-demo-2026`。同步范围包括大会前台模板、公开文案、嘉宾、议程、FAQ、票种、报名配置和大会设置。

生产中的报名、订单、票务销量和用户数据继续保留。线上生产数据不会按本地测试库存覆盖。

## 2. 发布对象

| 项目           | 本次值                                                             |
| -------------- | ------------------------------------------------------------------ |
| 官方仓库       | `https://github.com/yaojingang/TokEMS.git`                         |
| GitHub 主分支  | `main`                                                             |
| 目标提交       | `035c58a9e70ac9266f9797f89bd5b5a9f2b09369`                         |
| 规范模板合并   | PR #29，`feat: make tokems26 the canonical template`               |
| 生产依赖更新   | PR #28，目标提交包含生产依赖升级                                   |
| CI             | `tokems-ci` 成功，run `31942788675`                                |
| 构建时间       | `2026-08-16T11:58:49Z`                                             |
| 最高迁移       | `0050_flimsy_thunderbolt_ross.sql`                                 |
| 迁移 SHA-256   | `aa1a0e6e69acf08cbe0c873245c09890fb0f9d5787324c43c03fd84280fd583d` |
| 服务器源码目录 | `/www/wwwroot/TokEMS`                                              |
| 宝塔站点目录   | `/www/dk_project/wwwroot/hui.ailingdaoli.com`                      |
| 生产分支       | `production`，跟踪 `origin/main`                                   |

## 3. 发布前状态

服务器最初使用历史 fork：

- 远程仓库：`https://github.com/majin72/TokEMS.git`
- 分支：`main`
- 提交：`9fa2e2caecba6e57f69e907e914b76c572316670`
- 生产环境默认组织：`tokems-demo`
- 生产环境默认大会：`tokems-demo-2026`

数据库发布前摘要：

| 数据     | 发布前值                                          |
| -------- | ------------------------------------------------- |
| 组织     | `tokems-demo`，`TokEMS Demo Team`                 |
| 大会     | `tokems-demo-2026`，`TokEMS Demo Conference 2026` |
| 大会状态 | `registration_open`                               |
| 票种     | `两日通票`，容量 500，已售 3                      |
| 报名数   | 10                                                |
| 订单数   | 10                                                |

服务器运行条件：

- Docker `26.1.3`
- Docker Compose `v2.27.0`
- Node.js 和 pnpm 未安装在宿主机
- 根分区可用空间约 15 GiB
- 可用内存约 3 GiB
- 未配置 Swap

## 4. 备份和回滚点

本次备份目录：

```text
/www/backup/TokEMS/20260816-194933
```

数据库备份：

| 项目                | 结果                                                               |
| ------------------- | ------------------------------------------------------------------ |
| 文件                | `conference.dump`                                                  |
| 格式                | PostgreSQL custom format                                           |
| 大小                | 292 KiB                                                            |
| SHA-256             | `0c8f5d86fa9f66ee046656854c755f40b8cd45c4e507ecca148448cd9ed3f2fb` |
| `pg_restore --list` | 549 行，可读取                                                     |
| 票种销量快照        | 1 行                                                               |
| 配额销量快照        | 1 行                                                               |

备份同时保存了 `.env`、发布前提交、Compose 状态和销量计数。

旧应用镜像统一增加回滚标签：

```text
rollback-20260816-194933
```

本次没有单独导出 MinIO 数据卷。发布过程中没有删除或重建任何具名数据卷。

## 5. 源码来源收敛

服务器 Git 配置完成以下调整：

1. 原 `origin` 重命名为 `legacy-fork`。
2. 新 `origin` 指向 `https://github.com/yaojingang/TokEMS.git`。
3. 创建服务器分支 `production`，跟踪 `origin/main`。
4. 服务器目标提交切换为 `035c58a9e70ac9266f9797f89bd5b5a9f2b09369`。

切换前已确认旧服务器工作树与目标官方主分支的 Git tree 一致，因此没有覆盖服务器私有源码修改。

## 6. 模板和数据库同步

生产环境公开组织设置为：

```text
PUBLIC_ORGANIZATION_SLUG=geo-conference
NUXT_PUBLIC_ORGANIZATION_SLUG=geo-conference
```

正常运行状态继续保持：

```text
DEPLOYMENT_MODE=production
SEED_DEMO_DATA=false
```

本次模板切换临时使用 `SEED_DEMO_DATA=true` 运行一次 `db-init`，完成迁移和规范模板幂等同步。同步后通过事务恢复发布前保存的票种销量和配额销量。

## 7. 第一次切换失败

第一次容器切换时，API 在等待约 165 秒后保持 unhealthy，其他服务因依赖 API 无法完成切换。

容器内检查结果：

```text
BUILD_MIGRATION=unknown
BUILD_MIGRATION_HASH=unknown
BUILD_SHA=unknown
BUILD_TIME=unknown
```

API 健康接口返回 `degraded`。数据库连接正常，数据库已应用迁移哈希为真实值，镜像预期迁移值为 `unknown`。

### 根因

仓库的 `tooling/docker-deploy.mjs` 会从 Git 和迁移目录计算四项构建身份，并在同一进程中传给镜像构建和 Compose 启动。生产服务器没有 Node.js 和 pnpm，本次使用手工 Docker Compose。构建完成后进入新 Shell，临时环境变量丢失，容器被重新创建时获得了 `unknown`。

API 健康检查要求状态为 `ok` 且迁移一致，因此正确阻止了这批身份不完整的容器进入健康状态。

### 回滚中的同类现象

第一次回滚恢复了旧镜像和数据库备份，但旧 `.env` 没有持久化当时的四项构建身份。重新创建旧 API 容器后仍出现相同的 `unknown` 健康失败。这一步确认问题位于发布元数据传递，数据库和应用业务逻辑没有形成新的故障。

## 8. 最终修复和正式切换

最终处理完成以下事项：

1. 使用目标提交重新确认新 API、Worker、Web、Admin 和 Gateway 镜像。
2. 把四项构建身份写入服务器 `.env`，保证新终端和容器重建都能读取同一版本。
3. 重新标记目标镜像为各服务的 `:local` 当前镜像。
4. 运行迁移和 `tokems26` 规范模板同步。
5. 恢复票种和配额销量。
6. 使用 `--no-build --force-recreate --wait` 重建应用容器。

最终使用的构建身份：

```text
BUILD_SHA=035c58a9e70ac9266f9797f89bd5b5a9f2b09369
BUILD_TIME=2026-08-16T11:58:49Z
BUILD_MIGRATION=0050_flimsy_thunderbolt_ross.sql
BUILD_MIGRATION_HASH=aa1a0e6e69acf08cbe0c873245c09890fb0f9d5787324c43c03fd84280fd583d
```

## 9. 最终生产状态

全部长期服务达到 healthy：

- PostgreSQL
- Redis
- MinIO
- notification-sink
- API
- Worker
- Web
- payment-web
- Admin
- Gateway

一次性 `db-init` 和 `minio-init` 正常退出。

数据库最终摘要：

| 数据     | 最终值                                     |
| -------- | ------------------------------------------ |
| 组织     | `geo-conference`，`中国GEO大会组委会`      |
| 大会     | `tokems26`，`第二届中国 GEO & AI 营销大会` |
| 大会状态 | `registration_open`                        |
| 标语     | `让好的品牌被 AI 正确推荐`                 |
| 票种     | `大会通票`，容量 500，已售 3               |
| 报名数   | 10                                         |
| 订单数   | 10                                         |

生产数据保留结果符合本次目标。

## 10. 2026-08-16 发布后外部复核

外部复核结果：

| 检查项                                      | 结果                                       |
| ------------------------------------------- | ------------------------------------------ |
| `https://hui.ailingdaoli.com/`              | HTTP 200                                   |
| `https://hui.ailingdaoli.com/version.json`  | HTTP 200，提交为 `035c58a...`              |
| `https://hui.ailingdaoli.com/api/v1/health` | HTTP 200，状态 `ok`                        |
| `https://admin.hui.ailingdaoli.com/admin/`  | HTTP 200                                   |
| `https://www.ailingdaoli.com/pay/hui/`      | HTTP 200                                   |
| 数据库迁移                                  | `expected` 与 `applied` 哈希一致           |
| 当前大会                                    | `tokems26`                                 |
| GitHub `main`                               | `035c58a9e70ac9266f9797f89bd5b5a9f2b09369` |
| GitHub CI                                   | 成功                                       |
| GitHub 待合并 PR                            | 发布完成时为 0                             |

本地和线上 `/api/v1/homepage` 的模板结构、文案、大会设置、嘉宾、议程、FAQ、票种定义和报名表一致。完整 JSON 只有一项生产业务差异：

- 本地测试库存剩余 500。
- 线上保留已售 3 张，剩余 497。

本地 Mac 当时运行的 Docker 构建为 `06798c1` 和迁移 `0048`，线上及 GitHub 已更新到 `035c58a` 和迁移 `0050`。本地页面模板内容已一致，运行镜像版本尚未重建到同一提交。

2026-08-17 整理本文档时再次检查，线上版本、健康状态和三个公网入口保持正常，GitHub `main` 仍为 `035c58a...`。当日新建了草稿 PR #30，该 PR 尚未合并，也未进入本次生产版本。

## 11. 固化到发布规范的经验

本次交互形成以下长期约束，已写入 `docs/production-deployment-runbook.md`：

- GitHub 官方主分支是生产唯一源码来源。
- 服务器使用 `production` 分支跟踪 `origin/main`。
- 构建元数据同时属于镜像和运行环境，四项值必须持久化并保持一致。
- `SEED_DEMO_DATA=true` 只用于经过确认的规范模板同步。
- 模板同步前保存销量和生产数据摘要，同步后立即复核。
- 每次发布先做 PostgreSQL custom dump、可读性检查和镜像回滚标签。
- unhealthy 时先读容器内健康接口和构建身份，再决定修复或回滚。
- 公网验收同时检查大会前台、后台、支付页、版本接口和健康接口。
- 本地模板与线上模板对比时，实时库存和交易计数单独判断。

## 12. 后续事项

- 当前生产发布仍为人工 Docker Compose 流程，尚未建立 GitHub Actions 自动部署。
- 宿主机显示 147 条安全公告，其中 78 条为 Important，需要单独安排系统维护窗口。
- MinIO 数据卷需要纳入定期备份和恢复演练。
- 本地 Docker 环境可在合适时机从官方 `origin/main` 重新构建，使本地运行版本与线上提交一致。
