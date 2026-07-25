# npm 一键发布脚本设计

## 目标

在 `argon-agent-core/` 根目录提供 `publish-latest.ps1`。直接运行脚本时，
`@argon-agent/core` 与 `@argon-agent/cli` 默认各递增一个 patch 版本，经完整验证后按
Core、CLI 的顺序发布到 npm 官方 registry。CLI 安装后只暴露 `aragon` 命令，不再暴露
`argon` 或 `argon-agent`。

## 接口与版本策略

脚本参数 `-Bump` 接受 `patch`、`minor`、`major`，默认 `patch`。两个 workspace 独立
保留自己的版本线，但每次使用同一种递增类型。Core 更新后，CLI 对
`@argon-agent/core` 的依赖同步为 `^<新 Core 版本>`，随后更新 `package-lock.json`。
`-DryRun` 执行版本计算、测试、构建与打包检查，但不访问发布接口，并在退出前恢复版本
文件。`-Resume` 不再递增版本，用于 Core 已发布而 CLI 发布失败的恢复场景；脚本检查 npm
上的精确版本，跳过已存在的包并继续未完成的发布。

## 发布流程与错误处理

脚本始终以自身目录作为工作目录，并显式使用 `https://registry.npmjs.org/`。正常发布前
要求 `argon-agent-core/` 的受跟踪文件没有未提交修改，验证 npm 登录身份，并确认待发布的
两个精确版本尚不存在。随后依次执行 workspace 测试、构建、Core consumer smoke、两个
包的 `npm pack --dry-run`，并检查 CLI 包元数据只声明 `aragon`。Core 发布完成后必须等待
registry 能查询到精确版本，才允许发布 CLI；CLI 发布后再次查询版本和 `bin`。

发布开始前若任一步骤失败，脚本恢复三个版本文件并以非零状态退出。Core 已经发布后发生
错误时不恢复版本文件，输出 `-Resume` 恢复命令，避免重复发布不可覆盖的 npm 版本。脚本
不保存 token，也不修改用户 npm registry 配置。

## 测试

新增 PowerShell 集成测试，通过临时 workspace 和伪 npm 命令验证默认 patch、指定 bump、
Core 依赖与 lockfile 同步、DryRun 不调用 publish 且恢复文件，以及 `-Resume` 跳过已发布
Core。另加包元数据断言，确保 CLI 只有 `aragon` 可执行入口。最后运行完整 npm 测试、构建、
consumer smoke、pack dry-run，并直接执行构建后的 CLI 版本命令。
