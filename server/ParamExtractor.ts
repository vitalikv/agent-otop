import type { DialogState, FlowInput } from '../shared/chat.js';

const number = '(-?\\d+(?:\\.\\d+)?)';
const start = '(?<![\\p{L}\\d.])';

export class ParamExtractor {
  extract(text: string, state?: DialogState): { parameters: FlowInput; issue?: string } {
    const parameters: FlowInput = {};
    // Negated quantities, alternatives and catalogue powers cannot establish a design load.
    if (/(?:^|\s)не\s+-?\d|\d.*\sили\s.*\d/.test(text)) return { parameters, issue: 'Укажите одно подтверждённое значение каждого параметра, без отрицаний и альтернатив.' };
    const loads = [...text.matchAll(new RegExp(`${start}${number}\\s*(квт|вт)(?![\\p{L}])`, 'gu'))];
    if (new Set(loads.map(match => Number(match[1]) * (match[2] === 'вт' ? 0.001 : 1))).size > 1) return { parameters, issue: 'В сообщении несколько мощностей. Укажите переносимую расчётную нагрузку именно этого участка.' };
    const cataloguePower = /паспорт|номиналь|котел|котла/.test(text) || (/радиатор/.test(text) && !/нагрузк|переносим/.test(text));
    if (loads.length && !cataloguePower) parameters.load_kw = Number(loads[0][1]) * (loads[0][2] === 'вт' ? 0.001 : 1);

    const notWater = /не\s+(?:обычная\s+)?вода|без\s+воды/.test(text);
    const water = /(?:^|[^\p{L}])вод(?:а|ой|у|е|ы)(?![\p{L}])/u.test(text) && !notWater;
    const glycol = /гликол|антифриз|незамерзай/.test(text) && !/не\s+(?:антифриз|гликоль|незамерзайка)/.test(text);
    if (water && glycol) return { parameters, issue: 'Вода или гликолевая смесь? Укажите один теплоноситель для этого расчёта.' };
    if (glycol) parameters.coolant = 'glycol';
    else if (notWater) parameters.coolant = 'other';
    else if (water) parameters.coolant = 'water';

    const pairs = [...text.matchAll(new RegExp(`${start}${number}\\s*[/]\\s*${number}(?![\\d.])`, 'gu'))];
    if (pairs.length > 1 && !(pairs.length === 2 && /вместо.*(?:будет|возьмем|принять|сделать)/.test(text))) return { parameters, issue: 'Укажите одну пару температур подачи и обратки, например 60/40 °C.' };
    const pair = pairs.at(-1);
    if (pair) { parameters.supply_c = Number(pair[1]); parameters.return_c = Number(pair[2]); }
    const supplies = [...text.matchAll(new RegExp(`подач[а-я]*\\s*(?:[:=]|будет)?\\s*${number}`, 'gu'))];
    const returns = [...text.matchAll(new RegExp(`обрат[а-я]*\\s*(?:[:=]|будет)?\\s*${number}`, 'gu'))];
    for (const [matches, field] of [[supplies, 'supply_c'], [returns, 'return_c']] as const) {
      if (new Set(matches.map(match => Number(match[1]))).size > 1) return { parameters: {}, issue: 'Для одной температуры указаны разные значения. Укажите один подтверждённый режим подачи и обратки.' };
      if (matches.length) {
        const value = Number(matches[0][1]);
        if (parameters[field] !== undefined && parameters[field] !== value) return { parameters: {}, issue: 'Пара температур расходится с отдельно указанными значениями. Какой режим верен?' };
        parameters[field] = value;
      }
    }
    const delta = text.match(new RegExp(`(?:охлаждени[а-я]*|дельта\\s*t?|δt|δт|разност[а-я]*\\s+температур|перепад(?:\\s+температур)?)\\s*(?:[:=]|будет)?\\s*${number}\\s*(?:к|k|°\\s*[cс]|градус[а-я]*)?(?![\\p{L}\\d.])`, 'u'));
    if (delta && !/давлен|бар|паскал|кпа|мпа|напор.*радиатор/.test(text)) parameters.water_delta_k = Number(delta[1]);
    if (/ориентировоч|водяно[ей]\s+приближени|приближенн/.test(text) && !/не\s+(?:ориентировоч|приближенн)/.test(text)) parameters.method = 'water_approximation';
    const bare = text.match(new RegExp(`^${number}\\s*(?:[.!?])?$`));
    if (bare && state?.pending === 'load_kw') parameters.load_kw = Number(bare[1]);
    const temperatureReply = text.match(new RegExp(`^${number}\\s*(?:к|k|°\\s*[cс]|градус(?:ов|а)?)?\\s*[.!?]?$`, 'u'));
    if (temperatureReply && state?.pending === 'temperature') parameters.water_delta_k = Number(temperatureReply[1]);
    return { parameters };
  }
}
