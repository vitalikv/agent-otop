import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AppConfig } from '../server/AppConfig.js';
import { IntentClassifier } from '../server/IntentClassifier.js';

// Checks that the TypeScript network reproduces PyTorch and measures cost on this computer.
const root = new AppConfig().root;
const file = (name: string) => join(root, 'data/generated', name);
const rawDataset = await readFile(file('intent-dataset.json'));
const dataset: { inputs: { file: string; sha256_lf: string }[]; examples: { id: string; text: string; features: number[] }[] } = JSON.parse(rawDataset.toString('utf8'));
const modelText = await readFile(file('intent-model.json'), 'utf8');
const parity: { model_sha256: string; cases: { id: string; logits: number[] }[] } = JSON.parse(await readFile(file('intent-parity.json'), 'utf8'));
const errors: string[] = [];
for (const input of dataset.inputs) {
  const content = await readFile(join(root, input.file), 'utf8').catch(() => undefined);
  if (content === undefined || createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex') !== input.sha256_lf) errors.push(`Набор устарел: изменился ${input.file}. Выполните npm run train:data и npm run train:model.`);
}

const memoryBefore = process.memoryUsage().rss;
const loadStarted = performance.now();
const classifier = new IntentClassifier(JSON.parse(modelText));
const loadMs = performance.now() - loadStarted;
const memoryMb = (process.memoryUsage().rss - memoryBefore) / 2 ** 20;

if (classifier.model.training.dataset_sha256 !== createHash('sha256').update(rawDataset).digest('hex')) errors.push('Модель обучена на другой версии набора: выполните npm run train:model.');
if (parity.model_sha256 !== createHash('sha256').update(modelText).digest('hex')) errors.push('Контрольные логиты относятся к другой модели.');
const drift = dataset.examples.filter(example => !isDeepStrictEqual(classifier.featurizer.features(example.text), example.features));
if (drift.length) errors.push(`Признаки ${drift.length} примеров отличаются от набора (первый ${drift[0].id}): выполните npm run train:data и npm run train:model.`);

const byId = new Map(dataset.examples.map(example => [example.id, example]));
let maxDiff = 0;
let argmaxMismatch = 0;
for (const item of parity.cases) {
  const example = byId.get(item.id);
  if (!example) { errors.push(`Нет примера ${item.id}.`); continue; }
  const logits = classifier.logits(example.features);
  for (let i = 0; i < logits.length; i++) maxDiff = Math.max(maxDiff, Math.abs(logits[i] - item.logits[i]));
  if (logits.indexOf(Math.max(...logits)) !== item.logits.indexOf(Math.max(...item.logits))) argmaxMismatch++;
}
if (maxDiff > 1e-4 || argmaxMismatch) errors.push(`Расхождение с PyTorch: максимум ${maxDiff.toExponential(2)}, другой класс в ${argmaxMismatch} случаях.`);

const texts = dataset.examples.map(example => example.text);
for (const text of texts) classifier.classify(text);
const timings: number[] = [];
for (let round = 0; round < 5; round++) for (const text of texts) {
  const started = performance.now();
  classifier.classify(text);
  timings.push(performance.now() - started);
}
timings.sort((a, b) => a - b);
const average = timings.reduce((sum, value) => sum + value, 0) / timings.length;

console.log(`Модель: ${classifier.classes.length} классов, скрытый слой ${classifier.hidden}, ${classifier.model.training.parameters} параметров, файл ${(Buffer.byteLength(modelText) / 2 ** 20).toFixed(1)} МБ.`);
console.log(`Сверка с PyTorch: ${parity.cases.length} примеров, максимальное отличие логитов ${maxDiff.toExponential(2)}, другой класс: ${argmaxMismatch}.`);
console.log(`Загрузка ${loadMs.toFixed(0)} мс, прирост памяти процесса ≈ ${memoryMb.toFixed(0)} МБ. Определение намерения: в среднем ${average.toFixed(3)} мс, 99% быстрее ${timings[Math.floor(timings.length * 0.99)].toFixed(3)} мс (${timings.length} запросов, один поток).`);
if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else console.log('Модель согласована с набором и PyTorch.');
