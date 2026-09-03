# 2026-09-03 低内存预构建镜像生产发布记录

> 发布状态：已发布
>
> 执行时间：2026-09-03 11:26 至 11:29，Asia/Shanghai
>
> 操作者：Codex 与生产服务器管理员协作执行
>
> 长期规则：`docs/production-deployment-runbook.md`

## 1. 发布目标

- 上线两段式低内存发布：GitHub Actions 构建并证明镜像，4 核 8G 生产机只执行拉取、备份、迁移、切换和验收。
- 使用私有包 `ghcr.io/yaojingang/tokems-production-private`、schema 2 Release Descriptor、固定 digest 的六个服务镜像、Git Bundle 和 descriptor verifier 完成首轮正式生产发布。
- 修复生产 Python 3.6 兼容、无换行 GHCR Token 读取和 pnpm 链接包规范导出三个现场问题。
- 保留生产报名、订单、票、发票、用户、票种销量和配额销量。本次不执行规范模板同步，不修改 MinIO 对象和服务拓扑。
- 带 Production Environment 审批的自动部署继续处于第二阶段门禁；本次计为三次不同 SHA 预构建生产发布中的第 1 次。

## 2. GitHub 和构建身份

| 项目                        | 本次值                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR                          | [#60](https://github.com/yaojingang/TokEMS/pull/60)、[#61](https://github.com/yaojingang/TokEMS/pull/61)、[#62](https://github.com/yaojingang/TokEMS/pull/62)、[#65](https://github.com/yaojingang/TokEMS/pull/65)、[#66](https://github.com/yaojingang/TokEMS/pull/66)、[#67](https://github.com/yaojingang/TokEMS/pull/67) |
| CI                          | [`tokems-ci` run 33709964769](https://github.com/yaojingang/TokEMS/actions/runs/33709964769)，成功                                                                                                                                                                                                                           |
| 镜像发布工作流              | [`tokems-image-publish` run 33710411367](https://github.com/yaojingang/TokEMS/actions/runs/33710411367)，成功                                                                                                                                                                                                                |
| 目标提交                    | `4579248e5eb645df530b999a9c955b6369ba58ca`                                                                                                                                                                                                                                                                                   |
| 构建时间                    | `2026-09-03T03:10:47Z`                                                                                                                                                                                                                                                                                                       |
| 最高迁移                    | `0059_green_rictor.sql`                                                                                                                                                                                                                                                                                                      |
| 迁移 SHA-256                | `776a677d42968cf0aeafb79ff2920994f2fe32446bf50c1a9d560d7847d14a24`                                                                                                                                                                                                                                                           |
| 发布分支                    | 服务器 `production`，跟踪 `origin/main`                                                                                                                                                                                                                                                                                      |
| Release descriptor digest   | `sha256:7d0c5b49a4dceb12521b1f9da31d23c70d760a09b9e713242fb164429693cf84`                                                                                                                                                                                                                                                    |
| Source Bundle SHA-256       | `b459029f428ee648089abb78f361628e2d1b14274d4b8b0ebda52ef60eb42104`                                                                                                                                                                                                                                                           |
| Descriptor verifier SHA-256 | `1975710a912a17a6a8519bc3011d78edb7d19bef78ae332247b662d1e8831568`                                                                                                                                                                                                                                                           |
| 目标平台                    | `linux/amd64`                                                                                                                                                                                                                                                                                                                |

六个候选镜像及 descriptor 的 GitHub provenance、源码提交、构建身份、目标平台和迁移哈希均在生产变更前完成验证。

## 3. 发布前检查

- [x] 服务器工作区干净，分支为 `production`
- [x] `production` 与 descriptor Bundle 中的 `origin/main` 一致
- [x] Compose 配置和 Nginx 配置通过
- [x] 预构建模式的磁盘与备份容量满足要求；发布过程未调用 `docker build`
- [x] Python 3.6.8、Docker 26.1.3、Compose v2.27.0、Buildx v0.36.1 和 GitHub CLI 2.99.0 满足门禁
- [x] `/etc/tokems/production.env` 与 `/etc/tokems/ghcr-read-token` 均为 `root:root 0600`
- [x] 没有并行发布任务或未处理的恢复标记
- [x] 官方 main push CI 和镜像发布工作流成功

## 4. 备份和回滚点

| 项目                 | 本次值                                                             |
| -------------------- | ------------------------------------------------------------------ |
| 备份目录             | `/www/backup/TokEMS/20260903-112616`                               |
| 数据库 dump          | `conference.dump`，PostgreSQL custom format                        |
| dump SHA-256         | `9c5e6940f614576264b65dd2547d62c5ca69e928e290ce37f59989e4c9981a7d` |
| `pg_restore --list`  | 678 行，可读取                                                     |
| 镜像回滚标签         | `rollback-20260903-112616`                                         |
| MinIO 或对象存储备份 | 不适用，本次没有对象写入或存储配置变更                             |
| 发布前版本           | `1b475c8134ef8b2c9953811885492eabea91874e`                         |

备份目录保存发布前后容器、镜像和构建身份，数据库 dump 及校验，业务主键、计数、票种和配额销量，descriptor 与六个镜像拉取证据，以及写冻结、迁移、切换、HTTP 验收和恢复处置证据。恢复标记已归档为 `RECOVERY_RESOLVED-20260903-112907`。

## 5. 数据库和模板

- 是否包含新迁移：否，发布前后最高迁移均为 `0059_green_rictor.sql`
- `db-init` 结果：`SEED_DEMO_DATA=false`，迁移与迁移哈希检查成功
- 是否执行规范模板同步：否，目标规范快照与当前生产规范一致
- 规范组织和大会：`geo-conference` / `tokems26`
- 规范快照检查：`pnpm canonical:check`、目标快照和生产只读导出比较均成功
- 完整规范快照文件 SHA-256：`66c332c348c03019c99a899b1a441c5234d18e0148c3f9d25f8c4a2e1d8571e3`
- 前台派生快照文件 SHA-256：`863bebc62a55bcf2d670779644003e57612f207d33b9ff358931cd99a4e0fd68`
- 脱敏检查：管理员身份、API/第三方凭据、个人数据、交易数据、销量和审计记录均未进入快照
- 同步前报名数：35
- 同步后报名数：35
- 同步前订单数：35
- 同步后订单数：35
- 业务计数：用户 42、报名 35、订单 35、票 24、发票申请 2，发布前后逐项一致
- 票种和配额销量校验：发布前后文件逐字节一致

## 6. 镜像和容器切换

| 服务              | descriptor 固定镜像摘要                                                   | 最终状态 |
| ----------------- | ------------------------------------------------------------------------- | -------- |
| API               | `sha256:a4a926928048d70998db00e4ac5fd918df07b5115a75f8623a43af5e02a4685b` | healthy  |
| Worker            | `sha256:bea00f98a02692922322c495820bd39a19e9195c666b1c15027dd017e736b33c` | healthy  |
| Web / payment-web | `sha256:fdd2d9fc12599c61e81733bdc45574d2ba4464b2cfe7768fa48d5130e8f60770` | healthy  |
| Admin             | `sha256:3b8935e690420d249cb4d4c743aa3db8ae65644641f856a57b4e2c261455e62d` | healthy  |
| Gateway           | `sha256:9f2d49a870a14d27d253f0a9ced55d8a463f5d6871d4b7a68a32fb88c17a7de0` | healthy  |
| notification-sink | `sha256:0184152594275d84f7a18358bc9f488f3764090c43de07d5245627ad4b75c3b9` | healthy  |

六个候选镜像全部拉取并验证后，控制器才更新 `tokems-*:local` 标签。API、Worker、Web、payment-web、Admin、Gateway 和 notification-sink 切换成功；PostgreSQL、Redis、MinIO 和 Mailpit 保持健康。

## 7. 验证结果

- [x] 11 个 TokEMS 长期容器全部 healthy
- [x] Gateway、Web、Admin、API 和 Worker 五类运行身份均等于目标提交
- [x] API `status=ok`
- [x] `database.ok=true`、`database.migration.ok=true`
- [x] 迁移 `expected` 与 `applied` 哈希一致
- [x] 服务器本机首页和健康接口均为 HTTP 200
- [x] 公网首页、运营后台、支付页和健康接口均为 HTTP 200
- [x] 当前大会为 `tokems26`，公开首页与后台完整规范快照符合目标
- [x] 报名、订单、票、发票、用户、票种和配额销量保持不变
- [x] 写入恢复后持续观察 15 秒，Worker ready 身份和最终业务数据复验通过
- [x] 生产工作区最终干净，`HEAD` 与 `origin/main` 均为目标提交，恢复标记不存在

公网检查摘要：

| 入口     | HTTP 状态 | 版本或内容结果                         |
| -------- | --------- | -------------------------------------- |
| 大会前台 | 200       | `geo-conference` / `tokems26` 首页正常 |
| 运营后台 | 200       | `/admin/` 可访问                       |
| 支付页面 | 200       | `/pay/hui/` 可访问                     |
| 版本接口 | 200       | 提交 `4579248...`，五类构建身份一致    |
| 健康接口 | 200       | `status=ok`，数据库和迁移一致          |

## 8. 异常和处理

- 异常：正式发布前发现 TokEMS 与同机 GEOFlow 容器停止；内核日志记录 `dockerd` 两次被 OOM 终止。现场只读诊断复现了 `docker system df` 触发守护进程常驻内存快速增长。
- 影响：TokEMS 服务在恢复前中断；本次正式发布尚未开始，数据库迁移、镜像标签和生产环境文件均未变更。
- 根因：8G 主机上的 Docker 全局对象盘点触发异常内存增长，历史主机构建压力进一步放大风险；Docker 记录容器为人工停止状态，守护进程重启后没有自动拉起应用。
- 处理：终止诊断进程并重启 Docker 守护进程，按依赖顺序恢复旧 TokEMS 容器，验证旧版本和业务数据后继续标准预构建发布。未执行 prune、删卷、数据库覆盖恢复或迁移降级。GEOFlow 保持停止，留给其独立维护流程处理。
- 是否触发回滚：否；故障发生在生产变更前，正式发布一次完成。

`docker system df` 及其 `-v` 变体已写入生产运维禁用项。磁盘检查改用 Docker Root Dir 对应文件系统的 `df`，镜像检查使用有界的 `docker image inspect`。

## 9. 最终结论

- 最终状态：已发布
- 线上提交：`4579248e5eb645df530b999a9c955b6369ba58ca`
- 线上迁移：`0059_green_rictor.sql`
- 回滚点：`/www/backup/TokEMS/20260903-112616` 与 `rollback-20260903-112616`
- Release Descriptor：`sha256:7d0c5b49a4dceb12521b1f9da31d23c70d760a09b9e713242fb164429693cf84`
- 剩余风险：Docker 守护进程的全局对象盘点内存缺陷仍需在独立维护窗口评估升级或元数据治理；自动批准部署需等待另外两次不同 SHA 的预构建生产发布成功。
- 下次发布前事项：继续使用私有 GHCR 预构建路径，禁止运行 `docker system df`，确认 dockerd 内存稳定、恢复标记不存在，并完成第 2 次预构建发布计数。

本记录不包含 `.env`、连接串、密码、密钥、令牌、私钥或用户隐私数据。
