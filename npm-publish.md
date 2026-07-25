# ArgonAgent npm 发布手册

本手册用于从 `argon-agent-core/` monorepo 发布以下两个公共 npm 包：

| Workspace | npm 包 | 首个已发布版本 |
| --- | --- | --- |
| `packages/core` | `@argon-agent/core` | `0.1.0` |
| `packages/cli` | `@argon-agent/cli` | `0.2.0` |

仓库根包 `argon-agent` 设置了 `"private": true`，只负责组织 npm
workspaces，**不得发布根包**。

> 所有命令均为 PowerShell 命令，并且应在 `argon-agent-core/` 根目录执行。

## 一键自动发布（推荐）

正式稳定版优先使用仓库根目录的 `publish-latest.ps1`。直接运行会同时递增 Core 和
CLI 的 patch 版本；也可以显式选择同一种 SemVer 递增类型：

```powershell
# 默认：两个包分别递增 patch
.\publish-latest.ps1

# 新功能或 0.x breaking change：两个包分别递增 minor
.\publish-latest.ps1 -Bump minor

# 进入 1.x 后的 breaking change
.\publish-latest.ps1 -Bump major
```

本次把安装后的命令从 `argon` / `argon-agent` 改为唯一的 `aragon`，属于 `0.x` 阶段的
breaking CLI 变更，因此发布包含该变更的首个版本时应运行：

```powershell
.\publish-latest.ps1 -Bump minor
```

脚本自动完成以下工作：

1. 要求 `argon-agent-core/` 中没有未提交的源码修改，并检查 npm 官方 registry 登录。
2. 自动递增两个 workspace 版本，把 CLI 的 Core 依赖更新为新版本的 caret 范围，并同步
   `package-lock.json`。
3. 运行全部测试、构建、Core consumer smoke、两个包的 pack dry-run 和 CLI 版本检查。
4. 确认待发布的精确版本不存在，然后先发布 Core；只有 Core 可查询后才发布 CLI。
5. 验证 npm 上的 CLI 版本只暴露 `aragon` 可执行入口。

发布前可先完整演练。DryRun 不检查 npm 登录、不调用 publish，并在退出前恢复三个版本文件：

```powershell
.\publish-latest.ps1 -DryRun
.\publish-latest.ps1 -DryRun -Bump minor
```

如果任何检查在首次 publish 前失败，脚本会自动恢复版本文件。如果 Core 可能已经发布、
但 CLI 发布失败，脚本会保留版本现场；先核对 npm，再运行：

```powershell
.\publish-latest.ps1 -Resume
```

`-Resume` 不再次递增版本，并跳过 npm 中已经存在的精确版本。成功发布后，立即提交
`packages/core/package.json`、`packages/cli/package.json` 和 `package-lock.json`，创建包级
Git 标签并推送公开仓库。beta/rc 预发布仍使用后文的手动 tagged workflow；本脚本只发布
稳定版到 `latest`。

## 1. 发布原则

1. 已经成功进入 npm registry 的 `包名 + 版本号` 永远不能覆盖；只有在确认
   发布请求失败且该版本从未进入 registry 时，才可以原样重试同一版本。
2. `@argon-agent/cli` 依赖 `@argon-agent/core`，需要同时发布时必须先发 Core。
3. 正式版本使用默认 `latest` 标签；预发布版本必须显式使用
   `--tag beta`、`--tag rc` 等非 `latest` 标签。
4. 发布前必须更新对应包的 `CHANGELOG.md`，并同步 `package-lock.json`。
5. 只发布通过测试、构建、consumer smoke 和 tarball 检查的源码状态。
6. 发布命令始终显式指定 npm 官方 registry，不能向 npm 镜像站发布。

## 2. 当前版本和远端版本检查

先查看本地版本：

```powershell
node -p "require('./packages/core/package.json').version"
node -p "require('./packages/cli/package.json').version"
```

再查看 npm 上的 `latest` 版本和本地准备发布的精确版本：

```powershell
$registry = 'https://registry.npmjs.org/'
$coreVersion = node -p "require('./packages/core/package.json').version"
$cliVersion = node -p "require('./packages/cli/package.json').version"

npm view '@argon-agent/core' version dist-tags --json --registry $registry
npm view '@argon-agent/cli' version dist-tags dependencies --json --registry $registry

npm view "@argon-agent/core@$coreVersion" version --registry $registry
npm view "@argon-agent/cli@$cliVersion" version --registry $registry
```

