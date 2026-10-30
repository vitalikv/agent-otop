import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {CALCULATOR_IDS, prepareKnowledge, sha256} from './lib/knowledge-data.mjs';
import {assessInput, fixtureValues, validateCases, validateDefinition} from './lib/flow-contract.mjs';
import * as geometry from './lib/geometry-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const definition = read('data/definitions/hydraulics.flow.json');
const fixtures = read('data/fixtures/hydraulics.flow.json');
const references = read('docs/reference-answers.json');
const water = fixtures.cases.find(item => item.id === 'water-8kw').input;
const fluid = fixtures.cases.find(item => item.id === 'synthetic-mixture-si').input;
const geometricDefinitions = Object.fromEntries(['pipe.size', 'hydraulics.velocity', 'hydraulics.diameter'].map(id => [id, read(`data/definitions/${id}.json`)]));

test('geometric contracts and 36 development cases agree with six reference answers', () => {
  for (const [id, contract] of Object.entries(geometricDefinitions)) {
    geometry.validateDefinition(contract);
    geometry.validateCases(contract, read(`data/fixtures/${id}.json`), references);
  }
});

test('diameter and velocity are inverse operations after explicit unit conversion', () => {
  const velocity = geometricDefinitions['hydraulics.velocity'];
  const diameter = geometricDefinitions['hydraulics.diameter'];
  for (const unit of ['l/h', 'm3/h', 'l/min', 'm3/s']) {
    assert.equal(velocity.parameters.flow_l_h.accepted_units[unit], diameter.parameters.flow_l_h.accepted_units[unit]);
  }
  const fromM3PerHour = 0.4 * diameter.parameters.flow_l_h.accepted_units['m3/h'];
  const fromMetres = 0.012 * velocity.parameters.pipe_inner_mm.accepted_units.m;
  assert.equal(fromMetres, 12);
  for (const flow of [1, 100, fromM3PerHour, 1000]) {
    for (const bore of [12, 14.4, 16, 21.2]) {
      const speed = geometry.fixtureValues({method: 'absolute', flow_l_h: flow, pipe_inner_mm: bore}).velocity_m_s;
      const inverse = geometry.fixtureValues({method: 'by_velocity', flow_l_h: flow, velocity_m_s: speed}).pipe_inner_mm;
      assert(Math.abs(inverse - bore) < 1e-10);
    }
  }
});

test('dimension correction preserves flow and independently checks the velocity ratio', () => {
  const reference = references.records.find(item => item.id === 'SYN-128');
  const before = geometry.fixtureValues({method: 'absolute', ...reference.dialog_fixture.before});
  const after = geometry.fixtureValues({method: 'absolute', ...reference.dialog_fixture.after});
  const ratio = after.velocity_m_s / before.velocity_m_s;
  assert.equal(ratio, reference.numeric_expectations.find(item => item.metric === 'velocity_ratio').value);
  assert.equal(geometry.fixtureValues({method: 'diameter_ratio', previous_inner_mm: before.pipe_inner_mm, pipe_inner_mm: after.pipe_inner_mm}).velocity_ratio, ratio);
});

test('geometry validation handles missing, malformed and conflicting dimensions without changing inputs', () => {
  const contract = geometricDefinitions['hydraulics.velocity'];
  const base = {method: 'absolute', flow_l_h: 100, pipe_inner_mm: 12};
  for (const value of [NaN, Infinity, -Infinity, '12', true, {}, []]) {
    assert.equal(geometry.assessInput(contract, {...base, pipe_inner_mm: value}).status, 'invalid');
  }
  for (const input of [null, [], '12']) assert.equal(geometry.assessInput(contract, input).status, 'invalid');
  assert.deepEqual(geometry.assessInput(contract, {flow_l_h: 100, pipe_inner_mm: 12}), {status: 'clarify', issues: ['method']});
  assert.equal(geometry.assessInput(contract, {...base, method: 'toString'}).status, 'invalid');
  assert.equal(geometry.assessInput(contract, {...base, pipe_outer_mm: 16, pipe_wall_mm: 2.0000001}).status, 'ready');
  const conflict = {...base, pipe_outer_mm: 16, pipe_wall_mm: 10};
  const original = structuredClone(conflict);
  assert.deepEqual(geometry.assessInput(contract, conflict), {status: 'clarify', issues: ['geometry_conflict']});
  assert.deepEqual(conflict, original);
  const ratio = {method: 'diameter_ratio', previous_inner_mm: 12, pipe_inner_mm: 16, unchanged_volume_flow: true};
  assert.equal(geometry.assessInput(contract, {...ratio, previous_inner_mm: 0}).status, 'invalid');
  assert.equal(geometry.assessInput(contract, {...ratio, flow_l_h: 0}).status, 'invalid');
  assert.equal(geometry.assessInput(contract, {...ratio, unchanged_volume_flow: 'true'}).status, 'invalid');
});

