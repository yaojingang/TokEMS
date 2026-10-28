# 2026-10-28 后台加载体验优化生产发布记录

> 状态：发布成功，页面验收完成。执行日期：2026-10-28（Asia/Shanghai）。
>
> 依据：`docs/production-deployment-runbook.md`；由 Codex 使用用户授权的生产访问与既有 root 发布入口执行。

## 1. 发布目标

数据概览和报名管理先显示页面结构，数字、列表和辅助模块独立加载并显示动态占位；刷新保留已有内容。报名查询先分页，再补充当前页关联数据，减少数据增长后的等待。

范围为 PR #159 的 16 个文件，无新增迁移、依赖和生产配置变更。主工作目录其他未完成编辑未进入本次发布。使用既有标准入口和私有预构建镜像。

## 2. GitHub 和构建身份

| 项目 | 本次值 |
| --- | --- |
| 已合并 PR | [#159](https://github.com/yaojingang/TokEMS/pull/159)，目标 `main` |
| 主分支 CI | [40537945643](https://github.com/yaojingang/TokEMS/actions/runs/40537945643)，成功 |
| 完整镜像工作流 | [40540182684](https://github.com/yaojingang/TokEMS/actions/runs/40540182684)，成功 |
| 目标及线上 SHA | `476c3c5a5b76f7b532a82886406c9246a283d093` |
| 构建时间 | `2026-10-27T16:22:06Z` |
| 最高迁移 | `0072_absent_skaar.sql` |
| 迁移 SHA-256 | `595e1a8a59e0821a9ab83bc94c82c4e4555a857ae23cf6618d91d4245681c343` |
| 私有包 | `ghcr.io/yaojingang/tokems-production-private` |
| Descriptor digest | `sha256:6a863472c45ab37eb8483d746a2688091bc7c2ee868d4172dc8dba2e395952eb` |
| Source Bundle SHA-256 | `b8da35a288f0b508e416ccd5c729a1280dd0ddd13242d2ec20347087936e8320` |
| Verifier SHA-256 | `43e69e2b4f86a38440f048c16f28d1b66a846c7c8ab96fa8f848e8257e76efb0` |
| 平台 | `linux/amd64` |

发布前后重新读取 PR、CI、镜像工作流和生产身份。目标 SHA 等于已合并 PR 的 merge commit，并与成功主分支 CI、完整镜像工作流一致。生产机通过 descriptor、Bundle、verifier、全部镜像摘要及 GitHub provenance 验证。

## 3. 发布前检查

- `/www/wwwroot/TokEMS` 的 `production` 跟踪 `origin/main`，最终工作区干净，HEAD 和 origin/main 均等于目标 SHA。
- Compose、Nginx 配置、预构建容量、支付结清、数据库实例身份、Worker ready、互斥锁和恢复标记检查通过。
- 配置继续使用 `/etc/tokems/production.env`；目录权限 `root:root 0700`，文件及 GHCR 只读凭据权限 `root:root 0600`。
- 完整预检和正式发布退出码均为 0。
- 入口 `/usr/local/sbin/tokems-deploy`，使用既有支持的 SSH 回环代理下载；证明及摘要校验保留，失败未回退直连。没有启用主机构建、蓝绿入口或修改 Docker 守护进程、宿主机 Nginx。

## 4. 备份和回滚点

| 项目 | 本次值 |
| --- | --- |
| 成功发布备份 | `/www/backup/TokEMS/20261028-094818` |
| 数据库 dump | 该目录下 `conference.dump` |
| dump SHA-256 | `136ece658481c270e5f801f2344b9720a8b14caa31b1911d459962617086ccf8` |
| dump 目录检查 | `pg_restore --list` 通过，`conference.dump.list` 非空 |
| 回滚镜像标签 | `rollback-20261028-094818` |
| 发布前版本 | `f00bba30658049e1b9f1579c4202ff7eed3dd75b` |
| 首次直连尝试备份 | `/www/backup/TokEMS/20261028-092335`，保留 |
| 对象存储 | 本次无素材变更，保留既有数据卷 |

## 5. 数据库和模板

无新增迁移；db-init 成功，`SEED_DEMO_DATA=false`。只读漂移预检判断无需规范同步，结果 `canonical_sync=false`。`geo-conference` / `tokems26` 的完整规范及公开内容验收通过。

本轮代码推送前 `pnpm canonical:check` 已通过；本次部署复用该目标提交，未重新导出或改写规范内容。

- 完整规范快照 SHA-256：`b9ceb1f225e9f39ffd10ade53538e8c8ddbcb6e8422f371c29eec74a5868184b`。
- 前台派生快照 SHA-256：`ba05a2ad753e8265c52763bbe70706c5764e858b01c2bf50f6195e9766d60bcf`。

| 全库业务计数 | 切换前 | 切换后 | 解除写冻结后 |
| --- | ---: | ---: | ---: |
| 客户用户 | 368 | 368 | 368 |
| 发票申请 | 45 | 45 | 45 |
| 订单 | 260 | 260 | 260 |
| 报名 | 285 | 285 | 285 |
| 票证 | 249 | 249 | 249 |

票种销量、配额销量前后 CSV 逐字节一致。发布脚本在解除冻结前后均确认业务计数和销量保留。此前下载等待期间有正常新增业务，最终核验使用成功发布的冻结窗口。当前大会界面为 261 条报名，与全库计数口径不同。

## 6. 镜像和容器切换

| 服务 | Descriptor 固定的 digest | 实际 image ID |
| --- | --- | --- |
| notification-sink | `sha256:da03a98de479dbb9a4968b45ee556c128a4e265f679ced6b9a67cb6439de0155` | `sha256:82b055ad725d3a6f5c87a4d49d30fd7eff7b9e460d88fddc1c0c8d44e323a4ed` |
| api | `sha256:b333a8aa20ba02b1a0d7c5e4c6965cb550427d44fdc67416746e836d75cbde79` | `sha256:27138d00c98adf3b359862c0d706ba7955945452473fe3c078efca9dbde75bdc` |
| admin | `sha256:6c545911e4a7e9fe6c178558219fc1272464c0de29e8bf5c6b013fc55e2558c0` | `sha256:e695ae10bd78252bc59b3844e15ccaa4d49c69abc0399ef9506578b61223384e` |
| worker | `sha256:75ea238037e7cbb043d1d89dce798ff056c85385eccc2c001405eec7b74926c9` | `sha256:3d9c1b8f65ed5321894b10327a5a95fe8a5b02b48ea76dee996534cf12ed8524` |
| gateway | `sha256:9057386ae4fc4fa6246b0dedd804c96ceff901a9550208f3d462467938421c0c` | `sha256:0273fe094818a20419521658dc5874ad9a921bfba86b7074242054a81a9ab6a3` |
| web | `sha256:a55beb7505b5b83570c46781e3267cb7dcd59b815620978f020283a1c7eeb057` | `sha256:9cb99b29519aea0bc7bb6793b1ca22057c0df9fc85c02fbe59c570cd0cf179a5` |

Web 和 payment-web 共用 web 镜像。11 个长期容器全部 healthy，包括 7 个应用容器和 PostgreSQL、Redis、MinIO、Mailpit。各应用发布身份检查通过。

已完成备份、支付保护、停写、迁移检查、版本切换、完整验收和解除冻结。恢复标记清除，未执行数据库恢复。

## 7. 验证结果

| 入口 | 本机 HTTP | 公网 HTTP | 结果 |
| --- | --- | --- | --- |
| 大会前台 | 200 | 200 | 根页面、独立大会内容通过语义核验 |
| 后台 | 200，后台 Host | 200 | Chrome 已登录会话验收两页 |
| 支付页 | 200，支付 Host | 200 | 可访问 |
| 版本接口 | 200 | 200 | SHA、时间、迁移及哈希等于目标 |
| 健康接口 | 200 | 200 | status=ok，数据库及迁移正常，大会 tokems26 |

同一 Chrome、生产大会 101，未限速时的单次请求实测：

| 请求 | 发布前 | 发布后 |
| --- | ---: | ---: |
| 概览最近报名（5 条） | 7.17 秒 | 109 毫秒 |
| 报名管理首屏（10 条） | 6.06 秒 | 91 毫秒 |

报名管理新版本整页请求完成约 794 毫秒，DOMContentLoaded 494 毫秒。概览统计请求 162 毫秒，待支付计数 124 毫秒，待开发票计数 150 毫秒。

额外设置临时 10 秒请求延迟进行状态验收：

1. 概览先显示标题、8 项指标名称、库存模块、运营入口、趋势和最近报名区域；数字和模块各自显示动态占位，没有整页空白。
2. 报名管理先显示标题、操作、筛选、页签和表头；列表显示骨架行，候补名单独立加载，没有提前显示虚假的 0 条记录。
3. 点击刷新后显示“正在刷新”，已显示的第 1–10 条记录及 261 条总数继续可见，没有回到首次加载的空列表。
4. 验收后关闭限速、删除临时配置、关闭 DevTools，未设置视口覆盖，后台停留在正常尺寸的数据概览页。

以上为本次真实页面和请求验收，未开展持续负载测试。本地证据位于主工作目录 `artifacts/2026-10-28-admin-loading-production/`，含前后版本、健康响应、生产数据核验、网络耗时、慢网截图和清理结果，文件权限为私有。

## 8. 异常和处理

1. 网页终端后台预检因 Compose 读取输入暂停，恢复后超时。改为独立 systemd 控制器后完整预检通过；该次预检未修改运行应用和业务数据。
2. 首次直连下载缓慢，Worker 准备耗时 696 秒。确认尚未停写和更新数据库后，仅终止该次 Admin 下载；原发布入口以失败状态完成应用恢复检查，旧版本保持 healthy，恢复标记清除。备份和日志保留。
3. 随后使用既有 `--proxy http://127.0.0.1:1080` 重新完整预检和正式发布，全部成功。临时 SSH 回环隧道已关闭，确认端口释放。
4. 早期 systemd 控制器缺少 HOME，GitHub CLI 帮助探测在源码目录生成 `.local/state/gh/device-id`。核对归属、生成时间和唯一文件后，保存在首次备份目录的 `controller-gh-device-id`；最终服务器工作区干净。
5. 本机后台补充探测最初未带 Host，命中默认站点返回 404；按 Gateway 配置带后台 Host 复验返回 200。公网后台正常。

成功控制器为 `tokems-admin-loading-proxy-20261028.service`，Result=success、ExecMainStatus=0。正式日志 `/tmp/tokems-admin-loading-proxy-deploy-20261028.log` 末尾为 DEPLOY_EXIT=0。

## 9. 最终结论

生产运行 `476c3c5a5b76f7b532a82886406c9246a283d093`，两个页面的真实加载、慢网占位、刷新保留内容均通过验收。迁移保持 `0072_absent_skaar.sql`，生产数据、销量及大会内容核验通过，备份和回滚镜像已保留。

无未解决的发布阻塞。本记录归档本次生产发布的版本、备份、回滚点和验收证据。
