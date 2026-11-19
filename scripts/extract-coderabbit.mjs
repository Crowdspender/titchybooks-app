// Extracts CodeRabbit IDE-extension review findings from local workspace storage
// into a workable backlog (JSON + Markdown). No GitHub API needed: the extension
// persists every local review under
//   %APPDATA%/Qoder/User/workspaceStorage/<hash>/coderabbit.coderabbit-vscode/*.json
// Usage: node scripts/extract-coderabbit.mjs [storageJsonPath]
import fs from 'node:fs';

const DEFAULT_STORAGE =
  'C:/Users/Dell/AppData/Roaming/Qoder/User/workspaceStorage/' +
  '794f564c425ab0038cd4420271bc0469/coderabbit.coderabbit-vscode/' +
  'c8b769e70a8625938987a21d16c8d95fb4749ca5235dedad713b43f81467cc07.json';

const storagePath = process.argv[2] ?? DEFAULT_STORAGE;
const runs = JSON.parse(fs.readFileSync(storagePath, 'utf8'));

// The two reviews shown as unresolved in the extension History panel
// (Nov 18: 21 + 192 findings). Older completed runs are superseded.
const active = runs
  .filter((r) => r.status === 'completed')
  .filter((r) => new Date(r.timestamp).toISOString() >= '2026-11-18')
  .sort((a, b) => a.timestamp - b.timestamp);

const findings = [];
const seen = new Map(); // dedupe key -> finding (later run wins)
for (const run of active) {
  for (const [file, review] of Object.entries(run.fileReviewMap ?? {})) {
    for (const c of review.comments ?? []) {
      const key = `${c.filename ?? file}::${c.startLine}::${(c.comment ?? '').slice(0, 100)}`;
      const entry = {
        id: c.id,
        run: run.title,
        reviewedAt: new Date(run.timestamp).toISOString(),
        file: c.filename ?? file,
        startLine: c.startLine,
        endLine: c.endLine,
        type: c.type,
        severity: c.severity,
        indicators: c.indicatorTypes ?? [],
        comment: c.comment,
        fixInstructions: c.codegenInstructions,
        suggestions: c.suggestions ?? [],
        fingerprint: c.fingerprint,
      };
      if (seen.has(key)) {
        const prev = seen.get(key);
        findings.splice(findings.indexOf(prev), 1);
      }
      seen.set(key, entry);
      findings.push(entry);
    }
  }
}

// Stable order: severity (critical > major > minor), then file, then line
const sevRank = { critical: 0, major: 1, minor: 2, trivial: 3 };
findings.sort(
  (a, b) =>
    (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9) ||
    a.file.localeCompare(b.file) ||
    a.startLine - b.startLine,
);

fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/coderabbit-backlog.json', JSON.stringify(findings, null, 2));

// Markdown triage view
const bySev = {};
const byFile = {};
for (const f of findings) {
  bySev[f.severity] = (bySev[f.severity] ?? 0) + 1;
  (byFile[f.file] ??= []).push(f);
}
const lines = [
  '# CodeRabbit backlog (extracted from IDE extension storage)',
  '',
  `Total unresolved findings: ${findings.length}`,
  `Reviews: ${active.map((r) => `${r.title} (${new Date(r.timestamp).toISOString()})`).join('; ')}`,
  '',
  '## By severity',
  ...Object.entries(bySev).map(([s, n]) => `- ${s}: ${n}`),
  '',
  '## By file',
];
for (const [file, list] of Object.entries(byFile).sort((a, b) => b[1].length - a[1].length)) {
  lines.push('', `### ${file} (${list.length})`);
  for (const f of list) {
    const title = (f.comment ?? '').split('\n')[0].slice(0, 140);
    lines.push(`- [ ] **${f.severity}** L${f.startLine}-${f.endLine} ${title}`);
  }
}
fs.writeFileSync('docs/coderabbit-backlog.md', lines.join('\n') + '\n');

console.log(`Extracted ${findings.length} findings from ${active.length} reviews`);
console.log('By severity:', bySev);
console.log('Files touched:', Object.keys(byFile).length);
console.log('Wrote docs/coderabbit-backlog.json and docs/coderabbit-backlog.md');