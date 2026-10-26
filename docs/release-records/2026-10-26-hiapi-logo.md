# 2026-10-26 HiAPI Logo 生产发布记录

> 发布状态：已发布
>
> 执行时间：2026-10-26，Asia/Shanghai；备份标识为 20261026-190422
>
> 操作者：Codex，按用户明确授权提交、合并 PR 并发布
>
> 长期规则：docs/production-deployment-runbook.md

## 1. 发布目标

首页和合作页使用用户提供的 HiAPI 横版透明 PNG，HiAPI 详情页使用方形 PNG，移除原拼接文字标识。Logo PR #153 仅涉及三份前台源文件与两张原图。

生产使用最新已合并主分支，包含 PR #152、#153、#154。规范大会快照同步，现有业务记录、库存和销量通过保护校验。

## 2. GitHub 和构建身份

| 项目 | 本次值 |
| --- | --- |
| Logo PR | https://github.com/yaojingang/TokEMS/pull/153 |
| 最终目标对应 PR | https://github.com/yaojingang/TokEMS/pull/154 |
| Logo PR CI | https://github.com/yaojingang/TokEMS/actions/runs/40304177279，成功 |
| 最终目标 main CI | https://github.com/yaojingang/TokEMS/actions/runs/40309788399，成功 |
| 镜像发布工作流 | https://github.com/yaojingang/TokEMS/actions/runs/40311209550，成功 |
| 目标提交 | `b4c5cb1e43eeff43a856636fcf4d46c0f28036e5` |
| 构建时间 | `2026-10-26T10:56:04Z` |
| 最高迁移 | `0072_absent_skaar.sql` |
| 迁移 SHA-256 | `595e1a8a59e0821a9ab83bc94c82c4e4555a857ae23cf6618d91d4245681c343` |
| 发布分支 | origin/main |
| Release descriptor digest | `sha256:f67a44fa41ccdd712eb6b786f9b1a03b6f8a6459e9f59172aec63e2bf64be18d` |
| Source Bundle SHA-256 | `a475a0bd76b883f6bb363337933ac218b0bb85080165dd6385d380ae53db2b7f` |
| Descriptor verifier SHA-256 | `43e69e2b4f86a38440f048c16f28d1b66a846c7c8ab96fa8f848e8257e76efb0` |
| 目标平台 | `linux/amd64` |

## 3. 发布前检查

- [x] 服务器工作区干净，production 跟踪 origin/main，最终 HEAD 与 origin/main 一致。
- [x] Compose、Nginx、磁盘、备份容量与发布互斥锁检查通过。
- [x] 必需 CI、支付保护、descriptor、源码 Bundle、六个服务 digest 和 provenance 通过。
- [x] 本地 pnpm check、pnpm audit:security、pnpm canonical:check 和实际 pre-push 规范门禁通过。

## 4. 备份和回滚点

| 项目 | 本次值 |
| --- | --- |
| 备份目录 | `/www/backup/TokEMS/20261026-190422` |
| 数据库 dump | `/www/backup/TokEMS/20261026-190422/conference.dump`，1894914 字节 |
| dump SHA-256 | `47ea82c41a8f5602b739e4b85698a87532e4e66747fbc3cef6a0bce4b544b1b2` |
| pg_restore --list | 已通过，保留非空 catalog |
| 镜像回滚标签 | `rollback-20261026-190422` |
| MinIO / 对象存储 | 保留原数据卷，规范素材随已验证快照同步 |
| 发布前版本 | `48028c96af78ce9b3deee3a4438b3b227f320b68` |

原环境快照、回滚镜像和受保护恢复脚本保存在本次备份目录，按 Runbook 的应用回滚流程操作。

## 5. 数据库和模板

最高迁移保持 0072_absent_skaar.sql，本次无新增数据库结构迁移。常规 db-init 使用 SEED_DEMO_DATA=false 并成功；规范模板通过受保护入口单独同步。规范组织与大会为 geo-conference / tokems26。

- 完整规范快照 SHA-256：`0d5822e7b524a2d02b9f12393be9200deb72571901fe09d4b47ddeaadcb82500`。
- 前台派生快照 SHA-256：`27e20757dff223014a66a77668adeb15456f639f09ed191416a2f0c4f119b1ca`。
- 规范导出、生产完整快照、公开投影及脱敏门禁通过；管理员身份、凭据和业务记录未进入快照。

| 指标 | 最终备份前 | 恢复写入后 |
| --- | ---: | ---: |
| customer_users | 317 | 317 |
| registrations | 254 | 254 |
| orders | 230 | 230 |
| tickets | 219 | 219 |
| invoice_requests | 40 | 40 |

