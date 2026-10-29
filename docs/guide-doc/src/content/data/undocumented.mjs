/**
 * 未收录白名单（§8.3）。
 *
 * 规则：**每一条都必须写清「为什么这一项不写进文档」**，否则不允许存在。
 * `check.mjs` 会断言每条的 `name` 确实存在于对应 truth set —— 白名单不能变成垃圾场；
 * 同时断言条数 ≤ 6（阶段 A 的 DoD），膨胀就说明是漏写而不是「不必写」。
 *
 * `set` 取值：`cli-flags` / `exec-flags` / `slash-commands` / `tools` / `exec-events` /
 * `exit-codes` / `config-keys` / `core-exports` / `host-tools`。
 */

/** @typedef {{set: string, name: string, reason: string, owner?: string}} AllowRecord */

/** @type {AllowRecord[]} */
export const undocumented = [
  {
    set: 'host-tools',
    name: 'submit_result',
    reason:
      '宿主专属工具：只有带 `--result-schema` 的 headless 会话才注册它，普通会话与 TUI 里都不存在，' +
      '因此不进「内置工具 19 个」的口径；已由 `exec/host` 与 `appendix/compat` 两页说明',
    owner: 'exec/host（阶段 B）',
  },
];
