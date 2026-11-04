# 2026-11-04 TokEMS 首页锚点导航修复生产发布记录

> 发布状态：已发布
>
> 发布完成：2026-11-04 13:36:14，Asia/Shanghai；补充验收完成于 13:39 后
>
> 操作者：Codex，依据用户修复、验证并发布线上授权
>
> 长期规则：[生产发布规范](../production-deployment-runbook.md)

## 1. 发布目标

修复根首页 `#agenda` 等页内跳转导致空白页的问题，并检查首页全部同类链接。

- 根路径导航门禁放行同一路径、同一查询参数下的锚点变化，保留当前文档；跨页面进入根路径和查询参数变化继续创建新文档。
- 手机菜单根据焦点事件的真实目标判断是否关闭，修复点击锚点前菜单提前收起的问题。
- 首页增加全局“跳到主要内容”链接对应的 `#main-content` 目标。
- 新增五项真实浏览器回归并接入 CI。发布前后均覆盖桌面和手机。
- 发布范围为三个前台文件、回归脚本、CI 和协作规则；数据库结构、依赖及大会内容保持现有版本。

根因已在原始代码上复现：根路径门禁将片段变化交给整页导航，路由持续取消；手机菜单的异步焦点判断又会在点击完成前收起菜单。修复前根首页议程测试超时，手机锚点扫描失败；修复后对应回归通过。

## 2. GitHub 和构建身份

