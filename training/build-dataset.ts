import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { AppConfig } from '../server/AppConfig.js';
import { IntentFeaturizer, type FeaturizerConfig } from '../server/IntentFeaturizer.js';
import { IntentRules } from '../server/IntentRules.js';
import { ParamExtractor } from '../server/ParamExtractor.js';
import { TextNormalizer } from '../server/TextNormalizer.js';

interface SeedRecord { id: string; intents: string[]; question: string; }
interface AiFile {
  schema_version: number;
  origin: string;
  generator: string;
  review_status: 'unreviewed' | 'reviewed';
  paraphrases?: Record<string, string[]>;
  questions?: Record<string, string[]>;
}
interface TrainingConfig {
  schema_version: number;
  featurizer: FeaturizerConfig;
  excluded_seeds: Record<string, string>;
  min_examples_per_class: number;
  training: Record<string, unknown>;
}
interface DatasetExample {
  id: string;
  group: string;
  intent: string;
  intents: string[];
  origin: 'seed' | 'ai_paraphrase' | 'ai_question';
  review: string;
  text: string;
  features: number[];
  rules: string | null;
}

// Files whose content determines the dataset, including the featurization code.
const FIXED_INPUTS = ['docs/question-annotations.json', 'docs/question-intents.md', 'data/training/intent-config.json', 'server/TextNormalizer.ts', 'server/IntentFeaturizer.ts', 'server/IntentRules.ts', 'server/ParamExtractor.ts'];
const AI_DIRECTORY = 'data/training/ai';
const DATASET_PATH = 'data/generated/intent-dataset.json';

const root = new AppConfig().root;
const read = async (file: string) => (await readFile(join(root, file), 'utf8')).replace(/\r\n/g, '\n');
const fail = (message: string): never => { throw new Error(message); };

const config: TrainingConfig = JSON.parse(await read('data/training/intent-config.json'));
if (config.schema_version !== 1) fail('Неизвестная версия intent-config.json.');
const intentSection = (await read('docs/question-intents.md')).split(/^## /m).find(section => section.startsWith('Словарь намерений')) ?? '';
const catalog = [...intentSection.matchAll(/^\| `([a-z_.]+)` \|/gm)].map(match => match[1]);
if (new Set(catalog).size !== catalog.length || catalog.length < 2) fail('Словарь намерений не прочитан.');
const annotations = JSON.parse(await read('docs/question-annotations.json'));
const seeds: SeedRecord[] = annotations.records;
const known = new Set(catalog);
for (const seed of seeds) for (const intent of seed.intents) if (!known.has(intent)) fail(`${seed.id}: намерение ${intent} отсутствует в словаре.`);
for (const id of Object.keys(config.excluded_seeds)) if (!seeds.some(seed => seed.id === id)) fail(`Исключён неизвестный вопрос ${id}.`);

const featurizer = new IntentFeaturizer(config.featurizer);
const normalizer = new TextNormalizer();
const rules = new IntentRules();
const extractor = new ParamExtractor();
const primary = new Map(seeds.map(seed => [seed.id, seed.intents[0]]));
// Intent the current rule service would route to; null means its generic "not supported yet" answer.
function ruleIntent(raw: string): string | null {
  const text = normalizer.normalize(raw);
  const safety = rules.safety(text);
  if (safety) return primary.get(safety) ?? fail(`Правило ссылается на неизвестный ${safety}.`);
  return rules.isReset(text) || rules.isFlow(text, extractor.extract(text).parameters) ? 'hydraulics.flow' : null;
}

const examples: DatasetExample[] = [];
const add = (example: Omit<DatasetExample, 'features' | 'rules'>) => {
  const text = example.text.trim();
  if (text !== example.text || text.length < 2 || text.length > 400) fail(`${example.id}: пустой, слишком длинный или с пробелами по краям текст.`);
  examples.push({ ...example, features: featurizer.features(text), rules: ruleIntent(text) });
};
for (const seed of seeds) {
  if (config.excluded_seeds[seed.id]) continue;
  add({ id: seed.id, group: seed.id, intent: seed.intents[0], intents: seed.intents, origin: 'seed', review: annotations.usefulness_review, text: seed.question });
}
const aiFiles = (await readdir(join(root, AI_DIRECTORY))).filter(name => name.endsWith('.json')).sort();
for (const name of aiFiles) {
  const file = `${AI_DIRECTORY}/${name}`;
  const data: AiFile = JSON.parse(await read(file));
  if (data.schema_version !== 1 || data.origin !== 'ai_generated' || !data.generator || !['unreviewed', 'reviewed'].includes(data.review_status)) fail(`${file}: неверный заголовок.`);
  const review = `ai_${data.review_status}`;
  for (const [id, texts] of Object.entries(data.paraphrases ?? {})) {
    const seed = seeds.find(item => item.id === id) ?? fail(`${file}: переформулировка неизвестного ${id}.`);
    if (config.excluded_seeds[id]) fail(`${file}: ${id} исключён из обучения, его переформулировки не нужны.`);
    texts.forEach((text, i) => add({ id: `${id}/p${i + 1}`, group: id, intent: seed.intents[0], intents: [seed.intents[0]], origin: 'ai_paraphrase', review, text }));
  }
  for (const [intent, texts] of Object.entries(data.questions ?? {})) {
    if (!known.has(intent)) fail(`${file}: намерение ${intent} отсутствует в словаре.`);
    texts.forEach((text, i) => {
      const id = `${intent}/${name.replace(/\.json$/, '')}/q${i + 1}`;
      add({ id, group: id, intent, intents: [intent], origin: 'ai_question', review, text });
    });
  }
}

const seen = new Map<string, string>();
for (const example of examples) {
  const key = featurizer.tokens(example.text).join(' ');
  const previous = seen.get(key);
  if (previous) fail(`Повтор текста: ${previous} и ${example.id}.`);
  seen.set(key, example.id);
}
const counts = new Map(catalog.map(intent => [intent, 0]));
for (const example of examples) counts.set(example.intent, counts.get(example.intent)! + 1);
const scarce = [...counts].filter(([, count]) => count < config.min_examples_per_class);
if (scarce.length) fail(`Мало примеров (< ${config.min_examples_per_class}): ${scarce.map(([intent, count]) => `${intent}: ${count}`).join(', ')}.`);

const inputs = [];
for (const file of [...FIXED_INPUTS, ...aiFiles.map(name => `${AI_DIRECTORY}/${name}`)]) {
  inputs.push({ file, sha256_lf: createHash('sha256').update(await read(file)).digest('hex') });
}
const dataset = {
  schema_version: 1,
  note: 'Синтетические примеры разработки: не реальные обращения и не независимый контрольный набор.',
  inputs,
  featurizer: config.featurizer,
  training: config.training,
  classes: catalog,
  examples,
};
await mkdir(join(root, 'data/generated'), { recursive: true });
await writeFile(join(root, DATASET_PATH), JSON.stringify(dataset) + '\n', 'utf8');
const by = (origin: string) => examples.filter(example => example.origin === origin).length;
console.log(`Подготовлен ${DATASET_PATH}: ${examples.length} примеров (вопросы ${by('seed')}, переформулировки ${by('ai_paraphrase')}, новые ${by('ai_question')}), ${catalog.length} классов, минимум ${Math.min(...counts.values())} примеров на класс.`);
