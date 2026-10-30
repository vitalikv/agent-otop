import { TextNormalizer } from './TextNormalizer.js';

export interface FeaturizerConfig {
  version: 1;
  buckets: number;
  char_ngrams: [number, number];
  word_bigrams: boolean;
}

// FNV-1a over UTF-16 code units. Training data is exported with this class, so Python never re-implements hashing.
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export class IntentFeaturizer {
  private readonly normalizer = new TextNormalizer();

  constructor(readonly config: FeaturizerConfig) {
    const [min, max] = config.char_ngrams ?? [];
    if (config.version !== 1 || !Number.isInteger(config.buckets) || config.buckets < 2 || config.buckets > 2 ** 24
      || !Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > 8 || typeof config.word_bigrams !== 'boolean') {
      throw new Error('Неизвестные параметры признаков нейросети.');
    }
  }

  tokens(text: string): string[] {
    return this.normalizer.normalize(text).replace(/\d/g, '0').match(/[\p{L}\d]+(?:[./][\p{L}\d]+)*/gu) ?? [];
  }

  /** Sorted distinct bucket ids of words, word bigrams and character n-grams of padded words. */
  features(text: string): number[] {
    const words = this.tokens(text);
    const [min, max] = this.config.char_ngrams;
    const keys = new Set<string>();
    words.forEach((word, index) => {
      keys.add(`w:${word}`);
      if (this.config.word_bigrams && index > 0) keys.add(`b:${words[index - 1]} ${word}`);
      const padded = `<${word}>`;
      for (let n = min; n <= max; n++) for (let i = 0; i + n <= padded.length; i++) keys.add(`c:${padded.slice(i, i + n)}`);
    });
    return [...new Set([...keys].map(key => hash(key) % this.config.buckets))].sort((a, b) => a - b);
  }
}
