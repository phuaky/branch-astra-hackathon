const root = new URL('../', import.meta.url).pathname;
const processes = [
  Bun.spawn(['bun', '--watch', 'server/index.ts'], { cwd: root, stdout: 'inherit', stderr: 'inherit' }),
  Bun.spawn(['bun', 'run', 'dev:web'], { cwd: root, stdout: 'inherit', stderr: 'inherit' }),
];
function stop() { for (const process of processes) process.kill(); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await Promise.race(processes.map(process => process.exited));
stop();
