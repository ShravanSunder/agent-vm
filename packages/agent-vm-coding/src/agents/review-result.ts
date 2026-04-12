import { z } from "zod";

export const reviewResultSchema = z.object({
  approved: z.boolean(),
  comments: z.array(
    z.object({
      file: z.string().default(""),
      line: z.number().optional(),
      severity: z.enum(["critical", "suggestion", "nitpick"]),
      comment: z.string(),
    }),
  ),
  summary: z.string(),
});

export type ReviewResult = z.infer<typeof reviewResultSchema>;
