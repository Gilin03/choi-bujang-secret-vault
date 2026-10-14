import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { runOperationChecks } from '../public/operation-checks.js';

const root = new URL('../', import.meta.url);
const config = JSON.parse(await readFile(new URL('aleph.config.json', root), 'utf8'));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
const base = new URL(config.publicAppUrl);
if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Invalid production origin');
async function checkDeploymentIdentity() {
  const response = await fetch(new URL('/aleph.json', base), { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) });
  const identity = await response.json();
  if (!response.ok || identity.commit !== commit || identity.step !== config.step || identity.repoUrl !== config.repoUrl) {
    throw new Error('Production commit/step differs from checked commit; no results attributed to this commit');
  }
}
await checkDeploymentIdentity();
const results = await runOperationChecks({ expectedCommit: commit, fetchImpl: (path, options) => fetch(new URL(path, base), options) });
await checkDeploymentIdentity();
const artifact = { schema: 'byteback.operation-checks.v1', commit, source: 'production_anonymous_http',
  checkedAt: new Date().toISOString(), finalAssault: { total: 41, executed: 0, unexecuted: 41, passed: null }, results };
await mkdir(new URL('artifacts/', root), { recursive: true });
await writeFile(new URL('artifacts/operation-checks.json', root), `${JSON.stringify(artifact, null, 2)}\n`);
const counts = Object.fromEntries(['matched', 'mismatch', 'error', 'unexecuted'].map(state => [state, results.filter(row => row.state === state).length]));
console.log(JSON.stringify({ commit, checks: counts, official41: '미실행', output: 'artifacts/operation-checks.json' }));
if (counts.mismatch || counts.error) process.exitCode = 1;
