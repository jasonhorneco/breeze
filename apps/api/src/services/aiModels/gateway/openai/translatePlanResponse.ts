import { z } from 'zod';
import { GatewayError } from '../types';
import { parseSse } from './sse';
import { translateChatResponse } from './translateResponse';
import type { OaiChatResponse, OaiToolCall, ToolNameMap } from './types';

const messageContent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('output_text'), text: z.string() }),
  z.object({ type: z.literal('refusal'), refusal: z.string() }),
]);

const response = z.object({
  status: z.literal('completed'),
  model: z.string(),
  output: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('message'), role: z.literal('assistant'), content: z.array(messageContent) }),
    z.object({ type: z.literal('function_call'), call_id: z.string(), name: z.string(), arguments: z.string() }),
    z.object({ type: z.literal('reasoning') }),
    z.object({ type: z.literal('web_search_call') }),
  ])),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    input_tokens_details: z.object({ cached_tokens: z.number() }).nullish(),
  }).nullish(),
});

const failed = (code: string, message: string) => new GatewayError(502, 'api_error', code, message);
const limited = () => new GatewayError(429, 'rate_limit_error', 'plan_limit_stopped', 'The ChatGPT plan limit stopped this request.');

/** No text or tool proposal is returned before a completed event for the requested model. */
export async function translatePlanResponse(
  stream: AsyncIterable<Uint8Array>,
  context: { model: string; tools: ToolNameMap; estimatedInputTokens: number; catalogSearch?: boolean },
) {
  for await (const event of parseSse(stream)) {
    let value;
    try { value = JSON.parse(event.data); } catch {
      throw failed('plan_invalid_stream', 'The ChatGPT plan returned a malformed event.');
    }
    if (value?.type === 'response.failed' || value?.type === 'error') {
      const code = value.response?.error?.code ?? value.code;
      if (code === 'subscription_sharing_usage_limit_exceeded' || code === 'subscription_sharing_usage_unavailable') {
        throw limited();
      }
      throw failed('plan_failed', 'The ChatGPT plan request failed.');
    }
    if (value?.type === 'response.incomplete') {
      throw failed('plan_incomplete', 'The ChatGPT plan request did not complete.');
    }
    if (value?.type !== 'response.completed') continue;
    const parsed = response.safeParse(value.response);
    if (!parsed.success) throw failed('plan_invalid_output', 'The ChatGPT plan returned an unsupported response.');
    if (parsed.data.model !== context.model) throw failed('plan_model_mismatch', 'The ChatGPT plan returned a different model.');
    if (!context.catalogSearch && parsed.data.output.some(item => item.type === 'web_search_call')) {
      throw failed('plan_unexpected_search', 'The ChatGPT plan returned a search this request did not authorize.');
    }

    const text: string[] = [];
    const toolCalls: OaiToolCall[] = [];
    let refused = false;
    for (const item of parsed.data.output) {
      if (item.type === 'function_call') {
        toolCalls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
      } else if (item.type === 'message') {
        for (const part of item.content) {
          if (part.type === 'output_text') text.push(part.text);
          else { refused = true; text.push(part.refusal); }
        }
      }
    }
    const usage = parsed.data.usage;
    const completion: OaiChatResponse = {
      choices: [{
        index: 0,
        finish_reason: refused ? 'content_filter' : toolCalls.length ? 'tool_calls' : 'stop',
        message: { role: 'assistant', content: text.join('\n') || null, tool_calls: refused ? [] : toolCalls },
      }],
      ...(usage ? { usage: {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
        ...(usage.input_tokens_details ? { prompt_tokens_details: usage.input_tokens_details } : {}),
      } } : {}),
    };
    return translateChatResponse(completion, context);
  }
  throw failed('plan_incomplete', 'The ChatGPT plan stream closed without a completed response.');
}
