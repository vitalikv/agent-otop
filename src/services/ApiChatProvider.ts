import type { ChatAnswer, DialogState } from '../../shared/chat.js';
import type { ChatProvider, Message } from '../types/chat.js';
import { isDialogState, isRecord } from '../../shared/validation.js';

export class ApiChatProvider implements ChatProvider {
  readonly mode = 'local' as const;
  // A language-model answer takes seconds; the rules answer at once, so the long limit only matters for the model.
  constructor(private readonly baseUrl = '/api', private readonly timeoutMs = 120000) {}

  async checkConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(Math.min(this.timeoutMs, 10000)) });
      const data: unknown = await response.json();
      return response.ok && isRecord(data) && data.status === 'ok' && data.data === 'loaded';
    } catch { return false; }
  }

  async *stream(messages: readonly Message[], signal: AbortSignal, state?: DialogState): AsyncIterable<ChatAnswer> {
    signal.throwIfAborted();
    let response: Response;
    let answer: unknown;
    try {
      response = await fetch(`${this.baseUrl}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: messages.slice(-20).filter(message => message.content.trim()).map(({ role, content }) => ({ role, content })), state }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
      });
      answer = await response.json();
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof SyntaxError) throw new Error('Сервис вернул некорректный JSON. Повторите отправку.');
      throw new Error(error instanceof DOMException && error.name === 'TimeoutError' ? 'Истекло время ожидания сервиса. Повторите отправку.' : 'Локальный сервис недоступен. Проверьте, что запущен npm run dev.');
    }
    signal.throwIfAborted();
    if (!response.ok) throw new Error(isRecord(answer) && typeof answer.error === 'string' ? answer.error : `Ошибка сервиса: HTTP ${response.status}.`);
    if (!isRecord(answer) || typeof answer.content !== 'string' || !Array.isArray(answer.sources) || !Array.isArray(answer.choices)
      || typeof answer.clarification !== 'boolean' || (answer.state !== undefined && !isDialogState(answer.state))
      || !answer.choices.every(choice => typeof choice === 'string')
      || !answer.sources.every(source => isRecord(source) && typeof source.id === 'string' && typeof source.title === 'string' && typeof source.href === 'string' && /^\/api\/sources\/[a-zA-Z0-9.%-]+$/.test(source.href))) throw new Error('Сервис вернул неверный формат ответа.');
    yield answer as unknown as ChatAnswer;
  }
}
