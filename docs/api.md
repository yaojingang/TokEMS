# REST API 接口摘要

Base URL：`http://localhost:8088/api/v1`

Swagger UI：`http://localhost:8088/api/docs`

OpenAPI JSON：`http://localhost:8088/api/openapi.json`

## 通用请求约定

- 后台接口使用 `Authorization: Bearer <token>`。
- 多组织公开读取可传 `X-Organization-Slug`，默认值来自 `PUBLIC_ORGANIZATION_SLUG`。
- 关键写操作使用 8 到 160 字符的 `Idempotency-Key`。
- `eventId` 统一为 `101`–`2147483647` 的正整数。首场大会为 `101`，新建成功后全局递增 1，已分配编号不复用。
- 支付回调使用 `X-Payment-Timestamp` 和 `X-Payment-Signature`。
- 离线核销同步使用设备首次登记时返回的 `X-Device-Token`。
- API 默认对全局、登录、报名、候补和支付回调分别执行请求限流。

## Agent Access（实验性）

Agent Access 默认关闭，通过 OAuth Device Authorization 将本地 `tokems-admin` Skill 与一个确定的 TokEMS 实例、组织和超级管理员授权绑定。管理员密码只在 TokEMS 后台的 step-up 页面输入，连接器使用 DPoP 绑定的短期访问令牌和轮换 refresh token。

| Method   | Path                                            | 说明                               |
| -------- | ----------------------------------------------- | ---------------------------------- |
| GET      | `/.well-known/tokems-agent`                     | 实例身份、版本和功能开关           |
| GET      | `/.well-known/oauth-authorization-server`       | OAuth 端点元数据                   |
| POST     | `/oauth/device_authorization`                   | 创建设备授权请求                   |
| POST     | `/oauth/token`                                  | 设备码换取令牌或轮换 refresh token |
| POST     | `/oauth/revoke`                                 | 撤销 refresh token 对应连接        |
| POST     | `/auth/step-up`                                 | 后台管理员密码二次确认             |
| GET      | `/agent/capabilities`                           | 当前连接可用动作目录               |
| POST     | `/agent/operations`                             | 准备并绑定一项写操作               |
| GET      | `/agent/operations/:operationId`                | 查询执行与验证状态                 |
| POST     | `/agent/operations/:operationId/confirm`        | 确认无需浏览器审批的操作           |
| POST     | `/agent/operations/:operationId/cancel`         | 取消尚未完成的操作                 |
| POST     | `/agent/operations/:operationId/verify`         | 记录查询式验证摘要与证据类型       |
| GET      | `/admin/agent-connections`                      | 后台查看当前组织连接               |
| PATCH    | `/admin/agent-connections/:connectionId/policy` | step-up 后修改连接审批策略         |
| POST     | `/admin/agent-connections/:connectionId/revoke` | 撤销单个连接                       |
| POST     | `/admin/agent-connections/revoke-all`           | step-up 后紧急撤销当前组织全部连接 |
| GET      | `/admin/agent-security-metrics`                 | 连接、授权、操作与安全告警摘要     |
| GET/POST | `/admin/agent-authorizations/:authorizationId`  | 查看并批准或拒绝设备授权           |
| GET/POST | `/admin/agent-operations/:operationId`          | 查看并批准或拒绝受控、关键操作     |

写请求需要 `X-Agent-Operation-Id`、`X-Agent-Request-Hash`、`X-Agent-Before-Fingerprint` 与 `X-Agent-Current-Before-Fingerprint`。API 在进入领域逻辑前核对已批准操作、正文哈希、准备时前态、执行前新鲜前态以及路由参数和查询参数的目标指纹。`checkin.sync` 的设备令牌通过固定的 `X-Device-Token` 头传递。敏感读取还需要 `X-Agent-Purpose`。未知管理路由固定拒绝；动作目录未分类检查在 CI 中要求为零。

