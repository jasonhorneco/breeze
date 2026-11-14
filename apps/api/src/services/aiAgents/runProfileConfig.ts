/** Shared profile policy metadata: no run orchestration, I/O or endpoint handlers. */
import type { AiAgentLimits } from '@breeze/shared';
import type { OutcomeToolRunRef } from './outcomeTools';
import { isVerdictProfile, verdictLimits, verdictToolAllowlist } from './verdictProfile';
import { isSweepProfile, sweepLimits, sweepToolAllowlist } from './sweepProfile';
import { isNarrativeProfile, narrativeLimits, narrativeToolAllowlist } from './narrativeProfile';
import { isTriageProfile, triageLimits, triageToolAllowlist } from './triageProfile';
import { isDesignProfile, designLimits, designToolAllowlist } from './designProfile';
import { isPatchProfile, patchLimits, patchToolAllowlist } from './patchProfile';
import { isResearchProfile, researchDepthOf, researchLimits, researchToolAllowlist } from './researchProfile';
import { isAnalysisProfile, analysisLimits, analysisToolAllowlist } from './analysisProfile';
import { isAssessmentProfile, assessmentLimits, assessmentToolAllowlist } from './assessmentProfile';

/** `triggerRef` is read only by `remediation_research` (its depth); optional so every other call site stays valid. */
export type RunProfileRef = OutcomeToolRunRef & { triggerRef?: Record<string, unknown> | null };

/**
 * The run's effective limits: each narrow profile pins its own turn, budget
 * (and, for `analysis`, wall-clock) ceilings; `full` keeps the policy's. See
 * `driveSdkLoop` for why each arm exists. Exported so the tool-selection
 * harness judges tool search against the run's REAL turn cap.
 */
export function resolveRunProfileLimits(run: RunProfileRef, limits: AiAgentLimits): AiAgentLimits {
  if (isVerdictProfile(run)) return verdictLimits(limits);
  if (isSweepProfile(run)) return sweepLimits(limits);
  if (isNarrativeProfile(run)) return narrativeLimits(limits);
  if (isTriageProfile(run)) return triageLimits(limits);
  if (isDesignProfile(run)) return designLimits(limits);
  if (isPatchProfile(run)) return patchLimits(limits);
  if (isResearchProfile(run)) return researchLimits(limits, researchDepthOf(run.triggerRef));
  if (isAnalysisProfile(run)) return analysisLimits(limits);
  if (isAssessmentProfile(run)) return assessmentLimits(limits);
  return limits;
}

/**
 * A narrow profile's pinned tool floor — used for BOTH authority
 * (`guardrailPolicy.toolAllowlist`) and exposure. `null` for `full`: nothing
 * to narrow, authority stays the agent's own allowlist.
 */
export function resolveRunProfileToolAllowlist(run: RunProfileRef, agentAllowlist: string[]): string[] | null {
  if (isVerdictProfile(run)) return verdictToolAllowlist(agentAllowlist);
  if (isSweepProfile(run)) return sweepToolAllowlist(agentAllowlist);
  if (isNarrativeProfile(run)) return narrativeToolAllowlist(agentAllowlist);
  if (isTriageProfile(run)) return triageToolAllowlist(agentAllowlist);
  if (isDesignProfile(run)) return designToolAllowlist(agentAllowlist);
  if (isPatchProfile(run)) return patchToolAllowlist(agentAllowlist);
  if (isResearchProfile(run)) return researchToolAllowlist(agentAllowlist);
  if (isAnalysisProfile(run)) return analysisToolAllowlist(agentAllowlist);
  if (isAssessmentProfile(run)) return assessmentToolAllowlist(agentAllowlist);
  return null;
}

