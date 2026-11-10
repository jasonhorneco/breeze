import { GatewayError } from '../types';
import type { EffortLevel } from '@breeze/shared';
import { translateMessagesRequest } from './translateRequest';
import type { OaiContentPart, OaiMessage, OaiTool } from './types';

type PlanContentPart =
  | { type: 'input_text' | 'output_text'; text: string }
  | { type: 'input_image'; image_url: string; detail: 'auto' };

type PlanInput =
  | { role: 'user' | 'assistant'; content: string | PlanContentPart[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }
  | { type: 'additional_tools'; role: 'developer'; tools: PlanFunction[] };

type PlanFunction = OaiTool['function'] & { type: 'function'; strict: false };

function inputPart(part: OaiContentPart, role: 'user' | 'assistant'): PlanContentPart {
  if (part.type === 'text') return { type: role === 'user' ? 'input_text' : 'output_text', text: part.text };
  return { type: 'input_image', image_url: part.image_url.url, detail: 'auto' };
}

function toPlanInput(message: OaiMessage): PlanInput[] {
  if (message.role === 'system') return [];
  if (message.role === 'tool') {
    if (!message.tool_call_id || typeof message.content !== 'string') {
      throw new GatewayError(400, 'invalid_request_error', 'plan_invalid_history', 'A tool result has no matching call.');
    }
    return [{ type: 'function_call_output', call_id: message.tool_call_id, output: message.content }];
  }

  const input: PlanInput[] = [];
  if (message.content !== null) {
    const role = message.role;
    const content = typeof message.content === 'string'
      ? message.content : message.content.map(part => inputPart(part, role));
    input.push({ role, content });
  }
  for (const call of message.tool_calls ?? []) {
    input.push({ type: 'function_call', call_id: call.id, ...call.function });
  }
  return input;
}

/** Builds the eligible Responses payload from a grant-bound selection. Breeze still executes all local tools. */
export function translatePlanRequest(input: unknown, model: string, effort: EffortLevel | null, catalogSearch = false) {
  const request = input as { tools?: Array<{ type?: string; name?: string }> } | null;
  const hasCatalogSearch = catalogSearch && Array.isArray(request?.tools) && request.tools.length === 1 &&
    request.tools[0]?.type === 'web_search_20250305' && request.tools[0]?.name === 'web_search';
  const translated = translateMessagesRequest(hasCatalogSearch ? { ...request, tools: undefined } : input, model);
  const { messages, tools, tool_choice: choice } = translated.body;
  const instructions = messages.find(message => message.role === 'system')?.content;
  const responseInput = messages.flatMap(toPlanInput);
  if (tools?.length) {
    responseInput.unshift({
      type: 'additional_tools', role: 'developer',
      tools: tools.map(tool => ({ type: 'function', ...tool.function, strict: false })),
    });
  }

  return {
    body: {
      model, store: false, stream: true,
      ...(effort ? { reasoning: { effort } } : {}),
      ...(typeof instructions === 'string' ? { instructions } : {}),
      input: responseInput,
      ...(hasCatalogSearch ? { tools: [{ type: 'web_search' as const }] } : {}),
      ...(choice ? { tool_choice: typeof choice === 'string' ? choice : { type: 'function', name: choice.function.name } } : {}),
    },
    tools: translated.tools,
    stream: translated.stream,
  };
}
