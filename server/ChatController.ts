import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isDialogState, isRecord } from '../shared/validation.js';
import type { ChatRequest } from '../shared/chat.js';
import { AssistantService } from './AssistantService.js';
import { KnowledgeBase } from './KnowledgeBase.js';

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const maxBodyBytes = 64 * 1024;

export function validateRequest(value: unknown): ChatRequest {
  if (!isRecord(value) || Object.keys(value).some(key => !['messages', 'state'].includes(key)) || !Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 40) throw new HttpError(400, 'Нужна история от 1 до 40 сообщений.');
  let length = 0;
  for (const message of value.messages) {
    if (!isRecord(message) || Object.keys(message).some(key => !['role', 'content'].includes(key)) || !['user', 'assistant'].includes(String(message.role)) || typeof message.content !== 'string' || !message.content.trim() || message.content.length > 4000) throw new HttpError(400, 'Неверный формат сообщения или длина больше 4000 символов.');
    length += message.content.length;
  }
  if (length > 48000 || value.messages.at(-1).role !== 'user') throw new HttpError(400, 'История слишком длинная или последнее сообщение не от пользователя.');
  if (value.state !== undefined && !isDialogState(value.state)) throw new HttpError(400, 'Неверный формат параметров диалога.');
  return value as unknown as ChatRequest;
}

export class ChatController {
  private readonly assistant: AssistantService;
  constructor(private readonly knowledge: KnowledgeBase) { this.assistant = new AssistantService(knowledge); }
  createServer() {
    const server = createServer((request, response) => { void this.handle(request, response); });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    return server;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const json = (status: number, value: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const host = request.headers.host ?? '';
      if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host)) throw new HttpError(403, 'Разрешены только локальные запросы.');
      if (request.headers.origin && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(request.headers.origin)) throw new HttpError(403, 'Недопустимый источник запроса.');
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (path === '/api/health' && request.method === 'GET') { json(200, { status: 'ok', data: 'loaded', scenario: 'hydraulics.flow', engine: 'rules', stateful: false }); return; }
      if (path.startsWith('/api/sources/') && request.method === 'GET') {
        const text = this.knowledge.sourceText(decodeURIComponent(path.slice('/api/sources/'.length)));
        if (!text) throw new HttpError(404, 'Источник не найден.');
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end(text); return;
      }
      if (path !== '/api/chat') throw new HttpError(404, 'Маршрут не найден.');
      if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); throw new HttpError(405, 'Используйте POST.'); }
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new HttpError(415, 'Нужен Content-Type: application/json.');
      if (Number(request.headers['content-length']) > maxBodyBytes) throw new HttpError(413, 'Тело запроса больше 64 КиБ.');
      const body = await new Promise<string>((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBodyBytes) { reject(new HttpError(413, 'Тело запроса больше 64 КиБ.')); return; }
          chunks.push(chunk);
        });
        request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        request.on('error', reject);
        request.on('aborted', () => reject(new HttpError(400, 'Запрос прерван.')));
      });
      let value: unknown;
      try { value = JSON.parse(body); } catch { throw new HttpError(400, 'Некорректный JSON.'); }
      json(200, this.assistant.answer(validateRequest(value)));
    } catch (error) {
      if (!response.destroyed) json(error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'Не удалось обработать запрос. Проверьте параметры и повторите отправку.' });
    }
  }
}
