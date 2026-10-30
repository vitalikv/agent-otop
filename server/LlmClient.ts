export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export type LlmMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };
export interface LlmTimings { prompt_n: number; prompt_ms: number; predicted_n: number; predicted_ms: number }
export interface LlmCompletion { message: { content: string | null; tool_calls?: ToolCall[] }; timings?: LlmTimings }
export interface CompletionOptions { schema?: object; maxTokens?: number }
export interface LlmBackend { complete(messages: LlmMessage[], tools: object[], options?: CompletionOptions): Promise<LlmCompletion> }

export class LlmUnavailableError extends Error {}

/** OpenAI-compatible chat completions of a local llama.cpp server (llama-server --jinja). */
export class LlmClient implements LlmBackend {
  constructor(private readonly url: string, private readonly timeoutMs: number) {}

  async complete(messages: LlmMessage[], tools: object[], options: CompletionOptions = {}): Promise<LlmCompletion> {
    // Low temperature: answers restate the base; Qwen3 thinking is off to keep latency predictable.
    const body: Record<string, unknown> = { messages, temperature: 0.3, top_p: 0.8, max_tokens: options.maxTokens ?? 900, chat_template_kwargs: { enable_thinking: false } };
    if (tools.length) Object.assign(body, { tools, tool_choice: 'auto' });
    // A JSON schema is enforced by llama.cpp as a grammar, so the reply always parses.
    if (options.schema) body.response_format = { type: 'json_schema', json_schema: { name: 'reply', schema: options.schema } };
    let response: Response;
    try {
      response = await fetch(`${this.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new LlmUnavailableError(error instanceof DOMException && error.name === 'TimeoutError' ? 'Языковая модель не ответила вовремя.' : 'Языковая модель недоступна.');
    }
    if (!response.ok) throw new LlmUnavailableError(`Языковая модель вернула ошибку ${response.status}.`);
    const data = await response.json() as { choices?: { message?: LlmCompletion['message'] }[]; timings?: LlmTimings };
    const message = data.choices?.[0]?.message;
    if (!message) throw new LlmUnavailableError('Языковая модель вернула пустой ответ.');
    return { message, timings: data.timings };
  }

  async healthy(): Promise<boolean> {
    try {
      return (await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(3000) })).ok;
    } catch {
      return false;
    }
  }
}