test('geometric formulas and speed guidance retain their units and applicability', () => {
  assert.equal(geometricDefinitions['pipe.size'].methods.outer_wall.formula, 'pipe_inner_mm = pipe_outer_mm - 2 * pipe_wall_mm');
  assert.equal(geometricDefinitions['hydraulics.velocity'].methods.absolute.formula, 'velocity_m_s = 4 * (flow_l_h / 1000 / 3600) / (PI * (pipe_inner_mm / 1000)^2)');
  assert.equal(geometricDefinitions['hydraulics.velocity'].methods.diameter_ratio.formula, 'velocity_ratio = (previous_inner_mm / pipe_inner_mm)^2');
  assert.equal(geometricDefinitions['hydraulics.diameter'].methods.by_velocity.formula, 'pipe_inner_mm = sqrt(4 * (flow_l_h / 1000 / 3600) / (PI * velocity_m_s)) * 1000');
  for (const [id, contract] of Object.entries(geometricDefinitions)) {
    for (const [name, parameter] of Object.entries(contract.parameters)) {
      if (parameter.type !== 'number') continue;
      if (id === 'hydraulics.velocity' && name === 'flow_l_h') assert.equal(parameter.minimum, 0);
      else assert.equal(parameter.exclusive_minimum, 0);
    }
    if (!contract.speed_guidance) continue;
    assert.equal(contract.speed_guidance.minimum, 0.2);
    assert.equal(contract.speed_guidance.maximum, 0.7);
    assert.equal(contract.speed_guidance.enforcement, 'not_a_validation_bound_or_default');
  }
  for (const speed of [0.05, 2]) {
    assert.equal(geometry.assessInput(geometricDefinitions['hydraulics.diameter'], {method: 'by_velocity', flow_l_h: 400, velocity_m_s: speed}).status, 'ready');
  }
  assert.throws(() => geometry.fixtureValues({method: 'absolute', flow_l_h: Number.MAX_VALUE, pipe_inner_mm: Number.MIN_VALUE}), /Non-finite/);
});

test('all bundles preserve whole sections, tables, caveats and source-specific number statuses', () => {
  const bundles = CALCULATOR_IDS.map(id => prepareKnowledge(root, id));
  assert.deepEqual(bundles, CALCULATOR_IDS.map(id => prepareKnowledge(root, id)));
  const chunks = new Map(bundles.flatMap(bundle => bundle.chunks.map(chunk => [chunk.id, chunk])));
  assert.equal(chunks.size, 6);
  const size = chunks.get('g05.size');
  assert(size.text.includes('Примеры только для указанных размеров стенки:'));
  assert(size.text.includes('| ПП 25×4,2 | 16,6 |'));
  assert(size.text.includes('Заужение фитинга учитывают по его характеристике отдельно.'));
  for (const [outer, wall, expected] of [[16, 2, 12], [20, 2, 16], [26, 3, 20], [20, 3.4, 13.2], [25, 4.2, 16.6], [32, 5.4, 21.2]]) {
    assert(Math.abs(geometry.fixtureValues({method: 'outer_wall', pipe_outer_mm: outer, pipe_wall_mm: wall}).pipe_inner_mm - expected) < 1e-10);
  }
  const speed = chunks.get('g05.speed');
  assert(speed.text.includes('| 12 | 204 | 2,36 | 4,73 |'));
  assert(speed.text.includes('Это **не предельная мощность трубы**.'));
  assert(speed.text.includes('Это не универсальный нормативный диапазон'));
  assert(speed.number_statuses.includes('project_guideline'));
  assert(!size.number_statuses.includes('rounded_water_approximation'));
  for (const bundle of bundles) {
    assert(bundle.provenance.inputs.some(input => input.file === `data/definitions/${bundle.calculators[0].id}.json`));
    for (const chunk of bundle.chunks) assert.equal(sha256(chunk.text), chunk.sha256_lf);
    for (const reference of bundle.reference_answers) {
      for (const source of reference.source_ids) assert(bundle.reference_sources[source]);
    }
  }
  const changedState = read('data/fixtures/hydraulics.velocity.json');
  changedState.cases.find(item => item.id === 'corrected-size-with-state').input.flow_l_h = 200;
  assert.throws(() => geometry.validateCases(geometricDefinitions['hydraulics.velocity'], changedState, references));
});

