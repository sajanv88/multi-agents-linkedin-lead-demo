import { LlmAgent, type NodeContext, node, Workflow } from '@google/adk';
import { Brief, Candidates, FinalLeads, type FinalLeadsT, Verified } from './agents_schema.mts';
import { Claude } from './claude.mts';
import { checkWebsiteTool, type LeadSource, searchCompaniesTool } from './lead_tools.mts';

const claude = () => new Claude({ model: process.env.CLAUDE_DEPLOYMENT ?? 'claude-sonnet-4-6' });

export function buildLeadWorkflow(source: LeadSource) {
  const refineBrief = new LlmAgent({
    name: 'refine_brief',
    model: claude(),
    instruction: `Turn the user's request into a lead brief.
If the user did not state a country or company size, leave that field out. Do not write
placeholders like "unknown". If the request names a role (CTO, founder), put it in targetRole.
Never ask questions.`,
    outputSchema: Brief,
    outputKey: 'brief', // also to state, so the code node below can read it
  });

  const searcher = new LlmAgent({
    name: 'searcher',
    model: claude(),
    instruction: `Find companies in {Brief.industry}. Restrict to country {Brief.country?}
only if that is not blank. Call search_companies once or twice with different subsets of
{Brief.keywords}. Return every distinct candidate you saw.`,
    tools: [searchCompaniesTool(source)],
    outputSchema: Candidates,
  });

  const verifier = new LlmAgent({
    name: 'verifier',
    model: claude(),
    instruction: `For every candidate with a website, call check_website. Mark it "verified"
only if the site is reachable AND the page text supports the industry
<Brief.industry from refine_brief>. Otherwise "rejected". In "evidence", quote the words
from the page you relied on.`,
    tools: [checkWebsiteTool],
    outputSchema: Verified,
  });

  const finalizer = new LlmAgent({
    name: 'finalizer',
    model: claude(),
    instruction: `Keep only status "verified". Rank by fit. For each, write a one-sentence
reason and an openingLine: one sentence, no compliments, no adjectives about the company.
State one concrete thing you saw on their site and ask one specific question about it.
List every rejected company with its reason.`,
    outputSchema: FinalLeads,
  });

  // Plain code. No model, no tokens. The rules that must never be "interpreted".
  const enforceBrief = node(
    (ctx: NodeContext, result: FinalLeadsT): FinalLeadsT => {
      // `outputKey` stores the value the agent's outputSchema already parsed,
      // so this is an object, not JSON text.
      const brief = Brief.parse(ctx.state.get('brief'));
      const seen = new Set<string>();
      const rejected = [...result.rejected];
      const leads = result.leads.filter((l) => {
        const host = hostOf(l.website);
        if (!host || seen.has(host)) {
          rejected.push({
            company: l.company,
            reason: host ? 'duplicate domain' : 'bad website URL',
          });
          return false;
        }
        seen.add(host);
        if (brief.country && l.country.toLowerCase() !== brief.country.toLowerCase()) {
          rejected.push({ company: l.company, reason: `outside ${brief.country}` });
          return false;
        }
        return true;
      });
      return { leads, rejected };
    },
    { name: 'enforce_brief', inputSchema: FinalLeads, outputSchema: FinalLeads },
  );

  const reviewer = new LlmAgent({
    name: 'reviewer',
    model: claude(),
    instruction: `You are the last check before the user sees this. The brief was:
industry <Brief.industry from refine_brief>, country <Brief.country from refine_brief>,
size <Brief.companySize from refine_brief>. A field still showing as a literal <...>
placeholder was never specified: ignore that criterion rather than filtering on it, and do
not mention it. Re-read every lead against the criteria that remain. Drop anything
that does not match and say why. Present the rest as a table: company, website, why they
fit, opening line. Then list what was dropped and why. Never add a company that is not in
your input.`,
  });

  return new Workflow({
    name: 'lead_scout',
    edges: [
      [
        'START',
        refineBrief,
        node(searcher, { inputSchema: Brief }),
        node(verifier, { inputSchema: Candidates }),
        node(finalizer, { inputSchema: Verified }),
        enforceBrief,
        node(reviewer, { inputSchema: FinalLeads }),
      ],
    ],
  });
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}
