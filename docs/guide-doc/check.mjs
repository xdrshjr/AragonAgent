#!/usr/bin/env node
/**
 * 准确性门禁的命令行入口（§7.1.1）。
 *
 * 判定逻辑全部在 `src/extract/gate.mjs`；本文件只负责参数、用法与退出码，
 * 因此「命令行契约」可以独立于「判定规则」演进。
 *
 * 用法与退出码见下方 `USAGE`：0 全绿 | 1 用法错误 | 3 存在 ERROR（或 --strict 下的 WARN）。
 * 末行固定打印 `N truth sets, E error, W warn, I info`（AC-3 按这一行断言）。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HERE, Report, checkModel, checkDist, finish } from './src/extract/gate.mjs';

export function parseArgs(argv) {
  const options = {
    mode: 'model',
    root: path.join(HERE, 'dist'),
    contentRoot: path.join(HERE, 'src', 'content'),
    phase: 'A',
    strict: false,
    report: null,
    json: false,
    help: false,
    usageError: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--model') options.mode = 'model';
    else if (arg === '--dist') options.mode = 'dist';
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--root' || arg === '--content-root' || arg === '--phase' || arg === '--report') {
      const value = argv[index + 1];
      if (!value) {
        options.usageError = `${arg} 需要一个值`;
        return options;
      }
      index += 1;
      if (arg === '--root') options.root = path.resolve(process.cwd(), value);
      else if (arg === '--content-root') options.contentRoot = path.resolve(process.cwd(), value);
      else if (arg === '--phase') {
        if (value !== 'A' && value !== 'all') {
          options.usageError = `--phase 只接受 A 或 all（收到 \`${value}\`）`;
          return options;
        }
        options.phase = value;
      } else options.report = path.resolve(process.cwd(), value);
    } else {
      options.usageError = `未知参数 \`${arg}\``;
      return options;
    }
  }
  return options;
}

/** 用法说明。 */
const USAGE = `用法: node docs/guide-doc/check.mjs [--model | --dist] [options]

  --model                读 src/content/**，跑 truth set / 结构 / 链接 / 占位符 / 品牌 / 规模（默认）
  --dist                 读产物目录，跑内联脚本 / href / 外链 / 体积 / 锚点实存 / 计数
  --root <dir>           配合 --dist 指定产物目录（默认 docs/guide-doc/dist）
  --content-root <dir>   配合 --model 指定内容根（fixture 负向测试的唯一入口）
  --phase A|all          页集合（默认 A）
  --strict               WARN 视为 ERROR
  --report <file>        写 JSON 报告
  --json                 机器可读结果
  -h, --help

退出码: 0 全绿 | 1 用法错误 | 3 存在 ERROR（或 --strict 下的 WARN）`;

/**
 * CLI 入口。
 *
 * @param {string[]} argv 参数
 * @returns {Promise<number>} 退出码
 */
export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.usageError) {
    console.error(`参数错误：${options.usageError}`);
    console.error(USAGE);
    return 1;
  }
  const report = new Report();
  let summary = {};
  const truthSetCount = 9;
  try {
    summary = options.mode === 'dist' ? checkDist(options, report) : await checkModel(options, report);
  } catch (error) {
    report.error('exception', error && error.message ? error.message : String(error));
  }
  return finish(report, options, truthSetCount, summary);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
