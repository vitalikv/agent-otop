import assert from 'node:assert/strict';
import {assessInput as assessScalarInput} from './pressure-contract.mjs';
import {validateDevelopmentCases} from './development-cases.mjs';

const present = value => value !== undefined && value !== null;
export function validateDefinition(definition) {
  assert.equal(definition.schema_version, 1);
  assert.equal(definition.id, 'pipe.expansion');
  assert.equal(definition.status, 'source_aligned_draft_not_professionally_reviewed');
  assert.deepEqual(definition.source_ids, ['g06.expand']);
  assert.deepEqual(Object.keys(definition.methods), ['linear_expansion', 'coefficient_multiplier']);
  assert.deepEqual(definition.parameters.method.values, Object.keys(definition.methods));
  for (const [name, parameter] of Object.entries(definition.parameters)) {
    assert(['number', 'string', 'enum'].includes(parameter.type), name);
    assert(parameter.description && !Object.hasOwn(parameter, 'default'), name);
    if (parameter.type === 'number') assert(parameter.unit, name);
    for (const factor of Object.values(parameter.accepted_units ?? {})) assert(Number.isFinite(factor) && factor > 0, name);
  }
  assert.equal(definition.parameters.alpha_mm_m_k.unit, 'mm/(m*K)');
  assert.equal(definition.parameters.alpha_mm_m_k.accepted_units['1/K'], 1000);
  assert.equal(definition.common_validation.unknown_fields, 'reject');
  for (const method of Object.values(definition.methods)) {
    assert(method.formula && method.result_status && method.assumptions.length);
    for (const field of [...method.required, ...method.forbidden_parameters]) assert(Object.hasOwn(definition.parameters, field));
  }
}

export function assessInput(definition, input) {
  const result = assessScalarInput(definition, input);
  if (result.status === 'invalid' || !Object.hasOwn(definition.methods, input.method)) return result;
  const issues = new Set(result.issues);
  const initial = present(input.initial_c);
  const final = present(input.final_c);
  if (initial !== final || (!initial && !present(input.temperature_change_k))) issues.add('temperature');
  if (initial && final && present(input.temperature_change_k)
    && Math.abs(input.final_c - input.initial_c - input.temperature_change_k) > definition.common_validation.delta_consistency_absolute_tolerance_k) issues.add('temperature_conflict');
  return {status: issues.size ? 'clarify' : 'ready', issues: [...issues]};
}

export function fixtureValues(input) {
  assert(['linear_expansion', 'coefficient_multiplier'].includes(input.method), 'Unknown expansion method');
  const delta = input.temperature_change_k ?? (input.final_c - input.initial_c);
  const multiplier = input.length_m * delta;
  const values = input.method === 'coefficient_multiplier' ? {expansion_coefficient_multiplier: multiplier} : {expansion_mm: input.alpha_mm_m_k * multiplier};
  assert(Object.values(values).every(Number.isFinite), 'Non-finite calculation result');
  return values;
}

export function validateCases(definition, fixtures, references) {
  validateDevelopmentCases(definition, fixtures, references, assessInput, fixtureValues, {expansion_coefficient_multiplier: 'expansion_coefficient_multiplier'});
}
