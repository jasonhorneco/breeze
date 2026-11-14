// apps/api/src/jobs/aiModelDiscoveryWorker.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addMock, getJobMock, getRepeatableJobsMock, removeRepeatableByKeyMock, syncMock, syncConnectionMock, delegateMock, dbState, capturedProcessor, capturedWorker } = vi.hoisted(() => ({
  syncConnectionMock: vi.fn(),
  delegateMock: vi.fn(),
  dbState: { activeConnectionIds: [] as string[], whereArg: null as unknown },
  addMock: vi.fn(),
  getJobMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  syncMock: vi.fn(),
  capturedProcessor: { current: null as null | ((job: unknown) => Promise<unknown>) },
  capturedWorker: { current: null as null | { on: ReturnType<typeof vi.fn> } },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    name: string;
    constructor(name: string) { this.name = name; }
    add = (...args: unknown[]) => addMock(...args);
    getJob = (...args: unknown[]) => getJobMock(...args);
    getRepeatableJobs = () => getRepeatableJobsMock();
    removeRepeatableByKey = (...args: unknown[]) => removeRepeatableByKeyMock(...args);
    close = vi.fn();
  },
  Worker: class {
    name: string;
    constructor(name: string, processor: (job: unknown) => Promise<unknown>) {
      this.name = name;
      capturedProcessor.current = processor;
      capturedWorker.current = this as unknown as { on: ReturnType<typeof vi.fn> };
    }
    on = vi.fn();
    close = vi.fn();
  },
  Job: class {},
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/aiModels/discovery', () => ({
  syncPlatformModels: (...args: unknown[]) => syncMock(...args),
  syncConnectionModels: (...args: unknown[]) => syncConnectionMock(...args),
}));
vi.mock('./aiModelVerificationQueue', () => ({
  delegateLegacyOfferingVerification: (...args: unknown[]) => delegateMock(...args),
  closeAiModelVerificationQueue: vi.fn(),
  enqueueOfferingVerification: vi.fn(),
  verifyOfferingJobId: vi.fn(),
  VERIFY_OFFERING_JOB: 'verify-offering',
}));
vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: async (fn: () => unknown) => fn(),
  db: {
    select: () => ({
      from: () => ({
        where: async (arg: unknown) => {
          dbState.whereArg = arg;
          return dbState.activeConnectionIds.map((id) => ({ id }));
        },
      }),
    }),
  },
}));

import type { Job } from 'bullmq';
import type { SQL } from 'drizzle-orm';
import { attachWorkerObservability, type WorkerObservabilityOptions } from './workerObservability';
import { PgDialect } from 'drizzle-orm/pg-core';
import { GATEWAY_CONNECTION_KINDS } from '@breeze/shared';
import {
  AI_MODEL_DISCOVERY_QUEUE,
  SYNC_PLATFORM_JOB,
  __testOnly,
  aiModelConnectionSyncJobId,
  enqueueConnectionSync,
  enqueuePlatformModelSync,
  initializeAiModelDiscoveryWorker,
  PlatformModelSyncFailed,
  processAiModelDiscoveryJob,
  scheduleAiModelDiscoveryJobs,
  shutdownAiModelDiscoveryWorker,
} from './aiModelDiscoveryWorker';

beforeEach(() => {
  vi.clearAllMocks();
  addMock.mockImplementation(async (_name: string, _data: unknown, opts: { jobId?: string }) => ({ id: opts.jobId ?? 'job-1' }));
  getJobMock.mockResolvedValue(null);
  getRepeatableJobsMock.mockResolvedValue([]);
  dbState.activeConnectionIds = [];
});

