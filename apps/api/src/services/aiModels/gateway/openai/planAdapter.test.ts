import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: () => {} }));

import { __setUpstreamFetchForTests, setGatewayConnectionCheck } from '../forward';
import { startModelGateway, type ModelGateway } from '../server';
import { __resetGatewayFailureNotesForTests, takeGatewayFailureNote } from '../failureNotes';
import { GATEWAY_PLACEHOLDER_KEY } from './adapter';
import { encodeSse } from './sse';
import './planAdapter';

const model = 'gpt-6-luna';
const request = { model, max_tokens: 256, messages: [{ role: 'user' as const, content: 'Explain this stored alert.' }] };
let gateway: ModelGateway;
let calls: number;
let reply: () => Response;

function completed() {
  return new Response(encodeSse('response.completed', {
    type: 'response.completed', response: {
      status: 'completed', model,
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Read the stored evidence.' }] }],
      usage: { input_tokens: 20, output_tokens: 5 },
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

function client(maxRetries = 0) {
  const grant = gateway.grant({
    config: {
      source: 'gateway', kind: 'chatgpt_plan', partnerId: 'fixture-partner',
      connectionId: 'fixture-plan-connection', configVersion: 1,
      baseUrl: 'https://plan-worker.example.test', effort: 'low',
    },
    credential: { secret: 'fixture-worker-credential' }, wireModels: [model],
    orgId: 'fixture-org', aiSessionId: 'fixture-session', purpose: 'dispatch',
  });
  return {
    grant,
    sdk: new Anthropic({ baseURL: grant.baseUrl, apiKey: GATEWAY_PLACEHOLDER_KEY, maxRetries }),
  };
}

beforeEach(async () => {
  calls = 0;
  reply = completed;
  __resetGatewayFailureNotesForTests();
  gateway = await startModelGateway();
  __setUpstreamFetchForTests((async () => { calls += 1; return reply(); }) as never);
});

afterEach(async () => {
  __setUpstreamFetchForTests(null);
  setGatewayConnectionCheck(null);
  await gateway.close();
});

describe('native ChatGPT plan gateway request semantics', () => {
  it('allows identical legitimate requests and reports each response usage', async () => {
    const { sdk } = client();
    const first = await sdk.messages.create(request);
    const second = await sdk.messages.create(request);
    expect(calls).toBe(2);
    expect(first.content).toEqual(second.content);
    expect(first.usage).toMatchObject({ input_tokens: 20, output_tokens: 5 });
    expect(second.usage).toMatchObject({ input_tokens: 20, output_tokens: 5 });
  });

  it('does not impose an adapter-specific 32-request ceiling', async () => {
    const { sdk } = client();
    for (let index = 0; index < 33; index += 1) {
      await sdk.messages.create({ ...request, messages: [{ role: 'user', content: `Stored observation ${index}` }] });
    }
    expect(calls).toBe(33);
  });

  it('lets the ordinary SDK retry a busy worker and receive the next response', async () => {
    reply = () => calls === 1 ? Response.json({ error: 'plan_worker_busy' }, { status: 409 }) : completed();
    const result = await client(1).sdk.messages.create(request);
    expect(calls).toBe(2);
    expect(result.content).toMatchObject([{ type: 'text', text: 'Read the stored evidence.' }]);
  });

  it('keeps persistent busy retries bounded by the caller and preserves the reason', async () => {
    reply = () => Response.json({ error: 'plan_worker_busy' }, { status: 409 });
    await expect(client(1).sdk.messages.create(request)).rejects.toMatchObject({ status: 429 });
    expect(calls).toBe(2);
    expect(takeGatewayFailureNote('fixture-session')).toContain('worker is busy');
  });

  it('does not replace a failed attempt with a synthetic repeated-request refusal', async () => {
    const { sdk } = client();
    reply = () => new Response(null, { status: 503 });
    await expect(sdk.messages.create(request)).rejects.toMatchObject({ status: 502 });
    reply = completed;
    await expect(sdk.messages.create(request)).resolves.toMatchObject({ model });
    expect(calls).toBe(2);
  });

  it('keeps subscription limit failures distinct from worker contention', async () => {
    reply = () => new Response(null, { status: 429 });
    await expect(client().sdk.messages.create(request)).rejects.toMatchObject({ status: 429 });
    expect(calls).toBe(1);
    expect(takeGatewayFailureNote('fixture-session')).toContain('plan limit');
  });

  it('still refuses revoked grants before forwarding', async () => {
    const { sdk, grant } = client();
    grant.revoke();
    await expect(sdk.messages.create(request)).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(0);
  });

  it('still validates the live connection version before every request', async () => {
    const { sdk } = client();
    await sdk.messages.create(request);
    setGatewayConnectionCheck(async () => false);
    await expect(sdk.messages.create(request)).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(1);
  });

  it('does not let a request choose an unbound model', async () => {
    await expect(client().sdk.messages.create({ ...request, model: 'unbound-fixture-model' }))
      .rejects.toMatchObject({ status: 403 });
    expect(calls).toBe(0);
  });
});
