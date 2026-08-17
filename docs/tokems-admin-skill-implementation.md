# TokEMS Admin Skill 实施说明

版本：`0.1.1`
状态：`experimental`
日期：2026-08-17

## 当前结论

TokEMS Agent 管理平面、Node.js 连接器、后台审批界面和 governed Skill 发行资产已经形成可测试的实验版本。安全复审完成后，三个远程功能开关继续保持默认关闭：

- `TOKEMS_AGENT_ACCESS_ENABLED`
- `TOKEMS_AGENT_WRITES_ENABLED`
- `TOKEMS_AGENT_CRITICAL_ACTIONS_ENABLED`

本版本适合代码审查、预生产联调和真实客户端证据采集。生产写入与关键动作仍受本文末尾的退出条件约束。

## 数据与迁移

- `0052_hard_rafael_vega.sql` 增加 connection、device authorization、refresh token 和 operation 四张 Agent 表。
- 同一迁移增加 refresh 轮换短期恢复密文、operation 一次性秘密托管字段，以及 membership、connection 和 operation 的组织/用户组合外键。
- 当前 Drizzle inventory 为 72 张表、53 个迁移文件，最新编号为 `0052`。
- Worker 将未完成 operation 限制在每连接 50 条，清理 180 天以前的终态 operation，并保留独立审计记录。

## 服务端能力

### 动作目录与权限边界

- `AgentActionSchema` 定义固定 action ID、路由、权限、scope、数据级别、风险、审批、一致性、验证和回滚契约。
- `@AgentSurface`、`@AgentAction`、`@AgentExcluded` 为管理 handler 提供显式分类。
- 覆盖测试从 `AppModule` 递归发现模块，要求未分类 handler、无 handler action 和重复映射均为零。
- 管理员启停固定升级为 `critical`，要求 `tokems:dangerous` 和浏览器密码 step-up。
- 订单金额、支付事实、支付流水与任意订单字段修改继续排除。

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

当前状态观察在进入领域 handler 前完成，能够拒绝伪造或过期的客户端前态。领域写入与前态比较尚未在全部 action 中共享同一数据库事务；生产写开关需要等 action-specific revision/ETag 条件更新完成后再开启。

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

连接器提供实例发现、设备授权、连接选择、撤销、诊断、capability 同步、固定 action 检查、敏感读取用途、operation 生命周期、一次性秘密恢复和加密 artifact 下载。所有成功命令向 stdout 写入一个脱敏 JSON 对象，浏览器 URL 与授权进度写入 stderr。

模板资产与 HTML import 的签名上传元数据通过加密 artifact 交接。版本 `0.1.1` 仍由受保护的 TokEMS 上传流程完成独立对象存储的二进制上传。

## 审查修复摘要

本轮安全、架构和对抗审查覆盖 16 个可复现问题，已经修复以下高风险路径：

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

发行报告、ZIP 哈希、测试数量和 Review Studio 状态以 `skills/tokems-admin/reports/` 中本次重新生成的证据为准。

## 启用顺序

1. 部署迁移、API、Worker、Gateway 和后台，保持三个开关关闭。
2. 在预生产完成 PostgreSQL、Redis、Keychain/Secret Service、Device Authorization、refresh 恢复、一次性秘密恢复和跨组织隔离验收。
3. 完成 action-specific revision/ETag 原子条件更新后，开启 access 并先验证只读能力。
4. 审核代理审计、PII 掩码、安全指标、撤销演练和 catalog 升级流程，再评估写开关。
5. 完成退款、导出、管理员权限、secret、关键发票文件、通知和高影响批量操作的双人验收，再评估关键动作开关。
6. 收集真实 Codex macOS、Linux desktop 和生产 Docker 证据，完成独立 Review Studio 审核后评估 `active` 状态。

## 生产启用前退出条件

- 每个写 action 的前态比较与领域更新处于同一事务或同一乐观版本条件中。
- operation envelope 通过统一 trace/operation context 关联真实领域审计 ID。
- 所有 `queued` 与 `unknown` action 都有服务端终态 resolver；当前通知投递已完成。
- 公开发布 verifier 将期望 release/revision 与真实 API、HTML 输出绑定。
- 滚动升级采用兼容窗口或连接排空与原子流量切换。
- 干净发布提交上的 Docker build/deploy/smoke、Redis 故障、多实例 DPoP 重放和真实凭据存储证据齐备。
- governed 输出评测完成独立盲审，目标客户端原生权限证据完成归档。

这些项目继续标记为 `missing evidence`、warning 或生产 blocker，Skill 状态维持 `experimental`。
