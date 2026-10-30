import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { join } from 'node:path';
import { AppConfig } from '../server/AppConfig.js';
import { KnowledgeBase } from '../server/KnowledgeBase.js';
import { HeatingCalculator } from '../server/HeatingCalculator.js';
import { AssistantService } from '../server/AssistantService.js';
import { TextNormalizer } from '../server/TextNormalizer.js';
import { ParamExtractor } from '../server/ParamExtractor.js';
import type { DialogState, FlowInput } from '../shared/chat.js';

const root = new AppConfig().root;
const knowledge = await KnowledgeBase.load(root);
const calculator = new HeatingCalculator(knowledge.flow);
const fixtures = JSON.parse(await readFile(join(root, 'data/fixtures/hydraulics.flow.json'), 'utf8'));
for (const fixture of fixtures.cases) test(`structured: ${fixture.id}`, () => {
  const assessment = calculator.assess(fixture.input);
  assert.equal(assessment.status, fixture.expected.status);
  if (fixture.expected.issues) assert.deepEqual(assessment.issues.sort(), fixture.expected.issues.sort());
  if (fixture.expected.values) {
    const result = calculator.calculate(fixture.input);
    for (const [key, value] of Object.entries(fixture.expected.values)) {
      assert.ok(Math.abs(result.values[key] - Number(value)) <= 1e-9 * Math.max(1, Math.abs(Number(value))), key);
    }
  } else assert.throws(() => calculator.calculate(fixture.input));
});

const answer = (content: string, state?: DialogState) => new AssistantService(knowledge).answer({ messages: [{ role: 'user', content }], state });

test('complete dialog retains state through JSON and new service instances', () => {
  let response = answer('Посчитай расход для 5 кВт. Температуры пока не выбрал.');
  assert.equal(response.state?.parameters.load_kw, 5);
  assert.equal(response.state?.pending, 'coolant');
  response = answer('Обычная вода, не антифриз.', JSON.parse(JSON.stringify(response.state)));
  assert.equal(response.state?.parameters.coolant, 'water');
  assert.equal(response.state?.pending, 'method');
  response = answer('Ориентировочный расчёт для воды', response.state);
  assert.equal(response.state?.pending, 'temperature');
  response = answer('20', response.state);
  assert.equal(response.calculation?.values.volume_l_h, 215);
  assert.equal(response.clarification, false);
  assert.equal(response.sources[0].id, 'g05.flow');
  assert.match(response.content, /0,86/);
  assert.match(response.content, /Проектная потребность/);
  response = answer('А если 50/40?', response.state);
  assert.equal(response.calculation?.values.volume_l_h, 430);
  assert.equal(response.state?.parameters.water_delta_k, undefined);
  response = answer('Охлаждение 20 К', response.state);
  assert.equal(response.calculation?.values.volume_l_h, 215);
  assert.equal(response.state?.parameters.supply_c, undefined);
});

test('explicit method choice, conversion of W, decimal comma and regime replacement', () => {
  let response = answer('Ориентировочный расход воды для нагрузки 8000 Вт, 60/40');
  assert.equal(response.calculation?.values.volume_l_h, 344);
  response = answer('А если вместо 60/40 будет 50/40?', response.state);
  assert.equal(response.calculation?.values.volume_l_h, 688);
  response = answer('Нагрузка 8,5 kW', response.state);
  assert.equal(response.calculation?.values.volume_l_h, 731);
  response = answer('Новый расчёт расхода', response.state);
  assert.equal(response.state?.pending, 'load_kw');
  assert.deepEqual(response.state?.parameters, {});
});

test('missing state never supplies synthetic load or temperatures', () => {
  assert.equal(answer('Обычная вода, не антифриз.').calculation, undefined);
  assert.equal(answer('А если вместо 60/40 будет 50/40?').calculation, undefined);
  const response = answer('Ориентировочный расход воды, 60/40');
  assert.equal(response.state?.pending, 'load_kw');
  assert.equal(response.state?.parameters.load_kw, undefined);
});