test('contract and synthetic cases agree with the seven reference answers', () => {
  validateDefinition(definition);
  validateCases(definition, fixtures, references);
});

test('published formulas, units and bounds agree with the arithmetic oracle', () => {
  assert.equal(definition.methods.water_approximation.formula, 'volume_m3_h = 0.86 * load_kw / delta_k');
  assert.equal(definition.methods.fluid_properties.formula, 'mass_kg_s = load_kw * 1000 / (specific_heat_j_kg_k * delta_k); volume_m3_h = 3600 * mass_kg_s / density_kg_m3');
  assert.equal(definition.methods.delta_ratio.formula, 'volume_ratio = previous_delta_k / delta_k');
  assert.equal(definition.parameters.load_kw.minimum, 0);
  for (const field of ['water_delta_k', 'previous_delta_k', 'specific_heat_j_kg_k', 'density_kg_m3']) {
    assert.equal(definition.parameters[field].exclusive_minimum, 0);
  }
  const fromWatts = 8000 * definition.parameters.load_kw.accepted_units.W;
  assert.equal(fixtureValues({...water, load_kw: fromWatts}).volume_l_h, 344);
  const exact = fixtureValues({...fluid, coolant: 'water', load_kw: 8, water_delta_k: 20, specific_heat_j_kg_k: 4180, density_kg_m3: 1000});
  assert(Math.abs(exact.volume_l_h - 344.4976076555024) < 1e-9);
  assert.notEqual(exact.volume_l_h, fixtureValues(water).volume_l_h, 'Rounded coefficient must stay distinct from SI calculation');
});

test('non-finite and malformed values are rejected without coercion', () => {
  for (const value of [NaN, Infinity, -Infinity, '8', true, {}, []]) {
    assert.equal(assessInput(definition, {...water, load_kw: value}).status, 'invalid');
  }
  for (const input of [null, [], '8']) assert.equal(assessInput(definition, input).status, 'invalid');
  assert.equal(assessInput(definition, {...water, method: 'toString'}).status, 'invalid');
  const inherited = JSON.parse('{"method":"water_approximation","load_kw":8,"coolant":"water","water_delta_k":20,"__proto__":5}');
  assert.equal(assessInput(definition, inherited).status, 'invalid');
});

test('fluid properties require positive values and explicit provenance', () => {
  for (const field of ['specific_heat_j_kg_k', 'density_kg_m3']) {
    for (const value of [0, -1]) assert.equal(assessInput(definition, {...fluid, [field]: value}).status, 'invalid');
  }
  for (const field of ['properties_source', 'properties_composition', 'properties_temperature_c']) {
    const input = {...fluid};
    delete input[field];
    assert.deepEqual(assessInput(definition, input), {status: 'clarify', issues: [field]});
  }
  assert.equal(assessInput(definition, {...fluid, properties_source: ' '}).status, 'invalid');
  assert.equal(assessInput(definition, {...fluid, properties_temperature_c: '40'}).status, 'invalid');
});

