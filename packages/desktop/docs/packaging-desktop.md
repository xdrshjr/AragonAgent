# 桌面端一键打包（Windows / PowerShell）

双击 `packages\desktop\pack-desktop.cmd`，即可在 Windows 上产出一个已校验的 `release` 安装包并自动打开输出目录。

> **开源仓库里的差异（`github.com/xdrshjr/AragonAgent`）。** 这个仓库只有 `packages/tui` 与
> `packages/desktop` 两个 workspace 包。引擎 `@aragon-agent/core` 与命令行宿主 `@aragon-agent/cli`
> 是**闭源**的，作为 `packages/desktop` 的普通依赖从 npm registry 安装：`scripts/stage.mjs` 按
> `packages/desktop/package.json` 里声明的版本安装（`--omit=dev --omit=optional`），不再 `npm pack`
> 同仓库的兄弟包，产出的 `build-staging/engine` 与 `manifest.json` 结构不变。
>
> 由此带来两条与本仓库形状有关的结论：
>
> - 前置检查 `repo-packages` 与 `-Doctor` 的 `repo-layout` 只要求 `packages/tui` 和 `packages/desktop`
>   存在。`packages/core`、`packages/cli` 不在本仓库里属正常，详情会写 `engine from npm registry
>   (closed source)`；它们存在（闭源私有仓库）同样通过。
> - 打包前 `packages/tui/dist` 必须存在：desktop 通过 TUI 的 export map 从 `@aragon-agent/tui/model/*`
>   取类型。`pack-desktop.ps1` 发现它缺失时会先跑 `npm run build -w packages/tui`，已存在则跳过
>   （`-SkipEngineBuild` 可完全跳过这一步）；`-Doctor` 的 `engine-dist` 项在缺失时只给 warn，并给出
>   同一条修复命令。想在仓库根目录一次构建两个包，用 `npm run build`。

## 1. 快速开始

最小可用的三条命令（Windows PowerShell 5.1，在仓库根目录做一次安装之后）：

```bat
:: 1) 只在仓库根目录装一次（workspace 会把依赖提升到根 node_modules）
npm install
:: 2) 再进桌面包打包，脚本会先把 packages\tui 编译出来
cd packages\desktop
pack-desktop.cmd
```

- 第一条 `npm install` 在**仓库根目录**执行一次即可，之后不必重复。
- `pack-desktop.cmd` 也可以直接在资源管理器里双击。
- 第三个入口是 npm 脚本：在 `packages\desktop` 下执行 `npm run pack:win`，等价于无参数运行 `pack-desktop.ps1`。
- 无参数运行 = release flavor + 宿主平台（win）+ 安装包 + `verify-bundle` 校验 + 打开输出目录。
- 实测耗时（本机、热缓存）：`-Dir` 约 1.5 分钟（`DONE in 92.7s`），时间几乎都花在 `stage.mjs` 的引擎 `npm install` 与 electron-builder 上；零参数的完整安装包要多做一步 NSIS，因此更久。
- 首次构建要先下载 Electron（约 100 MB）和引擎依赖，所以第一次会明显慢于上面的数字。

## 2. 前置条件

| 项目 | 要求 |
|---|---|
| 系统 | Windows 10 / Windows 11 |
| Shell | Windows PowerShell 5.1+（系统自带；脚本以 5.1 为目标运行环境） |
| Node | Node >= 20（本机为 v22），npm 10.x |
| 依赖 | 首次使用前，在**仓库根目录**执行一次 `npm install` |
| 磁盘 | 建议至少 8 GB 可用空间（`dist`、`build-staging`、`release` 三份产物同时存在） |
| 网络 | 首次构建需要联网下载 Electron 与 electron-builder 的相关依赖（Electron 二进制在安装时下载） |

本文的耗时与行为来自这套已验证环境：Windows 11 26200、Windows PowerShell 5.1.26100、node v22.18.0、npm 10.9.3、37.5 GB 可用空间。

## 3. 一键打包

三种等价入口（都在 `packages\desktop` 下）：

