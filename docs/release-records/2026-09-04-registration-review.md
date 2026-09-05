# 2026-09-04 TokEMS 报名迭代复核修复发布记录

> 发布状态：已发布
>
> 验证时间：2026-09-04 23:43，Asia/Shanghai
>
> 操作者：Codex，按用户授权执行
>
> 长期规则：`docs/production-deployment-runbook.md`

## 1. 发布目标

修复账号状态响应较慢时，旧草稿覆盖报名页当前输入或主动清空内容的问题。首次恢复草稿优先保留手动编辑，未编辑字段继续恢复历史草稿；切换账号、购票对象时继续清空旧资料。

将报名浏览器专项接入 GitHub CI，新增延迟身份响应回归用例。代码改动共 4 个文件，新增 54 行、删除 2 行。

## 2. GitHub 和构建身份

| 项目                        | 本次值                                                                    |
| --------------------------- | ------------------------------------------------------------------------- |
| PR                          | https://github.com/yaojingang/TokEMS/pull/74                              |
| PR CI                       | https://github.com/yaojingang/TokEMS/actions/runs/33886234412 — success   |
| 主分支 CI                   | https://github.com/yaojingang/TokEMS/actions/runs/33887201538 — success   |
| 镜像发布工作流              | https://github.com/yaojingang/TokEMS/actions/runs/33887916759 — success   |
| 目标提交                    | `1afc01d1664406a6e1a08b426258e083a3412ed5`                                |
| 构建时间                    | `2026-09-04T15:10:14Z`                                                    |
| 最高迁移                    | `0059_green_rictor.sql`                                                   |
| 迁移 SHA-256                | `776a677d42968cf0aeafb79ff2920994f2fe32446bf50c1a9d560d7847d14a24`        |
| 发布分支                    | `origin/main`                                                             |
| Release descriptor digest   | `sha256:992e8400eef4c58ec42553b41ea382a6c713cc1d814d557664a2ac0cb76d716e` |
| Source Bundle SHA-256       | `c4092dddd671f6e34694b1b7651607a292dd02a3599bb06d3be70b8d80268e0d`        |
| Descriptor verifier SHA-256 | `1975710a912a17a6a8519bc3011d78edb7d19bef78ae332247b662d1e8831568`        |
| 目标平台                    | `linux/amd64`                                                             |

CI 全部通过后，按既有管理员权限压缩合并；GitHub 分支保护保持原配置。本地主分支已同步，本轮临时分支和工作树已清理。

## 3. 发布前检查

- [x] 服务器工作区干净，`production` 跟踪 `origin/main`
- [x] Compose 与 Nginx 配置通过
- [x] 预构建模式的磁盘和备份容量满足要求
- [x] 单一发布进程，未执行主机构建
- [x] GitHub 必需检查及镜像来源验证成功
- [x] `pnpm check`、`pnpm canonical:check` 和依赖安全检查通过
- [x] 新增回归在旧代码失败，正式构建的 6 项报名浏览器测试全部通过
- [x] 31 项数据库专项及 51 项工具测试通过

## 4. 备份和回滚点

| 项目                | 本次值                                                             |
| ------------------- | ------------------------------------------------------------------ |
| 备份目录            | `/www/backup/TokEMS/20260904-233346`                               |
| 最终数据库 dump     | `/www/backup/TokEMS/20260904-233346/conference.dump`               |
| dump SHA-256        | `acb47d62f5d69f1d9a78dcaa8cc33acadf7be43e332c87ab2228f037c868c8f6` |
| `pg_restore --list` | 已验证，内容非空                                                   |
| 镜像回滚标签        | `rollback-20260904-233346`                                         |
| 对象存储变更        | 本次无对象存储变更                                                 |
| 发布前版本          | `fe294e213e502bdec455e57723b0d2709fac68f2`                         |

## 5. 数据库和模板

本次无新迁移，`db-init` 成功；`SEED_DEMO_DATA=false`，未执行规范模板同步。只读规范核验确认 `geo-conference` / `tokems26` 的完整后台设置及公开内容符合目标快照。生产数据主键与销量保护检查通过。

