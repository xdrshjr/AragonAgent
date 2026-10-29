/**
 * 9 个 truth set 的提取器（spec §8.1，AC-30）。
 *
 * 提取器是**纯函数**（输入源码文本、输出记录），所以本套件用固定片段驱动它们：
 * 片段里的布景精确到行首缩进与注释形态，才能钉住三个已经发生过的回归：
 *   P1-1 注释里的 `.option(` 被当成真声明；
 *   P1-2 跨行的 `.option(\n  '--x',\n  'desc',\n)` 整条漏掉；
 *   P0-3 源文件清单少两个 Core 文件，`skill` / `skill_find` 静默消失。
 *
 * 最后两节跑**真实仓库**，证明 S-4 = 19 且与 `HOST_TOOL_NAMES` 的差异只有
 * 白名单里的 `submit_result`。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  checkReference,
  extractApiExportTable,
  extractConfigKeys,
  extractCoreExports,
  extractExecEvents,
  extractExitCodes,
  extractFlags,
  extractHostToolNames,
  extractOptionDeclarations,
  extractSlashCommands,
  extractTools,
  extractVersion,
  mergeNegatedFlags,
  parseOptionSpec,
} from '../src/extract/sources.mjs';
import { compareSlashDescriptions } from '../src/extract/gate.mjs';
import { REPO_ROOT } from '../src/extract/repo-root.mjs';

/** 把片段变成行数组再拼回字符串，保持测试里的行号可读。 */
const source = (...lines) => lines.join('\n');

/** S-4 的 11 个真实源文件（与 `src/extract/truth-sets.mjs` 的 TOOL_SOURCES 同序）。 */
const TOOL_SOURCES = [
  'packages/cli/src/tools/bash-tool.ts',
  'packages/cli/src/tools/fs-tools.ts',
  'packages/cli/src/tools/search-tools.ts',
  'packages/cli/src/tools/proc-tools.ts',
  'packages/cli/src/tools/job-tools.ts',
  'packages/cli/src/tools/plan-tools.ts',
  'packages/cli/src/todo/todo-tool.ts',
  'packages/cli/src/team/task-tool.ts',
  'packages/cli/src/skills/tools.ts',
  'packages/core/src/skills/skill-tool.ts',
  'packages/core/src/skills/skill-find-tool.ts',
];

/**
 * 读仓库内文件。
 *
 * @param {string} relative 仓库根相对路径（正斜杠）
 * @returns {string} 文件内容
 */
function readRepoFile(relative) {
  return fs.readFileSync(path.resolve(REPO_ROOT, relative), 'utf8');
}

// ---------------------------------------------------------------------------
// S-1 / S-2：Commander `.option(...)`
// ---------------------------------------------------------------------------

test('extractOptionDeclarations：行首 `.option(` 被提取', () => {
  const declarations = extractOptionDeclarations(
    source(
      "program",
      "  .option('--json', '输出 JSON')",
      "  .command('resume')",
      "  .option('--print', '非交互打印')",
    ),
  );
  assert.equal(declarations.length, 2);
  assert.equal(declarations[0].spec, '--json');
  assert.equal(declarations[0].desc, '输出 JSON');
  assert.equal(declarations[0].line, 2);
  assert.equal(declarations[0].scope, 'root');
  assert.deepEqual(declarations[0].longs, ['--json']);
  assert.equal(declarations[1].scope, 'resume', '`.command(` 之后的作用域应切换');
});

test('P1-1 回归：注释里的 `.option(` 不算声明', () => {
  const declarations = extractOptionDeclarations(
    source(
      "program",
      "  // .option('--ghost-in-comment', '不该被提取')",
      "  /* .option('--ghost-in-block', '同样不该') */",
      "  .option('--real', '真的声明')",
    ),
  );
  assert.equal(declarations.length, 1, `只应提取 1 条，实际 ${declarations.length} 条`);
  assert.equal(declarations[0].spec, '--real');
  assert.deepEqual(declarations[0].longs, ['--real']);
});

