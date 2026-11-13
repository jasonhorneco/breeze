import { describe, expect, it } from 'vitest';
import { translatePlanRequest } from './translatePlanRequest';

describe('ChatGPT plan request translation', () => {
  it('passes the grant model and effort and omits parameters unsupported by plan usage', () => {
    const result = translatePlanRequest({
      model: 'sdk-alias', max_tokens: 1024, stream: false,
      system: 'Draft a script.',
      temperature: 0.2, top_p: 0.4, stop_sequences: ['stop'],
      messages: [{ role: 'user', content: 'Show uptime.' }],
    }, 'gpt-6.1-sol', 'ultra');

    expect(result.stream).toBe(false);
    expect(result.body).toEqual({
      model: 'gpt-6.1-sol', store: false, stream: true, reasoning: { effort: 'ultra' },
      instructions: 'Draft a script.',
      input: [{ role: 'user', content: 'Show uptime.' }],
    });
  });

  it('carries an offered function and its exact historical call and result as Responses items', () => {
    const parameters = { type: 'object', properties: { device: { type: 'string' } }, required: ['device'] };
    const result = translatePlanRequest({
      model: 'sdk-alias', max_tokens: 1024, stream: true,
      tools: [{ name: 'read_inventory', description: 'Read inventory', input_schema: parameters }],
      tool_choice: { type: 'tool', name: 'read_inventory' },
      messages: [
        { role: 'user', content: 'Check this device.' },
        { role: 'assistant', content: [{ type: 'tool_use', name: 'read_inventory', id: 'call_one', input: { device: 'fixture' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_one', content: 'No issue found.' }] },
      ],
    }, 'gpt-6-luna', 'low');

    expect(result.stream).toBe(true);
    expect(result.body.tool_choice).toEqual({ type: 'function', name: 'read_inventory' });
    expect(result.tools.fromOai.get('read_inventory')).toBe('read_inventory');
    expect(result.body.input).toEqual([
      { type: 'additional_tools', role: 'developer', tools: [
        { type: 'function', name: 'read_inventory', description: 'Read inventory', parameters, strict: false },
      ] },
      { role: 'user', content: 'Check this device.' },
      { type: 'function_call', call_id: 'call_one', name: 'read_inventory', arguments: '{"device":"fixture"}' },
      { type: 'function_call_output', call_id: 'call_one', output: 'No issue found.' },
    ]);
  });

  it('does not forward a hosted tool or an invalid forced choice', () => {
    const request = { model: 'sdk-alias', max_tokens: 1024, messages: [{ role: 'user', content: 'Show uptime.' }] };
    expect(() => translatePlanRequest({ ...request, tools: [{ type: 'web_search', name: 'web_search' }] }, 'gpt-6-luna', 'low'))
      .toThrow(/server tools are not supported/);
    expect(() => translatePlanRequest({
      ...request, tools: [{ name: 'read_inventory', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'execute_script' },
    }, 'gpt-6-luna', 'low')).toThrow(/not offered/);
  });

  it('maps catalog web search only on a catalog-scoped grant', () => {
    const request = {
      model: 'sdk-alias', max_tokens: 1024, messages: [{ role: 'user', content: 'Check a product.' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    };
    expect(translatePlanRequest(request, 'gpt-6-luna', 'low', true).body.tools).toEqual([{ type: 'web_search' }]);
    expect(() => translatePlanRequest(request, 'gpt-6-luna', 'low')).toThrow(/server tools are not supported/);
  });

  it('compacts only advertised schemas while retaining original validation and saved effort', () => {
    const parameters = { type: 'object', properties: { value: { type: 'string', maxLength: 20, format: 'hostname' } }, required: ['value'], additionalProperties: false };
    const input = { model: 'sdk-alias', max_tokens: 256, messages: [{ role: 'user', content: 'Read.' }],
      tools: [{ name: 'read_inventory', input_schema: parameters }] };
    const full = translatePlanRequest(input, 'gpt-6.1-sol', 'high');
    const compact = translatePlanRequest(input, 'gpt-6.1-sol', 'high', false, { compactSchemas: true });
    expect(full.body.input[0]).toMatchObject({ type: 'additional_tools', tools: [{ parameters }] });
    expect(compact.body.input[0]).toMatchObject({ type: 'additional_tools', tools: [{ parameters: {
      type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false,
    } }] });
    expect(compact.tools.schemas).toEqual(full.tools.schemas);
    expect(compact.body.reasoning).toEqual({ effort: 'high' });
    expect(parameters.properties.value.maxLength).toBe(20);
  });
});
