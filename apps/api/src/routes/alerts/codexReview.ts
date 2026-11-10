import { readFile } from 'node:fs/promises';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { alertRules } from '../../db/schema';
import { requireMfa, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { isCodexPilotOwner, publishCodexDraft, readCodexDraftApproval } from '../../services/approvals/codexDraft';
import { codexReviewCatalog } from '../../services/aiModels/codexReviewCatalog';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { getAlertWithOrgCheck } from './helpers';

export const codexReviewRoutes = new Hono();

const endpoint = 'http://codex-review:8078';
const read = requirePermission(PERMISSIONS.ALERTS_READ.resource, PERMISSIONS.ALERTS_READ.action);
const write = requirePermission(PERMISSIONS.AI_AGENTS_WRITE.resource, PERMISSIONS.AI_AGENTS_WRITE.action);
const scopes = requireScope('partner', 'organization');
const requestId = z.string().uuid();
const conditionPattern = /^(?:fan\d{1,2}: (?:reading unavailable|collector status not OK))(?:; fan\d{1,2}: (?:reading unavailable|collector status not OK)){0,8}$/;

export { isCodexPilotOwner };

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

async function requestPilot(alertId: string, body?: object) {
  const key = (await readFile('/run/secrets/breeze_codex_pilot_service_key', 'utf8')).trim();
  if (key.length < 32) throw new Error('Pilot key unavailable');
  return fetch(endpoint + '/reviews/' + alertId, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
}

async function proxy(c: Context, id: string, body?: object) {
  try {
    const result = await requestPilot(id, body);
    const data = await result.json();
    if (result.status === 200 || result.status === 202) {
      const auth = c.get('auth') as AuthContext;
      const reviewProvider = codexReviewCatalog(auth);
      if (reviewProvider) data.reviewProvider = reviewProvider;
      const reviewId = requestId.safeParse(data?.review?.requestId);
      if (reviewId.success && data.review.proposal) {
        const approval = await readCodexDraftApproval(auth.user.id, reviewId.data);
        const binding = approval?.actionArguments as { alertId?: string; digest?: string } | undefined;
        if (approval && binding?.alertId === id && binding.digest === data.review.proposalDigest) {
          data.approval = { id: approval.id, status: approval.status };
        }
      }
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
  const body = await c.req.json().catch(() => null);
  if (body?.model !== undefined && body.model !== codexReviewCatalog(c.get('auth'), alert.orgId)?.model.slug) {
    return c.json({ error: 'pilot_model_unavailable' }, 422);
  }
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

codexReviewRoutes.post('/:id/codex-review/publish', scopes, ownerOnly, read, write, requireMfa(), async (c) => {
    const alert = await allowedAlert(c);
    if (!alert) return c.notFound();
    try {
      const response = await requestPilot(alert.id);
      if (!response.ok) return c.json({ error: 'pilot_unavailable' }, 502);
      const data = await response.json();
      const auth = c.get('auth') as AuthContext;
      const approval = await publishCodexDraft(auth, alert, data.review);
      if (!approval) return c.json({ error: 'pilot_draft_invalid' }, 409);
      return c.json({ review: data.review, attempt: data.attempt, approval: { id: approval.id, status: approval.status },
        reviewProvider: codexReviewCatalog(auth, alert.orgId) });
    } catch {
      return c.json({ error: 'pilot_unavailable' }, 502);
    }
});