当前 catalog 版本发布 78 个动作并映射到 78 个管理 handler。普通报名、用户、订单、退款和发票列表在 Agent 响应离开 API 前执行 PII 掩码；敏感详情需要 `tokems:pii`、明确用途和读取审计。公开内容执行成功后，官方连接器同时读取管理验证动作、公开大会或首页 API，以及已发布 `home-document`，再把组合证据摘要写回 operation。

Scope 包含 `tokems:read`、`tokems:pii`、`tokems:write`、`tokems:finance`、`tokems:communications`、`tokems:export`、`tokems:security` 和 `tokems:dangerous`。`tokems:*` 只作为超级管理员授权界面的全量选择语义，令牌中保存展开后的具体 scope。

## 公开与交易接口

| Method | Path                                                      | 说明                                        |
| ------ | --------------------------------------------------------- | ------------------------------------------- |
| GET    | `/homepage`                                               | 获取组织首页默认大会的当前公开快照          |
| GET    | `/homepage/home-document`                                 | 获取首页默认大会的已发布 HTML 首页          |
| GET    | `/events/:slug`                                           | 获取当前发布快照及实时库存                  |
| GET    | `/events/:slug/home-document`                             | 获取指定大会的已发布 HTML 首页              |
| POST   | `/events/:slug/public-metrics/view`                       | 登记结构化首页单次页面访问                  |
| POST   | `/cooperation-requests`                                   | 匿名提交单场公开大会的合作申请              |
| POST   | `/registrations`                                          | 创建报名、订单和库存保留，可领取候补资格    |
| POST   | `/waitlist`                                               | 售罄票种加入候补队列                        |
| GET    | `/orders/:identifier`                                     | 使用订单访问凭证按订单 ID 或订单号查询      |
| POST   | `/orders/access-links`                                    | 按订单信息申请带范围和有效期的访问凭证      |
| GET    | `/orders/:orderId/invoice-request`                        | 使用订单访问凭证读取发票申请                |
| POST   | `/orders/:orderId/invoice-request`                        | 使用订单访问凭证提交或补充发票资料          |
| GET    | `/orders/:orderId/invoice-documents/:documentId/download` | 使用发票下载权限获取文件                    |
| POST   | `/payments/webhook/:provider`                             | 支付渠道签名回调                            |
| GET    | `/payments/mock/:orderId/capability`                      | 使用订单凭证查询本机模拟支付权限            |
| POST   | `/payments/mock/:orderId/confirm`                         | 白名单本机账户使用订单凭证确认模拟支付      |
| GET    | `/tickets/:codeOrRegistrationId`                          | 按票号或报名 ID 查询电子票                  |
| POST   | `/checkins`                                               | 需要 `event.checkin.execute` 授权的在线核销 |
| GET    | `/health`                                                 | API、数据库和运行模式健康状态               |

公开大会响应的 `publicMetrics` 包含累计访问、统计起始时间、已确认参会人数、去重企业数和去重城市数。访问登记请求体为 `{ "pageViewId": "<UUID>" }`，同一大会与页面 UUID 在 Redis 中保持 10 分钟幂等，每 IP 每分钟最多登记 30 次。已知机器人不会增加计数；Redis 暂时不可用时由 PostgreSQL 原子自增继续服务。持久层不保存访客 Cookie、原始 IP、User-Agent 或个人资料。

报名请求示例：

```json
{
  "eventId": 101,
  "ticketTypeId": "33333333-3333-4333-8333-333333333331",
  "attendee": {
    "name": "林知夏",
    "mobile": "13800138000",
    "email": "lin@example.com",
    "company": "深圳未来品牌实验室",
    "title": "品牌增长负责人",
    "city": "深圳"
  },
  "invoiceRequired": false,
  "marketingConsent": true,
  "termsAccepted": true,
  "formVersion": 2,
  "termsVersion": "2026-07"
}
```

