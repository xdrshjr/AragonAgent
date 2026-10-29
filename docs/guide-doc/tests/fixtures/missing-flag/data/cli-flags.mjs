/**
 * missing-flag fixture：真实 cli-flags 数据 + 一条源码里不存在的幽灵参数。
 *
 * 门禁（check.mjs --model）对文档侧与源码侧双向对账，这条记录只存在于文档侧，
 * 因此必然触发 `doc-not-in-source` ERROR、退出码 3 —— 这就是 AC-4 要证明的
 * 「漂移会让构建失败」。其余数据原样 re-export，避免 fixture 变成第二份真源。
 */

import { cliFlags as realCliFlags } from '../../../../src/content/data/cli-flags.mjs';

export { subcommandFlags } from '../../../../src/content/data/cli-flags.mjs';

/** 源码里没有这条参数；default 与 defaultTextOfSource 对「查不到」的兜底一致。 */
export const phantomFlag = {
  scope: 'root',
  flag: '--definitely-not-a-flag',
  arg: '',
  short: '',
  default: '关',
  defaultOn: false,
  desc: '不存在',
  group: '其他',
  source: {
    path: 'packages/cli/src/cli.tsx',
    lines: '2370-2375',
    snippet: '--print',
  },
};

export const cliFlags = [...realCliFlags, phantomFlag];
