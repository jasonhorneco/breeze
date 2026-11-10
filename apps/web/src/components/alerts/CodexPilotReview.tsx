import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction } from '../../lib/runAction';

type Proposal = { kind: 'policy' | 'script'; title: string; draft: string; risk: string };
type Review = {
  finding: string;
  citations: string[];
  unknown: string;
  proposal: Proposal | null;
  decision: 'pending' | 'accepted' | 'rejected' | 'none';
  model: string;
  effort: string;
};
type PilotState = {
  review: Review | null;
  attempt: { state: 'started' | 'completed' | 'failed'; code?: string } | null;
  approval?: { id: string; status: string };
};

function failureMessage(code: string | undefined) {
  switch (code) {
    case 'plan_limit_stopped':
      return 'Your ChatGPT plan limit was reached. The pilot is stopped.';
    case 'chatgpt_sign_in_required':
      return 'The pilot needs your ChatGPT sign-in.';
    default:
      return 'This attempt did not produce a review.';
  }
}

export function CodexPilotReview({ alertId }: { alertId: string }) {
  const path = '/alerts/' + alertId + '/codex-review';
  const [pilot, setPilot] = useState<PilotState | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetchWithAuth(path, { signal });
      if (!response.ok) throw new Error('Review unavailable');
      const value = await response.json() as PilotState;
      if (!signal?.aborted) {
        setPilot(value);
        setUnavailable(false);
      }
    } catch {
      if (!signal?.aborted) setUnavailable(true);
    }
  }, [path]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const review = pilot?.review;
  const attempt = pilot?.attempt;

  async function submit(publish = false) {
    setBusy(true);
    try {
      const data = await runAction<PilotState>({
        request: () => fetchWithAuth(path + (publish ? '/publish' : ''), {
          method: 'POST',
        }),
        errorFallback: 'The Codex pilot request failed.',
      });
      setPilot(data);
      setUnavailable(false);
    } catch {
      // runAction reports the failure. Refresh to reconcile an interrupted request.
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 rounded-lg border bg-card p-6 text-sm" data-testid="codex-pilot-review">
      <h2 className="text-base font-semibold">Codex pilot review</h2>
      <p className="text-muted-foreground">Uses your ChatGPT plan. The pilot records findings and your decision on a draft.</p>
      {unavailable && <p role="status">The review service is unavailable.</p>}
      {!pilot && !unavailable && <p role="status">Checking the review.</p>}
      {!review && attempt?.state === 'started' && <p role="status">Codex is reviewing the stored alert. Refresh to see the result.</p>}
      {!review && attempt?.state === 'failed' && <p role="status">{failureMessage(attempt.code)}</p>}
      {pilot && !review && !attempt && (
        <button className="rounded-md border px-3 py-2" type="button" disabled={busy} onClick={() => void submit()}>
          Review this alert
        </button>
      )}
      {(unavailable || attempt?.state === 'started') && (
        <button className="rounded-md border px-3 py-2" type="button" disabled={busy} onClick={() => void refresh()}>
          Refresh
        </button>
      )}
      {review && (
        <>
          <p>{review.finding}</p>
          <p><strong>What remains uncertain</strong> {review.unknown}</p>
          <p className="text-muted-foreground">
            {review.model} ({review.effort}) · Evidence {review.citations.join(', ')}
          </p>
          {review.proposal && (
            <div className="space-y-2 rounded-md border p-3">
              <h3 className="font-semibold">{review.proposal.title}</h3>
              <p className="whitespace-pre-wrap">{review.proposal.draft}</p>
              <p><strong>Risk</strong> {review.proposal.risk}</p>
              {pilot?.approval ? (
                <p role="status">Draft review {pilot.approval.status}. <a className="underline" href="/approvals">Open Approvals</a></p>
              ) : review.decision === 'pending' ? (
                <button className="rounded-md border px-3 py-2" type="button" disabled={busy} onClick={() => void submit(true)}>
                  Send draft to Approvals
                </button>
              ) : <p role="status">Draft {review.decision}. Your review was recorded.</p>}
            </div>
          )}
        </>
      )}
    </section>
  );
}
