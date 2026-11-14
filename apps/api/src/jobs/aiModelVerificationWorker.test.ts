import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { addMock, getJobMock, verifyMock, capMock, workerCtor, workerClose, queueClose } = vi.hoisted(() => ({
  addMock: vi.fn(), getJobMock: vi.fn(), verifyMock: vi.fn(), capMock: vi.fn(),
  workerCtor: vi.fn(), workerClose: vi.fn(), queueClose: vi.fn(),
}));
vi.mock('bullmq', () => ({
  Queue: class {
    add = (...args: unknown[]) => addMock(...args);
    getJob = (...args: unknown[]) => getJobMock(...args);
    setGlobalConcurrency = (...args: unknown[]) => capMock(...args);
    close = queueClose;
  },
  Worker: class {
    constructor(...args: unknown[]) { workerCtor(...args); }
    on = vi.fn(); close = workerClose;
  },
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/aiModels/offeringVerification', () => ({ verifyConnectionOffering: (...args: unknown[]) => verifyMock(...args) }));

import {
  classifyAiModelVerificationFailure, initializeAiModelVerificationWorker, OfferingVerificationRetry,
  processAiModelVerificationJob, shutdownAiModelVerificationWorker,
} from './aiModelVerificationWorker';
import {
  AI_MODEL_VERIFICATION_QUEUE, delegateLegacyOfferingVerification, enqueueOfferingVerification,
  VERIFY_OFFERING_JOB, verifyOfferingJobId,
} from './aiModelVerificationQueue';

beforeEach(() => {
  vi.clearAllMocks();
  getJobMock.mockResolvedValue(null);
  capMock.mockResolvedValue(undefined);
  addMock.mockImplementation(async (_name: string, _data: unknown, opts: { jobId: string }) => ({ id: opts.jobId }));
});
afterEach(async () => { await shutdownAiModelVerificationWorker(); });

describe('ai-model-verification queue', () => {
  it('starts once with a queue-wide and per-worker concurrency of one', async () => {
    await initializeAiModelVerificationWorker();
    await initializeAiModelVerificationWorker();
    expect(capMock).toHaveBeenCalledExactlyOnceWith(1);
    expect(workerCtor).toHaveBeenCalledExactlyOnceWith(
      AI_MODEL_VERIFICATION_QUEUE, processAiModelVerificationJob,
      { connection: { host: 'localhost', port: 6379 }, concurrency: 1 },
    );
    await shutdownAiModelVerificationWorker();
    await shutdownAiModelVerificationWorker();
    expect(workerClose).toHaveBeenCalledTimes(1);
    expect(queueClose).toHaveBeenCalledTimes(1);
  });

  it('starts no SDK worker when the queue-wide concurrency cap cannot be established', async () => {
    capMock.mockRejectedValueOnce(new Error('Redis unavailable'));
    await expect(initializeAiModelVerificationWorker()).rejects.toThrow('Redis unavailable');
    expect(workerCtor).not.toHaveBeenCalled();
    expect(queueClose).toHaveBeenCalledTimes(1);
  });

  it('classifies retry verdicts as expected warnings with one-line stacks', () => {
    const error = new OfferingVerificationRetry('o1');
    expect(error.stack?.split('\n')).toHaveLength(1);
    expect(classifyAiModelVerificationFailure(undefined, error)).toEqual({
      level: 'warning', reason: 'ai_offering_verification_retry', reportOnlyWhenExhausted: true,
    });
    expect(classifyAiModelVerificationFailure(undefined, new Error('database fault'))).toBeNull();
  });

  it('rejects an unknown execution job type', async () => {
    await expect(processAiModelVerificationJob({ data: { type: 'sync-platform' } as never })).rejects.toThrow('Unknown');
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('explicit requests replace a spent record, preserving a user-requested retry', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    getJobMock.mockResolvedValue({ id: 'verify-offering-o1', getState: async () => 'failed', remove });
    const input = { offeringId: 'o1', partnerId: 'p1', extra: 'not-queue-data' };
    await enqueueOfferingVerification(input);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith(VERIFY_OFFERING_JOB,
      { type: 'verify-offering', offeringId: 'o1', partnerId: 'p1' },
      { jobId: 'verify-offering-o1', attempts: 1, removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } },
    );
  });

  describe('legacy discovery-queue handoff', () => {
    const payload = { type: 'verify-offering' as const, offeringId: 'o1', partnerId: 'p1', retryFailed: true as const };

    it('forwards only identifiers and keeps only the remaining retry budget', async () => {
      const extended = { ...payload, extra: 'not-queue-data' };
      await expect(delegateLegacyOfferingVerification(extended, 1)).resolves.toEqual({
        offeringId: 'o1', state: 'delegated', queue: AI_MODEL_VERIFICATION_QUEUE,
      });
      expect(addMock).toHaveBeenCalledWith(VERIFY_OFFERING_JOB, payload, {
        jobId: 'verify-offering-o1', attempts: 2, backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: false, removeOnFail: false,
      });
      expect(verifyMock).not.toHaveBeenCalled();
    });

    it.each(['waiting', 'active', 'completed', 'failed'])('does not replay an existing %s target after handoff retry', async (state) => {
      const remove = vi.fn(); const getState = vi.fn(async () => state);
      getJobMock.mockResolvedValue({ id: 'verify-offering-o1', data: payload, remove, getState });
      await delegateLegacyOfferingVerification(payload, 1);
      expect(addMock).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(getState).not.toHaveBeenCalled();
    });

    it('does not restart an exhausted original request', async () => {
      await expect(delegateLegacyOfferingVerification(payload, 3)).resolves.toMatchObject({ state: 'attempts_exhausted' });
      const manual = { type: 'verify-offering' as const, offeringId: 'o1', partnerId: 'p1' };
      await expect(delegateLegacyOfferingVerification(manual, 1)).resolves.toMatchObject({ state: 'attempts_exhausted' });
      expect(addMock).not.toHaveBeenCalled();
      expect(getJobMock).not.toHaveBeenCalled();
    });

    it('rejects mismatched partner ownership and malformed retry metadata', async () => {
      getJobMock.mockResolvedValue({ data: { ...payload, partnerId: 'foreign' } });
      await expect(delegateLegacyOfferingVerification(payload)).rejects.toThrow('binding mismatch');
      await expect(delegateLegacyOfferingVerification(payload, -1)).rejects.toThrow('Invalid');
      await expect(delegateLegacyOfferingVerification(payload, 1.5)).rejects.toThrow('Invalid');
      expect(addMock).not.toHaveBeenCalled();
    });

    it('recovers an ambiguous enqueue response without adding another request', async () => {
      getJobMock.mockResolvedValueOnce(null).mockResolvedValueOnce({ data: payload });
      addMock.mockRejectedValueOnce(new Error('reply lost'));
      await expect(delegateLegacyOfferingVerification(payload)).rejects.toThrow('reply lost');
      await expect(delegateLegacyOfferingVerification(payload)).resolves.toMatchObject({ state: 'delegated' });
      expect(addMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('verify-offering (W06 #7604)', () => {
    it('job name and per-offering, colon-free job id', () => {
      expect(VERIFY_OFFERING_JOB).toBe('verify-offering');
      expect(verifyOfferingJobId('o1')).toBe('verify-offering-o1');
      expect(verifyOfferingJobId('o1')).not.toContain(':');
    });

    it('routes verify-offering to verifyConnectionOffering with exactly the payload ids', async () => {
      verifyMock.mockResolvedValueOnce({ offeringId: 'o1', state: 'verified', record: { summary: null } });
      await expect(processAiModelVerificationJob({ data: { type: 'verify-offering', offeringId: 'o1', partnerId: 'p1' } }))
        .resolves.toEqual({ offeringId: 'o1', state: 'verified' });
      expect(verifyMock).toHaveBeenCalledWith({ offeringId: 'o1', partnerId: 'p1' });
    });

    it('a failed verification is a stored result, not a job failure; the return value carries no record detail', async () => {
      verifyMock.mockResolvedValueOnce({ offeringId: 'o1', state: 'failed', record: { summary: 'direct_tool_use: x' } });
      const out = await processAiModelVerificationJob({ data: { type: 'verify-offering', offeringId: 'o1', partnerId: 'p1' } });
      expect(out).toEqual({ offeringId: 'o1', state: 'failed' });
    });

    it('a refusal (missing / foreign / disconnected offering) fails the job', async () => {
      verifyMock.mockRejectedValueOnce(Object.assign(new Error('Model not found.'), { status: 404 }));
      await expect(processAiModelVerificationJob({ data: { type: 'verify-offering', offeringId: 'o1', partnerId: 'p1' } }))
        .rejects.toThrow(/not found/);
    });

    it('enqueueOfferingVerification: job verify-offering, jobId verify-offering-<id>, ids-only payload, attempts 1', async () => {
      await enqueueOfferingVerification({ offeringId: 'o1', partnerId: 'p1' });
      const [name, payload, opts] = addMock.mock.calls.at(-1)!;
      expect(name).toBe('verify-offering');
      // Only ids: never key material, a base URL, or anything else.
      expect(payload).toEqual({ type: 'verify-offering', offeringId: 'o1', partnerId: 'p1' });
      expect(Object.keys(payload as object).sort()).toEqual(['offeringId', 'partnerId', 'type']);
      // A failed verification is a result, not a retryable error (and a retry would re-spend partner tokens).
      expect(opts).toMatchObject({ jobId: 'verify-offering-o1', attempts: 1 });
    });

    it('a run superseded because the connection changed (a click merged into an in-flight run) re-runs once against the current connection', async () => {
      verifyMock
        .mockResolvedValueOnce({ offeringId: 'o1', state: 'superseded', connectionChanged: true, record: {} })
        .mockResolvedValueOnce({ offeringId: 'o1', state: 'verified', connectionChanged: false, record: {} });
      await expect(processAiModelVerificationJob({ data: { type: 'verify-offering', offeringId: 'o1', partnerId: 'p1' } }))
        .resolves.toEqual({ offeringId: 'o1', state: 'verified' });
      expect(verifyMock).toHaveBeenCalledTimes(2);
      expect(verifyMock).toHaveBeenNthCalledWith(2, { offeringId: 'o1', partnerId: 'p1' });
    });

    it('re-runs at most once, and never for a run superseded by a newer verdict', async () => {
      verifyMock.mockResolvedValue({ offeringId: 'o1', state: 'superseded', connectionChanged: true, record: {} });
      await expect(processAiModelVerificationJob({ data: { type: 'verify-offering', offeringId: 'o1', partnerId: 'p1' } }))
        .resolves.toEqual({ offeringId: 'o1', state: 'superseded' });
      expect(verifyMock).toHaveBeenCalledTimes(2);
      verifyMock.mockReset().mockResolvedValue({ offeringId: 'o1', state: 'superseded', connectionChanged: false, record: {} });
      await processAiModelVerificationJob({ data: { type: 'verify-offering', offeringId: 'o1', partnerId: 'p1' } });
      expect(verifyMock).toHaveBeenCalledTimes(1);
    });

    it('env path (retryFailed): a failed verdict fails the attempt so BullMQ retries it later; the record is already stored', async () => {
      verifyMock.mockResolvedValue({ offeringId: 'o1', state: 'failed', connectionChanged: false, record: { summary: 'x' } });
      await expect(processAiModelVerificationJob({ data: { type: 'verify-offering', offeringId: 'o1', partnerId: 'p1', retryFailed: true } }))
        .rejects.toThrow(/retry/i);
      verifyMock.mockResolvedValue({ offeringId: 'o1', state: 'verified', connectionChanged: false, record: {} });
      await expect(processAiModelVerificationJob({ data: { type: 'verify-offering', offeringId: 'o1', partnerId: 'p1', retryFailed: true } }))
        .resolves.toEqual({ offeringId: 'o1', state: 'verified' });
    });

    it('enqueueOfferingVerification(retryFailed): 3 attempts with a delayed exponential backoff, payload ids plus the flag only', async () => {
      await enqueueOfferingVerification({ offeringId: 'o1', partnerId: 'p1' }, { retryFailed: true });
      const [name, payload, opts] = addMock.mock.calls.at(-1)!;
      expect(name).toBe('verify-offering');
      expect(payload).toEqual({ type: 'verify-offering', offeringId: 'o1', partnerId: 'p1', retryFailed: true });
      expect(opts).toMatchObject({ jobId: 'verify-offering-o1', attempts: 3, backoff: { type: 'exponential', delay: 60_000 } });
    });

    it('collapses onto a waiting verification of the same offering', async () => {
      getJobMock.mockResolvedValue({ id: 'verify-offering-o1', getState: async () => 'waiting' });
      await enqueueOfferingVerification({ offeringId: 'o1', partnerId: 'p1' });
      expect(addMock).not.toHaveBeenCalled();
    });
  });
});
