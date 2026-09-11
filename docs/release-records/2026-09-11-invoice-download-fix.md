# 2026-09-11 TokEMS 生产发布记录

> 发布状态：已发布
>
> 执行时间：2026-09-11 18:14，Asia/Shanghai
>
> 操作者：项目维护者（通过 `/usr/local/sbin/tokems-deploy` 执行）
>
> 长期规则：`docs/production-deployment-runbook.md`

## 1. 发布目标

- 本次用户可见变化：个人中心发票文件下载链接改为短路径，并由应用直接安全流式返回 PDF。
- 本次代码和数据范围：PR #98、发票访问链接用途扩展、发票文件读取逻辑、迁移 `0067_majestic_songbird.sql`、相关前后端测试，以及规范快照同步。
- 明确不进入本次发布的内容：不替换既有发票对象，不删除订单、报名、票证或用户数据，不执行数据库覆盖恢复。

## 2. GitHub 和构建身份

| 项目                        | 本次值 |
| --------------------------- | ------ |
| PR                          | [#98](https://github.com/yaojingang/TokEMS/pull/98) |
| CI                          | `tokems-ci` run `34584467827`，成功 |
| 镜像发布工作流              | `tokems-image-publish` run `34585350973`，成功 |
| 目标提交                    | `fd2086ffebe157458b916124b540ab610bd39eb2` |
| 构建时间                    | `2026-09-11T09:40:07Z` |
| 最高迁移                    | `0067_majestic_songbird.sql` |
| 迁移 SHA-256                | `753eaafcce0ef7f8f0a74a39490849708f666cc86f9838ea7a1aeb6e03a91358` |
| 发布分支                    | `origin/main` |
| Release descriptor digest   | `sha256:aa9bb0819b4f10182522203d8d0555880e7341918aa66a93ea6add3b2c46db78` |
| Source Bundle SHA-256       | `89907cec3f24ff948c8ce49162eba52b7d876433c33769a89f2c14fc847c2131` |
| Descriptor verifier SHA-256 | `43e69e2b4f86a38440f048c16f28d1b66a846c7c8ab96fa8f848e8257e76efb0` |
| 目标平台                    | `linux/amd64` |

## 3. 发布前检查

- [x] 服务器工作区干净
- [x] `production` 跟踪 `origin/main`
- [x] Compose 配置通过
- [x] Nginx 配置通过
- [x] 预构建镜像和备份容量门禁通过；本次未在生产机执行构建
- [x] 没有并行发布任务
- [x] GitHub 必需检查成功

## 4. 备份和回滚点

| 项目                 | 本次值 |
| -------------------- | ------ |
| 备份目录             | `/www/backup/TokEMS/20260911-181455` |
| 数据库 dump          | `conference.dump` |
| dump SHA-256         | `a62501c11224ea9ed6fa31539073a5ee05032ccda9599105e2d9b424dfb04d25` |
| `pg_restore --list`  | `conference.dump.list`，存在且已通过发布脚本校验 |
| 镜像回滚标签         | `rollback-20260911-181455` |
| MinIO 或对象存储备份 | 不适用：本次只变更发票访问链路，没有修改对象内容或对象存储配置 |
| 发布前版本           | `7eff369979d3bbf41e22812afb136970241db5af` |

构建开始时的数据库备份 SHA-256 为 `332ca1807b1a71b69c6cf4a92714cd9fdb520e4f1ad6071c2607d7efa0a7ce12`。

## 5. 数据库和模板

- 是否包含新迁移：是，`0067_majestic_songbird.sql`
- `db-init` 结果：成功，`SEED_DEMO_DATA=false` 完成应用迁移；规范同步阶段按发布脚本执行了受保护的模板同步。
- 是否执行规范模板同步：是
- 规范组织和大会：`geo-conference` / `tokems26`
- 规范快照检查：生产发布脚本预检和同步验收成功
- 目标提交完整规范快照 SHA-256：`edc555c5d5bf764257c4ab7fba2bfc76327edad6b3930dd2d8cd2c4f765e63f8`
- 目标提交前台派生快照 SHA-256：`e472c9d927cd20f419dac8058a405e4ac8fe586b7e9acd14423db3ca2d96e175`
- 服务器同步后运行态规范快照 SHA-256：`a204e9ac255e0abc155ce52ab9fc53bf0bccc1c4352d2cfd51901dd9195f879f`
- 脱敏检查：发布脚本完成规范快照安全校验，未写入管理员身份、凭据、个人数据或交易数据。
- 同步前/后业务计数：`customer_users=123`、`invoice_requests=12`、`orders=102`、`registrations=103`、`tickets=85`，前后保持一致。
- 票种和配额销量校验：发布前后无差异。

## 6. 镜像和容器切换

| 服务              | 镜像摘要 | 最终状态 |
| ----------------- | -------- | -------- |
| API               | `sha256:997feb8f445211fbf4e7e688e03d6dc22929479a483e0c81fd94803685464ee8` | 已切换并通过验收 |
| Worker            | `sha256:2b063dc58155114bc4abeb9384b19f22a45367622cc6ba9214fa0a50f92649f1` | 已切换并通过验收 |
| Web / payment-web | `sha256:465d0bb5fe5b5e0eb5b5fd9a307764fb5a853cb797e6f71a55e1cd4a472b977` | 已切换并通过验收 |
| Admin             | `sha256:f13aa09a6d5bb7db527ed7679e097bf3adadb7aeb4d936e7aa0c399871cbcba9` | 已切换并通过验收 |
| Gateway           | `sha256:792250f61ef21746a45c292b5418aa48e6c51d269c53258ff0c623b701ffa9fb` | 已切换并通过验收 |
| notification-sink | `sha256:63d5a6a3706035f8263074752c294faed5c20a4ce4cb934c7739c7f25d2568cc` | 已切换并通过验收 |

## 7. 验证结果

- [x] 长期服务容器完成健康验收
- [x] `version.json.sha` 等于目标提交
- [x] API `status=ok`
- [x] `database.migration.ok=true`
- [x] 服务器本机和公网首页、后台、支付页可访问，公网状态均为 `200`
- [x] 当前大会为 `tokems26`
- [x] 规范首页和后台设置与已验证发布快照一致
- [x] 报名、订单、票种、发票和库存数据保持预期
- [ ] 真实用户登录个人中心并下载一份 PDF：待使用线上已有已开具发票完成业务验收

公网检查摘要：

| 入口     | HTTP 状态 | 版本或内容结果 |
| -------- | --------- | -------------- |
| 大会前台 | `200` | 可访问 |
| 运营后台 | `200` | 可访问 |
| 支付页面 | `200` | 可访问 |
| 版本接口 | `200` | `fd2086ff` / `0067_majestic_songbird.sql` |
| 健康接口 | `200` | PostgreSQL 正常，迁移 expected/applied 一致 |

## 8. 异常和处理

- 异常：生产运行版本从 `7eff3699` 落后于本次目标提交的直接父提交 `9c25496a`；预检检测到生产规范快照漂移。
- 影响：本次发布同时补齐 PR #97 的支付返回链接修复及其 smoke 测试，并执行受保护的规范模板同步。
- 根因：生产发布前未及时追平已合并的 PR #97；规范模板运行态与目标快照存在漂移。
- 处理：发布脚本按 Fast-forward 更新到 `fd2086ff`，同步 `geo-conference/tokems26` 规范模板，完成数据计数和销量复核。
- 是否触发回滚：否。

## 9. 最终结论

- 最终状态：已发布，健康检查和数据保护验收通过。
- 线上提交：`fd2086ffebe157458b916124b540ab610bd39eb2`
- 线上迁移：`0067_majestic_songbird.sql`，SHA-256 `753eaafcce0ef7f8f0a74a39490849708f666cc86f9838ea7a1aeb6e03a91358`
- 回滚点：`rollback-20260911-181455`，数据库备份位于 `/www/backup/TokEMS/20260911-181455/conference.dump`
- 剩余风险：尚缺真实已登录用户的发票 PDF 下载验收证据；代码路径和部署层验证已通过。
- 下次发布前事项：补齐本次线上发票下载业务验收结果，并继续保留发布备份和回滚标签。

本记录不得包含 `.env` 全文、数据库连接、密码、密钥、令牌、私钥或用户隐私数据。
