/**
 * 进程退出码数据集（truth set S-6）。
 *
 * 5 档：`0` 成功 / `1` 代理错误 / `2` 用法或会话错误（**stdout 为空**）/ `3` 预算命中 /
 * `128+signo` 被信号中断。来源：`exec/runner.ts` 的 `exitCode()` 与 `exec/index.ts` 的用法错误分支。
 */

/** @typedef {{code: string, meaning: string, when: string, stdout: string,
 *   source: {path: string, lines: string, snippet: string}}} ExitCodeRecord */

/** 全部 5 档退出码。 */
export const exitCodes = [
  {
    code: '128 + signo',
    meaning: '被信号中断',
    when: "`SIGINT` → 130、`SIGTERM` → 143",
    stdout: "可能非空",
    source: { path: 'packages/cli/src/exec/runner.ts', lines: '888', snippet: '128 +' },
  },
  {
    code: '3',
    meaning: '预算命中',
    when: "`--max-turns` / `--max-duration` 触发停止",
    stdout: "有事件输出",
    source: { path: 'packages/cli/src/exec/runner.ts', lines: '889', snippet: 'return 3' },
  },
  {
    code: '1',
    meaning: '代理错误',
    when: "运行中出错（模型错误、工具失败等）；stdout 可能已有事件",
    stdout: "可能非空",
    source: { path: 'packages/cli/src/exec/runner.ts', lines: '890', snippet: 'this.errored ? 1 : 0' },
  },
  {
    code: '0',
    meaning: '成功',
    when: "代理正常结束；`result` 事件的 `isError` 为 false",
    stdout: "有事件输出",
    source: { path: 'packages/cli/src/exec/runner.ts', lines: '890', snippet: 'this.errored ? 1 : 0' },
  },
  {
    code: '2',
    meaning: '用法或会话错误',
    when: "参数非法、会话不存在、stdin 格式错误",
    stdout: "**为空**",
    source: { path: 'packages/cli/src/exec/index.ts', lines: '1055', snippet: 'exitCode: 2' },
  },
];
