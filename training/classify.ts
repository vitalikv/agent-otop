import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { AppConfig } from '../server/AppConfig.js';
import { IntentClassifier } from '../server/IntentClassifier.js';

// npm run intent — questions are typed line by line (npm on Windows mangles arguments with spaces);
// node .training-build/training/classify.js "вопрос" … classifies arguments directly.
const classifier = await IntentClassifier.load(join(new AppConfig().root, 'data/generated/intent-model.json'));
const show = (question: string) => {
  const prediction = classifier.classify(question);
  const top = prediction.ranking.slice(0, 3).map(item => `${item.intent} ${(item.probability * 100).toFixed(1)}%`).join(', ');
  console.log(`  → ${prediction.accepted ? prediction.intent : `не уверена (порог ${(classifier.threshold * 100).toFixed(0)}%)`}; ${top}`);
};
const questions = process.argv.slice(2);
if (questions.length) for (const question of questions) { console.log(question); show(question); }
else {
  const input = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  console.log('Введите вопрос; пустая строка или Ctrl+C — выход.');
  input.prompt();
  for await (const line of input) {
    if (!line.trim()) break;
    show(line);
    input.prompt();
  }
  input.close();
}
