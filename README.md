# linkedin-lead-ai-agents

A TypeScript template for building multi-agent workflows with [Google ADK](https://github.com/google/adk-javascript)
running on **Claude** instead of Gemini.

The example workflow is a lead scout: you give it a plain-English request, and it turns that
into a structured brief, searches a company database, verifies each candidate by actually
fetching their website, and returns a reviewed table of leads with an opening line for each.

```
$ pnpm start "Find Agentic AI development CTO"
Your prompt: Find Agentic AI development CTO
[refine_brief] done
[searcher] done
[verifier] done
[finalizer] done
[enforce_brief] done

## Qualified Leads

| Company | Website | Why They Fit | Opening Line |
|---|---|---|---|
| Nuvraxis | https://nuvraxis.com | Builds AI agents on Claude and the modern AI stack. | "I noticed you build AI agents on Claude — are you handling agent observability in-house or with a third-party tool?" |
```

## Requirements

- **Node.js 24+** — the source runs directly via Node's native TypeScript stripping
- **pnpm 12.5.1** — pinned via `packageManager`; Corepack will fetch it for you
- An **Anthropic API key**
- A **company search API** that accepts `POST {COMPANY_API_URL}/companies/search` (see
  [Swapping the lead source](#swapping-the-lead-source) if you don't have one)

## Setup

```bash
pnpm install
cp .env.example .env   # then fill it in
```

`.env` needs all four of these:

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | Passed to the Anthropic SDK in `src/claude.mts` |
| `CLAUDE_DEPLOYMENT` | no | Model id for every agent. Defaults to `claude-sonnet-4-6` |
| `COMPANY_API_KEY` | yes | Bearer token for the company search API |
| `COMPANY_API_URL` | yes | Base URL of that API, with no trailing slash |

> `.env.example` currently only lists the first two. The run will fail without the
> `COMPANY_API_*` pair.

## Running

```bash
pnpm build                                  # compile src/*.mts -> dist/*.mjs
pnpm start "Find Agentic AI development CTO"
```

To run straight from source without compiling, pass the env file yourself — `pnpm dev` does
not load `.env`:

```bash
node --env-file=.env ./src/main.mts "Find Agentic AI development CTO"
```

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm build` | Wipes `dist/` and compiles with `tsc` |
| `pnpm start` | Runs `dist/main.mjs` with `--env-file=.env` |
| `pnpm dev` | Runs `src/main.mts` directly (no env file) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm check` | Biome format + lint + import sort, writing fixes |
| `pnpm check:ci` | Same checks, read-only, for CI |

## How the workflow fits together

`buildLeadWorkflow()` wires six nodes into a single linear ADK `Workflow`. Each node's
output is schema-validated before it becomes the next node's input.

| # | Node | Kind | Output schema |
| --- | --- | --- | --- |
| 1 | `refine_brief` | LLM | `Brief` |
| 2 | `searcher` | LLM + `search_companies` | `Candidates` |
| 3 | `verifier` | LLM + `check_website` | `Verified` |
| 4 | `finalizer` | LLM | `FinalLeads` |
| 5 | `enforce_brief` | **plain code** | `FinalLeads` |
| 6 | `reviewer` | LLM | free-form markdown |

`enforce_brief` is deliberately not an agent. Deduplicating domains and dropping
out-of-country leads are rules that must not be "interpreted", so they live in ordinary
TypeScript where they cost no tokens and cannot be argued with.

### Files

| File | Role |
| --- | --- |
| `src/main.mts` | CLI entry point: builds the runner, streams events, prints the reviewer's output |
| `src/agent_worflow.mts` | The agents, their instructions, and the workflow graph |
| `src/agents_schema.mts` | Zod schemas passed to each agent as `outputSchema` |
| `src/lead_tools.mts` | `search_companies` and `check_website` tools, plus the `LeadSource` interface |
| `src/company_api_lead_source.mts` | `LeadSource` backed by an HTTP company API |
| `src/claude.mts` | The Claude adapter — see below |

## The Claude adapter

`src/claude.mts` implements ADK's `BaseLlm` against the Anthropic API. It is the piece worth
understanding if you are adapting this template, because ADK is built around Gemini's
conventions and three of them do not carry over.

**Structured output.** ADK turns an agent's `outputSchema` into `config.responseSchema` and
expects the model to reply with JSON. Anthropic has no equivalent parameter. The adapter
instead registers a synthetic `json_output` tool whose input schema *is* the response schema,
then converts that tool call back into a text part containing the JSON. When an agent has no
other tools, `tool_choice` forces the call; when it does (`searcher`, `verifier`), the model
stays free to call them and a system instruction steers it to finish through `json_output`.

**Preamble suppression.** Claude often writes a sentence before a tool call ("I'll run two
searches..."). ADK concatenates every text part before parsing, so any such preamble would
corrupt the JSON. When a `json_output` block is present, the adapter drops the other parts.

**Schema translation.** genai's `Schema` is OpenAPI-flavoured — upper-case type names,
integer keywords encoded as strings (`"minItems": "3"`), plus `nullable` and
`propertyOrdering`. Anthropic validates `input_schema` as JSON Schema draft 2020-12 and
rejects all of it, so `toJsonSchema()` translates rather than passes through.

## Swapping the lead source

`CompanyApiLeadSource` is one implementation of a three-line interface:

```ts
export interface LeadSource {
  search(q: LeadQuery): Promise<Lead[]>;
}
```

To use a different vendor, a local fixture file, or a scraper, implement that interface and
pass it to `buildLeadWorkflow()` in `src/main.mts`. Nothing else changes — the tool
definition, the agents and the schemas stay as they are. A fixture-backed source is also the
easiest way to develop the prompts without burning API calls.

## Writing instructions: two placeholder syntaxes

ADK supports two ways to reference an upstream node's output inside an `instruction`, and
they behave differently when a field is absent:

- `{Brief.country}` reads the **current node's input**. It has an optional form —
  `{Brief.country?}` resolves to an empty string when the field is missing.
- `<Brief.country from refine_brief>` reads **any earlier node's output**. It has **no**
  optional form: when the field is missing, ADK leaves the literal `<...>` text in the
  prompt, and the model will read it as a placeholder and complain.

Since `Brief.country` and `Brief.companySize` are optional, the `reviewer` instruction
carries an explicit line telling the model that a field still showing as `<...>` was never
specified and should be ignored. Reword it if you like, but do not delete it.

## Conventions

- **`.mts` everywhere**, with relative imports written as `./x.mts`. `tsc` rewrites those to
  `./x.mjs` on emit via `rewriteRelativeImportExtensions`, so the same source both runs
  directly under Node and compiles.
- **`erasableSyntaxOnly`** is on, which keeps the source runnable by Node's type stripping.
  No enums, no parameter properties, no namespaces.
- **`exactOptionalPropertyTypes`** is on. An optional property accepts a *missing key*, not
  an explicit `undefined`, so build objects with `...(x !== undefined && { x })` rather than
  assigning `undefined`.
- **Biome** handles formatting, linting and import sorting. `pnpm check` fixes what it can.