test('P1-2 回归：跨行 `.option(` 被提取成一条', () => {
  const declarations = extractOptionDeclarations(
    source(
      "program",
      '  .option(',
      "    '--max-tokens <n>',",
      "    '单次输出上限（token）',",
      '  )',
      "  .option('--json', '输出 JSON')",
    ),
  );
  assert.equal(declarations.length, 2, '跨行声明不能被整条漏掉');
  assert.equal(declarations[0].spec, '--max-tokens <n>');
  assert.equal(declarations[0].desc, '单次输出上限（token）');
  assert.equal(declarations[0].line, 2);
  assert.deepEqual(declarations[0].longs, ['--max-tokens']);
  assert.equal(declarations[1].spec, '--json');
});

test('extractFlags：跨行声明的默认值也能读到第三个实参', () => {
  const result = extractFlags(
    source('program', '  .option(', "    '--theme <name>',", "    '主题',", "    'dark',", '  )'),
  );
  assert.equal(result.declarations.length, 1);
  assert.equal(result.declarations[0].defaultValue, 'dark');
  assert.equal(result.flags[0].defaultValue, 'dark');
});

test('mergeNegatedFlags：`--no-color` 没有正名时独立成记录且 defaultOn:false', () => {
  const flags = mergeNegatedFlags(
    extractOptionDeclarations(source('program', "  .option('--no-color', '关闭颜色输出')")),
  );
  assert.equal(flags.length, 1);
  assert.equal(flags[0].name, 'no-color', '没有 --color 时不能归并到不存在的正名');
  assert.equal(flags[0].defaultOn, false);
  assert.equal(flags[0].negatedName, 'no-color');
});

test('mergeNegatedFlags：`--no-compact` 并入存在的 `compact`（一条记录）', () => {
  const flags = mergeNegatedFlags(
    extractOptionDeclarations(
      source(
        'program',
        "  .option('--compact', '开启自动压缩')",
        "  .option('--no-compact', '关闭自动压缩')",
      ),
    ),
  );
  assert.equal(flags.length, 1, `应合并成 1 条，实际 ${flags.length} 条`);
  assert.equal(flags[0].name, 'compact');
  assert.equal(flags[0].defaultOn, false);
  assert.equal(flags[0].negatedName, 'no-compact');
  assert.deepEqual(flags[0].lines, [2, 3], '两条声明的行号都要留在记录里');
});

test('extractFlags：distinctLongNames 统计的是源码里写出来的长名', () => {
  const result = extractFlags(
    source('program', "  .option('--json', 'a')", "  .option('--print', 'b')", "  .option('--no-color', 'c')"),
  );
  assert.equal(result.distinctLongNames, 3);
  assert.equal(result.flags.length, 3);
});

test('parseOptionSpec：拆出长名、取值占位与短名', () => {
  assert.deepEqual(parseOptionSpec('-p, --print'), { name: 'print', arg: null, short: 'p' });
  assert.deepEqual(parseOptionSpec('--resume <id|path>'), { name: 'resume', arg: 'id|path', short: null });
  assert.deepEqual(parseOptionSpec('-m, --model <name>'), { name: 'model', arg: 'name', short: 'm' });
  assert.deepEqual(parseOptionSpec('--pairs [k=v]'), { name: 'pairs', arg: 'k=v', short: null });
  assert.deepEqual(parseOptionSpec(''), { name: '', arg: null, short: null });
});

// ---------------------------------------------------------------------------
// S-3 / S-4
// ---------------------------------------------------------------------------

test('extractSlashCommands：读 COMMANDS 数组并保留别名与描述', () => {
  const records = extractSlashCommands(
    source(
      'const COMMANDS: SlashCommand[] = [',
      '  {',
      "    name: 'model',",
      "    description: '切换模型',",
      "    aliases: ['m'],",
      '  },',
      '];',
      "const other = { name: 'not-in-array' };",
    ),
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].name, 'model');
  assert.deepEqual(records[0].aliases, ['m']);
  assert.equal(records[0].desc, '切换模型');
  assert.equal(records[0].kind, 'builtin');
});

