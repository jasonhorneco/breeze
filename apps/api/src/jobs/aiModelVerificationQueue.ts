/** Producers and legacy handoff only. This module never imports an SDK runner. */
import { Queue } from 'bullmq';
import { enqueueOrReplaceStale } from '../services/bullmqUtils';
import { getBullMQConnection } from '../services/redis';

export const AI_MODEL_VERIFICATION_QUEUE = 'ai-model-verification';
export const VERIFY_OFFERING_JOB = 'verify-offering';

export type AiModelVerificationJobData = {
  type: 'verify-offering'; offeringId: string; partnerId: string; retryFailed?: true;
};

let queue: Queue<AiModelVerificationJobData> | null = null;
export function getAiModelVerificationQueue(): Queue<AiModelVerificationJobData> {
  if (!queue) queue = new Queue<AiModelVerificationJobData>(AI_MODEL_VERIFICATION_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

/** Colon-free and per offering, preserving the existing request deduplication. */
export function verifyOfferingJobId(offeringId: string): string {
  return `verify-offering-${offeringId}`;
}

function options(attempts: number) {
  return {
    attempts,
    ...(attempts > 1 ? { backoff: { type: 'exponential', delay: 60_000 } } : {}),
    removeOnComplete: { count: 100 }, removeOnFail: { count: 100 },
  };
}

/** One admin request = one attempt; the existing env bootstrap may retry twice. */
export async function enqueueOfferingVerification(
  input: { offeringId: string; partnerId: string },
  opts: { retryFailed?: boolean } = {},
): Promise<void> {
  const payload: AiModelVerificationJobData = {
    type: 'verify-offering', offeringId: input.offeringId, partnerId: input.partnerId,
    ...(opts.retryFailed ? { retryFailed: true } : {}),
  };
  await enqueueOrReplaceStale(
    getAiModelVerificationQueue() as unknown as Queue,
    VERIFY_OFFERING_JOB, verifyOfferingJobId(input.offeringId), payload,
    options(opts.retryFailed ? 3 : 1), '[aiModelVerification]',
  );
}

/**
 * Preserve an old discovery-queue request without running the SDK globally.
 * Existing terminal jobs are retained, unlike a NEW explicit Verify click:
 * replay of the handoff after a worker crash must not spend tokens again.
 * The original attempt budget is reduced by attempts already spent.
 */
export async function delegateLegacyOfferingVerification(
  payload: AiModelVerificationJobData,
  attemptsMade = 0,
): Promise<{ offeringId: string; state: 'delegated' | 'attempts_exhausted'; queue: string }> {
  if (!Number.isSafeInteger(attemptsMade) || attemptsMade < 0) throw new Error('Invalid legacy verification attempt');
  const attempts = (payload.retryFailed ? 3 : 1) - attemptsMade;
  if (attempts <= 0) return { offeringId: payload.offeringId, state: 'attempts_exhausted', queue: AI_MODEL_VERIFICATION_QUEUE };
  const q = getAiModelVerificationQueue();
  const jobId = verifyOfferingJobId(payload.offeringId);
  const existing = await q.getJob(jobId);
  if (existing) {
    if (existing.data.offeringId !== payload.offeringId || existing.data.partnerId !== payload.partnerId) {
      throw new Error('Verification handoff binding mismatch');
    }
  } else {
    const data: AiModelVerificationJobData = {
      type: 'verify-offering', offeringId: payload.offeringId, partnerId: payload.partnerId,
      ...(payload.retryFailed ? { retryFailed: true } : {}),
    };
    await q.add(VERIFY_OFFERING_JOB, data, {
      ...options(attempts), jobId,
      // Keep the one-time handoff record across crashes. A later explicit
      // Verify click can still replace it through enqueueOrReplaceStale.
      removeOnComplete: false, removeOnFail: false,
    });
  }
  return { offeringId: payload.offeringId, state: 'delegated', queue: AI_MODEL_VERIFICATION_QUEUE };
}

export async function closeAiModelVerificationQueue(): Promise<void> {
  if (queue) { await queue.close(); queue = null; }
}
