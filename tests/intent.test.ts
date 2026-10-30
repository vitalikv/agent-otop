import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IntentFeaturizer, type FeaturizerConfig } from '../server/IntentFeaturizer.js';
import { IntentClassifier, type IntentModelFile } from '../server/IntentClassifier.js';

const config: FeaturizerConfig = { version: 1, buckets: 1024, char_ngrams: [2, 4], word_bigrams: true };
const featurizer = new IntentFeaturizer(config);

test('features are normalized, digit-independent, sorted and inside the bucket range', () => {
  assert.deepEqual(featurizer.features('Батарея  ЁЛКА 16х2'), featurizer.features('батарея елка 20x3'));
  assert.notDeepEqual(featurizer.features('батарея'), featurizer.features('радиатор'));
  assert.deepEqual(featurizer.tokens('Расход 0,3 м³/ч при 60/40'), ['расход', '0.0', 'м0/ч', 'при', '00/00']);
  const features = featurizer.features('Какой диаметр трубы нужен на 6 кВт?');
  assert.ok(features.length > 20);
  assert.deepEqual(features, [...new Set(features)].sort((a, b) => a - b));
  assert.ok(features.every(id => Number.isInteger(id) && id >= 0 && id < config.buckets));
  assert.deepEqual(featurizer.features(' ?! '), []);
  assert.throws(() => new IntentFeaturizer({ ...config, buckets: 1.5 }));
  assert.throws(() => new IntentFeaturizer({ ...config, char_ngrams: [3, 2] }));
});

const tensor = (shape: number[], values: number[]) => ({ shape, data: Buffer.from(new Float32Array(values).buffer).toString('base64') });
const tiny: FeaturizerConfig = { version: 1, buckets: 4, char_ngrams: [1, 1], word_bigrams: false };
// Embedding rows per bucket (hidden = 2), two classes.
const model = (overrides: Partial<IntentModelFile> = {}): IntentModelFile => ({
  format: 'teplo-intent-mlp',
  version: 1,
  featurizer: tiny,
  classes: ['a', 'b'],
  threshold: 0.6,
  weights: {
    embedding: tensor([4, 2], [1, 0, 0, 1, 2, -2, -1, 3]),
    hidden_bias: tensor([2], [0.5, -0.5]),
    output: tensor([2, 2], [1, 2, -1, 0.5]),
    output_bias: tensor([2], [0, 0.25]),
  },
  training: {},
  ...overrides,
});

test('classifier forward pass matches the hand-computed network', () => {
  const classifier = new IntentClassifier(model());
  // mean([1,0],[2,-2]) + bias = [2, -1.5] → ReLU [2, 0]; logits [2, -1.75].
  assert.deepEqual(Array.from(classifier.logits([0, 2])), [2, -1.75]);
  // No features: ReLU(bias) = [0.5, 0]; logits [0.5, -0.25].
  assert.deepEqual(Array.from(classifier.logits([])), [0.5, -0.25]);
  assert.throws(() => classifier.logits([4]));
  const prediction = classifier.classify('');
  assert.equal(prediction.intent, 'a');
  assert.ok(Math.abs(prediction.confidence - 1 / (1 + Math.exp(-0.75))) < 1e-12);
  assert.equal(prediction.accepted, true);
  assert.ok(Math.abs(prediction.ranking.reduce((sum, item) => sum + item.probability, 0) - 1) < 1e-12);
  assert.equal(new IntentClassifier(model({ threshold: 0.7 })).classify('').accepted, false);
});

test('classifier rejects malformed models', () => {
  const base = model();
  assert.throws(() => new IntentClassifier({ ...base, format: 'other' as 'teplo-intent-mlp' }), /формат/);
  assert.throws(() => new IntentClassifier({ ...base, classes: ['a', 'a'] }), /классов/);
  assert.throws(() => new IntentClassifier({ ...base, threshold: 2 }), /порог/);
  assert.throws(() => new IntentClassifier({ ...base, weights: { ...base.weights, output: tensor([2, 3], [1, 2, 3, 4, 5, 6]) } }), /форма/);
  assert.throws(() => new IntentClassifier({ ...base, weights: { ...base.weights, output_bias: { shape: [2], data: 'AAAA' } } }), /Размер/);
  assert.throws(() => new IntentClassifier({ ...base, weights: { ...base.weights, output_bias: tensor([2], [Number.NaN, 0]) } }), /нечисловые/);
});
