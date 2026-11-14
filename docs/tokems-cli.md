# TokEMS CLI 0.4

CLI `0.4.0`、Agent catalog `2.0.0`，状态为 `experimental`。支持经浏览器授权管理大会内容，以及拉取、比较、预览、修改和发布前台模板。实际能力以实例返回的 `availability` 为准。

## 安装与连接

需要 Node.js 24 及以上版本，以及 macOS Keychain 或 Linux Secret Service。仓库内直接运行：

```bash
pnpm tokems --version
pnpm tokems instance inspect --origin http://127.0.0.1:8088
pnpm tokems auth connect --origin http://127.0.0.1:8088 --profile content
pnpm tokems capabilities sync
```

管理员在实例后台核对同一验证码并完成身份验证。`read` 请求读取权限，默认 `content` 请求内容运营权限，`full` 请求完整 scope；所有预设仍受当前管理员权限、组织边界、实例开关和动作验收名单约束。远程实例使用 HTTPS，本地部署可使用 loopback 或 `.localhost` HTTP。

构建可独立安装的包：

```bash
pnpm --filter @conference/cli build
pnpm --filter @conference/cli pack --pack-destination /absolute/output/directory
npm install --prefix /absolute/personal-tools /absolute/output/directory/conference-cli-0.4.0.tgz
/absolute/personal-tools/node_modules/.bin/tokems --help
```

安装包携带完整运行脚本与凭据存储辅助程序，运行时无需仓库源码。该包尚未发布到 npm。仓库 `skills/tokems-admin` 提供同版本 Agent 指引；其中旧 registry/reports 是历史证据，不能作为本版本的发布认证。

## 模板工作流

先通过 `action inspect` 查看 `templates.list`、`events.list`，从返回内容取得真实 ID。下面的路径须替换为实际文件位置：

```bash
pnpm tokems template pull --template <template-id> --output /absolute/draft.json
pnpm tokems template diff --template <template-id> --patch-file /absolute/patch.json
pnpm tokems template preview --template <template-id> --event <event-id> --patch-file /absolute/patch.json --reason-file /absolute/reason.txt
```

示例 `patch.json`：

```json
{
  "seo": { "title": "大会新标题", "description": "大会介绍" }
}
```

结构化 patch 还支持首页区块、顺序、报名步骤、FAQ 和机构组。省略字段保留原值，区块使用现有稳定 `nodeKey`。完整字段见 Skill 的 `references/templates.md` 和实时动作输入契约。

`template preview` 准备一个候选预览操作。按返回的 operation ID 完成确认、浏览器审批和执行，再用 `artifact download` 将预览结果保存到受保护文件。候选预览使用所选大会的真实内容；结构化和 HTML 预览都保持草稿、绑定和公开版本不变。链接有效期 30 分钟，页面禁用报名、支付和统计。

确认修改后，用 `template patch` 准备草稿更新。发布、应用和回退分别使用 `templates.publish`、`templates.event-binding.update`、`events.releases.rollback`。先查看动作及输入契约，再准备对应操作。

## 统一操作流程

所有写入包含原因文件，准备后固定正文、目标、前态、请求编号和审批：

```bash
pnpm tokems action prepare --action <action-id> --params-file /absolute/params.json --input-file /absolute/input.json --reason-file /absolute/reason.txt
pnpm tokems action confirm --operation <operation-id>
# 按返回链接在浏览器批准同一操作。
pnpm tokems action execute --operation <operation-id>
pnpm tokems operation status --operation <operation-id>
pnpm tokems operation reconcile --operation <operation-id>
```

普通写入需要明确确认；受控写入需要浏览器审批；关键动作还需要密码验证。读取私人资料须提供 `--purpose-file`。CLI 输出脱敏 JSON，凭据保存在系统凭据库，临时正文和一次性结果加密保存。

## 图片与 HTML 上传

图片使用 `asset prepare`，执行上传预留后，使用同一文件运行 `asset upload`：

```bash
pnpm tokems asset prepare --file /absolute/image.png --media-type image/png --alt-text "大会主视觉" --reason-file /absolute/reason.txt
# 确认、审批并执行返回的预留操作。
pnpm tokems asset upload --operation <reservation-operation-id> --file /absolute/image.png --reason-file /absolute/reason.txt
```

上传完成会准备资产登记操作。HTML 用 `templates.html-imports.prepare` 申请上传，正文包含 `fileName`、`size`、`sourceDigest`、`mode`。执行预留后，同一 `asset upload` 命令上传 HTML 并准备扫描；扫描到达终态后再提交 `templates.html-imports.commit`。原始 HTML 上限 5 MiB，扫描、资源净化和阻断项规则沿用后台流程。

上传仅接受实例公布的存储地址，并校验摘要、大小、有效期和请求头；TokEMS 凭据留在原实例。短期链接通过加密 artifact 交接。

## 恢复与验收

结果未知时查询原 operation 并 reconcile。已成功的一次性操作若在本地保存前中断，重新执行同一 ID 会取回原托管结果并加密保存，业务写入不会重放。服务器托管期限为一小时。主验证状态采用服务端结论，客户端检查作为附加证据保留。`artifact download` 要求不存在的绝对路径，文件权限为 `0600`，已有输出目录权限保持原值。`doctor` 保留未完成操作和已有 artifact。

每个组织最多同时保留 50 份候选预览，总内容上限 64 MiB。超过任一预算会返回 `TEMPLATE_PREVIEW_LIMIT`，已有链接继续保持原有效期；到期后预算自动释放。图片与字体可通过配置的对象存储地址加载，脚本与表单继续禁用。

服务端对已开放写入统一执行事务、前态复查和领域审计；公开变更由服务端比对真实 API 与 HTML 的 release，根首页另核验展示模式。异步扫描通过真实任务终态 reconcile。`AGENT_ACTION_NOT_READY` 表示动作已定义、尚未开放，应使用现有后台入口。退款、财务、集成凭据、管理员安全和高影响操作继续由原有生产门禁管理。

开发验收命令：

```bash
pnpm check
pnpm test:tokems-cli
```

第二条需要 Docker 和 Chrome/Chromium，可通过现有 `CHROMIUM_PATH` 指定浏览器。脚本创建独立 PostgreSQL、Redis 和 S3 兼容存储，使用随机 loopback 端口与临时数据，完成真实授权、模板发布/回退、图片上传、HTML 扫描、浏览器图片加载、并发、缓存预算和故障回滚验收，最后清理自身容器。不会接管共享 8088、已有 Compose 服务或数据库。CI 同样执行此验收。

生产环境须按部署 Runbook 发布，再按只读、内容写入、关键动作顺序启用。新 catalog 要求旧连接重新授权。Gateway 与外层代理均应按仓库示例关闭预览链接的访问及错误日志，避免 query token 留存。生产开关以实例运维配置为准，发布事实记录在 `docs/release-records/`。
