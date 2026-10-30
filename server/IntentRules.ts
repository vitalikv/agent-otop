import type { DialogState, FlowInput } from '../shared/chat.js';

// Verified primary-response templates; the same choice is used whether rules or the network detect the danger.
const SAFETY_TEMPLATES: Record<string, (text: string) => string> = {
  'safety.gas': () => 'SYN-151',
  'safety.co': text => /голов|тошн|плохо/.test(text) ? 'SYN-153' : 'SYN-152',
  'safety.electric': () => 'SYN-154',
  'safety.hot_leak': () => 'SYN-155',
  'safety.boiling': () => 'SYN-156',
  'safety.protection': text => /перегрев/.test(text) ? 'SYN-159' : 'SYN-157',
};

export class IntentRules {
  readonly safetyIntents = Object.keys(SAFETY_TEMPLATES);

  safetyIntent(text: string): string | undefined {
    if (/(?:запах|пахнет|воняет).*газ|газ.*(?:запах|пахнет|утечк)|травит.*газ/.test(text)) return 'safety.gas';
    if (/дым|угарн|датчик.*(?:co|со)(?:\s|$|[,.!?])/.test(text)) return 'safety.co';
    if (/искр|горел.*провод|провод.*горел/.test(text)) return 'safety.electric';
    if (/кипит|кипен|закип|парит/.test(text)) return 'safety.boiling';
    if (/горяч.*(?:утеч|теч|стру)|(?:утеч|теч|стру).*горяч/.test(text)) return 'safety.hot_leak';
    if (/(?:заглуш|отключ|обойти|обход).*(?:защит|предохран|перегрев)|(?:предохран|датчик перегрева).*(?:заглуш|отключ|обойти)/.test(text)) return 'safety.protection';
    return undefined;
  }

  safetyTemplate(intent: string, text: string): string | undefined {
    return SAFETY_TEMPLATES[intent]?.(text);
  }

  safety(text: string): string | undefined {
    const intent = this.safetyIntent(text);
    return intent && this.safetyTemplate(intent, text);
  }

  isReset(text: string): boolean {
    return /новый расчет|сброс(?:ить)?(?: параметры)?/.test(text);
  }

  // Questions about pumps, diameters, equipment flow or selection are not the design-flow calculator, whoever routes them.
  isFlowExcluded(text: string): boolean {
    return /насос|диаметр|скорост|минимальн.*расход|фактическ.*расход|расход.*газ|расход.*топлив/.test(text)
      || /(?:подбор|подбери|выбрать|выбор|настроить|починить|купить|цена|стоимость|установить).*(?:радиатор|котел|труб|клапан|фитинг)/.test(text);
  }

  isFlow(text: string, parameters: FlowInput, state?: DialogState): boolean {
    if (this.isFlowExcluded(text)) return false;
    if (/расход.*(?:вод|теплонос|отоплен|участ|контур|квт|вт)|(?:вод|теплонос).*расход|(?:рассчита|рассчитай|посчита|посчитай).*расход|расчет расхода/.test(text)) return true;
    if (!state) return /квт|вт/.test(text) && /60\/40|подач|обрат|охлажден|перепад|\d\s*\/\s*\d/.test(text);
    return Object.keys(parameters).length > 0 || /^(?:да|нет|не знаю|вода|смесь)[.!?]?$/.test(text);
  }
}
