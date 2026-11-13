import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:fs', () => ({ readFileSync: vi.fn(() => 'a'.repeat(48)) }));
import { planCandidate } from './planCandidate';
import type { Offering } from './offerings';
import type { PartnerAiConnection } from './connections';

const conn = {
  id: 'fixture-connection', partnerId: 'fixture-partner', kind: 'chatgpt_plan',
  status: 'active', configVersion: 2, connectedBy: 'fixture-owner',
  providerConfig: { orgId: 'fixture-org' },
} as PartnerAiConnection;

function candidate(over: Partial<Offering> = {}) {
  vi.stubEnv('BREEZE_CODEX_PLAN_WORKER_URL', 'https://worker.example.test');
  vi.stubEnv('BREEZE_CODEX_PLAN_WORKER_KEY_FILE', 'fixture-key-file');
  vi.stubEnv('BREEZE_CODEX_PLAN_CONNECTION_ID', conn.id);
  return planCandidate({
    id: 'fixture-offering', partnerId: conn.partnerId, enabled: true,
    lifecycle: 'available', modelId: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol',
    capabilities: { chatgptPlan: { efforts: ['low', 'high'], defaultEffort: 'low' } },
    defaultOptions: { effort: 'high' }, toolProfile: 'auto', toolAllowlist: null,
    ...over,
  } as Offering, conn);
}

afterEach(() => vi.unstubAllEnvs());

describe('subscription candidate tool and window settings', () => {
  it('carries saved profiles and context through the normal gateway facts', () => {
    const c = candidate({ toolProfile: 'standard', contextWindowOverride: 64000 });
    expect(c.toolProfileFacts).toEqual({
      toolProfile: 'standard', toolAllowlist: null, effectiveWindow: 64000, transport: 'gateway',
    });
    expect(c.limits.maxInputTokens).toBe(64000);
    expect(c.defaultOptions).toEqual({ effort: 'high' });
    expect(c.logicalModel).toBe('gpt-6.1-sol');
    expect(c.funding).toBe('chatgpt_plan');
    expect(c.refusalFallbackOfferingId).toBeNull();
    expect(c.facts).toMatchObject({ planOwnerId: 'fixture-owner', planOrgId: 'fixture-org' });
  });

  it('leaves an unknown window unknown and preserves a custom allowlist', () => {
    const toolAllowlist = { domains: [], tools: ['query_devices'] };
    const c = candidate({ toolProfile: 'custom', toolAllowlist });
    expect(c.toolProfileFacts).toEqual({
      toolProfile: 'custom', toolAllowlist, effectiveWindow: null, transport: 'gateway',
    });
    expect(c.limits.maxInputTokens).toBeNull();
  });

  it('uses fresh observations only for the current connection version', () => {
    const fields = { contextWindowDiscovered: 128000, contextWindowObserved: 32000,
      contextWindowObservedAt: new Date(), contextWindowObservedConfigVersion: 2 };
    expect(candidate(fields).toolProfileFacts?.effectiveWindow).toBe(32000);
    expect(candidate({ ...fields, contextWindowObservedConfigVersion: 1 }).toolProfileFacts?.effectiveWindow).toBe(128000);
  });

  it('does not turn a missing worker binding into a paid fallback', () => {
    candidate();
    vi.stubEnv('BREEZE_CODEX_PLAN_CONNECTION_ID', 'different-connection');
    const c = planCandidate({
      modelId: 'gpt-6-luna', capabilities: { chatgptPlan: { efforts: [], defaultEffort: null } },
    } as Offering, conn);
    expect(c.connection).toBeNull();
    expect(c.facts.connection?.keyUsable).toBe(false);
    expect(c.funding).toBe('chatgpt_plan');
    expect(c.refusalFallbackOfferingId).toBeNull();
  });
});
