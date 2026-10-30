import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {CALCULATOR_IDS, prepareKnowledge} from './lib/knowledge-data.mjs';
import {assessInput, fixtureValues, validateCases, validateDefinition} from './lib/pressure-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const references = read('docs/reference-answers.json');
const loss = read('data/definitions/hydraulics.loss.json');
const head = read('data/definitions/hydraulics.head.json');
const lossCases = read('data/fixtures/hydraulics.loss.json');
const headCases = read('data/fixtures/hydraulics.head.json');
const valveInput = lossCases.cases.find(item => item.id === 'kv-conditional-example').input;
const headInput = headCases.cases.find(item => item.id === 'head-conditional-example').input;
const fluidInput = headCases.cases.find(item => item.id === 'synthetic-mixture-density').input;
const close = (actual, expected) => assert(Math.abs(actual - expected) <= 1e-10 * Math.max(1, Math.abs(expected)));

test('pressure contracts and 34 cases retain clarification and conditional reference results', () => {
  for (const [definition, fixtures] of [[loss, lossCases], [head, headCases]]) {
    validateDefinition(definition);
    validateCases(definition, fixtures, references);
  }
});

test('Pa, kPa and bar represent the same pressure drop after explicit conversion', () => {
  const conversions = head.parameters.pressure_pa.accepted_units;
  assert.deepEqual(conversions, {Pa: 1, kPa: 1000, bar: 100000});
  for (const [value, unit] of [[15000, 'Pa'], [15, 'kPa'], [0.15, 'bar']]) {
    close(fixtureValues({...headInput, pressure_pa: value * conversions[unit]}).head_m, 1.529051987767584);
  }
  const units = loss.parameters.flow_m3_h.accepted_units;
  for (const [value, unit] of [[0.2, 'm3/h'], [200, 'l/h'], [200 / 60, 'l/min'], [0.2 / 3600, 'm3/s']]) {
    const values = fixtureValues({...valveInput, flow_m3_h: value * units[unit]});
    close(values.pressure_bar, 0.16);
    close(values.pressure_kpa, 16);
    close(values.pressure_pa, 16000);
    close(values.pressure_bar * conversions.bar, values.pressure_kpa * conversions.kPa);
  }
});

test('valve losses follow squared flow and inverse squared operating Kv', () => {
  const base = fixtureValues(valveInput).pressure_pa;
  for (const factor of [0.5, 2, 3]) {
    close(fixtureValues({...valveInput, flow_m3_h: valveInput.flow_m3_h * factor}).pressure_pa, base * factor ** 2);
    close(fixtureValues({...valveInput, kv_m3_h: valveInput.kv_m3_h * factor}).pressure_pa, base / factor ** 2);
  }
  assert.equal(assessInput(loss, {...valveInput, flow_m3_h: 0, kv_m3_h: 0}).status, 'invalid');
  assert.equal(assessInput(loss, {...valveInput, coolant: 'glycol'}).status, 'clarify');
  assert.equal(assessInput(loss, {...valveInput, kv_basis: 'fully_open_kvs'}).status, 'clarify');
  for (const field of ['zeta', 'equivalent_length_m', 'pipe_length_m', 'density_kg_m3']) {
    assert.equal(assessInput(loss, {...valveInput, [field]: 1}).status, 'invalid');
  }
});

test('head depends on the stated density and does not require heat capacity', () => {
  for (const pressure of [0, 15000, 100000]) {
    for (const density of [970, 1000, 1030]) {
      const input = {...fluidInput, pressure_pa: pressure, density_kg_m3: density};
      assert.equal(assessInput(head, input).status, 'ready');
      close(fixtureValues(input).head_m * density * 9.81, pressure);
    }
  }
  close(fixtureValues(fluidInput).head_m / fixtureValues(headInput).head_m, 1000 / 1030);
  for (const field of ['density_kg_m3', 'properties_source', 'properties_temperature_c', 'properties_composition']) {
    const input = {...fluidInput};
    delete input[field];
    assert.deepEqual(assessInput(head, input), {status: 'clarify', issues: [field]});
  }
  assert.equal(assessInput(head, {...fluidInput, specific_heat_j_kg_k: 3900}).status, 'invalid');
  assert.equal(assessInput(head, {...headInput, floor_height_m: 6}).status, 'invalid');
});

test('conditional numbers cannot be relabelled as answers to incomplete requests', () => {
  for (const [definition, fixtures] of [[loss, lossCases], [head, headCases]]) {
    const wrongAssumptions = structuredClone(fixtures);
    wrongAssumptions.cases.find(item => item.reference_view === 'conditional_example').reference_assumptions = ['Неизвестная среда считается водой'];
    assert.throws(() => validateCases(definition, wrongAssumptions, references), /assumptions differ/);
    const wrongView = structuredClone(fixtures);
    const example = wrongView.cases.find(item => item.reference_view === 'conditional_example');
    delete example.reference_view;
    delete example.reference_assumptions;
    assert.throws(() => validateCases(definition, wrongView, references));
    for (const view of ['first_response', 'conditional_example']) {
      const missingView = structuredClone(fixtures);
      missingView.cases = missingView.cases.filter(item => !item.reference_id || (item.reference_view ?? 'first_response') !== view);
      assert.throws(() => validateCases(definition, missingView, references), /both clarification and conditional/);
    }
  }
});

