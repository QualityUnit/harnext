import { createInterface } from 'node:readline';

import { getModel, getModels } from '@earendil-works/pi-ai';
import type { KnownProvider, Model } from '@earendil-works/pi-ai';
import chalk from 'chalk';

import {
  buildNvidiaModel,
  buildOllamaModel,
  buildOpenRouterModel,
  DEFAULT_OLLAMA_BASE_URL,
  getProviderConfig,
  getStoredKey,
  listNvidiaModels,
  listOllamaModels,
  listOpenRouterModels,
  normalizeOllamaBaseUrl,
  PROVIDERS,
  removeProviderConfig,
  saveProviderConfig,
  saveProviderKey,
  setProviderEnv,
} from '@harnext/core';
import type { OpenRouterModelSummary } from '@harnext/core';
import type { ProviderInfo } from '@harnext/core';
import { select } from './select.js';
import type { SelectItem } from './select.js';

export interface ModelPickerResult {
  provider: string;
  model: Model<string>;
}

/**
 * Interactive model picker triggered by the /model slash command.
 * Uses arrow-key select boxes for provider and model selection.
 *
 * Loops at the provider list so that "Remove configuration" or back-cancel
 * inside a provider's submenu drops the user back to provider selection
 * rather than aborting the whole command.
 */
export async function pickModel(): Promise<ModelPickerResult | undefined> {
  while (true) {
    const provider = await selectProvider();
    if (!provider) return undefined;

    const result = await manageProvider(provider);
    if (result === 'reselect') continue;
    return result;
  }
}

/**
 * Drive a single provider through either the first-run wizard (no key/url
 * stored yet) or the CRUD submenu (already configured). Returns:
 *   - a ModelPickerResult when the user picked a model
 *   - 'reselect' to bounce back to the provider list (e.g. config removed)
 *   - undefined when the user cancelled out
 */
async function manageProvider(
  provider: ProviderInfo,
): Promise<ModelPickerResult | 'reselect' | undefined> {
  if (!isProviderConfigured(provider)) {
    return runFirstRunFlow(provider);
  }

  // CRUD submenu — loops so update-key/url returns here for further actions.
  while (true) {
    const action = await selectProviderAction(provider);
    if (!action || action === 'cancel') return undefined;
    if (action === 'back') return 'reselect';

    if (action === 'pick-model') {
      const result = await runFirstRunFlow(provider);
      if (result) return result;
      // user backed out of model selection — stay in the submenu
      continue;
    }

    if (action === 'update-key') {
      const ok = await promptApiKeyUpdate(provider);
      if (ok) console.log(chalk.green('  Key updated.'));
      console.log();
      continue;
    }

    if (action === 'update-url') {
      const ok = await promptBaseUrlUpdate(provider);
      if (ok) console.log(chalk.green('  Base URL updated.'));
      console.log();
      continue;
    }

    if (action === 'remove') {
      removeProviderConfig(provider.id);
      // Also clear the env var for this process so the picker's "configured"
      // tag flips off immediately. Shell-set env vars in *new* processes are
      // unaffected — that's by design (we don't own the parent shell).
      if (provider.envVar) delete process.env[provider.envVar];
      console.log(chalk.dim(`  Removed ${provider.name} configuration.`));
      console.log();
      return 'reselect';
    }
  }
}

function isProviderConfigured(provider: ProviderInfo): boolean {
  if (provider.local) return !!getProviderConfig(provider.id)?.baseUrl;
  return (
    !!(provider.envVar && process.env[provider.envVar]) || !!getStoredKey(provider.id)
  );
}

/**
 * The pre-existing (provider not yet configured) flow: prompt for key/url if
 * needed, then go straight to model selection. Reused as the "Pick a model"
 * branch from the CRUD submenu so updated configs flow through the same
 * codepath.
 */
async function runFirstRunFlow(
  provider: ProviderInfo,
): Promise<ModelPickerResult | undefined> {
  if (provider.local) {
    return pickLocalModel(provider);
  }

  const hasKey = await ensureProviderKey(provider);
  if (!hasKey) return undefined;

  if (provider.id === 'nvidia') {
    return pickNvidiaModel(provider);
  }

  if (provider.id === 'openrouter') {
    return pickOpenRouterModel(provider);
  }

  const model = await selectModel(provider);
  if (!model) return undefined;

  return { provider: provider.id, model };
}

// ── Provider CRUD submenu ────────────────────────────────────────────

