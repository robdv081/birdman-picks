// Bundles the worker for Node and runs the tests. Usage: node scripts/test.mjs
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', '.test-build', 'worker.mjs');
mkdirSync(path.dirname(out), { recursive: true });
await build({
  entryPoints: [path.join(here, '..', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  outfile: out,
  nodePaths: (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean),
  logLevel: 'warning',
});
const r = spawnSync(process.execPath, ['--no-warnings', '--test', path.join(here, '..', 'test', 'server.test.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, WORKER_BUNDLE: out },
});
process.exit(r.status ?? 1);
