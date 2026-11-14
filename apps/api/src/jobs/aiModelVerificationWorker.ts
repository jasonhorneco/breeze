/** Execution-class model qualification: runs only on the API/socket-owning role. */
import { Worker, type Job } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { verifyConnectionOffering, type OfferingVerificationState } from '../services/aiModels/offeringVerification';
import { attachWorkerObservability, type WorkerFailureClassification } from './workerObservability';
import {
  AI_MODEL_VERIFICATION_QUEUE, closeAiModelVerificationQueue, getAiModelVerificationQueue,
  type AiModelVerificationJobData,
} from './aiModelVerificationQueue';

export class OfferingVerificationRetry extends Error {
  constructor(offeringId: string) {
    super(`Offering ${offeringId} failed verification; the queue will retry it`);
    this.name = 'OfferingVerificationRetry';
    this.stack = `${this.name}: ${this.message}`;
  }
}

export function classifyAiModelVerificationFailure(_job: Job | undefined, error: Error): WorkerFailureClassification | null {
  return error instanceof OfferingVerificationRetry
    ? { level: 'warning', reason: 'ai_offering_verification_retry', reportOnlyWhenExhausted: true }
    : null;
}

export async function processAiModelVerificationJob(
  job: Pick<Job<AiModelVerificationJobData>, 'data'>,
): Promise<{ offeringId: string; state: OfferingVerificationState }> {
  if (job.data.type !== 'verify-offering') throw new Error('Unknown ai-model-verification job type');
  const input = { offeringId: job.data.offeringId, partnerId: job.data.partnerId };
  let result = await verifyConnectionOffering(input);
  // Retain the existing one-time recheck after a connection rotation, and
  // never rerun a verdict merely superseded by a newer verification.
  if (result.state === 'superseded' && result.connectionChanged) result = await verifyConnectionOffering(input);
  if (result.state === 'failed' && job.data.retryFailed) throw new OfferingVerificationRetry(result.offeringId);
  return { offeringId: result.offeringId, state: result.state };
}

let worker: Worker<AiModelVerificationJobData> | null = null;

export async function initializeAiModelVerificationWorker(): Promise<void> {
  if (worker) return;
  // A queue-wide cap keeps adding API replicas from multiplying SDK runs.
  // Fail closed at initialization if Redis cannot establish this cap.
  try {
    await getAiModelVerificationQueue().setGlobalConcurrency(1);
  } catch (error) {
    await closeAiModelVerificationQueue();
    throw error;
  }
  worker = new Worker<AiModelVerificationJobData>(AI_MODEL_VERIFICATION_QUEUE, processAiModelVerificationJob, {
    connection: getBullMQConnection(), concurrency: 1,
  });
  attachWorkerObservability(worker, 'aiModelVerificationWorker', { classifyFailure: classifyAiModelVerificationFailure });
}

export async function shutdownAiModelVerificationWorker(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
  await closeAiModelVerificationQueue();
}