合作申请要求 `Idempotency-Key`，每 IP 每分钟最多提交 10 次，只接受预发布、报名开放、进行中或已结束大会。合作方向可选择 1 至 3 项，手机、邮箱和微信号至少填写一项；成功响应仅包含申请编号、大会名称和提交时间。

## 组织网站统计

| Method | Path                            | 授权或说明                                      |
| ------ | ------------------------------- | ----------------------------------------------- |
| GET    | `/admin/organization/settings`  | `org.settings.read`，读取组织设置和统计确认状态 |
| PUT    | `/admin/organization/analytics` | `org.analytics.manage`，关键级启停与代码确认    |

更新请求为 `{ "enabled": boolean, "snippet": string }`。启用时只接受百度统计、Google Analytics 4 和 Umami 的标准完整代码，并要求 HTTPS 资源、匹配的统计 ID 和单一受支持结构。服务端只持久化平台、统计 ID、脚本地址和站点 ID；审计记录包含启停状态、平台、代码摘要和脚本域名。通用组织设置接口拒绝 `analytics` 字段。旧配置需要通过专用接口重新确认后才会进入公开页面。

候补邀请报名会附加 `waitlistOfferToken`。服务端校验邀请票种、邮箱、过期时间和领取状态。报名响应中的 `orderAccessToken` 只返回给当前参会人，前端在会话存储中保存并用于订单页。访问链接接口按订单校验信息签发短期令牌，数据库只保存摘要；通知链接把令牌放在 URL 片段中，避免令牌进入服务端访问日志。公开报名限制为每 IP 每分钟 60 次；同一大会按已验证用户账号与手机号保持一条报名记录，邮箱可由多个报名人共用。

支付渠道对原始请求体计算签名：

```text
hex(hmac_sha256(secret, "<timestamp>.<raw-json-body>"))
```

时间戳使用毫秒，允许时间窗为五分钟。回调正文包含 `orderId`、`externalId`、`status`、`amount`、`currency` 和 `occurredAt`。

## 认证与组织

| Method | Path                                               | 授权或说明                                 |
| ------ | -------------------------------------------------- | ------------------------------------------ |
| POST   | `/auth/login`                                      | 公开，10 次/分钟/IP，可指定组织            |
| GET    | `/auth/me`                                         | 当前用户、组织、角色、权限和管理员导航偏好 |
| PATCH  | `/auth/preferences/admin`                          | 更新当前成员最近大会，清理时可提交 `null`  |
| POST   | `/auth/invitations/accept`                         | 公开，接受一次性组织邀请                   |
| GET    | `/admin/organization/members`                      | `org.member.read`                          |
| PATCH  | `/admin/organization/members/:membershipId`        | `org.member.manage`                        |
| PATCH  | `/admin/organization/members/:membershipId/status` | `org.member.manage`，启用或停用            |
| DELETE | `/admin/organization/members/:membershipId`        | `org.member.manage`，移除成员              |
| POST   | `/admin/organization/administrators`               | 超级管理员，直接创建管理员                 |
| PATCH  | `/admin/organization/administrators/:membershipId` | 超级管理员，修改用户名或重置密码           |
| DELETE | `/admin/organization/administrators/:membershipId` | 超级管理员，删除当前组织管理员权限         |
| GET    | `/admin/organization/invitations`                  | `org.member.read`                          |
| POST   | `/admin/organization/invitations`                  | `org.member.manage`                        |
| DELETE | `/admin/organization/invitations/:invitationId`    | `org.member.manage`，取消邀请              |
| GET    | `/admin/organization/settings`                     | 组织设置读取                               |
| PATCH  | `/admin/organization/settings`                     | 组织设置修改                               |

邀请创建响应中的 `acceptanceToken` 只返回一次，72 小时内有效。数据库保存令牌摘要，后台把令牌放在链接片段中，避免令牌进入 Web 服务器请求日志。登录可提交 `organizationSlug` 选择邀请对应的组织。

