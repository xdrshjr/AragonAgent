/**
 * 9 个 truth set 的提取器（§8.1）。
 *
 * 全部是**纯函数**：输入源码文本，输出集合/记录。文件读取发生在 `check.mjs`/`build.mjs`
 * 两个入口里（§4.1 纪律），因此本文件可以被单测用固定片段直接驱动，不需要临时文件。
 *
 * 每条规则都穷尽于「源码里真实写出来的声明」，不做猜测式补全 —— 门禁的价值在于
 * 「文档记录的项必须能在源码里指出位置」，猜出来的项无法被指出。
 */

/** 允许出现在参数声明里的长名形态。 */
const LONG_NAME = /--[a-z0-9][a-z0-9-]*/g;

/**
 * @typedef {Object} OptionDeclaration
 * @property {number} line 声明起始行（1-based）
 * @property {string} scope 作用域：`'root'` 或子命令名
 * @property {string} spec 参数字面量，如 `'--lines <n>'`
 * @property {string} desc 描述字面量（源码原文）
 * @property {string|null} defaultValue 第三个实参（默认值），没有则为 `null`
 * @property {string[]} longs 该声明里的全部长名
 * @property {boolean} negated 是否 `--no-*` 形态
 */

/**
 * 收集 Commander 链式 `.option(...)` 声明（**行首锚定**，注释内的不算）。
 *
 * 支持跨行写法：`.option(` 之后的第一段引号字符串就是参数字面量（v1 只认单行，
 * 漏掉了 `cli.tsx` 里 7 处跨行声明）。
 *
 * @param {string} source cli.tsx 或 exec/cli-commands.ts 的源码
 * @returns {OptionDeclaration[]} 按源码顺序的声明
 */
