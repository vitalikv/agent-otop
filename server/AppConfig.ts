import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

function projectRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Не найден корень проекта с package.json.');
    directory = parent;
  }
  return directory;
}

export class AppConfig {
  readonly host = '127.0.0.1';
  readonly root = projectRoot();
  readonly port: number;
  readonly intentNetwork: boolean;
  /** Base URL of a llama.cpp server; when set, the language model answers instead of the intent network. */
  readonly llmUrl?: string;
  readonly llmTimeoutMs: number;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const network = env.BOT_INTENT_NETWORK ?? 'on';
    if (!['on', 'off'].includes(network)) throw new Error('BOT_INTENT_NETWORK должен быть on или off.');
    this.intentNetwork = network === 'on';
    if (env.BOT_LLM_URL) {
      const url = URL.canParse(env.BOT_LLM_URL) ? new URL(env.BOT_LLM_URL) : undefined;
      if (!url || !['http:', 'https:'].includes(url.protocol)) throw new Error('BOT_LLM_URL должен быть адресом http(s), например http://127.0.0.1:8080.');
      this.llmUrl = url.origin;
    }
    const timeout = env.BOT_LLM_TIMEOUT_MS ?? '120000';
    if (!/^\d+$/.test(timeout) || Number(timeout) < 1000) throw new Error('BOT_LLM_TIMEOUT_MS должен быть целым числом не меньше 1000.');
    this.llmTimeoutMs = Number(timeout);
    const port = env.BOT_PORT ?? '3001';
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      throw new Error('BOT_PORT должен быть целым числом от 1 до 65535.');
    }
    this.port = Number(port);
  }
}
