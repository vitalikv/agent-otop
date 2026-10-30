import { TextNormalizer } from './TextNormalizer.js';
import type { KnowledgeBase } from './KnowledgeBase.js';

// Light Russian suffix stripping: enough to join inflected forms in a 52-section corpus without a full Snowball stemmer.
const ENDINGS = ['иями', 'ями', 'ами', 'ией', 'ием', 'иях', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ться', 'тся', 'ает', 'яет', 'ует', 'ают', 'яют', 'уют', 'ешь', 'ете', 'ишь', 'ите',
  'ть', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ый', 'ий', 'ой', 'ей', 'ую', 'юю', 'ом', 'ем', 'ах', 'ях', 'ов', 'ев', 'ам', 'ям', 'ия', 'ья', 'ию', 'ью', 'ии',
  'а', 'я', 'о', 'е', 'ы', 'и', 'у', 'ю', 'ь', 'й'].sort((a, b) => b.length - a.length);
const STOP = new Set(['и', 'в', 'во', 'на', 'с', 'со', 'по', 'для', 'не', 'что', 'как', 'это', 'а', 'или', 'при', 'от', 'до', 'из', 'к', 'о', 'об', 'же', 'ли', 'бы', 'то', 'у', 'за',
  'мне', 'я', 'мы', 'вы', 'он', 'она', 'они', 'ну', 'еще', 'уже', 'если', 'но', 'так', 'чтобы', 'ведь', 'там', 'тут', 'его', 'ее', 'их', 'мой', 'моя', 'мои', 'какой', 'какая', 'какие']);
const K1 = 1.2;
const B = 0.75;

export interface SearchHit { id: string; score: number; }

export class KnowledgeSearch {
  private readonly normalizer = new TextNormalizer();
  private readonly terms: { id: string; aliases: string[][] }[];
  private readonly documents: { id: string; counts: Map<string, number>; length: number }[];
  private readonly frequency = new Map<string, number>();
  private readonly averageLength: number;

  constructor(knowledge: KnowledgeBase) {
    this.terms = knowledge.terms.map(term => ({ id: term.id, aliases: term.aliases.map(alias => this.words(alias)).filter(words => words.length) }));
    // The chapter and, twice, the heading name the topic of the whole section.
    this.documents = knowledge.passages.map(passage => {
      const tokens = [...this.tokens(passage.chapter), ...this.tokens(passage.heading), ...this.tokens(passage.heading), ...this.tokens(passage.text)];
      const counts = new Map<string, number>();
      for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
      for (const token of counts.keys()) this.frequency.set(token, (this.frequency.get(token) ?? 0) + 1);
      return { id: passage.id, counts, length: tokens.length };
    });
    this.averageLength = this.documents.reduce((sum, document) => sum + document.length, 0) / Math.max(1, this.documents.length);
  }

  stem(word: string): string {
    if (!/^[а-я]+$/.test(word)) return word;
    const ending = ENDINGS.find(item => word.length - item.length >= 3 && word.endsWith(item));
    return ending ? word.slice(0, -ending.length) : word;
  }

  private words(text: string): string[] {
    return (this.normalizer.normalize(text).match(/[\p{L}\d]+(?:[./x-][\p{L}\d]+)*/gu) ?? []).filter(word => !STOP.has(word)).map(word => this.stem(word));
  }

  /** Stems plus a synonym token for every dictionary term whose alias occurs in the text. */
  tokens(text: string): string[] {
    const words = this.words(text);
    const tokens = [...words];
    for (const term of this.terms) {
      const found = term.aliases.some(alias => words.some((_, start) => alias.every((word, i) => words[start + i] === word)));
      if (found) tokens.push(`term:${term.id}`);
    }
    return tokens;
  }

  search(query: string, limit = 4): SearchHit[] {
    const tokens = [...new Set(this.tokens(query))];
    const total = this.documents.length;
    return this.documents.map(document => {
      let score = 0;
      for (const token of tokens) {
        const count = document.counts.get(token);
        if (!count) continue;
        const frequency = this.frequency.get(token)!;
        const idf = Math.log(1 + (total - frequency + 0.5) / (frequency + 0.5));
        score += idf * count * (K1 + 1) / (count + K1 * (1 - B + B * document.length / this.averageLength));
      }
      return { id: document.id, score };
    }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