精确版本查询成功表示该版本已经存在，必须先递增版本。首次发布新版本时，精确
查询通常返回 404；这表示当前查询未发现该版本，但仍应结合 npm 网站和完整版本
列表确认，尤其是在刚刚执行过发布命令之后。

## 3. 如何选择新版本号

项目在 `1.0.0` 之前采用以下约定：

| 变更类型 | 版本变化 | 示例 |
| --- | --- | --- |
| 向后兼容的 Bug 修复、文档或内部调整 | `patch` | `0.1.0` → `0.1.1` |
| 新增向后兼容功能 | `minor` | `0.1.1` → `0.2.0` |
| `0.x` 阶段的破坏性 API/CLI 变更 | `minor`，并在 CHANGELOG 标明 breaking | `0.2.0` → `0.3.0` |
| 下一个 patch 的预发布版本 | `prepatch` | `0.2.0` → `0.2.1-beta.0` |
| 下一个 minor 的预发布版本 | `preminor` | `0.2.x` → `0.3.0-beta.0` |

达到 `1.0.0` 后遵循标准 SemVer：

- 向后兼容修复：`patch`
- 向后兼容功能：`minor`
- 破坏性变更：`major`

### 3.1 只有 Core 发生兼容性修复

```powershell
npm version patch -w packages/core --no-git-tag-version
npm install --package-lock-only --ignore-scripts
```

例如 Core 从 `0.1.0` 变为 `0.1.1`。CLI 当前依赖
`@argon-agent/core@^0.1.0`，该范围可以接受 `0.1.x`，因此 CLI 没有代码变更时
不需要重新发布。

### 3.2 只有 CLI 发生变化

Bug 修复：

```powershell
npm version patch -w packages/cli --no-git-tag-version
npm install --package-lock-only --ignore-scripts
```

新增功能：

```powershell
npm version minor -w packages/cli --no-git-tag-version
npm install --package-lock-only --ignore-scripts
```

### 3.3 Core 升级 minor/major，CLI 需要跟随

`0.x` 的 caret 范围需要特别注意：

```text
^0.1.0 允许 >=0.1.0 <0.2.0
```

因此 Core 从 `0.1.x` 升级到 `0.2.0` 后，必须更新 CLI 的 Core 依赖并发布
一个新的 CLI 版本：

```powershell
# 1. 递增 Core 版本
npm version minor -w packages/core --no-git-tag-version

# 2. 把 CLI 依赖更新为新的 Core minor 版本
$newCoreVersion = node -p "require('./packages/core/package.json').version"
npm pkg set "dependencies.@argon-agent/core=^$newCoreVersion" -w packages/cli

# 3. CLI 至少递增 patch
npm version patch -w packages/cli --no-git-tag-version

# 4. 同步 package-lock.json
npm install --package-lock-only --ignore-scripts
```

Core 达到 `1.x` 后，如果发生 major 升级，也按相同方式更新 CLI 依赖。

### 3.4 同时修改 Core 和 CLI，但 Core 仍在原依赖范围内

分别递增两个 workspace 的版本：

```powershell
npm version patch -w packages/core --no-git-tag-version
npm version patch -w packages/cli --no-git-tag-version
npm install --package-lock-only --ignore-scripts
```

根据实际变更调整：`0.x` 阶段使用 `patch` 或 `minor`；只有已经进入 `1.x`
之后，破坏性变更才使用 `major`。

### 3.5 发布 beta/rc 版本

为下一个 patch 首次创建 beta：

```powershell
npm version prepatch -w packages/core --preid beta --no-git-tag-version
```

为下一个 minor 首次创建 beta：

```powershell
npm version preminor -w packages/core --preid beta --no-git-tag-version
```

继续递增 beta：

```powershell
npm version prerelease -w packages/core --preid beta --no-git-tag-version
```

每次改变预发布版本后都要更新 CHANGELOG 并同步 lockfile：

```powershell
npm install --package-lock-only --ignore-scripts
```

发布预发布版本时必须使用匹配的 dist-tag：

```powershell
$registry = 'https://registry.npmjs.org/'
npm publish -w packages/core --access public --tag beta --registry $registry
```

不要把 beta/rc 直接发布到 `latest`。

如果 CLI 需要消费跨越当前依赖范围的 Core beta，应使用精确的 Core beta 版本，
并同时发布 CLI beta，避免稳定版 CLI 意外依赖预发布版本：

