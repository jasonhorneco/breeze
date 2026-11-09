import type { DnsEvent, DnsProvider } from './index';
import { DnsProviderHttpError, requestJson } from './http';
import { asArray, asNumber, asRecord, asString } from './helpers';

export interface PiHoleV6ProviderConfig {
  apiEndpoint?: string;
}

// Pi-hole v6 query status strings (FTL `enum query_status`). A query is "blocked"
// when it was stopped by gravity, an exact denylist, a regex denylist, a special
// (e.g. Mozilla canary) domain, or an external/upstream block. We match on
// substrings so the *_CNAME variants (GRAVITY_CNAME, DENYLIST_CNAME, …) and any
// future EXTERNAL_BLOCKED_* additions are covered without an exhaustive list.
// Everything else (FORWARDED, CACHE, CACHE_STALE, RETRIED, …) is "allowed".
const BLOCKED_STATUS_PATTERN = /GRAVITY|DENYLIST|REGEX|BLOCKED|SPECIAL_DOMAIN/;

/**
 * Pi-hole v6 client.
 *
 * v6 replaced the v5 `/admin/api.php?...&auth=<token>` surface with a
 * session-based REST API: POST `/api/auth` with the app password returns a
 * session id (SID), which is then sent on every subsequent request via the
 * `X-FTL-SID` header. We authenticate lazily on the first call and reuse the
 * SID for the lifetime of this provider instance (one sync run), re-authing
 * once if the session expires mid-run (HTTP 401).
 */
export class PiHoleV6Provider implements DnsProvider {
  private sid: string | null = null;

  constructor(
    // The Pi-hole v6 app password (used as the `password` in POST /api/auth).
    private readonly appPassword: string,
    private readonly config: PiHoleV6ProviderConfig,
    private readonly allowPrivateNetwork = false,
    private readonly allowCarrierNat = false
  ) {}

  private baseUrl(): string {
    const endpoint = this.config.apiEndpoint;
    if (!endpoint) {
      throw new Error('Pi-hole integration requires config.apiEndpoint');
    }
    return endpoint.replace(/\/+$/, '');
  }

