# TokEMS Admin Skill 实施说明

版本：`0.4.0`
状态：`experimental`
日期：2026-11-07

## 当前结论

TokEMS Agent 管理平面、Node.js 连接器、后台审批界面和 governed Skill 发行资产已经形成可测试的实验版本。安全复审完成后，三个远程功能开关继续保持默认关闭：

- `TOKEMS_AGENT_ACCESS_ENABLED`
- `TOKEMS_AGENT_WRITES_ENABLED`
- `TOKEMS_AGENT_CRITICAL_ACTIONS_ENABLED`

本版本适合代码审查、预生产联调和真实客户端证据采集。生产写入与关键动作仍受本文末尾的退出条件约束。

## 数据与迁移

- `0052_hard_rafael_vega.sql` 增加 connection、device authorization、refresh token 和 operation 四张 Agent 表。
- 同一迁移增加 refresh 轮换短期恢复密文、operation 一次性秘密托管字段，以及 membership、connection 和 operation 的组织/用户组合外键。
- 本轮 CLI 升级复用现有 Agent 表与业务表，无新增数据库迁移；当前数据库 inventory 以 `docs/generated/project-inventory.json` 为准。
- Worker 将未完成 operation 限制在每连接 50 条，清理 180 天以前的终态 operation，并保留独立审计记录。

## 服务端能力

### 动作目录与权限边界

- `AgentActionSchema` 定义固定 action ID、路由、权限、scope、数据级别、风险、审批、一致性、验证和回滚契约。
- `@AgentSurface`、`@AgentAction`、`@AgentExcluded` 为管理 handler 提供显式分类。
- 覆盖测试从 `AppModule` 递归发现模块，要求未分类 handler、无 handler action 和重复映射均为零。
- 管理员启停固定升级为 `critical`，要求 `tokems:dangerous` 和浏览器密码 step-up。
- 订单金额、支付事实、支付流水与任意订单字段修改继续排除。
- Catalog `2.0.0` 定义 158 个动作。可用性同时受 access/write/critical 开关、逐动作验收名单、输入契约、scope 与业务权限约束；未开放写动作明确返回 `AGENT_ACTION_NOT_READY`。飞书发送与凭据管理继续保留人工入口。
- 与 catalog 绑定的 `references/system-contracts.json` 保存动作、管理 handler、模板节点和输入字段快照，CI 在漂移时失败。

### 授权与连接

- OAuth Device Authorization 使用设备端 `user_code`；浏览器按 HMAC 查询并要求管理员核对同一验证码。
- 审批摘要与 step-up 请求哈希绑定验证码、scope、审批策略和授权对象。
- DPoP ES256、Redis `jti` 防重放、10 分钟 access token、轮换 refresh token 和 90 天连接有效期已经接入。
- access token 在连接器中缓存到临近过期；refresh 响应丢失时，同一 DPoP 连接可在两分钟恢复窗口内重新取得同一轮换结果。
- macOS Keychain 与 Linux Secret Service 在授权前执行随机写入、读取、删除往返检查；本地保存失败会用内存中的 refresh token 撤销远端连接。

### Operation 生命周期

- `prepare` 接收临时正文，由服务端重算正文哈希、脱敏审批投影、影响摘要和动态风险；正文不写入数据库。
- `confirm` 与浏览器 `approve` 绑定服务端生成的摘要、正文哈希、目标指纹和前态指纹。
- 管理读取返回短期签名的状态观察 token；执行阶段校验连接、组织、action、目标、状态指纹、正文投影和影响摘要。
- `outbox-job` 会保持 `queued`；通知投递由 Worker 根据真实 delivery 终态推进为 `succeeded/verified` 或 `failed`。
- 客户端提交的验证证据仅记录为 `client-reported`，正式 `verified` 由服务端 verifier 或 Worker 写入。
- verification 并发失败在同一事务中回滚，避免孤立审计记录。
- `one-time-secret` 响应先加密托管一小时。连接器下载并写入本地加密 artifact 后再确认清除，HTTP 响应丢失时仍可恢复。

管理读取与签名前态使用同一 repeatable-read 快照。已开放写动作在 serializable 事务内锁定并复查连接、当前身份、权限和业务前态；领域修改、operation 完成状态和领域审计共同提交或回滚。原有业务服务使用同一事务上下文，HTTP Idempotency-Key 与批准记录绑定；通用幂等缓存只保存 Agent operation 引用，秘密结果继续使用专用加密托管。

### 隐私、安全与可靠性

- `displayName`、`displayCompany`、税务字段和常见身份字段纳入服务端列表掩码。
- `formAnswers`、`answers`、`attendee` 容器中的任意自定义字段值默认全量掩码。
- 组织成员和审计读取升级为 `sensitive-read`，要求 `tokems:pii`、明确用途及安全 scope。
- 客户端输出层增加姓名、公司、税号、地址、微信、自定义答案等二次脱敏。
- 连接器响应上限为 32 MiB，并在 `Content-Length` 和流式读取阶段同时执行限制。
- 本地锁在加锁后重新读取凭据，撤销与刷新共用同一把锁；超过十分钟且进程不存在的锁可安全回收。
- 公开页面检查继续记录状态、ETag、内容摘要和大小。该证据在服务端确认期望 release/revision 前保持 `unverified`。

## 后台界面

