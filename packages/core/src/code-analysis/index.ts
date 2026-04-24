/**
 * Public surface of the code-analysis pipeline. Re-exported from
 * `@harnext/core` so CLI call sites only need the package-level barrel.
 */

export { runCodeAnalysisPipeline, ANALYSIS_PHASES } from './pipeline.js';

export type {
  AnalysisEvent,
  AnalysisError,
  AnalysisPhase,
  PackageTech,
  RunCodeAnalysisOptions,
  RunCodeAnalysisResult,
  TechStack,
} from './types.js';

export {
  TECH_STACK_FILE,
  coercePackageTech,
  coerceTechStack,
  getTechStackPath,
  isPackageTech,
  isTechStack,
  loadTechStack,
  saveTechStack,
  synthesizeMinimalTechStack,
} from './schemas/tech-stack.js';

export {
  RISK_CONTRACT_FILE,
  coerceRiskContract,
  defaultRiskContract,
  getContractPath,
  isMergePolicyEntry,
  isRiskContract,
  loadRiskContract,
  saveRiskContract,
  unionRequiredChecks,
  type CoerceRiskContractResult,
  type MergePolicyEntry,
  type RiskContract,
} from './schemas/risk-contract.js';

export {
  SCRIPTS_SUBDIR,
  checkScriptEntry,
  ensureScriptsDir,
  getScriptsDir,
  listExistingScriptFiles,
  partitionChecks,
  slugifyCheckId,
  type CheckScriptEntry,
} from './schemas/check-scripts.js';

export {
  installBundledSkills,
  resolveAgentSkillsDir,
  type InstallBundledSkillsResult,
} from './stages/install-bundled-skills.js';

export {
  DEFAULT_GENERATED_SKILL_SLUGS,
  hasValidFrontmatter,
  runProjectSkillsStage,
  type RunProjectSkillsStageOptions,
  type RunProjectSkillsStageResult,
} from './stages/project-skills.js';

export {
  applyGeneratedPrompts,
  coerceStagePrompts,
  runStagePromptsStage,
  type GeneratedStagePrompt,
  type RunStagePromptsStageOptions,
  type RunStagePromptsStageResult,
  type StagePromptSpec,
} from './stages/stage-prompts.js';

export {
  CODE_ANALYSIS_MAX_TURNS,
  runCodingAgent,
  type RunCodingAgentOptions,
  type RunCodingAgentResult,
} from './run-coding-agent.js';

export { createSessionDir, type SessionDir, type ManifestEntry } from './session-dir.js';

export {
  getBundledPromptsDir,
  loadPrompt,
  renderPrompt,
  type LoadedPrompt,
  type PromptId,
} from './prompt-loader.js';
