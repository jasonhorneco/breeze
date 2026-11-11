import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CandidateFacts, EligibilityContext } from '../aiModels/eligibility';

const m = vi.hoisted(() => ({
  candidate: vi.fn(),
  assignment: vi.fn(),
}));
vi.mock('../../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../aiModels/assignments', () => ({
  getEffectiveAssignment: m.assignment,
  isPermitted: () => true,
}));
vi.mock('../aiModels/candidateLoader', () => ({
  loadOfferingCandidate: m.candidate,
  readOrgPartnerId: async () => 'partner',
}));
vi.mock('../aiModels/registryCutover', () => ({ ensurePartnerCutover: async () => true }));
vi.mock('../aiModels/transport', () => ({ defaultTransport: () => 'agent_sdk' }));
vi.mock('../aiModels/resolveModel', () => ({
  unavailableMessage: (reason: string) => reason,
  eligibilityContextFor: async (input: {
    partnerId: string; orgId: string | null; userId?: string; planUserSession?: boolean;
  }): Promise<EligibilityContext> => ({
    partnerId: input.partnerId, surface: 'ai_agents', partnerPlan: 'community',
    hosted: false, residencyRequired: false, geoCarriable: false,
    userInitiated: !!input.userId, userHoldsPermission: () => false,
    ...(input.planUserSession && input.userId && input.orgId ? {
      planPrincipal: { userId: input.userId, orgId: input.orgId },
    } : {}),
  }),
}));

// Keep the real eligibility rules: the regression occurs when the partner
// policy's null org prevents the subscription owner's principal being formed.
import { bindAgentOffering } from './agentOfferingBinding';

const owner = { partnerId: 'partner', orgId: null };
const writer = { userId: 'subscriber', planUserSession: true };
const facts: CandidateFacts = {
  ownerPartnerId: 'partner', enabled: true, lifecycle: 'available',
  requiredPermission: null, platform: null, catalog: null,
  connection: { kind: 'chatgpt_plan', status: 'active', keyUsable: true },
  rate: { source: 'offering', standard: {
    inputCentsPerM: 0, outputCentsPerM: 0, cacheReadCentsPerM: 0, cacheWriteCentsPerM: 0,
  } },
  supportsTools: true, inferenceGeo: null, supportedInferenceGeos: [],
  planOwnerId: 'subscriber', planOrgId: 'home',
};

beforeEach(() => {
  vi.clearAllMocks();
  m.assignment.mockResolvedValue({ permitted: { kind: 'all' }, defaultOfferingId: 'codex' });
  m.candidate.mockResolvedValue({ funding: 'chatgpt_plan', facts });
});

describe('subscription model binding for native agent policies', () => {
  it('lets the subscription owner select a model for a partner-wide agent', async () => {
    await expect(bindAgentOffering(owner, 'codex', writer)).resolves.toEqual({
      offeringId: 'codex', offeringPartnerId: 'partner',
    });
    expect(m.assignment).toHaveBeenCalledWith({
      partnerId: 'partner', orgId: null, surface: 'ai_agents', role: 'default',
    });
  });

  it('allows an organization policy in the subscription organization', async () => {
    await expect(bindAgentOffering({ partnerId: null, orgId: 'home' }, 'codex', writer))
      .resolves.toMatchObject({ offeringId: 'codex' });
  });

  it('does not borrow subscription consent for another organization', async () => {
    await expect(bindAgentOffering({ partnerId: null, orgId: 'other' }, 'codex', writer))
      .rejects.toMatchObject({ code: 'not_permitted' });
  });

  it.each([
    { userId: 'another-user', planUserSession: true },
    { userId: 'subscriber', planUserSession: false },
    { userId: 'subscriber' },
    { userId: '', planUserSession: true },
  ])('requires the subscription owner in an interactive session: %j', async (untrustedWriter) => {
    await expect(bindAgentOffering(owner, 'codex', untrustedWriter))
      .rejects.toMatchObject({ code: 'not_permitted' });
  });

  it.each([
    { planOwnerId: null }, { planOrgId: null }, { ownerPartnerId: 'foreign' },
  ])('retains subscription ownership checks: %j', async (changed) => {
    m.candidate.mockResolvedValue({ funding: 'chatgpt_plan', facts: { ...facts, ...changed } });
    await expect(bindAgentOffering(owner, 'codex', writer))
      .rejects.toMatchObject({ code: 'not_permitted' });
  });

  it('retains the normal permission requirement for the policy writer', async () => {
    m.candidate.mockResolvedValue({ funding: 'chatgpt_plan', facts: { ...facts, requiredPermission: 'ai:premium' } });
    await expect(bindAgentOffering(owner, 'codex', writer))
      .rejects.toMatchObject({ code: 'permission_required', status: 403 });
  });
});
