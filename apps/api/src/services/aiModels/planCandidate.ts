import { readFileSync } from 'node:fs';
import { EFFORT_LEVELS, emptyOptionSupport } from '@breeze/shared';
import { z } from 'zod';
import type { LoadedCandidate } from './candidateLoader';
import type { PartnerAiConnection } from './connections';
import type { GatewayConnectionConfig, GatewayCredential } from './gateway/types';
import type { Offering } from './offerings';
import { resolveEffectiveContextWindow } from './contextWindowFacts';
import { toolProfileFactsFrom } from './toolProfileFacts';

const planOffering = z.object({
  efforts: z.array(z.enum(EFFORT_LEVELS)),
  defaultEffort: z.enum(EFFORT_LEVELS).nullable(),
}).refine(model => model.efforts.length === 0 ? model.defaultEffort === null
  : model.defaultEffort !== null && model.efforts.includes(model.defaultEffort));

export function planWorker(conn: PartnerAiConnection): {
  config: GatewayConnectionConfig;
  credential: GatewayCredential;
} | null {
  const { BREEZE_CODEX_PLAN_WORKER_URL: worker, BREEZE_CODEX_PLAN_WORKER_KEY_FILE: keyPath } = process.env;
  if (!worker || !keyPath || conn.id !== process.env.BREEZE_CODEX_PLAN_CONNECTION_ID) return null;
  try {
    const url = new URL(worker);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    const secret = readFileSync(keyPath, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(secret)) return null;
    return {
      config: {
        source: 'gateway', kind: 'chatgpt_plan', baseUrl: url.href, partnerId: conn.partnerId,
        connectionId: conn.id, configVersion: conn.configVersion,
      },
      credential: { secret },
    };
  } catch {
    return null;
  }
}

export function planCandidate(offering: Offering, conn: PartnerAiConnection): LoadedCandidate {
  const model = planOffering.safeParse(offering.capabilities?.chatgptPlan);
  const wireModel = offering.modelId ?? '';
  const route = model.success && wireModel ? planWorker(conn) : null;
  const effortLevels = model.success ? [...new Set(model.data.efforts)] : [];
  const savedEffort = z.enum(EFFORT_LEVELS).safeParse(offering.defaultOptions?.effort);
  const defaultEffort = savedEffort.success && effortLevels.includes(savedEffort.data)
    ? savedEffort.data : model.success ? model.data.defaultEffort : null;
  const window = resolveEffectiveContextWindow(offering, conn.configVersion);
  return {
    toolProfileFacts: toolProfileFactsFrom(offering, 'gateway', window.value),
    facts: {
      ownerPartnerId: offering.partnerId, enabled: offering.enabled, lifecycle: offering.lifecycle,
      requiredPermission: offering.requiredPermission, platform: null, catalog: null,
      connection: { kind: 'chatgpt_plan', status: conn.status, keyUsable: route !== null },
      rate: { source: 'offering', standard: { inputCentsPerM: 0, outputCentsPerM: 0, cacheReadCentsPerM: 0, cacheWriteCentsPerM: 0 } },
      supportsTools: true, inferenceGeo: null, supportedInferenceGeos: [],
      planOwnerId: conn.connectedBy,
      planOrgId: typeof conn.providerConfig?.orgId === 'string' ? conn.providerConfig.orgId : null,
    },
    offeringId: offering.id, connectionId: conn.id,
    displayName: offering.displayName ?? wireModel, logicalModel: wireModel, wireModel,
    connection: route ? { id: conn.id, kind: 'chatgpt_plan', ...route } : null,
    funding: 'chatgpt_plan',
    capabilities: { thinkingMode: effortLevels.length ? 'adaptive' : 'none', effortLevels, supportsTools: true, supportsVision: false },
    optionSupport: { ...emptyOptionSupport(), effort: effortLevels },
    optionRates: null,
    defaultOptions: defaultEffort ? { effort: defaultEffort } : null,
    allowedOptions: null,
    refusalFallbackOfferingId: null,
    promptProfile: 'generic',
    limits: { maxInputTokens: window.value, maxOutputTokens: null },
    configVersion: conn.configVersion,
  };
}