```powershell
$newCoreVersion = node -p "require('./packages/core/package.json').version"
npm pkg set "dependencies.@argon-agent/core=$newCoreVersion" -w packages/cli
if ($LASTEXITCODE -ne 0) { throw 'Failed to update CLI Core beta dependency' }

npm version prepatch -w packages/cli --preid beta --no-git-tag-version
if ($LASTEXITCODE -ne 0) { throw 'Failed to bump CLI beta version' }

npm install --package-lock-only --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw 'Failed to synchronize package-lock.json' }

$registry = 'https://registry.npmjs.org/'
npm publish -w packages/core --access public --tag beta --registry $registry
if ($LASTEXITCODE -ne 0) { throw 'Core beta publish failed; CLI beta was not published' }

npm view "@argon-agent/core@$newCoreVersion" version --registry $registry
if ($LASTEXITCODE -ne 0) { throw 'Core beta is not queryable; CLI beta was not published' }

npm publish -w packages/cli --access public --tag beta --registry $registry
if ($LASTEXITCODE -ne 0) { throw 'CLI beta publish failed' }
```

两个 publish 之间仍须先用 `npm view` 确认 Core beta 已可查询。

## 4. 版本文件检查

每次版本更新后检查：

```powershell
git diff -- `
  package-lock.json `
  packages/core/package.json `
  packages/core/CHANGELOG.md `
  packages/cli/package.json `
  packages/cli/CHANGELOG.md
```

确认 workspace 的 `package.json` 和 `package-lock.json` 版本一致：

```powershell
node -e "const fs=require('fs'); const lock=require('./package-lock.json'); for (const p of ['packages/core','packages/cli']) { const pkg=JSON.parse(fs.readFileSync('./'+p+'/package.json','utf8')); const entry=lock.packages?.[p]; console.log(p+': package.json='+pkg.version+', lock='+entry?.version); if (pkg.version!==entry?.version) process.exitCode=1; } const cli=JSON.parse(fs.readFileSync('./packages/cli/package.json','utf8')); const pkgRange=cli.dependencies?.['@argon-agent/core']; const lockRange=lock.packages?.['packages/cli']?.dependencies?.['@argon-agent/core']; console.log('CLI Core range: package.json='+pkgRange+', lock='+lockRange); if (pkgRange!==lockRange) process.exitCode=1;"
```

如果检查失败，运行：

```powershell
npm install --package-lock-only --ignore-scripts
```

然后再次检查。根包是私有 workspace 容器，一般不需要随两个公共包一起递增版本。

## 5. 登录 npm 官方 registry

日常安装可以继续使用 npm 镜像，但登录和发布必须使用 npm 官方 registry。

如果当前环境关闭了 TLS 校验，先恢复安全设置：

```powershell
[Environment]::SetEnvironmentVariable(
  'NODE_TLS_REJECT_UNAUTHORIZED',
  $null,
  'User'
)
Remove-Item Env:NODE_TLS_REJECT_UNAUTHORIZED -ErrorAction SilentlyContinue
```

登录命令：

```powershell
$registry = 'https://registry.npmjs.org/'

npm login `
  --scope "@argon-agent" `
  --registry $registry `
  --auth-type "web"
```

登录后验证：

```powershell
npm config get '@argon-agent:registry'
npm whoami --registry $registry
npm org ls argon-agent --registry $registry
```

第一条命令应输出：

```text
https://registry.npmjs.org/
```

如果 `npm login` 报错 `Public registration is not allowed`，说明请求仍然发往了
`npmmirror` 等只读镜像的可能性很高。先定位实际配置来源：

```powershell
npm config get registry
npm config get '@argon-agent:registry'
npm config get userconfig
npm config get globalconfig
Get-ChildItem Env:npm_config_registry -ErrorAction SilentlyContinue
```

确认没有项目 `.npmrc`、用户 `.npmrc` 或环境变量覆盖后，重新执行上面的带
`--registry` 登录命令。

## 6. 发布前完整验证

发布提交应在 npm 发布之前完成，并同步到实际公开源码仓库。提交必须包含本次
版本号、依赖范围、lockfile、CHANGELOG 和源码变更。先确认没有无关文件混入：

```powershell
git status --short
```

PowerShell 默认不会因为某个原生命令返回非零退出码而自动停止，因此每个关键
命令后都要检查 `$LASTEXITCODE`：

