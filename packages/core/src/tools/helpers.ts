/**
 * Tool System — Convenience Helpers
 *
 * Provides factory functions for creating ToolResult values and
 * a builder function for defining tools with less boilerplate.
 */

import type {
  AgentTool,
  JSONSchema7,
  ToolExecuteFn,
  ToolResult,
  ToolResultContent,
} from './types.js';

// ---------------------------------------------------------------------------
// Result Factories
// ---------------------------------------------------------------------------

/**
 * Create a successful text result.
 *
 * @param text - The text content to return.
 */
export function textResult(text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

/**
 * Create an error result.
 * Sets `isError: true` and prepends "Error: " to the message.
 *
 * @param message - Human-readable error description.
 */
export function errorResult(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

/**
 * Create a result containing a base64-encoded image.
 *
 * @param mediaType - MIME type (e.g. 'image/png', 'image/jpeg').
 * @param data      - Base64-encoded image data.
 */
export function imageResult(mediaType: string, data: string): ToolResult {
  return {
    content: [{ type: 'image', mediaType, data }],
  };
}

/**
 * Create a result with multiple content blocks.
 *
 * @param blocks  - Array of content blocks.
 * @param isError - Whether this result represents an error.
 */
export function multiResult(
  blocks: ToolResultContent[],
  isError?: boolean,
): ToolResult {
  return {
    content: blocks,
    ...(isError ? { isError } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tool Builder
// ---------------------------------------------------------------------------

/**
 * Configuration for `defineTool()` — all fields that make up an AgentTool.
 */
export interface DefineToolConfig<TParams = Record<string, unknown>> {
  name: string;
  label: string;
  description: string;
  parameters: JSONSchema7;
  execute: ToolExecuteFn<TParams>;
  tags?: string[];
  bridgeable?: boolean;
  bridgeName?: string;
}

/**
 * Convenience builder that creates a fully-typed AgentTool from a
 * plain configuration object.
 *
 * Usage:
 * ```ts
 * const myTool = defineTool({
 *   name: 'greet',
 *   label: 'Greeter',
 *   description: 'Greets the user.',
 *   parameters: {
 *     type: 'object',
 *     properties: { name: { type: 'string' } },
 *     required: ['name'],
 *   },
 *   async execute(_id, params, _ctx) {
 *     return textResult(`Hello, ${params.name}!`);
 *   },
 * });
 * ```
 */
export function defineTool<TParams = Record<string, unknown>>(
  config: DefineToolConfig<TParams>,
): AgentTool<TParams> {
  return {
    name: config.name,
    label: config.label,
    description: config.description,
    parameters: config.parameters,
    execute: config.execute,
    ...(config.tags ? { tags: config.tags } : {}),
    ...(config.bridgeable !== undefined ? { bridgeable: config.bridgeable } : {}),
    ...(config.bridgeName ? { bridgeName: config.bridgeName } : {}),
  };
}