describe('ai-model-discovery queue', () => {
  it('uses the index names', () => {
    expect(AI_MODEL_DISCOVERY_QUEUE).toBe('ai-model-discovery');
    expect(SYNC_PLATFORM_JOB).toBe('sync-platform');
  });

  it('schedules exactly one daily sync-platform and one daily sync-all-connections repeatable, with stable job ids', async () => {
    getRepeatableJobsMock.mockResolvedValue([{ key: 'old-key' }]);
    await scheduleAiModelDiscoveryJobs();
    expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('old-key');
    expect(addMock).toHaveBeenCalledTimes(2);
    expect(addMock).toHaveBeenCalledWith(
      'sync-platform',
      { type: 'sync-platform', trigger: 'schedule' },
      expect.objectContaining({ jobId: __testOnly.DAILY_REPEAT_JOB_ID, repeat: { pattern: __testOnly.DAILY_CRON }, attempts: 3 }),
    );
    expect(addMock).toHaveBeenCalledWith(
      'sync-all-connections',
      { type: 'sync-all-connections' },
      expect.objectContaining({ jobId: __testOnly.DAILY_CONNECTIONS_REPEAT_JOB_ID, repeat: { pattern: __testOnly.DAILY_CONNECTIONS_CRON } }),
    );
    expect(__testOnly.DAILY_REPEAT_JOB_ID).not.toContain(':');
    expect(__testOnly.DAILY_CONNECTIONS_REPEAT_JOB_ID).not.toContain(':');
  });

  it('connection sync job ids are colon-free and per connection', () => {
    expect(aiModelConnectionSyncJobId('5f0c-1')).toBe('sync-connection-5f0c-1');
    expect(aiModelConnectionSyncJobId('x')).not.toContain(':');
  });

  it('enqueueConnectionSync adds sync-connection under the per-connection job id and reuses a waiting one', async () => {
    await enqueueConnectionSync('c1');
    expect(addMock).toHaveBeenLastCalledWith(
      'sync-connection',
      { type: 'sync-connection', connectionId: 'c1' },
      expect.objectContaining({ jobId: 'sync-connection-c1', attempts: 3 }),
    );
    getJobMock.mockResolvedValue({ id: 'sync-connection-c1', getState: async () => 'waiting' });
    addMock.mockClear();
    await enqueueConnectionSync('c1');
    expect(addMock).not.toHaveBeenCalled();
  });

  it('routes sync-connection to syncConnectionModels and returns its report (a failed listing is recorded, not retried)', async () => {
    syncConnectionMock.mockResolvedValueOnce({ connectionId: 'c1', status: 'failed', error: 'HTTP 401' });
    await expect(processAiModelDiscoveryJob({ data: { type: 'sync-connection', connectionId: 'c1' } }))
      .resolves.toMatchObject({ status: 'failed' });
    expect(syncConnectionMock).toHaveBeenCalledWith('c1');
    expect(syncMock).not.toHaveBeenCalled();
  });

  it('a sync superseded by a concurrent rotation throws so BullMQ retries it with the new key', async () => {
    syncConnectionMock.mockResolvedValueOnce({ connectionId: 'c1', status: 'skipped', retry: true, error: 'connection changed during sync' });
    await expect(processAiModelDiscoveryJob({ data: { type: 'sync-connection', connectionId: 'c1' } })).rejects.toThrow(/changed/);
  });

  it('sync-all-connections fans out one sync-connection job per active BYOK/catalog connection', async () => {
    dbState.activeConnectionIds = ['a', 'b'];
    await expect(processAiModelDiscoveryJob({ data: { type: 'sync-all-connections' } })).resolves.toEqual({ enqueued: 2 });
    expect(addMock.mock.calls.map((c) => c[2].jobId)).toEqual(['sync-connection-a', 'sync-connection-b']);
    expect(dbState.whereArg).toBeTruthy();
  });

  it('the daily fan-out covers gateway kinds (openai_compatible) as well as BYOK/catalog, active rows only', async () => {
    await processAiModelDiscoveryJob({ data: { type: 'sync-all-connections' } });
    const { sql: text, params } = new PgDialect().sqlToQuery(dbState.whereArg as SQL);
    expect(text).toContain('"kind" in');
    expect(params).toEqual(expect.arrayContaining(['anthropic_byok', 'catalog', ...GATEWAY_CONNECTION_KINDS, 'active']));
  });

  it('a sync-connection job payload carries only the connection id (never key material)', async () => {
    await enqueueConnectionSync('c9');
    expect(addMock.mock.calls.at(-1)![1]).toEqual({ type: 'sync-connection', connectionId: 'c9' });
  });

  it('a manual refresh enqueues sync-platform under the manual job id and reuses a waiting one', async () => {
    expect(await enqueuePlatformModelSync('manual')).toEqual({ id: __testOnly.MANUAL_JOB_ID });
    expect(addMock).toHaveBeenLastCalledWith('sync-platform', { type: 'sync-platform', trigger: 'manual' }, expect.objectContaining({ jobId: __testOnly.MANUAL_JOB_ID }));
    getJobMock.mockResolvedValue({ id: __testOnly.MANUAL_JOB_ID, getState: async () => 'waiting' });
    addMock.mockClear();
    expect(await enqueuePlatformModelSync('manual')).toEqual({ id: __testOnly.MANUAL_JOB_ID });
    expect(addMock).not.toHaveBeenCalled();
  });

  it('init starts the worker, schedules the daily job, and enqueues a delayed boot sync', async () => {
    await initializeAiModelDiscoveryWorker();
    expect(capturedProcessor.current).toBeTypeOf('function');
    expect(addMock).toHaveBeenCalledWith('sync-platform', { type: 'sync-platform', trigger: 'boot' }, expect.objectContaining({ jobId: __testOnly.BOOT_JOB_ID, delay: 60_000 }));
    await shutdownAiModelDiscoveryWorker();
  });

  it('a failed sync throws so BullMQ retries; ok and skipped reports are returned', async () => {
    syncMock.mockResolvedValueOnce({ status: 'failed', error: 'network down' });
    await expect(processAiModelDiscoveryJob({ data: { type: 'sync-platform', trigger: 'schedule' } })).rejects.toThrow(/network down/);
    syncMock.mockResolvedValueOnce({ status: 'skipped', reason: 'no_platform_key' });
    await expect(processAiModelDiscoveryJob({ data: { type: 'sync-platform', trigger: 'manual' } }))
      .resolves.toEqual({ status: 'skipped', reason: 'no_platform_key' });
  });

  // #9534: each boot-sync failure was logged twice — once by
  // attachWorkerObservability ([aiModelDiscoveryWorker]) and again by the
  // worker's own handlers ([aiModelDiscovery]) — each with a full stack that
  // points at this file, not the provider. One line with the provider error.
  describe('failure logging (#9534)', () => {
    async function classifier() {
      await initializeAiModelDiscoveryWorker();
      const call = vi.mocked(attachWorkerObservability).mock.calls.at(-1);
      await shutdownAiModelDiscoveryWorker();
      expect(call?.[1]).toBe('aiModelDiscoveryWorker');
      const classify = (call?.[2] as WorkerObservabilityOptions | undefined)?.classifyFailure;
      expect(classify).toBeTypeOf('function');
      return classify!;
    }

    it('registers no failed/error handler of its own (attachWorkerObservability already logs and reports)', async () => {
      await initializeAiModelDiscoveryWorker();
      const events = capturedWorker.current!.on.mock.calls.map((c) => c[0]);
      await shutdownAiModelDiscoveryWorker();
      expect(events).not.toContain('failed');
      expect(events).not.toContain('error');
    });

    it('a failed platform sync throws a one-line error carrying the provider error, not a stack', async () => {
      syncMock.mockResolvedValueOnce({ status: 'failed', error: 'HTTP 401: invalid x-api-key' });
      const err = await processAiModelDiscoveryJob({ data: { type: 'sync-platform', trigger: 'boot' } }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PlatformModelSyncFailed);
      expect((err as Error).message).toContain('HTTP 401: invalid x-api-key');
      expect((err as Error).stack).not.toContain('\n');
      expect((err as Error).stack).toContain('HTTP 401: invalid x-api-key');
    });

    it('classifies a platform sync failure to report once, when its retries are exhausted', async () => {
      const classify = await classifier();
      expect(classify(undefined as unknown as Job, new PlatformModelSyncFailed('HTTP 401'))).toEqual(
        expect.objectContaining({ level: 'error', reportOnlyWhenExhausted: true }),
      );
    });


  });

  it('hands an existing verification to the dedicated queue with attempts already spent', async () => {
    const data = { type: 'verify-offering' as const, offeringId: 'o1', partnerId: 'p1', retryFailed: true as const };
    const result = { offeringId: 'o1', state: 'delegated', queue: 'ai-model-verification' };
    delegateMock.mockResolvedValueOnce(result);
    await expect(processAiModelDiscoveryJob({ data, attemptsMade: 1 })).resolves.toEqual(result);
    expect(delegateMock).toHaveBeenCalledWith(data, 1);
    expect(syncMock).not.toHaveBeenCalled();
    expect(syncConnectionMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown job type', async () => {
    await expect(processAiModelDiscoveryJob({ data: { type: 'sync-everything' } as never })).rejects.toThrow(/Unknown/);
  });


});
