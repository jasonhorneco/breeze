import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';

const mock = vi.hoisted(() => ({
  user: '3ecef742-f1b0-4f24-9a40-1f97d13f4af2',
  principal: 'user_session' as 'user_session' | 'api_key', org: '74d52c8a-9434-4160-9bae-0d663ce169a5',
  read: vi.fn(), publish: vi.fn(), readApproval: vi.fn(), upstream: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({ readFile: async () => 'synthetic-service-token-0000000000000' }));
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ name: 'Test BMC' }] }) }) }) },
}));
vi.mock('./helpers', () => ({ getAlertWithOrgCheck: mock.read }));
vi.mock('../../services/approvals/codexDraft', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../services/approvals/codexDraft')>(),
  publishCodexDraft: mock.publish,
  readCodexDraftApproval: mock.readApproval,
}));
vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (c: Context, next: Next) => {
    c.set('auth', {
      user: { id: mock.user, email: 'owner@example.test', name: 'Fixture owner', isPlatformAdmin: false },
      principal: { kind: mock.principal }, token: null, partnerId: null,
      orgId: mock.org, scope: 'organization', accessibleOrgIds: [mock.org],
      orgCondition: () => undefined, canAccessOrg: (orgId: string) => orgId === mock.org,
    });
    await next();
  },
  requirePermission: () => async (_c: Context, next: Next) => { await next(); },
  requireMfa: () => async (_c: Context, next: Next) => { await next(); },
}));
import { codexReviewRoutes } from './codexReview';

const id = '383c5401-fd5b-4906-b02f-71d11ed857ed';
const owner = '3ecef742-f1b0-4f24-9a40-1f97d13f4af2';
const organization = '74d52c8a-9434-4160-9bae-0d663ce169a5';
const path = '/' + id + '/codex-review';
const app = new Hono().route('/', codexReviewRoutes);

beforeEach(() => {
  vi.clearAllMocks();
  mock.user = owner;
  mock.principal = 'user_session';
  mock.org = organization;
  vi.stubEnv('BREEZE_CODEX_PILOT_ENABLED', 'true');
  vi.stubEnv('BREEZE_CODEX_PILOT_ALERT_ID', id);
  vi.stubEnv('BREEZE_CODEX_PILOT_OWNER_ID', owner);
  vi.stubEnv('BREEZE_CODEX_PILOT_ORG_ID', organization);
  vi.stubEnv('BREEZE_CODEX_PILOT_RULE_NAME', 'Test BMC');
  vi.stubGlobal('fetch', mock.upstream);
  mock.read.mockImplementation(async () => ({
    id, orgId: mock.org, status: 'resolved', ruleId: id,
    message: 'Test BMC: fan1: reading unavailable', severity: 'high',
    triggeredAt: new Date('2026-10-15T07:00:00Z'), resolvedAt: new Date('2026-10-15T07:02:00Z'),
  }));
  mock.upstream.mockImplementation(async () => Response.json({ review: null, attempt: null }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('owner-only Codex pilot', () => {
  it('rejects disabled, wrong-alert, machine, wrong-owner and cross-org access before upstream', async () => {
    vi.stubEnv('BREEZE_CODEX_PILOT_ENABLED', 'false');
    expect((await app.request(path)).status).toBe(404);
    vi.stubEnv('BREEZE_CODEX_PILOT_ENABLED', 'true');
    expect((await app.request('/other/codex-review')).status).toBe(404);
    mock.principal = 'api_key';
    expect((await app.request(path)).status).toBe(404);
    mock.principal = 'user_session';
    mock.user = id;
    expect((await app.request(path)).status).toBe(404);
    mock.user = owner;
    mock.org = id;
    expect((await app.request(path)).status).toBe(404);
    expect(mock.upstream).not.toHaveBeenCalled();
  });

  it('projects allowlisted evidence and publishes the saved draft without deciding it', async () => {
    mock.upstream.mockImplementationOnce(async () => Response.json({ review: null, attempt: { state: 'started' } }, { status: 202 }));
    expect((await app.request(path, { method: 'POST' })).status).toBe(202);
    const request = mock.upstream.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({
      condition: 'fan1: reading unavailable', severity: 'high',
      triggeredAt: '2026-10-15T07:00:00.000Z', resolvedAt: '2026-10-15T07:02:00.000Z',
    });
    const review = { requestId: id, proposal: { kind: 'policy' }, decision: 'pending' };
    mock.upstream.mockResolvedValueOnce(Response.json({ review }));
    mock.publish.mockResolvedValueOnce({ id, status: 'pending' });
    const response = await app.request(path + '/publish', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ approval: { id, status: 'pending' } });
    expect(mock.publish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id }), review);
    expect((await app.request(path + '/decision', { method: 'POST' })).status).toBe(404);
  });

  it('projects the verified plan model and rejects a different model before queueing', async () => {
    vi.stubEnv('BREEZE_CODEX_PILOT_CATALOG_VERIFIED_AT', '2026-11-09T06:00:00Z');
    vi.stubEnv('BREEZE_CODEX_PILOT_CATALOG_DISPLAY_NAME', 'GPT-6-Luna');
    const response = await app.request(path);
    expect(await response.json()).toMatchObject({
      reviewProvider: { provider: 'OpenAI Codex', funding: 'ChatGPT subscription', model: { slug: 'gpt-6-luna' }, alertId: id },
    });
    mock.upstream.mockClear();
    const responseWrong = await app.request(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-6-astra' }),
    });
    expect(responseWrong.status).toBe(422);
    expect(mock.upstream).not.toHaveBeenCalled();
  });
});
