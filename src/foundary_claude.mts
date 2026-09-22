import AnthropicFoundry from '@anthropic-ai/foundry-sdk';
import { BaseLlm, type LlmRequest, type LlmResponse } from '@google/adk';
import type { Content, FunctionDeclaration, Part } from '@google/genai';

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export class FoundryClaude extends BaseLlm {
  static override readonly supportedModels = [/^claude-.*/];

  private readonly client = new AnthropicFoundry({
    apiKey: process.env.ANTHROPIC_FOUNDRY_API_KEY,
    resource: process.env.ANTHROPIC_FOUNDRY_RESOURCE,
  });

  async *generateContentAsync(
    req: LlmRequest,
    _stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    this.maybeAppendUserContent(req);


    const system = systemText(req.config?.systemInstruction);

    const res = await this.client.messages.create(
      {
        model: this.model, // the Foundry deployment name
        max_tokens: 4096,
        ...(system !== undefined && { system }),
        tools: functionDeclarations(req).map(toTool),
        messages: (req.contents ?? []).map(toMessage),
      },
      { signal: abortSignal },
    );

    yield {
      content: {
        role: 'model',
        parts: res.content.map(fromBlock).filter((p): p is Part => !!p),
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

function functionDeclarations(req: LlmRequest): FunctionDeclaration[] {
  return (req.config?.tools ?? []).flatMap((t) =>
    'functionDeclarations' in t ? (t.functionDeclarations ?? []) : [],
  );
}

function toTool(fd: FunctionDeclaration) {
  if (typeof fd.name === "undefined") throw new Error("Unknown Function declaration name.", {cause: "toTool FunctionDeclaration fd.name is undefined."})
  return {
    name: fd.name,
    description: fd.description ?? '',
    input_schema: (fd.parametersJsonSchema ??
      fd.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>,
  };
}

function toMessage(c: Content): { role: 'user' | 'assistant'; content: Block[] } {
  const content = (c.parts ?? []).flatMap((p): Block[] => {
    if (p.text) return [{ type: 'text', text: p.text }];
    if (p.functionCall)
      return [
        {
          type: 'tool_use',
          id: p.functionCall.id ?? crypto.randomUUID(),
          name: p.functionCall.name ?? "anonymous_func_call",
          input: p.functionCall.args ?? {},
        },
      ];
    if (p.functionResponse)
      return [
        {
          type: 'tool_result',
          tool_use_id: p.functionResponse.id ??crypto.randomUUID(),
          content: JSON.stringify(p.functionResponse.response ?? {}),
        },
      ];
    return [];
  });
  return { role: c.role === 'model' ? 'assistant' : 'user', content };
}

function fromBlock(b: {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}): Part | undefined {
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