export function extractOptionDeclarations(source) {
  const lines = String(source || '').split(/\r?\n/);
  const declarations = [];
  let scope = 'root';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const command = line.match(/^\s*\.command\(\s*['"]([^'"]+)['"]/);
    if (command) scope = command[1].split(/[\s[]/)[0];
    if (!/^\s*\.option\(/.test(line)) continue;
    const collected = collectCall(lines, index);
    const parsed = parseOptionCall(collected.text);
    if (!parsed) continue;
    declarations.push({
      line: index + 1,
      scope,
      spec: parsed.spec,
      desc: parsed.desc,
      defaultValue: parsed.defaultValue,
      longs: parsed.spec.match(LONG_NAME) || [],
      negated: /--no-[a-z0-9-]+/.test(parsed.spec),
    });
    index = collected.endLine;
  }
  return declarations;
}

/**
 * 从 `index` 起收集一个 `.option(` 调用（括号配平，最多 12 行）。
 *
 * @param {string[]} lines 源码行
 * @param {number} index 起始行下标
 * @returns {{text: string, endLine: number}} 调用文本与结束行下标
 */
function collectCall(lines, index) {
  let depth = 0;
  let text = '';
  let line = index;
  for (; line < lines.length && line < index + 12; line += 1) {
    text += `${lines[line]}\n`;
    for (const char of lines[line]) {
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
    }
    if (depth <= 0) break;
  }
  return { text, endLine: Math.min(line, lines.length - 1) };
}

/**
 * 解析一个 `.option(...)` 调用：参数字面量、描述字面量、可选默认值。
 *
 * @param {string} text 调用文本
 * @returns {{spec: string, desc: string, defaultValue: string|null}|null} 解析结果
 */
function parseOptionCall(text) {
  const literals = [];
  const re = /(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
  let match = re.exec(text);
  while (match) {
    literals.push(match[2]);
    match = re.exec(text);
  }
  if (literals.length === 0) return null;
  return {
    spec: literals[0],
    desc: literals[1] || '',
    defaultValue: literals.length > 2 ? literals[2] : null,
  };
}

/**
 * 把一个参数字面量拆成结构化字段。
 *
 * @param {string} spec 参数字面量，如 `'-p, --print'` 或 `'--resume <id|path>'`
 * @returns {{name: string, arg: string|null, short: string|null}} 拆解结果
 */
export function parseOptionSpec(spec) {
  const text = String(spec || '');
  const shortMatch = text.match(/(^|[\s,])-([A-Za-z])(,|\s|$)/);
  const longMatch = text.match(LONG_NAME);
  const argMatch = text.match(/[<[]([^>\]]+)[>\]]/);
  return {
    name: longMatch ? longMatch[0].replace(/^--/, '') : '',
    arg: argMatch ? argMatch[1].trim() : null,
    short: shortMatch ? shortMatch[2] : null,
  };
}

/**
 * 把 `--no-x` 与同作用域的 `--x` 合并成一条记录（§8.1.1 规则 1）。
 *
 * 没有正名的 `--no-*`（`--no-color` 等）保留原名单独成行并标 `defaultOn: true`
 * —— v1 把它们归并到不存在的 `--color`，会产生「文档有、源码无」的假 ERROR。
 *
 * @param {OptionDeclaration[]} declarations 声明列表
 * @returns {{scope: string, name: string, arg: string|null, short: string|null,
 *   desc: string, defaultOn: boolean, defaultValue: string|null,
 *   line: number, lines: number[], negatedName: string|null}[]} 合并后的记录
 */
export function mergeNegatedFlags(declarations) {
  /** @type {Map<string, object>} */
  const byKey = new Map();
  for (const declaration of declarations) {
    const parsed = parseOptionSpec(declaration.spec);
    const isNegated = parsed.name.startsWith('no-');
    const baseName = isNegated ? parsed.name.slice(3) : parsed.name;
    const positiveExists = declarations.some((other) => {
      if (other.scope !== declaration.scope) return false;
      const otherParsed = parseOptionSpec(other.spec);
      return otherParsed.name === baseName;
    });
    const name = isNegated && !positiveExists ? parsed.name : baseName;
    const key = `${declaration.scope}\u0000${name}`;
    const existing = byKey.get(key);
    const defaultOn = isNegated ? false : true;
    if (existing) {
      existing.lines.push(declaration.line);
      if (isNegated) {
        existing.defaultOn = false;
        existing.negatedName = parsed.name;
      }
      continue;
    }
    byKey.set(key, {
      scope: declaration.scope,
      name,
      arg: parsed.arg,
      short: parsed.short,
      desc: declaration.desc,
      defaultOn,
      defaultValue: declaration.defaultValue,
      line: declaration.line,
      lines: [declaration.line],
      negatedName: isNegated ? parsed.name : null,
    });
  }
  return [...byKey.values()];
}

/**
 * S-1 / S-2：CLI 参数与 exec 参数的提取（同一规则）。
 *
 * @param {string} source `cli.tsx` 或 `cli-commands.ts` 的源码
 * @param {string} [scopeHint] 当源码没有 `.command(` 时使用的默认作用域
 * @returns {{declarations: OptionDeclaration[], flags: object[], distinctLongNames: number}}
 *   声明、合并后的记录与不同长名数
 */
export function extractFlags(source, scopeHint) {
  let declarations = extractOptionDeclarations(source);
  if (scopeHint && declarations.every((item) => item.scope === 'root')) {
    declarations = declarations.map((item) => ({ ...item, scope: scopeHint }));
  }
  const flags = mergeNegatedFlags(declarations);
  const distinct = new Set();
  for (const declaration of declarations) {
    for (const long of declaration.longs) distinct.add(long);
  }
  return { declarations, flags, distinctLongNames: distinct.size };
}

/**
 * 读取 `description:` 并返回它跨行拼接后的**完整**字面量。
 *
 * WHY 需要拼接：描述有两种写法 —— 一种把字面量放在 `description:` 同一行，另一种
 * 让它换行再来；长描述还会用 `' … ' +` 续行。只读 `name:` 的下一行、且要求字面量
 * 同行收尾，会在这三种写法的后两种上返回空串。空串在页面上是一个空单元格，而门禁
 * 只比对命令名，所以它既不红也不响 —— 「报绿但少扫」的经典形态。
 *
 * @param {string[]} lines 源码行
 * @param {number} start 开始探测的下标（通常是 `name:` 的下一行）
 * @param {number} limit 探测上界
 * @returns {string} 描述原文；找不到 `description:` 时返回空串
 */
function readJoinedDescription(lines, start, limit) {
  for (let index = start; index < Math.min(start + 6, limit); index += 1) {
    const head = /^\s*description:\s*(.*)$/.exec(lines[index] || '');
    if (!head) continue;
    let probe = index;
    let remainder = head[1];
    if (remainder === '') {
      probe += 1;
      remainder = (lines[probe] || '').trim();
    }
    const first = /^'((?:[^'\\]|\\.)*)'/.exec(remainder);
    if (!first) return '';
    let text = first[1];
    while (/'\s*\+$/.test(lines[probe] || '') && probe + 1 < limit) {
      probe += 1;
      const next = /^\s*'((?:[^'\\]|\\.)*)'/.exec(lines[probe] || '');
      if (!next) break;
      text += next[1];
    }
    return text;
  }
  return '';
}

