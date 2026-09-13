import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const root = new URL('../', import.meta.url).pathname;
const clientRoot = join(root, 'dist/client');
await rm(join(root, 'dist'), { recursive: true, force: true });
const vite = Bun.spawn(['bun', 'run', 'vite', 'build', '--outDir', 'dist/client'], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
if (await vite.exited !== 0) throw new Error('Client build failed');
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.woff2': 'font/woff2',
};
const assets: Record<string, { contentType: string; base64: string }> = {};
async function collect(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile()) {
      assets[`/${relative(clientRoot, path)}`] = {
        contentType: types[extname(path)] ?? 'application/octet-stream',
        base64: (await readFile(path)).toString('base64'),
      };
    }
  }
}
await collect(clientRoot);
const result = await Bun.build({
  entrypoints: [join(root, 'server/worker.ts')],
  outdir: join(root, 'dist/server'),
  naming: 'index.js', target: 'browser', format: 'esm', minify: true,
  define: { 'import.meta.main': 'false' },
  plugins: [{
    name: 'bundled-public-assets',
    setup(build) {
      build.onResolve({ filter: /^branch:assets$/ }, () => ({ path: 'assets', namespace: 'branch' }));
      build.onLoad({ filter: /.*/, namespace: 'branch' }, () => ({ contents: `export default ${JSON.stringify(assets)}`, loader: 'js' }));
    },
  }],
});
if (!result.success) throw new AggregateError(result.logs, 'Hosted Worker build failed');
await mkdir(join(root, 'dist/.openai'), { recursive: true });
await copyFile(join(root, '.openai/hosting.json'), join(root, 'dist/.openai/hosting.json'));
console.log(`Hosted Worker built with ${Object.keys(assets).length} public assets.`);
