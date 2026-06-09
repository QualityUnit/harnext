import { describe, expect, it } from 'vitest';
import type { BeforeToolCallContext } from '@mariozechner/pi-agent-core';

import {
  canonicalToolName,
  createPermissionHook,
  filterTools,
  isPermissionMode,
  matchesAnyRule,
  normalizeToolName,
  toolMatchesRule,
  type ToolPolicy,
} from '../src/tool-policy.js';

const TOOLS = [
  { name: 'read' },
  { name: 'bash' },
  { name: 'edit' },
  { name: 'write' },
  { name: 'mcp__github__create_issue' },
];

function ctx(toolName: string): BeforeToolCallContext {
  return { toolCall: { name: toolName } } as unknown as BeforeToolCallContext;
}

async function decide(policy: ToolPolicy, toolName: string): Promise<'allow' | 'block'> {
  const hook = createPermissionHook(policy);
  if (!hook) return 'allow';
  const result = await hook(ctx(toolName));
  return result?.block ? 'block' : 'allow';
}

describe('name normalization + matching', () => {
  it('folds case so Claude and native names match', () => {
    expect(normalizeToolName('Bash')).toBe('bash');
    expect(toolMatchesRule('bash', 'Bash')).toBe(true);
    expect(toolMatchesRule('Read', 'read')).toBe(true);
  });

  it('maps native names to canonical Claude names', () => {
    expect(canonicalToolName('bash')).toBe('Bash');
    expect(canonicalToolName('read')).toBe('Read');
    expect(canonicalToolName('mcp__x__y')).toBe('mcp__x__y');
  });

  it('matches whole-server MCP rules by prefix', () => {
    expect(toolMatchesRule('mcp__github__create_issue', 'mcp__github')).toBe(true);
    expect(toolMatchesRule('mcp__gitlab__x', 'mcp__github')).toBe(false);
    expect(matchesAnyRule('mcp__github__x', ['Read', 'mcp__github'])).toBe(true);
  });

  it('validates permission mode strings', () => {
    expect(isPermissionMode('dontAsk')).toBe(true);
    expect(isPermissionMode('nope')).toBe(false);
  });
});

describe('filterTools (visibility)', () => {
  it('removes disallowed tools (alias-aware)', () => {
    const visible = filterTools(TOOLS, { disallowedTools: ['Write', 'Bash'] });
    expect(visible.map((t) => t.name)).toEqual(['read', 'edit', 'mcp__github__create_issue']);
  });

  it('removes a whole MCP server by prefix', () => {
    const visible = filterTools(TOOLS, { disallowedTools: ['mcp__github'] });
    expect(visible.some((t) => t.name.startsWith('mcp__github'))).toBe(false);
  });

  it('does not hide allowed_tools (allow is auto-approve, not a filter)', () => {
    const visible = filterTools(TOOLS, { allowedTools: ['Read'] });
    expect(visible).toHaveLength(TOOLS.length);
  });
});

describe('createPermissionHook', () => {
  it('returns no hook for default/acceptEdits with no disallow list', () => {
    expect(createPermissionHook({ permissionMode: 'default' })).toBeUndefined();
    expect(createPermissionHook({ permissionMode: 'acceptEdits' })).toBeUndefined();
    expect(createPermissionHook({})).toBeUndefined();
  });

  it('dontAsk allows only allowed_tools, blocks the rest', async () => {
    const policy: ToolPolicy = { permissionMode: 'dontAsk', allowedTools: ['Read', 'Bash'] };
    expect(await decide(policy, 'read')).toBe('allow');
    expect(await decide(policy, 'bash')).toBe('allow');
    expect(await decide(policy, 'write')).toBe('block');
    expect(await decide(policy, 'edit')).toBe('block');
  });

  it('plan mode is read-only', async () => {
    const policy: ToolPolicy = { permissionMode: 'plan' };
    expect(await decide(policy, 'read')).toBe('allow');
    expect(await decide(policy, 'bash')).toBe('block');
    expect(await decide(policy, 'write')).toBe('block');
  });

  it('bypassPermissions allows everything except disallowed', async () => {
    expect(await decide({ permissionMode: 'bypassPermissions' }, 'bash')).toBe('allow');
    const withDisallow: ToolPolicy = {
      permissionMode: 'bypassPermissions',
      disallowedTools: ['Bash'],
    };
    expect(await decide(withDisallow, 'bash')).toBe('block');
    expect(await decide(withDisallow, 'read')).toBe('allow');
  });

  it('disallowed always wins, even when also allowed', async () => {
    const policy: ToolPolicy = {
      permissionMode: 'dontAsk',
      allowedTools: ['Bash'],
      disallowedTools: ['Bash'],
    };
    expect(await decide(policy, 'bash')).toBe('block');
  });

  it('default mode blocks only disallowed tools', async () => {
    const policy: ToolPolicy = { permissionMode: 'default', disallowedTools: ['Write'] };
    expect(await decide(policy, 'write')).toBe('block');
    expect(await decide(policy, 'bash')).toBe('allow');
  });
});
