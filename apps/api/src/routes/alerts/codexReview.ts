import { readFile } from 'node:fs/promises';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { alertRules } from '../../db/schema';
import { requireMfa, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { zValidator } from '../../lib/validation';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { getAlertWithOrgCheck } from './helpers';

export const codexReviewRoutes = new Hono();

const endpoint = 'http://codex-review:8078';
const read = requirePermission(PERMISSIONS.ALERTS_READ.resource, PERMISSIONS.ALERTS_READ.action);
const write = requirePermission(PERMISSIONS.AI_AGENTS_WRITE.resource, PERMISSIONS.AI_AGENTS_WRITE.action);
const scopes = requireScope('partner', 'organization');
const decision = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['accepted', 'rejected']),
}).strict();
const conditionPattern = /^(?:fan\d{1,2}: (?:reading unavailable|collector status not OK))(?:; fan\d{1,2}: (?:reading unavailable|collector status not OK)){0,8}$/;

export function isCodexPilotOwner(auth: AuthContext, alertId: string | undefined) {
  return process.env.BREEZE_CODEX_PILOT_ENABLED === 'true' &&
    alertId === process.env.BREEZE_CODEX_PILOT_ALERT_ID &&
    auth.principal?.kind === 'user_session' && !auth.aiOrigin &&
    auth.user.id === process.env.BREEZE_CODEX_PILOT_OWNER_ID;
}

const ownerOnly: MiddlewareHandler = async (c, next) => {
  const auth = c.get('auth') as AuthContext;
  if (!isCodexPilotOwner(auth, c.req.param('id'))) {
    return c.notFound();
  }
  await next();
};

async function allowedAlert(c: Context) {
  const auth = c.get('auth') as AuthContext;
  const permissions = c.get('permissions') as UserPermissions | undefined;
  const id = c.req.param('id');
  if (!id) return null;
  const alert = await getAlertWithOrgCheck(id, {
    ...auth, allowedSiteIds: permissions?.allowedSiteIds,
  });
  if (!alert || alert.orgId !== process.env.BREEZE_CODEX_PILOT_ORG_ID) return null;
  return alert;
}

async function requestPilot(alertId: string, body?: object, operation = '') {
  const key = (await readFile('/run/secrets/breeze_codex_pilot_service_key', 'utf8')).trim();
  if (key.length < 32) throw new Error('Pilot key unavailable');
  return fetch(endpoint + '/reviews/' + alertId + operation, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
}

async function proxy(c: Context, id: string, body?: object, operation?: string) {
  try {
    const result = await requestPilot(id, body, operation);
    const data = await result.json();
    if (result.status === 200 || result.status === 202) {
      return c.json(data, result.status);
    }
    const reason = typeof data?.error === 'string' && /^pilot_[a-z_]+$/.test(data.error) ? data.error : 'pilot_unavailable';
    return c.json({ error: reason }, result.status === 409 ? 409 : 502);
  } catch {
    return c.json({ error: 'pilot_unavailable' }, 502);
  }
}

codexReviewRoutes.get('/:id/codex-review', scopes, ownerOnly, read, async (c) => {
  const alert = await allowedAlert(c);
  return alert ? proxy(c, alert.id) : c.notFound();
});

codexReviewRoutes.post('/:id/codex-review', scopes, ownerOnly, read, write, requireMfa(), async (c) => {
  const alert = await allowedAlert(c);
  if (!alert || !alert.ruleId || !alert.resolvedAt || alert.status !== 'resolved') return c.notFound();
  const [rule] = await db.select({ name: alertRules.name }).from(alertRules).where(eq(alertRules.id, alert.ruleId)).limit(1);
  const ruleName = process.env.BREEZE_CODEX_PILOT_RULE_NAME;
  if (!ruleName) return c.notFound();
  const prefix = ruleName + ': ';
  const condition = alert.message?.startsWith(prefix) ? alert.message.slice(prefix.length) : '';
  if (rule?.name !== ruleName || !conditionPattern.test(condition)) {
    return c.json({ error: 'pilot_evidence_rejected' }, 422);
  }
  return proxy(c, alert.id, {
    triggeredAt: alert.triggeredAt.toISOString(), resolvedAt: alert.resolvedAt.toISOString(),
    severity: alert.severity, condition,
  });
});

codexReviewRoutes.post('/:id/codex-review/decision', scopes, ownerOnly, read, write, requireMfa(),
  zValidator('json', decision), async (c) => {
    const alert = await allowedAlert(c);
    if (!alert) return c.notFound();
    const auth = c.get('auth') as AuthContext;
    const verdict = c.req.valid('json');
    const response = await proxy(c, alert.id, { ...verdict, reviewerId: auth.user.id }, '/decision');
    if (response.status === 200) {
      writeRouteAudit(c, {
        orgId: alert.orgId, action: 'codex_pilot.review_decision', resourceType: 'alert',
        resourceId: alert.id, details: verdict, result: 'success',
      });
    }
    return response;
  },
);