test('extractSlashCommands：描述换行书写、以及 `+` 续行，都要读成完整一句', () => {
  const records = extractSlashCommands(
    source(
      'const COMMANDS: SlashCommand[] = [',
      '  {',
      "    name: 'team',",
      '    description:',
      "      'Team subagents: status | on | off | max <n> | ' +",
      "        'overseer on|off',",
      '  },',
      '  {',
      "    name: 'exit',",
      '    description:',
      "      'Exit',",
      '  },',
      '];',
    ),
  );
  assert.equal(records.length, 2);
  // 换行 + 续行：两段必须拼起来，而不是留空串或只留前半句。
  assert.equal(records[0].desc, 'Team subagents: status | on | off | max <n> | overseer on|off');
  // 换行但只有一段：同样要读到，不能被当成「没有 description」。
  assert.equal(records[1].desc, 'Exit');
});

test('compareSlashDescriptions：空说明与改过的说明都是 ERROR 级发现', () => {
  const sourceRecords = [
    { name: 'team', desc: 'Team subagents: status | on', kind: 'builtin' },
    { name: 'exit', desc: 'Exit', kind: 'builtin' },
    { name: 'gone', desc: 'x', kind: 'family', missing: true },
  ];
  assert.deepEqual(
    compareSlashDescriptions(
      [
        { name: 'team', desc: '' },
        { name: 'exit', desc: 'Quit' },
        { name: 'gone', desc: '' },
      ],
      sourceRecords,
    ).map((finding) => finding.code),
    ['slash-desc-empty', 'slash-desc-mismatch'],
    '空说明与错说明各报一条；missing 的家族命令不参与对账',
  );
  assert.deepEqual(
    compareSlashDescriptions([{ name: 'exit', desc: 'Exit' }], sourceRecords),
    [],
    '一致时必须返回空数组，否则这条断言永远不会红',
  );
});

