import { describe, expect, it } from 'vitest';
import { validateToolInput } from './aiToolSchemas';

describe('query_devices argument validation', () => {
  it.each([
    { filter: 'server-a' },
    { search: 'server-a', filter: 'another-server' },
    { hostname: 'server-a' },
    { search: 'server-a', orgId: 'another-organization' },
  ])('rejects unsupported keys instead of silently broadening the query: %j', (input) => {
    const result = validateToolInput('query_devices', input);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/unrecognized/i);
  });

  it.each([
    {},
    { search: 'server-a' },
    { status: 'online', osType: 'linux', search: 'server-a', limit: 20, offset: 0 },
    { tags: ['infrastructure'] },
  ])('preserves documented filtered and intentionally unfiltered queries: %j', (input) => {
    expect(validateToolInput('query_devices', input)).toEqual({ success: true });
  });

  it('still rejects invalid values on a documented filter', () => {
    expect(validateToolInput('query_devices', { search: 42 }).success).toBe(false);
  });
});