## 普通用户账号

普通用户会话使用 HttpOnly Cookie。登录成功响应返回 CSRF 令牌，资料修改、报名认领、发票提交和退出操作需要通过 `X-CSRF-Token` 传回。

| Method | Path                                             | 授权或说明                                                       |
| ------ | ------------------------------------------------ | ---------------------------------------------------------------- |
| POST   | `/customer-auth/otp`                             | 公开，请求手机验证码                                             |
| POST   | `/customer-auth/verify`                          | 公开，验证并自动登录或首次注册                                   |
| GET    | `/customer-auth/session`                         | 查询当前普通用户会话                                             |
| POST   | `/customer-auth/logout`                          | 普通用户会话与 CSRF                                              |
| POST   | `/customer-auth/logout-all`                      | 撤销当前用户全部会话                                             |
| GET    | `/customer/profile`                              | 当前用户资料                                                     |
| PATCH  | `/customer/profile`                              | 更新可选资料与版本号                                             |
| GET    | `/customer/registrations`                        | 报名历史游标分页                                                 |
| GET    | `/customer/registrations/:registrationId`        | 报名、订单、电子票详情                                           |
| GET    | `/customer/events/:eventId/purchase-context`     | 本人参会、本人购买、可追加名额和推荐动作                         |
| GET    | `/customer/orders`                               | 按购票人归属返回订单、参会人、支付、发票和票状态                 |
| PATCH  | `/customer/orders/:orderId/attendee`             | 购票人在名额认领前修改参会人资料并轮换认领邀请                   |
| POST   | `/customer/attendee-claims`                      | 使用独立参会人令牌认领一个报名名额                               |
| POST   | `/customer/registration-claims`                  | 同手机号订单访问凭证，一次性认领                                 |
| GET    | `/customer/invoices`                             | 发票中心分类、准确数量、游标分页与可用操作                       |
| GET    | `/customer/orders/:orderId/invoice`              | 读取本人订单的发票申请                                           |
| GET    | `/customer/orders/:orderId/invoice-context`      | 读取订单号、大会与扣除成功退款后的可开票金额                     |
| POST   | `/customer/orders/:orderId/invoice`              | 首次创建本人订单的发票申请                                       |
| PATCH  | `/customer/orders/:orderId/invoice`              | 携带 `expectedUpdatedAt` 修改已有发票资料                        |
| POST   | `/customer/orders/:orderId/invoice/send`         | 已开具发票重新发送，持久化冷却并限制请求频率                     |
| GET    | `/admin/customers`                               | `customer.read`，用户搜索与游标分页                              |
| POST   | `/admin/customers`                               | `customer.manage`，后台预建手机号用户账号，返回 `{ customerId }` |
| GET    | `/admin/customers/export.csv`                    | `customer.read` + `customer.export`，按当前筛选导出完整用户目录  |
| GET    | `/admin/customers/:customerUserId`               | `customer.read`，用户详情和首批历史                              |
| GET    | `/admin/customers/:customerUserId/registrations` | `customer.read`，继续加载报名历史                                |
| PATCH  | `/admin/customers/:customerUserId`               | `customer.manage`，状态修改另需高权限                            |
| DELETE | `/admin/customers/:customerUserId`               | `customer.delete`，删除账号并保留历史                            |

用户列表支持按姓名、用户名、公司、邮箱、完整手机号和完整用户 UUID 搜索。响应包含准确总数、账号资料与最近报名资料合成的显示姓名和公司、报名记录数、报名大会数，以及结构化的最新报名信息。完整手机号按 E.164 返回，管理端以国内 11 位格式显示。

用户导出沿用列表的 `q`、`status` 和 `eventId` 筛选，覆盖同一数据库快照内的全部分页结果，单次上限为 50,000 条，每个访问来源每小时最多请求 5 次。CSV 使用 UTF-8 BOM，并对公式起始字符转义；用户列表和导出响应均禁止缓存。导出审计只记录筛选是否存在和结果数量，不保存搜索词或用户字段明文。

