/**
 * truth set 的加载层：源文件清单 + 提取。
 *
 * 单独成文件有两个原因：① `gate.mjs` 已经接近 1,000 行硬上限；② 「哪些文件是 truth set 的
 * 来源」这件事必须一眼可读 —— P0-3 的失效模式正是「源清单少两个文件，门禁仍然报绿」，
 * 所以清单单独放，并且每个集合的规模都会被断言 > 0（AC-30）。
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  extractFlags,
  extractSlashCommands,
  extractTools,
  extractHostToolNames,
  extractExecEvents,
  extractExitCodes,
  extractConfigKeys,
  extractCoreExports,
  extractApiExportTable,
  extractVersion,
} from './sources.mjs';
import { REPO_ROOT } from './repo-root.mjs';

/** truth set 的源文件清单（S-4 的两个 Core 文件是 P0-3 的修正）。 */
const SOURCES = {
  cli: 'packages/cli/src/cli.tsx',
  execFlags: 'packages/cli/src/exec/cli-commands.ts',
  builtins: 'packages/cli/src/commands/builtins.ts',
  toolIndex: 'packages/cli/src/tools/index.ts',
  events: 'packages/cli/src/exec/events.ts',
  runner: 'packages/cli/src/exec/runner.ts',
  execIndex: 'packages/cli/src/exec/index.ts',
  schema: 'packages/cli/src/config/schema.ts',
  coreIndex: 'packages/core/src/index.ts',
  apiMd: 'packages/core/API.md',
  cliPkg: 'packages/cli/package.json',
  corePkg: 'packages/core/package.json',
};

/** 工具源文件（S-4：CLI 13 + todo + task + 技能 4，其中 2 个在 Core）。 */
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

/** 命令族模块（S-3 的 7 条）。 */
const FAMILY_SOURCES = [
  ['packages/cli/src/commands/queue-command.ts', 'queue'],
  ['packages/cli/src/commands/kit-command.ts', 'kit'],
  ['packages/cli/src/prompts/command.ts', 'prompts'],
  ['packages/cli/src/commands/agents-command.ts', 'agents'],
  ['packages/cli/src/commands/keys-command.ts', 'keys'],
  ['packages/cli/src/commands/task-command.ts', 'task'],
  // `/team` MOVED OUT OF `builtins.ts` (team-command-forced-dispatch §3.10): the
  // command is registered from its own module now, so a truth set that only
  // scrapes `COMMANDS` would lose the name and report the documented `/team` as
  // "doc has it, source does not" - the failure R-5 records.
  ['packages/cli/src/commands/team-command.ts', 'team'],
  ['packages/cli/src/commands/skills.ts', 'skills'],
];

/**
 * 读取仓库内文件。
 *
 * @param {string} relative 仓库根相对路径
 * @returns {string} 文件内容
 * @throws {Error} 文件不存在
 */
export function readSource(relative) {
  const absolute = path.resolve(REPO_ROOT, relative);
  if (!fs.existsSync(absolute)) {
    throw new Error(`源文件不存在：${relative}（仓库根按 ${REPO_ROOT} 解析）`);
  }
  return fs.readFileSync(absolute, 'utf8');
}

/**
 * 提取 9 个 truth set。
 *
 * @returns {{sets: Object<string, Set<string>>, meta: object}} 集合与附加信息
 */
export function loadTruthSets() {
  const cli = extractFlags(readSource(SOURCES.cli));
  const exec = extractFlags(readSource(SOURCES.execFlags), 'exec');
  const families = FAMILY_SOURCES.map(([file, expectedName]) => ({
    path: file,
    expectedName,
    text: readSource(file),
  }));
  const slash = extractSlashCommands(readSource(SOURCES.builtins), families);
  const toolFiles = TOOL_SOURCES.map((file) => ({ path: file, text: readSource(file) }));
  const toolList = extractTools(toolFiles);
  const hostTools = extractHostToolNames(readSource(SOURCES.toolIndex));
  const events = extractExecEvents(readSource(SOURCES.events));
  const exits = extractExitCodes(readSource(SOURCES.runner), readSource(SOURCES.execIndex));
  const configKeys = extractConfigKeys(readSource(SOURCES.schema));
  const coreExports = extractCoreExports(readSource(SOURCES.coreIndex));
  const apiTable = extractApiExportTable(readSource(SOURCES.apiMd));

  const versions = {
    cli: extractVersion(readSource(SOURCES.cliPkg)),
    core: extractVersion(readSource(SOURCES.corePkg)),
  };
  const sets = {
    'S-1 cli-flags': new Set(cli.flags.map((flag) => `${flag.scope}--${flag.name}`)),
    'S-2 exec-flags': new Set(exec.flags.map((flag) => `--${flag.name}`)),
    'S-3 slash-commands': new Set(slash.filter((item) => !item.missing).map((item) => item.name)),
    'S-4 tools': new Set(toolList.map((item) => item.name)),
    'S-5 exec-events': new Set(events.map((item) => item.type)),
    'S-6 exit-codes': new Set(exits.map((item) => item.code)),
    'S-7 config-keys': new Set(configKeys.filter((item) => !item.key.includes('.')).map((item) => item.key)),
    'S-8 core-exports': new Set([...coreExports.values]),
    'S-9 versions': new Set([versions.cli, versions.core]),
  };
  return {
    sets,
    meta: {
      cli,
      exec,
      slash,
      toolList,
      hostTools,
      events,
      exits,
      configKeys,
      coreExports,
      apiTable,
      versions,
    },
  };
}

/**
 * 递归列出目录下的文件（跳过 node_modules/dist/.git）。
 *
 * @param {string} dir 目录
 * @param {string[]} [out] 累加器
 * @returns {string[]} 绝对路径
 */
export function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * 动态加载内容根下的模块（fixture 测试靠它指向别的内容根）。
 *
 * @param {string} contentRoot 内容根目录
 * @param {string[]} relativeFiles 相对内容根的文件名
 * @returns {Promise<object[]>} 模块导出列表
 */
export async function importContent(contentRoot, relativeFiles) {
  const modules = [];
  for (const relative of relativeFiles) {
    const absolute = path.join(contentRoot, relative);
    if (!fs.existsSync(absolute)) {
      throw new Error(`内容模块缺失：${path.relative(REPO_ROOT, absolute)}`);
    }
    modules.push(await import(`file://${absolute.replace(/\\/g, '/')}`));
  }
  return modules;
}

