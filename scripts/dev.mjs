import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const env = { ...loadEnv('development', root, ''), ...process.env };
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    if (process.platform === 'win32') {
      const cleanup = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      cleanup.on('error', () => child.kill());
    } else child.kill();
  }
}
const tsc = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
const build = spawn(process.execPath, [tsc, '-p', 'tsconfig.server.json'], { cwd: root, env, stdio: 'inherit', windowsHide: true });
const built = await new Promise(resolve => {
  build.on('error', error => { console.error(error.message); resolve(false); });
  build.on('exit', code => resolve(code === 0));
});
if (!built) process.exit(1);
const commands = [
  [tsc, '-p', 'tsconfig.server.json', '--watch', '--preserveWatchOutput'],
  ['--watch', 'dist-server/server/index.js'],
];
if (!process.argv.includes('--server-only')) commands.push([fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)), '--host', '127.0.0.1']);
for (const args of commands) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  children.push(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => stop(code ?? 0));
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
