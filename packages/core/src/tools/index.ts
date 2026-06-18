export {
  type BashToolDetails,
  type BashToolInput,
  type BashToolOptions,
  bashTool,
  createBashTool,
} from './bash.js';
export {
  type BashOutputToolDetails,
  type BashOutputToolInput,
  createBashOutputTool,
  formatStatus,
  runtimeSeconds,
} from './bash-output.js';
export {
  type KillShellToolDetails,
  type KillShellToolInput,
  createKillShellTool,
} from './kill-shell.js';
export {
  type EditToolDetails,
  type EditToolInput,
  editTool,
  createEditTool,
} from './edit.js';
export {
  type ReadToolDetails,
  type ReadToolInput,
  readTool,
  createReadTool,
} from './read.js';
export {
  type WriteToolDetails,
  type WriteToolInput,
  writeTool,
  createWriteTool,
} from './write.js';
export {
  type SkillToolDetails,
  type SkillToolInput,
  createSkillTool,
} from './skill.js';
export {
  type MemoryToolDetails,
  type MemoryToolInput,
  memoryTool,
  createMemoryTool,
} from './memory.js';
export {
  type TodoItem,
  type TodoToolDetails,
  type TodoToolInput,
  todoTool,
  createTodoTool,
} from './todo.js';
export {
  type ExitPlanToolDetails,
  type ExitPlanToolInput,
  exitPlanTool,
  createExitPlanTool,
} from './exit-plan.js';
export {
  type HeartbeatToolDetails,
  type HeartbeatToolInput,
  type CreateHeartbeatToolOptions,
  heartbeatTool,
  createHeartbeatTool,
} from './heartbeat-tool.js';
export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  type TruncationResult,
} from './truncate.js';

import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { BackgroundShellManager } from '../background-shells.js';
import type { CommandExecutor } from '../command-executor.js';
import { bashTool, createBashTool } from './bash.js';
import { createBashOutputTool } from './bash-output.js';
import { createKillShellTool } from './kill-shell.js';
import { editTool, createEditTool } from './edit.js';
import { exitPlanTool, createExitPlanTool } from './exit-plan.js';
import { heartbeatTool, createHeartbeatTool, type CreateHeartbeatToolOptions } from './heartbeat-tool.js';
import { memoryTool, createMemoryTool } from './memory.js';
import { readTool, createReadTool } from './read.js';
import { todoTool, createTodoTool } from './todo.js';
import { writeTool, createWriteTool } from './write.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Tool = AgentTool<any>;

export const codingTools: Tool[] = [
  readTool,
  bashTool,
  editTool,
  writeTool,
  todoTool,
  exitPlanTool,
  memoryTool,
  heartbeatTool,
];

export const allTools = {
  read: readTool,
  bash: bashTool,
  edit: editTool,
  write: writeTool,
  todo: todoTool,
  exit_plan: exitPlanTool,
  memory: memoryTool,
  heartbeat: heartbeatTool,
};

export type ToolName = keyof typeof allTools;

export interface CreateCodingToolsOptions {
  /** Manager for `run_in_background` shells; also enables the bash_output / kill_shell tools. */
  backgroundShells?: BackgroundShellManager;
  /** Where the `bash` tool runs commands. Defaults to the host shell executor. */
  executor?: CommandExecutor;
  /** Command working directory when it differs from the file-tool `cwd`. */
  execCwd?: string;
  /** Overrides for the `heartbeat` tool (cli/node paths, crontab I/O). Defaults derive from `process`. */
  heartbeat?: CreateHeartbeatToolOptions;
}

export function createCodingTools(cwd: string, options: CreateCodingToolsOptions = {}): Tool[] {
  const { backgroundShells, executor, execCwd } = options;
  const tools: Tool[] = [
    createReadTool(cwd),
    createBashTool(cwd, { backgroundShells, executor, execCwd }),
    createEditTool(cwd),
    createWriteTool(cwd),
    createTodoTool(),
    createExitPlanTool(),
    createMemoryTool(cwd),
    createHeartbeatTool(cwd, options.heartbeat),
  ];
  // The background-shell companions only exist when a manager is wired in
  // (i.e. background execution is enabled for this session).
  if (backgroundShells) {
    tools.push(createBashOutputTool(backgroundShells), createKillShellTool(backgroundShells));
  }
  return tools;
}

export function createAllTools(cwd: string): Record<ToolName, Tool> {
  return {
    read: createReadTool(cwd),
    bash: createBashTool(cwd),
    edit: createEditTool(cwd),
    write: createWriteTool(cwd),
    todo: createTodoTool(),
    exit_plan: createExitPlanTool(),
    memory: createMemoryTool(cwd),
    heartbeat: createHeartbeatTool(cwd),
  };
}