```powershell
npm test
if ($LASTEXITCODE -ne 0) { throw 'npm test failed' }

npm run build
if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }

npm run verify:dist -w packages/core
if ($LASTEXITCODE -ne 0) { throw 'Core consumer smoke failed' }

npm pack -w packages/core --dry-run --json
if ($LASTEXITCODE -ne 0) { throw 'Core pack dry-run failed' }

npm pack -w packages/cli --dry-run --json
if ($LASTEXITCODE -ne 0) { throw 'CLI pack dry-run failed' }

node .\packages\cli\dist\cli.js --version
if ($LASTEXITCODE -ne 0) { throw 'CLI dist smoke failed' }

git status --short
```

检查 tarball 输出至少满足：

- Core 包含 `README.md`、`LICENSE`、`dist/index.js` 和类型声明。
- CLI 包含 `README.md`、`LICENSE`、`dist/cli.js`。
- `dist/cli.js` 第一行是 `#!/usr/bin/env node`。
- 不包含 `.env`、API Key、开发日志、临时文件或无关笔记。
- tarball 中的包名和版本号就是本次准备发布的版本。
- `node packages/cli/dist/cli.js --version` 输出本次 CLI 版本。

可以额外检查 CLI shebang：

```powershell
Get-Content .\packages\cli\dist\cli.js -TotalCount 1
```

任一测试、构建、consumer smoke 或 tarball 检查失败时停止发布。构建结束后再次
检查 Git 状态；如果生成了未预期的跟踪文件或源码变化，也应停止发布。

## 7. 正式发布

### 7.1 只发布 Core

```powershell
$registry = 'https://registry.npmjs.org/'
$coreVersion = node -p "require('./packages/core/package.json').version"
if ($coreVersion -match '-') { throw 'Pre-release versions must use the beta/rc workflow and --tag' }

npm publish -w packages/core --access public --registry $registry
if ($LASTEXITCODE -ne 0) { throw 'Core publish failed' }
```

发布成功后立即验证，确认 registry 已经可以查询到新版本：

```powershell
$coreVersion = node -p "require('./packages/core/package.json').version"
npm view "@argon-agent/core@$coreVersion" version dist-tags --json --registry $registry
if ($LASTEXITCODE -ne 0) { throw 'Published Core version is not queryable' }
```

### 7.2 只发布 CLI

先读取并验证 CLI 声明的 Core 版本范围，而不是只检查 Core 的 `latest`：

```powershell
$registry = 'https://registry.npmjs.org/'
$coreRange = node -p "require('./packages/cli/package.json').dependencies['@argon-agent/core']"
npm view "@argon-agent/core@$coreRange" version --registry $registry
if ($LASTEXITCODE -ne 0) { throw "No published Core version satisfies $coreRange" }
```

再发布：

```powershell
$cliVersion = node -p "require('./packages/cli/package.json').version"
if ($cliVersion -match '-') { throw 'Pre-release versions must use the beta/rc workflow and --tag' }

npm publish -w packages/cli --access public --registry $registry
if ($LASTEXITCODE -ne 0) { throw 'CLI publish failed' }
```

### 7.3 同时发布 Core 和 CLI

必须严格按顺序执行，不能直接使用 `npm publish --workspaces`：

```powershell
$registry = 'https://registry.npmjs.org/'
$coreVersion = node -p "require('./packages/core/package.json').version"
$cliVersion = node -p "require('./packages/cli/package.json').version"
if ($coreVersion -match '-' -or $cliVersion -match '-') {
  throw 'Pre-release versions must use the beta/rc workflow and --tag'
}

# 1. 发布 Core
npm publish -w packages/core --access public --registry $registry
if ($LASTEXITCODE -ne 0) { throw 'Core publish failed; CLI was not published' }

# 2. 确认 Core 新版本可查询
npm view "@argon-agent/core@$coreVersion" version --registry $registry
if ($LASTEXITCODE -ne 0) { throw 'Core is not queryable; CLI was not published' }

# 3. 确认新 Core 满足 CLI 声明的依赖范围
$coreRange = node -p "require('./packages/cli/package.json').dependencies['@argon-agent/core']"
npm view "@argon-agent/core@$coreRange" version --registry $registry
if ($LASTEXITCODE -ne 0) { throw "Published Core does not satisfy CLI range $coreRange" }

# 4. 发布 CLI
npm publish -w packages/cli --access public --registry $registry
if ($LASTEXITCODE -ne 0) { throw 'CLI publish failed' }

# 5. 确认 CLI 新版本可查询
npm view "@argon-agent/cli@$cliVersion" version --registry $registry
if ($LASTEXITCODE -ne 0) { throw 'Published CLI version is not queryable' }
```