| 项目                        | 本次值                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------- |
| PR                          | [#167](https://github.com/yaojingang/TokEMS/pull/167)，已合并到 main               |
| 源码提交                    | `46b3f6a0600cf8e2f660226fb0d30856dcc7d403`                                         |
| 主分支 CI                   | [41774715981](https://github.com/yaojingang/TokEMS/actions/runs/41774715981)，成功 |
| 镜像发布工作流              | [41775921551](https://github.com/yaojingang/TokEMS/actions/runs/41775921551)，成功 |
| 目标提交 / PR merge SHA     | `67e5b1963f7298637809fe4a86a44b2ba2539c90`                                         |
| 构建时间                    | `2026-11-04T04:53:52Z`                                                             |
| 最高迁移                    | `0072_absent_skaar.sql`                                                            |
| 迁移 SHA-256                | `595e1a8a59e0821a9ab83bc94c82c4e4555a857ae23cf6618d91d4245681c343`                 |
| 发布分支                    | `origin/main`                                                                      |
| Release descriptor digest   | `sha256:ba46302e479c9254c0ff75ca129ee5038c394f6c3fdae8d903df0a3127d7dcac`          |
| Source Bundle SHA-256       | `29bf214be96f3469e9f0e44d206f56d46c7e297d1ac7886216df41586c193d32`                 |
| Descriptor verifier SHA-256 | `43e69e2b4f86a38440f048c16f28d1b66a846c7c8ab96fa8f848e8257e76efb0`                 |
| 目标平台                    | `linux/amd64`                                                                      |

私有包为 `ghcr.io/yaojingang/tokems-production-private`。生产机已验证 PR、main push CI、完整镜像工作流、descriptor provenance、Bundle 固定 ref 与完整历史、校验值及六个镜像来源证明。

## 3. 发布前检查

- [x] 服务器工作区干净，`production` 跟踪 `origin/main`
- [x] Compose、Nginx、预构建磁盘容量和数据库备份容量检查通过
- [x] 无并行发布控制器和待恢复发布
- [x] 支付结清、数据库实例身份、迁移及 Worker ready 门禁通过
- [x] GitHub 必需检查成功，目标等于已合并 PR 的 merge SHA
- [x] 完整预检退出码 0

使用既有 `/usr/local/sbin/tokems-deploy` 标准入口。入口 SHA-256 为 `61dadc4b89f23f5d8cdf7ecc939f02db4e171f119c02549ca826747a3d79b09e`，与目标提交相同。生产配置位于 `/etc/tokems/production.env`，目录为 root:root 0700，配置与 GHCR 只读凭据均为 root:root 0600。

预检控制器为 `tokems-anchor-check-proxy-20261104.service`，日志 `/tmp/tokems-anchor-check-proxy-20261104.log`，末尾 `CHECK_EXIT=0`。正式控制器为 `tokems-anchor-deploy-20261104.service`，日志 `/tmp/tokems-anchor-deploy-20261104.log`，末尾 `DEPLOY_EXIT=0`。

## 4. 备份和回滚点

| 项目                | 本次值                                                             |
| ------------------- | ------------------------------------------------------------------ |
| 备份目录            | `/www/backup/TokEMS/20261104-133206`                               |
| 数据库 dump         | `conference.dump`，位于上述目录                                    |
| dump SHA-256        | `d3eabc654a34a05f2e7a4f0271a5a564ca2ceefc7ca4d52771380d7545886b5d` |
| `pg_restore --list` | 通过，目录清单 81,482 字节                                         |
| 镜像回滚标签        | `rollback-20261104-133206`，六个旧镜像均已复核存在                 |
| 对象存储            | 本次无素材变更，保留既有数据卷                                     |
| 发布前版本          | `6688526fa8b847c4ba26855edab50f9dfa63b099`                         |

脚本在停止写入后再次生成最终备份及业务基线。备份和回滚资料保留在生产机。

## 5. 数据库和模板

无新增迁移，`db-init` 成功，`SEED_DEMO_DATA=false`。只读规范漂移预检通过，`canonical_sync=false`。规范组织和大会为 `geo-conference` / `tokems26`。

推送前 `pnpm canonical:export`、`pnpm canonical:check` 和脱敏检查通过，两份规范快照与发布前相同。

- 完整规范快照 SHA-256：`29fa4dadef14f8c42629f4a76200b4fd2a126ced383c05bef2a9a205e79650fa`。
- 前台派生快照 SHA-256：`de812b659247c6ed9a0d6ccd405f986a88f0edf6e75f141c256a049d0bfed005`。
- 管理员身份、凭据、个人资料、交易数据、销量及审计记录未进入规范快照。

| 全库业务计数 | 写冻结后基线 | 切换后 | 恢复写入后 |
| ------------ | -----------: | -----: | ---------: |
| 客户用户     |          454 |    454 |        454 |
| 发票申请     |           54 |     54 |         54 |
| 订单         |          322 |    322 |        322 |
| 报名         |          359 |    359 |        359 |
| 票证         |          315 |    315 |        315 |

票种销量和配额销量的 before、after、post-thaw CSV 均逐字节一致。保护记录身份及保留策略验收通过。解除写冻结前已启动独立监督单元，最终恢复标记清除，监督单元与发布控制器均已结束。

## 6. 镜像和容器切换

| 服务              | Descriptor 固定的 GHCR digest                                             | 实际 image ID                                                             | 最终状态 |
| ----------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------- |
| api               | `sha256:4273949093bd9f078315f8726f393e52f5bd220095a9ec12af31f7d422cd063f` | `sha256:6d4e06a550a4a1153a38b3c0f259a317fc4c39750b2ef6231bd31b4c9392e89d` | healthy  |
| worker            | `sha256:0d6ed020e416eb8654379e5fa595c534229127a5df60a851a294182bd0711635` | `sha256:4511d073ebafd6a840c278b7aaa033037f6f14c7791964ff72a699ae66809632` | healthy  |
| web               | `sha256:067acb7d797a0c83f0566456cf6866635350e2c8f599f327a78fd8619bce2c56` | `sha256:4ac235dc49780daa070a407f7af3378997cadd80338d07adb6d63ea85d90b07b` | healthy  |
| admin             | `sha256:b93ea0e0c4785e0b52596b47546ff45c533f1409c06568cfd04f1fc544b4fa4e` | `sha256:855fa842ae1d166015b2abaa18948e1e60cf460a5780f4fde8e3747ccfcbf985` | healthy  |
| gateway           | `sha256:d6fec1d569c6295039648049b37c2bec88a88d37d2d7f9ded8a7e862c5b79362` | `sha256:1937738e12ed831586fc959dc835eb2cb5799b4f860f288fdfd4aad207d20365` | healthy  |
| notification-sink | `sha256:a226c2064286814ee18a7decfb876cbb5e766e8a771b759af59f52002ca97fc1` | `sha256:02e95a1b8e76d7d95b9acbd721cc3d020943dc869a406d3e3164dd51e065bf20` | healthy  |

Web 与 payment-web 共用 web 镜像。11 个长期容器均为 healthy，包含七个应用容器及 PostgreSQL、Redis、MinIO、Mailpit。服务器 HEAD 和 origin/main 均等于目标 SHA，工作区干净。

## 7. 验证结果

- [x] 容器、Gateway / Web / Admin / API / Worker 四项构建身份一致
- [x] API `status=ok`，数据库正常，`database.migration.ok=true`
- [x] 公网和本机 HTTP 验收通过
- [x] 公开大会为 `tokems26`，大会内容及后台设置匹配已验证规范快照
- [x] 业务数据计数、保护记录和销量符合预期
- [x] 临时回环下载代理已关闭，1080 端口释放

| 入口                 | 本机 HTTP       | 公网 HTTP       | 结果                              |
| -------------------- | --------------- | --------------- | --------------------------------- |
| 根首页               | 200，GET / HEAD | 200，GET / HEAD | 页面与锚点目标正常                |
| 独立大会 `/tokems26` | 200             | 200             | 大会内容正常                      |
| 后台 `/admin/`       | 200，后台 Host  | 200             | 页面可访问                        |
| 支付 `/pay/hui/`     | 200，支付 Host  | 200             | 页面可访问                        |
| 版本接口             | 200             | 200             | SHA、构建时间、迁移及哈希等于目标 |
| 健康接口             | 200             | 200             | API、数据库、迁移正常             |

本地 `pnpm check`、`pnpm audit:security` 和五项浏览器回归通过；官方 main CI 同样通过五项新增回归。现有临时 deepmerge 低风险审计例外继续按 `docs/security-audit-exceptions.md` 管理，范围未变。

发布后使用隔离、匿名浏览器对公网执行同一套五项回归，全部通过：手机焦点与键盘、根首页议程、1440px 全锚点、390px 手机菜单全锚点，以及根路径整页边界。检查发现并覆盖 10 个同页链接、8 个目标：`#main-content`、`#hero`、`#why`、`#agenda`、`#speakers`、`#members`、`#tickets`、`#faq`。另在两种尺寸直接打开全部八个锚点网址，16 项全部通过。路由完成、文档保留、目标可见、滚动定位与脚本错误检查均通过。

浏览器验证屏蔽全部 API 写请求，无报名、下单或统计写入。桌面和手机截图已检查。共享预览 8088 与用户浏览器自然视口保持原状态。

本地验收材料位于 `test-results/homepage-anchors/`，包含 `production-smoke.log`、`production-direct-anchors.json`、`production-public.json`、`production-server.json`、`production-deploy.log`、桌面和手机截图。

## 8. 异常和处理

1. 首次直连预检下载发布包缓慢，超过八分钟仍不足 1 MB。在确认应用仍为旧版本且未进入备份、停写或数据库更新阶段后，仅终止该次已确认的 Docker 下载，预检以退出码 1 结束。11 个旧容器均保持 healthy。
2. 既有 SSH 私钥需要读取电脑钥匙串。使用系统 SSH 的既有钥匙串支持后连接成功，服务器授权及密钥配置保持原样。
3. 重新使用标准入口的既有 `--proxy http://127.0.0.1:1080` 完成预检及发布，全部来源证明和摘要校验保留。该代理仅通过临时 SSH 回环通道用于网络准备，验收及业务容器继续使用正常网络；发布后已关闭通道。
4. 补充本机支付探测使用无尾斜线地址时命中 308，旧版 Python 不自动跟随该状态，随后 curl 跟随到带外部 Host 的 8088 地址并超时。按 Gateway 配置直接请求 `/pay/hui/`，本机返回 200，公网入口亦为 200。

本次未触发应用回滚、数据库恢复或发布门禁绕过。

## 9. 最终结论

生产运行 `67e5b1963f7298637809fe4a86a44b2ba2539c90`，迁移为 `0072_absent_skaar.sql`。首页同页锚点、手机菜单、键盘操作和直接锚点网址均通过公网验收。备份与回滚点已保留，临时代理已关闭，无未解决的本次发布阻塞。