test('extractSlashCommands：家族模块按期望名查找，找不到就记 missing', () => {
  const found = extractSlashCommands('', [
    { path: 'packages/cli/src/commands/queue-command.ts', expectedName: 'queue', text: "const cmd = { name: 'queue', help: '队列' };" },
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'queue');
  assert.equal(found[0].kind, 'family');
  assert.equal(found[0].desc, '队列');

  const missing = extractSlashCommands('', [
    { path: 'packages/cli/src/commands/gone-command.ts', expectedName: 'gone', text: 'export const nothing = 1;' },
  ]);
  assert.equal(missing[0].missing, true, '扫不到必须报 missing，不能静默少一条');
});

test('extractHostToolNames：只认数组里行首的引号项', () => {
  const names = extractHostToolNames(
    source(
      'export const HOST_TOOL_NAMES = [',
      "  'bash',",
      "  // 'not_a_tool',",
      "  'read_file',",
      "  'skill', // 行尾注释的项不算（形态不符）",
      '];',
      "const OTHER = ['ghost'];",
    ),
  );
  assert.deepEqual([...names], ['bash', 'read_file']);
});

test('extractTools：只认行首锚定的 `name: \'...\'`', () => {
  const records = extractTools([
    {
      path: 'synthetic.ts',
      text: source(
        'const tool = {',
        "  name: 'read_file',",
        '};',
        "// name: 'ghost_in_comment',",
        'const label = "name: \'ghost_in_string\'";',
        "  name: 'write_file'",
        '}',
      ),
    },
  ]);
  assert.deepEqual(records.map((item) => item.name), ['read_file', 'write_file']);
  assert.equal(records[0].line, 2);
  assert.equal(records[0].file, 'synthetic.ts');
});

// ---------------------------------------------------------------------------
// S-5 ~ S-9
// ---------------------------------------------------------------------------

test('extractExecEvents：联合成员按顺序映射到接口的 type 字面量', () => {
  const records = extractExecEvents(
    source(
      'export type ExecEvent =',
      '  | ExecTextDeltaEvent',
      '  | ExecApprovalRequestEvent',
      '  | ExecDoneEvent;',
      '',
      '/** 文本增量 */',
      'export interface ExecTextDeltaEvent {',
      "  type: 'text_delta';",
      '}',
      // subtype 必须在 `type` 之前才会被读到：提取循环在取到 `type` 的那一行就 break
      // （见下面「真实 events.ts 的 subtype 读不到」那条断言）。
      'export interface ExecApprovalRequestEvent {',
      "  subtype: 'tool';",
      "  type: 'approval_request';",
      '}',
      'export interface ExecDoneEvent {',
      "  type: 'done';",
      '}',
    ),
  );
  assert.deepEqual(records.map((item) => item.name), [
    'ExecTextDeltaEvent',
    'ExecApprovalRequestEvent',
    'ExecDoneEvent',
  ]);
  assert.deepEqual(records.map((item) => item.type), ['text_delta', 'approval_request', 'done']);
  assert.equal(records[1].subtype, 'tool');
  assert.equal(records[0].doc, '文本增量');
});

test('真实 events.ts：`subtype` 与 `type` 的声明顺序无关，两个都会被读到', () => {
  // 回归点：早先的实现一取到 `type` 就 break，导致 subtype 永远是 null ——
  // 而 `ExecSystemInitEvent` 恰好是 `type: 'system';` 紧跟 `subtype: 'init';` 的写法，
  // 于是 `system/init` 这个最重要的事件在文档里看不到自己的 subtype。
  // S-5 的 truth set 只对账 `type`，所以门禁不会因此变红：这正是需要单测盯住它的原因。
  const records = extractExecEvents(readRepoFile('packages/cli/src/exec/events.ts'));
  const init = records.find((item) => item.name === 'ExecSystemInitEvent');
  assert.ok(init, 'ExecSystemInitEvent 应出现在 S-5 里');
  assert.equal(init.type, 'system');
  assert.equal(init.subtype, 'init', 'subtype 声明在 type 之后也必须读到');
});

test('extractExitCodes：从 runner 与 exec index 两处取值', () => {
  const records = extractExitCodes(
    source(
      'export class Runner {',
      '  exitCode(): number {',
      '    if (this.interrupted) return 128 + signo;',
      '    if (this.usageError) return 3;',
      '    return this.errored ? 1 : 0;',
      '  }',
      '}',
    ),
    source('const result = {', '  exitCode: 2,', '};'),
  );
  assert.deepEqual(records.map((item) => item.code), ['128 + signo', '3', '1', '0', '2']);
  assert.equal(records[4].file, 'packages/cli/src/exec/index.ts');
});

test('extractConfigKeys：只收 depth-1 键，并带上紧邻的前置注释', () => {
  const records = extractConfigKeys(
    source(
      'export const DEFAULT_CONFIG = {',
      '  /** 默认模型 */',
      "  model: 'default',",
      '  nested: {',
      '    inner: 1,',
      '    deeper: { hidden: true },',
      '  },',
      "  theme: 'dark',",
      '};',
    ),
  );
  assert.deepEqual(records.map((item) => item.key), [
    'model',
    'nested',
    'nested.inner',
    'nested.deeper',
    'theme',
  ]);
  assert.equal(records[0].doc, '默认模型');
  assert.equal(records[1].value, '{ … }');
  assert.equal(records[3].value, '{ hidden: true }');
  assert.equal(records[4].value, "'dark'");
});

test('extractCoreExports：`export type {` 进 types，值导出入 values，注释被剥掉', () => {
  const { values, types } = extractCoreExports(
    source(
      'export {',
      '  Agent,',
      '  withRetry as retry, // 运行时导出，别名取右侧',
      '} from \'./agent/index.js\';',
      "export type { AgentConfig, ToolSpec } from './types.js';",
      "export const VERSION = '1';",
      'export class ToolRegistry {}',
    ),
  );
  assert.deepEqual([...values], ['Agent', 'retry', 'VERSION', 'ToolRegistry']);
  assert.deepEqual([...types], ['AgentConfig', 'ToolSpec']);
});

test('extractApiExportTable：解析 API.md 的运行时导出表', () => {
  const records = extractApiExportTable(
    source(
      '## Runtime (value) exports',
      '',
      '| 名称 | 类型 | 子路径 | 用途 |',
      '|---|---|---|---|',
      '| `Agent` | class | 根 | 主运行时 |',
      '| `withRetry` | function | `./llm/types` | 重试封装 |',
      '',
      '## Type exports',
      '| `Hidden` | type | 根 | 不该被收进运行时表 |',
    ),
  );
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((item) => ({ name: item.name, kind: item.kind, subpath: item.subpath, purpose: item.purpose })),
    [
      { name: 'Agent', kind: 'class', subpath: '根', purpose: '主运行时' },
      { name: 'withRetry', kind: 'function', subpath: '`./llm/types`', purpose: '重试封装' },
    ],
  );
  assert.equal(records[0].line, 5);
});

