import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AnswerSource } from '../shared/chat.js';

interface ParameterDefinition {
  type: 'number' | 'enum' | 'boolean' | 'string';
  minimum?: number;
  exclusive_minimum?: number;
  values?: unknown[];
}
export interface FlowDefinition {
  id: string;
  parameters: Record<string, ParameterDefinition>;
  common_validation: { delta_consistency_absolute_tolerance_k: number };
  methods: Record<string, {
    required: string[];
    forbidden_parameters: string[];
    requires_values: Record<string, unknown>;
    result_status: string;
    assumptions: string[];
  }>;
  clarifications: Record<string, string>;
  scope: string;
  explanation: string;
}
interface SourceRecord { file: string; heading: string; text: string; }
interface Reference { id: string; answer: string; source_ids: string[]; }
export interface IntentExplanation {
  id: string;
  title: string;
  explanation: string;
  required_data_for_concrete_decision: string;
  boundary: string;
  source_ids: string[];
}
interface Bundle {
  schema_version: number;
  provenance: { inputs: { file: string; sha256_lf: string }[] };
  chunks: (SourceRecord & { id: string; sha256_lf: string })[];
  supporting_sources: Record<string, SourceRecord>;
  intent_explanations: { records: IntentExplanation[] };
  calculators: FlowDefinition[];
  reference_answers: Reference[];
}

export class KnowledgeBase {
  private constructor(readonly flow: FlowDefinition, private readonly sources: Map<string, SourceRecord>, private readonly references: Reference[], private readonly intents: Map<string, IntentExplanation>) {}

  static async load(root: string): Promise<KnowledgeBase> {
    try {
      const read = async (file: string) => {
        const path = resolve(root, file);
        const local = relative(root, path);
        if (local.startsWith('..') || isAbsolute(local)) throw new Error('Недопустимый путь данных.');
        return (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
      };
      const bundle: Bundle = JSON.parse(await read('data/generated/knowledge.json'));
      if (bundle.schema_version !== 1 || !bundle.provenance.inputs.length || !bundle.chunks.length) throw new Error('Неизвестный формат базы.');
      for (const input of bundle.provenance.inputs) {
        const hash = createHash('sha256').update(await read(input.file)).digest('hex');
        if (hash !== input.sha256_lf) throw new Error(`Данные устарели: ${input.file}`);
      }
      const flow = bundle.calculators.find(item => item.id === 'hydraulics.flow');
      if (!flow || !isDeepStrictEqual(flow, JSON.parse(await read('data/definitions/hydraulics.flow.json')))) throw new Error('Контракт расхода повреждён.');
      const references = JSON.parse(await read('docs/reference-answers.json')).records;
      if (!isDeepStrictEqual(bundle.reference_answers, references)) throw new Error('Эталоны повреждены.');
      const sources = new Map<string, SourceRecord>();
      for (const chunk of bundle.chunks) {
        if (createHash('sha256').update(chunk.text).digest('hex') !== chunk.sha256_lf || !(await read(chunk.file)).includes(chunk.text)) throw new Error(`Повреждён раздел: ${chunk.id}`);
        sources.set(chunk.id, chunk);
      }
      for (const [id, source] of Object.entries(bundle.supporting_sources)) {
        if (!(await read(source.file)).includes(source.text)) throw new Error(`Повреждён источник: ${id}`);
        sources.set(id, source);
      }
      for (const id of ['g05.flow', 'safety.gas', 'safety.co', 'safety.electric', 'safety.hot', 'safety.protection']) {
        if (!sources.has(id)) throw new Error(`Нет источника: ${id}`);
      }
      const intents = new Map<string, IntentExplanation>();
      for (const record of bundle.intent_explanations?.records ?? []) {
        const fields = [record.id, record.title, record.explanation, record.required_data_for_concrete_decision, record.boundary];
        if (!fields.every(field => typeof field === 'string' && field.trim()) || intents.has(record.id) || [...intents.values()].some(item => item.title === record.title)) throw new Error(`Неверное объяснение намерения: ${record.id}`);
        if (!Array.isArray(record.source_ids) || !record.source_ids.length || record.source_ids.some(id => !sources.has(id))) throw new Error(`Нет источника объяснения: ${record.id}`);
        intents.set(record.id, record);
      }
      if (!intents.has('hydraulics.flow')) throw new Error('Нет объяснений намерений.');
      return new KnowledgeBase(flow, sources, references, intents);
    } catch (error) {
      throw new Error(`Не удалось загрузить базу. Выполните npm run data:prepare и npm run data:check-generated. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  source(id: string): AnswerSource {
    const source = this.sources.get(id);
    if (!source) throw new Error(`Неизвестный источник: ${id}`);
    return { id, title: `${id.startsWith('g05.') ? 'Глава 05 · ' : ''}${source.heading}`, href: `/api/sources/${encodeURIComponent(id)}` };
  }

  sourceText(id: string): string | undefined {
    const source = this.sources.get(id);
    return source ? `${source.file}\n\n${source.text}` : undefined;
  }

  intent(id: string): IntentExplanation | undefined {
    return this.intents.get(id);
  }

  // Clarification buttons send the intent title back as the user's message.
  intentByTitle(title: string): IntentExplanation | undefined {
    return [...this.intents.values()].find(item => item.title === title);
  }

  reference(id: string): Reference {
    const reference = this.references.find(item => item.id === id);
    if (!reference) throw new Error(`Нет шаблона: ${id}`);
    return reference;
  }
}