- 设备授权页支持验证码输入、查询、显著核对和密码 step-up。
- operation 审批页展示服务端生成的风险、目标、原因、正文哈希、签名前态、脱敏差异、影响和过期时间。
- 组织连接面板支持列表、策略修改、单连接撤销和全部连接紧急撤销。
- 密码字段在发出 step-up 请求前复制到局部值并立即清空页面状态。

## Skill 连接器

Skill 位于 `skills/tokems-admin/`，支持 Codex macOS 和 Linux desktop，Node.js 最低版本为 24。

连接器提供实例发现、设备授权、连接选择、撤销、诊断、capability 同步、固定 action 检查、敏感读取用途、operation 生命周期、安全模板局部修改、一次性秘密恢复和加密 artifact 下载。模板局部修改先读取实时草稿与 revision，再按稳定 `nodeKey` 生成完整草稿请求；未知节点、重复节点和不完整排序会在准备操作前停止。所有成功命令向 stdout 写入一个脱敏 JSON 对象，浏览器 URL 与授权进度写入 stderr。

模板 `organizationGroups` 支持嘉宾、媒体和参会会员三组机构覆盖、动态兜底、显式隐藏、顺序控制及跨组去重。嘉宾输入覆盖 `publicCode`、`bio`、`topicAbstract`、`socialLinks` 等完整资料字段。模板资产与 HTML import 的签名上传元数据通过加密 artifact 交接。版本 `0.4.0` 的 `asset upload` 校验授权实例公布的存储 origin、文件摘要、大小和有效期后完成二进制上传，并准备登记或扫描操作。模板拉取、差异比较和基于真实大会的结构化/HTML 候选预览均已接入。

参会需求读取要求用途与 `tokems:pii`；修改和治理要求版本及原因；导出固定进入关键审批，嘉宾版强制匿名并通过 mode `0600` artifact 下载。飞书日报预览要求用途与 `tokems:finance`。旧 catalog 连接需要使用 `0.4.0` 重新授权。

## 审查修复摘要

历史审查已覆盖以下基础路径，本轮继续补齐事务、读取快照和安装运行验收：

1. 审批摘要和动态风险由服务端生成。
2. 前态改用服务器签名观察 token，并在不可观察时关闭失败。
3. Device Authorization 恢复标准验证码核对。
4. 自定义报名答案与遗漏字段完成 PII 掩码和 scope 升级。
5. outbox `queued` 状态与通知终态完成服务端 reconcile。
6. 客户端验证降级为可审计的声明，无法自行写入 `verified`。
7. 管理员启停升级为关键动作。
8. refresh 响应丢失、Secret Service 误判、本地锁竞态和连接撤销竞态完成恢复处理。
9. one-time secret 增加服务端加密托管、下载确认和过期清理。
10. 每连接未完成 operation 限额、终态保留期和响应大小上限已经加入。

## 验证与发行

本版本的交付门禁包括：

- workspace lint、typecheck、unit/integration test、production build 和文档 inventory。
- Agent API、security、Worker、数据库迁移和 Node.js 连接器测试。
- 设备授权与 operation 审批的桌面、移动端视觉回归。
- Skill IR、OpenAI/generic 编译、触发与输出评测、conformance、trust、permission probe、Skill Atlas、registry、package verify、安装模拟、升级检查和 Review Studio。
- 依赖安全审计。

本轮以 `pnpm check`、`pnpm test:tokems-cli` 和独立 tarball 安装验收为准。`skills/tokems-admin/reports/`、`registry/` 中 2026-08 的 governed 证据与哈希属于 `0.2.0` 历史记录，不能用于证明 `0.4.0` 的生产发布、原生客户端权限或 active 认证。当前分发入口为 `packages/cli`；说明见 [TokEMS CLI](tokems-cli.md)。

## 启用顺序

1. 部署迁移、API、Worker、Gateway 和后台，保持三个开关关闭。
2. 在预生产完成 PostgreSQL、Redis、Keychain/Secret Service、Device Authorization、refresh 恢复、一次性秘密恢复和跨组织隔离验收。
3. 先开启 access 验证只读，再按逐动作验收名单逐步评估写入。
4. 审核代理审计、PII 掩码、安全指标、撤销演练和 catalog 升级流程，再评估写开关。
5. 完成退款、导出、管理员权限、secret、关键发票文件、通知和高影响批量操作的双人验收，再评估关键动作开关。
6. 收集真实 Codex macOS、Linux desktop 和生产 Docker 证据，完成独立 Review Studio 审核后评估 `active` 状态。

## 生产启用前退出条件

- 已开放写 action 使用原子前态检查与领域事务；扩展名单前补齐对应业务验收。
- 已开放写 action 的 operation envelope 通过统一 trace/operation context 关联真实领域审计 ID；新增动作须延续此契约。
- 已接入 HTML 扫描与通知服务端终态 resolver；新增异步动作须补齐 resolver。
- 已接入公开大会 release、下线可见性和根首页模式的 API/HTML verifier；生产域名及多层代理需要执行实际发布验收。
- 滚动升级采用兼容窗口或连接排空与原子流量切换。
- 干净发布提交上的 Docker build/deploy/smoke、Redis 故障、多实例 DPoP 重放和真实凭据存储证据齐备。
- governed 输出评测完成独立盲审，目标客户端原生权限证据完成归档。

这些项目继续标记为 `missing evidence`、warning 或生产 blocker，Skill 状态维持 `experimental`。