test('extractVersion：解析 package.json 的 version 字段', () => {
  assert.equal(extractVersion(source('{', '  "name": "x",', '  "version": "1.2.3"', '}')), '1.2.3');
  assert.throws(() => extractVersion('not json'), /JSON/);
});

// ---------------------------------------------------------------------------
// P0-3 回归：真实仓库
// ---------------------------------------------------------------------------

test('P0-3 回归：真实仓库的 S-4 有 19 个工具，含 skill 与 skill_find', () => {
  const records = extractTools(
    TOOL_SOURCES.map((relative) => ({ path: relative, text: readRepoFile(relative) })),
  );
  const names = records.map((item) => item.name);
  assert.equal(TOOL_SOURCES.length, 11, 'S-4 的源文件清单必须是 11 个（P0-3 少过两个）');
  assert.equal(names.length, 19, `S-4 应是 19 条，实际 ${names.length} 条：${names.join(', ')}`);
  assert.equal(new Set(names).size, 19, '19 条记录之间不应重名');
  for (const required of ['skill', 'skill_find']) {
    assert.ok(names.includes(required), `S-4 必须含 ${required}（只在 Core 的两个文件里声明）`);
  }
});

test('P0-3 回归：S-4 与 HOST_TOOL_NAMES 的差集恰好是白名单里的 submit_result', () => {
  const toolNames = new Set(
    extractTools(TOOL_SOURCES.map((relative) => ({ path: relative, text: readRepoFile(relative) }))).map(
      (item) => item.name,
    ),
  );
  const hostTools = extractHostToolNames(readRepoFile('packages/cli/src/tools/index.ts'));
  assert.ok(hostTools.size > 0, 'HOST_TOOL_NAMES 不应为空');

  // 文档侧多出来的工具：一个都不能有（否则是「文档记录了源码里不存在的工具」）。
  const documentedButNotHost = [...toolNames].filter((name) => !hostTools.has(name));
  assert.deepEqual(documentedButNotHost, [], 'S-4 里的每个工具都必须能注册进宿主');

  // 宿主多出来的工具：恰好一个，且是 `undocumented.mjs` 白名单里的 `submit_result`。
  // 这不是漂移，而是**有意为之**的差异：submit_result 由宿主注入、不在 CLI 的工具
  // 声明里，所以 S-4 提取不到它。白名单条目就是这条事实的唯一记录点。
  const hostButNotDocumented = [...hostTools].filter((name) => !toolNames.has(name));
  assert.deepEqual(hostButNotDocumented, ['submit_result']);
});

test('真实仓库：mergeNegatedFlags 对 cli.tsx 不产生「有文档无源码」的假正名', () => {
  const { flags } = extractFlags(readRepoFile('packages/cli/src/cli.tsx'));
  assert.ok(flags.length > 0);
  for (const flag of flags) {
    assert.ok(flag.name, '每条记录都要有名字');
    assert.equal(typeof flag.defaultOn, 'boolean');
    if (flag.negatedName && flag.name !== flag.negatedName) {
      assert.equal(flag.defaultOn, false, `${flag.name} 有 --no- 形态，defaultOn 必须是 false`);
    }
  }
});

test('checkReference：真实文件里的真实区间是 ok', () => {
  const text = readRepoFile('packages/cli/package.json');
  const verdict = checkReference({ text, lines: '1-3', snippet: '"name"' });
  assert.equal(verdict.status, 'ok');
});
