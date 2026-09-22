# TokEMS 蓝绿发布

`tooling/production-bluegreen.sh` 是独立的新入口。原 `tooling/production-deploy.sh` 保持原样，仍按原 Runbook 工作；两个入口共用发布互斥锁和恢复标记，不能并行操作。

## 执行顺序

发布先检查目标提交的已合并 PR、该 SHA 的 main CI、镜像发布、私有 GHCR 包、descriptor provenance、源码 Bundle 和全部六个镜像 digest。构建在 GitHub Actions 完成；服务器先下载并验证完整版本。**这一步全部成功前，不启动候选应用、不停止旧应用、不修改数据库、不切流量。** 新入口不提供现场构建选项。

随后读取实际数据库迁移历史和填充执行记录，对照目标提交的 `tooling/bluegreen/release-policy.json` 自动选择流程：

| 变化 | 流程 |
| --- | --- |
| 只有代码，数据库已匹配 | 旧服务继续写入，启动候选、验证、热重载入口 Gateway 路由，再移交后台任务 |
| 已声明兼容旧版本的在线迁移/填充 | 备份、授权旧实例接受经过审核的新迁移哈希、事务更新，再走蓝绿切换 |
| 需要维护的迁移/填充，或应用不兼容旧版 | 支付预检、排空后台、停止全部旧应用、再次检查支付和剩余数据库连接、最终备份、更新、启动新应用、验收并恢复流量 |
| 未分类的迁移、修改过的历史、缺失镜像或证明 | 在停止旧服务前退出 |

宿主机宝塔 Nginx 保持现有 `proxy_pass http://127.0.0.1:8088`，脚本不读取、修改或重载宿主机 Nginx。现有 `/conference-assets/` 直连共享 MinIO 的 `19000` 规则及 CORS 可以继续使用，无需新增 `tokems-upstream.conf` 或调整站点 include。

固定入口 `tokems-entry-gateway` 使用已验证的 Gateway 镜像，常驻监听 `127.0.0.1:8088`。它在 Docker 网络内转发至当前蓝/绿版本的 Gateway；各版本仍保留自己的完整路由、素材和构建身份。日常切换只原子更新固定入口挂载的路由配置，执行容器内 `nginx -t` 和 `nginx -s reload`，等待旧 worker 排空，随后交接 API/Worker。固定入口镜像独立保留，不随每次应用发布重建；更新它的 Nginx 基础镜像属于单独的入口维护。

PostgreSQL、Redis、MinIO、Mailpit 继续使用现有 `tokems` 容器和数据卷。应用分别运行在 `tokems-blue` / `tokems-green`；各版本 Gateway 的 `127.0.0.1:18088` / `18089` 仅用于本机验证，公网始终经 `8088`。每个槽使用独立应用网络，基础服务连接到该网络，不让两个槽共用 `api` 等 DNS 别名。

候选 API 的 HTTP 可以读写，但支付/退款定时任务暂停；候选 Worker 不执行启动维护和消费。旧任务排空后，停止旧 API/Worker，确认它们真正退出，才激活新后台。归属记录持久化，因此容器重启仍会恢复正确的 active/standby 状态。首次接管没有控制协议的旧版本时，使用正常 SIGTERM 等待退出，不自动强杀长任务。

## 首次接入

1. 按原 Runbook 准备 Docker Compose、GitHub CLI、Python 3.6+、systemd、受保护的生产环境和 GHCR 只读凭据。源码目录仍为 `/www/wwwroot/TokEMS`，`production` 跟踪唯一官方 `origin/main`。
2. 保持现有宝塔配置，三个域名的应用流量继续进入 `127.0.0.1:8088`。脚本通过本机和三个 HTTPS 入口的实际 HTTP 响应验证版本，接受现有站点 include 结构和直连 MinIO 路由。
3. `/etc/tokems/bluegreen.json` 仅用于可选下载代理；不使用代理时可以不创建。配置只有 `downloadProxy`，例如 `{"downloadProxy":"socks5h://127.0.0.1:1080"}`。文件需 root:root 0600、目录 0700；早期草案中的 `nginx` 和 `upstreamFile` 配置已废弃，脚本会拒绝这些键。
4. 首次目标必须包含新入口、发布策略和后台控制协议，经过 PR、main CI 和镜像发布。至少预留 4 GiB 可用内存、30 个数据库连接及镜像/备份空间。
5. 首次接管时，旧 Gateway 是只读容器，没有动态路由挂载。脚本在镜像全部验证、数据库备份、候选环境健康及新路由容器内语法检查通过之后，排空旧 Gateway，释放 `8088`，启动固定入口。**这一次端口交接会有短暂 HTTP 中断**；普通代码更新不冻结数据库。失败可启动原 Gateway 恢复原入口，原容器和镜像保留。后续蓝绿切换不更换固定入口容器。

