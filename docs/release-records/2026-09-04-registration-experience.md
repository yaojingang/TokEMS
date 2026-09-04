# 2026-09-04 报名体验优化生产发布记录

> 发布状态：已发布，API 和 Worker 正常写入已恢复，恢复标记已归档。
>
> 最终服务器复验：2026-09-04 22:34，Asia/Shanghai。
>
> 操作者：Codex，用户已授权上线、修复、PR 合并与主分支同步。
>
> 长期规则：`docs/production-deployment-runbook.md`

## 1. 发布目标

- 报名入口缩短为 `https://hui.ailingdaoli.com/register/tokems26`，兼容旧参数链接。
- 后台邮箱字段可关闭，前台读取已生效的报名表配置；当前邮箱隐藏，职位、所在城市为选填。
- 表单保留一个默认勾选的报名条款选项，蓝色链接打开居中弹窗，关闭后保留表单内容。
- 保留生产独立维护的 18 位嘉宾、28 项议程和嘉宾短地址，沿用单一大会通票展示及现有 FAQ。
- 发布使用全新大会版本 V30、报名表 V8、条款版本 `2026-09-04`。退款流程方案和依赖升级 PR 未纳入本轮。

## 2. GitHub 和构建身份

| 项目                        | 本次值                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------- |
| 报名优化 PR                 | [#71](https://github.com/yaojingang/TokEMS/pull/71)                                |
| 内容保留修复 PR             | [#72](https://github.com/yaojingang/TokEMS/pull/72)                                |
| 发布时间比较修复 PR         | [#73](https://github.com/yaojingang/TokEMS/pull/73)                                |
| 最终主分支 CI               | [33881907323，成功](https://github.com/yaojingang/TokEMS/actions/runs/33881907323) |
| 最终镜像发布                | [33882714376，成功](https://github.com/yaojingang/TokEMS/actions/runs/33882714376) |
| 目标提交                    | `fe294e213e502bdec455e57723b0d2709fac68f2`                                         |
| 构建时间                    | `2026-09-04T14:15:58Z`                                                             |
| 最高迁移                    | `0059_green_rictor.sql`                                                            |
| 迁移 SHA-256                | `776a677d42968cf0aeafb79ff2920994f2fe32446bf50c1a9d560d7847d14a24`                 |
| 发布分支                    | `production` 跟踪 `origin/main`，两者 HEAD 一致，服务器工作区干净                  |
| Release descriptor digest   | `sha256:7e00f327bbff2df407d50901601c3fbac41ca5eac9464497f238b79c9c2c1c88`          |
| Source Bundle SHA-256       | `5ce083e212ee124b59d8a5c223ed611ee3532369d803f51eef00e5217d17d102`                 |
| Descriptor verifier SHA-256 | `1975710a912a17a6a8519bc3011d78edb7d19bef78ae332247b662d1e8831568`                 |
| 目标平台                    | `linux/amd64`                                                                      |

## 3. 发布前检查

- [x] 服务器工作区干净，官方上游和目标提交核对通过。
- [x] 合并 PR、主分支 CI、六个私有镜像及发布清单均通过证明验证。
- [x] Compose、Nginx、磁盘、备份容量、当前容器身份和恢复状态检查通过。
- [x] 新部署脚本从已验证的源码 Bundle 加载；全程使用预构建镜像。
- [x] 生产环境目录权限 `0700`，环境文件及 GHCR 只读凭据权限 `0600`。

## 4. 备份和回滚点

| 项目                | 本次值                                                             |
| ------------------- | ------------------------------------------------------------------ |
| 最终备份目录        | `/www/backup/TokEMS/20260904-222637`                               |
| 数据库备份          | `/www/backup/TokEMS/20260904-222637/conference.dump`               |
| dump SHA-256        | `b90130134bbf66ff47ebc2667a73065f8238ded0b2e2c795a1879a64afe27423` |
| `pg_restore --list` | 已通过                                                             |
| 镜像回滚标签        | `rollback-20260904-222637`                                         |
| 发布前运行版本      | `4579248e5eb645df530b999a9c955b6369ba58ca`                         |
| MinIO 备份          | 本轮未新增对象存储全量备份；嘉宾未新增头像资产                     |

三轮备份和回滚标签均保留。本轮没有覆盖恢复数据库或删除生产卷。

## 5. 数据库和模板

- 无新迁移，最高迁移及哈希保持一致。
- 常规迁移使用 `SEED_DEMO_DATA=false`；规范同步阶段临时使用 `true`，最终规范组织 / 大会为 `geo-conference` / `tokems26`。
- `pnpm canonical:check` 及推送门禁通过；部署后的公开首页和完整后台规范与目标一致。
- 完整快照 SHA-256：`b6eede0924a284d687d8923201dc508a6fc52a578f9c2bc70fb4e598ba75138a`。
- 前台派生快照 SHA-256：`57464ab82ac2ba7ce876b6233b0956b94b19a6849e1cb4b6a42f06ca1bc02fc4`。
- 快照脱敏校验通过，管理员身份、密钥、用户资料、交易记录、销量和审计记录未纳入规范快照。

| 数据     | 冻结前 | 只读验收后 | 恢复写入后 |
| -------- | -----: | ---------: | ---------: |
| 用户     |     45 |         45 |         45 |
| 报名     |     37 |         37 |         37 |
| 订单     |     37 |         37 |         37 |
| 票       |     25 |         25 |         25 |
| 发票申请 |      2 |          2 |          2 |

业务主键集合、票种及配额销量校验通过，现有数据完整保留。

## 6. 镜像和容器切换

镜像均来自 `ghcr.io/yaojingang/tokems-production-private`。Web 与 payment-web 共用同一服务镜像。

| 服务              | GHCR digest                                                               | 实际 image ID                                                             | 状态    |
| ----------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------- |
| api               | `sha256:194832c7e62665eb9d81afad2ea0aeb1ec53a38e0c9628f80ab1bd82673df631` | `sha256:828f349dfc5de23152721d90c4d49477236b99385de108d0d251f3a34a9e982d` | healthy |
| worker            | `sha256:bd0e7196b94a1df196d18731913cb2199ecaae92bcd6a8a748b6b5c4f5a9c252` | `sha256:4b871b7125c63311fa47386af1e089f635d95d80f840ac4c653f3e47ab107cb9` | healthy |
| web               | `sha256:7908e308d72e4f8394f948b92b585bfec4eecce831c0736834e0a1ba3a9198e4` | `sha256:f12c3784965622e4679df1da4368b2a8f2b1e8b3033da8924af7830243dd3ae6` | healthy |
| payment-web       | `sha256:7908e308d72e4f8394f948b92b585bfec4eecce831c0736834e0a1ba3a9198e4` | `sha256:f12c3784965622e4679df1da4368b2a8f2b1e8b3033da8924af7830243dd3ae6` | healthy |
| admin             | `sha256:04e50b8caf6db0c92b0fe990d266ca8097ff3e228a249355ab3aa374b9603f78` | `sha256:cf57627ad8fc3962671c87aec0799ba7cf0bc2a8ebe32b782021d3faff1b25e6` | healthy |
| gateway           | `sha256:34c842315d38a2fdf0ea3ea75492ace2098e0bc4db4e6350f37d8fe70511cc59` | `sha256:c0e5ab20d70c5de3c508fdfa25fad00e40aee84984a50f86f567ca209debf6cc` | healthy |
| notification-sink | `sha256:ee258a8cf891ebf9ce4f5ad2c1cc8316dfa6482e67572d26c65137ed46d45808` | `sha256:d1e59086f554a7806ccbe982e41d59ea1f96ff5073e4bfed5af94b0837b97ff2` | healthy |

API 和 Worker 已恢复标准启动命令与 `unless-stopped` 策略。独立写入监督机制、Worker 持久 ready 身份和 15 秒稳定性观察通过。`RECOVERY_REQUIRED` 已归档，生产写入正常。

## 7. 验证结果

- [x] 运行容器健康；Gateway、Web、Admin、API、Worker 的构建身份及数据库迁移一致。
- [x] 服务器本机与公网 HTTP、公开首页及完整规范配置验证通过。
- [x] 桌面 1440×1000、手机 390×844 的独立浏览器验收通过，未改变用户浏览器视口。
- [x] 短地址、旧参数链接跳转、邮箱隐藏、选填字段、唯一默认勾选项、蓝色条款链接和居中弹窗符合预期。
- [x] 弹窗关闭后表单内容保留，无横向溢出、页面 JavaScript 异常或统计脚本请求。

| 公网入口                                              | HTTP 状态 |
| ----------------------------------------------------- | --------- |
| [大会首页](https://hui.ailingdaoli.com/)              | 200       |
| [运营后台](https://admin.hui.ailingdaoli.com/admin/)  | 200       |
| [独立支付入口](https://www.ailingdaoli.com/pay/hui/)  | 200       |
| [版本接口](https://hui.ailingdaoli.com/version.json)  | 200       |
| [健康接口](https://hui.ailingdaoli.com/api/v1/health) | 200       |

页面验收只进行了读取和本地表单输入，没有发送短信、提交报名、创建订单或执行真实支付。持久化和运营流程由通过的 CI 覆盖。截图和 JSON 证据保存于本地 `.codex-artifacts/production-release/2026-09-04-c942cd7/`。

## 8. 异常和处理

1. 首次目标 `c942cd793d76e8a0332b4fba339f5cfae64c9c59` 的 CI 与镜像发布通过，但生产已有独立发布 V22–V28，规范同步因 V22 不可变内容冲突中止。备份为 `/www/backup/TokEMS/20260904-205920`，最终 dump SHA-256 为 `8de6d4e7c8b70ce3b7f5a7f5484421207aced98c7e43285542738d909c42e8d1`。事务回滚，旧应用恢复至保护性只读。PR #72 将线上嘉宾和议程带回本地，生成全新 V30，并修复空白议程字段的导出校验。
2. 第二次目标 `9623e042136763da84902ec2e2f4079ba4fcd43c` 的 CI 与镜像发布通过，V30 同步成功。验收把生产首次发布报名表的时间与本地时间进行精确比较，触发保护性回滚。备份为 `/www/backup/TokEMS/20260904-214814`，最终 dump SHA-256 为 `b9a2522305a9447e61d6dfd10502ae9d57d2acf1da4d304b7f1c1762b0abba7f`。
3. 通过只读连接导出完整生产规范，确认唯一差异为 `publicEvent.registrationForm.publishedAt`。PR #73 让跨环境验收忽略该运行时间，实际数据库时间保持原值；字段、版本和条款的负例仍被拒绝。两条新增回归测试修复前失败、修复后通过，31 项部署测试、完整本地检查和生产样本重放全部通过。
4. 最终按标准 `deploy --sync-canonical --resume-recovery` 完成发布。外部签名核验与镜像下载曾有传输延迟，随后正常完成；未修改服务器 DNS 或网络配置。

两次保护性回滚期间，公开浏览可用，报名、后台保存及异步任务的写入受到冻结保护。最终恢复写入和数据复验通过。

## 9. 剩余风险和后续

- 本次未执行真实付款；支付入口可访问，业务流程通过 CI 验证。
- 数据库和镜像回滚点保留，后续按既定备份保留策略管理。
- 本记录随仓库保存；本轮实现与修复代码已合并 GitHub 主分支，本轮修复分支已清理。其他任务中的退款工作流分支与文档保持原状。
