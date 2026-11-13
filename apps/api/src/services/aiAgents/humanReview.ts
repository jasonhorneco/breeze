import { humanReviewRequestSchema, type HumanReviewRequest } from '@breeze/shared';

/** Safe projection for old/corrupt rows as well as newly captured outcomes. */
export function readHumanReviewRequests(outcome: Record<string, unknown>): HumanReviewRequest[] {
  const requests = outcome.humanReviewRequests;
  if (!Array.isArray(requests) || requests.length !== 1) return [];
  const parsed = humanReviewRequestSchema.safeParse(requests[0]);
  return parsed.success ? [parsed.data] : [];
}

/** First successful submission wins even when concurrent calls both passed the pre-hook. */
export function captureHumanReviewRequest(
  outcome: { humanReviewRequests?: HumanReviewRequest[] },
  input: unknown,
): void {
  const request = humanReviewRequestSchema.parse(input);
  if (!outcome.humanReviewRequests?.length) outcome.humanReviewRequests = [request];
}
