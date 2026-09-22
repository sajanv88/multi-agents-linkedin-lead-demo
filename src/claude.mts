import Anthropic from '@anthropic-ai/sdk';

import { BaseLlm, type LlmRequest, type LlmResponse } from '@google/adk';
import type { Content, FunctionDeclaration, Part, Schema } from '@google/genai';

type MessageCreateParams = Parameters<Anthropic['messages']['create']>[0];
type AnthropicTool = Extract<
  NonNullable<MessageCreateParams['tools']>[number],
  { input_schema: unknown }
>;
type InputSchema = AnthropicTool['input_schema'];

type NamedFunctionDeclaration = FunctionDeclaration & { name: string };

const JSON_OUTPUT_TOOL = 'json_output';

const JSON_OUTPUT_INSTRUCTION = `When you have finished, you MUST deliver your answer by calling the \`${JSON_OUTPUT_TOOL}\` tool. Never write the answer as prose.`;

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export class Claude extends BaseLlm {
  static override readonly supportedModels = [/^claude-.*/];

  private readonly client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  async *generateContentAsync(
    req: LlmRequest,
    _stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    this.maybeAppendUserContent(req);

    const tools = functionDeclarations(req).map(toTool);
    const outputSchema = responseSchema(req);

    if (outputSchema !== undefined) {
      tools.push({
        name: JSON_OUTPUT_TOOL,
        description: 'Deliver the final answer. Its shape must match the schema exactly.',
        input_schema: outputSchema,
      });
    }

    const system = [
      systemText(req.config?.systemInstruction),
      outputSchema && JSON_OUTPUT_INSTRUCTION,
    ]
      .filter((s): s is string => !!s)
      .join('\n\n');

    const forceJsonOutput = outputSchema !== undefined && tools.length === 1;

    const res = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: req.config?.maxOutputTokens ?? 4096,
        ...(system !== '' && { system }),
        ...(tools.length > 0 && { tools }),
        ...(forceJsonOutput && { tool_choice: { type: 'tool' as const, name: JSON_OUTPUT_TOOL } }),
        messages: toMessages(req.contents ?? []),
      },
      { signal: abortSignal },
    );

    yield {
      content: {
        role: 'model',
        parts: toParts(res.content),
      },
      usageMetadata: {
        promptTokenCount: res.usage.input_tokens,
        candidatesTokenCount: res.usage.output_tokens,
      },
    };
  }

  async connect(): Promise<never> {
    throw new Error('Live (bidi) sessions are not supported by this adapter');
  }
}

function systemText(si: unknown): string | undefined {
  if (!si) return undefined;
  if (typeof si === 'string') return si;
  return (si as Content).parts?.map((p) => p.text ?? '').join('\n');
}

function responseSchema(req: LlmRequest): InputSchema | undefined {
  const { responseJsonSchema, responseSchema: genaiSchema } = req.config ?? {};
  if (isRecord(responseJsonSchema)) return { ...responseJsonSchema, type: 'object' };

  if (isRecord(genaiSchema)) return { ...toJsonSchema(genaiSchema as Schema), type: 'object' };
  return undefined;
}

function functionDeclarations(req: LlmRequest): NamedFunctionDeclaration[] {
  return (req.config?.tools ?? [])
    .flatMap((t) => ('functionDeclarations' in t ? (t.functionDeclarations ?? []) : []))
    .filter((fd): fd is NamedFunctionDeclaration => fd.name !== undefined);
}

function toTool(fd: NamedFunctionDeclaration): AnthropicTool {
  return {
    name: fd.name,
    ...(fd.description !== undefined && { description: fd.description }),
    input_schema: toInputSchema(fd),
  };
}

function toInputSchema(fd: NamedFunctionDeclaration): InputSchema {
  const schema = isRecord(fd.parametersJsonSchema)
    ? fd.parametersJsonSchema
    : fd.parameters !== undefined
      ? toJsonSchema(fd.parameters)
      : { properties: {} };

  return { ...schema, type: 'object' };
}

const NUMERIC_KEYWORDS = [
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minProperties',
  'maxProperties',
] as const;

function toJsonSchema(schema: Schema): Record<string, unknown> {
  const {
    type,
    properties,
    items,
    anyOf,
    nullable,
    propertyOrdering: _propertyOrdering,
    example: _example,
    ...rest
  } = schema;

  const jsonType = type?.toLowerCase();

  return {
    ...rest,
    ...Object.fromEntries(
      NUMERIC_KEYWORDS.filter((key) => rest[key] !== undefined).map((key) => [
        key,
        Number(rest[key]),
      ]),
    ),
    ...(jsonType !== undefined && { type: nullable ? [jsonType, 'null'] : jsonType }),
    ...(properties !== undefined && {
      properties: Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [key, toJsonSchema(value)]),
      ),
    }),
    ...(items !== undefined && { items: toJsonSchema(items) }),
    ...(anyOf !== undefined && { anyOf: anyOf.map(toJsonSchema) }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toMessages(contents: Content[]) {
  return contents.map(toMessage).filter((m) => m.content.length > 0);
}

function toMessage(c: Content): { role: 'user' | 'assistant'; content: Block[] } {
  const content = (c.parts ?? []).flatMap((p): Block[] => {
    if (p.text) return [{ type: 'text', text: p.text }];
    if (p.functionCall)
      return [
        {
          type: 'tool_use',
          id: p.functionCall.id ?? crypto.randomUUID(),
          name: p.functionCall.name ?? 'anonymous_func_call',
          input: p.functionCall.args ?? {},
        },
      ];
    if (p.functionResponse)
      return [
        {
          type: 'tool_result',
          tool_use_id: p.functionResponse.id ?? crypto.randomUUID(),
          content: JSON.stringify(p.functionResponse.response ?? {}),
        },
      ];
    return [];
  });
  return { role: c.role === 'model' ? 'assistant' : 'user', content };
}

type ResponseBlock = { type: string; text?: string; id?: string; name?: string; input?: unknown };

function toParts(blocks: ResponseBlock[]): Part[] {
  const answer = blocks.find((b) => b.type === 'tool_use' && b.name === JSON_OUTPUT_TOOL);

  if (answer) return [{ text: JSON.stringify(answer.input ?? {}) }];

  return blocks.map(fromBlock).filter((p): p is Part => p !== undefined);
}

function fromBlock(b: ResponseBlock): Part | undefined {
  if (b.type === 'text') return { text: b.text ?? '' };
  if (b.type === 'tool_use')
    return {
      functionCall: {
        ...(b.id !== undefined && { id: b.id }),
        ...(b.name !== undefined && { name: b.name }),
        args: (b.input ?? {}) as Record<string, unknown>,
      },
    };
  return undefined;
}
