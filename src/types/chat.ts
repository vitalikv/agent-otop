import type { AnswerSource, ChatAnswer, DialogState } from '../../shared/chat.js';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  sources?: AnswerSource[];
  choices?: string[];
  clarification?: boolean;
  mode?: 'demo' | 'local';
}

export interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
  messages: Message[];
  state?: DialogState;
}

export interface ChatProvider {
  readonly mode?: 'demo' | 'local';
  checkConnection?(): Promise<boolean>;
  stream(messages: readonly Message[], signal: AbortSignal, state?: DialogState): AsyncIterable<string | ChatAnswer>;
}
