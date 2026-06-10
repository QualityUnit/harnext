/**
 * Tool visibility + permission policy, mirroring the Claude Agent SDK's
 * `allowed_tools` / `disallowed_tools` / `permission_mode` semantics.
 *
 * The Claude SDK names its built-in tools in PascalCase (`Read`, `Write`,
 * `Edit`, `Bash`); harnext names its native tools in lowercase (`read`,
 * `write`, `edit`, `bash`). Callers (and the Python SDK) speak the Claude
 * names, so every comparison here is alias-aware: a rule of `"Bash"` matches
 * the native `bash` tool, and vice versa. Unknown names (e.g. MCP tools such
 * as `mcp__server__tool`) pass through unchanged and match case-insensitively.
 */

import type {
  BeforeToolCallContext,
  BeforeToolCallResult,
} from '@mariozechner/pi-agent-core';

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'dontAsk'
  | 'bypassPermissions';

export const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
];

export function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * Canonical (Claude SDK) name for each harnext native tool. Used when emitting
 * stream-json so consumers see the names they expect.
 */
export const NATIVE_TO_CANONICAL: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  todo: 'TodoWrite',
};

/** Native tools that don't mutate the workspace — allowed under `plan` mode. */
const READ_ONLY_NATIVE = new Set(['read', 'todo']);

/** Native tools that mutate the workspace — blocked under `plan` mode. */
const MUTATING_NATIVE = new Set(['bash', 'write', 'edit']);

/**
 * Reduce a tool name to a stable comparison key. For most built-ins the
 * canonical lowercase already equals the native name (`Bash`→`bash`), so a
 * lowercase fold is sufficient and also makes MCP names case-insensitive.
 * Canonical names whose lowercase differs from the native name (`TodoWrite`)
 * are folded explicitly.
 */
const CANONICAL_LOWER_TO_NATIVE: Record<string, string> = {
  todowrite: 'todo',
};

export function normalizeToolName(name: string): string {
  const lower = name.trim().toLowerCase();
  return CANONICAL_LOWER_TO_NATIVE[lower] ?? lower;
}

/** Map a native tool name to its Claude-SDK canonical name (else unchanged). */
export function canonicalToolName(name: string): string {
  return NATIVE_TO_CANONICAL[normalizeToolName(name)] ?? name;
}

/**
 * Does `toolName` match `rule`? Exact (alias-aware) match, plus MCP
 * server-prefix matching: a rule of `mcp__github` matches every tool whose
 * name starts with `mcp__github__`, mirroring the Claude SDK.
 */
export function toolMatchesRule(toolName: string, rule: string): boolean {
  const t = normalizeToolName(toolName);
  const r = normalizeToolName(rule);
  if (t === r) return true;
  if (r.startsWith('mcp__') && !r.includes('__', 5)) {
    // `mcp__<server>` whole-server rule
    return t.startsWith(`${r}__`);
  }
  return false;
}

export function matchesAnyRule(toolName: string, rules: readonly string[]): boolean {
  return rules.some((rule) => toolMatchesRule(toolName, rule));
}

export interface ToolPolicy {
  permissionMode?: PermissionMode;
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
}

/**
 * Remove tools the model must not even see. Only `disallowed_tools` affects
 * visibility — `allowed_tools` is an auto-approve list, not a visibility
 * filter, so it never hides tools (matching the Claude SDK).
 */
export function filterTools<T extends { name: string }>(
  tools: readonly T[],
  policy: ToolPolicy,
): T[] {
  const disallowed = policy.disallowedTools ?? [];
  if (disallowed.length === 0) return [...tools];
  return tools.filter((tool) => !matchesAnyRule(tool.name, disallowed));
}

/**
 * Build a `beforeToolCall` hook enforcing the permission policy at call time.
 * Returns `undefined` when no enforcement is needed (so the agent keeps its
 * default behavior of running every tool).
 */
export function createPermissionHook(
  policy: ToolPolicy,
):
  | ((context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>)
  | undefined {
  const mode: PermissionMode = policy.permissionMode ?? 'default';
  const allowed = policy.allowedTools ?? [];
  const disallowed = policy.disallowedTools ?? [];

  // `default`/`acceptEdits` with no disallow list is the agent's native
  // behavior (run everything) — no hook needed.
  if (
    (mode === 'default' || mode === 'acceptEdits' || mode === 'bypassPermissions') &&
    disallowed.length === 0
  ) {
    return undefined;
  }

  return async (context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
    const toolName = context.toolCall.name;
    const native = normalizeToolName(toolName);

    // Disallowed always wins, in every mode.
    if (matchesAnyRule(toolName, disallowed)) {
      return { block: true, reason: `Tool "${toolName}" is disallowed by policy.` };
    }

    switch (mode) {
      case 'bypassPermissions':
        return undefined;

      case 'plan':
        if (READ_ONLY_NATIVE.has(native)) return undefined;
        if (MUTATING_NATIVE.has(native)) {
          return {
            block: true,
            reason: `Plan mode is read-only; "${toolName}" cannot run.`,
          };
        }
        // Unknown (e.g. MCP) tools: allow only if explicitly pre-approved.
        return matchesAnyRule(toolName, allowed)
          ? undefined
          : { block: true, reason: `Plan mode is read-only; "${toolName}" is not pre-approved.` };

      case 'dontAsk':
        // Default-deny: only explicitly allowed tools run.
        return matchesAnyRule(toolName, allowed)
          ? undefined
          : {
              block: true,
              reason: `Tool "${toolName}" is not in allowed_tools (permission-mode=dontAsk).`,
            };

      case 'acceptEdits':
      case 'default':
      default:
        // Headless harnext has no interactive approval prompt, so once the
        // disallow check above passes we run the tool. `allowed_tools` is a
        // no-op here (it only gates `dontAsk`/`plan`).
        return undefined;
    }
  };
}
