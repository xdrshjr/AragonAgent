/**
 * Skill validation — frontmatter contract (§4.4) and staged-install safety (§8.3).
 *
 * Pure functions only: no filesystem, no process. The staged validator takes a
 * pre-listed file table so the same rules run identically over a real staging
 * directory (CLI) and over a fixture (tests).
 */

import {
  SKILL_ALLOWED_TOOLS_MAX,
  SKILL_DESC_MAX,
  SKILL_KEYWORDS_MAX,
  SKILL_KEYWORD_LEN_MAX,
  SKILL_META_MAX,
  SKILL_NAME_MAX,
  SKILL_NAME_PATTERN,
  STAGED_MAX_DEPTH,
  STAGED_MAX_FILE_BYTES,
  STAGED_MAX_FILES,
  STAGED_MAX_TOTAL_BYTES,
  WINDOWS_RESERVED_NAMES,
} from './constants.js';
import type {
  SkillActivation,
  SkillFrontmatter,
  SkillValidationIssue,
  StagedFile,
  StagedValidationResult,
} from './types.js';

const ACTIVATIONS: SkillActivation[] = ['auto', 'always', 'manual'];
const SEMVER = /^\d+\.\d+\.\d+(?:[-+].+)?$/;

/**
 * Characters that let a description escape the `<available_skills>` block.
 *
 * WARN, NOT ERROR — and that asymmetry is load-bearing (§4.4). Community skills
 * under `.claude/skills` legitimately write `<div>` in a description; failing
 * them would break interop (D8). Escaping is enforced UNCONDITIONALLY at every
 * render point by `sanitizeForPromptBlock()`; validation only tells the user.
 * Never let "validation passed" become a licence to skip sanitizing.
 */
function isControlCode(code: number): boolean {
  return code < 0x20 || code === 0x7f;
}

/** True when `s` holds a C0/DEL control character. */
export function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    if (isControlCode(s.charCodeAt(i))) return true;
  }
  return false;
}

/** True when `s` holds an angle bracket or a control character. */
function hasAngleOrControl(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code === 0x3c || code === 0x3e || isControlCode(code)) return true;
  }
  return false;
}

function asString(v: string | string[] | undefined): string | undefined {
  if (typeof v === 'string') return v;
  return undefined;
}

function asArray(v: string | string[] | undefined): string[] | undefined {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim().length > 0) return [v.trim()];
  return undefined;
}

/**
 * Validate a parsed frontmatter map against the §4.2 contract.
 *
 * Error codes are a stable public surface — the UI and the tests both key off
 * them, so renaming one is a breaking change.
 */
export function validateSkillFrontmatter(
  data: Record<string, string | string[]>,
  dirName: string,
): SkillValidationIssue[] {
  const issues: SkillValidationIssue[] = [];
  const err = (code: string, message: string): void => {
    issues.push({ level: 'error', code, message });
  };
  const warn = (code: string, message: string): void => {
    issues.push({ level: 'warn', code, message });
  };

  const name = asString(data.name)?.trim();
  if (!name) {
    err('SKILL_NAME_MISSING', 'name is required');
  } else if (!SKILL_NAME_PATTERN.test(name) || name.length > SKILL_NAME_MAX) {
    err(
      'SKILL_NAME_INVALID',
      `name "${name}" must be kebab-case ([a-z0-9-], no leading/trailing/double dash) and at most ${SKILL_NAME_MAX} characters`,
    );
  } else if (name !== dirName) {
    warn('SKILL_NAME_DIR_MISMATCH', `frontmatter name "${name}" does not match directory "${dirName}"`);
  }

  const description = asString(data.description)?.trim();
  if (!description) {
    err('SKILL_DESC_MISSING', 'description is required');
  } else if (description.length > SKILL_DESC_MAX) {
    err('SKILL_DESC_TOO_LONG', `description is ${description.length} characters (max ${SKILL_DESC_MAX})`);
  } else if (hasAngleOrControl(description)) {
    warn(
      'SKILL_DESC_UNSAFE_CHARS',
      'description contains angle brackets or control characters; they will be neutralized before reaching the model',
    );
  }

  const version = asString(data.version)?.trim();
  if (version && !SEMVER.test(version)) {
    warn('SKILL_VERSION_INVALID', `version "${version}" is not semver; falling back to 0.0.0`);
  }

  const activation = asString(data.activation)?.trim();
  if (activation && !(ACTIVATIONS as string[]).includes(activation)) {
    warn('SKILL_ACTIVATION_INVALID', `unknown activation "${activation}"; falling back to auto`);
  }

  const allowedTools = data['allowed-tools'] ?? data.allowedTools;
  if (allowedTools !== undefined && !Array.isArray(allowedTools) && typeof allowedTools !== 'string') {
    warn('SKILL_ALLOWED_TOOLS_INVALID', 'allowed-tools must be a list of tool names');
  } else if (Array.isArray(allowedTools) && allowedTools.length > SKILL_ALLOWED_TOOLS_MAX) {
    warn('SKILL_ALLOWED_TOOLS_INVALID', `allowed-tools has more than ${SKILL_ALLOWED_TOOLS_MAX} entries`);
  }

  return issues;
}

