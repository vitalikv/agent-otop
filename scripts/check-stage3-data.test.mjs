import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {prepareFullKnowledge, formulaValue, validateFormulaCatalog} from './lib/full-knowledge.mjs';
import {sha256} from './lib/knowledge-data.mjs';
import * as expansion from './lib/expansion-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const definition = read('data/definitions/pipe.expansion.json');
const fixtures = read('data/fixtures/pipe.expansion.json');
const references = read('docs/reference-answers.json');

test('expansion distinguishes an unknown coefficient from a known symbolic multiplier', () => {
  expansion.validateDefinition(definition);
  expansion.validateCases(definition, fixtures, references);
  const base = {method: 'linear_expansion', length_m: 10, temperature_change_k: 50, alpha_mm_m_k: 0.15, alpha_source: 'Explicit synthetic coefficient'};
  for (const value of [NaN, Infinity, -Infinity, '0.15', true, []]) assert.equal(expansion.assessInput(definition, {...base, alpha_mm_m_k: value}).status, 'invalid');
  assert.equal(expansion.assessInput(definition, {...base, alpha_source: ' '}).status, 'invalid');
  for (const value of [null, [], '10']) assert.equal(expansion.assessInput(definition, value).status, 'invalid');
  assert.equal(expansion.assessInput(definition, {...base, method: 'toString'}).status, 'invalid');
  assert.equal(expansion.assessInput(definition, {...base, floor_height_m: 6}).status, 'invalid');
  assert.equal(expansion.assessInput(definition, {...base, initial_c: 20, final_c: 70, temperature_change_k: 50.0000001}).status, 'ready');
  assert.equal(expansion.assessInput(definition, {...base, initial_c: 20, final_c: 70, temperature_change_k: 49}).status, 'clarify');
  assert.equal(expansion.fixtureValues({...base, length_m: 0}).expansion_mm, 0);
});

test('linear expansion preserves sign and explicit units rather than choosing a material coefficient', () => {
  const alpha = 0.00015 * definition.parameters.alpha_mm_m_k.accepted_units['1/K'];
  const length = 10000 * definition.parameters.length_m.accepted_units.mm;
  assert.equal(alpha, 0.15);
  const base = {method: 'linear_expansion', length_m: length, alpha_mm_m_k: alpha};
  assert.equal(expansion.fixtureValues({...base, initial_c: 20, final_c: 70}).expansion_mm, 75);
  assert.equal(expansion.fixtureValues({...base, initial_c: 70, final_c: 20}).expansion_mm, -75);
  assert.equal(definition.methods.linear_expansion.formula, 'expansion_mm = alpha_mm_m_k * length_m * temperature_change_k');
  assert.equal(definition.methods.coefficient_multiplier.outputs.expansion_coefficient_multiplier, 'm*K');
  assert.throws(() => expansion.fixtureValues({...base, length_m: Number.MAX_VALUE, temperature_change_k: Number.MAX_VALUE}), /Non-finite/);
});

