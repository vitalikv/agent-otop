import type { ChatAnswer, DialogState, FlowInput, PendingField } from '../shared/chat.js';
import { HeatingCalculator } from './HeatingCalculator.js';
import { KnowledgeBase } from './KnowledgeBase.js';

const format = (number: number) => new Intl.NumberFormat('ru-RU', { maximumSignificantDigits: 6 }).format(number);

export class DialogManager {
  private readonly calculator: HeatingCalculator;
  constructor(private readonly knowledge: KnowledgeBase) { this.calculator = new HeatingCalculator(knowledge.flow); }

  answer(previous: DialogState | undefined, extracted: FlowInput, issue?: string): ChatAnswer {
    const parameters: FlowInput = { ...previous?.parameters, ...extracted };
    // A new complete regime replaces the previous representation; within one message both must agree.
    if (extracted.supply_c !== undefined || extracted.return_c !== undefined) {
      if (extracted.water_delta_k === undefined) delete parameters.water_delta_k;
    } else if (extracted.water_delta_k !== undefined) {
      delete parameters.supply_c;
      delete parameters.return_c;
    }
    const state: DialogState = { version: 1, intent: 'hydraulics.flow', parameters };
    const base: ChatAnswer = { content: '', sources: [this.knowledge.source('g05.flow')], choices: [], clarification: false, state };
    const ask = (pending: PendingField, content: string, choices: string[] = []): ChatAnswer => ({ ...base, content, choices, clarification: true, state: { ...state, pending } });
    if (issue) return ask(previous?.pending ?? 'load_kw', issue);
    if (parameters.load_kw !== undefined && parameters.load_kw < 0) return ask('load_kw', 'Нагрузка не может быть отрицательной. Укажите расчётную нагрузку участка в кВт (или явно в Вт).');
    if (parameters.water_delta_k !== undefined && parameters.water_delta_k <= 0) return ask('temperature', 'Охлаждение должно быть положительным. Укажите разность температур в К или подачу/обратку в °C.');
    if (parameters.load_kw === undefined) return ask('load_kw', `${this.knowledge.flow.clarifications.load_kw} Число без единицы на этом шаге принимается в кВт. Паспортная мощность котла или радиатора не заменяет нагрузку участка.`);
    if (!parameters.coolant) return ask('coolant', this.knowledge.flow.clarifications.coolant, ['Вода', 'Гликолевая смесь']);
    if (parameters.coolant !== 'water' || (parameters.method && parameters.method !== 'water_approximation')) {
      return { ...base, content: 'В этом срезе чата доступен только ориентировочный расчёт для подтверждённой воды. Коэффициент 0,86 нельзя применять к гликолю или неизвестной смеси. Для расчёта по свойствам нужны теплоёмкость и плотность, их источник, состав, концентрация и рабочая температура. Таблицы свойств и такой диалог пока не подключены.' };
    }
    if (!parameters.method) return ask('method', 'Использовать ориентировочный водяной расчёт с округлённым коэффициентом 0,86? Для окончательного расчёта нужны свойства воды при рабочей температуре.', ['Ориентировочный расчёт для воды']);
    const assessment = this.calculator.assess(parameters);
    if (assessment.issues.includes('temperature_conflict')) return ask('temperature', this.knowledge.flow.clarifications.temperature_conflict);
    if (assessment.issues.includes('temperature')) return ask('temperature', `${this.knowledge.flow.clarifications.temperature} Например, 60/40 °C. Число без единицы на этом шаге — охлаждение в К.`, ['60/40 °C', '50/40 °C']);
    if (assessment.status !== 'ready') return ask('temperature', 'Параметры противоречат выбранному расчёту. Начните новый расчёт сообщением «Новый расчёт расхода».');
    const delta = parameters.water_delta_k ?? (parameters.supply_c! - parameters.return_c!);
    const calculation = this.calculator.calculate(parameters);
    const regime = parameters.supply_c === undefined ? `охлаждение ${format(delta)} К` : `подача/обратка ${format(parameters.supply_c)}/${format(parameters.return_c!)} °C, охлаждение ${format(delta)} К`;
    const content = `Ориентировочный расход воды: ${format(calculation.values.volume_m3_h)} м³/ч (${format(calculation.values.volume_l_h)} л/ч).\n\nНагрузка участка: ${format(parameters.load_kw)} кВт; ${regime}.\nФормула: V ≈ 0,86 × Q / Δt = 0,86 × ${format(parameters.load_kw)} / ${format(delta)} м³/ч.\n\n${this.knowledge.flow.methods.water_approximation.assumptions.join('\n')}\n\n${this.knowledge.flow.scope}${parameters.load_kw === 0 ? '\nНулевая проектная потребность не разрешает прекращать обязательный расход источника.' : ''}\nМожно изменить нагрузку или температурный режим — сохранённые параметры будут использованы для пересчёта.`;
    return { ...base, content, calculation };
  }
}
