# 微信支付三通道上线与回滚 Runbook

## 前置核验

1. 管理后台完成商户凭据配置，并执行「连接验证」（`/v3/security/echo`）。
2. 人工确认公众号 AppID ↔ 商户号绑定、JSAPI 授权目录 `/pay/`、H5 域名、产品权限。
3. 配置 `PAYMENT_PUBLIC_ORIGIN` / `PAYMENT_PUBLIC_BASE_PATH` / `PAYMENT_PUBLIC_URL`，且与 `PUBLIC_ORIGIN` 不同。
4. Redis 可用（JSAPI OAuth 依赖）；Redis 故障时仅拒绝 JSAPI，Native/H5 仍可工作。
5. Docker 构建上下文不包含 `cert/`、`*.pem`、`*.p12`。

## 推荐上线顺序

1. **备份数据库**。
2. 部署兼容 migration（`0035_wechat_payment_status_enum` → `0036_wechat_payment_attempts`；migrate 按文件单独提交，避免 Postgres enum 55P04）与 inbox / reconcile 代码。
3. 灰度迁移 Native 内核到 attempt 模型（默认仅开放 Native 通道）。
4. 部署 `payment-web`、Gateway `/pay/hui` 路由与外部 Nginx 支付入口。
5. 验证稳定 notify：`https://hui.../api/v1/payments/wechat/notify/{organizationId}`。
6. 验证 OAuth callback：`https://www.../pay/hui/api/v1/payments/wechat/oauth/callback`。
7. 管理后台开启 JSAPI（需 AppSecret + OAuth）。
8. 开启 H5。
9. 最后验证渠道切换与跨浏览器支付恢复。

## 浏览器选择与支付恢复

- 电脑微信（Windows / macOS）与普通电脑浏览器使用 Native 扫码；手机和 iPad 微信使用 JSAPI；手机外部浏览器使用 H5。
- 个人中心的报名卡、门票服务、参会名额列表和报名详情页，通过已登录购买者的 `payment-access` 接口取得新凭证，再整页进入支付页。
- 准备支付收到明确的 `payment_channel_conflict` 响应时，使用服务端切换流程查单、关闭旧交易并确认结果。交易未结清时停止切换；已付款时进入完成状态。
- 并发恢复时，关闭租约事务保留已使用目标通道的活动交易，随后复用其支付凭证，避免让另一个浏览器的二维码失效。
- 本地浏览器回归：`WEB_BASE_URL=http://localhost:3000 pnpm test:payment-resume`。该检查使用模拟接口，不发生真实扣款；真机交易按下方清单验收。

## 上线后验证 SQL

```sql
-- 不应出现重复商户订单号
SELECT out_trade_no, COUNT(*) FROM payments
WHERE out_trade_no IS NOT NULL
GROUP BY out_trade_no HAVING COUNT(*) > 1;

-- 不应出现重复微信交易号
SELECT external_id, COUNT(*) FROM payments
WHERE provider = 'wechatpay' AND external_id IS NOT NULL AND status = 'succeeded'
GROUP BY external_id HAVING COUNT(*) > 1;

-- 每单至多一个活动 attempt
SELECT order_id, COUNT(*) FROM payments
WHERE provider = 'wechatpay'
  AND status IN ('preparing','pending','processing','query_pending','close_pending','unknown')
GROUP BY order_id HAVING COUNT(*) > 1;

-- 已支付订单应恰好一张有效票（按业务表调整）
-- SELECT o.id, COUNT(t.id) FROM orders o LEFT JOIN tickets t ON t.order_id = o.id
-- WHERE o.status = 'paid' GROUP BY o.id HAVING COUNT(t.id) <> 1;

-- inbox / 未知状态积压
SELECT status, COUNT(*) FROM payment_notification_inbox GROUP BY status;
SELECT status, COUNT(*) FROM payments
WHERE provider = 'wechatpay'
  AND status IN ('unknown','close_pending','query_pending')
GROUP BY status;
```

## 通知 inbox 重试

HTTP notify 在验签解密并写入 `payment_notification_inbox` 后立即返回 SUCCESS，并异步入账。API 支付维护任务每 15 秒通过统一的 `ConferenceRepository.confirmPayment` 事务重试 `received` / `failed` 行，并回收超过 60 秒的 `processing` 租约；超过 10 次进入 `dead`，需人工按上线后 SQL 排查。支付窗口结束后，维护任务会先向微信查单并确认关单，随后 Worker 才释放库存。

### L1：关闭单个新通道

管理后台关闭 `channels.jsapi` 或 `channels.h5`。不影响存量 notify / 查单 / 关单。

### L2：停止所有新 prepare

