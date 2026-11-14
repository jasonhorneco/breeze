import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:fs', () => ({ readFileSync: vi.fn(() => 'a'.repeat(48)) }));
import { planCandidate } from './planCandidate';
import type { Offering } from './offerings';
import type { PartnerAiConnection } from './connections';

const fixtureDate = new Date('2026-01-01T00:00:00Z');
const conn: PartnerAiConnection = {
  id: 'fixture-connection', partnerId: 'fixture-partner', kind: 'chatgpt_plan',
  status: 'active', configVersion: 2, connectedBy: 'fixture-owner',
  name: 'Fixture plan', providerConfig: { orgId: 'fixture-org' },
  inferenceGeo: null, keyLast4: null, catalogEntryId: null, baseUrl: null,
  lastError: null, verifiedAt: fixtureDate, lastDiscoveredAt: null, discoveryError: null,
  createdAt: fixtureDate, updatedAt: fixtureDate,
};

function offering(over: Partial<Offering> = {}): Offering {
  return {
    id: 'fixture-offering', partnerId: conn.partnerId, connectionId: conn.id,
    platformModelId: null, source: 'manual', enabled: true,
    lifecycle: 'available', modelId: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol',
    capabilities: { chatgptPlan: { efforts: ['low', 'high'], defaultEffort: 'low' } },
    defaultOptions: { effort: 'high' }, allowedOptions: null,
    toolProfile: 'auto', toolAllowlist: null, requiredPermission: null,
    refusalFallbackOfferingId: null, lastSeenAt: null, missedSyncCount: 0,
    priceInputCentsPerM: null, priceOutputCentsPerM: null,
    priceCacheReadCentsPerM: null, priceCacheWriteCentsPerM: null,
    contextWindowOverride: null, contextWindowDiscovered: null, contextWindowObserved: null,
    contextWindowObservedAt: null, contextWindowObservedConfigVersion: null,
    createdAt: fixtureDate, updatedAt: fixtureDate, ...over,
  };
}

function candidate(over: Partial<Offering> = {}) {
  vi.stubEnv('BREEZE_CODEX_PLAN_WORKER_URL', 'https://worker.example.test');
  vi.stubEnv('BREEZE_CODEX_PLAN_WORKER_KEY_FILE', 'fixture-key-file');
  vi.stubEnv('BREEZE_CODEX_PLAN_CONNECTION_ID', conn.id);
  return planCandidate(offering(over), conn);
}

afterEach(() => vi.unstubAllEnvs());

describe('subscription candidate tool and window settings', () => {
  it('carries saved profiles and context through the normal gateway facts', () => {
    const c = candidate({ toolProfile: 'standard', contextWindowOverride: 64000 });
    expect(c.toolProfileFacts).toEqual({
      toolProfile: 'standard', toolAllowlist: null, effectiveWindow: 64000, transport: 'gateway',
    });
    expect(c.limits.maxInputTokens).toBe(64000);
    expect(c.contextWindow).toEqual({ window: 64000, source: 'override' });
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
    const c = planCandidate(offering({
      modelId: 'gpt-6-luna', capabilities: { chatgptPlan: { efforts: [], defaultEffort: null } },
    }), conn);
    expect(c.connection).toBeNull();
    expect(c.facts.connection?.keyUsable).toBe(false);
    expect(c.funding).toBe('chatgpt_plan');
    expect(c.refusalFallbackOfferingId).toBeNull();
  });
});
