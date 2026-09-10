# 2026-09-09 TokEMS 生产恢复记录

> 发布状态：已恢复，规范同步成功，生产写入已恢复
>
> 执行时间：2026-09-09 11:15–11:25，Asia/Shanghai
>
> 操作者：Codex，用户授权修正本次生产发布故障
>
> 长期规则：`docs/production-deployment-runbook.md`

## 1. 发布目标

恢复大会首页、接口及后台任务服务，保留已同步嘉宾资料及业务数据。修正规范核验虚拟内存预算、回滚 Web 迁移标记及只读覆盖原子写入。

## 2. GitHub 和构建身份

目标提交：`92391e45828a345a642b1ea0c8e96d56eed55421`，已合并 [PR #91](https://github.com/yaojingang/TokEMS/pull/91)。PR CI `34304650582` 全部通过，主分支 CI `34305214450` 与镜像发布 `34305699213` 全部通过，含六个服务与经过证明的最终 descriptor。已执行 `deploy --resume-recovery --target-sha 92391e45828a345a642b1ea0c8e96d56eed55421 --sync-canonical`。

| 项目 | 本次值 |
| --- | --- |
| 服务器源码 HEAD | `92391e45828a345a642b1ea0c8e96d56eed55421` |
| 实际应用运行 SHA | `a04bfaf648832421a3649cd13577c6a75e5b5afd` |
| 策略 | `verified-runtime-reuse`；仅部署脚本、测试和运维文档变化，规范快照相同 |
| 应用构建时间 | `2026-09-09T01:55:33Z` |
| 最高迁移 | `0064_feishu_manual_request_hash.sql` |
| 迁移 SHA-256 | `459ebfdb97f15ba9da7592e27425f09651c41cb7e98c4914cddc589c7063ac82` |
| 目标 descriptor digest | `sha256:e9fdf0ec72c41f1b93ca5f278042f8538f1afd7c89f1c40e81e5fe47f3dbd9d7` |
| Source Bundle SHA-256 | `51117f33e84957f7836b479a427e6c9b24a559add1d3328921dbb2b3651aa722` |
| Descriptor verifier SHA-256 | `43e69e2b4f86a38440f048c16f28d1b66a846c7c8ab96fa8f848e8257e76efb0` |
| 平台 | `linux/amd64` |

以上身份来自服务器新备份内的 `deployment-result.txt` 与线上版本接口。版本接口保持返回经过验证并复用的应用 SHA `a04bfaf`。

## 3. 发布前检查

本地隔离完整检查、部署专项测试、Linux/Python 3.6 内存预算回归、Compose 回滚配置和写入失败注入通过。安全、架构和假设复核完成，原子写入失败处理的发现已修正并重新验证。规范快照门禁和暂存区敏感信息扫描通过。

服务器发布脚本完成工作区、生产分支、并行锁、备份容量、Compose、GitHub 证明与来源 Bundle 验证；生产源码快进到目标提交。结束后再次检查服务器工作区，无未提交修改。Nginx 配置验证成功。

## 4. 备份和回滚点

原故障备份目录：`/www/backup/TokEMS/20260909-101552`。
原回滚镜像标签：`rollback-20260909-101552`。
原运行提交：`67fbd57617681e4a246ad4b7ea5c78e7e31a4121`。
失败发布目标：`a04bfaf648832421a3649cd13577c6a75e5b5afd`。
原 `conference.dump` 为 686993 字节，SHA-256 与保存的校验值一致，`pg_restore --list` 返回 0。以 512 MiB 预算重新执行原核验程序，发布前后所有受保护主键、计数及销量比对通过；报名 38→38、订单 38→38、票 26→26。本次恢复继续保留该目录。

| 项目 | 本次值 |
| --- | --- |
| 新备份目录 | `/www/backup/TokEMS/20260909-111504` |
| 新数据库备份 | `/www/backup/TokEMS/20260909-111504/conference.dump` |
| 新备份 SHA-256 | `fa0a2ca528fdb06bb45cf5cfcf603a8d456dc151faa41e5bdaccf8825daceac5` |
| 校验结果 | `sha256sum -c` 成功；`pg_restore --list` 返回 0 |
| 新回滚镜像标签 | `rollback-20260909-111504` |
| 对象存储 | 原数据卷保持，恢复流程未执行覆盖或清理 |

## 5. 数据库和模板

故障现场数据库已迁移至 `0064_feishu_manual_request_hash.sql`。此次采用当前应用镜像执行规范修复同步，无新增数据库迁移。`geo-conference` / `tokems26` 完整规范核验成功；停止写入期间与解除写冻结后的两次业务数据保护核验通过，包含受保护主键、计数、票种及配额销量。

| 数据 | 同步前 | 恢复写入后 |
| --- | ---: | ---: |
| 用户 | 47 | 47 |
| 报名 | 38 | 38 |
| 订单 | 38 | 38 |
| 票 | 26 | 26 |
| 发票申请 | 3 | 3 |

完整快照 SHA-256：`c439ffe0574ed1b0fb8108a6001d8b9a6d4ba07fe8e7bdeec07bb76868d05100`。
前台快照 SHA-256：`7d066e7d8b000d75618b42ba237dd59515ed40c6c22c9fb9af4e385f2e93cbf4`。
本次未修改规范快照；脱敏校验通过。

## 6. 镜像和容器切换

以下六个服务使用 `ghcr.io/yaojingang/tokems-production-private` 已验证的 `a04bfaf` 应用镜像。表内 digest 来自服务器实际镜像的 `RepoDigests`，Image ID 记录可识别前缀。

| 服务 | GHCR digest（sha256） | 实际 Image ID 前缀 | 最终状态 |
| --- | --- | --- | --- |
| API | `2ed56edaa61c4e1426ec8c495997abf2d56d8de9b5f587759f4df282c3b775f8` | `18192016e3a6` | healthy |
| Worker | `400405becdd140bd4f1eab7755b5a99dc86096503a2934c6247dba37351a9df7` | `974fdc7b6315` | healthy |
| Web / payment-web | `b62ba5ff748bf8511c4968b34a7004211bd802c5c9f71702c1896c10871a0b5d` | `61aeb45c2f38` | 两个容器均 healthy |
| Admin | `7aee6f9c48514ff9c634a50138b2aca1c59c8d678177a9f80aad62cf84bb4a85` | `34849c013819` | healthy |
| Gateway | `f51abfc9ac58044eaf9ffe43cbee47448a5a16c98cf7dcb5cd6217022831a26c` | `52100bb5a74c` | healthy |
| notification-sink | `d0ebfecc942b1ba03bee065c35dce418eda0838cc50421f74706cfc2ef335086` | `79f127375e07` | healthy |

API 和 Worker 已恢复正常写入；Worker 启动维护和持久就绪身份通过核验。数据库、Redis、MinIO、Mailpit 均 healthy。`/www/backup/TokEMS/RECOVERY_REQUIRED` 已由成功流程清除，恢复监督流程正常结束。

## 7. 验证结果

发布脚本完成服务器本机 HTTP、容器、构建身份、迁移哈希、规范内容与业务数据核验。解除写冻结后观察 15 秒，再次核验数据保护通过。

11:22 的独立公网检查如下；另在 Chrome 中确认大会首页已正常渲染，未显示故障页。

| 入口 | HTTP | 结果 |
| --- | --- | --- |
| `https://hui.ailingdaoli.com/` | 200 | 大会首页正常 |
| `https://hui.ailingdaoli.com/api/v1/homepage` | 200 | `tokems26`；21 位嘉宾，与规范快照一致 |
| `https://hui.ailingdaoli.com/api/v1/health` | 200 | `status=ok`，数据库及迁移一致 |
| `https://hui.ailingdaoli.com/version.json` | 200 | Gateway 身份为 `a04bfaf` / `0064` |
| `https://hui.ailingdaoli.com/web-version.json` | 200 | Web 身份为 `a04bfaf` / `0064` |
| `https://admin.hui.ailingdaoli.com/admin/` | 200 | 后台页面正常 |
| `https://www.ailingdaoli.com/pay/hui/` | 200 | 支付入口页面正常 |
| 全部 21 位嘉宾公开详情接口 | 200 | 姓名、角色、简介、主题、主题介绍及标签与完整快照逐项一致 |

冷洪利名称及“曝光率GEO创始人”介绍符合用户指定内容，新增任开心资料已上线。支付核验覆盖入口可访问性和发布脚本结清门禁，本次没有发起真实支付。

本地证据保存在 `artifacts/2026-09-09-production-recovery/`，含检查日志与 `public-verification.json`；服务器证据位于新备份目录，含 `deployment-result.txt`、同步前后及恢复写入后的数据保护记录。

## 8. 异常和处理

Python 3.6 启动 VmSize 为 231128 KiB，原 256 MiB 上限读取 14612180 字节规范快照时报 MemoryError；同一现场只读探针在 512 MiB 下通过，峰值 RSS 81124 KiB。
回滚时 Web 从运行环境返回 0064 迁移、Gateway/Admin 从旧镜像返回 0062，构建身份检查失败，API/Worker 退出。原故障发布进入保护状态并保留恢复证据。

修复将核验进程预算提高到 512 MiB，并在常规停写前执行真实规范 JSON 解码预检；回滚 Web 和 payment-web 的迁移标记与旧镜像对齐；只读 Compose 覆盖文件改为原子写入，恢复期间使用新的临时覆盖文件。新版本成功通过受保护恢复，期间未再次触发失败回滚。

## 9. 最终结论

大会前台、后台和支付入口恢复，21 位嘉宾资料已核验一致，生产写入正常，备份可读取，受保护业务数据和销量保持。

服务器源码为 `92391e4`，应用复用经验证的 `a04bfaf`，迁移为 `0064`；这是此次脚本修复与规范同步策略的预期状态。后续发布继续使用标准入口及已合并、主分支 CI 与镜像发布通过的目标提交。本次未发现阻止正常运行的剩余问题。
