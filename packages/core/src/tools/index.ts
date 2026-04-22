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
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  type TruncationResult,
} from './truncate.js';

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { bashTool, createBashTool } from './bash.js';
import { editTool, createEditTool } from './edit.js';
import { readTool, createReadTool } from './read.js';
import { writeTool, createWriteTool } from './write.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Tool = AgentTool<any>;

export const codingTools: Tool[] = [readTool, bashTool, editTool, writeTool];

export const allTools = {
  read: readTool,
  bash: bashTool,
  edit: editTool,
  write: writeTool,
};

export type ToolName = keyof typeof allTools;

export function createCodingTools(cwd: string): Tool[] {
  return [createReadTool(cwd), createBashTool(cwd), createEditTool(cwd), createWriteTool(cwd)];
}

export function createAllTools(cwd: string): Record<ToolName, Tool> {
  return {
    read: createReadTool(cwd),
    bash: createBashTool(cwd),
    edit: createEditTool(cwd),
    write: createWriteTool(cwd),
  };
}
