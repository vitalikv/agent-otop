import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfig } from '../server/AppConfig.js';
import { KnowledgeBase } from '../server/KnowledgeBase.js';
import { ChatController } from '../server/ChatController.js';
import { ApiChatProvider } from '../src/services/ApiChatProvider.js';
import type { Message } from '../src/types/chat.js';
import type { ChatAnswer, DialogState } from '../shared/chat.js';

const root = new AppConfig().root;
const knowledge = await KnowledgeBase.load(root);

test('HTTP health, conversation, sources, limits and validation', async t => {
  const server = new ChatController(knowledge).createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${base}/api/health`).then(response => response.json());
  assert.equal(health.data, 'loaded');
  assert.equal(health.stateful, false);
  const provider = new ApiChatProvider(`${base}/api`);
  assert.equal(await provider.checkConnection(), true);
  const message = (content: string): Message => ({ id: 'test', role: 'user', content, createdAt: '' });
  const chunks = [];
  for await (const chunk of provider.stream([message('Ориентировочный расход воды: 8 кВт, 60/40')], new AbortController().signal)) chunks.push(chunk);
  const result = chunks[0];
  assert.equal(result.calculation?.values.volume_l_h, 344);
  const sourceResponse = await fetch(`${base}${result.sources[0].href}`);
  assert.match(sourceResponse.headers.get('content-type')!, /text\/plain/);
  assert.match(await sourceResponse.text(), /Для окончательного подбора/);
  const post = (body: unknown, headers = {}) => fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  assert.equal((await post('{')).status, 400);
  assert.equal((await post({ messages: [] })).status, 400);
  assert.equal((await post({ messages: [{ role: 'system', content: 'x' }] })).status, 400);
  assert.equal((await post({ messages: [{ role: 'assistant', content: 'x' }] })).status, 400);
  assert.equal((await post({ messages: [{ role: 'user', content: 'x'.repeat(4001) }] })).status, 400);
  assert.equal((await post({ messages: Array.from({ length: 41 }, () => ({ role: 'user', content: 'x' })) })).status, 400);
  assert.equal((await post({ messages: [{ role: 'user', content: 'x' }], state: { ...result.state, parameters: { load_kw: '8' } } })).status, 400);
  assert.equal((await post({ messages: [{ role: 'user', content: 'x' }], state: { ...result.state, parameters: { unknown: 2 } } })).status, 400);
  assert.equal((await post('x'.repeat(65537))).status, 413);
  assert.equal((await post('{}', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('{}', { Origin: 'https://example.org' })).status, 403);
  assert.equal((await fetch(`${base}/api/chat`)).status, 405);
  assert.equal((await fetch(`${base}/api/sources/unknown`)).status, 404);
  assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
  const state = JSON.parse(JSON.stringify(result.state)) as DialogState;
  const continuation = await post({ messages: [{ role: 'user', content: 'А если 50/40?' }], state }).then(response => response.json()) as ChatAnswer;
  assert.equal(continuation.calculation?.values.volume_l_h, 688);
  const independent = await post({ messages: [{ role: 'user', content: 'А если 50/40?' }] }).then(response => response.json()) as ChatAnswer;
  assert.equal(independent.calculation, undefined);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(async () => { for await (const _chunk of provider.stream([message('Вода')], aborted.signal)) assert.fail('Cancelled reply yielded'); }, { name: 'AbortError' });
});

test('missing, malformed and stale knowledge fails closed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'teplo-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(KnowledgeBase.load(directory), /data:prepare/);
  await mkdir(join(directory, 'data/generated'), { recursive: true });
  await writeFile(join(directory, 'data/generated/knowledge.json'), '{}');
  await assert.rejects(KnowledgeBase.load(directory), /data:prepare/);
  const bundle = JSON.parse(await readFile(join(root, 'data/generated/knowledge.json'), 'utf8'));
  bundle.provenance.inputs = [{ file: 'changed.txt', sha256_lf: '0'.repeat(64) }];
  await writeFile(join(directory, 'changed.txt'), 'changed');
  await writeFile(join(directory, 'data/generated/knowledge.json'), JSON.stringify(bundle));
  await assert.rejects(KnowledgeBase.load(directory), /Данные устарели/);
});

test('configuration rejects invalid ports and always binds loopback', () => {
  for (const port of ['0', '-1', '65536', '1.5', 'abc', '']) assert.throws(() => new AppConfig({ BOT_PORT: port }));
  assert.equal(new AppConfig({ BOT_PORT: '3100', BOT_HOST: '0.0.0.0' }).host, '127.0.0.1');
});
