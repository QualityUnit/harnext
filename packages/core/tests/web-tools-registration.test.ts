/**
 * Issue #78 acceptance: `web_fetch` and `web_search` must be *registered* in
 * `tools/index.ts` (the static `codingTools`/`allTools` registries and the
 * `createCodingTools`/`createAllTools` factories) and re-exported from the core
 * barrel, so the agent actually receives them.
 *
 * The per-tool suites exercise behavior in isolation; this integration test
 * guards the wiring itself — without it, the tools could work perfectly yet
 * never reach a session because they were dropped from the registries.
 */
import { describe, expect, it } from 'vitest';

import {
  allTools,
  codingTools,
  createAllTools,
  createCodingTools,
} from '../src/tools/index.js';
import * as barrel from '../src/index.js';

const WEB_TOOLS = ['web_fetch', 'web_search'] as const;

describe('web tools registration (issue #78)', () => {
  it('includes both web tools in the static codingTools array', () => {
    const names = codingTools.map((t) => t.name);
    for (const name of WEB_TOOLS) expect(names).toContain(name);
  });

  it('maps both web tools by name in allTools', () => {
    for (const name of WEB_TOOLS) {
      expect(allTools[name]).toBeDefined();
      expect(allTools[name].name).toBe(name);
    }
  });

  it('produces both web tools from createCodingTools(cwd)', () => {
    const names = createCodingTools(process.cwd()).map((t) => t.name);
    for (const name of WEB_TOOLS) expect(names).toContain(name);
  });

  it('produces both web tools from createAllTools(cwd)', () => {
    const tools = createAllTools(process.cwd());
    for (const name of WEB_TOOLS) {
      expect(tools[name]).toBeDefined();
      expect(tools[name].name).toBe(name);
    }
  });

  it('re-exports the web tool factories from the core barrel', () => {
    expect(typeof barrel.createWebFetchTool).toBe('function');
    expect(typeof barrel.createWebSearchTool).toBe('function');
    expect(barrel.webFetchTool.name).toBe('web_fetch');
    expect(barrel.webSearchTool.name).toBe('web_search');
  });
});
