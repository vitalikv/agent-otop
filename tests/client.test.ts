import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiChatProvider } from '../src/services/ApiChatProvider.js';
import { StorageService } from '../src/services/StorageService.js';
import type { Conversation, Message } from '../src/types/chat.js';

const message: Message = { id: 'user', role: 'user', content: 'Вода', createdAt: '' };
const consume = async (provider: ApiChatProvider, signal = new AbortController().signal) => {
  for await (const _chunk of provider.stream([message], signal)) assert.fail('Unexpected successful reply');
};

test('state and response metadata survive browser storage; damaged optional fields are discarded', t => {
  let stored = '';
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => stored,
    setItem: (_key: string, value: string) => { stored = value; },
  } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else Reflect.deleteProperty(globalThis, 'localStorage'); });
  const storage = new StorageService();
  const conversation: Conversation = {
    id: 'chat', title: 'Расход', updatedAt: '',
    messages: [{ ...message }, { id: 'reply', role: 'assistant', content: 'Какие температуры?', createdAt: '', mode: 'local', clarification: true, choices: ['60/40 °C'], sources: [{ id: 'g05.flow', title: 'Нагрузка и расход', href: '/api/sources/g05.flow' }] }],
    state: { version: 1, intent: 'hydraulics.flow', parameters: { load_kw: 5, coolant: 'water', method: 'water_approximation' }, pending: 'temperature' },
  };
  assert.equal(storage.save([conversation]), true);
  assert.deepEqual(storage.load(), [conversation]);
  const malformed = JSON.parse(stored);
  malformed[0].state.parameters.load_kw = '5';
  malformed[0].messages[1].sources[0].href = 'javascript:alert(1)';
  malformed[0].messages[1].choices = [null];
  stored = JSON.stringify(malformed);
  const restored = storage.load();
  assert.equal(restored[0].state, undefined);
  assert.equal(restored[0].messages[1].sources, undefined);
  assert.equal(restored[0].messages[1].choices, undefined);
  stored = JSON.stringify([{ id: 'old', title: 'Демо', updatedAt: '', messages: [{ ...message }, { id: 'empty', role: 'assistant', content: '', createdAt: '' }] }]);
  assert.equal(storage.load()[0].state, undefined);
  assert.match(storage.load()[0].messages[1].content, /прерван/);
  stored = 'broken';
  assert.deepEqual(storage.load(), []);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('Unavailable'); } });
  assert.equal(storage.save([conversation]), false);
  assert.deepEqual(storage.load(), []);
});

test('API provider reports unavailable service, HTTP errors, invalid JSON and invalid metadata', async t => {
  let fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('offline'); });
  const provider = new ApiChatProvider();
  assert.equal(await provider.checkConnection(), false);
  await assert.rejects(consume(provider), /недоступен/);
  fetchMock.mock.restore();
  fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: 'Запрос слишком большой' }), { status: 413 }));
  await assert.rejects(consume(provider), /Запрос слишком большой/);
  fetchMock.mock.restore();
  fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('<html>proxy error</html>'));
  await assert.rejects(consume(provider), /некорректный JSON/);
  fetchMock.mock.restore();
  fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ content: 'test', sources: [{ id: 'x', title: 'x', href: 'javascript:alert(1)' }], choices: [], clarification: false })));
  await assert.rejects(consume(provider), /неверный формат/);
});

test('timeout and in-flight cancellation never yield a ready answer', async t => {
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Expected earlier abort')), 1000);
    init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
  }));
  await assert.rejects(consume(new ApiChatProvider('/api', 5)), /время ожидания/);
  const controller = new AbortController();
  const pending = consume(new ApiChatProvider(), controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});
