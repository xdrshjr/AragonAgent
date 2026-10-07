# 本轮实现验证记录

日期：2026-10-07。本文只记录本轮证据；未执行项目不会标为通过。此文件不是发布许可。

## 环境与验收边界

执行环境为 Windows 10.0.26200、PowerShell，Node v22.18.0、npm 10.9.3。
通过工具执行命令及 Ink 的真实 Yoga/渲染/输入链路测试；没有连接可人工操作的 Windows Terminal 或 VS Code GUI。
以下真实宿主组合均保持**待验收**：Windows Terminal + 微软拼音、VS Code 集成终端 + 微软拼音；
各宿主的当前版本、字体、实际行列数、mouse/mouseSelect/paste/hints 配置尚未采集。
第二个维护中 Node 版本、真实 SGR 拖选、Shift+Enter 宿主按键拦截与截图同样待验收。

## 自动化行为

- 输入：CSI-u Shift+Enter、Ctrl+J、Alt+Enter，真实过滤器→Ink 的 DEL/BS/CSI Delete/Alt+DEL，括号粘贴、字素导航、历史边界、失焦/补全与高度上限均有回归。
- 队列：稳定 ID、重复动作、接收回填、裁剪记账、/clear、取消数量及恢复不重发均有回归；App 真实 `/queue` 按键分页、缩放、关闭和草稿保留已覆盖。
- 复制：两入口共享 busy，超时结果与资源释放分离，迟到 close 不重复反馈，卸载取消，以及复制不同时退出/停服务均有回归。
- 布局：40–200 列字段测宽、中文/控制字符净化、短窗口预算、TODO 对齐、固定状态栏唯一 spinner、overlay/补全/确认提示所有权均有回归。

最终标准 `npm test` 退出码 0：CLI 233 个文件、3506 项通过、6 项跳过（114.74 秒）；Core 30 个文件、482 项通过（2.47 秒）。
总计 3988 项通过、6 项跳过。测试日志中的 rollback 故障提示来自故障路径用例，套件没有失败。
此前针对旧展示契约、剪贴板及队列桩的 130 项定向复查也全部通过。
最终 `npm run typecheck` 与 `npm run build` 均退出 0；CLI 与 Core 的源码及测试类型检查通过，CLI 启动文件 shebang 已生成。
`git diff --check -- packages/cli docs/plans/tui-composer-queue-status` 退出 0。
按 spec 文件表逐项核对 65 个计划文件，没有缺失修改；实现中发现的遗漏测试及编码方案问题已补入 spec 缺陷节。

本工作区同时存在既有 package/lockfile 改动和另一模型配置任务的改动，均予以保留；本节点没有提交 Git，也没有清理其他任务的文件。

## Windows 系统剪贴板读回

测试保存原 DataObject 格式，在 finally 中恢复。
只使用固定的无敏感样本：英文、中文、含空行和缩进的代码、`M:/项目/a.ts` 等。
使用原生复制实现后执行 `Get-Clipboard -Raw`，仅允许 CRLF/LF 的差异。

首次实测：四组均返回原生工具成功，却多出正文首字符 U+FEFF。证据为运行目录中的读回结果；
该失败推翻原 spec 的“clip.exe + 带 BOM UTF-16LE”要求，已在设计缺陷节记录修正，不把退出码 0 宣称为逐字符通过。
进一步探测无 BOM 的 `clip.exe` 也会把部分纯中文误判编码，因此改为固定 PowerShell 脚本显式 UTF-8 解码 stdin，再调用 `Set-Clipboard`。
修复后 **16/16 样本原始读回逐字相等**，均返回 confirmed/native，单次耗时 322–408ms。
样本包含短英文、单汉字、中文、emoji、组合字素、多行代码、空行缩进、中文路径、前后空白、尾部换行、正文自带 U+FEFF 和 shell 元字符。
成功原始数据为 `.agentmesh/clipboard-readback-fixed.json`；初次失败及编码探测为 `.agentmesh/clipboard-readback.json`、`.agentmesh/clipboard-probe.json`。

此测试只验证系统剪贴板原生写入/读回，不代表双宿主的拖选、IME 或快捷键验收通过。

## 30 秒性能采样（部分证据，验收未通过）

使用真实 App、Ink、React 和 Yoga，PassThrough 模拟 TTY；每组先注入 1000 条转录，再经 stdin 提交 50 条消息。
采样前后均断言真实 reducer 中 50 个 pending ID 唯一、FIFO 顺序不变，并验证状态栏显示 50。

| 场景 | 时长 | 实际 delta 频率 | App commit 估计 P95 | 按键到草稿 P95 | stdout 写入量 | 全屏清除 |
| --- | --- | --- | --- | --- | --- | --- |
| 160×40 | 30.133 秒 | 18.09 次/秒 | 33.684ms | 77.757ms | 4,129,419 字节 | 0 |
| 80×24 | 30.209 秒 | 18.14 次/秒 | 26.998ms | 60.409ms | 1,485,721 字节 | 0 |

