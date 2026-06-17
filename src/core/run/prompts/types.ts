/**
 * prompts/types.ts — shared types for the M41 adaptive prompt suite.
 */

import type { ModelProfile } from '../model-profile.js';

/** Which agent role a system prompt is being assembled for. */
export type PromptRole = 'executor' | 'planner' | 'synthesizer' | 'swarm-phase';

/** A single composable layer of the assembled system prompt. */
export interface PromptLayer {
  /** Stable key for budgeting/telemetry. */
  key: 'base' | 'tool' | 'output' | 'role' | 'memory';
  /** Rendered text for this layer (already verbosity-resolved). */
  text: string;
  /**
   * Trim priority: LOWER is dropped/truncated first under budget pressure.
   * Memory is lowest; the discipline layers (base/tool/output/role) are
   * protected and only hard-truncated as a last resort.
   */
  priority: number;
}

export interface AssembleOptions {
  role: PromptRole;
  /** Whether the serving client supports tool calls (tool vs no-tool layer). */
  useTools: boolean;
  /** Resolved capability profile (drives verbosity + tool-format hint). */
  profile: ModelProfile;
  /** Optional caller-injected memory (genome recall / playbook). */
  memory?: string;
  /** Hard char ceiling for the whole prompt. Defaults to profile.promptCharCap. */
  charCap?: number;
}

export interface AssembledPrompt {
  /** Final system-prompt string (≤ charCap). */
  system: string;
  /** Which layers survived (for tests/telemetry). */
  included: PromptLayer['key'][];
  /** Char count of the result. */
  chars: number;
}
