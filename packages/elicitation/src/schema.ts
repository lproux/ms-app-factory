import { z } from 'zod';

export const Question = z.object({
  id: z.string(),
  prompt: z.string(),
  kind: z.enum(['text', 'choice', 'multi-choice', 'path', 'url', 'boolean']),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  required: z.boolean().default(true),
  default: z.unknown().optional(),
  inferFrom: z.array(z.string()).optional(),
});
export type Question = z.infer<typeof Question>;

export const Recipe = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  target: z.enum(['copilot-studio', 'teams']),
  questions: z.array(Question),
  defaults: z.record(z.unknown()).optional(),
});
export type Recipe = z.infer<typeof Recipe>;
