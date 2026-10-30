import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs training/train.py with the project's Python environment; arguments are passed through (e.g. --device cuda).
const root = fileURLToPath(new URL('../', import.meta.url));
const python = join(root, 'training/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
if (!existsSync(python)) {
  console.error('Нет окружения обучения training/.venv. Создайте его по инструкции в docs/stage-5-intent-model.md.');
  process.exit(1);
}
const result = spawnSync(python, ['training/train.py', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
