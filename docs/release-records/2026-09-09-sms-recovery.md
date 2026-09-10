# 2026-09-09 TokEMS 短信验证码恢复记录

> 发布状态：现有版本短信及正常写入已恢复；新版本发布按用户要求暂停
>
> 执行时间：2026-09-09 20:06–20:33，Asia/Shanghai
>
> 操作者：Codex；用户要求优先恢复短信验证码，其余升级后续处理
>
> 长期规则：`docs/production-deployment-runbook.md`；本记录沿用 `TEMPLATE.md` 的证据结构。

## 1. 恢复目标与结果

恢复线上验证码请求入库和短信处理。20:31 左右完成 API 与 Worker 恢复；20:33 查询到恢复后真实验证码短信状态为 `delivered`。保留现有应用版本和数据库结构，本次没有修改短信凭据。

## 2. GitHub 和构建身份

- 当前运行版本：`a04bfaf648832421a3649cd13577c6a75e5b5afd`，恢复前后相同。
- 构建时间：`2026-09-09T01:55:33Z`。
- 最高迁移：`0064_feishu_manual_request_hash.sql`，恢复前后相同。
- 迁移 SHA-256：`459ebfdb97f15ba9da7592e27425f09651c41cb7e98c4914cddc589c7063ac82`。
- 原服务器源码：`e8cf15461982ce94f6108080e6ba92c5430543a8`。
- 服务器源码已经前进到 `34ddc59055beaa7b04d83e1e35fbb62dedb71a98`；该版本未切换为运行版本。
- 目标 PR：<https://github.com/yaojingang/TokEMS/pull/94>，已合并至 `main`，合并 SHA 与目标一致。
- 本次实时核验：主分支 CI `34344847518` 成功，镜像发布 `34345558026` 成功，GitHub `main` 与目标一致。
- 发布清单：`sha256:fb01fc66e4711292efbdf44c9ce6207e816f8703521df64a1948882d853a37ff`；源码 Bundle 与六个服务的来源证明已由服务器核验。

## 3. 故障证据与前置检查

验证码请求日志显示 `POST /api/v1/customer-auth/otp` 在更新 `customer_auth_challenges` 时失败。API 数据库会话实测 `default_transaction_read_only=on`、`transaction_read_only=on`；Worker 命令为仅保持进程存活的定时器。页面访问统计写入也失败。只读健康接口仍返回正常，因此无法反映这次写入故障。

原恢复标记关联 `/www/backup/TokEMS/20260909-181231`，状态为 `phase=write-freeze`、`reason=canonical-update-started`。该次规范同步因 V153 不可变内容冲突失败。服务器保留了只读 API 和暂停 Worker 的保护状态。

本次核实工作区干净、生产环境权限为 root-only、无其他并行发布或禁止的 Docker 全局扫描；Compose、Nginx、应用版本身份、数据库实例身份均通过检查。

## 4. 备份和回滚点

| 证据 | 位置或结果 |
| --- | --- |
| 原故障发布备份 | `/www/backup/TokEMS/20260909-181231/conference.dump`，读取验证成功 |
| 排障启动时额外备份 | `/www/backup/TokEMS/sms-recovery-20260909-201312/conference.dump`，读取验证成功 |
| 完整发布尝试备份 | `/www/backup/TokEMS/20260909-202534` |
| 最终短信恢复备份 | `/www/backup/TokEMS/sms-restore-20260909-203055/conference.dump`，读取验证成功 |
| 最终 dump 校验值 | 同目录 `conference.dump.sha256` |
| 最终镜像回滚标签 | 六个现有应用镜像均添加 `rollback-20260909-203055` |
| 配置及原恢复标记 | 最终恢复目录内 `production.env.before`、`RECOVERY_BEFORE`，仅服务器 root 可读 |
| 运行及验证结果 | 最终恢复目录内 `sms-restore-result.txt` 和前后业务数据证据 |

对象存储和其他数据卷保持现状。

## 5. 数据库和大会模板

未执行本次数据库迁移或大会规范同步。恢复前后业务计数核验通过：用户 52、报名 41、订单 41、票 29、发票申请 3。受保护主键、票种销量与配额销量通过前后比较；恢复写入后允许正常新增业务记录。

公开大会内容使用恢复前实时数据作为基线，恢复后完整投影比较通过。V154 规范同步按用户要求延期。

## 6. 执行过程和容器

先启动标准 `deploy --resume-recovery --target-sha 34ddc59055beaa7b04d83e1e35fbb62dedb71a98`。发布清单下载约 15.9 MB，完成来源证明后，服务器源码前进至目标。用户要求优先恢复短信时，任务仍在准备镜像，尚未执行迁移或规范同步。随后通过 TERM 结束该任务，退出码 143；退出保护停止了 API 和 Worker。

之后启动原有只读容器完成基线核验，执行服务器 root-only 应急控制脚本 `sms-recovery-20260909-201312/restore-current.sh`。该脚本复用仓库现有版本身份、数据库身份、备份、数据保护和解除冻结函数，在恢复写入前启动独立 systemd 监督单元。API 和 Worker 使用原镜像及正常数据库连接重建，Worker 恢复 `node dist/main.js` 并生成持久 ready 身份。稳定观察与数据保护通过后，恢复原重启策略并归档恢复标记。

原发布任务与应急恢复控制任务均已结束；监督流程正常结束。其他升级没有继续执行。

## 7. 最终验证

- API、Worker 均 healthy；版本、迁移哈希和数据库实例身份一致。
- 数据库 `default_transaction_read_only=off`。
- 真实 `CustomerAuthService.requestOtp` 路径通过数据库事务验证；验证事务已回滚，没有产生测试短信或持久测试记录。
- 组织短信服务开启，账号和验证码模板均为 `verified`，加密凭据可正常读取。
- 恢复后真实验证码短信最初为 `accepted`，随后查询到 `delivered`，计数 1。
- `RECOVERY_REQUIRED` 已归档，解除冻结完成。
- 公网健康、版本及首页接口均 HTTP 200；`status=ok`、迁移检查成功，当前大会 `tokems26`。
- 公网证据保存在本地 `artifacts/2026-09-09-sms-recovery/public-verification.json`。

## 8. 异常和处理

标准恢复下载较慢，用户明确要求先恢复登录，因此收窄为现有版本服务恢复。完整升级安全退出后 API/Worker 处于停止状态；应急脚本首次基线检查因此停止，随后启动原只读容器并成功重跑。诊断命令中出现过终端引用和工具版本兼容错误，均发生在读取检查阶段，未修改业务数据。

## 9. 最终结论与后续事项

短信验证码能力已恢复并有真实送达回执。现有应用保持 `a04bfaf`，服务器源码为已验证的 `34ddc59`。后续发布需重新核验当前生产数据和规范状态，再完成 V154 同步及新应用镜像切换；当前已无待恢复标记，后续使用正常发布流程。

本次没有提交或推送新的业务代码。本记录为本地未提交的运维证据。后续以当前 Git、CI、生产健康接口和 Runbook 为准。