type ProviderAction =
  | 'pick-model'
  | 'update-key'
  | 'update-url'
  | 'remove'
  | 'back'
  | 'cancel';

async function selectProviderAction(
  provider: ProviderInfo,
): Promise<ProviderAction | undefined> {
  const items: SelectItem<ProviderAction>[] = [
    { label: 'Pick a model', value: 'pick-model' },
  ];
  if (provider.local) {
    items.push({
      label: 'Update base URL',
      value: 'update-url',
      hint: getProviderConfig(provider.id)?.baseUrl,
    });
  } else {
    items.push({
      label: 'Update API key',
      value: 'update-key',
      hint: provider.envVar && process.env[provider.envVar] ? `from $${provider.envVar}` : 'stored',
    });
  }
  items.push({ label: 'Remove configuration', value: 'remove' });
  items.push({ label: 'Back to providers', value: 'back' });

  return select(items, { title: `${provider.name} — configured` });
}

async function promptApiKeyUpdate(provider: ProviderInfo): Promise<boolean> {
  console.log();
  console.log(chalk.dim(`  Enter a new API key for ${provider.name} (empty to cancel).`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question(chalk.cyan('  API key: '), (answer) => {
      rl.close();
      const key = answer.trim();
      if (!key) {
        resolve(false);
        return;
      }
      saveProviderKey(provider.id, key);
      setProviderEnv(provider, key);
      resolve(true);
    });
  });
}

async function promptBaseUrlUpdate(provider: ProviderInfo): Promise<boolean> {
  const current = getProviderConfig(provider.id)?.baseUrl;
  const fallback = current ?? provider.defaultBaseUrl ?? DEFAULT_OLLAMA_BASE_URL;
  console.log();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question(chalk.cyan(`  ${provider.name} base URL [${fallback}]: `), (answer) => {
      rl.close();
      const raw = answer.trim() || fallback;
      const url = normalizeOllamaBaseUrl(raw);
      if (!url) {
        resolve(false);
        return;
      }
      saveProviderConfig(provider.id, { baseUrl: url });
      resolve(true);
    });
  });
}

// ── Provider selection ───────────────────────────────────────────────

async function selectProvider(): Promise<ProviderInfo | undefined> {
  const items: SelectItem<ProviderInfo>[] = PROVIDERS.map((p) => {
    const tag = isProviderConfigured(p) ? chalk.green(' ✓') : '';
    return {
      label: p.name + tag,
      value: p,
      hint: p.defaultModel,
    };
  });

  return select(items, { title: 'Select a provider' });
}

// ── Model selection (registry providers) ─────────────────────────────

export async function selectModel(provider: ProviderInfo): Promise<Model<string> | undefined> {
  let models: Model<string>[];
  try {
    models = getModels(provider.id as KnownProvider) as Model<string>[];
  } catch {
    console.log(chalk.red(`  No models found for ${provider.name}`));
    return undefined;
  }

  if (models.length === 0) {
    console.log(chalk.red(`  No models found for ${provider.name}`));
    return undefined;
  }

  const items: SelectItem<Model<string>>[] = models.map((m) => {
    const parts: string[] = [];
    const ctx = formatTokenCount(m.contextWindow);
    parts.push(ctx);
    if (m.reasoning) parts.push('reasoning');
    if (m.cost.input > 0) parts.push(`$${m.cost.input}/${m.cost.output}`);
    return {
      label: m.id,
      value: m,
      hint: parts.join('  '),
    };
  });

  return select(items, { title: `Select a model (${provider.name})`, pageSize: 15 });
}

// ── NVIDIA NIM flow (custom model list, fixed remote base URL) ───────

async function pickNvidiaModel(provider: ProviderInfo): Promise<ModelPickerResult | undefined> {
  const apiKey = process.env[provider.envVar] ?? getStoredKey(provider.id);
  if (!apiKey) {
    console.log(chalk.red(`  No API key configured for ${provider.name}.`));
    return undefined;
  }
  let modelIds: string[];
  try {
    const summaries = await listNvidiaModels(apiKey);
    modelIds = summaries.map((s) => s.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`  Could not fetch NVIDIA model list: ${message}`));
    return undefined;
  }
  if (modelIds.length === 0) {
    console.log(chalk.yellow(`  ${provider.name} returned no models for this key.`));
    return undefined;
  }
  const picked = await select(
    modelIds.map((id) => ({ label: id, value: id })),
    { title: `Select a model (${provider.name})`, pageSize: 15 },
  );
  if (!picked) return undefined;
  return {
    provider: provider.id,
    model: buildNvidiaModel(picked) as Model<string>,
  };
}

