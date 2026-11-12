/**
 * /ai/models — the partner AI model registry API (W04, #7602): connections,
 * offerings, partner assignments, residency, org overrides and usage. Mounted
 * in index.ts BEFORE the broad api.route('/ai', …) mounts (Hono matches in
 * registration order).
 */
import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { buildPartnerModelsSnapshot } from '../../services/aiModels/registryView';
import { codexReviewCatalog } from '../../services/aiModels/codexReviewCatalog';
import { aiModelAssignmentRoutes } from './assignments';
import { aiModelChoiceRoutes } from './choices';
import { aiModelConnectionRoutes } from './connections';
import { aiModelOfferingRoutes } from './offerings';
import { aiModelOrgAssignmentRoutes } from './orgAssignments';
import { aiModelResidencyRoutes } from './residency';
import { aiModelUsageRoutes } from './usage';
import { loadToolProfileCatalog, partnerRead, requirePartnerWide } from './shared';

export const aiModelsRoutes = new Hono();
aiModelsRoutes.use('*', authMiddleware);

aiModelsRoutes.get('/', ...partnerRead, async (c) => {
  const { partnerId } = requirePartnerWide(c);
  const snapshot = await buildPartnerModelsSnapshot(partnerId, await loadToolProfileCatalog());
  const reviewProvider = snapshot.connections.some(conn => conn.kind === 'chatgpt_plan')
    ? undefined : codexReviewCatalog(c.get('auth'));
  return c.json(reviewProvider ? { ...snapshot, reviewProvider } : snapshot);
});

aiModelsRoutes.route('/connections', aiModelConnectionRoutes);
aiModelsRoutes.route('/offerings', aiModelOfferingRoutes);
aiModelsRoutes.route('/assignments', aiModelAssignmentRoutes);
aiModelsRoutes.route('/residency', aiModelResidencyRoutes);
aiModelsRoutes.route('/orgs', aiModelOrgAssignmentRoutes);
aiModelsRoutes.route('/usage', aiModelUsageRoutes);
aiModelsRoutes.route('/choices', aiModelChoiceRoutes);   // W05 (#7603): user-scoped pickers; their own gates, not partnerRead
