# 临时依赖审计例外

批准日期：2026-10-28。仓库维护者已明确批准仅对下述 deepmerge 构建工具链公告设置临时例外，截止 **2026-11-09 00:00 UTC（北京时间 08:00）**；其余完整检查通过后合并 PR #160。此前的 node-forge 例外已随官方修复升级移除。

## 2026-10-28 核验

- PR #160 首轮 CI 的构建、质量检查和业务流程全部通过，最后的完整依赖审计报告 qs 和 deepmerge 两项未忽略公告。
- [qs 公告 GHSA-6pq8-jhm2-2vcw](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw) 已提供 6.16.1 修复版，将现有覆盖约束从 6.16.0 更新至 6.16.1。唯一依赖路径为 API 的开发测试依赖 supertest → superagent → qs。
- node-forge 已发布 [1.4.1 安全修复及 1.4.2 兼容性修复](https://github.com/digitalbazaar/forge/blob/v1.4.2/CHANGELOG.md)。将其固定至 1.4.2，移除 `GHSA-86w9-cpqp-85rv` 忽略项；近期发布安装例外仅固定为 `node-forge@1.4.2`。
- [deepmerge 公告 GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4) 为低危：合并恶意对象时可能污染返回对象的原型。npm registry 最新版本仍为 4.3.1，审计建议的 4.3.2 尚未发布。
- 唯一剩余路径为 Web 的 Nuxt 4.6.2 → @nuxt/nitro-server 4.6.2 → nitropack 2.13.4 → @rollup/plugin-node-resolve 16.0.3 → deepmerge 4.3.1。最新 plugin-node-resolve 仍引入 deepmerge，升级 Nitro 也保留该路径。
- 该包用于 Rollup 构建配置；当前 Web 构建产物未发现 deepmerge 包路径。Docker Web 运行阶段只复制 `.output`，API / Worker 单独部署自身生产依赖，Admin 使用静态产物。构建环境仍安装受影响代码，应只使用受信任的构建配置。

## 保留的门禁

- pnpm 原生 `auditConfig.ignoreGhsas` 仅保留 `GHSA-gcqx-w48m-w2h4`，完整依赖审计继续执行；其他漏洞继续阻止通过。
- 不降低严重级别阈值，不启用全部未修复漏洞忽略，不设置 `continue-on-error`，不绕过必需 CI。
- `tooling/lib/security-audit-exceptions.test.mjs` 检查 pnpm 实际生效的例外范围及到期时间，CI 的 `pnpm test:tooling` 执行该门禁。
- 依赖路径、生产打包范围或相关调用发生变化时，应先移除例外并重新评估。
- 官方发布修复后，升级依赖、移除对应例外，并同步调整范围检查。全部移除后删除这份临时记录和专用到期检查。
- 到期仍无修复时，须取得新的明确授权并更新风险核验记录；禁止自动延期。
