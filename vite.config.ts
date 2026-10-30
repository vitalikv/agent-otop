import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const port = process.env.BOT_PORT ?? env.BOT_PORT ?? '3001';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Некорректный BOT_PORT');
  const proxy = { '/api': { target: `http://127.0.0.1:${port}` } };
  return { server: { host: '127.0.0.1', proxy }, preview: { host: '127.0.0.1', proxy } };
});
