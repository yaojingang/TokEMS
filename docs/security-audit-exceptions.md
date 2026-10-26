# 临时依赖审计例外

续期批准日期：2026-10-26。仓库维护者已明确批准仅将 node-forge 的下述构建/开发工具链例外续至 **2026-11-09 00:00 UTC（北京时间 08:00）**，并要求其余 CI 全部通过后合并 PR #151。原授权于 2026-10-24 到期，本次保留范围与到期门禁。

## 2026-10-26 核验

- 升级 Nuxt 至 4.6.2，并更新 Fastify、fast-uri、ip-address 与 serialize-javascript 的安全版本约束，修复当前可升级的审计项。
- [braces 公告 GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) 已于 2026-10-23 撤回，移除该项忽略规则。
- [node-forge 公告 GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) 仍未提供已发布修复版本；npm registry 的最新版本为 1.4.0。
- 剩余依赖路径为 Web 的 Nuxt 4.6.2 → @nuxt/nitro-server 4.6.2 → nitropack 2.13.4 → listhen 1.10.1 → node-forge 1.4.0。Nuxt CLI 升级后已移除另一条引入路径。
- listhen 使用 node-forge 生成和读取开发 HTTPS 证书；未发现调用受影响 RSA 验签入口的公网路径。支付验签使用 Node 原生 crypto。
- Web 构建产物 `.output` 不包含 node-forge。Docker Web 运行阶段只复制该构建产物，API / Worker 单独部署自身生产依赖，Admin 使用静态产物。构建环境仍安装受影响代码，构建配置应继续保持可信。

## 保留的门禁

- pnpm 原生 `auditConfig.ignoreGhsas` 仅保留 `GHSA-86w9-cpqp-85rv`，完整依赖审计继续执行；其他漏洞继续阻止通过。
- 不降低严重级别阈值，不启用全部未修复漏洞忽略，不设置 `continue-on-error`，不绕过必需 CI。
- `tooling/lib/security-audit-exceptions.test.mjs` 检查 pnpm 实际生效的例外范围及到期时间，CI 的 `pnpm test:tooling` 执行该门禁。
- 依赖路径、生产打包范围或相关调用发生变化时，应先移除例外并重新评估。
- 官方发布修复后，升级依赖、移除对应例外，并同步调整范围检查。全部移除后删除这份临时记录和专用到期检查。
- 到期仍无修复时，须取得新的明确授权并更新风险核验记录；禁止自动延期。