test('conflicts and invalid numbers are clarified without swapping', () => {
  let response = answer('Ориентировочный расход воды: 6 кВт, подача 50, обратка 70');
  assert.equal(response.calculation, undefined);
  assert.equal(response.state?.parameters.supply_c, 50);
  assert.match(response.content, /Проверьте/);
  response = answer('60/40', response.state);
  assert.equal(response.calculation?.values.volume_l_h, 258);
  for (const text of ['Охлаждение 0 К', 'Охлаждение -10 К', '60/60', '60/40, перепад 10 К', 'Нагрузка -1 кВт']) {
    assert.equal(answer(text, response.state).calculation, undefined, text);
  }
});

test('coolant negatives, alternatives and nameplate power never imply confirmed water/load', () => {
  for (const text of ['не вода', 'антифриз', 'гликолевая смесь', 'вода или антифриз']) {
    const response = answer(`Ориентировочный расход: нагрузка 5 кВт, 60/40, ${text}`);
    assert.equal(response.calculation, undefined, text);
  }
  const response = answer('Ориентировочный расход воды: котёл 24 кВт, 60/40');
  assert.equal(response.state?.parameters.load_kw, undefined);
  assert.equal(response.state?.pending, 'load_kw');
});

test('zero load and very large finite input retain engineering boundaries', () => {
  const response = answer('Ориентировочный расход воды: нагрузка 0 кВт, 60/40');
  assert.equal(response.calculation?.values.volume_l_h, 0);
  assert.match(response.content, /не разрешает прекращать/);
  assert.throws(() => calculator.calculate({ method: 'water_approximation', coolant: 'water', load_kw: 1e308, water_delta_k: 1e-308 }));
});

test('unrelated question cannot trigger reuse of complete flow parameters', () => {
  const ready = answer('Ориентировочный расход воды: 8 кВт, 60/40');
  for (const text of ['Подбери насос', 'Какой диаметр трубы?', 'Как приготовить суп?', 'Минимальный расход котла?', 'Как настроить радиатор?', 'Подбери радиатор 5 кВт']) {
    const response = answer(text, ready.state);
    assert.equal(response.calculation, undefined);
    assert.deepEqual(response.state, ready.state);
  }
});

test('known safety templates precede flow and keep their verified sources', () => {
  const state = answer('Ориентировочный расход воды: 8 кВт, 60/40').state;
  for (const [text, id] of [
    ['Пахнет газом, рассчитай расход 8 кВт', 'SYN-151'],
    ['Сработал датчик угарного газа', 'SYN-152'],
    ['Дым и головная боль', 'SYN-153'],
    ['Насос искрит', 'SYN-154'],
    ['Бьёт струя горячей воды', 'SYN-155'],
    ['Котёл кипит', 'SYN-156'],
    ['Как отключить датчик перегрева?', 'SYN-159'],
  ]) {
    const response = answer(text, state);
    assert.equal(response.content, knowledge.reference(id).answer);
    assert.equal(response.calculation, undefined);
    assert.ok(response.sources.length);
  }
});

test('normalization and ambiguous quantities', () => {
  const normalizer = new TextNormalizer();
  const extractor = new ParamExtractor();
  assert.equal(normalizer.normalize('Ё 8,5kW 16х2'), 'е 8.5квт 16x2');
  for (const text of ['5 кВт или 8 кВт', '5 кВт, 8 кВт', 'не 5 кВт', '60/40 или 50/40']) assert.ok(extractor.extract(normalizer.normalize(text)).issue, text);
  const state: DialogState = { version: 1, intent: 'hydraulics.flow', parameters: {}, pending: 'temperature' };
  assert.deepEqual(extractor.extract('перепад давления 20 кпа', state).parameters, {});
  assert.deepEqual(extractor.extract('20 к', state).parameters, { water_delta_k: 20 });
  assert.ok(extractor.extract('подача 60, подача 50').issue);
  assert.ok(extractor.extract('60/40, подача 70').issue);
  assert.equal(calculator.assess({ method: 'toString' } as unknown as FlowInput).status, 'invalid');
});
