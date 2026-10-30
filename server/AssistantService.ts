import type { ChatAnswer, ChatRequest } from '../shared/chat.js';
import { TextNormalizer } from './TextNormalizer.js';
import { ParamExtractor } from './ParamExtractor.js';
import { IntentRules } from './IntentRules.js';
import { DialogManager } from './DialogManager.js';
import { KnowledgeBase } from './KnowledgeBase.js';

export class AssistantService {
  private readonly normalizer = new TextNormalizer();
  private readonly extractor = new ParamExtractor();
  private readonly intents = new IntentRules();
  private readonly dialog: DialogManager;
  constructor(private readonly knowledge: KnowledgeBase) { this.dialog = new DialogManager(knowledge); }

  answer(request: ChatRequest): ChatAnswer {
    const text = this.normalizer.normalize(request.messages.at(-1)!.content);
    const safety = this.intents.safety(text);
    if (safety) {
      const reference = this.knowledge.reference(safety);
      return { content: reference.answer, sources: reference.source_ids.map(id => this.knowledge.source(id)), choices: [], clarification: false, state: request.state };
    }
    const reset = this.intents.isReset(text);
    const state = reset ? undefined : request.state;
    const extracted = this.extractor.extract(text, state);
    if (reset || this.intents.isFlow(text, extracted.parameters, state)) return this.dialog.answer(state, extracted.parameters, extracted.issue);
    return { content: 'Сейчас поддерживается расчёт проектного расхода теплоносителя для воды. Укажите нагрузку участка, теплоноситель и температуры подачи/обратки или охлаждение. Подбор насоса, фактический и минимальный расход оборудования, диагностика и другие темы пока не подключены.', sources: [], choices: ['Рассчитать расход теплоносителя'], clarification: false, state };
  }
}
