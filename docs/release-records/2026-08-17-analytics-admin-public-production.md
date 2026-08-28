# 2026-08-17 网站统计、后台与公开页面生产发布记录

> 发布状态：已发布
>
> 执行时间：2026-08-17 17:48 至 18:02，Asia/Shanghai
>
> 操作者：Codex 与生产服务器管理员协作执行
>
> 长期规则：`docs/production-deployment-runbook.md`

## 1. 发布目标

- 上线组织级网站统计设置，支持百度统计、Google Analytics 4 和 Umami，并保持旧配置待管理员重新确认。
- 上线公开页面浏览量、嘉宾详情、合作申请、后台嘉宾和合作申请管理，以及 Agent 授权与操作能力。
- 修正大会报名中心品牌入口，使其返回公开首页。
- 保留生产报名、订单、票、发票、用户、票种销量和配额销量。
- 本次不执行规范模板种子同步，不修改 MinIO 对象，也不处理宿主机操作系统安全更新。

## 2. GitHub 和构建身份

| 项目         | 本次值                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR           | [#30](https://github.com/yaojingang/TokEMS/pull/30)、[#31](https://github.com/yaojingang/TokEMS/pull/31)、[#32](https://github.com/yaojingang/TokEMS/pull/32) |
| CI           | [`tokems-ci` run 32011699651](https://github.com/yaojingang/TokEMS/actions/runs/32011699651)，第二次运行成功                                                  |
| 目标提交     | `1b56d76794332769c584b201a320a044cc58746c`                                                                                                                    |
| 构建时间     | `2026-08-17T09:49:23Z`                                                                                                                                        |
| 最高迁移     | `0052_hard_rafael_vega.sql`                                                                                                                                   |
| 迁移 SHA-256 | `4ade808bbe4a85946f78e1da5b4e8f96f1dd7b24869c0e818abb826bd5fd8b67`                                                                                            |
| 发布分支     | 服务器 `production`，跟踪 `origin/main`                                                                                                                       |

主分支 CI 第一次运行在视觉巡检阶段出现 5 次瞬时资源 404。质量门禁、迁移、种子、构建服务和此前 PR 检查均已通过。重跑同一提交后，完整质量门禁、业务流程、依赖审计和视觉巡检全部成功，没有修改代码。

## 3. 发布前检查

- [x] 服务器工作区干净，分支为 `production`
- [x] `origin` 指向 `https://github.com/yaojingang/TokEMS.git`
- [x] Compose 配置通过，运行容器全部健康
- [x] Nginx 配置测试通过
- [x] 根分区发布前剩余约 14 GiB，构建后剩余约 13 GiB
- [x] 发布前可用内存约 2.7 GiB，无 Swap
- [x] 没有并行构建、迁移或发布任务
- [x] GitHub 主分支 CI 成功

服务器在数据库备份前已完成源码 Fast-forward。为确保应用回滚准确，发布流程从运行中的 API 容器读取旧构建提交，并从该提交导出旧版 `docker-compose.yml`。

## 4. 备份和回滚点

| 项目                 | 本次值                                                             |
| -------------------- | ------------------------------------------------------------------ |
| 备份目录             | `/www/backup/TokEMS/20260817-174806`                               |
| 数据库 dump          | `conference.dump`，PostgreSQL custom format                        |
| dump SHA-256         | `ca7f1f9c936743674c874b7bf30c442025fde987417695b1244693391cf91882` |
| `pg_restore --list`  | 549 行，可读取                                                     |
| 镜像回滚标签         | `rollback-20260817-174806`                                         |
| MinIO 或对象存储备份 | 不适用，本次没有对象写入或存储配置变更                             |
| 发布前版本           | `035c58a9e70ac9266f9797f89bd5b5a9f2b09369`                         |

备份目录同时保存发布前 `.env`、旧版 Compose 配置、容器状态、版本和健康响应、票种与配额销量、构建日志、迁移日志、发布后状态和运行日志。

## 5. 数据库和模板

- 包含新迁移：是，`0051` 和 `0052`
- `db-init`：`SEED_DEMO_DATA=false`，迁移成功
- 规范模板同步：未执行
- 规范组织和大会：`geo-conference` / `tokems26`
- 大会状态：`registration_open`
- 当前发布快照：存在
- 发布后业务摘要：用户 1、报名 10、订单 10、票 3、发票申请 3、嘉宾 16、合作申请 0
- 票种销量：发布前后文件逐字节一致
- 配额销量：发布前后文件逐字节一致
- 新表检查：`event_public_metrics`、`agent_connections`、`agent_operations`、`cooperation_requests` 均存在

网站统计最终公开配置为：`enabled=false`、`activationVersion=null`、`provider=baidu`，没有统计 ID。历史配置不会自动恢复，管理员需在后台重新确认后启用。

发布前独立业务计数查询没有单独保存；发布前数据库 dump 是该时点的权威快照。发布过程没有执行种子同步，销量文件已完成发布前后严格比较。

## 6. 镜像和容器切换

| 服务              | 镜像 ID                                                                   | 最终状态 |
| ----------------- | ------------------------------------------------------------------------- | -------- |
| API               | `sha256:39862abd4674cc5278d89e8a0f2e0dc2e6b4cc153f775c22429a356f81567555` | healthy  |
| Worker            | `sha256:073a6c12609dc6580fbc39d7573eb0b1d873662fcd846b7d3b839928ce9b615d` | healthy  |
| Web / payment-web | `sha256:e1d51bea75e3275f586ac08142112e0d421f6ff9afde2ed34c452457af9d76ae` | healthy  |
| Admin             | `sha256:5a42665189d17a5e223cf4d850347796c68d4f25db9d8b23d03c93cac309a95f` | healthy  |
| Gateway           | `sha256:6a63733beedc28bffd34db22d944bb10df6f695c814be2c0bd530c630017aa52` | healthy  |
| notification-sink | `sha256:d7f9e9891d9a3326bcc9c9c0367b2ae6f52e00fd3859dc3259c13484aa7c66f6` | healthy  |

构建使用 `COMPOSE_PARALLEL_LIMIT=1` 串行执行，以降低无 Swap 环境的峰值内存压力。迁移成功后，使用 `--no-build --force-recreate --wait` 切换应用服务。长期基础服务和具名数据卷保持运行。

## 7. 验证结果

- [x] PostgreSQL、Redis、MinIO、notification-sink、API、Worker、Web、payment-web、Admin 和 Gateway 全部 healthy
- [x] `version.json.sha` 等于目标提交
- [x] API `status=ok`
- [x] `database.ok=true`、`database.migration.ok=true`
- [x] 迁移 `expected` 与 `applied` 哈希一致
- [x] 当前大会为 `tokems26`
- [x] 本机版本、健康和公开首页接口可访问
- [x] 公网首页、后台、支付页、FAQ 和合作申请页均为 HTTP 200
- [x] 1440px 和 390px 浏览器验收通过
- [x] 嘉宾详情真实首页链接在桌面端和手机端加载成功
- [x] 浏览器没有控制台错误、页面异常或失败资源请求
- [x] 运行日志严重错误计数为 0
- [x] 生产数据和票种、配额销量符合预期

公网检查摘要：

| 入口     | HTTP 状态 | 版本或内容结果           |
| -------- | --------- | ------------------------ |
| 大会前台 | 200       | `tokems26` 首页正常      |
| 运营后台 | 200       | `/admin/` 可访问         |
| 支付页面 | 200       | `/pay/hui/` 可访问       |
| FAQ      | 200       | 独立 FAQ 页面正常        |
| 合作申请 | 200       | 页面正常，未提交测试数据 |
| 版本接口 | 200       | 提交 `1b56d76...`        |
| 健康接口 | 200       | `status=ok`，迁移一致    |

浏览器验收首次使用的临时脚本把嘉宾链接转换为纯路径，丢失了真实链接中的 `?event=tokems26`。该脚本因此进入了详情页的失效状态。公开 API、首页真实链接和修正后的桌面端与手机端验收均证明线上嘉宾详情正常，生产代码和数据无需处理。

## 8. 最终结论

- 最终状态：已发布
- 线上提交：`1b56d76794332769c584b201a320a044cc58746c`
- 线上迁移：`0052_hard_rafael_vega.sql`
- 回滚点：`/www/backup/TokEMS/20260817-174806` 与 `rollback-20260817-174806`
- 模板同步：未执行
- 统计代码：功能已上线，当前保持停用并等待管理员确认
- 剩余风险：宿主机无 Swap；147 条操作系统安全公告需单独维护窗口处理；MinIO 定期备份和恢复演练仍需建设
- 下次发布前事项：在备份阶段同时保存报名、订单、票和发票计数；继续遵循四项构建身份持久化和发布前回滚点规则

本记录不包含 `.env`、连接串、密码、密钥、令牌、私钥或用户隐私数据。
