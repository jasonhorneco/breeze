import { describe, expect, it } from 'vitest';
import { humanReviewRequestSchema, type HumanReviewRequest } from '@breeze/shared';
import { captureHumanReviewRequest, readHumanReviewRequests } from './humanReview';
import { buildOutcomeSdkTools, outcomeToolsForRun } from './outcomeTools';

describe('human review handoff', () => {
  it('exposes a validated outcome only to linked full alert runs, preserving task-step tools', () => {
    expect(outcomeToolsForRun({ profile: 'full', triggerKind: 'alert', alertId: 'alert-1' })).toEqual(['request_human_review']);
    expect(outcomeToolsForRun({ profile: 'full', triggerKind: 'alert', alertId: 'alert-1', taskId: 'task-1' }))
      .toEqual(['request_human_review', 'submit_task_step']);
    expect(outcomeToolsForRun({ profile: 'full', triggerKind: 'schedule', alertId: 'alert-1' })).toEqual([]);
    expect(outcomeToolsForRun({ profile: 'full', triggerKind: 'alert', alertId: null })).toEqual([]);
    expect(outcomeToolsForRun({ profile: 'verdict' })).toEqual(['submit_alert_verdict']);
    expect(buildOutcomeSdkTools(['request_human_review'])[0]?.name).toBe('request_human_review');
  });
  it('captures one inert request and preserves the first successful submission', () => {
    const outcome: { humanReviewRequests?: HumanReviewRequest[] } = {};
    captureHumanReviewRequest(outcome, { reason: 'Evidence is incomplete.', nextSteps: ['Inspect stored sensor history.'] });
    captureHumanReviewRequest(outcome, { reason: 'A second concurrent call.', nextSteps: [] });
    expect(outcome.humanReviewRequests).toEqual([{ reason: 'Evidence is incomplete.', nextSteps: ['Inspect stored sensor history.'] }]);
  });
  it('rejects executable/authority fields rather than silently stripping them', () => {
    for (const extra of [{ command: 'restart' }, { approved: true }, { deviceId: 'other-tenant' }, { tool: 'run_script' }]) {
      expect(humanReviewRequestSchema.safeParse({ reason: 'Review', nextSteps: [], ...extra }).success).toBe(false);
    }
  });
  it('bounds text and the number of suggested checks', () => {
    for (const input of [{ reason: '' }, { reason: 'x'.repeat(1001) }, { reason: 'Review', nextSteps: ['x'.repeat(301)] },
      { reason: 'Review', nextSteps: Array(6).fill('Check') }]) {
      expect(humanReviewRequestSchema.safeParse(input).success).toBe(false);
    }
  });
  it('projects only a validated single request and returns no corrupt/legacy content', () => {
    expect(readHumanReviewRequests({})).toEqual([]);
    expect(readHumanReviewRequests({ humanReviewRequests: [{ reason: 'Read', token: 'secret' }] })).toEqual([]);
    expect(readHumanReviewRequests({ humanReviewRequests: [{ reason: 'A' }, { reason: 'B' }] })).toEqual([]);
    expect(readHumanReviewRequests({ humanReviewRequests: [{ reason: ' Read ', nextSteps: [] }], privatePayload: 'secret' }))
      .toEqual([{ reason: 'Read', nextSteps: [] }]);
  });
});
