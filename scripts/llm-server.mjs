import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';

// npm run llm:server -- 8b | 14b | path/to/model.gguf
// Starts llama.cpp's OpenAI-compatible server on the address of BOT_LLM_URL (default http://127.0.0.1:8080).
const root = fileURLToPath(new URL('../', import.meta.url));
const env = { ...loadEnv('development', root, ''), ...process.env };
const models = { '8b': 'Qwen3-8B-Q4_K_M.gguf', '14b': 'Qwen3-14B-Q4_K_M.gguf' };
const choice = process.argv[2] ?? '8b';
const model = models[choice.toLowerCase()] ? join(root, 'llm/models', models[choice.toLowerCase()]) : isAbsolute(choice) ? choice : join(root, choice);
const binary = env.LLAMA_SERVER ?? join(root, 'llm/llama.cpp', process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
const url = new URL(env.BOT_LLM_URL || 'http://127.0.0.1:8080');
const parallel = Number(env.LLM_PARALLEL ?? 1);
const context = Number(env.LLM_CONTEXT ?? 8192);
for (const [file, hint] of [[binary, 'Установите llama.cpp в llm/llama.cpp или укажите LLAMA_SERVER (docs/llm-prototype.md).'], [model, 'Скачайте модель в llm/models (docs/llm-prototype.md).']]) {
  if (!existsSync(file)) { console.error(`Не найден ${file}. ${hint}`); process.exit(1); }
}
if (!Number.isInteger(parallel) || parallel < 1 || !Number.isInteger(context) || context < 2048) { console.error('LLM_PARALLEL ≥ 1 и LLM_CONTEXT ≥ 2048 — целые числа.'); process.exit(1); }
// All layers on the GPU; the context is per dialog slot, so the total grows with the number of parallel slots.
const args = ['-m', model, '--host', url.hostname, '--port', url.port || '8080', '-ngl', '999', '-c', String(context * parallel), '--parallel', String(parallel), '--jinja'];
console.log(`${binary} ${args.join(' ')}`);
const child = spawn(binary, args, { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill());