普通用户没有独立的密码登录或公开账号注册接口。`/customer-auth/verify` 会为首次验证的“组织 + 手机号”创建账号，已有账号会直接建立新会话。具备 `customer.manage` 权限的后台成员可以预建手机号账号和基础资料，预建过程不创建登录会话，用户首次登录仍需通过短信验证码。本地 `fake` 模式在验证码申请响应中返回固定演示验证码 `123456`；正式 `provider` 模式不会在响应中返回验证码。

历史报名认领令牌同时校验组织、报名、有效期、权限范围和当前登录手机号。成功后令牌中的认领权限立即消费。

大会报名采用“一笔订单对应一个参会名额”。登录用户可以为本人购买，也可以在大会开启追加名额后为其他参会人多次下单。`settings.registration.additionalPurchaseEnabled` 默认 `false`，单个购票人在同一大会的有效名额上限默认 5。现代订单以 `purchaserCustomerUserId` 作为财务所有权，账号删除后保持订单、票和发票；仅 `purchaserCustomerUserId` 与 `purchaseIntentId` 同时为空的历史订单允许按原报名账号回退。参会人认领只获得本人报名和电子票权限。

发票首次申请与资料更新使用独立契约。更新请求和后台状态操作携带 `expectedUpdatedAt`，服务在事务锁内核对版本；检测到其他页面或工作人员已更新记录时返回 `409`，客户端刷新最新状态后再继续。发票中心以订单创建时间和订单 ID 作为稳定游标，申请状态变化不会让记录在翻页期间跳动。普通用户时间线只返回公开状态文案；驳回原因可以展示，内部操作者、元数据和后台备注不会返回。

## 大会、内容与发布

| Method            | Path                                                  | 说明                                           |
| ----------------- | ----------------------------------------------------- | ---------------------------------------------- |
| GET/POST          | `/admin/events`                                       | 大会列表与新建，新建必须提交已发布模板版本     |
| GET               | `/admin/event-options`                                | 后台入口与大会切换使用的轻量大会列表           |
| GET               | `/admin/event-slugs/availability`                     | 检查一级短地址是否可用，需 `event.manage`      |
| PUT               | `/admin/organization/homepage-event`                  | 设置组织首页默认大会，需 `org.settings.manage` |
| GET/PATCH         | `/admin/events/:eventId`                              | 大会详情与保存生效、状态更新                   |
| PATCH             | `/admin/events/:eventId/public-url`                   | 修改大会一级短地址，需 `event.manage`          |
| GET               | `/admin/event-blueprints`                             | 大会蓝图                                       |
| GET               | `/admin/template-packages`                            | 前台模板包                                     |
| GET               | `/admin/events/:eventId/template-binding`             | 模板绑定、当前版本和升级状态                   |
| PUT               | `/admin/events/:eventId/template-binding`             | 升级或替换大会模板                             |
| POST              | `/admin/events/:eventId/save-as-template`             | 从大会解析配置创建并发布模板 V1                |
| GET               | `/admin/events/:eventId/experience`                   | 读取模板与大会覆盖的解析结果                   |
| PUT               | `/admin/events/:eventId/experience/:surface`          | 保存首页、FAQ 或流程覆盖                       |
| POST              | `/admin/events/:eventId/experience/validate`          | 体验配置校验                                   |
| POST              | `/admin/events/:eventId/experience/preview`           | 生成大会体验预览                               |
| GET/POST          | `/admin/events/:eventId/releases`                     | 变更记录与兼容手动激活接口                     |
| POST              | `/admin/events/:eventId/releases/:releaseId/rollback` | 回滚公开快照指针                               |
| GET               | `/admin/events/:eventId/content`                      | 嘉宾、议程和内容配置                           |
| POST/PATCH/DELETE | `/admin/events/:eventId/ticket-types[/:ticketTypeId]` | 票种维护与可恢复下架                           |
| GET               | `/admin/events/:eventId/ticket-types/archived`        | 已下架票种                                     |
| POST              | `/admin/events/:eventId/ticket-types/:id/restore`     | 恢复票种并按大会状态生效                       |
| POST/PATCH/DELETE | `/admin/events/:eventId/speakers[/:speakerId]`        | 嘉宾维护                                       |
| POST/PATCH/DELETE | `/admin/events/:eventId/sessions[/:sessionId]`        | 议程维护                                       |
| GET               | `/admin/events/:eventId/registration-forms`           | 报名表版本                                     |
| POST              | `/admin/events/:eventId/registration-forms/publish`   | 保存报名表和条款版本并生效                     |

