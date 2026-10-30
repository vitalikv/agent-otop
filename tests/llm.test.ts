import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { AppConfig } from '../server/AppConfig.js';
import { KnowledgeBase } from '../server/KnowledgeBase.js';
import { KnowledgeSearch } from '../server/KnowledgeSearch.js';
import { ExpressionCalculator } from '../server/ExpressionCalculator.js';
import { AssistantService } from '../server/AssistantService.js';
import { ChatController } from '../server/ChatController.js';
import { LlmClient, LlmUnavailableError, type CompletionOptions, type LlmBackend, type LlmCompletion, type LlmMessage } from '../server/LlmClient.js';
import { LlmResponder } from '../server/LlmResponder.js';

const knowledge = await KnowledgeBase.load(new AppConfig().root);
const position = (id: string) => knowledge.passages.findIndex(passage => passage.id === id) + 1;

// Scripted stand-in for llama-server: replies in order and records what it was asked.
class ScriptedBackend implements LlmBackend {
  readonly calls: { messages: LlmMessage[]; tools: object[]; options?: CompletionOptions }[] = [];
  constructor(private readonly replies: LlmCompletion['message'][]) {}
  async complete(messages: LlmMessage[], tools: object[], options?: CompletionOptions): Promise<LlmCompletion> {
    this.calls.push({ messages: structuredClone(messages), tools, options });
    const message = this.replies.shift();
    if (!message) throw new Error('Модель не должна была вызываться.');
    return { message, timings: { prompt_n: 100, prompt_ms: 50, predicted_n: 20, predicted_ms: 200 } };
  }
}
const ask = (content: string) => ({ messages: [{ role: 'user' as const, content }] });

test('expression calculator computes formulas and evaluates nothing else', () => {
  const calculator = new ExpressionCalculator();
  assert.ok(Math.abs(calculator.evaluate('0.86*8/(60-40)') - 0.344) < 1e-12);
  assert.ok(Math.abs(calculator.evaluate('4*(100/1000/3600)/(pi*(12/1000)^2)') - 0.24560948008008543) < 1e-12);
  assert.equal(calculator.evaluate('sqrt(16) + 2^3 * 0,5'), 8);
  assert.equal(calculator.evaluate('-2^2'), -4);
  assert.equal(calculator.evaluate('2^-1'), 0.5);
  assert.equal(calculator.evaluate('20 × 2'), 40);
  for (const bad of ['process.exit()', '1/0', '2+', '(1', 'abc', '', 'x'.repeat(301), '1;2']) assert.throws(() => calculator.evaluate(bad), bad);
});

test('word search joins inflections and dictionary synonyms', () => {
  const search = new KnowledgeSearch(knowledge);
  assert.equal(search.stem('радиаторов'), 'радиатор');
  assert.equal(search.stem('трубой'), 'труб');
  assert.ok(search.tokens('Батарея под окном').includes('term:radiator'));
  assert.deepEqual(search.tokens('16х2 и Ду20').slice(0, 2), ['16x2', 'ду20']);
  assert.ok(search.search('Как правильно опрессовать систему перед стяжкой, каким давлением испытывать?').some(hit => hit.id === 'g06.test'));
  assert.deepEqual(search.search('видеокарта для игр'), []);
});

test('the model picks sections, calculates with the tool and cites renumbered sources', async () => {
  const backend = new ScriptedBackend([
    { content: JSON.stringify({ sections: [position('g05.flow'), 999] }) },
    { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calculate', arguments: JSON.stringify({ expression: '0.86*8/(60-40)' }) } }] },
    { content: '<think>черновик</think>Расход ≈ 0,344 м³/ч [1], формула из базы [1]. Подтвердите, что теплоноситель — вода [3]?' },
  ]);
  const { answer, trace } = await new LlmResponder(knowledge, backend).answer(ask('Какой расход воды нужен для 8 кВт при подаче 60 и обратке 40 градусов?'));
  const [selection, first, second] = backend.calls;
  assert.ok(selection.options?.schema && selection.tools.length === 0);
  assert.match((selection.messages[0] as { content: string }).content, new RegExp(`${position('g05.flow')}\\. 5\\. Диаметры труб, гидравлика и балансировка → Нагрузка и расход`));
  assert.deepEqual(trace.selected, ['g05.flow']);
  assert.equal(trace.retrieved[0], 'g05.flow');
  assert.ok(trace.retrieved.length >= 1 && trace.retrieved.length <= 2);
  assert.match((first.messages[0] as { content: string }).content, /^Ты — помощник по отоплению[\s\S]*Фрагменты базы:\n\n\[1\] Глава 05 · Нагрузка и расход\n## Нагрузка и расход/);
  assert.equal(first.tools.length, 1);
  assert.deepEqual(second.messages.at(-1), { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ result: 0.86 * 8 / 20 }) });
  assert.deepEqual(trace.calculations, [{ expression: JSON.stringify({ expression: '0.86*8/(60-40)' }), result: 0.86 * 8 / 20 }]);
  assert.equal(answer.content, 'Расход ≈ 0,344 м³/ч [1], формула из базы [1]. Подтвердите, что теплоноситель — вода?');
  assert.deepEqual(answer.sources.map(source => source.id), ['g05.flow']);
  assert.equal(answer.clarification, true);
  assert.equal(trace.timings.length, 3);
});

