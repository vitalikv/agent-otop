export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
  messages: Message[];
}

export interface ChatProvider {
  stream(messages: readonly Message[], signal: AbortSignal): AsyncIterable<string>;
}
