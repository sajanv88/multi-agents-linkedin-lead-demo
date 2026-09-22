import { FunctionTool } from '@google/adk';
import { z } from 'zod';

export interface LeadQuery {
  industry: string;
  country?: string | undefined;
  keywords: string[];
  limit: number;
}
export interface Lead {
  company: string;
  website?: string;
  industry: string;
  country?: string;
  headcount?: string;
  whyRelevant: string;
}
export interface LeadSource {
  search(q: LeadQuery): Promise<Lead[]>;
}

export const searchCompaniesTool = (source: LeadSource) =>
  new FunctionTool({
    name: 'search_companies',
    description:
      'Search a company database by industry, country and keywords. Returns raw, unverified candidates.',
    parameters: z.object({
      industry: z.string(),
      country: z.string().optional(),
      keywords: z.array(z.string()).default([]),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    execute: async (q) => ({ candidates: await source.search(q) }),
  });

export const checkWebsiteTool = new FunctionTool({
  name: 'check_website',
  description:
    'Fetch a company website. Returns HTTP status, page title and the first 500 characters of visible text.',
  parameters: z.object({ url: z.string().url() }),
  execute: async ({ url }) => {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
      const html = await res.text();
      const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
      const text = html
        .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 500);
      return { reachable: res.ok, status: res.status, title, text };
    } catch (e) {
      return { reachable: false, status: 0, title: '', text: '', error: String(e) };
    }
  },
});
