import { createHash } from 'node:crypto';
import { assertBoundModel, registerGatewayAdapter, type GatewayAdapter } from '../adapter';
import { joinByoUrl } from '../byoEndpointPolicy';
import { noteGatewayFailure } from '../failureNotes';
import { forwardUpstream } from '../forward';
import { GatewayError, type GatewayGrantRecord, type GatewayResponse } from '../types';
import { estimateInputTokens, openAiCompatibleAdapter } from './adapter';
import { encodeSse } from './sse';
import { translatePlanRequest } from './translatePlanRequest';
import { translatePlanResponse } from './translatePlanResponse';
import type { AnthropicMessage } from './translateResponse';

const attempts = new WeakMap<GatewayGrantRecord, Set<string>>();
const json = (body: unknown): GatewayResponse => ({
  status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)),
});

function recordAttempt(grant: GatewayGrantRecord, body: string): void {
  const digest = createHash('sha256').update(body).digest('hex');
  let seen = attempts.get(grant);
  if (!seen) {
    seen = new Set();
    attempts.set(grant, seen);
  }
  if (seen.has(digest) || seen.size >= 32) {
    throw new GatewayError(409, 'invalid_request_error', 'plan_request_repeated', 'The ChatGPT plan request was already attempted.');
  }
  seen.add(digest);
}

async function* messageEvents(message: AnthropicMessage) {
  yield encodeSse('message_start', {
    type: 'message_start',
    message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } },
  });
  for (const [index, block] of message.content.entries()) {
    const start = block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} };
    const delta = block.type === 'text'
      ? { type: 'text_delta', text: block.text }
      : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) };
    yield encodeSse('content_block_start', { type: 'content_block_start', index, content_block: start });
    yield encodeSse('content_block_delta', { type: 'content_block_delta', index, delta });
    yield encodeSse('content_block_stop', { type: 'content_block_stop', index });
  }
  yield encodeSse('message_delta', {
    type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: message.usage,
  });
  yield encodeSse('message_stop', { type: 'message_stop' });
}

export const chatGptPlanAdapter: GatewayAdapter = {
  kind: 'chatgpt_plan',
  dialect: 'anthropic',
  sdkChildEnv: openAiCompatibleAdapter.sdkChildEnv,
  async handle(req, grant) {
    const config = grant.config;
    if (config.kind !== 'chatgpt_plan' || grant.purpose !== 'dispatch' ||
        config.effort === undefined || grant.wireModels.size !== 1 || !grant.credential.secret) {
      throw new GatewayError(403, 'permission_error', 'plan_grant_invalid', 'This grant cannot use the ChatGPT plan.');
    }
    if (req.method === 'GET' && req.path === '/v1/models') return openAiCompatibleAdapter.handle(req, grant);
    if (req.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(req.path)) {
      throw new GatewayError(404, 'not_found_error', 'gateway_not_found', 'Not found.');
    }
    let parsed;
    try { parsed = JSON.parse(req.body.toString('utf8')); } catch {
      throw new GatewayError(400, 'invalid_request_error', 'bad_json', 'Request body is not JSON.');
    }
    const model = assertBoundModel(grant, parsed?.model);
    const estimatedInputTokens = estimateInputTokens(parsed);
    if (req.path === '/v1/messages/count_tokens') return json({ input_tokens: estimatedInputTokens });

    const translated = translatePlanRequest(parsed, model, config.effort, config.catalogSearch);
    const body = JSON.stringify(translated.body);
    recordAttempt(grant, body);
    const upstream = await forwardUpstream(grant, {
      url: joinByoUrl(config.baseUrl, 'responses'),
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body, stream: true,
    }, req.signal);
    if (!upstream.ok || !upstream.body || !/^text\/event-stream(?:\s*;|$)/i.test(upstream.headers.get('content-type') ?? '')) {
      await upstream.body?.cancel();
      const limited = upstream.status === 429;
      const message = limited ? 'The ChatGPT plan limit stopped this request.' : 'The ChatGPT plan worker could not serve this request.';
      noteGatewayFailure(grant.aiSessionId, message);
      throw new GatewayError(limited ? 429 : 502, limited ? 'rate_limit_error' : 'api_error',
        limited ? 'plan_limit_stopped' : 'plan_worker_unavailable', message);
    }
    const message = await translatePlanResponse(upstream.body as unknown as AsyncIterable<Uint8Array>, {
      model, tools: translated.tools, estimatedInputTokens, catalogSearch: config.catalogSearch,
    });
    return translated.stream
      ? { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body: messageEvents(message) }
      : json(message);
  },
};

registerGatewayAdapter(chatGptPlanAdapter);
