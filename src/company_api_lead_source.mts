import type { Lead, LeadQuery, LeadSource } from './lead_tools.mts';

export class CompanyApiLeadSource implements LeadSource {
  private readonly apiKey;
  private readonly baseUrl;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.baseUrl = process.env.COMPANY_API_URL;
  }

  async search(q: LeadQuery): Promise<Lead[]> {
    const res = await fetch(`${this.baseUrl}/companies/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        industry: q.industry,
        country: q.country,
        keywords: q.keywords,
        size: q.limit,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`company API ${res.status}: ${await res.text()}`);

    const data = (await res.json()) as { results: VendorCompany[] };
    return data.results.map(toLead);
  }
}

interface VendorCompany {
  name: string;
  website?: string;
  industry?: string;
  country?: string;
  employee_count?: number;
  summary?: string;
}

function toLead(c: VendorCompany): Lead {
  return {
    company: c.name,
    ...(c.website !== undefined && { website: c.website }),
    industry: c.industry ?? 'unknown',
    ...(c.country !== undefined && { country: c.country }),
    ...(c.employee_count !== undefined && { headcount: String(c.employee_count) }),
    whyRelevant: c.summary ?? '',
  };
}
