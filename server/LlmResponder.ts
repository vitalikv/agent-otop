import type { ChatAnswer, ChatRequest } from '../shared/chat.js';
import { ExpressionCalculator } from './ExpressionCalculator.js';
import { KnowledgeSearch } from './KnowledgeSearch.js';
import type { KnowledgeBase } from './KnowledgeBase.js';
import type { LlmBackend, LlmMessage, LlmTimings } from './LlmClient.js';

const INSTRUCTIONS = `Ты — помощник по отоплению частного дома в приложении «Отопление». Отвечай по-русски, коротко и понятно владельцу дома без инженерной подготовки.

Правила:
1. Опирайся только на пронумерованные фрагменты базы ниже. Если нужного в них нет, прямо скажи, что в базе этого нет, и подскажи, какие данные или документ нужны.
2. Не выдумывай модели, артикулы, паспортные значения, нормы, давления испытаний, цены и коды ошибок. Паспортные данные изделия берутся только из его документа.
3. Если для конкретного ответа не хватает данных пользователя, задай один-два уточняющих вопроса. Не спрашивай то, что уже известно из диалога. Общий принцип можно объяснить и без этих данных.
4. Приводи числа из фрагментов вместе с их оговорками: ориентир, учебный пример, требование паспорта.
5. Любую арифметику выполняй инструментом calculate, в уме не считай. В ответе покажи формулу и результат с единицами.
6. Не давай инструкций по работам с газом, дымоходом, электрикой под напряжением и по отключению или обходу защит. Такие работы выполняет специалист.
7. После утверждений из базы ставь ссылку на фрагмент в квадратных скобках, например [2].
8. На вопросы не об отоплении и не о приложении вежливо откажись.`;
const TOOLS = [{
  type: 'function',
  function: {
    name: 'calculate',
    description: 'Вычисляет арифметическое выражение: + - * / ^, скобки, sqrt(), pi. Пример: 0.86*8/(60-40).',
    parameters: { type: 'object', properties: { expression: { type: 'string', description: 'Выражение только из чисел и операций' } }, required: ['expression'] },
  },
}];
const MAX_TOOL_ROUNDS = 4;
const SELECTION = `Ты подбираешь разделы инженерной базы по отоплению, нужные для ответа на вопрос владельца дома. Ниже оглавление: номер, глава и раздел.
Верни номера от одного до четырёх самых полезных разделов, начиная с главного. Если вопрос не об отоплении, верни пустой список.`;

export interface LlmTrace {
  selected: string[];
  matched: string[];
  retrieved: string[];
  calculations: { expression: string; result: number | string }[];
  timings: LlmTimings[];
  rounds: number;
}

export class LlmResponder {
  private readonly search: KnowledgeSearch;
  private readonly calculator = new ExpressionCalculator();

  private readonly contents: string;

  constructor(private readonly knowledge: KnowledgeBase, private readonly backend: LlmBackend) {
    this.search = new KnowledgeSearch(knowledge);
    this.contents = knowledge.passages.map((passage, i) => `${i + 1}. ${passage.chapter} → ${passage.heading}`).join('\n');
  }

  // The model picks sections from the table of contents by meaning; word search adds its best match for exact designations.
  private async retrieve(query: string): Promise<Pick<LlmTrace, 'selected' | 'matched' | 'retrieved' | 'timings'>> {
    const schema = { type: 'object', properties: { sections: { type: 'array', items: { type: 'integer', minimum: 1, maximum: this.knowledge.passages.length }, maxItems: 4 } }, required: ['sections'] };
    const completion = await this.backend.complete([{ role: 'system', content: `${SELECTION}\n\n${this.contents}` }, { role: 'user', content: query }], [], { schema, maxTokens: 60 });
    let numbers: number[] = [];
    try {
      numbers = JSON.parse(completion.message.content ?? '').sections;
    } catch {
      numbers = (completion.message.content?.match(/\d+/g) ?? []).map(Number);
    }
    const selected = [...new Set(numbers.filter(n => Number.isInteger(n)).map(n => this.knowledge.passages[n - 1]?.id).filter((id): id is string => !!id))].slice(0, 4);
    const matched = this.search.search(query, 2).map(hit => hit.id);
    const retrieved = [...new Set([...selected, ...matched.slice(0, selected.length ? 1 : 2)])];
    return { selected, matched, retrieved, timings: completion.timings ? [completion.timings] : [] };
  }

  async answer(request: ChatRequest): Promise<{ answer: ChatAnswer; trace: LlmTrace }> {
    const users = request.messages.filter(message => message.role === 'user');
    const question = users.at(-1)!.content;
    // A short follow-up ("а если 16 мм?") is searched together with the previous question.
    const query = question.length < 60 && users.length > 1 ? `${users.at(-2)!.content}\n${question}` : question;
    const { selected, matched, retrieved, timings } = await this.retrieve(query);
    const fragments = retrieved.map((id, i) => `[${i + 1}] ${this.knowledge.source(id).title}\n${this.knowledge.sourceText(id)!.replace(/^[^\n]*\n\n/, '')}`);
    const messages: LlmMessage[] = [
      { role: 'system', content: `${INSTRUCTIONS}\n\nФрагменты базы:\n\n${fragments.length ? fragments.join('\n\n') : 'Подходящих фрагментов не найдено.'}` },
      ...request.messages.slice(-9).map(message => ({ role: message.role, content: message.content }) as LlmMessage),
    ];
    const trace: LlmTrace = { selected, matched, retrieved, calculations: [], timings, rounds: 1 };
    let content = '';
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const completion = await this.backend.complete(messages, round < MAX_TOOL_ROUNDS ? TOOLS : []);
      trace.rounds++;
      if (completion.timings) trace.timings.push(completion.timings);
      const calls = completion.message.tool_calls ?? [];
      if (!calls.length) { content = completion.message.content ?? ''; break; }
      messages.push({ role: 'assistant', content: completion.message.content, tool_calls: calls });
      for (const call of calls) {
        let result: number | string;
        try {
          if (call.function.name !== 'calculate') throw new Error('Неизвестный инструмент.');
          result = this.calculator.evaluate(String(JSON.parse(call.function.arguments || '{}').expression ?? ''));
        } catch (error) {
          result = `Ошибка: ${error instanceof Error ? error.message : String(error)}`;
        }
        trace.calculations.push({ expression: call.function.arguments, result });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ result }) });
      }
    }
    content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (!content) content = 'Не удалось получить ответ. Переформулируйте вопрос.';
    // Citations are renumbered in order of first use so that they match the order of the returned sources.
    const cited: string[] = [];
    content = content.replace(/\[(\d+)\]/g, (_marker, number: string) => {
      const id = retrieved[Number(number) - 1];
      if (!id) return '';
      if (!cited.includes(id)) cited.push(id);
      return `[${cited.indexOf(id) + 1}]`;
    }).replace(/ +([.,;:?!])/g, '$1');
    const answer: ChatAnswer = {
      content,
      sources: cited.map(id => this.knowledge.source(id)),
      choices: [],
      clarification: /\?\s*$/.test(content),
      state: request.state,
    };
    return { answer, trace };
  }
}