大会更新的 `settings.registration` 包含 `paymentMode`、`currency` 和 `registrationOpen`。大会进入预发布或报名开放状态后，基本信息、体验、报名、票种、内容、表单的有效保存会在同一事务生成不可变快照并切换公开指针。`free` 模式要求全部票种价格为 0，零元报名会在同一事务完成订单、库存和电子票。

每场大会的规范前台地址为 `/{eventSlug}`。新地址使用 3–24 位小写字母、数字或连字符，推荐 4–12 位；创建大会时可以自定义，留空会生成 `e` 加 6 位随机字符的短地址。修改地址后，旧地址记录在 `event_slug_aliases` 并使用 308 永久跳转到新地址，历史链接持续可用。系统保留路径和当前组织内其他大会的现用、历史地址均不可占用。

前台根地址 `/` 从数据库读取组织首页默认大会并保持根地址展示；兼容地址 `/?event={eventSlug}` 使用 308 跳转到规范地址。报名、FAQ、订单、电子票、发票和账号等共享流程继续通过 `event` 查询参数携带大会范围。

首页默认大会按组织保存，一次只能选择一场。目标大会必须处于预发布、报名开放、进行中或已结束状态，并且存在当前发布版本。默认大会切换会写入审计记录；当前默认大会在切换到另一场可用大会前不能转为非公开状态。

## 大会模板

| Method    | Path                                     | 授权或说明                              |
| --------- | ---------------------------------------- | --------------------------------------- |
| GET       | `/admin/templates`                       | `org.template.read`，模板列表与使用统计 |
| GET       | `/admin/template-options`                | `org.template.use`，已发布模板选项      |
| POST      | `/admin/templates`                       | `org.template.manage`，创建或复制模板   |
| GET/PATCH | `/admin/templates/:templateId`           | 读取详情或修改元信息                    |
| GET/PUT   | `/admin/templates/:templateId/draft`     | 读取或按修订号保存结构化草稿            |
| POST      | `/admin/templates/:templateId/publish`   | `org.template.publish`，发布不可变版本  |
| GET       | `/admin/templates/:templateId/versions`  | 版本历史                                |
| GET       | `/admin/templates/:templateId/usages`    | 使用大会与升级状态                      |
| POST      | `/admin/templates/:templateId/duplicate` | 复制已发布版本                          |
| POST      | `/admin/templates/:templateId/archive`   | 归档模板                                |
| POST      | `/admin/templates/:templateId/restore`   | 恢复模板                                |
| GET       | `/admin/template-assets`                 | 模板图片列表与短期预览地址              |
| POST      | `/admin/template-assets/uploads`         | 获取对象存储预签名上传地址              |
| POST      | `/admin/template-assets`                 | 校验已上传对象并登记资产                |
| DELETE    | `/admin/template-assets/:assetId`        | 删除无引用资产并排队清理对象            |

模板版本发布后保持不可变。大会绑定明确的 `templateVersionId`，升级或替换需要独立确认，保存成功后按大会状态立即生效。模板资产登记会核对组织路径、媒体类型、文件大小和 SHA-256。

## 发票管理

