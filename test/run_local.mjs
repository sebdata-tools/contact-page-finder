// Live smoke test: runs the Actor locally with a given input and prints a summary of what it saved.
// Usage (from the Actor folder): node test/run_local.mjs @file.json [rows to print]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2] ?? '{"websites":["https://basecamp.com","plausible.io"]}';
const input = JSON.parse(arg.startsWith('@') ? fs.readFileSync(arg.slice(1), 'utf8') : arg);

const storage = path.join(root, 'storage');
fs.rmSync(storage, { recursive: true, force: true });
const kv = path.join(storage, 'key_value_stores', 'default');
fs.mkdirSync(kv, { recursive: true });
fs.writeFileSync(path.join(kv, 'INPUT.json'), JSON.stringify(input));

const t0 = Date.now();
const run = spawnSync(process.execPath, ['src/main.js'], { cwd: root, stdio: 'inherit', env: { ...process.env, APIFY_LOCAL_STORAGE_DIR: storage } });
const seconds = ((Date.now() - t0) / 1000).toFixed(1);

const dsDir = path.join(storage, 'datasets', 'default');
const files = fs.existsSync(dsDir) ? fs.readdirSync(dsDir).filter((f) => /^\d+\.json$/.test(f)).sort() : [];
const items = files.map((f) => JSON.parse(fs.readFileSync(path.join(dsDir, f), 'utf8')));
const count = (fn) => items.filter(fn).length;
const methods = {};
for (const it of items) methods[it.contactPageMethod ?? 'none'] = (methods[it.contactPageMethod ?? 'none'] ?? 0) + 1;
console.log('\n=== exit code', run.status, '| seconds', seconds, '| rows', items.length, '| contact page found', count((i) => i.contactPageFound),
    '| by method', JSON.stringify(methods), '| with form', count((i) => i.hasContactForm), '| with role address', count((i) => i.emails.length > 0),
    '| role addresses', items.reduce((n, i) => n + i.emails.length, 0), '| other addresses omitted', items.reduce((n, i) => n + i.otherEmailsOmitted, 0),
    '| with a social profile', count((i) => Object.values(i.socialProfiles).some(Boolean)), '| pages', items.reduce((n, i) => n + i.pagesFetched, 0));
const summaryFile = path.join(kv, 'SUMMARY.json');
if (fs.existsSync(summaryFile)) {
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
    console.log('SUMMARY', JSON.stringify({ ...summary, siteReport: undefined }));
    for (const r of summary.siteReport.filter((s) => s.status !== 'ok')) console.log('  not read:', JSON.stringify(r));
}
for (const it of items.slice(0, Number(process.argv[3] ?? 2))) console.log(JSON.stringify(it));
fs.writeFileSync(path.join(storage, 'items.json'), JSON.stringify(items, null, 1));
process.exit(run.status ?? 1);
