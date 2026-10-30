import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AppConfig } from '../server/AppConfig.js';
import { KnowledgeBase } from '../server/KnowledgeBase.js';
import { AssistantService } from '../server/AssistantService.js';
import { IntentClassifier, MODEL_PATH, type IntentPredictor } from '../server/IntentClassifier.js';
import type { DialogState } from '../shared/chat.js';

const root = new AppConfig().root;
const knowledge = await KnowledgeBase.load(root);
const classes = ['hydraulics.flow', 'equipment.role', 'radiator.select', 'radiator.place', 'heat_loss.calculate', 'scope.off_topic', 'safety.electric', 'safety.co'];
// Deterministic stand-in for the trained network: routing is tested independently of the weights.
const network = (ranking: [string, number][], threshold = 0.9): IntentPredictor & { calls: number } => ({
  classes,
  calls: 0,
  classify() {
    this.calls++;
    const items = ranking.map(([intent, probability]) => ({ intent, probability }));
    return { intent: items[0].intent, confidence: items[0].probability, accepted: items[0].probability >= threshold, ranking: items };
  },
});
const ask = (classifier: IntentPredictor, content: string, state?: DialogState) => new AssistantService(knowledge, classifier).answer({ messages: [{ role: 'user', content }], state });
const flowState: DialogState = { version: 1, intent: 'hydraulics.flow', parameters: { load_kw: 5 }, pending: 'coolant' };

test('verified rules for danger and the flow dialog precede the network', () => {
  const classifier = network([['scope.off_topic', 0.99]]);
  assert.equal(ask(classifier, 'В котельной пахнет газом').content, knowledge.reference('SYN-151').answer);
  assert.equal(ask(classifier, 'Посчитай расход для 5 кВт').state?.pending, 'coolant');
  assert.equal(ask(classifier, 'Вода', flowState).state?.pending, 'method');
  assert.equal(classifier.calls, 0);
});

test('a confident network answer uses the prepared explanation, its sources and keeps the dialog state', () => {
  const explanation = knowledge.intent('equipment.role')!;
  const response = ask(network([['equipment.role', 0.97], ['radiator.select', 0.02]]), 'Зачем нужен расширительный бак?', flowState);
  assert.match(response.content, new RegExp(`^Тема: ${explanation.title.toLowerCase()}\\.`));
  assert.ok(response.content.includes(explanation.explanation));
  assert.ok(response.content.includes(`Данные для конкретного решения: ${explanation.required_data_for_concrete_decision}.`));
  assert.deepEqual(response.sources.map(source => source.id), explanation.source_ids);
  assert.equal(response.clarification, false);
  assert.deepEqual(response.state, flowState);
  const boundary = ask(network([['scope.off_topic', 0.99]]), 'Посоветуй сериал').content;
  assert.ok(boundary.startsWith(knowledge.intent('scope.off_topic')!.explanation));
  assert.doesNotMatch(boundary, /Тема:|Данные для конкретного решения|Опора и границы/);
});

test('network danger classes use the same verified templates as the rules', () => {
  assert.equal(ask(network([['safety.electric', 0.95]]), 'Ударило током от радиатора').content, knowledge.reference('SYN-154').answer);
  assert.equal(ask(network([['safety.co', 0.95]]), 'После включения котла всех тошнит').content, knowledge.reference('SYN-153').answer);
  assert.deepEqual(ask(network([['safety.co', 0.95]]), 'Пищит детектор в котельной').sources.map(source => source.id), knowledge.reference('SYN-152').source_ids);
});

test('the network starts the flow dialog only where the flow rules allow it', () => {
  const flow = network([['hydraulics.flow', 0.95]]);
  assert.equal(ask(flow, 'Сколько теплоносителя прокачивать через контур на 4 кВт?').state?.pending, 'coolant');
  const excluded = ask(flow, 'Какой минимальный расход у котла?');
  assert.ok(excluded.content.includes(knowledge.intent('hydraulics.flow')!.explanation));
  assert.equal(excluded.state, undefined);
});

test('uncertain network answers ask with topic buttons, and a pressed button selects that topic', () => {
  const uncertain = network([['radiator.select', 0.5], ['scope.off_topic', 0.3], ['radiator.place', 0.1], ['heat_loss.calculate', 0.06], ['equipment.role', 0.04]]);
  const response = ask(uncertain, 'Что лучше для зала?', flowState);
  assert.equal(response.clarification, true);
  assert.deepEqual(response.choices, ['radiator.select', 'radiator.place', 'heat_loss.calculate'].map(id => knowledge.intent(id)!.title));
  assert.deepEqual(response.state, flowState);
  const never = network([['scope.off_topic', 1]]);
  const chosen = ask(never, response.choices[1]);
  assert.ok(chosen.content.includes(knowledge.intent('radiator.place')!.explanation));
  assert.equal(ask(never, knowledge.intent('hydraulics.flow')!.title).state?.pending, 'load_kw');
  assert.equal(never.calls, 0);
});

test('a network class without an explanation or template is rejected at start', () => {
  assert.throws(() => new AssistantService(knowledge, { classes: ['unknown.intent'], classify: () => { throw new Error(); } }), /нет объяснения/);
});

const trained = existsSync(join(root, MODEL_PATH));
test('the trained model loads for the service and covers every explained class', { skip: !trained && 'нет обученной модели' }, async () => {
  const classifier = await IntentClassifier.loadForService(root);
  const service = new AssistantService(knowledge, classifier);
  for (const intent of classifier.classes) assert.ok(knowledge.intent(intent), intent);
  const response = service.answer({ messages: [{ role: 'user', content: 'Зачем нужен расширительный бак?' }] });
  assert.ok(response.content.length > 0 && (response.clarification || response.sources.length > 0));
});