| Method | Path                                                                            | 授权或说明                                              |
| ------ | ------------------------------------------------------------------------------- | ------------------------------------------------------- |
| GET    | `/admin/events/:eventId/invoices`                                               | `event.read` + `org.invoice.read`，搜索、筛选和游标分页 |
| GET    | `/admin/events/:eventId/invoices/pending-count`                                 | 当前大会待处理数量                                      |
| GET    | `/admin/events/:eventId/invoices/:invoiceId`                                    | 路由化详情与状态时间线                                  |
| POST   | `/admin/events/:eventId/invoices/:invoiceId/approve`                            | 审核通过                                                |
| POST   | `/admin/events/:eventId/invoices/:invoiceId/reject`                             | 驳回并记录原因                                          |
| POST   | `/admin/events/:eventId/invoices/:invoiceId/retry`                              | 重新进入审核                                            |
| POST   | `/admin/events/:eventId/invoices/:invoiceId/issue-failed`                       | 标记开票失败                                            |
| POST   | `/admin/events/:eventId/invoices/:invoiceId/cancel`                             | 取消申请                                                |
| POST   | `/admin/events/:eventId/invoices/:invoiceId/document-uploads`                   | 获取 PDF/OFD 预签名上传地址                             |
| POST   | `/admin/events/:eventId/invoices/:invoiceId/documents`                          | 校验对象并登记电子发票                                  |
| POST   | `/admin/events/:eventId/invoices/:invoiceId/documents/:documentId/void`         | 作废指定文件                                            |
| POST   | `/admin/events/:eventId/invoices/:invoiceId/documents/:documentId/replace-file` | 验证新对象并原子替换或恢复指定文件                      |
| POST   | `/admin/events/:eventId/invoices/:invoiceId/send`                               | 重新发送当前有效发票                                    |
| GET    | `/admin/events/:eventId/invoices/:invoiceId/documents/:documentId/download`     | 获取短期下载地址并记录审计                              |
| GET    | `/admin/events/:eventId/invoices/export.csv`                                    | 小结果直接导出，大结果创建 Worker 任务                  |
| GET    | `/admin/events/:eventId/invoices/export-jobs/:exportJobId`                      | 查询当前大会异步导出状态                                |
| POST   | `/admin/events/:eventId/invoices/export-jobs/:exportJobId/retry`                | 重试失败任务                                            |
| GET    | `/admin/events/:eventId/invoices/export-jobs/:exportJobId/download`             | 获取短期导出文件地址                                    |
| POST   | `/admin/events/:eventId/invoices/batch-imports/preflight`                       | 校验批量导入清单、申请单状态与文件映射                  |

重新上传文件沿用原发票文件 ID。新对象通过大小、媒体类型、文件签名和 SHA-256 校验后，在事务内切换存储对象；替换失败时旧文件继续有效。删除采用带原因的作废记录，用户下载接口会立即拒绝已删除文件；重新上传已删除文件会恢复同一文件 ID，并将交付状态重置为未发送。

所有管理接口同时校验组织和大会范围。CSV 导出对公式起始字符进行转义。达到 `INVOICE_ASYNC_EXPORT_THRESHOLD` 的查询进入 Worker，默认阈值为 50,000 条。

## 运营、履约与审计

