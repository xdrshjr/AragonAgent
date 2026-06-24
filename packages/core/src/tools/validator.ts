/**
 * Tool System — Parameter Validator
 *
 * Validates tool parameters against their JSON Schema 7 definitions.
 * Uses `ajv` when available for full JSON Schema validation; falls back
 * to a minimal inline validator for basic type checking when ajv is
 * not yet installed.
 */

import type { JSONSchema7 } from './types.js';

// ---------------------------------------------------------------------------
// Validation Error
// ---------------------------------------------------------------------------

/**
 * Structured validation error with a JSON pointer path and message.
 */
export interface ValidationError {
  path: string;
  message: string;
}

/**
 * Error thrown when parameter validation fails.
 */
export class ToolValidationError extends Error {
  constructor(
    public readonly errors: ValidationError[],
  ) {
    super(`Parameter validation failed: ${formatValidationErrors(errors)}`);
    this.name = 'ToolValidationError';
  }
}

// ---------------------------------------------------------------------------
// Validator Interface
// ---------------------------------------------------------------------------

/**
 * Internal strategy interface — both the ajv-based and fallback
 * validators implement this contract.
 */
interface ValidatorStrategy {
  validate(schema: JSONSchema7, params: unknown): Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ToolParamValidator
// ---------------------------------------------------------------------------

/**
 * Validates tool call parameters against a JSON Schema 7 definition.
 *
 * Attempts to use `ajv` for full schema validation. If ajv is not
 * available at runtime (not yet installed), falls back to a lightweight
 * inline validator that covers basic type and required-field checks.
 */
export class ToolParamValidator {
  private strategy: ValidatorStrategy | null = null;
  private strategyReady: Promise<ValidatorStrategy> | null = null;

  /**
   * Validate `params` against the given JSON Schema.
   *
   * @returns The validated (and potentially coerced) parameters.
   * @throws {ToolValidationError} if validation fails.
   */
  async validate(schema: JSONSchema7, params: unknown): Promise<Record<string, unknown>> {
    const strategy = await this.getStrategy();
    return strategy.validate(schema, params);
  }

  // -----------------------------------------------------------------------
  // Strategy Resolution
  // -----------------------------------------------------------------------

  private getStrategy(): Promise<ValidatorStrategy> {
    if (this.strategyReady) {
      return this.strategyReady;
    }

    this.strategyReady = (async () => {
      try {
        // Dynamic import for ESM compatibility.
        const AjvModule = await import('ajv');
        const Ajv = AjvModule.default ?? AjvModule;
        this.strategy = new AjvStrategy(Ajv);
      } catch {
        // ajv not installed — use the fallback.
        this.strategy = new FallbackStrategy();
      }
      return this.strategy!;
    })();

    return this.strategyReady;
  }
}

// ---------------------------------------------------------------------------
// Ajv-based Strategy
// ---------------------------------------------------------------------------

class AjvStrategy implements ValidatorStrategy {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ajvInstance: any;

  /** Cache of compiled validators keyed by a stable schema fingerprint. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private compiledCache = new Map<string, any>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(Ajv: any) {
    this.ajvInstance = new Ajv({
      allErrors: true,
      coerceTypes: true,
      useDefaults: true,
      strict: false,
    });
  }

  validate(schema: JSONSchema7, params: unknown): Record<string, unknown> {
    // Ensure we validate an object even if params is null/undefined.
    const data: Record<string, unknown> =
      params !== null && typeof params === 'object' && !Array.isArray(params)
        ? { ...(params as Record<string, unknown>) }
        : {};

    const validateFn = this.getOrCompile(schema);
    const valid = validateFn(data);
    if (!valid) {
      const errors: ValidationError[] = (validateFn.errors ?? []).map(
        (err: any) => ({
          path: err.instancePath || '/',
          message: err.message ?? 'unknown error',
        }),
      );
      throw new ToolValidationError(errors);
    }

    return data;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getOrCompile(schema: JSONSchema7): any {
    const key = JSON.stringify(schema);
    let fn = this.compiledCache.get(key);
    if (!fn) {
      fn = this.ajvInstance.compile(schema);
      this.compiledCache.set(key, fn);
    }
    return fn;
  }
}

// ---------------------------------------------------------------------------
// Fallback Strategy (no ajv)
// ---------------------------------------------------------------------------

/**
 * A lightweight validator that covers the most common schema shapes
 * used in tool parameter definitions:
 *  - top-level `type: 'object'` with `properties` and `required`
 *  - per-property primitive type checks (string, number, boolean, array, object)
 *
 * This is NOT a full JSON Schema 7 implementation — it exists solely
 * as a safety net until ajv is installed.
 */
class FallbackStrategy implements ValidatorStrategy {
  validate(schema: JSONSchema7, params: unknown): Record<string, unknown> {
    const data: Record<string, unknown> =
      params !== null && typeof params === 'object' && !Array.isArray(params)
        ? { ...(params as Record<string, unknown>) }
        : {};

    const errors: ValidationError[] = [];

    // Check required fields.
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (data[key] === undefined || data[key] === null) {
          errors.push({
            path: `/${key}`,
            message: `required property '${key}' is missing`,
          });
        }
      }
    }

    // Check property types.
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        const value = data[key];
        if (value === undefined || value === null) {
          // Apply defaults if specified.
          if (propSchema.default !== undefined) {
            data[key] = propSchema.default;
          }
          continue;
        }

        const typeError = checkPrimitiveType(key, value, propSchema);
        if (typeError) {
          errors.push(typeError);
        }
      }
    }

    if (errors.length > 0) {
      throw new ToolValidationError(errors);
    }

    return data;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkPrimitiveType(
  key: string,
  value: unknown,
  schema: JSONSchema7,
): ValidationError | null {
  const expectedType = schema.type;
  if (!expectedType || typeof expectedType !== 'string') {
    return null;
  }

  const actualType = Array.isArray(value) ? 'array' : typeof value;

  switch (expectedType) {
    case 'string':
      if (typeof value !== 'string') {
        return { path: `/${key}`, message: `expected string, got ${actualType}` };
      }
      break;
    case 'number':
    case 'integer':
      if (typeof value !== 'number') {
        return { path: `/${key}`, message: `expected number, got ${actualType}` };
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') {
        return { path: `/${key}`, message: `expected boolean, got ${actualType}` };
      }
      break;
    case 'array':
      if (!Array.isArray(value)) {
        return { path: `/${key}`, message: `expected array, got ${actualType}` };
      }
      break;
    case 'object':
      if (typeof value !== 'object' || Array.isArray(value) || value === null) {
        return { path: `/${key}`, message: `expected object, got ${actualType}` };
      }
      break;
    // 'null' and unknown types are not checked — let them pass.
  }

  return null;
}

/**
 * Format validation errors into a single human-readable string.
 */
export function formatValidationErrors(errors: ValidationError[]): string {
  return errors
    .map((e) => `${e.path}: ${e.message}`)
    .join('; ');
}
