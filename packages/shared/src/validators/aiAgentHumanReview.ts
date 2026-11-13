import { z } from 'zod';

/** Inert review text, never an executable action or an approval decision. */
export const humanReviewRequestShape = {
  reason: z.string().trim().min(1).max(1000).describe('Why a technician needs to review the evidence.'),
  nextSteps: z.array(z.string().trim().min(1).max(300)).max(5).default([])
    .describe('Up to five suggested checks for the technician. These are text only, not commands to execute.'),
};
export const humanReviewRequestSchema = z.object(humanReviewRequestShape).strict();
export type HumanReviewRequest = z.infer<typeof humanReviewRequestSchema>;
