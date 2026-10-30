import type { Conversation, Message } from '../types/chat';

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
        for (const message of chat.messages) {
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