test('a broken selection falls back to word search and tool errors are returned to the model', async () => {
  const backend = new ScriptedBackend([
    { content: 'разделы: нет' },
    { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calculate', arguments: '{"expression":"import os"}' } }] },
    { content: 'Не могу посчитать без исходных данных.' },
  ]);
  const { answer, trace } = await new LlmResponder(knowledge, backend).answer(ask('Как опрессовать систему отопления перед стяжкой?'));
  assert.deepEqual(trace.selected, []);
  assert.deepEqual(trace.retrieved, trace.matched.slice(0, 2));
  assert.ok(trace.retrieved.includes('g06.test'));
  assert.match(String(trace.calculations[0].result), /^Ошибка/);
  assert.deepEqual(answer.sources, []);
  assert.equal(answer.clarification, false);
});

test('verified rules answer before the language model', async () => {
  const silent = new ScriptedBackend([]);
  const assistant = new AssistantService(knowledge, undefined, new LlmResponder(knowledge, silent));
  assert.equal((await assistant.replyWithTrace(ask('В котельной пахнет газом'))).answer.content, knowledge.reference('SYN-151').answer);
  assert.equal((await assistant.replyWithTrace(ask('Посчитай расход для 5 кВт'))).answer.state?.pending, 'coolant');
  assert.equal(silent.calls.length, 0);
  const backend = new ScriptedBackend([{ content: '{"sections":[]}' }, { content: 'Я помогаю с отоплением.' }]);
  const routed = await new AssistantService(knowledge, undefined, new LlmResponder(knowledge, backend)).replyWithTrace(ask('Посоветуй сериал'));
  assert.equal(routed.route, 'llm');
  assert.equal(routed.answer.content, 'Я помогаю с отоплением.');
});

test('llama-server client sends the expected request and reports outages as unavailable', async t => {
  const bodies: Record<string, unknown>[] = [];
  let status = 200;
  const server = createServer((request, response) => {
    if (request.url === '/health') { response.writeHead(200).end('{}'); return; }
    let body = '';
    request.on('data', chunk => { body += chunk; }).on('end', () => {
      bodies.push(JSON.parse(body));
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], timings: { prompt_n: 1, prompt_ms: 1, predicted_n: 1, predicted_ms: 1 } }));
    });
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = new LlmClient(`http://127.0.0.1:${address.port}`, 5000);
  assert.equal(await client.healthy(), true);
  assert.equal((await client.complete([{ role: 'user', content: 'q' }], [{ type: 'function' }])).message.content, 'ok');
  await client.complete([{ role: 'user', content: 'q' }], [], { schema: { type: 'object' }, maxTokens: 60 });
  assert.deepEqual(bodies[0].chat_template_kwargs, { enable_thinking: false });
  assert.equal(bodies[0].tool_choice, 'auto');
  assert.equal(bodies[1].tools, undefined);
  assert.deepEqual(bodies[1].response_format, { type: 'json_schema', json_schema: { name: 'reply', schema: { type: 'object' } } });
  assert.equal(bodies[1].max_tokens, 60);
  status = 500;
  await assert.rejects(client.complete([{ role: 'user', content: 'q' }], []), LlmUnavailableError);
  await assert.rejects(new LlmClient('http://127.0.0.1:9', 2000).complete([{ role: 'user', content: 'q' }], []), LlmUnavailableError);
  assert.equal(await new LlmClient('http://127.0.0.1:9', 2000).healthy(), false);

  const api = new ChatController(knowledge, undefined, new LlmResponder(knowledge, new LlmClient('http://127.0.0.1:9', 2000))).createServer().listen(0, '127.0.0.1');
  await once(api, 'listening');
  t.after(() => new Promise<void>(resolve => api.close(() => resolve())));
  const apiAddress = api.address();
  assert.ok(apiAddress && typeof apiAddress !== 'string');
  const base = `http://127.0.0.1:${apiAddress.port}/api`;
  assert.equal((await fetch(`${base}/health`).then(response => response.json())).engine, 'rules+llm');
  const failed = await fetch(`${base}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ask('Зачем нужен расширительный бак?')) });
  assert.equal(failed.status, 503);
  assert.match((await failed.json()).error, /недоступна/);
  const ruled = await fetch(`${base}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ask('В котельной пахнет газом')) });
  assert.equal(ruled.status, 200);
});

test('configuration validates the language model address and timeout', () => {
  assert.equal(new AppConfig({ BOT_LLM_URL: 'http://127.0.0.1:8080/v1' }).llmUrl, 'http://127.0.0.1:8080');
  assert.equal(new AppConfig({}).llmUrl, undefined);
  assert.equal(new AppConfig({}).llmTimeoutMs, 120000);
  assert.throws(() => new AppConfig({ BOT_LLM_URL: 'ftp://x' }), /BOT_LLM_URL/);
  assert.throws(() => new AppConfig({ BOT_LLM_URL: 'не адрес' }), /BOT_LLM_URL/);
  assert.throws(() => new AppConfig({ BOT_LLM_TIMEOUT_MS: '10' }), /BOT_LLM_TIMEOUT_MS/);
});
