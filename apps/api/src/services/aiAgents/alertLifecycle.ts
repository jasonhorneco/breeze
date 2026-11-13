/** Scoped alert facts. Optional fields keep historical callers compatible; the live loader fills them. */
export interface AlertLifecycleContext {
  id?: string;
  status?: string;
  triggeredAt?: Date | string | null;
  resolvedAt?: Date | string | null;
  observedAt?: Date | string | null;
  title: string;
  severity: string;
  message: string | null;
}

export interface AlertTriggerContext {
  phase: 'trigger' | 'recovery' | 'correlation' | 'ungrouped' | 'unknown';
  reason: 'alert_triggered' | 'auto_resolved' | 'group_created' | 'ungrouped' | 'unknown';
}

/** Interpret only server-owned lifecycle markers, never arbitrary trigger-ref text. */
export function alertTriggerContext(run: {
  triggerKind: string;
  profile?: string;
  triggerRef?: unknown;
}): AlertTriggerContext | null {
  if (run.triggerKind !== 'alert') return null;
  const ref = run.triggerRef && typeof run.triggerRef === 'object'
    ? run.triggerRef as Record<string, unknown> : {};
  switch (ref.verdictReason) {
    case 'auto_resolved': return { phase: 'recovery', reason: 'auto_resolved' };
    case 'group_created': return { phase: 'correlation', reason: 'group_created' };
    case 'ungrouped': return { phase: 'ungrouped', reason: 'ungrouped' };
    default: return run.profile === 'full'
      ? { phase: 'trigger', reason: 'alert_triggered' }
      : { phase: 'unknown', reason: 'unknown' };
  }
}
