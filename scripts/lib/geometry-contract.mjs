// Offline validation and arithmetic for stage-3 circular-pipe data.
import assert from 'node:assert/strict';
import {validateDevelopmentCases} from './development-cases.mjs';

const present = value => value !== undefined && value !== null;
const contracts = {
  'pipe.size': {sources: ['g05.size'], methods: ['outer_wall']},
  'hydraulics.velocity': {sources: ['g05.size', 'g05.speed'], methods: ['absolute', 'diameter_ratio']},
  'hydraulics.diameter': {sources: ['g05.speed'], methods: ['by_velocity']}
};

export function validateDefinition(definition) {
  assert(Object.hasOwn(contracts, definition.id), 'Unknown geometric calculator');
  assert.equal(definition.schema_version, 1);
  assert.equal(definition.status, 'source_aligned_draft_not_professionally_reviewed');
  assert.deepEqual(definition.source_ids, contracts[definition.id].sources);
  assert.deepEqual(Object.keys(definition.methods), contracts[definition.id].methods);
  assert(definition.explanation.trim() && definition.scope.trim());
  assert.equal(definition.common_validation.unknown_fields, 'reject');
  for (const [name, parameter] of Object.entries(definition.parameters)) {
    assert(['number', 'enum', 'boolean'].includes(parameter.type), name);
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
    if (method.uses_geometry_alternatives) assert(definition.common_validation.geometry_alternatives.length > 0, name);
  }
  if (definition.speed_guidance) {
    assert.equal(definition.speed_guidance.number_status, 'project_guideline');
    assert.equal(definition.speed_guidance.enforcement, 'not_a_validation_bound_or_default');
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
      : parameter.type === 'enum' ? parameter.values.includes(value) : typeof value === 'boolean';
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
    if (method.uses_geometry_alternatives) {
      const outer = present(input.pipe_outer_mm);
      const wall = present(input.pipe_wall_mm);
      const inner = present(input.pipe_inner_mm);
      const alternatives = definition.common_validation.geometry_alternatives;
      if (outer !== wall || !alternatives.some(fields => fields.every(field => present(input[field])))) missing.add('pipe_dimensions');
      if (outer && wall && !invalid.has('pipe_outer_mm') && !invalid.has('pipe_wall_mm')) {
        const bore = input.pipe_outer_mm - 2 * input.pipe_wall_mm;
        if (bore <= 0 || (inner && !invalid.has('pipe_inner_mm')
          && Math.abs(bore - input.pipe_inner_mm) > definition.common_validation.geometry_consistency_absolute_tolerance_mm)) {
          missing.add('geometry_conflict');
        }
      }
    }
  }
  if (invalid.size) return {status: 'invalid', issues: [...invalid]};
  if (missing.size) return {status: 'clarify', issues: [...missing]};
  return {status: 'ready', issues: []};
}

// Formula strings in the definitions are documentation and never evaluated.
export function fixtureValues(input) {
  let values;
  if (input.method === 'by_velocity') {
    values = {pipe_inner_mm: Math.sqrt(4 * (input.flow_l_h / 1000 / 3600) / (Math.PI * input.velocity_m_s)) * 1000};
  } else {
    const bore = input.pipe_inner_mm ?? (input.pipe_outer_mm - 2 * input.pipe_wall_mm);
    values = {pipe_inner_mm: bore};
    if (input.method === 'absolute') values.velocity_m_s = (input.flow_l_h / 1000 / 3600) / (Math.PI * (bore / 1000 / 2) ** 2);
    else if (input.method === 'diameter_ratio') values.velocity_ratio = (input.previous_inner_mm / bore) ** 2;
    else assert.equal(input.method, 'outer_wall', 'Unknown geometric method');
  }
  assert(Object.values(values).every(Number.isFinite), 'Non-finite calculation result');
  return values;
}

export function validateCases(definition, fixtures, references) {
  validateDevelopmentCases(definition, fixtures, references, assessInput, fixtureValues, {
    inner_diameter: 'pipe_inner_mm', velocity: 'velocity_m_s', velocity_ratio: 'velocity_ratio'
  });
}