目标定时器为 30Hz，受主线程阻塞影响实际投递不足，不能宣称达到了设计负载。
commit 耗时来自 render governor 的 render 至 layout effect 计时，**不是 frame flush**；无修改前同机同宿主基线，不能判断 ≤20% 回归门槛。
每组只有 5 次输入样本；本采样未覆盖真实宿主、IME、流式过程中复制与 resize 混合压力及长期资源增长。
每组 6 条采样进度日志被 App 的 console bridge 映射为 notice，数值包含这一低频附加负载。
因此保留 R08 发布门槛，不用以上数值替代完整性能验收。

原始数值、复现脚本和完整限制分别保存为 `.agentmesh/status-perf-results.json`、
`.agentmesh/status-perf-30s.test.tsx`、`.agentmesh/status-perf-report.md`；此前 10 条 pending 的初探单独保留，不混入本表。

## 真实宿主操作清单（待执行）

1. 两个宿主各记录版本、字体、窗口尺寸及全部输入开关；使用 Node 22.17+ 和另一维护版本重复。
2. 无绑定与有绑定 Shift+Enter 分别采集字节；Ctrl+J 产生换行；Alt+Enter 被宿主拦截时标不适用。
3. 微软拼音输入“你好，世界”，候选确认不能发消息，下一次独立 Enter 才发送；若交付同一 CR，记录该组合不通过及括号粘贴替代路径。
4. 英文、中文、多行代码和中文路径：拖选松开不改剪贴板，Ctrl+C 才复制；纯文本编辑器及系统读回一致。
5. 运行时连发三条（包括同文不同 ID），中断保留未接收项；收到真实回执后同时出现会话消息并消去 Queue。
6. 40×12、80×20、120×30；TODO/Team/补全/长草稿同时存在，输入与右栏共底线、状态字段无半数字。
7. 每种目标宿主持续流式 30 秒，同时输入/复制/resize；采集 P95、写入量、清屏次数和截图，并与相同场景旧版比较。

## 官方配置核对

本轮重新读取了 [Windows Terminal 交互设置](https://learn.microsoft.com/en-us/windows/terminal/customize-settings/interaction)
与 [actions](https://learn.microsoft.com/en-us/windows/terminal/customize-settings/actions)，以及
[VS Code Terminal Basics](https://code.visualstudio.com/docs/terminal/basics) 与
[Advanced](https://code.visualstudio.com/docs/terminal/advanced)。配置已写入 CLI README 和 `/terminal-setup`。
核对文档不能替代以上实测。保留 R08 发布验收门槛。

## 最终审查节点独立验证（2026-10-07）

本节点重新检查设计覆盖、相邻回归、命名与帮助文案，并修复 queue 全文覆盖层漏接滚轮的问题。
新增场景先失败（queue 滚轮实际 `[]`，预期 `[-3, 8]`），修复后 `mouse-routing.test.tsx` 的 34 项全部通过。
帮助页同步移除已停用的状态缩写。

验证对象为 `.agentmesh/tui-review-snapshot/aragon-agent-core` 中的独立功能快照，基于 HEAD `1b635d3f3`，
仅叠加本次 82 个文件的功能差异。包清单保持基线 CLI 0.6.11、Core 0.2.23；复用本机已安装依赖，未安装或升级依赖。
工作区另有模型配置和版本变更，没有纳入快照或暂存区。

- 最终 `npm test` 退出 0：CLI 227 个文件、3432 项通过、6 项跳过（98.29 秒）；Core 30 个文件、482 项通过（2.81 秒）。合计 3914 项通过。
- `npm run typecheck`、`npm run build` 均退出 0，源码与测试类型通过，CLI 启动文件生成成功。
- 剔除最后一个无关模型配置测试桩后，补跑 App 的 61 项回归及标准 typecheck，全部通过。
- `git diff --cached --check` 通过；逐文件暂存清单与计划及补列测试一致。
- 快照初次切分曾误删与模型配置桩同一行的 `isRunning/getCwd` 测试桩，导致 12 项队列会话测试失败；修正切分后定向 12 项及完整全量复跑均通过。这不是产品实现修复，未删除测试或放宽断言。
- 完整工作区也重新运行过全量测试：CLI 3508、Core 482 项通过、6 项跳过；包含模型配置任务的测试，仅作为混合工作区证据，不能替代上述独立快照结果。

原始日志保存在 `.agentmesh/tui-snapshot-test-final.log`、`tui-snapshot-typecheck-final.log`、`tui-snapshot-build.log`。
本节点不重复宣称上游剪贴板 16 项读回是本次执行；其原始证据与待验收范围继续保留。
最终提交是代码交付，不是发布；真实双宿主、微软拼音及完整性能验收仍未通过。
