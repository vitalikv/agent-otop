import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AppConfig } from '../server/AppConfig.js';
import { KnowledgeBase } from '../server/KnowledgeBase.js';
import { AssistantService } from '../server/AssistantService.js';
import { LlmClient } from '../server/LlmClient.js';
import { LlmResponder } from '../server/LlmResponder.js';
import type { ChatRequest } from '../shared/chat.js';

// npm run llm:eval -- --label 8b [--limit 20] [--ids SYN-001,SYN-061]
// Runs the 160 reference questions through the full service pipeline (rules, then the language model).
interface Expectation { metric: string; value: number; unit: string; absolute_tolerance?: number }
interface Reference {
  id: string; question: string; question_context: string | null; response_mode: string; answer: string; source_ids: string[];
  numeric_expectations?: Expectation[]; dialog_fixture?: { before?: Record<string, unknown> } | null;
}
const option = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const label = option('label') ?? 'model';
if (!/^[\w.-]+$/.test(label)) throw new Error('--label: только буквы, цифры, точка, дефис и подчёркивание.');
const config = new AppConfig();
const url = config.llmUrl ?? 'http://127.0.0.1:8080';
const client = new LlmClient(url, config.llmTimeoutMs);
if (!await client.healthy()) {
  console.error(`Языковая модель недоступна на ${url}. Запустите npm run llm:server -- 8b в отдельном терминале.`);
  process.exit(1);
}
const knowledge = await KnowledgeBase.load(config.root);
const assistant = new AssistantService(knowledge, undefined, new LlmResponder(knowledge, client));
const passages = new Set(knowledge.passages.map(passage => passage.id));
let references: Reference[] = JSON.parse(await readFile(join(config.root, 'docs/reference-answers.json'), 'utf8')).records;
const ids = option('ids')?.split(',');
if (ids) references = references.filter(reference => ids.includes(reference.id));
references = references.slice(0, Number(option('limit') ?? references.length));

const numbers = (text: string) => (text.replace(/(\d)\s(?=\d{3}\b)/g, '$1').match(/\d+(?:[.,]\d+)?/g) ?? []).map(value => Number(value.replace(',', '.')));
// Rounded values are accepted within 3 %; l/h may also be written in m³/h.
const states = (text: string, expected: Expectation) => numbers(text).some(found => [expected.value, ...(expected.unit === 'l/h' ? [expected.value / 1000] : [])]
  .some(value => Math.abs(found - value) <= Math.max(expected.absolute_tolerance ?? 0, Math.abs(value) * 0.03)));
const share = (values: (boolean | null)[]) => { const known = values.filter(value => value !== null); return known.length ? `${known.filter(Boolean).length}/${known.length}` : '—'; };
const percentile = (values: number[], p: number) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] : 0;

const results = [];
for (const [index, reference] of references.entries()) {
  const context = [reference.question_context, reference.dialog_fixture?.before && `известные параметры: ${Object.entries(reference.dialog_fixture.before).map(([key, value]) => `${key}=${value}`).join(', ')}`].filter(Boolean).join('; ');
  const request: ChatRequest = { messages: [...(context ? [{ role: 'assistant' as const, content: `(Из предыдущей части диалога) ${context}` }] : []), { role: 'user', content: reference.question }] };
  const started = performance.now();
  const { answer, route, trace } = await assistant.replyWithTrace(request);
  const ms = Math.round(performance.now() - started);
  const expected = reference.source_ids.filter(id => passages.has(id));
  const numeric = (reference.numeric_expectations ?? []).filter(item => states(reference.answer, item));
  const timings = trace?.timings ?? [];
  const sum = (key: 'prompt_n' | 'prompt_ms' | 'predicted_n' | 'predicted_ms') => timings.reduce((total, item) => total + item[key], 0);
  results.push({
    id: reference.id, mode: reference.response_mode, question: reference.question, context, reference: reference.answer, route, ms,
    answer: answer.content, sources: answer.sources.map(source => source.id), retrieved: trace?.retrieved ?? [], calculations: trace?.calculations ?? [],
    retrieval_hit: route === 'llm' && expected.length ? expected.some(id => trace!.retrieved.includes(id)) : null,
    selection_hit: route === 'llm' && expected.length ? expected.some(id => trace!.selected.includes(id)) : null,
    words_hit: route === 'llm' && expected.length ? expected.some(id => trace!.matched.includes(id)) : null,
    source_hit: route === 'llm' && expected.length ? expected.some(id => answer.sources.some(source => source.id === id)) : null,
    numbers_match: route === 'llm' && numeric.length ? numeric.every(item => states(answer.content, item)) : null,
    asks_question: route === 'llm' && reference.response_mode === 'clarify' ? answer.content.includes('?') : null,
    prompt_tokens: sum('prompt_n'), prompt_ms: sum('prompt_ms'), generated_tokens: sum('predicted_n'), generated_ms: sum('predicted_ms'),
  });
  console.log(`${index + 1}/${references.length} ${reference.id} ${route} ${(ms / 1000).toFixed(1)} с`);
}

