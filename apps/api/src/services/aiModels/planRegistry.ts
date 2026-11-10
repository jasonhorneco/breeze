import { readFile } from 'node:fs/promises';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { EFFORT_LEVELS } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiModelAssignments, organizations, partnerAiConnections, partnerAiModels, users } from '../../db/schema';
import { inPartnerEnvLock } from './envOpenAiBootstrapStore';
import { ensurePartnerCutover } from './registryCutover';
import type { PartnerAiConnection } from './connections';
import { planWorker } from './planCandidate';
import { discoveryGrantRecord } from './gateway/grants';
import { forwardUpstream } from './gateway/forward';
import { joinByoUrl } from './gateway/byoEndpointPolicy';

const catalogSchema = z.object({
  observed_at: z.iso.datetime({ offset: true }),
  models: z.array(z.object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,79}$/),
    displayName: z.string().min(1).max(100),
    supportedEfforts: z.array(z.enum(EFFORT_LEVELS)).max(EFFORT_LEVELS.length),
    defaultEffort: z.enum(EFFORT_LEVELS).nullable(),
  }).refine(row => row.supportedEfforts.length === 0 ? row.defaultEffort === null
    : row.defaultEffort !== null && row.supportedEfforts.includes(row.defaultEffort))).min(1).max(50),
}).refine(catalog => new Set(catalog.models.map(model => model.slug)).size === catalog.models.length);

/** Registers offerings supplied by the private worker's verified account catalog. */
export async function registerChatGptPlanAtBoot(): Promise<void> {
  const file = process.env.BREEZE_CODEX_PLAN_CATALOG_FILE;
  if (!file) return;
  await saveChatGptPlanCatalog(JSON.parse(await readFile(file, 'utf8')));
}

export async function refreshChatGptPlanCatalog(conn: PartnerAiConnection): Promise<void> {
  if (conn.kind !== 'chatgpt_plan' || conn.status !== 'active') throw new Error('ChatGPT connection unavailable');
  const route = planWorker(conn);
  if (!route) throw new Error('ChatGPT plan worker unavailable');
  const response = await forwardUpstream(discoveryGrantRecord(route.config, route.credential), {
    url: joinByoUrl(route.config.baseUrl, 'models'), method: 'GET',
    headers: { accept: 'application/json' }, stream: false, maxBytes: 128_000,
  }, AbortSignal.timeout(20_000));
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('ChatGPT account catalog unavailable');
  }
  await saveChatGptPlanCatalog(await response.json());
}