入口状态与挂载配置保存在 `/www/backup/TokEMS/bluegreen/gateway/`，容器重启仍加载当前路由。控制器在重载前保存切换意图；断点恢复会再次重载并核验实际生效的路由。不要通过旧 Compose 或旧发布脚本重新启动已退出的 legacy Gateway，它仍声明占用 `8088`。

生产环境只从 `/etc/tokems/production.env` 解析；生成的 Compose 位于 root 私有发布目录，包含敏感运行配置，不能分享或提交。新脚本不重标记或覆盖共享 `tokems-*:local`，也不运行 `db-init` / seed。

## 命令

```bash
# 指定已合并且完成 CI/镜像发布的完整 SHA
sudo bash tooling/production-bluegreen.sh deploy --target-sha <40位SHA>

sudo bash tooling/production-bluegreen.sh status
sudo bash tooling/production-bluegreen.sh resume --release <发布ID>
sudo bash tooling/production-bluegreen.sh rollback --release <当前已完成发布ID>
```

## 可选的 SSH 下载代理

代理只用于发布准备阶段的 GitHub API、GHCR、镜像和来源证明下载；本机／公网验收、数据库、生产容器及离线恢复不继承它。默认使用正常网络，不读取当前 shell 的代理环境。`--proxy URL` 临时开启，`--no-proxy` 临时关闭，两者互斥且只接受 `deploy`。也可以在受保护的 `/etc/tokems/bluegreen.json` 增加 `downloadProxy`，值为代理 URL 或 `null`；命令行优先于配置。

先在自己的电脑保持这个 SSH 会话运行（本机 1082 必须已经是可用的代理服务，SSH 仅转发 TCP）：

```bash
ssh -NT -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -R 127.0.0.1:1080:127.0.0.1:1082 ecs-user@<生产服务器>
```

远端端口只监听回环地址，无需开放公网 1080。随后在另一个终端登录服务器，选择与本机代理相符的协议：

```bash
# 本机 1082 是 HTTP 或 mixed 代理端口
sudo bash tooling/production-bluegreen.sh deploy --target-sha <40位SHA> \
  --proxy http://127.0.0.1:1080

# 本机 1082 是 SOCKS5 端口；域名也通过代理解析
sudo bash tooling/production-bluegreen.sh deploy --target-sha <40位SHA> \
  --proxy socks5h://127.0.0.1:1080

# 本次不使用配置文件中的代理
sudo bash tooling/production-bluegreen.sh deploy --target-sha <40位SHA> --no-proxy
```

代理 URL 只接受 `127.0.0.1`、`localhost`、`[::1]` 和显式端口，支持 HTTP、HTTPS、SOCKS5，不接受账号密码、路径或查询参数。`socks5://` 自动按 `socks5h://` 处理。代理选项写入本次私有发布记录，systemd 接管后仍然有效，不依赖 `sudo -E`。代理连接失败不会悄悄回退直连；旧服务在准备失败时继续运行。

