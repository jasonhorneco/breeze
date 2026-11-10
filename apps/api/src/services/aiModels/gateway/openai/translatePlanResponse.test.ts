import { describe, expect, it } from 'vitest';
import { encodeSse } from './sse';
import { translatePlanRequest } from './translatePlanRequest';
import { translatePlanResponse } from './translatePlanResponse';

const model = 'gpt-6.1-sol';
const { tools } = translatePlanRequest({
  model, max_tokens: 1024, messages: [{ role: 'user', content: 'Draft a script.' }],
  tools: [{
    name: 'draft_script', input_schema: {
      type: 'object', required: ['source'], properties: { source: { type: 'string' } }, additionalProperties: false,
    },
  }],
}, model, 'high');

const context = { model, tools, estimatedInputTokens: 12 };
const usage = { input_tokens: 18, output_tokens: 8, input_tokens_details: { cached_tokens: 4 } };

async function* events(...items: Array<Record<string, unknown>>) {
  for (const event of items) yield encodeSse(String(event.type), event);
}

describe('ChatGPT plan response translation', () => {
  it('returns the validated tool proposal and actual usage only after completion', async () => {
    const result = await translatePlanResponse(events(
      { type: 'response.output_text.delta', delta: 'ignored partial output' },
      { type: 'response.completed', response: { status: 'completed', model, usage, output: [
        { type: 'reasoning' },
        { type: 'function_call', call_id: 'call_plan_001', name: 'draft_script', arguments: '{"source":"uptime"}' },
      ] } },
    ), context);
    expect(result).toMatchObject({
      model, stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'draft_script', input: { source: 'uptime' } }],
      usage: { input_tokens: 14, output_tokens: 8, cache_read_input_tokens: 4 },
    });
  });

  it('refuses unknown tools without creating a tool block', async () => {
    const result = await translatePlanResponse(events(
      { type: 'response.completed', response: { status: 'completed', model, usage, output: [
        { type: 'function_call', call_id: 'call_plan_002', name: 'execute_script', arguments: '{"source":"uptime"}' },
      ] } },
    ), context);
    expect(result.stop_reason).toBe('end_turn');
    expect(result.content.every(block => block.type === 'text')).toBe(true);
  });

  it('fails closed for a quota error, an unfinished stream, or a substituted model', async () => {
    await expect(translatePlanResponse(events({
      type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } },
    }), context)).rejects.toMatchObject({ status: 429, code: 'plan_limit_stopped' });
    await expect(translatePlanResponse(events({
      type: 'response.output_text.delta', delta: 'partial',
    }), context)).rejects.toMatchObject({ code: 'plan_incomplete' });
    await expect(translatePlanResponse(events({
      type: 'response.completed', response: { status: 'completed', model: 'gpt-6-luna', output: [] },
    }), context)).rejects.toMatchObject({ code: 'plan_model_mismatch' });
  });
});
