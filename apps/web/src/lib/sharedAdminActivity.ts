/** Same-origin, same-actor activity metadata only. No tokens, cookies or timers. */
export type AdminActivityKind = 'passive' | 'deliberate';
export interface SharedAdminActivity {
  record(kind: AdminActivityKind): void;
  read(): { passiveAt: number | null; deliberateAt: number | null };
  clear(): void;
}

const WRITE_INTERVAL_MS = 1000;
const PREFIX = 'breeze-admin-activity-v1:';

function timestamp(raw: string | null, now: number): number | null {
  if (raw === null || raw.length > 24) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'number' && Number.isSafeInteger(value)
      && value >= 0 && value <= now ? value : null;
  } catch { return null; }
}

export function createSharedAdminActivity(actorId: string): SharedAdminActivity {
  // No unscoped/global fallback key while identity is absent or malformed.
  const validActor = typeof actorId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(actorId);
  const keys = {
    passive: PREFIX + actorId + ':passive',
    deliberate: PREFIX + actorId + ':deliberate'
  };
  const lastWrite = { passive: -Infinity, deliberate: -Infinity };
  const readOne = (kind: AdminActivityKind, now: number): number | null => {
    if (!validActor) return null;
    try { return timestamp(window.localStorage.getItem(keys[kind]), now); }
    catch { return null; } // Keep local idle enforcement when storage is blocked.
  };
  return {
    record(kind) {
      if (!validActor || (kind !== 'passive' && kind !== 'deliberate')) return;
      const now = Date.now();
      if (!Number.isSafeInteger(now) || now < 0) return;
      if (now >= lastWrite[kind] && now - lastWrite[kind] < WRITE_INTERVAL_MS) return;
      lastWrite[kind] = now;
      try {
        const prior = readOne(kind, now);
        if (prior === null || now > prior) window.localStorage.setItem(keys[kind], String(now));
      } catch { /* Storage failure must neither throw nor reset an idle budget. */ }
    },
    read() {
      const now = Date.now();
      return { passiveAt: readOne('passive', now), deliberateAt: readOne('deliberate', now) };
    },
    clear() {
      if (!validActor) return;
      for (const key of Object.values(keys)) {
        try { window.localStorage.removeItem(key); } catch { /* Best effort. */ }
      }
    }
  };
}
