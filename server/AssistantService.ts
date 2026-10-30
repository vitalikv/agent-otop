import type { ChatAnswer, ChatRequest, DialogState } from '../shared/chat.js';
import { TextNormalizer } from './TextNormalizer.js';
import { ParamExtractor } from './ParamExtractor.js';
import { IntentRules } from './IntentRules.js';
import { DialogManager } from './DialogManager.js';
import { KnowledgeBase } from './KnowledgeBase.js';
import type { IntentPredictor } from './IntentClassifier.js';
import type { LlmResponder, LlmTrace } from './LlmResponder.js';

// Not offered as clarification buttons: they describe the request itself rather than a heating topic.
const NOT_CHOICES = new Set(['scope.off_topic', 'integrity.fabrication', 'dialog.continue']);
// Boundaries of the assistant: only the explanation is shown, without the catalogue's decision data and basis.
const BOUNDARIES = new Set([...NOT_CHOICES, 'scope.external', 'service.cost', 'service.booking', 'app.help']);

export class AssistantService {
  private readonly normalizer = new TextNormalizer();
  private readonly extractor = new ParamExtractor();
  private readonly intents = new IntentRules();
  private readonly dialog: DialogManager;

  constructor(private readonly knowledge: KnowledgeBase, private readonly classifier?: IntentPredictor, private readonly llm?: LlmResponder) {
    this.dialog = new DialogManager(knowledge);
    for (const intent of classifier?.classes ?? []) {
      if (!knowledge.intent(intent)) throw new Error(`Для класса сети нет объяснения: ${intent}`);
      if (intent.startsWith('safety.') && !this.intents.safetyIntents.includes(intent)) throw new Error(`Для класса сети нет шаблона опасности: ${intent}`);
    }
  }

  async reply(request: ChatRequest): Promise<ChatAnswer> {
    return (await this.replyWithTrace(request)).answer;
  }

  // With a language model configured it answers whatever the verified rules do not handle; otherwise the network or the fallback does.
  async replyWithTrace(request: ChatRequest): Promise<{ answer: ChatAnswer; route: 'rules' | 'network' | 'llm' | 'fallback'; trace?: LlmTrace }> {
    const ruled = this.byRules(request);
    if (ruled) return { answer: ruled, route: 'rules' };
    if (this.llm) return { ...await this.llm.answer(request), route: 'llm' };
    return { answer: this.answer(request), route: this.classifier ? 'network' : 'fallback' };
  }

  answer(request: ChatRequest): ChatAnswer {
    const ruled = this.byRules(request);
    if (ruled) return ruled;
    const raw = request.messages.at(-1)!.content;
    const text = this.normalizer.normalize(raw);
    const state = request.state;
    const extracted = this.extractor.extract(text, state);
    if (!this.classifier) return { content: 'Сейчас поддерживается расчёт проектного расхода теплоносителя для воды. Укажите нагрузку участка, теплоноситель и температуры подачи/обратки или охлаждение. Подбор насоса, фактический и минимальный расход оборудования, диагностика и другие темы пока не подключены.', sources: [], choices: ['Рассчитать расход теплоносителя'], clarification: false, state };
    const prediction = this.classifier.classify(raw);
    if (prediction.accepted) return this.byIntent(prediction.intent, text, state, extracted);
    const choices = prediction.ranking.filter(item => !NOT_CHOICES.has(item.intent)).slice(0, 3).map(item => this.knowledge.intent(item.intent)!.title);
    return { content: 'Не уверен, что правильно понял вопрос. Выберите подходящую тему или переформулируйте вопрос подробнее.', sources: [], choices, clarification: true, state };
  }

  // Verified rules come first: danger, a pressed topic button, then the stateful flow dialog.
  private byRules(request: ChatRequest): ChatAnswer | undefined {
    const raw = request.messages.at(-1)!.content;
    const text = this.normalizer.normalize(raw);
    const safety = this.intents.safety(text);
    if (safety) return this.template(safety, request.state);
    const chosen = this.knowledge.intentByTitle(raw.trim());
    const reset = this.intents.isReset(text);
    const state = reset ? undefined : request.state;
    const extracted = this.extractor.extract(text, state);
    if (chosen) return this.byIntent(chosen.id, text, state, extracted);
    if (reset || this.intents.isFlow(text, extracted.parameters, state)) return this.dialog.answer(state, extracted.parameters, extracted.issue);
    return undefined;
  }

  private byIntent(intent: string, text: string, state: DialogState | undefined, extracted: ReturnType<ParamExtractor['extract']>): ChatAnswer {
    const safety = this.intents.safetyTemplate(intent, text);
    if (safety) return this.template(safety, state);
    if (intent === 'hydraulics.flow' && !this.intents.isFlowExcluded(text)) return this.dialog.answer(state, extracted.parameters, extracted.issue);
    const explanation = this.knowledge.intent(intent)!;
    const sentence = (value: string) => value.replace(/\.$/, '');
    const required = explanation.required_data_for_concrete_decision;
    const content = (BOUNDARIES.has(intent) ? [explanation.explanation] : [
      `Тема: ${sentence(explanation.title.toLowerCase())}.`,
      explanation.explanation,
      required === 'Нет' ? '' : `Данные для конкретного решения: ${sentence(required)}.`,
      `Опора и границы: ${sentence(explanation.boundary)}.`,
    ]).concat('Если тема определена неверно, переформулируйте вопрос.').filter(Boolean).join('\n\n');
    return { content, sources: explanation.source_ids.map(id => this.knowledge.source(id)), choices: [], clarification: false, state };
  }

  private template(id: string, state: DialogState | undefined): ChatAnswer {
    const reference = this.knowledge.reference(id);
    return { content: reference.answer, sources: reference.source_ids.map(source => this.knowledge.source(source)), choices: [], clarification: false, state };
  }
}
