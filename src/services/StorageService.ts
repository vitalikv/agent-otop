import type { Conversation, Message } from '../types/chat.js';
import { isDialogState, isRecord } from '../../shared/validation.js';

export class StorageService {
  private readonly key = 'teplo.chats.v1';

  load(): Conversation[] {
    try {
      const data: unknown = JSON.parse(localStorage.getItem(this.key) ?? '[]');
      if (!Array.isArray(data)) return [];
      const chats = data.filter((item): item is Conversation => {
        if (!item || typeof item.id !== 'string' || typeof item.title !== 'string' || typeof item.updatedAt !== 'string' || !Array.isArray(item.messages)) return false;
        return item.messages.every((m: Partial<Message> | null) => m && typeof m.id === 'string' && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && typeof m.createdAt === 'string');
      });
      for (const chat of chats) {
        if (chat.state !== undefined && !isDialogState(chat.state)) delete chat.state;
        for (const message of chat.messages) {
          if (!Array.isArray(message.sources) || !message.sources.every(source => isRecord(source) && typeof source.id === 'string' && typeof source.title === 'string' && typeof source.href === 'string' && /^\/api\/sources\/[a-zA-Z0-9.%-]+$/.test(source.href))) delete message.sources;
          if (!Array.isArray(message.choices) || !message.choices.every(choice => typeof choice === 'string')) delete message.choices;
          if (message.mode !== 'local' && message.mode !== 'demo') delete message.mode;
          if (typeof message.clarification !== 'boolean') delete message.clarification;
          if (message.role === 'assistant' && !message.content.trim()) {
            message.content = '[Ответ был прерван при закрытии страницы]';
          }
        }
      }
      return chats;
    } catch {
      return [];
    }
  }

  save(chats: Conversation[]): boolean {
    try {
      localStorage.setItem(this.key, JSON.stringify(chats));
      return true;
    } catch {
      return false;
    }
  }
}