const llm = results.filter(result => result.route === 'llm');
const rate = (tokens: number, ms: number) => ms ? (tokens / ms * 1000).toFixed(0) : '—';
const total = (key: 'prompt_tokens' | 'prompt_ms' | 'generated_tokens' | 'generated_ms') => llm.reduce((sum, result) => sum + result[key], 0);
const summary = {
  label, url, questions: results.length, by_rules: results.length - llm.length, by_llm: llm.length,
  latency_s: { median: percentile(llm.map(result => result.ms), 0.5) / 1000, p90: percentile(llm.map(result => result.ms), 0.9) / 1000, max: percentile(llm.map(result => result.ms), 1) / 1000 },
  prompt_tokens_avg: llm.length ? Math.round(total('prompt_tokens') / llm.length) : 0,
  generated_tokens_avg: llm.length ? Math.round(total('generated_tokens') / llm.length) : 0,
  prompt_tokens_per_s: rate(total('prompt_tokens'), total('prompt_ms')),
  generated_tokens_per_s: rate(total('generated_tokens'), total('generated_ms')),
  retrieval_hit: share(llm.map(result => result.retrieval_hit)),
  selection_hit: share(llm.map(result => result.selection_hit)),
  words_hit: share(llm.map(result => result.words_hit)),
  source_hit: share(llm.map(result => result.source_hit)),
  numbers_match: share(llm.map(result => result.numbers_match)),
  clarify_asks_question: share(llm.map(result => result.asks_question)),
  calculations: llm.reduce((sum, result) => sum + result.calculations.length, 0),
};
await mkdir(join(config.root, 'data/generated'), { recursive: true });
await writeFile(join(config.root, `data/generated/llm-eval-${label}.json`), JSON.stringify({ summary, results }, null, 1) + '\n', 'utf8');
const quote = (text: string) => text.split('\n').map(line => `> ${line}`).join('\n');
const report = [
  `# Прогон эталонных вопросов: ${label}`,
  '',
  `Вопросов ${summary.questions}: правилами ${summary.by_rules}, моделью ${summary.by_llm}. Время ответа модели: медиана ${summary.latency_s.median.toFixed(1)} с, 90% быстрее ${summary.latency_s.p90.toFixed(1)} с, максимум ${summary.latency_s.max.toFixed(1)} с.`,
  `Запрос в среднем ${summary.prompt_tokens_avg} токенов (${summary.prompt_tokens_per_s} ток/с), ответ ${summary.generated_tokens_avg} токенов (${summary.generated_tokens_per_s} ток/с). Вызовов calculate: ${summary.calculations}.`,
  `Нужный раздел передан модели: ${summary.retrieval_hit} (выбран по оглавлению ${summary.selection_hit}, найден по словам ${summary.words_hit}); указан в источниках ответа: ${summary.source_hit}; числа эталона в ответе: ${summary.numbers_match}; уточняющий вопрос там, где эталон уточняет: ${summary.clarify_asks_question}.`,
  '',
  'Автоматические проверки грубые: они не оценивают правильность и полноту ответа. Это делает человек, сравнивая ответ с эталоном.',
  ...results.flatMap(result => [
    '',
    `## ${result.id} · ${result.mode} · ${result.route} · ${(result.ms / 1000).toFixed(1)} с`,
    '',
    `**Вопрос:** ${result.question}${result.context ? `\n\n*Контекст:* ${result.context}` : ''}`,
    '',
    '**Эталон:**',
    '',
    quote(result.reference),
    '',
    `**Ответ (${label}):**`,
    '',
    quote(result.answer),
    '',
    `Источники: ${result.sources.join(', ') || '—'} · передано модели: ${result.retrieved.join(', ') || '—'}${result.calculations.length ? ` · расчёты: ${result.calculations.map(item => `${item.expression} → ${item.result}`).join('; ')}` : ''}`,
  ]),
].join('\n') + '\n';
await writeFile(join(config.root, `data/generated/llm-eval-${label}.md`), report, 'utf8');
console.log(JSON.stringify(summary, null, 1));
console.log(`Отчёт: data/generated/llm-eval-${label}.md`);