1. **双击** `packages\desktop\pack-desktop.cmd`。它会用 `-NoProfile -ExecutionPolicy Bypass` 启动 PowerShell 脚本、把你附加的参数原样转发（例如 `pack-desktop.cmd -Dir`），结束时停在 `Y/N` 提示上（`choice /c YN /t 30 /d Y`，30 秒后自动关闭，所以不会把 CI 卡住），并把脚本的退出码原样返回；传了 `-NoPause` 就完全跳过这个提示。
2. **命令行**：

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File .\pack-desktop.ps1
```

3. **npm 脚本**（`packages\desktop\package.json` 的 `pack:win`）：

```bat
npm run pack:win
```

三个入口背后是同一个 `pack-desktop.ps1`，它按顺序做这几步：前置检查（prerequisites）→ `npm run build -w packages/tui`（`packages/tui/dist` 已存在时跳过，加 `-SkipEngineBuild` 完全跳过）→ `node scripts/dist.mjs`（内部是 `build.mjs` → `stage.mjs` → `electron-builder`）→ `node scripts/verify-bundle.mjs`（报告引擎大小、无原生扩展、无 `isolated-vm`、宿主 import 均可解析）→ 打印产物清单并打开输出目录。每次运行的日志写进 `pack-logs\pack-<yyyyMMdd-HHmmss>.log`。

要加开关就用前两种入口；`npm run pack:win` 是“无参数运行”的快捷方式。

在 CI 或任何输入被重定向的场合，脚本结尾的按键等待会自动跳过（等同于 `-NoPause`）。

## 4. 常用场景

每条都可以直接复制到 `packages\desktop` 下执行。

| 场景 | 命令 |
|---|---|
| 最快验证（只出解包目录，不做 NSIS 安装包） | `powershell -NoProfile -ExecutionPolicy Bypass -File .\pack-desktop.ps1 -Dir` |
| 完整安装包（默认行为，可省略全部参数） | `powershell -NoProfile -ExecutionPolicy Bypass -File .\pack-desktop.ps1 -Flavor release -Platform win` |
| 全新构建（先删 `dist`、`build-staging`、输出目录） | `powershell -NoProfile -ExecutionPolicy Bypass -File .\pack-desktop.ps1 -Clean` |
| e2e flavor（打包测试专用的 `release-e2e`） | `powershell -NoProfile -ExecutionPolicy Bypass -File .\pack-desktop.ps1 -Flavor e2e` |
| 只跑环境体检（不改任何文件） | `powershell -NoProfile -ExecutionPolicy Bypass -File .\pack-desktop.ps1 -Doctor` |
| CI / 无人值守（结尾等按键） | `powershell -NoProfile -ExecutionPolicy Bypass -File .\pack-desktop.ps1 -NoPause` |
| npm 脚本入口（等价于无参数运行） | `npm run pack:win` |

也可以把这些参数交给 `pack-desktop.cmd`（它会原样转发），例如 `pack-desktop.cmd -Dir`。

实测（本机、热缓存）：`-Dir` 约 1.5 分钟（`DONE in 92.7s`，exit 0），完整安装包更久；首次构建要先下载 Electron（约 100 MB）和引擎依赖，不能按上面的数字估算。

## 5. 参数表

`pack-desktop.ps1` 的**全部**参数如下，没有表外的开关。

| 开关 | 默认值 | 含义 |
|---|---|---|
| （无参数） | — | 宿主平台的完整 release 安装包 + 校验 + 打开输出目录 |
| `-Flavor <release\|e2e>` | `release` | `e2e` 构建测试专用 flavor，输出到 `release-e2e`（inspector fuse 打开，绝不给用户用） |
| `-Platform <win\|mac\|linux>` | 宿主平台 | 非宿主平台会被拒绝并返回退出码 2（本机无法交叉构建，规则与 `scripts/ci-desktop.mjs` 一致） |
| `-Dir` | 关 | 只构建解包目录，不做安装包 —— 最快路径（跳过 NSIS 步骤） |
| `-Output <dir>` | `release` / `release-e2e` | 输出目录 |
| `-Clean` | 关 | 构建前删除 `dist`、`build-staging` 与输出目录 |
| `-SkipVerify` | 关 | 跳过 `scripts/verify-bundle.mjs` |
| `-SkipEngineBuild` | 关 | 跳过 `npm run build -w packages/tui`（直接用磁盘上的 `packages/tui/dist`） |
| `-Doctor` | 关 | 运行环境体检并以体检结果作为退出码 |
| `-NoOpen` | 关 | 不在输出目录上打开资源管理器 |
| `-NoPause` | 关 | 结尾不等待按键（输入被重定向时自动如此，例如 CI） |
| `-Help` | — | 打印用法并以 0 退出 |

退出码：

| 退出码 | 含义 |
|---|---|
| `0` | 成功 |
| `1` | 构建或校验失败（`-Doctor` 有 fail 项时也是 1） |
| `2` | 用法错误（例如平台不对） |

### 环境体检（`-Doctor`）

体检是**只读**的：只报告，每条不通过打印一行 `-> fix:`，不安装、不删除任何东西。它一共做 15 项检查（名称与体检输出一一对应）：

1. `powershell` —— Windows PowerShell 5.1+ 且为 64 位
2. `execution-policy` —— 执行策略（Execution Policy）
3. `os` —— 操作系统与体系结构
4. `node` —— Node >= 20
5. `npm` —— npm 在 PATH 上且可用
6. `repo-layout` —— 仓库结构（必须存在 `packages/tui` 与 `packages/desktop`；`packages/core`、`packages/cli` 不在本仓库属正常，引擎来自 npm registry）
7. `desktop-node-modules` —— `node_modules` 是否存在
8. `electron` —— electron 是否已安装及其版本
9. `electron-builder` —— electron-builder 是否已安装及其版本
10. `engine-dist` —— 引擎依赖能否从 `node_modules` 解析（`@aragon-agent/core`、`@aragon-agent/cli`、`@aragon-agent/tui` 来自 npm registry），以及 `packages/tui/dist` 是否存在（缺失只 warn，修复命令是 `npm run build -w packages/tui`）
11. `disk-space` —— 可用磁盘空间
12. `write-access` —— 对 desktop 目录的写权限
13. `electron-run-as-node` —— `ELECTRON_RUN_AS_NODE` 是否被设置
14. `build-icon` —— `build/icon.png` 是否存在
15. `env` —— 环境代码页（codepage），以及非 ASCII 检出路径的提醒

体检脚本本身是 `scripts\pack\Invoke-PackDoctor.ps1`，`-Doctor` 只是它的入口。退出码就是体检结论：**至少有一项 fail 就是 1**，15 项全部 pass 或只有 warn 才是 0（warn 只提示，不改退出码）。所以某项通过不代表整份体检通过，要看完整张表。

## 6. 产物在哪里

全部相对于 `packages\desktop`：

| 路径 | 内容 |
|---|---|
| `release\` | release flavor 的输出目录：安装包、`*.blockmap`、`*.yml` 以及 `win-unpacked\` |
| `release\win-unpacked\AragonAgent.exe` | 解包后的应用本体（`-Dir` 的产物就在这个目录里，`-Dir` 不产出安装包） |
| `release\win-unpacked\resources\engine\` | 以已发布形态安装的引擎（`core` / `tui` / `cli`），不在 asar 里 |
| `release-e2e\` | `-Flavor e2e` 的独立输出目录，结构与 `release\` 相同 |
| `build-staging\engine\` | `stage.mjs` 组装的引擎目录（中间产物，可删） |
| `pack-logs\pack-<yyyyMMdd-HHmmss>.log` | 每次运行的完整日志（本地文件，不要提交） |

打印产物清单时，输出目录的每个顶层条目一行：名称、大小、类别（`installer` / `folder` / `metadata`）。目录（比如 `win-unpacked\`）给的是**递归大小和文件数**，不是目录项自身的大小；安装包（`*.exe` 等）不混在这个合计里，而是单独列出来并给出可复制的完整路径。`-Dir` 构建没有安装包，清单里会直接写明这一点，然后给出解包目录、可执行文件路径，以及一条可选的 `--smoke` 提示。统计只看输出目录的顶层，所以 `win-unpacked\` 里面的 exe 不会被当成安装包。

命名规则：文件名的产品名来自 `electron-builder.yml` 的 `productName`（`AragonAgent`），版本号来自 `packages\desktop\package.json` 的 `version`，安装包使用 electron-builder 默认模板 `${productName} Setup ${version}.${ext}`，因此 Windows 安装包形如 `AragonAgent Setup <version>.exe`；`*.blockmap` 与 `*.yml` 是 electron-builder 随安装包一起写出的小文件。想看别的目录就加 `-Output <dir>`（e2e flavor 的默认目录固定为 `release-e2e`，不要和 `release` 混用）。

可选、手动的冒烟测试（不在一键脚本里）：

```bat
.\release\win-unpacked\AragonAgent.exe --smoke
```

它打印一行 JSON，只有真正拉起一个 session host 才会以 0 退出。

## 7. 日志与排错

每次运行都会写一份日志：`packages\desktop\pack-logs\pack-<yyyyMMdd-HHmmss>.log`。先把日志尾部读一遍，再看退出码是 1（构建/校验失败）还是 2（用法错误）。最常见的 6 个失败原因：

| 现象 | 真实原因 | 排查动作 |
|---|---|---|
| `stage` 阶段报找不到包 / 直接 ERR_MODULE_NOT_FOUND | 没有在仓库根目录执行过 `npm install`，或依赖被清掉了 | `pack-desktop.cmd -Doctor` 看 `desktop-node-modules` 项；回仓库根目录执行 `npm install` |
| 启动即报语法 / 引擎报 `The engine "node" is incompatible` | Node 版本过低（< 20） | `node -v`；doctor 的 `node` 项会直接标红并给出 `-> fix:` |
| Electron 当成纯 Node 跑，`import 'electron'` 直接崩 | 终端（VS Code、Claude Code 等）导出了 `ELECTRON_RUN_AS_NODE` | doctor 的 `electron-run-as-node` 项会报；在干净的 PowerShell 里重跑，或先清除该变量再按第 3 节启动 |
| 打包到一半失败，提示文件被占用 / 空间不足 / 写不进去 | 磁盘空间不足或杀毒软件锁住了 `release\` 里的文件 | doctor 的 `disk-space`、`write-access` 项；关掉占用的杀软实时扫描，或加 `-Clean` 重跑 |
| 退出码 2，提示不能构建该平台 | 用 `-Platform mac` / `-Platform linux` 在 Windows 上请求了交叉构建 | 去掉 `-Platform`（默认宿主平台），或到对应系统上打包（见第 9 节） |
| 脚本提示 output path contains a space，或 electron-builder 报参数被拆开 | `-Output` 里有空格：`dist.mjs` 把 `-c.directories.output=<dir>` 透给 electron-builder 时没加引号 | 换一个不含空格的输出目录，即 `-Output` 不要包含空格（脚本会提前警告）；默认的 `release` 没有这个问题 |

其他：先加 `-Dir` 跑一遍能快速断定问题在“编译/组包”还是在“NSIS 安装包”这一步；怀疑缓存脏就加 `-Clean`；只怀疑产物不对而构建本身没问题时，用 `-SkipEngineBuild` 省掉 TUI 的重建时间（前提是 `packages/tui/dist` 已经是新的）。`pack-logs\` 只在本地产出（本包没有忽略规则覆盖它），请把它留在本机，不要提交到仓库。

## 8. 与现有 CI 的关系

`node scripts/ci-desktop.mjs` 仍然是 CI 的**唯一入口**（`verify` / `e2e-win` / `package <win|mac|linux>`）。`pack-desktop.ps1` 不替代它，两者调用的是同一批 node 脚本：`scripts/dist.mjs`、`scripts/verify-bundle.mjs`（引擎由闭源仓库发布到 npm，本仓库只编译 `packages/tui` 与 `packages/desktop`）。

- 面向对象不同：`ci-desktop.mjs` 面向流水线（含 E2E、用例台账、bench 报告）；`pack-desktop.ps1` 面向本地开发者，只做“构建 + 校验 + 打开目录”。
- 两者不冲突：都可以在同一份工作区里独立运行，产物目录还是 `release\` / `release-e2e\`。
- 平台规则一致：非宿主平台一律拒绝（退出码 2），和 `ci-desktop.mjs package` 的判断相同。
- 在 CI 里想用这个脚本，加 `-NoPause`（输入被重定向时本来也会自动跳过）。

## 9. 注意

- **不签名、不发布。** 证书不在仓库里，所以 Windows SmartScreen 与 macOS Gatekeeper 会提示来源未知，这是预期行为；构建过程带 `--publish never`，不会上传任何东西。
- **换机打包。** mac / linux 的安装包必须在对应系统上构建：`-Platform mac` / `-Platform linux` 在 Windows 上会被拒绝（退出码 2），因为 electron-builder 无法在这里交叉构建。
- **e2e flavor 不是给用户用的。** `-Flavor e2e` 打开的 inspector fuse 与测试开关只服务于打包后的自动化测试，产物落在 `release-e2e\`，不要分发给任何人。
- `-Clean` 会真的删掉 `dist`、`build-staging` 和输出目录，确认里面没有你要留的东西。
- 需要管理员权限的安装器、签名、更新源都不在这个脚本的范围内（更新在应用里只是“有新版”的通知）。