async function saveChatGptPlanCatalog(raw: unknown): Promise<void> {
  const { id, orgId, ownerId } = z.object({
    id: z.uuid(), orgId: z.uuid(), ownerId: z.uuid(),
  }).parse({
    id: process.env.BREEZE_CODEX_PLAN_CONNECTION_ID,
    orgId: process.env.BREEZE_CODEX_PILOT_ORG_ID,
    ownerId: process.env.BREEZE_CODEX_PILOT_OWNER_ID,
  });
  const catalog = catalogSchema.parse(raw);
  const verifiedAt = new Date(catalog.observed_at);
  if (verifiedAt.getTime() > Date.now()) throw new Error('ChatGPT catalog observation time is in the future');
  const partnerId = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations)
      .where(eq(organizations.id, orgId)).limit(1);
    const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).limit(1);
    return owner ? org?.partnerId : null;
  }, 'aiModels.chatgptPlan.owner'));
  if (!partnerId || !(await ensurePartnerCutover(partnerId))) throw new Error('ChatGPT plan owner registry is unavailable');

  await inPartnerEnvLock(partnerId, async () => {
    const [existing] = await db.select().from(partnerAiConnections).where(eq(partnerAiConnections.id, id)).for('update');
    if (existing && (existing.kind !== 'chatgpt_plan' || existing.partnerId !== partnerId ||
        existing.connectedBy !== ownerId || existing.providerConfig?.orgId !== orgId)) {
      throw new Error('ChatGPT plan connection binding changed');
    }
    if (existing?.status === 'disconnected') return;
    if (existing?.verifiedAt && existing.verifiedAt > verifiedAt) return;
    if (!existing) {
      await db.insert(partnerAiConnections).values({
        id, partnerId, kind: 'chatgpt_plan', name: 'OpenAI Codex', connectedBy: ownerId,
        providerConfig: { orgId }, verifiedAt, lastDiscoveredAt: verifiedAt,
      });
    } else {
      await db.update(partnerAiConnections).set({ verifiedAt, lastDiscoveredAt: verifiedAt, updatedAt: new Date() })
        .where(and(eq(partnerAiConnections.id, id), eq(partnerAiConnections.partnerId, partnerId)));
    }

    const saved = await db.select().from(partnerAiModels).where(and(
      eq(partnerAiModels.connectionId, id), eq(partnerAiModels.partnerId, partnerId),
    ));
    const byModel = new Map(saved.map(model => [model.modelId, model]));
    for (const model of catalog.models) {
      const defaultEffort = model.slug === 'gpt-6-luna' && model.supportedEfforts.includes('low') ? 'low' : model.defaultEffort;
      const fields = {
        displayName: model.displayName,
        capabilities: { chatgptPlan: { efforts: model.supportedEfforts, defaultEffort } },
        lifecycle: 'available' as const, lastSeenAt: verifiedAt,
      };
      const row = byModel.get(model.slug);
      if (row) {
        byModel.delete(model.slug);
        await db.update(partnerAiModels).set({ ...fields, updatedAt: new Date() })
          .where(and(eq(partnerAiModels.id, row.id), eq(partnerAiModels.partnerId, partnerId)));
      } else {
        await db.insert(partnerAiModels).values({
          ...fields, defaultOptions: defaultEffort ? { effort: defaultEffort } : null, partnerId, connectionId: id,
          modelId: model.slug, source: 'discovered', enabled: true,
        });
      }
    }
    for (const row of byModel.values()) {
      await db.update(partnerAiModels).set({ lifecycle: 'missing', updatedAt: new Date() })
        .where(and(eq(partnerAiModels.id, row.id), eq(partnerAiModels.partnerId, partnerId)));
    }
    if (!existing && process.env.BREEZE_CODEX_PLAN_ENABLE_MODEL_CHOICES === 'true') {
      await enableInitialPlanChoices(partnerId, orgId, id);
    }
  });
}

/** An explicitly requested one-time setup preserves defaults and every existing permitted model. */
async function enableInitialPlanChoices(partnerId: string, orgId: string, connectionId: string): Promise<void> {
  const offerings = await db.select({ id: partnerAiModels.id }).from(partnerAiModels)
    .where(and(eq(partnerAiModels.partnerId, partnerId), eq(partnerAiModels.connectionId, connectionId)));
  const partnerRows = await db.select().from(aiModelAssignments).where(and(
    eq(aiModelAssignments.partnerId, partnerId), isNull(aiModelAssignments.orgId),
    inArray(aiModelAssignments.surface, ['chat', 'script_builder']), eq(aiModelAssignments.role, 'default'),
  ));
  const orgRows = await db.select().from(aiModelAssignments).where(and(
    eq(aiModelAssignments.offeringPartnerId, partnerId), eq(aiModelAssignments.orgId, orgId),
    inArray(aiModelAssignments.surface, ['chat', 'script_builder']), eq(aiModelAssignments.role, 'default'),
  ));
  const newIds = offerings.map(offering => offering.id);
  for (const row of [...partnerRows, ...orgRows]) {
    const permitted = row.permittedOfferingIds;
    await db.update(aiModelAssignments).set({
      allowUserChoice: row.orgId ? null : true,
      permittedOfferingIds: permitted ? [...new Set([...permitted, ...newIds])] : null,
      updatedAt: new Date(),
    }).where(and(eq(aiModelAssignments.id, row.id), eq(aiModelAssignments.offeringPartnerId, partnerId)));
  }
}
