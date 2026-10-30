import type { DialogState, FlowInput } from '../shared/chat.js';

export class IntentRules {
  safety(text: string): string | undefined {
    if (/(?:запах|пахнет|воняет).*газ|газ.*(?:запах|пахнет|утечк)|травит.*газ/.test(text)) return 'SYN-151';
    if (/дым|угарн|датчик.*(?:co|со)(?:\s|$|[,.!?])/.test(text)) return /голов|тошн|плохо/.test(text) ? 'SYN-153' : 'SYN-152';
    if (/искр|горел.*провод|провод.*горел/.test(text)) return 'SYN-154';
    if (/кипит|кипен|закип|парит/.test(text)) return 'SYN-156';
    if (/горяч.*(?:утеч|теч|стру)|(?:утеч|теч|стру).*горяч/.test(text)) return 'SYN-155';
    if (/(?:заглуш|отключ|обойти|обход).*(?:защит|предохран|перегрев)|(?:предохран|датчик перегрева).*(?:заглуш|отключ|обойти)/.test(text)) return /перегрев/.test(text) ? 'SYN-159' : 'SYN-157';
    return undefined;
  }

  isFlow(text: string, parameters: FlowInput, state?: DialogState): boolean {
    if (/насос|диаметр|скорост|минимальн.*расход|фактическ.*расход|расход.*газ|расход.*топлив/.test(text)) return false;
    if (/(?:подбор|подбери|выбрать|выбор|настроить|починить|купить|цена|стоимость|установить).*(?:радиатор|котел|труб|клапан|фитинг)/.test(text)) return false;
    if (/расход.*(?:вод|теплонос|отоплен|участ|контур|квт|вт)|(?:вод|теплонос).*расход|(?:рассчита|рассчитай|посчита|посчитай).*расход|расчет расхода/.test(text)) return true;
    if (!state) return /квт|вт/.test(text) && /60\/40|подач|обрат|охлажден|перепад|\d\s*\/\s*\d/.test(text);
    return Object.keys(parameters).length > 0 || /^(?:да|нет|не знаю|вода|смесь)[.!?]?$/.test(text);
  }
}