关闭 `enabled` 或全部通道开关。保留 notify、主动查单、关单与 reconcile，确保已付款订单仍可入账出票。

### L3：撤销 www 支付页入口

外部 Nginx 停止代理 `/pay/hui`，或 Gateway 摘除 `payment-web`。**不要**停 hui 主站 API 的 notify。存量订单可继续通过查单与回调完成。

数据库新增列默认保留，不做破坏性回滚。

## 真机最小金额验收清单

- [ ] 手机 / iPad 微信 JSAPI：授权一次 → 调起支付 → notify 或查单入账 → 仅一张票
- [ ] 手机 Safari/Chrome H5：跳转微信 → 回跳订单页 → 入账
- [ ] 电脑微信与普通电脑浏览器 Native：显示二维码 → 扫码支付成功
- [ ] 更换浏览器并重新登录：个人中心继续支付 → 恢复凭证 → 显示当前环境支付入口
- [ ] 旧通道冲突、并发恢复、恢复期间另一浏览器已付款：保留唯一有效交易并正确显示结果
- [ ] iPad Native 默认；手动切换 H5（若已开放）
- [ ] 用户取消、重复 notify、切换通道、订单过期协调

## 安全红线

- openid、AppSecret、商户私钥、order access token 不得进入 URL query、日志或前端持久化（access 仅 fragment → sessionStorage）。
- 稳定 notify 永远在 hui；OAuth/H5 才使用 www/pay/hui。
- 有活动 attempt 时更换 AppID/商户号/APIv3 密钥需谨慎，或保留旧凭据版本处理存量单。

### 关闭页面后的恢复与后台关单

- 用户关闭支付标签页后，临时凭证可能随会话消失。重新打开旧链接时，支付页提供“返回个人中心继续支付”，由已登录的购票人重新获取支付访问凭证。个人中心与报名详情的“继续支付”均进入真实收银台；电脑微信使用 Native 二维码。
- 后台入口：大会 → 报名 → 报名详情 → 订单、支付与退款 → **关闭未支付订单**。操作人须同时具备报名管理与订单查看权限，填写关闭原因并确认订单号和金额。
- 系统先查询微信交易，必要时关闭交易，再查询确认。已付款则同步支付结果并出票；USERPAYING、查询失败或结果不明时保留订单与库存，提示稍后重试。此操作不执行退款。
- 领取关闭任务前与最终业务事务内均核对订单版本，防止旧后台页面或并发重报名误关新支付。同轮已确认关单但业务事务失败的 processing 订单，可凭该支付窗口的关闭证据重试。
- 确认关闭后，订单变为 closed、报名变为 cancelled，释放未转换的库存占用，并保留支付记录、操作人、关闭原因、状态日志和审计记录。用户随后可返回报名页重新提交；仍需满足开放时间和可用名额。现有报名流程可能复用订单标识，重新发起的支付使用新的交易记录。
- 库存释放事件按原 reservationId 查票种，避免用户改票种重报后把候补资格分配到错误票种。
- 回归：`pnpm test:payment-resume` 覆盖失败关页再开与二维码恢复；`pnpm test:admin-order-close` 覆盖后台确认、失败重试与权限；API 的 `admin-order-closure.integration.test.ts` 在独立 PostgreSQL 数据库验证支付协调、库存、审计和并发保护，仅替换外部微信网关。

### 待支付报名的信息修改

- 本人待支付报名的详情页和支付页提供“返回修改信息”。修改页带入原资料，保存后回到详情继续支付；公司、姓名等修改同步到本次报名的核心表单回答，保留原订单、金额、库存占用和支付记录。
- 必填项、字段类型及下拉选项沿用报名时的表单定义。手机号关联登录和参会身份，页面引导用户联系主办方更换；已付款、处理中或已关闭的本人订单不可在此编辑。代购订单返回个人中心已有参会人维护入口。
- 保存时校验报名版本，旧页面无法覆盖重新报名后的资料。加载或保存期间登录过期可原地登录；同账户恢复保留填写内容，换账户则重新校验权限并清除旧草稿。
- `pnpm test:payment-resume` 覆盖修改、取消、失败重试、登录恢复、下拉选项及手机布局；`customer-registration-edit.integration.test.ts` 使用独立 PostgreSQL 验证权限、状态、旧版本保护和资料一致性。

- 保存请求设有 4 秒超时且不自动重试写入；遇到不确定的保存失败时先读取最新资料核对保存结果。版本冲突提供逐项核对，用户选择采用最新内容或保留本次修改后才可保存。正在支付或已关闭时保留可复制的草稿。
- 跨标签登录导致安全校验失效时，仅刷新明确过期的会话，同账户保留草稿；普通权限拒绝不自动重试。离开修改页后，迟到请求不会再跳转或打开登录框。
