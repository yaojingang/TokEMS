# 系统架构与设计决策

## 目标与形态

系统围绕大会配置、官网发布、报名交易、现场履约和数据复盘建立可追溯闭环。工程采用模块化单体 API 与独立 Worker，领域服务、契约和数据表均保留清晰边界。

```mermaid
flowchart LR
  W["Nuxt 大会前台"] --> A["NestJS REST API"]
  M["Vue 运营后台"] --> A
  A --> P[("PostgreSQL 16+ + pgvector")]
  A --> O["事务 Outbox"]
  O --> Q["Redis + BullMQ"]
  Q --> K["Worker"]
  K --> N["通知提供商"]
  K --> L["候补与库存调度"]
  K --> S["对象存储与导出任务"]
```

## 本地容器拓扑

本地部署使用单一 Compose 项目 `tokems`。外部端口仅绑定到 `127.0.0.1`，应用容器通过内部 DNS 服务名访问 PostgreSQL、Redis、MinIO 和通知接收器。

```mermaid
flowchart TB
  B["本机浏览器"] -->|"localhost:8088"| G["gateway · Nginx"]
  B -->|"admin.localhost:8088"| G
  G -->|"/"| W["web · Nuxt"]
  G -->|"后台域名 /admin"| M["admin · Nginx"]
  G -->|"/api"| A["api · NestJS"]
  A --> P[("postgres · pgvector")]
  A --> S["minio"]
  K["worker · BullMQ"] --> P
  K --> R[("redis")]
  K --> N["notification-sink"]
  D["db-init"] --> P
  I["minio-init"] --> S
```

`db-init` 和 `minio-init` 是可重复执行的一次性任务。API 仅在迁移与种子初始化成功后启动，Web 与 Admin 仅在 API 健康后启动。数据库、Redis 与 MinIO 使用具名数据卷，重建应用镜像不会删除业务数据。

## 上下文边界

| 上下文         | 责任                                       | 关键实体                                                                                          |
| -------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Organization   | 组织、用户、成员、角色、授权与首页默认大会 | organizations, users, memberships, organization_homepage_events                                   |
| Event Planning | 大会、蓝图、内容草稿与生命周期             | events, event_blueprints, speakers, speaker_public_routes, sessions                               |
| Experience     | 共享模板、草稿、版本、资产、大会绑定与覆盖 | conference_templates, conference_template_versions, template_assets, event_template_bindings      |
| Release        | 渲染器、不可变快照、变更记录与回滚指针     | template_packages, event_releases                                                                 |
| Registration   | 版本化表单、条款同意和参会人               | registration_forms, registrations                                                                 |
| Public Metrics | 大会访问累计、按日访问与公开参会聚合       | event_public_metrics, event_public_metric_days, registrations                                     |
| Cooperation    | 大会合作意向、联系方式与运营跟进           | cooperation_requests                                                                              |
| Commerce       | 票种、库存保留、订单、支付、退款和状态日志 | ticket_types, inventory_reservations, orders, payments, refunds                                   |
| Invoice        | 发票申请、文件、状态、访问凭证与导出任务   | invoice_requests, invoice_documents, invoice_state_logs, order_access_tokens, invoice_export_jobs |
| Waitlist       | 售罄排队、顺序邀约、占位和一次性领取       | waitlist_entries                                                                                  |
| Fulfillment    | 电子票、签到列表、设备和核销记录           | tickets, checkin_lists, checkin_devices, checkin_records                                          |
| Engagement     | AI 草稿、审批、通知模板和投递              | ai_runs, notification_templates, notification_deliveries                                          |
| Integrations   | 第三方凭据、飞书群日报订阅与投递账本       | organization_integrations, event_feishu_digest_subscriptions, feishu_digest_deliveries            |
| Platform       | 幂等、事件投递和审计                       | idempotency_keys, outbox_events, audit_logs                                                       |

## 发布快照

