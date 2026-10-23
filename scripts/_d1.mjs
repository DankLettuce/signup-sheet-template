// Tiny wrapper around `wrangler d1 execute` for the admin scripts.
// Local (default): the dev DB in .wrangler/state (or $PERSIST). --remote: production (site.config.json database_name).
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const args = process.argv.slice(2);
export const flag = n => args.includes('--' + n);
export const opt = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };
export const REMOTE = flag('remote');

export function d1(sql) {
  const f = join(mkdtempSync(join(tmpdir(), 'd1-')), 'q.sql');
  writeFileSync(f, sql);
  const target = REMOTE ? [JSON.parse(readFileSync(join(ROOT, 'site.config.json'), 'utf8')).site.database_name, '--remote'] : ['DB', '--local', '--persist-to', process.env.PERSIST || '.wrangler/state'];
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', ...target, '--json', '--file', f, ...(REMOTE ? ['--yes'] : [])],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  return JSON.parse(out); // [{ results: [...] }, ...] one per statement
}
export const q = sql => d1(sql).at(-1).results;
export const lit = s => s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`;

// "2026-10-25 14:00" (America/New_York wall time) -> "2026-10-25 18:00:00" (UTC, D1 format)
export function etToUtc(str) {
  const m = String(str || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw new Error(`Time must look like "2026-10-25 14:00" (Eastern), got: ${str}`);
  const [Y, M, D, h, mi, s] = m.slice(1).map(x => Number(x || 0));
  for (const off of [4, 5]) {
    const t = new Date(Date.UTC(Y, M - 1, D, h + off, mi, s));
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(t).map(p => [p.type, p.value]));
    if (+parts.hour === h && +parts.minute === mi && +parts.day === D) return t.toISOString().replace('T', ' ').slice(0, 19);
  }
  throw new Error('That Eastern time does not exist (DST gap): ' + str);
}
export const utcToEt = s => new Date(s.replace(' ', 'T') + 'Z').toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET';
