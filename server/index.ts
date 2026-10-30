import { AppConfig } from './AppConfig.js';
import { KnowledgeBase } from './KnowledgeBase.js';
import { ChatController } from './ChatController.js';

try {
  const config = new AppConfig();
  const knowledge = await KnowledgeBase.load(config.root);
  const server = new ChatController(knowledge).createServer();
  server.on('error', error => { console.error(`Сервис бота: ${error.message}`); process.exitCode = 1; });
  server.listen(config.port, config.host, () => console.log(`Сервис бота: http://${config.host}:${config.port} · данные загружены · правила, без нейросети`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close());
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
