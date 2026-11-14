import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: vi.fn() }));

import { __setUpstreamFetchForTests } from './forward';
import { discoverChatGptPlanCatalog } from './planDiscovery';

const config = {
  source: 'gateway', kind: 'chatgpt_plan', partnerId: 'p', connectionId: 'c',
  configVersion: 1, baseUrl: 'https://subscription.example.com/v1',
} as const;
const credential = { secret: 'synthetic-test-worker-credential' };

afterEach(() => { __setUpstreamFetchForTests(null); vi.restoreAllMocks(); });

describe('ChatGPT plan catalog transport', () => {
  it('uses the guarded gateway with the same credential, path, body cap and deadline', async () => {
    const payload = { observed_at: '2026-10-01T00:00:00Z', models: [] };
    const fetch = vi.fn(async () => Response.json(payload));
    __setUpstreamFetchForTests(fetch);
    await expect(discoverChatGptPlanCatalog({ config, credential })).resolves.toEqual(payload);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(url).toBe('https://subscription.example.com/v1/models');
    expect(options).toMatchObject({ method: 'GET', redirect: 'error', streamResponse: false, maxBytes: 128_000 });
    expect(options.headers).toMatchObject({ authorization: `Bearer ${credential.secret}`, accept: 'application/json' });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects non-success responses without returning their body', async () => {
    __setUpstreamFetchForTests(vi.fn(async () => new Response('private upstream detail', { status: 401 })));
    await expect(discoverChatGptPlanCatalog({ config, credential })).rejects.toThrow('ChatGPT account catalog unavailable');
  });

  it('propagates transport failures and rejects malformed JSON', async () => {
    __setUpstreamFetchForTests(vi.fn(async () => { throw new Error('transport failed'); }));
    await expect(discoverChatGptPlanCatalog({ config, credential })).rejects.toThrow();
    __setUpstreamFetchForTests(vi.fn(async () => new Response('not JSON')));
    await expect(discoverChatGptPlanCatalog({ config, credential })).rejects.toThrow();
  });
});
