import { GOAL_PHASES, loadGoalConfig, resolveGoalModels, saveGoalConfig } from '@harnext/core';
import type { GoalPhase } from '@harnext/core';
import chalk from 'chalk';

import { pickModel } from './model-picker.js';
import { select } from './select.js';
import type { SelectItem } from './select.js';

type ConfigAction = GoalPhase | 'reset' | 'done';

/**
 * Interactive /set-goal-config flow: shows the resolved model per /goal
 * phase (explicit config or provider default), lets the user re-pick any
 * phase via the standard provider/model picker, and persists the overrides
 * to ~/.harnext/agent/goal-config.json.
 */
export async function runSetGoalConfigCommand(
  activeProvider: string,
  activeModelId: string,
): Promise<void> {
  while (true) {
    const config = loadGoalConfig();
    const resolved = resolveGoalModels(activeProvider, activeModelId, config);

    console.log();
    console.log(chalk.bold('  /goal phase models:'));
    for (const phase of GOAL_PHASES) {
      const model = resolved[phase];
      const tag = resolved.defaulted.includes(phase) ? chalk.dim(' (default)') : '';
      console.log(
        `  ${phase.padEnd(10)}` + chalk.cyan(`${model.provider}/${model.modelId}`) + tag,
      );
    }
    console.log();

    const items: SelectItem<ConfigAction>[] = [
      { label: 'Planner', value: 'planner', hint: 'writes the blueprint — strong model' },
      { label: 'Generator', value: 'generator', hint: 'implements the blueprint — fast model' },
      { label: 'Evaluator', value: 'evaluator', hint: 'reviews the changes — strong model' },
      { label: 'Reset to defaults', value: 'reset', hint: 'clear all overrides' },
      { label: 'Done', value: 'done' },
    ];
    const action = await select(items, { title: 'Set a model for a phase' });
    if (!action || action === 'done') {
      console.log();
      return;
    }
    if (action === 'reset') {
      saveGoalConfig({});
      console.log(chalk.dim('  Cleared overrides — back to provider defaults.'));
      continue;
    }

    const picked = await pickModel();
    if (!picked) {
      console.log(chalk.dim('  Cancelled.'));
      continue;
    }
    saveGoalConfig({
      ...config,
      [action]: { provider: picked.provider, modelId: picked.model.id },
    });
    console.log(
      chalk.green(`  ${action} set to `) + chalk.bold(`${picked.provider}/${picked.model.id}`),
    );
  }
}