/**
 * @typedef {Object} SlashCommandRecord
 * @property {string} name 命令名（不带斜杠）
 * @property {string[]} aliases 别名
 * @property {string} desc 源码描述
 * @property {number} line 行号（1-based）
 * @property {string} file 来源文件
 * @property {'builtin'|'family'} kind 来源类别
 */

/**
 * S-3：斜杠命令 —— `COMMANDS` 数组（30 条）+ 7 条独立注册的命令族。
 *
 * 家族模块的写法并不统一（有的 `{ name: 'queue' }` 单行，有的多行对象），
 * 所以调用方可以为每个文件给出**期望名**（`expectedName`，取自文件名）。
 * 找到就返回，找不到就记一条 `missing: true` 的记录 —— 宁可报错，也不静默少扫
 * 一个文件（P0-3 的教训）。
 *
 * @param {string} builtinsSource `commands/builtins.ts` 源码
 * @param {{path: string, text: string, expectedName?: string}[]} familySources 家族命令模块
 * @returns {(SlashCommandRecord & {missing?: boolean})[]} 全部命令
 */
export function extractSlashCommands(builtinsSource, familySources = []) {
  const lines = String(builtinsSource || '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^const COMMANDS: SlashCommand\[\]/.test(line));
  const end = lines.findIndex((line, index) => index > start && /^];/.test(line));
  const records = [];
  const limit = end > start ? end : lines.length;
  for (let index = Math.max(start, 0); index < limit; index += 1) {
    const nameMatch = lines[index].match(/^\s*name: '([a-z0-9-]+)',/);
    if (!nameMatch) continue;
    const descMatch = readJoinedDescription(lines, index + 1, limit);
    let aliases = [];
    for (let probe = index; probe < Math.min(index + 8, limit); probe += 1) {
      const aliasMatch = lines[probe].match(/^\s*aliases: \[([^\]]*)\]/);
      if (aliasMatch) {
        aliases = [...aliasMatch[1].matchAll(/'([a-z0-9-]+)'/g)].map((item) => item[1]);
        break;
      }
    }
    records.push({
      name: nameMatch[1],
      aliases,
      desc: descMatch,
      line: index + 1,
      file: 'packages/cli/src/commands/builtins.ts',
      kind: 'builtin',
    });
  }
  for (const family of familySources) {
    const familyText = String(family.text || '');
    const familyLines = familyText.split(/\r?\n/);
    const expected = family.expectedName;
    const pattern = expected
      ? new RegExp(`name: '${expected}'`)
      : /^\s*name: '([a-z0-9-]+)',/;
    let foundLine = -1;
    let foundName = null;
    if (expected) {
      for (let index = 0; index < familyLines.length; index += 1) {
        if (pattern.test(familyLines[index])) {
          foundLine = index;
          foundName = expected;
          break;
        }
      }
    } else {
      for (let index = 0; index < familyLines.length; index += 1) {
        const match = familyLines[index].match(pattern);
        if (match) {
          foundLine = index;
          foundName = match[1];
          break;
        }
      }
    }
    if (foundName === null) {
      records.push({
        name: expected || family.path,
        aliases: [],
        desc: '',
        line: 1,
        file: family.path,
        kind: 'family',
        missing: true,
      });
      continue;
    }
    const nearby = familyLines.slice(foundLine, foundLine + 5).join(' ');
    const descMatch = nearby.match(/(?:description|help|summary): '((?:[^'\\]|\\.)*)'/);
    records.push({
      name: foundName,
      aliases: [],
      desc: descMatch ? descMatch[1] : '',
      line: foundLine + 1,
      file: family.path,
      kind: 'family',
    });
  }
  return records;
}

