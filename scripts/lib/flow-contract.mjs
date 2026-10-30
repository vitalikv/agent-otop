// Offline checks for the stage-3 data contract. No text parsing or chat service.
import assert from 'node:assert/strict';
import {validateDevelopmentCases} from './development-cases.mjs';

const present = value => value !== undefined && value !== null;

export function validateDefinition(definition) {
  assert.equal(definition.schema_version, 1);
  assert.equal(definition.id, 'hydraulics.flow');
  assert.equal(definition.status, 'source_aligned_draft_not_professionally_reviewed');
  assert.deepEqual(definition.source_ids, ['g05.flow']);
  assert(definition.explanation.trim());
  assert(definition.scope.trim());
  const parameters = definition.parameters;
  for (const [name, parameter] of Object.entries(parameters)) {
    assert(['number', 'enum', 'string', 'boolean'].includes(parameter.type), name);
    assert(parameter.description.trim(), name);
    assert(!Object.hasOwn(parameter, 'default'), `${name}: implicit default`);
    if (parameter.type === 'number') assert(parameter.unit, name);
    if (parameter.type === 'enum') assert(parameter.values.length > 0, name);
    if (parameter.accepted_units) {
      assert.equal(parameter.accepted_units[parameter.unit], 1, name);
      for (const factor of Object.values(parameter.accepted_units)) assert(factor > 0 && Number.isFinite(factor), name);
    }
  }
  assert.deepEqual(parameters.method.values, Object.keys(definition.methods));
  assert.deepEqual(definition.common_validation.temperature_alternatives, [['water_delta_k'], ['supply_c', 'return_c']]);
  assert.equal(definition.common_validation.unknown_fields, 'reject');
  assert(definition.common_validation.delta_consistency_absolute_tolerance_k > 0);
  for (const [name, method] of Object.entries(definition.methods)) {
    assert(method.uses_temperature_alternatives, name);
    assert(method.formula && method.result_status && method.assumptions.length > 0, name);
    assert(Object.keys(method.outputs).length > 0, name);
    for (const field of [...method.required, ...method.forbidden_parameters, ...Object.keys(method.requires_values)]) {
      assert(Object.hasOwn(parameters, field), `${name}: unknown parameter ${field}`);
    }
    for (const field of method.required) assert(!method.forbidden_parameters.includes(field), name);
  }
  assert.equal(definition.methods.water_approximation.constants.water_coefficient.value, 0.86);
  assert.equal(definition.methods.water_approximation.requires_values.coolant, 'water');
  assert.equal(definition.methods.delta_ratio.requires_values.unchanged_load_and_properties, true);
  assert.equal(new Set(definition.reference_answer_ids).size, definition.reference_answer_ids.length);
  for (const term of definition.terms) assert(term.canonical && term.aliases.length && term.note);
}

export function assessInput(definition, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {status: 'invalid', issues: ['input']};
  const invalid = new Set();
  const missing = new Set();
  for (const [field, value] of Object.entries(input)) {
    const parameter = definition.parameters[field];
    if (!Object.hasOwn(definition.parameters, field)) { invalid.add(field); continue; }
    if (!present(value)) continue;
    const validType = parameter.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : parameter.type === 'enum' ? parameter.values.includes(value)
      : parameter.type === 'string' ? typeof value === 'string' && value.trim().length > 0
      : typeof value === 'boolean';
    if (!validType || (parameter.minimum !== undefined && value < parameter.minimum)
      || (parameter.exclusive_minimum !== undefined && value <= parameter.exclusive_minimum)) invalid.add(field);
  }
  if (!present(input.method)) missing.add('method');
  const method = Object.hasOwn(definition.methods, input.method) ? definition.methods[input.method] : undefined;
  if (method) {
    for (const field of method.required) if (!present(input[field])) missing.add(field);
    for (const field of method.forbidden_parameters) if (present(input[field])) invalid.add(field);
    for (const [field, value] of Object.entries(method.requires_values)) {
      if (present(input[field]) && !invalid.has(field) && input[field] !== value) missing.add(field);
    }
    const supply = present(input.supply_c);
    const back = present(input.return_c);
    if (supply !== back || (!supply && !present(input.water_delta_k))) missing.add('temperature');
    if (supply && back && !invalid.has('supply_c') && !invalid.has('return_c')) {
      const delta = input.supply_c - input.return_c;
      if (delta <= 0 || (present(input.water_delta_k) && !invalid.has('water_delta_k')
        && Math.abs(delta - input.water_delta_k) > definition.common_validation.delta_consistency_absolute_tolerance_k)) {
        missing.add('temperature_conflict');
      }
    }
  }
  if (invalid.size) return {status: 'invalid', issues: [...invalid]};
  if (missing.size) return {status: 'clarify', issues: [...missing]};
  return {status: 'ready', issues: []};
}

// Independent arithmetic oracle for structured development cases, never eval(formula).
export function fixtureValues(input) {
  const delta = input.water_delta_k ?? (input.supply_c - input.return_c);
  let values;
  if (input.method === 'delta_ratio') values = {volume_ratio: input.previous_delta_k / delta};
  else if (input.method === 'water_approximation') {
    const volume = 0.86 * input.load_kw / delta;
    values = {volume_m3_h: volume, volume_l_h: volume * 1000};
  } else {
    const mass = input.load_kw * 1000 / input.specific_heat_j_kg_k / delta;
    const volume = mass / input.density_kg_m3 * 3600;
    values = {mass_kg_s: mass, volume_m3_h: volume, volume_l_h: volume * 1000};
  }
  assert(Object.values(values).every(Number.isFinite), 'Non-finite calculation result');
  return values;
}

export function validateCases(definition, fixtures, references) {
  validateDevelopmentCases(definition, fixtures, references, assessInput, fixtureValues, {flow: 'volume_l_h', flow_ratio: 'volume_ratio'});
}
