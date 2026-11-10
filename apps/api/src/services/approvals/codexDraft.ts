import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { approvalRequests } from '../../db/schema/approvals';
import { hasSatisfiedMfa, type AuthContext } from '../../middleware/auth';
import { getAlertWithOrgCheck } from '../../routes/alerts/helpers';
import { getUserPermissions, hasPermission, PERMISSIONS } from '../permissions';

export const CODEX_DRAFT_TOOL = 'codex_review_draft';
export const codexDraftDigest = z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema = z.object({
  alertId: z.string().uuid(),
  orgId: z.string().uuid(),
  digest: codexDraftDigest,
}).strict();
const pendingReviewSchema = z.object({
  requestId: z.string().uuid(),
  alertId: z.string().uuid(),
  proposal: z.object({
    kind: z.enum(['policy', 'script']),
    title: z.string().min(1).max(160),
    draft: z.string().min(1).max(1600),
    risk: z.string().min(1).max(600),
  }).strict(),
  proposalDigest: codexDraftDigest,
  decision: z.literal('pending'),
});
type ApprovalRow = typeof approvalRequests.$inferSelect;

export function isCodexPilotOwner(auth: AuthContext, alertId: string | undefined) {
  return process.env.BREEZE_CODEX_PILOT_ENABLED === 'true' &&
    !!alertId && alertId === process.env.BREEZE_CODEX_PILOT_ALERT_ID &&
    auth.principal?.kind === 'user_session' && !auth.aiOrigin &&
    auth.user.id === process.env.BREEZE_CODEX_PILOT_OWNER_ID;
}

export async function readCodexDraftApproval(userId: string, id: string) {
  const [approval] = await db.select().from(approvalRequests).where(and(
    eq(approvalRequests.id, id), eq(approvalRequests.userId, userId),
    eq(approvalRequests.actionToolName, CODEX_DRAFT_TOOL),
  )).limit(1);
  return approval ?? null;
}

export async function publishCodexDraft(auth: AuthContext, alert: { id: string; orgId: string }, value: unknown) {
  const parsed = pendingReviewSchema.safeParse(value);
  if (!parsed.success || parsed.data.alertId !== alert.id || !isCodexPilotOwner(auth, alert.id) ||
      alert.orgId !== process.env.BREEZE_CODEX_PILOT_ORG_ID || !hasSatisfiedMfa(auth)) return null;
  const review = parsed.data;
  // Hash the broker's original field order before PostgreSQL can normalize it.
  const digest = createHash('sha256').update(JSON.stringify((value as { proposal: unknown }).proposal)).digest('hex');
  if (digest !== review.proposalDigest) return null;
  await db.insert(approvalRequests).values({
    id: review.requestId, userId: auth.user.id, requestingClientLabel: 'Codex pilot',
    actionLabel: 'Review Codex draft: ' + review.proposal.title, actionToolName: CODEX_DRAFT_TOOL,
    actionArguments: { alertId: alert.id, orgId: alert.orgId, digest },
    riskTier: 'low', riskSummary: 'Review only. This records your decision on the draft.',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  }).onConflictDoNothing({ target: approvalRequests.id });
  const approval = await readCodexDraftApproval(auth.user.id, review.requestId);
  const binding = bindingSchema.safeParse(approval?.actionArguments);
  return binding.success && binding.data.digest === digest && binding.data.alertId === alert.id &&
    binding.data.orgId === alert.orgId ? approval : null;
}

export async function canDecideCodexDraft(auth: AuthContext, approval: ApprovalRow, digest: string | undefined) {
  const binding = bindingSchema.safeParse(approval.actionArguments);
  if (!binding.success || approval.userId !== auth.user.id ||
      !isCodexPilotOwner(auth, binding.data.alertId) || !hasSatisfiedMfa(auth) ||
      binding.data.digest !== digest || binding.data.orgId !== process.env.BREEZE_CODEX_PILOT_ORG_ID ||
      approval.intentId || approval.executionId || approval.elevationRequestId || approval.diagnosticAccessGrantId ||
      approval.requestingClientId || approval.requestingSessionId) return false;
  const permissions = await getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId ?? undefined, orgId: auth.orgId ?? undefined, scope: auth.scope,
  });
  const read = PERMISSIONS.ALERTS_READ;
  const write = PERMISSIONS.AI_AGENTS_WRITE;
  if (!permissions || !hasPermission(permissions, read.resource, read.action) ||
      !hasPermission(permissions, write.resource, write.action)) return false;
  const alert = await getAlertWithOrgCheck(binding.data.alertId, { ...auth, allowedSiteIds: permissions.allowedSiteIds });
  return alert?.orgId === binding.data.orgId;
}