生产主键保留、业务计数、票种和配额销量在切换后及恢复写入后均校验通过。

## 6. 镜像和容器切换

| 服务 | descriptor 固定镜像 | 实际状态与 image ID |
| --- | --- | --- |
| api | `ghcr.io/yaojingang/tokems-production-private@sha256:f4d3fe3425a7194cae13b2517a973a1fc02b2341c1c05cfcbe12861c594b37bb` | healthy，`sha256:d9cab00e6743c61f206005cb1c9bd678161dd542a8f6980baf0a065765d6492a` |
| worker | `ghcr.io/yaojingang/tokems-production-private@sha256:318c58279459571eb8964df5e314d1853252a8609c17053c404c75e2c53037fa` | healthy，`sha256:ace9a86f839b2f49212321d6995928d50b80cecdecccc30cd98cc92bd456df48` |
| web | `ghcr.io/yaojingang/tokems-production-private@sha256:8e0d63c517471594b17f5fa934678310b56e6eec66f96001116d667e721f04bf` | healthy，`sha256:a05bff7551566cb5e0c6c878bce2075c920dca1fbafb29413c5f2bd627085de8` |
| admin | `ghcr.io/yaojingang/tokems-production-private@sha256:c0d3676c0f895de74ea90be271083b529af2cf2a42d627a1291227c4d132e014` | healthy，`sha256:f64b655a9090ea91a6f3d6277d0145755262d8d8950cbebfa3063552d5e6f9fd` |
| gateway | `ghcr.io/yaojingang/tokems-production-private@sha256:7bc21c09b5870e67fe49545590d0a49cfb66b53efbc658ecfd7276bbcd35a9a1` | healthy，`sha256:2bdd1d65b07bea026a3fc8285d88cf68d31b5bb3f06e74fd2d5ba12ff573904b` |
| notification-sink | `ghcr.io/yaojingang/tokems-production-private@sha256:8e66166db34726a7334943826b5d7ff1e30940811e6959c6ecf8eac84c820d3e` | healthy，`sha256:4fa6396219e35a4a695f1b666c608e66b182f7c9373cace014be7a406b02f77f` |

payment-web 使用同一已验证 Web 镜像。七个应用容器全部 healthy。运行变量与镜像构建身份一致；静态服务通过镜像标签和实际 HTTP 版本核验。

## 7. 验证结果

- [x] 容器健康、本机与公网 HTTP、构建身份、迁移哈希和 tokems26 公开内容通过。
- [x] API status=ok，database.migration.ok=true。
- [x] 首页、合作页及 HiAPI 详情页在 1440、375、320 像素下完成 12 项浏览器检查，页面运行错误为零。
- [x] 两张线上 PNG 与用户原图摘要一致，比例正确，其他支持单位的内容、图片与链接保留。
- [x] 恢复标记已清除，下载用 SSH 回环代理已关闭。

| 公网入口 | HTTP |
| --- | ---: |
| https://hui.ailingdaoli.com/ | 200 |
| https://admin.hui.ailingdaoli.com/admin/ | 200 |
| https://www.ailingdaoli.com/pay/hui/ | 200 |
| https://hui.ailingdaoli.com/version.json | 200 |
| https://hui.ailingdaoli.com/api/v1/health | 200 |

## 8. 异常和处理

- 直连下载缓慢，在只读预检阶段改用发布入口支持的 SSH 回环代理；完整保留来源验证和发布门禁。
- f995e3b 预检通过后，main 合入 PR #154。入口在备份和停服前拒绝过期目标；确认五个 Logo 文件相同后，等待最新提交 CI 和镜像成功，再发布 b4c5cb1。
- 本地验收脚本修正含空格路径的 URL 解码，并按静态服务镜像标签核验版本，最终复验通过。
- 正式部署成功，未触发应用回滚或数据库覆盖恢复。

## 9. 最终结论

- 最终状态：已发布，三个目标页面的 Logo 替换完成。
- 线上提交：`b4c5cb1e43eeff43a856636fcf4d46c0f28036e5`。
- 线上迁移：`0072_absent_skaar.sql`。
- 回滚点：`rollback-20261026-190422`，材料位于 `/www/backup/TokEMS/20261026-190422`。
- 本次无剩余阻塞，既有构建期依赖审计例外继续按 docs/security-audit-exceptions.md 管理。

证据位于 artifacts/2026-10-26-hiapi-logo/，包含版本、备份摘要、业务计数、截图与原图校验结果；敏感发布证据文件使用 0600 权限。
