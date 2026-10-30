import type { FlowInput } from '../shared/chat.js';
import type { FlowDefinition } from './KnowledgeBase.js';

export class HeatingCalculator {
  constructor(private readonly definition: FlowDefinition) {}

  assess(input: FlowInput): { status: 'ready' | 'clarify' | 'invalid'; issues: string[] } {
    const invalid = new Set<string>();
    const missing = new Set<string>();
    const fields = input as Record<string, unknown>;
    const present = (key: string) => fields[key] !== undefined && fields[key] !== null;
    for (const [key, value] of Object.entries(fields)) {
      const spec = Object.hasOwn(this.definition.parameters, key) ? this.definition.parameters[key] : undefined;
      if (!spec) { invalid.add(key); continue; }
      if (!present(key)) continue;
      const valid = spec.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
        && (spec.minimum === undefined || value >= spec.minimum) && (spec.exclusive_minimum === undefined || value > spec.exclusive_minimum)
        : spec.type === 'enum' ? spec.values?.includes(value)
        : spec.type === 'string' ? typeof value === 'string' && !!value.trim() : typeof value === 'boolean';
      if (!valid) invalid.add(key);
    }
    if (!present('method')) missing.add('method');
    const method = input.method && Object.hasOwn(this.definition.methods, input.method) ? this.definition.methods[input.method] : undefined;
    if (method) {
      for (const key of method.required) if (!present(key)) missing.add(key);
      for (const key of method.forbidden_parameters) if (present(key)) invalid.add(key);
      for (const [key, value] of Object.entries(method.requires_values)) if (present(key) && !invalid.has(key) && fields[key] !== value) missing.add(key);
      if (present('supply_c') !== present('return_c') || (!present('supply_c') && !present('water_delta_k'))) missing.add('temperature');
      if (present('supply_c') && present('return_c') && !invalid.has('supply_c') && !invalid.has('return_c')) {
        const delta = input.supply_c! - input.return_c!;
        if (delta <= 0 || (present('water_delta_k') && !invalid.has('water_delta_k') && Math.abs(delta - input.water_delta_k!) > this.definition.common_validation.delta_consistency_absolute_tolerance_k)) missing.add('temperature_conflict');
      }
    }
    return invalid.size ? { status: 'invalid', issues: [...invalid] } : missing.size ? { status: 'clarify', issues: [...missing] } : { status: 'ready', issues: [] };
  }

  calculate(input: FlowInput): { status: string; values: Record<string, number> } {
    if (this.assess(input).status !== 'ready') throw new Error('Недостаточные или противоречивые параметры расчёта.');
    const delta = input.water_delta_k ?? (input.supply_c! - input.return_c!);
    let values: Record<string, number>;
    if (input.method === 'delta_ratio') values = { volume_ratio: input.previous_delta_k! / delta };
    else {
      const mass = input.method === 'fluid_properties' ? input.load_kw! * 1000 / input.specific_heat_j_kg_k! / delta : undefined;
      const volume = mass === undefined ? 0.86 * input.load_kw! / delta : mass / input.density_kg_m3! * 3600;
      values = { volume_m3_h: volume, volume_l_h: volume * 1000 };
      if (mass !== undefined) values.mass_kg_s = mass;
    }
    if (!Object.values(values).every(Number.isFinite)) throw new Error('Результат выходит за числовые пределы. Уточните исходные данные.');
    return { status: this.definition.methods[input.method!].result_status, values };
  }
}
