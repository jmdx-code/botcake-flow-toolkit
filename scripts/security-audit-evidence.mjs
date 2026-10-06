// Read-only evidence collection. Sends only public package names/versions to OSV/npm.
// Secret scan results contain locations and rule names, never matched values.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const destination = path.resolve('docs/security-audit');
fs.mkdirSync(destination, { recursive: true });
const save = (name, value) => fs.writeFileSync(path.join(destination, name), JSON.stringify(value, null, 2) + '\n');
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const direct = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies }).map(([name, range]) => ({
  name, range, version: lock.packages['node_modules/' + name]?.version,
  scope: manifest.dependencies[name] ? 'production' : 'development',
}));
const packages = Object.entries(lock.packages).filter(([location]) => location).map(([location, pkg]) => ({
  location, name: pkg.name ?? location.split('node_modules/').at(-1), version: pkg.version,
  dev: Boolean(pkg.dev), optional: Boolean(pkg.optional), integrity: pkg.integrity,
}));
save('dependency-inventory.json', { direct, packages });

const unique = [...new Map(packages.map(pkg => [pkg.name + '@' + pkg.version, pkg])).values()];
try {
  const response = await fetch('https://api.osv.dev/v1/querybatch', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ queries: unique.map(pkg => ({ package: { ecosystem: 'npm', name: pkg.name }, version: pkg.version })) }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error('OSV HTTP ' + response.status);
  const result = await response.json();
  save('osv-results.json', { queriedAt: new Date().toISOString(), results: unique.map((pkg, i) => ({ name: pkg.name, version: pkg.version, ...result.results[i] })) });
  console.log('OSV queried:', unique.length, 'packages; matches:', result.results.filter(item => item.vulns?.length).length);
} catch (error) { save('osv-results.json', { error: String(error) }); }

const maintenance = await Promise.all(direct.map(async pkg => {
  try {
    const response = await fetch('https://registry.npmjs.org/' + encodeURIComponent(pkg.name), { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error('registry HTTP ' + response.status);
    const data = await response.json();
    const version = data.versions[pkg.version];
    const latest = data['dist-tags']?.latest;
    return { name: pkg.name, version: pkg.version, versionPublishedAt: data.time[pkg.version], latest, latestPublishedAt: data.time[latest], repository: version?.repository, deprecated: version?.deprecated };
  } catch (error) { return { name: pkg.name, error: String(error) }; }
}));
save('maintenance.json', maintenance);

const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['jwt-literal', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['credential-url', /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:@/]+:[^\s@/]+@/g],
  ['secret-literal-review', /(?:api[_-]?key|access[_-]?token|secret|password|webhook)\s*[:=]\s*["'][^"'\r\n]{16,}["']/gi],
];
function scan(text, file, revision) {
  const hits = [];
  for (const [rule, regex] of rules) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) hits.push({ file, revision, line: text.slice(0, match.index).split('\n').length, rule });
  }
  return hits;
}
const excluded = new Set(['.git', 'node_modules', 'security-audit']);
function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (excluded.has(entry.name)) return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(file) : entry.isFile() ? [file] : [];
  });
}
const localFiles = filesIn('.');
const localHits = localFiles.flatMap(file => scan(fs.readFileSync(file, 'utf8'), file, 'worktree'));
const revisions = execFileSync('git', ['rev-list', '--all'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const blobs = new Map();
for (const revision of revisions) {
  const entries = execFileSync('git', ['ls-tree', '-r', '-z', revision], { encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const entry of entries) {
    const match = /^\d+ blob ([a-f0-9]+)\t(.+)$/.exec(entry);
    if (match && !blobs.has(match[1])) blobs.set(match[1], { file: match[2], revision });
  }
}
const historyHits = [...blobs].flatMap(([hash, info]) => scan(execFileSync('git', ['cat-file', 'blob', hash], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }), info.file, info.revision));
save('secret-scan.json', { localFileCount: localFiles.length, revisionCount: revisions.length, uniqueBlobCount: blobs.size, localHits, historyHits, limitation: 'Pattern scan; absence of matches does not prove absence of secrets. node_modules excluded; generated dist included.' });
console.log('Secret scan locations:', localHits.length, 'worktree;', historyHits.length, 'history; scanned revisions:', revisions.length);

// npm's executable is a .cmd shim on Windows. It receives no interpolated input.
const audit = spawnSync(process.platform === 'win32' ? 'cmd.exe' : 'npm', process.platform === 'win32' ? ['/d', '/c', 'npm audit --json'] : ['audit', '--json'], { encoding: 'utf8' });
try { save('npm-audit-after.json', JSON.parse(audit.stdout)); } catch { save('npm-audit-after.json', { error: audit.stderr, exitCode: audit.status }); }
