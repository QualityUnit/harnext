import { describe, expect, it } from 'vitest';
import type { BeforeToolCallContext } from '@earendil-works/pi-agent-core';

import {
  canonicalToolName,
  classifyInteractive,
  createPermissionHook,
  filterTools,
  isMutatingTool,
  isPathInsideCwd,
  isPermissionMode,
  isReadOnlyTool,
  matchesAnyRule,
  normalizeToolName,
  toolMatchesRule,
  toolTargetPath,
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

  it('plan mode is read-only but allows exit_plan', async () => {
    const policy: ToolPolicy = { permissionMode: 'plan' };
    expect(await decide(policy, 'read')).toBe('allow');
    expect(await decide(policy, 'bash')).toBe('block');
    expect(await decide(policy, 'write')).toBe('block');
    expect(await decide(policy, 'exit_plan')).toBe('allow');
    expect(await decide(policy, 'ExitPlanMode')).toBe('allow');
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

describe('tool classification helpers', () => {
  it('classifies mutating vs read-only tools (alias-aware)', () => {
    expect(isMutatingTool('bash')).toBe(true);
    expect(isMutatingTool('Edit')).toBe(true);
    expect(isMutatingTool('write')).toBe(true);
    expect(isMutatingTool('read')).toBe(false);
    expect(isReadOnlyTool('read')).toBe(true);
    expect(isReadOnlyTool('TodoWrite')).toBe(true);
    expect(isReadOnlyTool('exit_plan')).toBe(true);
    expect(isReadOnlyTool('ExitPlanMode')).toBe(true);
    expect(isReadOnlyTool('bash')).toBe(false);
  });

  it('maps exit_plan to its canonical Claude name', () => {
    expect(canonicalToolName('exit_plan')).toBe('ExitPlanMode');
    expect(normalizeToolName('ExitPlanMode')).toBe('exit_plan');
  });

  it('extracts the mutation target path only for edit/write', () => {
    expect(toolTargetPath('edit', { path: 'src/a.ts' })).toBe('src/a.ts');
    expect(toolTargetPath('Write', { path: '/etc/hosts' })).toBe('/etc/hosts');
    expect(toolTargetPath('bash', { command: 'ls' })).toBeUndefined();
    expect(toolTargetPath('edit', {})).toBeUndefined();
    expect(toolTargetPath('read', { path: 'x' })).toBeUndefined();
  });

  it('detects whether a path is inside the working directory', () => {
    const cwd = '/home/user/project';
    expect(isPathInsideCwd('src/a.ts', cwd)).toBe(true);
    expect(isPathInsideCwd('./nested/b.ts', cwd)).toBe(true);
    expect(isPathInsideCwd('/home/user/project/c.ts', cwd)).toBe(true);
    expect(isPathInsideCwd('.', cwd)).toBe(true);
    expect(isPathInsideCwd('../sibling/d.ts', cwd)).toBe(false);
    expect(isPathInsideCwd('/etc/hosts', cwd)).toBe(false);
    expect(isPathInsideCwd('/home/user/project-evil/e.ts', cwd)).toBe(false);
  });
});

describe('classifyInteractive (TTY permission modes)', () => {
  const cwd = '/home/user/project';

  it('bypassPermissions allows everything', () => {
    for (const tool of ['bash', 'edit', 'write', 'read', 'exit_plan']) {
      expect(classifyInteractive(tool, { path: '/etc/x', command: 'rm' }, { mode: 'bypassPermissions', cwd })).toEqual({
        action: 'allow',
      });
    }
  });

  it('plan mode allows reads, denies mutations, and routes exit_plan to approval', () => {
    expect(classifyInteractive('read', { path: 'a.ts' }, { mode: 'plan', cwd })).toEqual({
      action: 'allow',
    });
    expect(classifyInteractive('todo', {}, { mode: 'plan', cwd })).toEqual({ action: 'allow' });
    expect(classifyInteractive('exit_plan', { plan: 'do it' }, { mode: 'plan', cwd })).toEqual({
      action: 'approve-plan',
    });
    expect(classifyInteractive('bash', { command: 'ls' }, { mode: 'plan', cwd }).action).toBe('deny');
    expect(classifyInteractive('edit', { path: 'a.ts' }, { mode: 'plan', cwd }).action).toBe('deny');
    expect(classifyInteractive('write', { path: 'a.ts' }, { mode: 'plan', cwd }).action).toBe('deny');
  });

  it('acceptEdits auto-allows in-cwd edits, asks for bash and out-of-cwd edits', () => {
    expect(classifyInteractive('edit', { path: 'src/a.ts' }, { mode: 'acceptEdits', cwd })).toEqual({
      action: 'allow',
    });
    expect(classifyInteractive('write', { path: 'src/new.ts' }, { mode: 'acceptEdits', cwd })).toEqual({
      action: 'allow',
    });
    expect(classifyInteractive('read', { path: '/etc/hosts' }, { mode: 'acceptEdits', cwd })).toEqual({
      action: 'allow',
    });
    expect(classifyInteractive('bash', { command: 'npm test' }, { mode: 'acceptEdits', cwd })).toEqual({
      action: 'ask',
      kind: 'bash',
    });
    expect(classifyInteractive('edit', { path: '/etc/hosts' }, { mode: 'acceptEdits', cwd })).toEqual({
      action: 'ask',
      kind: 'edit-outside',
    });
    expect(classifyInteractive('write', { path: '../escape.ts' }, { mode: 'acceptEdits', cwd })).toEqual({
      action: 'ask',
      kind: 'edit-outside',
    });
  });

  it('treats a write with no path as out-of-cwd (asks rather than silently allowing)', () => {
    expect(classifyInteractive('write', {}, { mode: 'acceptEdits', cwd })).toEqual({
      action: 'ask',
      kind: 'edit-outside',
    });
  });
});
