/**
 * Skills submodule barrel — reachable as `@aragon-agent/core/skills`.
 *
 * The root barrel (`src/index.ts`) re-exports the documented public face; this
 * subpath additionally exposes the internals the CLI needs (staged-install
 * validation, always-block rendering, byte helpers) without widening the frozen
 * top-level API surface. Same "root barrel + subpath" split the tools module
 * already uses.
 */

export * from './constants.js';
export * from './types.js';
export { parseFrontmatter } from './frontmatter.js';
export type { ParsedFrontmatter } from './frontmatter.js';
export {
  validateSkillFrontmatter,
  validateStagedSkill,
  normalizeFrontmatter,
  checkStagedPath,
  hasControlChar,
} from './validate.js';
export {
  sanitizeForPromptBlock,
  renderSkillCatalog,
  renderSkillBody,
  renderSkillInvocation,
  renderAlwaysSkills,
  renderCatalogLine,
  renderSkillFindResults,
  renderSkillFindNoMatch,
  applySkillArguments,
  splitArguments,
  suggestSkillNames,
  catalogRecords,
  rankCatalogRecords,
  classifyBundledFile,
  byteLength,
  truncateToBytes,
} from './disclosure.js';
export {
  normalizeToolAlias,
  resolveDeclaredTool,
  computeToolPolicy,
  evaluateToolCall,
  renderDenyEscalation,
  renderDenyEscalationNotice,
  SKILL_TOOL_ALIASES,
  SKILL_TOOL_KNOWN_ABSENT,
} from './tool-policy.js';
export { SkillRegistry } from './skill-registry.js';
export { createSkillTool } from './skill-tool.js';
export type { SkillToolDeps } from './skill-tool.js';
export { createSkillFindTool, matchSkills } from './skill-find-tool.js';
export type { SkillFindToolDeps } from './skill-find-tool.js';