运营后台在大会上线前保存草稿。大会进入预发布或报名开放状态时，系统生成首个公开版本；此后每次有效保存都以当前生效快照为基线，只合并本次修改所在模块，把体验配置、大会字段、票种价格与文案、嘉宾、议程、报名表和服务条款固化为不可变 JSON 快照，并原子更新 `currentReleaseId`。相同内容重复保存不会新增版本。官网读取该指针对应的快照并重新校验；库存保留、已售和候补占位继续实时计算。回滚会立即切换公开指针，后续每次保存继续以回滚后的生效快照为基线，其他模块保持回滚版内容。

公开首页使用两级解析：`/{eventSlug}` 先匹配大会当前地址，再匹配 `event_slug_aliases` 历史地址；历史地址使用 308 跳转到当前规范地址。`/` 通过 `organization_homepage_events` 找到组织默认大会，再复用同一渲染链路，数据库关系是首页大会的唯一配置源。HTML 模板、结构化 Nuxt 页面和故障回退页统一输出大会独立地址作为 canonical URL。根首页和大会独立页采用重新验证缓存，默认大会切换后无需重建前端资源。

该模型让内容变更、价格变更和条款变更在保存成功后立即生效，同时保留完整的变更记录与回滚能力。报名创建时再次锁定票种并核对当前生效版本，避免旧页面提交到新版本。

## 报名、支付与候补

```mermaid
sequenceDiagram
  participant U as 参会人
  participant API as API
  participant DB as PostgreSQL
  participant W as Worker
  U->>API: 报名 + 幂等键
  API->>DB: 锁票种并校验发布快照
  API->>DB: 报名、订单、库存保留、Outbox
  API-->>U: 待支付订单
  U->>API: 渠道签名回调
  API->>DB: 校验金额并签发电子票
  DB-->>W: Outbox 投递
  W-->>U: 票证通知
```

可售数公式：

```text
capacity - sold - active reservations - active waitlist offers
```

票种行锁保护库存计算。事务级顾问锁串行化相同幂等键、报名联系方式和候补邀约。订单保留十五分钟。支付回调验证原始正文 HMAC、五分钟时间窗、金额、币种和渠道外部流水唯一性。

售罄后可进入候补队列。库存因保留过期或全额退款释放时，Worker 按位置邀请第一位等待者，并创建两小时占位。原始邀请令牌只进入通知正文，数据库保存 SHA-256 哈希和末四位。成功报名会把邀请标记为已领取，重放请求会被拒绝。

## 现场核销

在线核销通过 `ticket_id + checkin_list_id` 唯一约束防止重复成功。离线设备首次登记时获得一次性明文令牌，数据库仅保存令牌哈希。每个同步批次绑定组织、大会、设备、批次键和正文哈希；同键同参返回缓存结果，同键异参返回冲突。100 台设备并发验收覆盖报名、支付、发票、同步和重试全过程。

## 一致性与异步处理

- PostgreSQL 保存业务事实，Redis 承载 BullMQ 队列。
- 金额使用整数最小货币单位，订单保存价格快照。
- 业务事实和 Outbox 在同一事务提交。
- Worker 使用 Outbox ID 作为 Job ID，成功投递后回写发布时间。
- 达到阈值的发票导出进入 Worker，结果写入对象存储并通过短期签名链接下载。
- 模板资产删除先验证全部草稿、版本、大会覆盖和发布快照引用，再由 Worker 执行对象删除。
- 退款、订单、报名和电子票均保留状态日志或审计证据。
- 过期库存和候补邀请由 Worker 周期扫描，重复执行保持幂等。

## 多组织与安全