/** Build the normalized frontmatter view, applying every documented default. */
export function normalizeFrontmatter(
  data: Record<string, string | string[]>,
  fallbackName: string,
): SkillFrontmatter {
  const activationRaw = asString(data.activation)?.trim();
  const activation: SkillActivation = (ACTIVATIONS as string[]).includes(activationRaw ?? '')
    ? (activationRaw as SkillActivation)
    : 'auto';

  const versionRaw = asString(data.version)?.trim();
  const version = versionRaw && SEMVER.test(versionRaw) ? versionRaw : '0.0.0';

  const keywords = (asArray(data.keywords) ?? [])
    .slice(0, SKILL_KEYWORDS_MAX)
    .map((k) => k.slice(0, SKILL_KEYWORD_LEN_MAX));

  const allowedTools = (asArray(data['allowed-tools'] ?? data.allowedTools) ?? []).slice(
    0,
    SKILL_ALLOWED_TOOLS_MAX,
  );

  const meta = (key: string): string | undefined => {
    const v = asString(data[key])?.trim();
    return v && v.length > 0 ? v.slice(0, SKILL_META_MAX) : undefined;
  };

  return {
    name: asString(data.name)?.trim() || fallbackName,
    description: asString(data.description)?.trim() ?? '',
    version,
    ...(meta('license') ? { license: meta('license') } : {}),
    ...(meta('author') ? { author: meta('author') } : {}),
    ...(meta('homepage') ? { homepage: meta('homepage') } : {}),
    keywords,
    allowedTools,
    activation,
    raw: data,
  };
}

// ---------------------------------------------------------------------------
// Staged install validation (§8.3 step 2)
// ---------------------------------------------------------------------------

/**
 * Reject a relative path that could escape the staging root or is unusable on
 * Windows. This is the SECOND line of defence — the archive extractor applies
 * the same rules while writing (§9.2.1). Both are required: the extractor
 * guards what lands on disk, this guards what we then promote into the skills
 * root (a plain local-directory source never goes through the extractor).
 */
export function checkStagedPath(path: string): SkillValidationIssue | null {
  const normalized = path.replace(/\\/g, '/');
  if (normalized.length === 0) {
    return { level: 'error', code: 'SKILL_PATH_EMPTY', message: 'empty entry path' };
  }
  if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith('/')) {
    return {
      level: 'error',
      code: 'SKILL_PATH_ABSOLUTE',
      message: `absolute path not allowed: ${path}`,
    };
  }
  const segments = normalized.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => s === '..')) {
    return {
      level: 'error',
      code: 'SKILL_PATH_TRAVERSAL',
      message: `path escapes the skill directory: ${path}`,
    };
  }
  if (hasControlChar(normalized)) {
    return {
      level: 'error',
      code: 'SKILL_PATH_CONTROL_CHARS',
      message: `control characters in path: ${JSON.stringify(path)}`,
    };
  }
  for (const segment of segments) {
    const base = (segment.split('.')[0] ?? '').toLowerCase();
    if (WINDOWS_RESERVED_NAMES.has(base)) {
      return {
        level: 'error',
        code: 'SKILL_PATH_RESERVED_NAME',
        message: `Windows reserved name in path: ${path}`,
      };
    }
  }
  if (segments.length > STAGED_MAX_DEPTH) {
    return {
      level: 'error',
      code: 'SKILL_PATH_TOO_DEEP',
      message: `path nests deeper than ${STAGED_MAX_DEPTH} levels: ${path}`,
    };
  }
  return null;
}

/**
 * Validate a staged skill before it is promoted into a skills root.
 *
 * `entryText` is the raw SKILL.md; `files` is the full staged file table
 * (SKILL.md included). Returns `ok: false` if ANY error-level issue is found —
 * the installer must then abort and leave the target untouched.
 */
export function validateStagedSkill(
  entryText: string | null,
  files: StagedFile[],
  dirName: string,
  parse: (source: string) => { data: Record<string, string | string[]> } | null,
): StagedValidationResult {
  const issues: SkillValidationIssue[] = [];
  let totalBytes = 0;

  if (entryText === null) {
    issues.push({
      level: 'error',
      code: 'SKILL_MD_MISSING',
      message: 'SKILL.md not found in the source',
    });
  }

  if (files.length > STAGED_MAX_FILES) {
    issues.push({
      level: 'error',
      code: 'SKILL_TOO_MANY_FILES',
      message: `${files.length} files exceeds the limit of ${STAGED_MAX_FILES}`,
    });
  }

  for (const file of files) {
    if (file.isSymlink) {
      issues.push({
        level: 'error',
        code: 'SKILL_SYMLINK_REJECTED',
        message: `symbolic links are not allowed: ${file.path}`,
      });
      continue;
    }
    const pathIssue = checkStagedPath(file.path);
    if (pathIssue) {
      issues.push(pathIssue);
      continue;
    }
    if (file.bytes > STAGED_MAX_FILE_BYTES) {
      issues.push({
        level: 'error',
        code: 'SKILL_FILE_TOO_LARGE',
        message: `${file.path} is ${file.bytes} bytes (max ${STAGED_MAX_FILE_BYTES})`,
      });
    }
    totalBytes += file.bytes;
  }

  if (totalBytes > STAGED_MAX_TOTAL_BYTES) {
    issues.push({
      level: 'error',
      code: 'SKILL_TOTAL_TOO_LARGE',
      message: `total size ${totalBytes} bytes exceeds ${STAGED_MAX_TOTAL_BYTES}`,
    });
  }

  let frontmatter: SkillFrontmatter | null = null;
  if (entryText !== null) {
    const parsed = parse(entryText);
    if (!parsed) {
      issues.push({
        level: 'error',
        code: 'SKILL_FRONTMATTER_MISSING',
        message: 'SKILL.md has no parseable YAML frontmatter block',
      });
    } else {
      issues.push(...validateSkillFrontmatter(parsed.data, dirName));
      frontmatter = normalizeFrontmatter(parsed.data, dirName);
    }
  }

  return {
    ok: !issues.some((i) => i.level === 'error'),
    issues,
    frontmatter,
    fileCount: files.length,
    totalBytes,
  };
}
