# TokEMS CLI

CLI 0.4.0 支持 Node.js 24 及以上版本、macOS Keychain 和 Linux Secret Service。

仓库内使用 `pnpm tokems --help`。独立使用时构建本包并将生成的 tarball 安装到个人工具目录，运行 `tokems --help`。安装包包含全部运行脚本，无需克隆仓库。

先运行 `instance inspect --origin <实例地址>`，再使用 `auth connect --origin <实例地址> --profile content`。管理员在浏览器核对授权码并验证身份后建立连接。可选预设为 `read`、`content`、`full`；默认使用内容运营权限。

通过 `capabilities sync` 查看实际可用动作与关闭原因。写入按 `action prepare`、`action confirm`、浏览器审批、`action execute` 执行。结果未知时使用 `operation status` 与 `operation reconcile` 核对。

模板操作提供 `template pull`、`template diff`、`template patch` 与 `template preview`。候选预览不改变公开配置。模板发布、应用到大会及大会版本回退分别使用目录动作。

素材先以 `asset prepare` 申请上传，执行获批预留后用 `asset upload` 上传同一文件并准备登记；HTML 文件的上传同样使用已执行的 HTML 导入预留。上传地址来自已授权实例公布的对象存储地址，连接凭据仅发送到 TokEMS。

普通输出为脱敏 JSON。预览链接、一次性凭据和文件通过加密 artifact 交接。`artifact download` 的输出须为尚不存在的绝对路径，文件权限为 0600。

本版本保持 experimental。生产动作依赖实例总开关、动作验收状态和连接权限；未开放的动作由服务端拒绝。`doctor` 只读检查连接与凭据存储。