- JWT 只承载身份和组织声明；AuthGuard 在每个后台请求中重新读取成员关系和授权。
- 服务层所有运营查询都带 `organization_id` 范围，跨组织读写返回 404。
- 授权支持精确权限和 `event.*` 通配权限。
- 成员授权受委派上限约束，成员管理员不能修改自己的角色或授予超出自身范围的权限。
- 在线和离线核销同时校验登录成员、设备、大会和电子票的组织范围。
- 密码使用 bcrypt；生产环境强制至少 32 字符的 `JWT_SECRET`。
- Helmet、域名白名单 CORS、2 MiB 正文限制、受信代理范围、请求 ID 清洗和分层限流位于 API 入口。
- 支付回调、设备令牌和候补令牌均采用时间窗、哈希或防重放控制。
- 订单、参会人发票入口和发票文件使用带范围与有效期的随机访问凭证，数据库只保存 SHA-256 摘要。
- 500 错误不会把堆栈、SQL 或内部异常文本返回客户端。
- AI 输出先进入草稿，只有人工审批后的内容才能排队发送。

单实例限流使用 NestJS 内存存储。公开报名限制为每 IP 每分钟 60 次，首页访问登记限制为每 IP 每分钟 30 次。页面级随机 UUID 只在 Redis 中保留 10 分钟用于幂等，访问总量通过 PostgreSQL 原子自增；持久层不保存访客 Cookie、原始 IP 或 User-Agent。多实例生产环境需要在 API 网关或共享 Redis 限流存储中执行同等策略；大型公开活动建议额外启用验证码或联系方式验证。

## 视觉系统

前台保留原型的中性白底、蓝色主张、编辑感留白、高密度数据块和强转化路径。后台保留深蓝侧栏、宋体页面标题、表格化信息密度和可折叠移动导航。响应式断点延续原型的 1100px、820px 和 560px 规则。

## 外部适配边界

- 支付渠道通过签名 Webhook 适配，渠道密钥按 `PAYMENT_WEBHOOK_SECRET_<PROVIDER>` 配置。
- 通知渠道通过带幂等键的 HTTP Webhook 适配，可接短信、邮件、企业微信或统一消息中心。
- MinIO/S3 保存模板图片、电子发票文件和异步导出文件；上传注册前校验对象大小、媒体类型和 SHA-256。
- `AI_API_URL`、`AI_API_KEY` 和 `AI_MODEL` 接入兼容的内容生成服务。
- OpenTelemetry、Prometheus 和集中日志可在 API/Worker 入口接入。

### Agent 管理平面

`tokems-admin` Skill 通过 Gateway 发现实例，由 Device Authorization 建立单组织连接。连接记录固定管理员成员关系、授权版本、scope、DPoP 公钥指纹和审批策略；管理员凭据不会进入 Agent 进程。访问令牌短期有效，refresh token 单次轮换，重放会撤销整个 token family 与连接。DPoP `jti` 通过 Redis 原子占位防重放，Redis 不可用时拒绝 Agent 请求。

Agent 管理 handler 以动作目录为发布边界。所有后台 handler 都需要标记为已发布动作或明确排除，覆盖测试阻止未分类路由进入构建。当前目录包含 78 个动作并逐一映射 78 个管理 handler。写操作经过 prepare、confirm/approve、execute、verify/reconcile 生命周期，服务端保存脱敏差异、正文摘要、前态指纹、目标指纹、审批、验证和代理审计关联，完整正文与固定 secret header 留在连接器的本地加密待执行文件中。

普通 PII 列表由 API 在响应阶段统一掩码，敏感详情要求用途、PII scope 和读取审计。公开内容操作完成后，连接器对管理 API 状态、同一 TokEMS origin 上的公开大会或首页 API、以及已发布 HTML home-document 执行查询式验证；证据以 SHA-256、HTTP 状态和 ETag 形式写回 operation，页面正文不进入审计或聊天输出。

连接和写入由三个独立开关逐级开放：`TOKEMS_AGENT_ACCESS_ENABLED`、`TOKEMS_AGENT_WRITES_ENABLED`、`TOKEMS_AGENT_CRITICAL_ACTIONS_ENABLED`。应用回滚保留连接、operation 与审计表。