test('invalid numeric types, unknown methods and empty provenance are rejected without mutation', () => {
  for (const [definition, base, field] of [[loss, valveInput, 'flow_m3_h'], [loss, valveInput, 'kv_m3_h'], [head, fluidInput, 'density_kg_m3'], [head, headInput, 'pressure_pa']]) {
    for (const value of [NaN, Infinity, -Infinity, '1', true, {}, []]) {
      const input = {...base, [field]: value};
      assert.equal(assessInput(definition, input).status, 'invalid');
    }
    for (const input of [null, [], '1']) assert.equal(assessInput(definition, input).status, 'invalid');
    assert.equal(assessInput(definition, {...base, method: 'toString'}).status, 'invalid');
    const before = structuredClone(base);
    assessInput(definition, base);
    assert.deepEqual(base, before);
  }
  assert.equal(assessInput(head, {...fluidInput, properties_composition: ' '}).status, 'invalid');
  assert.throws(() => fixtureValues({...valveInput, flow_m3_h: Number.MAX_VALUE, kv_m3_h: Number.MIN_VALUE}), /Non-finite/);
});

test('pressure formulas, constants, units and numerical bounds agree with the source', () => {
  assert.equal(loss.methods.valve_kv_water.formula, 'pressure_bar = (flow_m3_h / kv_m3_h)^2; pressure_kpa = pressure_bar * 100; pressure_pa = pressure_bar * 100000');
  assert.equal(head.methods.water_approximation.formula, 'head_m = pressure_pa / (1000 * 9.81)');
  assert.equal(head.methods.fluid_density.formula, 'head_m = pressure_pa / (density_kg_m3 * 9.81)');
  assert.equal(loss.methods.valve_kv_water.constants.pa_per_bar.value, 100000);
  assert.equal(loss.methods.valve_kv_water.constants.kpa_per_bar.value, 100);
  assert.equal(loss.methods.valve_kv_water.requires_values.coolant, 'water');
  assert.equal(loss.methods.valve_kv_water.requires_values.kv_basis, 'operating_setting');
  assert.equal(head.methods.water_approximation.constants.density_kg_m3.value, 1000);
  assert.equal(head.methods.water_approximation.requires_values.coolant, 'water');
  for (const method of Object.values(head.methods)) assert.equal(method.constants.gravity_m_s2.value, 9.81);
  assert.equal(loss.parameters.flow_m3_h.minimum, 0);
  assert.equal(head.parameters.pressure_pa.minimum, 0);
  assert.equal(loss.parameters.kv_m3_h.exclusive_minimum, 0);
  assert.equal(head.parameters.density_kg_m3.exclusive_minimum, 0);
});

test('calculator bundles preserve source sections and all development cases', () => {
  const bundles = CALCULATOR_IDS.map(id => prepareKnowledge(root, id));
  assert.equal(bundles.length, 7);
  assert.equal(bundles.reduce((sum, bundle) => sum + bundle.development_cases.cases.length, 0), 112);
  assert.equal(new Set(bundles.flatMap(bundle => bundle.reference_answers.map(record => record.id))).size, 16);
  const lossChunk = bundles.find(bundle => bundle.calculators[0].id === 'hydraulics.loss').chunks[0];
  assert(lossChunk.text.includes('Используют Kv реальной настройки клапана'));
  assert(lossChunk.text.includes('по Kv, ζ и эквивалентной длине.'));
  assert(lossChunk.text.includes('В переходной области и при малых'));
  assert(lossChunk.number_statuses.includes('exact_unit_conversion'));
  const pumpChunk = bundles.find(bundle => bundle.calculators[0].id === 'hydraulics.head').chunks.find(chunk => chunk.id === 'g05.pump');
  assert(pumpChunk.text.includes('Высота второго этажа в замкнутой заполненной системе не добавляется'));
  assert(pumpChunk.text.includes('без двойного учёта.'));
  assert(pumpChunk.number_statuses.includes('approximate_gravity'));
});

test('pressure preparation rejects changed section hashes and source boundaries', t => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-otop-pressure-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
    assert(path.basename(temporaryRoot).startsWith('agent-otop-pressure-'));
    fs.rmSync(temporaryRoot, {recursive: true, force: true});
  });
  fs.cpSync(path.join(root, 'docs'), path.join(temporaryRoot, 'docs'), {recursive: true});
  fs.cpSync(path.join(root, 'data/definitions'), path.join(temporaryRoot, 'data/definitions'), {recursive: true});
  fs.cpSync(path.join(root, 'data/fixtures'), path.join(temporaryRoot, 'data/fixtures'), {recursive: true});
  const file = path.join(temporaryRoot, 'docs/reference-sources.json');
  const manifest = read('docs/reference-sources.json');
  const badLoss = structuredClone(manifest);
  badLoss.sources['g05.loss'].section_sha256_lf = '0'.repeat(64);
  fs.writeFileSync(file, JSON.stringify(badLoss));
  assert.throws(() => prepareKnowledge(temporaryRoot, 'hydraulics.loss'), /section changed/);
  const badPump = structuredClone(manifest);
  badPump.sources['g05.pump'].line_end--;
  fs.writeFileSync(file, JSON.stringify(badPump));
  assert.throws(() => prepareKnowledge(temporaryRoot, 'hydraulics.head'), /section end/);
});
