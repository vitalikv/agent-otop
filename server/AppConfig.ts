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

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const port = env.BOT_PORT ?? '3001';
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      throw new Error('BOT_PORT должен быть целым числом от 1 до 65535.');
    }
    this.port = Number(port);
  }
}