test('complete data reconstructs all eight source chapters byte-for-byte after LF normalization', () => {
  const bundle = prepareFullKnowledge(root);
  assert.equal(bundle.chapters.length, 8);
  assert.equal(bundle.chunks.length, 52);
  for (const chapter of bundle.chapters) {
    const chunks = bundle.chunks.filter(chunk => chunk.file === chapter.file);
    const source = fs.readFileSync(path.join(root, chapter.file), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(chunks.map(chunk => chunk.text).join(''), source, chapter.file);
    assert.equal(sha256(source), chapter.sha256_lf);
    for (const chunk of chunks) {
      assert.equal(sha256(chunk.text), chunk.sha256_lf);
      assert(chunk.number_statuses.length && chunk.note && chunk.href, chunk.id);
    }
  }
  assert(bundle.chunks.filter(chunk => chunk.file.includes('/07-')).every(chunk => chunk.number_statuses.includes('educational_example')));
  assert.equal(bundle.chunks.find(chunk => chunk.heading === 'Отличия от текущих планов редактора').kind, 'historical_context');
  assert.deepEqual(bundle, prepareFullKnowledge(root));
  assert.equal(bundle.professional_reviewed, false);
  assert.equal(bundle.independent_test_set, false);
});

test('all rule codes, failure actions, intent explanations and reference links are resolved', () => {
  const data = prepareFullKnowledge(root);
  assert.equal(data.engineering_rules.rules.length, 17);
  assert.equal(data.engineering_rules.unknown_evidence, 'unknown_is_not_passed');
  assert.equal(data.intent_explanations.records.length, 46);
  assert.equal(data.intent_explanations.training_classes_approved, false);
  assert.equal(data.reference_answers.length, 160);
  assert.equal(data.terminology.records.length, 35);
  assert.equal(data.calculators.length, 7);
  assert.equal(data.supplementary_formulas.formulas.length, 5);
  const ids = new Set([...data.chunks.map(chunk => chunk.id), ...Object.keys(data.supporting_sources)]);
  for (const explanation of data.intent_explanations.records) assert(explanation.source_ids.every(id => ids.has(id)));
  for (const reference of data.reference_answers) assert(reference.source_ids.every(id => ids.has(id)));
  const check = data.terminology.records.find(record => record.id === 'check_valve');
  const setting = data.terminology.records.find(record => record.id === 'return_setting_valve');
  assert(check.aliases.every(alias => !setting.aliases.includes(alias)));
  assert(data.terminology.ambiguous_terms.some(term => term.alias === 'перепад'));
  assert.equal(data.terminology.catalog_origin.original_file_available, false);
  assert.equal(data.supporting_sources['project.catalog-vocabulary'].kind, 'local_mention_not_original_catalog');
  assert.equal(data.terminology.records.find(record => record.id === 'union_candidate').normalization, 'candidate_requires_clarification');
});

test('supplementary friction formulas retain regime and coefficient applicability', () => {
  const data = prepareFullKnowledge(root);
  validateFormulaCatalog(data.supplementary_formulas, new Set(data.chunks.map(chunk => chunk.id)));
  assert.equal(formulaValue('hydraulics.reynolds', {density_kg_m3: 1000, velocity_m_s: 0.5, inner_m: 0.02, viscosity_pa_s: 0.001}), 10000);
  assert.equal(formulaValue('hydraulics.laminar_friction', {reynolds: 1000}), 0.064);
  const friction = data.supplementary_formulas.formulas.find(record => record.id === 'hydraulics.darcy_loss');
  assert.equal(formulaValue(friction.id, {...friction.development_example.inputs, velocity_m_s: 1}), 15000);
  assert.equal(formulaValue('hydraulics.local_zeta_loss', {zeta_sum: 5, density_kg_m3: 1000, velocity_m_s: 0.5}), 625);
  assert.equal(data.supplementary_formulas.formulas.find(record => record.id === 'hydraulics.laminar_friction').inputs.regime.values[0], 'confirmed_laminar');
  assert(friction.required.includes('lambda_source'));
  assert.throws(() => formulaValue('unknown', {}), /Unknown/);
});

test('full preparation fails when sections, rules, intent coverage or term references are incomplete', t => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-otop-stage3-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
    assert(path.basename(temporaryRoot).startsWith('agent-otop-stage3-'));
    fs.rmSync(temporaryRoot, {recursive: true, force: true});
  });
  for (const directory of ['docs', 'data/definitions', 'data/fixtures']) fs.cpSync(path.join(root, directory), path.join(temporaryRoot, directory), {recursive: true});
  assert.deepEqual(prepareFullKnowledge(temporaryRoot), prepareFullKnowledge(root));
  const cases = [
    ['knowledge-sections', value => value.sections.pop(), /section inventory/],
    ['engineering-rules', value => { value.rules[0].on_failure = 'Passed despite unknown evidence'; }, /Rules must preserve/],
    ['intent-explanations', value => value.records.pop(), /Intent catalog coverage/],
    ['terminology', value => { value.records[0].source_ids = ['missing']; }, /radiator/],
    ['formula-catalog', value => { value.formulas[0].development_example.expected = 0; }, /hydraulics.reynolds/]
  ];
  for (const [name, mutate, error] of cases) {
    const file = `data/definitions/${name}.json`;
    const value = read(file);
    mutate(value);
    fs.writeFileSync(path.join(temporaryRoot, file), JSON.stringify(value));
    assert.throws(() => prepareFullKnowledge(temporaryRoot), error, name);
    fs.copyFileSync(path.join(root, file), path.join(temporaryRoot, file));
  }
});
