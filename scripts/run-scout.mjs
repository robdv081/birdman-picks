// Builds scripts/scout.ts for Node and runs it. Pass --dry to see the report without publishing.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.agent-build', 'scout.mjs');
await build({
  entryPoints: [path.join(root, 'scripts', 'scout.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: out,
  logLevel: 'warning',
});
const r = spawnSync(process.execPath, [out, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
