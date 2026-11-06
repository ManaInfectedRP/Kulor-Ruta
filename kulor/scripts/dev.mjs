// Development run: Vite with hot reload for the UI, Electron pointed at it.
import { spawn, execSync } from 'node:child_process';
import { createServer } from 'vite';
import electronPath from 'electron';

execSync('node scripts/build-main.mjs', { stdio: 'inherit' });

const server = await createServer();
await server.listen();
const url = server.resolvedUrls.local[0];

const app = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, KULOR_DEV_URL: url },
});
app.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
