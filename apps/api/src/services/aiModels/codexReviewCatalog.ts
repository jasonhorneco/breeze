import type { AiReviewProviderDto } from '@breeze/shared';
import type { AuthContext } from '../../middleware/auth';
import { isCodexPilotOwner } from '../approvals/codexDraft';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function codexReviewCatalog(auth: AuthContext, orgId?: string): AiReviewProviderDto | undefined {
  const alertId = process.env.BREEZE_CODEX_PILOT_ALERT_ID;
  const reviewOrgId = process.env.BREEZE_CODEX_PILOT_ORG_ID;
  const verifiedAt = process.env.BREEZE_CODEX_PILOT_CATALOG_VERIFIED_AT;
  const displayName = process.env.BREEZE_CODEX_PILOT_CATALOG_DISPLAY_NAME;
  if (!alertId || !uuid.test(alertId) || !reviewOrgId || !uuid.test(reviewOrgId) ||
      !verifiedAt || !displayName || displayName.length > 80 ||
      !Number.isFinite(Date.parse(verifiedAt)) || !isCodexPilotOwner(auth, alertId) ||
      (orgId !== undefined && orgId !== reviewOrgId) || !auth.canAccessOrg(reviewOrgId)) return;
  return {
    provider: 'OpenAI Codex', funding: 'ChatGPT subscription',
    model: { slug: 'gpt-6-luna', displayName, effort: 'low' },
    verifiedAt, alertId,
  };
}