  // POST /api/auth { password } → { session: { valid, sid, validity, … } }.
  private async authenticate(): Promise<string> {
    let payload: Record<string, unknown>;
    try {
      payload = await requestJson<Record<string, unknown>>(`${this.baseUrl()}/api/auth`, {
        method: 'POST',
        allowPrivateNetwork: this.allowPrivateNetwork,
        allowCarrierNat: this.allowCarrierNat,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: this.appPassword })
      });
    } catch (error) {
      // Pi-hole has a finite pool of session seats and returns 429 with a
      // `no_seats` error body when they're exhausted. That is NOT a transient
      // rate-limit — retrying won't free a seat on this timescale — so surface
      // a distinct, actionable message instead of a generic HTTP 429. (We only
      // INSPECT responseBody server-side to pick the message; it is never
      // reflected to the tenant — see DnsProviderHttpError.) dispose() releasing
      // sessions after each run is what keeps this from happening in the first
      // place.
      if (error instanceof DnsProviderHttpError && error.status === 429 && error.responseBody.includes('no_seats')) {
        throw new Error(
          'Pi-hole v6 authentication failed: all session seats are in use (HTTP 429 no_seats). ' +
          'Existing sessions must expire or be released before a new sync can authenticate.'
        );
      }
      throw error;
    }

    const session = asRecord(payload.session);
    const sid = asString(session?.sid);
    if (!sid || session?.valid === false) {
      throw new Error('Pi-hole v6 authentication failed (no valid session returned)');
    }
    this.sid = sid;
    return sid;
  }

  // Authenticated request with the X-FTL-SID header. If the session has expired
  // (401), re-authenticate once and retry — long sync runs can outlive the
  // session validity window.
  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const sid = this.sid ?? (await this.authenticate());
    try {
      return await this.callWithSid<T>(path, sid, init);
    } catch (error) {
      if (error instanceof DnsProviderHttpError && error.status === 401) {
        const fresh = await this.authenticate();
        return this.callWithSid<T>(path, fresh, init);
      }
      throw error;
    }
  }

  private async callWithSid<T>(path: string, sid: string, init: RequestInit): Promise<T> {
    return requestJson<T>(`${this.baseUrl()}${path}`, {
      ...init,
      allowPrivateNetwork: this.allowPrivateNetwork,
      allowCarrierNat: this.allowCarrierNat,
      headers: {
        'X-FTL-SID': sid,
        ...(init.headers ?? {})
      }
    });
  }

  async syncEvents(since: Date, until: Date): Promise<DnsEvent[]> {
    // Pi-hole's /api/queries is paginated newest-first. We bound the window
    // server-side with from/until (unix seconds). `cursor` is a stable snapshot
    // ceiling, not a next-page token; `start` advances within that snapshot.
    // Cap the work and reject incomplete windows so lastSync cannot skip them.
    const fromSec = Math.floor(since.getTime() / 1000);
    const untilSec = Math.ceil(until.getTime() / 1000);
    const perPage = 1000;
    const maxPages = 50;
    const events: DnsEvent[] = [];
    // Count rows we drop as unparseable (NOT in-window trims) so a silent
    // upstream shape drift — which would otherwise return [] and be recorded as
    // a healthy "success" sync — is observable in the server logs.
    let skipped = 0;
    let cursor: number | undefined;
    let offset = 0;
    let previousPage: string | undefined;

    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({
        from: String(fromSec),
        until: String(untilSec),
        length: String(perPage),
        start: String(offset)
      });
      if (cursor !== undefined) params.set('cursor', String(cursor));

      const payload = await this.call<Record<string, unknown>>(`/api/queries?${params.toString()}`);
      const rows = asArray(payload.queries);
      if (rows.length > 0) {
        const first = asRecord(rows[0]);
        const last = asRecord(rows[rows.length - 1]);
        const signature = JSON.stringify([first?.id, first?.time, first?.domain, last?.id, last?.time, last?.domain]);
        if (signature === previousPage) throw new Error('Pi-hole v6 query pagination did not advance; window is incomplete');
        previousPage = signature;
      }

      for (const entry of rows) {
        const record = asRecord(entry);
        if (!record) { skipped++; continue; }

        const epoch = asNumber(record.time);
        const domain = asString(record.domain);
        if (!epoch || !domain) { skipped++; continue; }

        const timestamp = new Date(epoch * 1000);
        if (Number.isNaN(timestamp.getTime())) { skipped++; continue; }
        // In-window trim is expected (defensive double-check of the server-side
        // from/until bound), not malformed data — don't count it as skipped.
        if (timestamp < since || timestamp > until) continue;

        const status = asString(record.status) ?? '';
        const client = asRecord(record.client);
        const sourceIp = asString(client?.ip);
        const sourceHostname = asString(client?.name);
        const id = asNumber(record.id);

        events.push({
          timestamp,
          domain,
          queryType: asString(record.type) ?? 'A',
          action: BLOCKED_STATUS_PATTERN.test(status) ? 'blocked' : 'allowed',
          sourceIp,
          sourceHostname,
          providerEventId: id !== undefined
            ? `v6-${id}`
            : `${epoch}-${domain}-${sourceIp ?? 'unknown'}`,
          metadata: { status }
        });
      }

      if (cursor === undefined) cursor = asNumber(payload.cursor);
      offset += rows.length;
      const total = asNumber(payload.recordsFiltered);
      if (rows.length < perPage || (total !== undefined && offset >= total)) break;
      if (page === maxPages - 1) {
        throw new Error(`Pi-hole v6 query sync exceeded its ${maxPages}-page budget; window is incomplete`);
      }
    }

    if (skipped > 0) {
      console.warn(`[PiHoleV6] query sync skipped ${skipped} unparseable row(s) (possible API shape drift).`);
    }

    return events;
  }

  // Pi-hole v6 exact-match domain lists: POST /api/domains/{deny|allow}/exact to
  // add, DELETE /api/domains/{deny|allow}/exact/{domain} to remove.
  private async addDomain(type: 'deny' | 'allow', domain: string): Promise<void> {
    await this.call<unknown>(`/api/domains/${type}/exact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain })
    });
  }

  private async removeDomain(type: 'deny' | 'allow', domain: string): Promise<void> {
    try {
      await this.call<unknown>(`/api/domains/${type}/exact/${encodeURIComponent(domain)}`, {
        method: 'DELETE'
      });
    } catch (error) {
      // A 404 means the domain is already absent — that is the desired end
      // state for a removal, so treat it as a no-op rather than a sync error.
      // Any other error still propagates.
      if (error instanceof DnsProviderHttpError && error.status === 404) return;
      throw error;
    }
  }

  async addBlocklistDomain(domain: string): Promise<void> {
    await this.addDomain('deny', domain);
  }

  async removeBlocklistDomain(domain: string): Promise<void> {
    await this.removeDomain('deny', domain);
  }

  async addAllowlistDomain(domain: string): Promise<void> {
    await this.addDomain('allow', domain);
  }

  async removeAllowlistDomain(domain: string): Promise<void> {
    await this.removeDomain('allow', domain);
  }

  // Release the session (DELETE /api/auth) so it doesn't occupy one of Pi-hole's
  // finite session seats until it ages out. v6 auth is stateful and seat-limited
  // (POST /api/auth can return 429 `no_seats`), so a sync that runs every few
  // minutes against a 30-minute session lifetime would otherwise accumulate
  // orphaned sessions. Best-effort: a failed logout just lets the session age
  // out on its own, so this never throws and never masks the sync result.
  async dispose(): Promise<void> {
    const sid = this.sid;
    if (!sid) return;
    this.sid = null;
    try {
      await this.callWithSid('/api/auth', sid, { method: 'DELETE' });
    } catch (error) {
      console.warn('[PiHoleV6] failed to release session:', error instanceof Error ? error.message : error);
    }
  }
}