- 完整规范快照 SHA-256：`b6eede0924a284d687d8923201dc508a6fc52a578f9c2bc70fb4e598ba75138a`
- 前台派生快照 SHA-256：`57464ab82ac2ba7ce876b6233b0956b94b19a6849e1cb4b6a42f06ca1bc02fc4`
- 规范快照脱敏检查通过。

| 数据表           | 写冻结基线 | 只读验收后 | 恢复写入后 |
| ---------------- | ---------- | ---------- | ---------- |
| customer_users   | 45         | 45         | 45         |
| invoice_requests | 2          | 2          | 2          |
| orders           | 37         | 37         | 37         |
| registrations    | 37         | 37         | 37         |
| tickets          | 25         | 25         | 25         |

## 6. 镜像和容器切换

| 服务              | GHCR digest                                                               | 最终状态 |
| ----------------- | ------------------------------------------------------------------------- | -------- |
| api               | `sha256:c0816a62994485152ceba4f53769a4adb04e03d37ce6617bc756eec588969371` | healthy  |
| worker            | `sha256:326d14fe9e9e3e80adbe942af4462e2de458c5f1cb23374d71edfc9ed0101860` | healthy  |
| web               | `sha256:528b894955f0ad9b50dac7ea9352afd130424865e30770d2d292af149a81d2e2` | healthy  |
| admin             | `sha256:7e829433befa36f0771e83cdd13ebc9804f87e446ad8bc1ae51e860592588374` | healthy  |
| gateway           | `sha256:b17dd24088beb64b1f19c7afd50de6fa00828535979b46bffdf300e2316a7565` | healthy  |
| notification-sink | `sha256:bf9e1537ce52291dd6e4494b887b501ebb11dae8c8070984742758f8cf20b486` | healthy  |

Web 和 payment-web 使用同一服务镜像。实际容器 image ID：

- `/tokems-notification-sink-1`：`sha256:90682b11697d4b16706d009c5f79e27212f843095a3e12986d2022d12af3d400`
- `/tokems-api-1`：`sha256:44dcee13f30f453f3c1a5ccafceb931965aa3e9d25303adcae38d60f660d1976`
- `/tokems-worker-1`：`sha256:70f7e365624e4684cb3a05703dc03eff8abdde600be1fe0e178eaf934c495357`
- `/tokems-web-1`：`sha256:76d171fcf1f1067edc96bf8fe09bfaa605828d3384831b7fb5259c6188aa4e12`
- `/tokems-payment-web-1`：`sha256:76d171fcf1f1067edc96bf8fe09bfaa605828d3384831b7fb5259c6188aa4e12`
- `/tokems-admin-1`：`sha256:200ef53519bd7f16ca8617093351cf31f2b36d743b3618e63f205ca89c46ec7d`
- `/tokems-gateway-1`：`sha256:8842d0f0e5f9f98ac62340a6e22deb487997f7259de68e9a08235dfb8fc34558`

## 7. 验证结果

- [x] 七个应用容器全部 healthy
- [x] 服务器源码、远端引用和运行版本均为目标提交
- [x] API 健康、数据库迁移哈希和全部构建身份一致
- [x] 服务器本机与公网首页、后台、支付、版本和健康入口通过验证
- [x] 大会内容、报名表与后台设置符合规范快照
- [x] 报名、订单、票、发票、用户计数以及库存销量保护检查通过
- [x] API/Worker 标准启动命令与 `unless-stopped` 策略已恢复
- [x] 写恢复观察通过，`RECOVERY_REQUIRED` 标记已清除

桌面和手机端最终页面验收结果见本次证据目录中的 `public-acceptance.json`。验收仅访问公开页面并填写未提交的测试内容，未发送短信、创建真实报名或支付。

## 8. 异常和处理

远端镜像验证耗时较长，API 镜像下载触发自动重试，随后全部镜像拉取并验证成功。等待发生于写冻结之前，旧服务持续运行。部署未触发回滚。

新增回归已确认在修复前失败、修复后通过。

## 9. 最终结论

代码复核修复已发布到 `1afc01d1664406a6e1a08b426258e083a3412ed5`。生产业务数据与发布前基线一致，报名和后台写入正常。本次无剩余阻塞项。

本记录保存当次事实，后续操作以当前仓库、CI、服务器健康接口和生产 Runbook 为准。详细证据保存在本地 `.codex-artifacts/production-release/2026-09-04-registration-review/`。
