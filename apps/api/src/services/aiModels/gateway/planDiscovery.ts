import { joinByoUrl } from './byoEndpointPolicy';
import { forwardUpstream } from './forward';
import { discoveryGrantRecord } from './grants';
import type { GatewayConnectionConfig, GatewayCredential } from './types';

/** Catalog transport stays inside the gateway; the registry validates and persists it. */
export async function discoverChatGptPlanCatalog(input: {
  config: GatewayConnectionConfig;
  credential: GatewayCredential;
}): Promise<unknown> {
  const response = await forwardUpstream(discoveryGrantRecord(input.config, input.credential), {
    url: joinByoUrl(input.config.baseUrl, 'models'), method: 'GET',
    headers: { accept: 'application/json' }, stream: false, maxBytes: 128_000,
  }, AbortSignal.timeout(20_000));
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('ChatGPT account catalog unavailable');
  }
  return response.json();
}