/**
 * S-4：内置工具名（`name: '<snake>'`，行首锚定）。
 *
 * @param {{path: string, text: string}[]} sources 工具源文件
 * @returns {{name: string, file: string, line: number}[]} 工具记录
 */
export function extractTools(sources) {
  const records = [];
  for (const source of sources) {
    const lines = String(source.text || '').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(/^\s*name: '([a-z][a-z0-9_]*)',?\s*$/);
      if (!match) continue;
      records.push({ name: match[1], file: source.path, line: index + 1 });
    }
  }
  return records;
}

/**
 * S-4 的第二来源：`tools/index.ts` 的 `HOST_TOOL_NAMES` 数组。
 *
 * @param {string} indexSource `packages/cli/src/tools/index.ts` 源码
 * @returns {Set<string>} 宿主可注册的工具名全集
 */
export function extractHostToolNames(indexSource) {
  const lines = String(indexSource || '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^export const HOST_TOOL_NAMES/.test(line));
  const names = new Set();
  if (start < 0) return names;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\];/.test(lines[index])) break;
    const match = lines[index].match(/^\s*'([a-z_]+)',\s*$/);
    if (match) names.add(match[1]);
  }
  return names;
}

/**
 * @typedef {Object} ExecEventRecord
 * @property {string} name 联合成员名，如 `ExecTextDeltaEvent`
 * @property {string} type `type` 字面量
 * @property {string|null} subtype `subtype` 字面量
 * @property {number} line 接口起始行
 * @property {string} doc 接口前的文档注释（首行）
 */

/**
 * S-5：`ExecEvent` 联合 → 各接口的 `type`（+ `subtype`）字面量。
 *
 * @param {string} source `exec/events.ts` 源码
 * @returns {ExecEventRecord[]} 事件记录
 */
export function extractExecEvents(source) {
  const lines = String(source || '').split(/\r?\n/);
  const unionStart = lines.findIndex((line) => /^export type ExecEvent\b/.test(line));
  if (unionStart < 0) return [];
  const members = [];
  for (let index = unionStart + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*\|\s*(\w+)/);
    if (!match) break;
    members.push(match[1]);
  }
  const records = [];
  for (const name of members) {
    const start = lines.findIndex((line) =>
      new RegExp(`^export interface ${name}\\b`).test(line));
    if (start < 0) continue;
    let type = null;
    let subtype = null;
    for (let index = start; index < Math.min(start + 60, lines.length); index += 1) {
      // `type` 与 `subtype` 的顺序不固定（有的接口 subtype 在前，有的在后），
      // 所以两个都扫，不能一见到 `type` 就 break —— 否则 subtype 永远是 null。
      if (!type) {
        const typeMatch = lines[index].match(/^\s{2}type: '([^']+)';?/);
        if (typeMatch) type = typeMatch[1];
      }
      if (!subtype) {
        const subMatch = lines[index].match(/^\s{2}subtype\??: '([^']+)';?/);
        if (subMatch) subtype = subMatch[1];
      }
      if (type && subtype) break;
    }
    records.push({ name, type: type || '', subtype, line: start + 1, doc: docLineBefore(lines, start) });
  }
  return records;
}

/**
 * 取某行之前的文档注释首行（用于事件与配置键的「说明」）。
 *
 * @param {string[]} lines 源码行
 * @param {number} index 目标行下标
 * @returns {string} 注释首行（去掉 `/**`、`*` 等记号）；没有注释返回空串
 */