如果 npm 要求 2FA，按命令行或浏览器提示完成验证，不要把长期 token 写进本文件。

## 8. 发布后验收

检查版本、dist-tag、CLI 依赖和可执行入口：

```powershell
$registry = 'https://registry.npmjs.org/'

npm view '@argon-agent/core' version dist-tags --json --registry $registry
npm view '@argon-agent/cli' version dist-tags dependencies bin --json --registry $registry

$cliVersion = node -p "require('./packages/cli/package.json').version"
npm exec --yes `
  --registry $registry `
  --package "@argon-agent/cli@$cliVersion" `
  -- aragon --version
```

还应打开 npm 包页面检查 README、许可证、仓库链接和版本号：

- <https://www.npmjs.com/package/@argon-agent/core>
- <https://www.npmjs.com/package/@argon-agent/cli>

## 9. 部分发布失败时如何处理

### Core 已成功、CLI 发布失败

1. 不要再次发布或重复递增 Core。
2. 保留发布命令的完整错误输出，等待片刻后至少重复查询一次 CLI 精确版本：

   ```powershell
   $registry = 'https://registry.npmjs.org/'
   $cliVersion = node -p "require('./packages/cli/package.json').version"
   npm view "@argon-agent/cli@$cliVersion" version dist-tags dependencies bin --json --registry $registry
   ```

3. 如果已经能查询到该版本，核对依赖、`bin` 和 dist-tag；全部正确才视为发布成功。
4. 如果重复查询仍返回 404，并且原发布命令明确在 registry 接收版本前失败，本地
   内容也没有改变，则重新通过完整验证后可以重试同一版本。
5. 如果为了排错修改了源码、依赖或产物，需要重新评估版本号并更新 CHANGELOG。
6. 如果已发布的正式版内容有问题，修复后递增 CLI patch；预发布版则递增
   prerelease，并在重试时保留原来的 `--tag beta` / `--tag rc`。
7. 如果只是 dist-tag 错误，不要重新发布，可使用 `npm dist-tag` 修正标签。

### 常见错误

| 错误 | 原因 | 处理 |
| --- | --- | --- |
| `Public registration is not allowed` | 通常是请求到了不支持登录写入的镜像 | 检查 default/scope registry、`.npmrc` 和 `npm_config_registry`，再用官方 `--registry` 登录 |
| `ENEEDAUTH` / `E401` | 未登录或凭证过期 | `npm login` 后运行 `npm whoami` |
| `E403` | 组织/包权限、2FA、token 策略或版本已存在 | 先查精确版本，再检查 `whoami`、组织权限和 2FA；不要盲目升版 |
| `E402` | scoped 包被当成私有包发布 | 确认带有 `--access public` |
| `EPUBLISHCONFLICT` | 相同版本已经进入 registry | 递增版本、更新 CHANGELOG/lockfile，并重新执行完整验证 |
| CLI 安装时 Core 404 | Core 尚未发布或未同步 | 等 `npm view` 能查询 Core 后再发 CLI |

## 10. 发布记录与后续工作

发布完成后：

1. 确认发布前创建的 release commit 已经推送到公开的 ArgonAgent GitHub 仓库。
2. 在实际公开仓库为该 release commit 创建包级标签，例如
   `core-v0.1.1`、`cli-v0.2.1`。
3. 在对应的 `packages/core/CHANGELOG.md` 或 `packages/cli/CHANGELOG.md`
   以及 GitHub Release 中记录 npm 页面和升级说明。
4. 再次核对 npm dist-tag；正式版应是 `latest`，预发布版应是 `beta` / `rc`。
5. 对破坏性变更写明迁移方式。

建议提交信息：

```text
chore(release): publish core vX.Y.Z
chore(release): publish cli vX.Y.Z
chore(release): publish core vX.Y.Z and cli vA.B.C
```

## 11. 官方参考

- [npm version](https://docs.npmjs.com/cli/v10/commands/npm-version/)
- [npm publish](https://docs.npmjs.com/cli/publish/)
- [npm SemVer](https://docs.npmjs.com/about-semantic-versioning/)
- [npm login](https://docs.npmjs.com/cli/v11/commands/npm-login/)
