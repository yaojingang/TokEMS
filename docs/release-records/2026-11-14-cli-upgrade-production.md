# 2026-11-14 TokEMS CLI 0.4 生产发布记录

> 发布状态：成功，正常写入及 Worker 已恢复，恢复标记已清除。
>
> 完成时间：2026-11-14 21:40:24，Asia/Shanghai（`2026-11-14T13:40:24.375618Z`）。
>
> 操作者：Codex，经用户授权。执行规范：`docs/production-deployment-runbook.md`。

## 1. 发布目标

CLI 0.4.0、Agent catalog 2.0.0 上线，提供授权预设、逐动作授权、模板拉取/比较/编辑/预览/上传及发布结果核验。此次包括七项复审修复，以及 Nuxt 4.6.4、node-forge 1.4.3 的六项安全公告修复。现行大会 37 项议程、33 位嘉宾及生产业务数据完整保留。

Agent 开关为 access=true、writes=true、criticalActions=false。旧连接需按新 catalog 重新授权；客户端最低版本为 0.4.0。

## 2. GitHub 和构建身份

| 项目 | 本次值 |
| --- | --- |
| CLI 与复审修复 | [PR #176](https://github.com/yaojingang/TokEMS/pull/176)，合并 `a775c35a2e7e0c2fefed93dabd3654b46505b997` |
| 不可变版本恢复 | [PR #179](https://github.com/yaojingang/TokEMS/pull/179)，合并 `b7c14a83b59a0301ab33572a7f3e9ed74157967e` |
| 公开发布身份修复 | [PR #180](https://github.com/yaojingang/TokEMS/pull/180)，目标为其 merge commit |
| 目标提交 | `4ca2d9db9f7f22d6eff33bd864bade3c39e8858d` |
| 目标 PR CI | [43597172843](https://github.com/yaojingang/TokEMS/actions/runs/43597172843)，成功 |
| 目标主分支 push CI | [43598358065](https://github.com/yaojingang/TokEMS/actions/runs/43598358065)，成功 |
| 六镜像及 descriptor 工作流 | [43599331211](https://github.com/yaojingang/TokEMS/actions/runs/43599331211)，成功 |
| 构建时间 | `2026-11-14T13:21:21Z` |
| 最高迁移 | `0072_absent_skaar.sql` |
| 迁移 SHA-256 | `595e1a8a59e0821a9ab83bc94c82c4e4555a857ae23cf6618d91d4245681c343` |
| 发布源码 | 官方 `origin/main`，生产 `production` 跟踪该分支 |
| Release descriptor digest | `sha256:f844e8f40091c9403dcb3e09a239f29ae1a32991e71e7fc8a7e16529e8c1c329` |
| Source Bundle SHA-256 | `a0920fbadb7081ea7192b40341eea44322c8a33082dcd9261142df7363f19b85` |
| Descriptor verifier SHA-256 | `43e69e2b4f86a38440f048c16f28d1b66a846c7c8ab96fa8f848e8257e76efb0` |
| 目标平台 | `linux/amd64` |

生产入口独立核对合并 PR、精确 SHA 的主分支 CI、完整镜像发布及 GitHub provenance，再导入固定 ref 的 Bundle。部署结束时服务器 HEAD 与 origin/main 均为目标提交，工作区干净。后续发布记录文档提交单独归档，应用运行版本以本记录目标 SHA 为准。

## 3. 发布前检查

- [x] 服务器工作区干净，发布分支跟踪关系正确，无并行发布任务。
- [x] Compose 与 Nginx 配置通过；预构建路径的备份、磁盘和数据验证容量门禁通过。
- [x] 六服务来源证明及不可变镜像摘要通过；下载代理只作用于发布客户端。
- [x] GitHub 必需检查成功，精确 SHA 已通过 PR 合并。
- [x] 本地完整 `pnpm check`、规范导出/检查及实际 pre-push 门禁通过。
- [x] 公开发布身份回归测试在修复前出现两项失败，修复后规范测试 24 项通过，数据库测试 80 项通过；40 项环境用例本地跳过，隔离 CLI 和运营流程由 CI 执行并通过。
- [x] 独立安全复核通过；用失败部署保存的观测数据重跑原有完整和公开校验，均通过。

## 4. 备份和回滚点

| 项目 | 本次值 |
| --- | --- |
| 最终成功发布备份目录 | `/www/backup/TokEMS/20261114-213212` |
| 最终 PostgreSQL dump | `/www/backup/TokEMS/20261114-213212/conference.dump` |
| dump SHA-256 | `e11ee92b2e00c0fac7aebd4bf7147803492bbfa69866b70891dc565b70d0f4f2` |
| dump 大小 | 3,972,498 bytes |
| `pg_restore --list` | 成功，930 行 |
| 镜像回滚标签 | `rollback-20261114-213212` |
| 发布前运行版本 | `3e8635be5ae53776a8917f0c329074e1a2b18414` |
| Nginx 独立备份 | `/www/backup/TokEMS/nginx-agent-20261114-105555` |

先前尝试的备份 `/www/backup/TokEMS/20261114-190026`、`20261114-192544` 和 `20261114-203445` 及相应回滚标签均保留。现有数据库、MinIO、Redis 持久卷保留；未执行数据库覆盖恢复或对象存储全量备份。规范素材的内容摘要及引用通过完整验收。

## 5. 数据库和模板

无新增迁移；`SEED_DEMO_DATA=false` 的迁移步骤成功，规范同步阶段单独启用幂等 seed。规范组织/大会为 `geo-conference` / `tokems26`，当前发布为 V318，ID 为 `bcccd1a1-6f21-4b6f-a104-a6c8b69dffd0`。

完整规范经生产只读数据库重新导出，按既有环境字段与素材映射规则严格比较通过；公开 API、首页、独立大会页均通过验收。V318 的不可变 snapshot 保留原内容，公开 releaseId 与当前数据库发布身份一致。

| 规范快照 | SHA-256 |
| --- | --- |
| 完整快照 | `bcddc529d0aff98106e811652610b2991734493174be9ee75182c4a0ad64c9e0` |
| 前台派生快照 | `96f97f7be540be7a6db64a588de75abdaf487634dc000926a312370830d73e39` |

快照通过脱敏检查，管理员身份、凭据、个人数据、交易数据、销量与审计记录均未进入快照。

| 业务计数 | 最终冻结基线 | 只读验收后 | 恢复写入后 |
| --- | ---: | ---: | ---: |
| 用户 | 635 | 635 | 635 |
| 报名 | 538 | 538 | 538 |
| 订单 | 471 | 471 | 471 |
| 票 | 488 | 488 | 488 |
| 发票申请 | 99 | 99 | 99 |

三种票种合计 sold=467，一条配额 sold=0；冻结前后逐行和 SHA-256 一致。额外从首次冻结基线核对：16,050 条稳定记录主键全部保留，仅增加一条 V318 发布记录；1,456 条保留期记录均保留，销量一致。正式发布在恢复写入前后再次完成完整生产数据保护验证。

## 6. 镜像和容器切换

唯一镜像包为 `ghcr.io/yaojingang/tokems-production-private`。六个 descriptor digest 与成功工作流产物逐项一致；以下实际 image ID 与运行容器一致，Web 镜像供 Web 和 payment-web 共用。

| 服务 | GHCR digest | 实际 image ID |
| --- | --- | --- |
| api | `sha256:2f5d309eab98e44847111350912a3e7ac12ceea66d4ba3e7dfa8f2122d51401e` | `sha256:ae54d85c7b0dae26aeb7b9a6dddb8aedcb4b32f9f50d844146dabe9e88831d2d` |
| worker | `sha256:f755acdea6b6e5f5f8e44ffdb63c05cea85764575a1875e5426046c3cfdba42e` | `sha256:49fde39c7994d68ef55a987008735fc71df304b8aa26a7851481d5ed6424e6c5` |
| web | `sha256:b30004ce63e1514a604cc5d4ea783cd793298b74207e0241c0f22a2833c53c82` | `sha256:26756a095b91438d5ac583070ba16932006966e908085424f1a7f947873217ac` |
| admin | `sha256:0ee98ace2b29b90cbd3e2d8ddbf979b964e0046888aefefef01be93c1a5c6be0` | `sha256:c283052304bd8cf9a7d7710fd6a85c70063d2549a8e07bdedec267707e6a798c` |
| gateway | `sha256:6f6675cc5d7fbde71788fe6cc3711a9ca9841899e143b496cd58788a17fc0dca` | `sha256:50754ffd4e2ce2da2c85b1511f039d5c80cf07503b80e924bd9612fd97d7fd31` |
| notification-sink | `sha256:4771efb24470c215f2a38200b3f4c0f631115053c955ed42d5f1b543e8da7721` | `sha256:ab88539c76453eea0e4ac3649c972452bd8b4631f99801d4f9f43eb2bcb89e59` |

应用与 PostgreSQL、Redis、MinIO、Mailpit 共 11 个长期容器全部 running/healthy。API 已解除只读连接，Worker 消费者启动并通过持久 ready 身份校验；独立检查确认恢复标记不存在。

## 7. 验证结果

- [x] 五类构建身份、迁移名称及哈希一致。
- [x] 服务器本机与公网 HTTP、完整规范、公开内容、生产记录及销量验收通过。
- [x] 恢复写入后的生产数据复验通过，独立核实正常 API 与 Worker。
- [x] 外层两站点 Nginx 安装独立 Agent 入口扩展，配置检查与 reload 成功，保留原 TLS、站点及根首页配置。
- [x] 两域名共四个发现接口返回 200；六个无效预览请求返回 400/401/404 并带 no-referrer。
- [x] 宿主机四个访问/错误日志及 Gateway 日志中测试预览标记均不存在；普通健康请求标记同时存在，作为正向对照。
- [x] 实际 CLI `instance inspect` 成功，返回 package/minClient=0.4.0、catalog=2.0.0 和预期三个开关。

| 公网入口 | HTTP | 内容结果 |
| --- | ---: | --- |
| 根首页与 `/tokems26` | 200 | 当前大会页面 |
| 管理后台 | 200 | 页面可访问 |
| `/pay/hui/` | 200 | 支付页面可访问 |
| 前台与后台 `version.json` | 200 | 目标 SHA |
| API health | 200 | status=ok，数据库和迁移正常，目标 SHA |
| homepage API | 200 | tokems26、V318、37 项议程、33 位嘉宾 |

## 8. 异常和处理

1. 初次下载通过临时代理速度不足，在任何数据库写入前受控取消；旧应用恢复。随后改用当前系统 HTTP 代理的独立 SSH 回环转发，发布日志中的签名下载 URL query 全部脱敏，保持 pipeline exit code。
2. V315 的本地内容与生产历史内容不同，第一次规范同步事务回滚。生产最高版本为 V317；保留双方历史，本地追加 V318 承载同一目标内容，经 PR #179、主分支 CI 和完整镜像发布后前向恢复。
3. V318 同步成功后，严格验收发现目标快照缺少新 API 的 `publicEvent.releaseId`。原校验规则归一化后仅此字段有差异。PR #180 从锁定的数据库发布身份补齐字段，并拒绝 API 返回的错误身份；两份规范各增加该字段，V318 不可变内容保留。生产原有严格校验继续执行并最终通过。
4. 两次失败后应用自动回到旧版本只读访问，Worker 消费者停止，RECOVERY_REQUIRED 保留。最终通过标准 `deploy --resume-recovery --target-sha 4ca2d9db9f7f22d6eff33bd864bade3c39e8858d --proxy http://127.0.0.1:1081` 恢复，完整保护门禁均通过后自动解冻。

首次冻结基线时间为 2026-11-14 19:32:42（11:32:42 UTC），本次于 21:40:24 完成。异常恢复使只读保护延长约 2 小时 08 分；期间报名、后台保存、支付回调处理及异步任务受限，公开页面由旧版只读服务提供，容器切换有短暂维护窗口。发布完成后写入与 Worker 均恢复。全程未覆盖数据库、不可变历史或恢复标记。

## 9. 最终结论

- 最终状态：成功，恢复标记已自动清除；运行提交为本记录目标 SHA。
- 线上迁移：0072_absent_skaar.sql，哈希与 descriptor、构建及数据库一致。
- 回滚点：`rollback-20261114-213212` 及本记录所列备份。既有旧版 Git 规范与运营内容有差异，应用回滚可能继续进入受保护恢复；须按 Runbook 完成验证，保留前向恢复能力。
- 依赖例外：用户于 2026-11-14 明确批准 GHSA-gcqx-w48m-w2h4（deepmerge，低危构建链）延至 2026-11-21 00:00 UTC；其余审计继续阻断发布。
- 后续事项：旧 CLI 连接重新授权；在例外到期前按 `docs/security-audit-exceptions.md` 处理修复或重新取得明确授权。
- 本地其他工作树和未完成编辑保留，共享预览未被本发布工作树替换。
