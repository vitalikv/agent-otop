// Offline stage-3 checks for valve losses and pressure-to-head conversion.
import assert from 'node:assert/strict';
import {validateDevelopmentCases} from './development-cases.mjs';

const present = value => value !== undefined && value !== null;
const contracts = {
  'hydraulics.loss': {sources: ['g05.loss'], methods: ['valve_kv_water']},
  'hydraulics.head': {sources: ['g05.flow', 'g05.pump'], methods: ['water_approximation', 'fluid_density']}
};

export function validateDefinition(definition) {
  assert(Object.hasOwn(contracts, definition.id), 'Unknown pressure calculator');
  assert.equal(definition.schema_version, 1);
  assert.equal(definition.status, 'source_aligned_draft_not_professionally_reviewed');
  assert.deepEqual(definition.source_ids, contracts[definition.id].sources);
  assert.deepEqual(Object.keys(definition.methods), contracts[definition.id].methods);
  assert(definition.explanation.trim() && definition.scope.trim());
  assert.equal(definition.common_validation.unknown_fields, 'reject');
  for (const [name, parameter] of Object.entries(definition.parameters)) {
    assert(['number', 'enum', 'string'].includes(parameter.type), name);
    assert(parameter.description.trim(), name);
    assert(!Object.hasOwn(parameter, 'default'), `${name}: implicit default`);
    if (parameter.type === 'number') assert(parameter.unit, name);
    if (parameter.type === 'enum') assert(parameter.values.length > 0, name);
    if (parameter.accepted_units) {
      assert.equal(parameter.accepted_units[parameter.unit], 1, name);
      for (const factor of Object.values(parameter.accepted_units)) assert(Number.isFinite(factor) && factor > 0, name);
    }
  }
  assert.deepEqual(definition.parameters.method.values, Object.keys(definition.methods));
  for (const [name, method] of Object.entries(definition.methods)) {
    assert(method.formula && method.result_status && method.assumptions.length, name);
    assert(Object.keys(method.outputs).length > 0, name);
    for (const field of [...method.required, ...method.forbidden_parameters, ...Object.keys(method.requires_values)]) {
      assert(Object.hasOwn(definition.parameters, field), `${name}: unknown parameter ${field}`);
    }
    for (const field of method.required) assert(!method.forbidden_parameters.includes(field), name);
    for (const constant of Object.values(method.constants)) {
      assert(Number.isFinite(constant.value) && constant.value > 0 && constant.unit && constant.number_status, name);
    }
  }
  assert.equal(new Set(definition.reference_answer_ids).size, definition.reference_answer_ids.length);
  for (const term of definition.terms) assert(term.canonical && term.aliases.length && term.note);
}

export function assessInput(definition, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {status: 'invalid', issues: ['input']};
  const invalid = new Set();
  const missing = new Set();
  for (const [field, value] of Object.entries(input)) {
    if (!Object.hasOwn(definition.parameters, field)) { invalid.add(field); continue; }
    if (!present(value)) continue;
    const parameter = definition.parameters[field];
    const valid = parameter.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : parameter.type === 'enum' ? parameter.values.includes(value) : typeof value === 'string' && value.trim().length > 0;
    if (!valid || (parameter.minimum !== undefined && value < parameter.minimum)
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
  }
  if (invalid.size) return {status: 'invalid', issues: [...invalid]};
  if (missing.size) return {status: 'clarify', issues: [...missing]};
  return {status: 'ready', issues: []};
}

// Independent arithmetic for development cases; formula strings are never executed.
export function fixtureValues(input) {
  let values;
  if (input.method === 'valve_kv_water') {
    const bar = (input.flow_m3_h / input.kv_m3_h) ** 2;
    values = {pressure_bar: bar, pressure_kpa: bar * 100, pressure_pa: bar * 100000};
  } else {
    assert(['water_approximation', 'fluid_density'].includes(input.method), 'Unknown pressure method');
    const density = input.method === 'water_approximation' ? 1000 : input.density_kg_m3;
    values = {head_m: input.pressure_pa / density / 9.81};
  }
  assert(Object.values(values).every(Number.isFinite), 'Non-finite calculation result');
  return values;
}

export function validateCases(definition, fixtures, references) {
  validateDevelopmentCases(definition, fixtures, references, assessInput, fixtureValues, {
    pressure_loss: 'pressure_kpa', head: 'head_m'
  });
}
