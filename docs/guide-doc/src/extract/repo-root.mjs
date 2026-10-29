/**
 * 仓库根的唯一定义（`guide-doc` 的上两级）。
 *
 * 单独成文件是为了让 `gate.mjs` 与 `truth-sets.mjs` 共享同一个根，而不必互相 import
 * （那会形成环）。路径计算只允许出现在这类基础设施文件里（§4.1）。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `docs/guide-doc` 的绝对路径。 */
export const HERE = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

/** 仓库根（`guide-doc` 的上两级）。 */
export const REPO_ROOT = path.resolve(HERE, '..', '..');
