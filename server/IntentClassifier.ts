import { readFile } from 'node:fs/promises';
import { IntentFeaturizer, type FeaturizerConfig } from './IntentFeaturizer.js';

interface Tensor { shape: number[]; data: string; }
export interface IntentModelFile {
  format: 'teplo-intent-mlp';
  version: 1;
  featurizer: FeaturizerConfig;
  classes: string[];
  threshold: number;
  weights: Record<'embedding' | 'hidden_bias' | 'output' | 'output_bias', Tensor>;
  training: Record<string, unknown>;
}
export interface IntentPrediction {
  intent: string;
  confidence: number;
  accepted: boolean;
  ranking: { intent: string; probability: number }[];
}

function decode(tensor: Tensor, shape: number[]): Float32Array {
  if (!Array.isArray(tensor?.shape) || tensor.shape.length !== shape.length || tensor.shape.some((size, i) => size !== shape[i])) {
    throw new Error(`Неверная форма весов: ожидалось ${shape.join('×')}.`);
  }
  const bytes = Buffer.from(tensor.data, 'base64');
  const size = shape.reduce((product, value) => product * value, 1);
  if (bytes.length !== size * 4) throw new Error('Размер весов не совпадает с формой.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const values = Float32Array.from({ length: size }, (_, i) => view.getFloat32(i * 4, true));
  if (!values.every(Number.isFinite)) throw new Error('Веса содержат нечисловые значения.');
  return values;
}

/** Character n-gram bag → mean embedding → ReLU → linear layer → softmax; mirrors training/train.py. */
export class IntentClassifier {
  readonly featurizer: IntentFeaturizer;
  readonly classes: string[];
  readonly threshold: number;
  readonly hidden: number;
  private readonly embedding: Float32Array;
  private readonly hiddenBias: Float32Array;
  private readonly output: Float32Array;
  private readonly outputBias: Float32Array;

  constructor(readonly model: IntentModelFile) {
    if (model?.format !== 'teplo-intent-mlp' || model.version !== 1) throw new Error('Неизвестный формат модели намерений.');
    if (!Array.isArray(model.classes) || model.classes.length < 2 || new Set(model.classes).size !== model.classes.length) throw new Error('Неверный список классов модели.');
    if (typeof model.threshold !== 'number' || model.threshold < 0 || model.threshold > 1) throw new Error('Неверный порог уверенности модели.');
    this.featurizer = new IntentFeaturizer(model.featurizer);
    this.classes = model.classes;
    this.threshold = model.threshold;
    this.hidden = model.weights?.hidden_bias?.shape?.[0];
    if (!Number.isInteger(this.hidden) || this.hidden < 1) throw new Error('Неверный размер скрытого слоя.');
    this.embedding = decode(model.weights.embedding, [model.featurizer.buckets, this.hidden]);
    this.hiddenBias = decode(model.weights.hidden_bias, [this.hidden]);
    this.output = decode(model.weights.output, [this.classes.length, this.hidden]);
    this.outputBias = decode(model.weights.output_bias, [this.classes.length]);
  }

  static async load(path: string): Promise<IntentClassifier> {
    return new IntentClassifier(JSON.parse(await readFile(path, 'utf8')));
  }

  logits(features: readonly number[]): Float64Array {
    const { hidden } = this;
    const state = new Float64Array(hidden);
    for (const feature of features) {
      if (!Number.isInteger(feature) || feature < 0 || feature >= this.featurizer.config.buckets) throw new Error('Признак вне словаря модели.');
      for (let j = 0, row = feature * hidden; j < hidden; j++) state[j] += this.embedding[row + j];
    }
    for (let j = 0; j < hidden; j++) state[j] = Math.max(0, (features.length ? state[j] / features.length : 0) + this.hiddenBias[j]);
    const logits = new Float64Array(this.classes.length);
    for (let c = 0; c < logits.length; c++) {
      let sum = this.outputBias[c];
      for (let j = 0, row = c * hidden; j < hidden; j++) sum += this.output[row + j] * state[j];
      logits[c] = sum;
    }
    return logits;
  }

  classify(text: string): IntentPrediction {
    const logits = this.logits(this.featurizer.features(text));
    const max = Math.max(...logits);
    const exp = Array.from(logits, value => Math.exp(value - max));
    const total = exp.reduce((sum, value) => sum + value, 0);
    const ranking = exp.map((value, i) => ({ intent: this.classes[i], probability: value / total })).sort((a, b) => b.probability - a.probability);
    return { intent: ranking[0].intent, confidence: ranking[0].probability, accepted: ranking[0].probability >= this.threshold, ranking };
  }
}
