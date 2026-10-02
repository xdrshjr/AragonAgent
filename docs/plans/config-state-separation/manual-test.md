# config-state-separation — 手工验收清单

对应 `spec.md` §8.3。**平台：Windows**（需求原场景），路径示例按 `C:\Users\<you>\.aragon-agent\`。
POSIX 上除权限位一条外全部等价。

执行前请先 `npm run build -w packages/cli`，并确认 `npx vitest run` 在 `packages/cli` 下为绿。

---

## 0. 准备

1. 备份现有配置：`copy C:\Users\<you>\.aragon-agent\config.json C:\Users\<you>\config.json.backup`
2. 记录基线：打开 `config.json`，确认里面**存在** `promptHistory` / `submitCount` /
   `mouseNoticeSeen` / `recentModels` 中的至少一个（老用户必然有；全新安装可跳到第 4 步，
   并把第 3 步的「迁移」理解为「首次写入」）。

> 想在不动真实主目录的前提下演练：先 `set ARAGON_HOME=C:\tmp\aragon-test`。
> 注意 `ARAGON_HOME` **不能**写在 `.env` 里——它在任何 `.env` 加载之前就被解析。

---

## 1. 启动即迁移（AC-6）

| # | 操作 | 期望 |
|---|---|---|
| 1.1 | 运行 `aragon config home` | 打印用户根目录，并新增两行 `prompt history: …\prompt-history.jsonl`、`ui state: …\state.json` |
| 1.2 | 打开 `config.json` | 四个键 `promptHistory` / `submitCount` / `mouseNoticeSeen` / `recentModels` **全部消失**；`model` / `apiKeys` / `skills` / `log` 原样保留；新增 `historyEnabled: true` |
| 1.3 | 打开 `prompt-history.jsonl` | 迁移前 `config.json` 里的每条历史各占一行，形如 `{"v":1,"ts":…,"text":"…"}` |
| 1.4 | 打开 `state.json` | `{"schema":1,"submitCount":<迁移前的值>,"mouseNoticeSeen":<迁移前的值>}` |
| 1.5 | 再次运行 `aragon config home` | `prompt-history.jsonl` 行数**不变**（不重复导入）；`aragon logs tail --level info` 里只有一条 `migrate_state_split` |
| 1.6 | 迁移过程 | 终端**没有**新增任何提示行（D-8：本次迁移对用户无感） |

## 2. 同一会话内的召回（AC-2 前半句 / RV-1）

> **这一步是整份清单里最容易被跳过、也最容易漏掉真实缺陷的一步。**
> `setPromptHistory` 被顺手删掉时，重启之后一切正常，只有「提交完不重启就按 `↑`」会失败。

| # | 操作 | 期望 |
|---|---|---|
| 2.1 | 启动 `aragon`，依次提交三句：`第一句` / `第二句` / `第三句` | 三次都正常回复 |
| 2.2 | **不要退出**，按 `↑` | 输入框出现 `第三句` |
| 2.3 | 再按 `↑` 两次 | 依次出现 `第二句`、`第一句` |
| 2.4 | 按 `↓` 走到底 | 输入框清空（既有行为，不是恢复草稿） |

## 3. 提交不再触碰 config.json（AC-5）

| # | 操作 | 期望 |
|---|---|---|
| 3.1 | 记录基线：`dir C:\Users\<you>\.aragon-agent\config.json`（**在第 1 步的迁移完成之后取**，迁移本身会写一次） | 记下字节数与修改时间 |
| 3.2 | 在 TUI 里再提交 3 句后退出 | — |
| 3.3 | 再次 `dir config.json` | 字节数与修改时间**均与 3.1 相同** |
| 3.4 | `type prompt-history.jsonl`（末尾） | 多了 3 行；`state.json` 的 `submitCount` 加了 3 |

## 4. 跨进程召回（AC-2 后半句）

| # | 操作 | 期望 |
|---|---|---|
| 4.1 | 重新启动 `aragon`，按 `↑` 三次 | 依次召回最近三句，顺序与退出前一致 |
| 4.2 | 提交一句与历史中**完全相同**的话，再按 `↑` | 它只出现一次，且位于最新端（AC-3） |

## 5. TUI 修改仍然落盘（AC-9 / G6）

| # | 操作 | 期望 |
|---|---|---|
| 5.1 | TUI 内 `/theme cool` 后退出 | `config.json` 的 `theme` 为 `"cool"` |
| 5.2 | `aragon config set model gpt-4o` 后重开 | 状态栏显示 `gpt-4o` |
| 5.3 | 打开设置页改任一项并保存 | 该字段落盘，且 `skills` / `log` 段的其余字段**未被清空** |

## 6. 启动读取配置（AC-8 / G5）

| # | 操作 | 期望 |
|---|---|---|
| 6.1 | 手工把 `config.json` 的 `model` 改成一个显眼值，启动 `aragon` 后退出 | 状态栏显示该值 |
| 6.2 | `aragon logs tail --level info -n 20` | 有一条 `config_loaded`，`data` 里列出本次生效的 `provider` / `model` / `theme` / `toolTimeoutMs` / `historyEnabled` / `configPath`，`hasApiKey` 为布尔值 |
| 6.3 | 检查该记录 | **不含**任何密钥明文 |

## 7. history 命令（AC-10 / G7）

| # | 操作 | 期望 |
|---|---|---|
| 7.1 | `aragon history path` | 打印 `prompt-history.jsonl` 绝对路径 + 「存储原文」提示 |
| 7.2 | `aragon history list -n 5` | 最近 5 条，**从新到旧**，每行带 ISO 时间戳 |
| 7.3 | `aragon history list --json` | 原始 `{"v":1,"ts":…,"text":…}` 数组 |
| 7.4 | `aragon history clear`（不带 `--yes`） | 拒绝执行，`echo %ERRORLEVEL%` 为 `2`，文件仍在 |
| 7.5 | `aragon history clear --yes` | 打印 `Removed N entries.`，文件消失 |
| 7.6 | 重开 `aragon` 按 `↑` | 无内容可召回；`config.json` 不受影响 |

## 8. historyEnabled 开关（D-9 / RV-12）

| # | 操作 | 期望 |
|---|---|---|
| 8.1 | 先提交 2 句，再 `aragon config set historyEnabled false` | 打印 `Set historyEnabled = false`；`config.json` 中该键为 `false` |
| 8.2 | 重开 `aragon`，提交 1 句后退出 | `prompt-history.jsonl` 行数**不变**（不写） |
| 8.3 | `aragon history list` | 仍能列出 8.1 之前的 2 条（关写不关读） |
| 8.4 | `aragon config set historyEnabled true` | 恢复记录 |

## 9. 删了不会长回来（AC-1 / R-1）

| # | 操作 | 期望 |
|---|---|---|
| 9.1 | 手工往 `config.json` 里加回 `"promptHistory": ["手工塞回来的"]` | — |
| 9.2 | 执行任意一次写操作，例如 `aragon config set theme cool` | — |
| 9.3 | 重新打开 `config.json` | `promptHistory` **已消失**，`theme` 已生效 |

## 10. 首次运行 + 关掉文件日志（RV-2 / R-13）

> 这条覆盖的是「`<home>` 目录还不存在」的路径，`mkdirSync` 缺失时会**静默**不落盘。

| # | 操作 | 期望 |
|---|---|---|
| 10.1 | 设 `ARAGON_HOME=C:\tmp\aragon-fresh`（目录不存在），并 `aragon config set log.toFile false` 之外**不做任何配置写入**——最干净的做法是直接删掉整个 `C:\tmp\aragon-fresh` | — |
| 10.2 | 用 `aragon --no-log-file` 启动，提交 1 句后退出 | `C:\tmp\aragon-fresh\prompt-history.jsonl` 被创建，含那 1 行 |

## 11. 权限位（AC-4，仅 POSIX）

| # | 操作 | 期望 |
|---|---|---|
| 11.1 | `stat -c %a ~/.aragon-agent/prompt-history.jsonl` | `600` |
| 11.2 | `stat -c %a ~/.aragon-agent/state.json` | `600` |
| 11.3 | 追加到 400 行以上触发一次压实后重测 11.1 | 仍为 `600`（rename 不保证保留 mode） |

---

## 收尾

- 恢复备份：`copy C:\Users\<you>\config.json.backup C:\Users\<you>\.aragon-agent\config.json`
- 清掉演练目录：`rmdir /s /q C:\tmp\aragon-test C:\tmp\aragon-fresh`