| Method   | Path                                              | 说明                       |
| -------- | ------------------------------------------------- | -------------------------- |
| GET      | `/admin/events/:eventId/dashboard`                | 指标和票种库存             |
| GET      | `/admin/events/:eventId/registrations`            | 报名分页查询               |
| GET      | `/admin/events/:eventId/registrations/:id`        | 报名、订单与用户账号详情   |
| GET      | `/admin/events/:eventId/cooperation-requests`     | 合作申请搜索、筛选与分页   |
| GET      | `/admin/events/:eventId/cooperation-requests/:id` | 合作申请详情               |
| PATCH    | `/admin/events/:eventId/cooperation-requests/:id` | 更新跟进状态与内部备注     |
| GET      | `/admin/events/:eventId/orders`                   | 订单查询                   |
| GET      | `/admin/events/:eventId/waitlist`                 | 候补队列                   |
| POST     | `/admin/orders/:orderId/refunds`                  | 全额或部分退款             |
| GET      | `/admin/refunds`                                  | 退款记录                   |
| GET      | `/admin/events/:eventId/inventory`                | 实时库存、保留和候补占位   |
| POST     | `/admin/inventory/release-expired`                | 释放过期库存               |
| GET/POST | `/admin/events/:eventId/checkin-devices`          | 核销设备列表与登记         |
| POST     | `/admin/checkins/sync`                            | 设备令牌保护的离线批次同步 |
| GET      | `/admin/audit-logs`                               | 审计查询                   |
| GET      | `/admin/events/:eventId/registrations/export.csv` | 报名 CSV 导出              |

原有 `/admin/dashboard?eventId=`、`/admin/registrations?eventId=` 和 `/admin/orders?eventId=` 在兼容周期内继续可用。

Dashboard 指标口径：`paidOrders` 为 `paid` 或 `partially_refunded` 订单数；`paidSeats` 为这些订单对应的非取消有效报名席位数；`confirmedAttendees` 为未被归并且状态为 `confirmed`、`checked_in` 或 `completed` 的报名数；`purchasers` 为付费订单的去重购票人数；`revenue` 为订单金额扣除成功退款后的净额。`conversionRate` 使用 `paidSeats / submitted active registrations`。报名 CSV 分列导出购票人与参会人资料、订单归属、购买意图和订单总额，所有单元格继续执行公式注入防护。

报名分页查询支持 `q`、`status`、`page` 和 `pageSize`，`pageSize` 范围为 1 到 100。响应为 `{ items, total, page, pageSize }`。报名详情需要 `event.registration.read`，关联用户账号资料还需要 `customer.read`；缺少用户查看权限时通过 `customerRelation: "restricted"` 明确标记。

合作申请列表使用 `event.registration.read`，支持 `q`、`status`、`type`、`page` 和 `pageSize`。详情响应使用 `private, no-store`；修改需要 `event.registration.manage`，只接受 `status`、`internalNote` 和 `expectedUpdatedAt`，成功修改会写入审计记录。

订单分页查询支持 `q`、`status` 和 `page`，固定每页 20 条，响应为 `{ items, total, page, pageSize }`。`q` 会匹配订单号、参会人姓名、手机号和公司。

## AI 与通知

| Method | Path                             | 说明                   |
| ------ | -------------------------------- | ---------------------- |
| GET    | `/admin/ai/runs`                 | AI 运行记录            |
| POST   | `/admin/ai/generate`             | 生成待审核草稿         |
| POST   | `/admin/ai/runs/:runId/approve`  | 人工审批               |
| GET    | `/admin/notification-templates`  | 通知模板               |
| GET    | `/admin/notification-deliveries` | 投递记录               |
| POST   | `/admin/notifications/queue`     | 基于已审批内容排队发送 |

## 错误格式

```json
{
  "code": "INVENTORY_UNAVAILABLE",
  "message": "所选票种暂时无可用名额",
  "details": {},
  "traceId": "4cde015f-74c7-4f19-a221-56f63e13de72",
  "path": "/api/v1/registrations",
  "occurredAt": "2026-07-18T04:00:00.000Z"
}
```

服务端 500 错误返回统一安全提示，内部堆栈仅写入服务端日志。核心业务错误码包括 `VALIDATION_ERROR`、`UNAUTHORIZED`、`FORBIDDEN`、`NOT_FOUND`、`IDEMPOTENCY_CONFLICT`、`INVENTORY_UNAVAILABLE`、`INVALID_STATE_TRANSITION` 和 `DUPLICATE_CHECKIN`。