test('ratios use explicit conditions and no inferred load or fluid properties', () => {
  const ratio = fixtures.cases.find(item => item.id === 'delta-halved').input;
  assert.equal(assessInput(definition, {...ratio, previous_delta_k: 0}).status, 'invalid');
  assert.equal(assessInput(definition, {...ratio, unchanged_load_and_properties: 'true'}).status, 'invalid');
  assert.equal(assessInput(definition, {...ratio, load_kw: 8}).status, 'invalid');
  assert.equal(fixtureValues({...ratio, water_delta_k: 40}).volume_ratio, 0.5);
});

test('temperature consistency has a numerical tolerance and never reorders temperatures', () => {
  assert.equal(assessInput(definition, {...water, water_delta_k: 20.0000001}).status, 'ready');
  assert.equal(assessInput(definition, {...water, water_delta_k: 20.01}).status, 'clarify');
  const input = {...water, supply_c: 40, return_c: 60, water_delta_k: 20};
  const before = structuredClone(input);
  assert.equal(assessInput(definition, input).status, 'clarify');
  assert.deepEqual(input, before);
});

test('fixture validation detects incorrect results and fabricated dialog context', () => {
  const badResult = structuredClone(fixtures);
  badResult.cases[0].expected.values.volume_l_h = 400;
  assert.throws(() => validateCases(definition, badResult, references));
  const badState = structuredClone(fixtures);
  badState.cases.find(item => item.id === 'water-with-state').input.load_kw = 9;
  assert.throws(() => validateCases(definition, badState, references));
});

test('preparation is deterministic, keeps full source section and includes provenance', () => {
  const bundle = prepareKnowledge(root);
  assert.deepEqual(bundle, prepareKnowledge(root));
  const chunk = bundle.chunks[0];
  assert.equal(chunk.sha256_lf, sha256(chunk.text));
  assert(chunk.text.includes('При 1 кВт и охлаждении 10 К получается около 86 л/ч.'));
  assert(chunk.text.includes('для гликоля — свойства заданного состава, а не водяной коэффициент 0,86.'));
  assert(chunk.text.includes('а не по\nувеличенной паспортной мощности радиатора.'));
  assert.equal(bundle.provenance.snapshot_files.length, 10);
  assert.equal(bundle.professional_reviewed, false);
  assert.equal(bundle.independent_test_set, false);
  for (const record of bundle.reference_answers) {
    for (const id of record.source_ids) assert(bundle.reference_sources[id], `${record.id}/${id}`);
  }
  assert(!JSON.stringify(bundle).includes(root), 'Bundle must not depend on an absolute workspace path');
  assert.equal(sha256('a\r\nb'), sha256('a\nb'));
});

test('preparation refuses changed source text, changed section hashes and removed source files', t => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-otop-data-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
    assert(path.basename(temporaryRoot).startsWith('agent-otop-data-'));
    fs.rmSync(temporaryRoot, {recursive: true, force: true});
  });
  fs.cpSync(path.join(root, 'docs'), path.join(temporaryRoot, 'docs'), {recursive: true});
  fs.cpSync(path.join(root, 'data/definitions'), path.join(temporaryRoot, 'data/definitions'), {recursive: true});
  fs.cpSync(path.join(root, 'data/fixtures'), path.join(temporaryRoot, 'data/fixtures'), {recursive: true});
  assert.deepEqual(prepareKnowledge(temporaryRoot), prepareKnowledge(root));
  const sourcePath = path.join(temporaryRoot, 'docs/knowledge/installation-guide/05-pipe-sizing-and-hydraulics.md');
  const original = fs.readFileSync(sourcePath, 'utf8');
  fs.writeFileSync(sourcePath, original.replace('0,86', '0,90'));
  assert.throws(() => prepareKnowledge(temporaryRoot), /source changed/);
  fs.writeFileSync(sourcePath, original);
  const manifestPath = path.join(temporaryRoot, 'docs/reference-sources.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.sources['g05.flow'].section_sha256_lf = '0'.repeat(64);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => prepareKnowledge(temporaryRoot), /section changed/);
  fs.unlinkSync(sourcePath);
  assert.throws(() => prepareKnowledge(temporaryRoot), /inventory changed/);
});