**代理模式额外需要 root 安装 `crane >= 0.20.3` 到系统 PATH，文件不能被其他用户写入。** 使用[官方 crane 发布包](https://github.com/google/go-containerregistry/releases)，按对应平台核对 SHA-256 后安装。普通模式无需该依赖。脚本使用客户端经代理下载镜像归档，核对已证明的 manifest、config 和每层摘要，将工具生成的临时标签替换为 `tokems-bluegreen-cache:sha256-<config摘要>` 后通过 `docker load` 导入，不覆盖现有部署标签；读取 Docker 实际 image ID 并用于运行（兼容 classic 和 containerd 存储），发布记录同时保留 GHCR digest 和来源证明。

这样无需修改 `/etc/docker/daemon.json` 或重启 Docker。[Docker 的镜像拉取代理属于守护进程配置](https://docs.docker.com/engine/daemon/proxy/)，仅给 `docker pull` 设置 shell 代理不能切换其下载线路。`--no-proxy` 使用原有 Docker 下载路径；如果管理员此前给 Docker 全局配置了代理，该全局配置仍然生效。

隧道需保持至 `artifacts-ready`。此后迁移、切换和 `resume`／`rollback` 使用本地已验证镜像，无需再连接电脑代理。

## 发布记录与续跑

入口返回 systemd 单元和 `journalctl -fu ...` 命令。控制器脱离 SSH 会话运行；异常信号退出由 systemd 重启。主机重启或遇到不能自动处理的错误后，通过 `status` 查看并对当前恢复记录执行 `resume`。

发布目录为 `/www/backup/TokEMS/bluegreen/<发布ID>/`，保存源码、镜像和 CI 证据、不可变输入摘要、计划、前后业务计数、数据库备份和阶段记录。旧应用镜像添加 `rollback-<发布ID>` 标签。保留这些记录、旧容器和镜像，不自动清理。

`resume` 只接受当前恢复标记所属的发布；若已写入完成／回滚终态但进程在收尾前中断，只补完活动版本记录和清除标记。已经收尾、已被后续发布替代的记录不能重放；服务恢复正常后需要重新 `deploy`。恢复直接检查本地缓存、当前容器和数据库，不请求最新 main CI、GitHub 或 GHCR。手动回滚先检查兼容性，不允许的回滚直接拒绝，不改动正常服务或恢复标记；允许的回滚具有持久阶段记录，失败后可继续恢复。

## 迁移与填充的声明

`baseline` 是新协议引入时已存在的迁移，不会自动授权补跑全部历史 SQL。实际数据库必须是目标迁移文件哈希的完整前缀。每条待执行迁移都必须在 `migrations` 中声明：

```json
{
  "0073_example.sql": {
    "sha256": "该SQL文件的SHA256",
    "mode": "online",
    "backwardCompatible": true,
    "transaction": true,
    "reason": "新增可空字段，旧代码可继续读写；不重写大表"
  }
}
```

示例名称和摘要仅说明格式，不能原样填入。兼容性声明必须随实际迁移一起审查。仅凭文件名或 SQL 关键词无法推断兼容性。需要长时间锁表、改列含义、删列、重写数据或切换不兼容消息格式时，声明 `maintenance`；整版不可与旧应用共存时设置 `applicationRollbackCompatible=false`。没有控制协议的旧实例遇到待执行迁移时也会走维护路径，提交新 schema 后不能承诺自动启动旧版本。

控制器在新版本可能接收写请求或运行后台任务之前持久记录写入边界。应用声明不可回滚时，越过该边界后只能向前恢复，即使本次没有 SQL 迁移，也不能仅凭迁移账本未变恢复旧代码。

`dataTasks` 是有版本的 SQL 数据变更，字段为 `id`、`path`、`sha256`、`verifyPath`、`verifySha256`，以及上述 `mode`、`backwardCompatible`、`transaction`、`reason`。执行文件必须是事务内 SQL；验收文件是一条返回单个布尔值的查询。执行记录和数据更新在同一事务提交。相同 ID 重跑跳过；同一已执行 ID 修改摘要会拒绝，后续变更使用新 ID。

每个事务使用独立 advisory lock、5 秒取锁超时和 15 分钟语句超时。既有用户、报名、订单、支付、退款、票证和发票的行 ID 在事务内受保护，删除它们会使该更新回滚。任务仍需针对目标记录实现可重复、有限范围的更新，并用验收查询校验业务结果及库存等字段；执行账本不能代替业务幂等设计。

当前入口仅自动执行事务型 SQL。`CREATE INDEX CONCURRENTLY` 等不能进入事务的操作必须作为独立审核的运维变更完成，再发布匹配版本；`transaction=false` 会在停服前被拒绝。不会把无法证明安全的操作猜成在线执行。

## 规范内容与环境设置

新入口不导入 canonical 快照、不做生产整份 JSON 全等、不覆盖 `customerAccounts` 协议、`defaultTemplateId`、`publishedAt`。本地和 CI 的 `canonical:export` / `canonical:check` / 脱敏门禁继续保留。

模板内容通过后台发布，或作为明确的版本化数据任务更新。内容任务必须比较预期版本/摘要，发生后台并发修改就退出；一次事务写入新不可变版本和切换指针，保留现有历史和业务记录。不能把全库 seed 包装成任务。

旧浏览器所需的构建资源保存在 `/var/lib/tokems-bluegreen-assets/`，只合并公开静态产物。Nuxt 的 `builds/latest.json` 属于可变指针，始终从当前版本读取，不参与不可变资源合并。

## 失败与恢复边界

- 镜像准备或预检失败：旧服务保持运行。
- 数据库没有实际提交：在 advisory lock 下核对迁移和任务账本，恢复原服务。不会仅因“开始过更新”而留在停机状态。
- 已提交兼容更新：恢复旧镜像及经过审核的迁移兼容声明，数据库保留增量变更。
- 已提交不兼容更新：保留本地完整目标版本，向前恢复；不会自动恢复数据库备份，也不会启动不兼容旧代码。
- 后台任务或 Nginx 旧连接超过排空期限：退出自动推进并记录恢复状态；不 SIGKILL 长任务。对于没有控制协议的 legacy 容器，若在记录 TERM 意图与实际发送间发生极小窗口的中断，需检查进程是否正在退出，不能靠重复 TERM 猜测，因为旧 Worker 的第二次 TERM 可能中断支付任务。

正常完成要求：全部应用容器健康，API 与备份使用同一数据库，本机与三个公网入口的四项构建身份匹配，公开首页可读取，后台所有权完成交接，并记录业务计数。停止旧版本 Gateway 后再次验收固定 `8088` 和公网入口。生产发布记录仍按 `docs/release-records/TEMPLATE.md` 留存，不能仅以脚本退出码替代实际发布证据。