// ── OpenRouter flow (live /v1/models catalog, fixed remote base URL) ──

async function pickOpenRouterModel(
  provider: ProviderInfo,
): Promise<ModelPickerResult | undefined> {
  let summaries: OpenRouterModelSummary[];
  try {
    summaries = await listOpenRouterModels();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`  Could not fetch OpenRouter model list: ${message}`));
    return undefined;
  }
  if (summaries.length === 0) {
    console.log(chalk.yellow(`  ${provider.name} returned no models.`));
    return undefined;
  }

  const items: SelectItem<OpenRouterModelSummary>[] = summaries.map((s) => {
    const parts: string[] = [];
    if (s.contextLength) parts.push(formatTokenCount(s.contextLength));
    if (s.reasoning) parts.push('reasoning');
    if (s.promptCost) parts.push(`$${trimCost(s.promptCost)}/${trimCost(s.completionCost ?? 0)}`);
    return { label: s.id, value: s, hint: parts.join('  ') };
  });

  const picked = await select(items, {
    title: `Select a model (${provider.name})`,
    pageSize: 15,
  });
  if (!picked) return undefined;

  // Prefer pi-ai's curated registry metadata when it knows the id; otherwise
  // build from the live summary so brand-new models are still usable.
  const registryModel = getModel('openrouter', picked.id as never) as Model<string> | undefined;
  const model = registryModel ?? (buildOpenRouterModel(picked.id, picked) as Model<string>);
  return { provider: provider.id, model };
}

// ── Local provider flow (ollama) ─────────────────────────────────────

async function pickLocalModel(provider: ProviderInfo): Promise<ModelPickerResult | undefined> {
  const existing = getProviderConfig(provider.id)?.baseUrl;
  const baseUrl = existing ?? (await promptBaseUrl(provider));
  if (!baseUrl) return undefined;

  if (!existing) {
    saveProviderConfig(provider.id, { baseUrl });
  }

  let modelIds: string[];
  try {
    const summaries = await listOllamaModels(baseUrl);
    modelIds = summaries.map((m) => m.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`  Could not reach ${provider.name} at ${baseUrl}: ${message}`));
    return undefined;
  }

  if (modelIds.length === 0) {
    console.log(chalk.yellow(`  No models installed on ${provider.name}. Pull one with "ollama pull <name>".`));
    return undefined;
  }

  const picked = await select(
    modelIds.map((id) => ({ label: id, value: id })),
    { title: `Select a model (${provider.name})`, pageSize: 15 },
  );
  if (!picked) return undefined;

  return {
    provider: provider.id,
    model: buildOllamaModel(picked, baseUrl) as Model<string>,
  };
}

async function promptBaseUrl(provider: ProviderInfo): Promise<string | undefined> {
  const fallback = provider.defaultBaseUrl ?? DEFAULT_OLLAMA_BASE_URL;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string | undefined>((resolve) => {
    rl.question(chalk.cyan(`  ${provider.name} base URL [${fallback}]: `), (answer) => {
      rl.close();
      const raw = answer.trim() || fallback;
      resolve(normalizeOllamaBaseUrl(raw));
    });
  });
}

// ── Key prompt (registry providers) ──────────────────────────────────

async function ensureProviderKey(provider: ProviderInfo): Promise<boolean> {
  if (provider.envVar && process.env[provider.envVar]) return true;

  const stored = getStoredKey(provider.id);
  if (stored) {
    setProviderEnv(provider, stored);
    return true;
  }

  console.log();
  console.log(chalk.yellow(`  No API key found for ${provider.name}.`));
  if (provider.envVar) {
    console.log(chalk.dim(`  Set ${provider.envVar} or enter it now.`));
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise<boolean>((resolve) => {
    rl.question(chalk.cyan('  API key (empty to cancel): '), (answer) => {
      rl.close();
      const key = answer.trim();
      if (!key) {
        resolve(false);
        return;
      }
      saveProviderKey(provider.id, key);
      setProviderEnv(provider, key);
      console.log(chalk.green('  Key saved.'));
      resolve(true);
    });
  });
}

// ── Utilities ────────────────────────────────────────────────────────

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M ctx`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k ctx`;
  return `${tokens} ctx`;
}

/** Trim floating-point noise from per-million-token prices for display. */
function trimCost(usd: number): string {
  return Number.parseFloat(usd.toFixed(4)).toString();
}
