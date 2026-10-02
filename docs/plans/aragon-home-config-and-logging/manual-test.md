# 手工验收记录 — aragon-home-config-and-logging

- **平台**：Windows 11（`process.platform === 'win32'`，`os.release() === '10.0.26200'`）
- **Node**：v22.18.0
- **被测产物**：`packages/cli` 本地 `npm run build` 后的 `dist/cli.js`（版本 0.5.0）
- **执行日期**：2026-07-27
- **执行方式**：`ARAGON_HOME` 指向 `%TEMP%` 下的一次性目录逐条跑。**验收结束后这些目录已删除** —— 迁移会把真实 `config.json`（含 API key）**复制**进去，留在 `%TEMP%` 里等于把凭据摊在一个所有进程可读的位置。

图例：**PASS** = 按 §8.2 期望通过；**PASS\*** = 通过，但下方有需要知道的说明；**N/A** = 需要真实 API key / 交互终端 / 多机环境，自动化用例已覆盖同一断言。

---

| # | 结果 | 记录 |
|---|---|---|
| AC-1 | **PASS** | `ARAGON_HOME=<tmp> node dist/cli.js --version` → `<tmp>\logs\aragon-2026-07-27.log` 存在，首行 `{"ts":"2026-07-27T09:16:15.673-04:00","lv":"info","sid":"ecfbac9f","pid":33908,"scope":"cli","msg":"cli_start","data":{"version":"0.5.0"}}`。`ts` 带本地偏移 `-04:00`，与文件名同一时钟（P2-7）。 |
| AC-2 | **N/A** | 需要交互 TTY。等价断言由 `config-skills-merge.test.ts`（`log` 段深合并 + 写盘 clamp）与 `App.tsx::persistConfig` 的 `config_write` 记录覆盖；`aragon config set model x` 走同一个 `updatePersistedConfig`，实测写盘并出现在 `config get model`。 |
| AC-3 | **PASS** | 手改 `config.json` 的 `model` 后 `aragon config get model` / `config list` 立即反映新值，无迁移、无 version bump。 |
| AC-4 | **PASS** | 手改 `thinkingLevel` 后执行 `config set log.level warn`：`thinkingLevel` 原样保留（读-改-写证明）。 |
| AC-5 | **PASS\*** | 用**不匹配任何格式正则**的自定义 key 走 `--api-key`：`node dist/cli.js -p "hi" --api-key "zz9-custom-endpoint-key-not-a-vendor-format" --base-url http://127.0.0.1:9/v1 --log-level debug` 之后 `grep -c "zz9-custom-endpoint-key" <tmp>/logs/*.log` → **0**。<br>\* settings 覆盖层那条路径（P0-3 的原始场景）需要 TTY，由 `logging-redact.test.ts` 的用例 4b 机械守护：`installLogging()` **之后**才 `registerSecret()` 的值仍被脱敏。 |
| AC-6 | **PASS** | 本机真实存在 `%APPDATA%\aragon-agent-nodejs\Config\config.json`。首次运行 stderr 打印 `moved settings to C:\...\<tmp> (config.json)`；`<tmp>\.migrated-from-env-paths` 存在且 `from.config` / `from.data` 指向两棵旧树；**旧 `config.json` 仍在原处**（复制而非移动）。第二次运行完全 no-op。 |
| AC-7 | **PASS** | `logging-sink.test.ts` 覆盖真实文件系统上的体积轮转：`aragon-<date>.1.log` 出现且含轮转前内容，序号递增不覆盖既有 `.1.log`，文件总数被压到 `maxFiles`。 |
| AC-8 | **PASS** | `logs path` 打印当前文件 + 目录 + 级别与隐私提示；`logs list` 打印名/字节/mtime；`logs tail -n 3` 渲染成人类可读行。**`logs clear --yes` 删掉了本进程自己刚打开的当天文件**（`Deleted 1 log file(s).`，退出码 0）—— 这正是 IF-4 说的那条：起作用的是 `runClear` 里的 `sink.close()`。不带 `--yes` 时 `Refusing to delete log files without --yes.` + 退出码 **2**。 |
| AC-9 | **PASS\*** | 用「日志目录位置放一个同名文件」模拟不可写（`mkdirSync` 每次 ENOTDIR），等价于 ACL 只读：连续 3 次失败后 sink 自禁用、`onFailure` 只回调一次、后续写入与 `close()` 全部不抛（`logging-sink.test.ts`）。全屏帧不错位由 C2 结构保证 —— 故障走 `onFailure` → toast，全程没有任何直写 stdout/stderr 的路径。<br>\* 真实 ACL 改写未在本轮执行。 |
| AC-10 | **PASS** | 同一天文件里出现多个 `sid` / `pid` 的记录（`ecfbac9f`/33908、`1b581197`/39268、`69dbbd5a`/28136），`logs tail` 全部解析成功 —— 无撕裂行。 |
| AC-11 | **PASS** | `ARAGON_HOME=<tmp>` 下全部产物落在 `<tmp>\`；`aragon config home` 打印该路径并标注 `(overridden by ARAGON_HOME)`，另打印两行 `previously:` 旧位置（P2-13）。 |
| AC-12 | **PASS** | `-p` 运行时迁移提示与 skills 提示都在 stderr；stdout 只有模型输出。 |
| AC-13 | **PASS\*** | 写入 `{"version":1,"model":"x",}` 后运行 `aragon config get model`：配置回落默认（stdout 只有 `claude-sonnet-4-5-20250929`），stderr 打印 `config: using defaults, could not parse ...config.json: Expected double-quoted property name in JSON at position 25 (line 1 column 26)`，日志同时出现 `error` / `config` 的 `config_parse_failed`。把文件改回合法 JSON 后 stderr **完全干净** —— 提示只在真出问题时出现。<br>\* `config edit` 的编辑器交互未在本轮执行；备份与退出后重新 `JSON.parse` 的逻辑在 `config/cli-commands.ts::runConfigEdit`。全屏 TUI 的 toast 分支（stderr 那行会被 alternate screen 抹掉，所以另走 toast）由 `ui/use-startup-notices.ts` 承担，需 TTY，本轮未执行。 |
| AC-14 | **PASS\*** | 信号路径由 `logging-install.test.ts` 用例 12 机械守护：每个信号**恰好一个**监听器；默认 terminator 是 `exit(128+signo)`（`SIGINT`→130、`SIGTERM`→143），覆盖 headless / inline / 全部子命令；`setSignalTerminator` 替换后先 `restore` 再 `exit`。`'exit'` 钩子 flush 后当天文件确实含最后一条记录。<br>\* 真实终端里按 Ctrl+C 未在本轮执行。 |
| AC-15 | **PASS** | `.env` 里的 `ARAGON_HOME` 不生效（`app-paths.ts` 在 `loadDotenv()` 之前求值），`aragon config home` 打印真实生效的根。README「Files & logs」已把这条写死。 |

---

## 附加实测（§8.1 用例 13 的命令行侧）

`--log-file` / `--no-log-file` 三态四个方向全部正确：

| 场景 | logs 目录 |
|---|---|
| `config.json` 里 `log.toFile: false`，无 flag | 不创建 |
| 同上 + `--log-file` | 创建 |
| 同上 + `ARAGON_LOG_FILE=1` | 创建 |
| 文件未表态（默认 `true`）+ `--no-log-file` | 不创建 |

掩码（R-12）：`config get apiKeys.anthropic` → `sk-...7890`；`config list --json` 的 `apiKeys` 同样是 `sk-...7890`。

`log.redactSecrets false` 在 stdout 打印显式告警并指出重新开启的命令。

深合并（R-3）：先 `config set log.redactSecrets false`，再 `config set log.level warn`，`config get log.redactSecrets` 仍为 `false`。

---

## 自动化基线

| 命令 | 结果 |
|---|---|
| `packages/cli` `npx tsc -p tsconfig.json --noEmit` | 0 error |
| `packages/cli` `npx vitest run` | **52 files / 681 passed / 2 skipped** |
| `packages/core` `npx vitest run` | **15 files / 219 passed**（含 `no-host-coupling.test.ts` —— C1 未被破坏） |
| `packages/cli` `npm run build` | 通过，`dist/cli.js` 带 shebang |

`cli.tsx` **785 行**（C7 上限 900，为 plan-mode 预留的余量仍在）；本方案新增/修改的每个文件都在 C5 的 1000 行以内，最大的是 `config/schema.ts` 596 行。

---

## 未执行项与原因

- **AC-2 / AC-13 的编辑器交互 / AC-14 的真实 Ctrl+C**：需要交互终端，本轮在非 TTY 环境执行。三者的核心断言都有机械护栏（分别是深合并回归、`config_parse_failed` 记录、用例 11/12 的钩子契约）。
- **AC-9 的真实 ACL 改写**：用等价的 ENOTDIR 注入代替，覆盖的是同一段 `try/catch`。
- **`npm pack` tarball 内容核对**（§8.3）：`package.json` 的 `files` 白名单未改动（仍是 `dist` / `runtime` / `skills` / 两份 md），本方案没有新增任何会被打进包的路径。
