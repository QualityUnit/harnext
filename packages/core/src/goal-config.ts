import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getModels } from '@mariozechner/pi-ai';
import type { KnownProvider } from '@mariozechner/pi-ai';

import { getAgentDir } from './config.js';

export type GoalPhase = 'planner' | 'generator' | 'evaluator';

export const GOAL_PHASES: GoalPhase[] = ['planner', 'generator', 'evaluator'];

export interface GoalPhaseModel {
  provider: string;
  modelId: string;
}

/** Per-phase model overrides persisted by /set-goal-config. */
export interface GoalConfig {
  planner?: GoalPhaseModel;
  generator?: GoalPhaseModel;
  evaluator?: GoalPhaseModel;
}

export interface ResolvedGoalModels {
  planner: GoalPhaseModel;
  generator: GoalPhaseModel;
  evaluator: GoalPhaseModel;
  /** Phases that fell back to provider defaults (not set via /set-goal-config). */
  defaulted: GoalPhase[];
}

function getGoalConfigPath(): string {
  return join(getAgentDir(), 'goal-config.json');
}

export function loadGoalConfig(): GoalConfig {
  const path = getGoalConfigPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as GoalConfig;
  } catch {
    return {};
  }
}

export function saveGoalConfig(config: GoalConfig): void {
  const path = getGoalConfigPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Newest registry model whose id contains `family` (e.g. 'opus', 'haiku').
 * Rolling aliases are preferred over dated pins (claude-haiku-4-5 over
 * claude-haiku-4-5-20251001) so defaults track new releases automatically.
 */
function latestRegistryModel(provider: string, family: string): string | undefined {
  let ids: string[];
  try {
    ids = getModels(provider as KnownProvider).map((m) => m.id);
  } catch {
    return undefined;
  }
  const familyIds = ids.filter((id) => id.includes(family));
  if (familyIds.length === 0) return undefined;
  const undated = familyIds.filter((id) => !/-\d{8}$/.test(id));
  const pool = undated.length > 0 ? undated : familyIds;
  return [...pool].sort().at(-1);
}

/**
 * Strong (planner/evaluator) and fast (generator) default model ids for a
 * provider. Providers without a known strong/fast pairing use the active
 * model for every phase — /set-goal-config can override per phase.
 */
function defaultModelsForProvider(
  provider: string,
  activeModelId: string,
): { strong: string; fast: string } {
  if (provider === 'anthropic') {
    return {
      strong: latestRegistryModel('anthropic', 'opus') ?? activeModelId,
      fast: latestRegistryModel('anthropic', 'haiku') ?? activeModelId,
    };
  }
  if (provider === 'openrouter') {
    return {
      strong: 'deepseek/deepseek-v4-pro',
      fast: 'deepseek/deepseek-v4-flash',
    };
  }
  return { strong: activeModelId, fast: activeModelId };
}

/**
 * Resolve the model for each /goal phase: explicit /set-goal-config entries
 * win; unset phases fall back to the active provider's strong/fast defaults
 * (planner and evaluator strong, generator fast).
 */
export function resolveGoalModels(
  activeProvider: string,
  activeModelId: string,
  config: GoalConfig = loadGoalConfig(),
): ResolvedGoalModels {
  const defaults = defaultModelsForProvider(activeProvider, activeModelId);
  const defaulted: GoalPhase[] = [];
  const resolve = (phase: GoalPhase, fallbackId: string): GoalPhaseModel => {
    const configured = config[phase];
    if (configured) return configured;
    defaulted.push(phase);
    return { provider: activeProvider, modelId: fallbackId };
  };
  return {
    planner: resolve('planner', defaults.strong),
    generator: resolve('generator', defaults.fast),
    evaluator: resolve('evaluator', defaults.strong),
    defaulted,
  };
}