function docLineBefore(lines, index) {
  const buffer = [];
  for (let probe = index - 1; probe >= 0 && probe > index - 40; probe -= 1) {
    const line = lines[probe].trim();
    if (line === '') continue;
    if (line.startsWith('/**') || line.startsWith('*') || line.startsWith('/*') || line.endsWith('*/')) {
      buffer.unshift(line);
      if (line.startsWith('/**') || line.startsWith('/*')) break;
      continue;
    }
    break;
  }
  if (buffer.length === 0) return '';
  const text = buffer
    .join(' ')
    .replace(/\/\*\*?|\*\//g, ' ')
    .replace(/(^|\s)\*\s?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

/**
 * S-6：退出码（5 档）。
 *
 * @param {string} runnerSource `exec/runner.ts` 源码
 * @param {string} indexSource `exec/index.ts` 源码
 * @returns {{code: string, line: number, file: string}[]} 退出码记录
 */
export function extractExitCodes(runnerSource, indexSource) {
  const records = [];
  const runnerLines = String(runnerSource || '').split(/\r?\n/);
  const start = runnerLines.findIndex((line) => /^\s{2}exitCode\(\): number \{/.test(line));
  if (start >= 0) {
    for (let index = start; index < Math.min(start + 12, runnerLines.length); index += 1) {
      const line = runnerLines[index];
      if (/interrupted/.test(line)) {
        records.push({ code: '128 + signo', line: index + 1, file: 'packages/cli/src/exec/runner.ts' });
      } else if (/return 3;/.test(line)) {
        records.push({ code: '3', line: index + 1, file: 'packages/cli/src/exec/runner.ts' });
      } else if (/return this\.errored \? 1 : 0;/.test(line)) {
        records.push({ code: '1', line: index + 1, file: 'packages/cli/src/exec/runner.ts' });
        records.push({ code: '0', line: index + 1, file: 'packages/cli/src/exec/runner.ts' });
      }
      if (/^\s{2}\}/.test(line) && index > start) break;
    }
  }
  const indexLines = String(indexSource || '').split(/\r?\n/);
  const usageLine = indexLines.findIndex((line) => /exitCode: 2,/.test(line));
  if (usageLine >= 0) records.push({ code: '2', line: usageLine + 1, file: 'packages/cli/src/exec/index.ts' });
  return records;
}

/**
 * @typedef {Object} ConfigKeyRecord
 * @property {string} key 键名（嵌套用 `a.b`）
 * @property {string} value 默认值字面量（源码原文）
 * @property {number} line 行号
 * @property {string} doc 最近的前置注释
 */

/**
 * S-7：`DEFAULT_CONFIG` 的顶层键 + 一层嵌套键。
 *
 * @param {string} source `config/schema.ts` 源码
 * @returns {ConfigKeyRecord[]} 配置键记录
 */
export function extractConfigKeys(source) {
  const lines = String(source || '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^export const DEFAULT_CONFIG\b/.test(line));
  if (start < 0) return [];
  const records = [];
  let depth = 0;
  let lastTopKey = null;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    const before = depth;
    for (const char of line) {
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
    }
    const keyMatch = line.match(/^(\s+)([A-Za-z_][\w]*): (.+?),?$/);
    if (keyMatch) {
      const level = before;
      if (level === 1) {
        lastTopKey = keyMatch[2];
        const isGroup = /\{\s*$/.test(keyMatch[3]) || keyMatch[3].trim() === '{';
        records.push({
          key: keyMatch[2],
          value: isGroup ? '{ … }' : keyMatch[3].replace(/,$/, ''),
          line: index + 1,
          doc: docLineBefore(lines, index),
        });
      } else if (level === 2 && lastTopKey) {
        records.push({
          key: `${lastTopKey}.${keyMatch[2]}`,
          value: keyMatch[3].replace(/,$/, ''),
          line: index + 1,
          doc: docLineBefore(lines, index),
        });
      }
    }
    if (depth <= 0 && index > start) break;
  }
  return records;
}

/**
 * S-8：`packages/core/src/index.ts` 的值导出与类型导出。
 *
 * @param {string} source `src/index.ts` 源码
 * @returns {{values: Set<string>, types: Set<string>}} 两个集合
 */
export function extractCoreExports(source) {
  const text = String(source || '');
  const values = new Set();
  const types = new Set();
  const statements = text.match(/export (?:type )?\{[\s\S]*?\} from '[^']+';|export (?:const|class|function) [A-Za-z_$][\w$]*/g) || [];
  for (const statement of statements) {
    if (statement.startsWith('export type {')) {
      for (const name of braceNames(statement)) types.add(name);
      continue;
    }
    const braceMatch = statement.match(/\{([\s\S]*)\}/);
    if (braceMatch) {
      for (const name of braceNames(statement)) values.add(name);
      continue;
    }
    const declMatch = statement.match(/^export (?:const|class|function) ([A-Za-z_$][\w$]*)/);
    if (declMatch) values.add(declMatch[1]);
  }
  return { values, types };
}

/**
 * 解析 `export { A, B as C }` 里的导出名（别名取右边的名字）。
 *
 * @param {string} statement 一条导出语句
 * @returns {string[]} 导出名
 */
function braceNames(statement) {
  const braceMatch = statement.match(/\{([\s\S]*)\}/);
  if (!braceMatch) return [];
  // 注释里会出现逗号与括号，先按行去掉 `//` 之后的内容，否则名字会被注释粘走
  // （`CHARS_PER_TOKEN` / `SKILL_CATALOG_MAX_BYTES` 就是这样被漏掉的）。
  const body = braceMatch[1]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  return body
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const alias = item.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      if (alias) return alias[1];
      return item.replace(/^type\s+/, '').trim();
    })
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

/**
 * S-8 的第二来源：`packages/core/API.md` 的运行时导出表。
 *
 * @param {string} source API.md 全文
 * @returns {{name: string, kind: string, subpath: string, purpose: string, line: number}[]}
 *   导出记录（含用途，可直接作为 `api-exports` 数据集的来源）
 */
export function extractApiExportTable(source) {
  const lines = String(source || '').split(/\r?\n/);
  const records = [];
  let inside = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^## Runtime \(value\) exports/.test(line)) {
      inside = true;
      continue;
    }
    if (inside && /^## /.test(line)) break;
    if (!inside) continue;
    const match = line.match(/^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|$/);
    if (!match) continue;
    records.push({
      name: match[1],
      kind: match[2],
      subpath: match[3],
      purpose: match[4],
      line: index + 1,
    });
  }
  return records;
}

/**
 * S-9：版本号（纯函数版，供测试用）。
 *
 * @param {string} packageJsonText `package.json` 文本
 * @returns {string} 版本号
 */
export function extractVersion(packageJsonText) {
  return JSON.parse(packageJsonText).version;
}

/**
 * 一条引用的漂移判定（§8.4 的三级规则）。
 *
 * @param {object} params 参数
 * @param {string} params.text 被引用文件的全文
 * @param {string} params.lines `'120-168'` 或 `'42'`
 * @param {string} [params.snippet] 稳定子串
 * @returns {{status: 'ok'|'moved'|'missing'|'out-of-range'|'bad-range', newLines?: string}}
 *   判定结果；`moved` 附带新位置
 */
export function checkReference({ text, lines, snippet }) {
  const all = String(text || '').split(/\r?\n/);
  const [startText, endText] = String(lines || '').split('-');
  const start = Number(startText);
  const end = endText === undefined ? start : Number(endText);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return { status: 'bad-range' };
  if (start > end) return { status: 'bad-range' };
  if (start < 1 || end > all.length) return { status: 'out-of-range' };
  if (!snippet) return { status: 'ok' };
  const range = all.slice(start - 1, end).join('\n');
  if (range.includes(snippet)) return { status: 'ok' };
  const from = Math.max(0, start - 31);
  const to = Math.min(all.length, end + 30);
  const wide = all.slice(from, to);
  for (let offset = 0; offset < wide.length; offset += 1) {
    const candidate = wide.slice(offset, offset + snippet.split('\n').length).join('\n');
    if (candidate.includes(snippet)) {
      const newStart = from + offset + 1;
      const newEnd = newStart + snippet.split('\n').length - 1;
      return { status: 'moved', newLines: newStart === newEnd ? String(newStart) : `${newStart}-${newEnd}` };
    }
  }
  return { status: 'missing' };
}
