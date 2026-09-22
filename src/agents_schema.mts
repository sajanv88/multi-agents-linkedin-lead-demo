import { z } from 'zod';

export const Brief = z.object({
  industry: z.string(),
  country: z
    .string()
    .optional()
    .describe('Only if the user stated one. Never invent a placeholder.'),
  companySize: z
    .string()
    .optional()
    .describe('Only if the user stated one, e.g. "50-200 employees".'),
  targetRole: z
    .string()
    .optional()
    .describe('Persona to reach, e.g. "CTO", if the user named one.'),
  buyingSignals: z.array(z.string()),
  keywords: z.array(z.string()).min(3).max(6),
});

export const Candidates = z.object({
  candidates: z.array(
    z.object({
      company: z.string(),
      website: z.string().optional(),
      country: z.string().optional(),
      whyRelevant: z.string(),
    }),
  ),
});

export const Verified = z.object({
  leads: z.array(
    z.object({
      company: z.string(),
      website: z.string(),
      country: z.string(),
      status: z.enum(['verified', 'rejected']),
      evidence: z.string().describe('Words quoted from the page that support the decision'),
    }),
  ),
});

export const FinalLeads = z.object({
  leads: z.array(
    z.object({
      company: z.string(),
      website: z.string(),
      country: z.string(),
      fit: z.enum(['strong', 'medium']),
      reason: z.string(),
      openingLine: z.string(),
    }),
  ),
  rejected: z.array(z.object({ company: z.string(), reason: z.string() })),
});

export type FinalLeadsT = z.infer<typeof FinalLeads>;
