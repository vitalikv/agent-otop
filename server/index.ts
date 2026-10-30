import { AppConfig } from './AppConfig.js';
import { KnowledgeBase } from './KnowledgeBase.js';
import { ChatController } from './ChatController.js';
import { IntentClassifier } from './IntentClassifier.js';
import { LlmClient } from './LlmClient.js';
import { LlmResponder } from './LlmResponder.js';

try {
  const config = new AppConfig();
  const knowledge = await KnowledgeBase.load(config.root);
  const client = config.llmUrl ? new LlmClient(config.llmUrl, config.llmTimeoutMs) : undefined;
  // The language model replaces the intent network; verified rules stay in front of either.
  const classifier = !client && config.intentNetwork ? await IntentClassifier.loadForService(config.root) : undefined;
  const server = new ChatController(knowledge, classifier, client && new LlmResponder(knowledge, client)).createServer();
  server.on('error', error => { console.error(`Сервис бота: ${error.message}`); process.exitCode = 1; });
  server.listen(config.port, config.host, () => console.log(`Сервис бота: http://${config.host}:${config.port} · данные загружены · ${client ? `правила и языковая модель ${config.llmUrl}` : classifier ? 'правила и нейросеть' : 'правила, нейросеть отключена'}`));
  if (client && !await client.healthy()) console.warn(`Языковая модель на ${config.llmUrl} пока недоступна: запустите npm run llm:server. До запуска вопросы вне правил получат ошибку 503.`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close());
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
