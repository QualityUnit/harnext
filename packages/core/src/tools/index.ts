export {
  type BashToolDetails,
  type BashToolInput,
  bashTool,
  createBashTool,
} from './bash.js';
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
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  type TruncationResult,
} from './truncate.js';

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { bashTool, createBashTool } from './bash.js';
import { editTool, createEditTool } from './edit.js';
import { exitPlanTool, createExitPlanTool } from './exit-plan.js';
import { readTool, createReadTool } from './read.js';
import { todoTool, createTodoTool } from './todo.js';
import { writeTool, createWriteTool } from './write.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Tool = AgentTool<any>;

export const codingTools: Tool[] = [readTool, bashTool, editTool, writeTool, todoTool, exitPlanTool];

export const allTools = {
  read: readTool,
  bash: bashTool,
  edit: editTool,
  write: writeTool,
  todo: todoTool,
  exit_plan: exitPlanTool,
};

export type ToolName = keyof typeof allTools;

export function createCodingTools(cwd: string): Tool[] {
  return [
    createReadTool(cwd),
    createBashTool(cwd),
    createEditTool(cwd),
    createWriteTool(cwd),
    createTodoTool(),
    createExitPlanTool(),
  ];
}

export function createAllTools(cwd: string): Record<ToolName, Tool> {
  return {
    read: createReadTool(cwd),
    bash: createBashTool(cwd),
    edit: createEditTool(cwd),
    write: createWriteTool(cwd),
    todo: createTodoTool(),
    exit_plan: createExitPlanTool(),
  };
}
