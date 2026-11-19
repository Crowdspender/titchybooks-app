// Applies triage verdicts to the extracted CodeRabbit backlog.
// Verdicts live in docs/coderabbit-dispositions.json: { "<finding id>": { "disposition": "fixed"|"skipped", "reason": "..." } }
// Usage: node scripts/apply-coderabbit-dispositions.mjs
import fs from 'node:fs';

const backlog = JSON.parse(fs.readFileSync('docs/coderabbit-backlog.json', 'utf8'));
const verdicts = JSON.parse(fs.readFileSync('docs/coderabbit-dispositions.json', 'utf8'));

let applied = 0;
for (const finding of backlog) {
  const verdict = verdicts[finding.id];
  if (!verdict) continue;
  finding.disposition = verdict.disposition;
  finding.dispositionReason = verdict.reason;
  applied++;
}
const unknown = Object.keys(verdicts).filter(id => !backlog.some(f => f.id === id));
if (unknown.length) console.warn('Verdicts without matching finding:', unknown);
fs.writeFileSync('docs/coderabbit-backlog.json', JSON.stringify(backlog, null, 2));

const bySev = {};
const byFile = {};
for (const f of backlog) {
  bySev[f.severity] = (bySev[f.severity] ?? 0) + 1;
  (byFile[f.file] ??= []).push(f);
}
const done = backlog.filter(f => f.disposition).length;
const lines = [
  '# CodeRabbit backlog (extracted from IDE extension storage)',
  '',
  `Total findings: ${backlog.length} | triaged: ${done} | open: ${backlog.length - done}`,
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
    const mark = f.disposition ? 'x' : ' ';
    const verdict = f.disposition ? ` — ${f.disposition}: ${f.dispositionReason}` : '';
    lines.push(`- [${mark}] **${f.severity}** L${f.startLine}-${f.endLine} ${title}${verdict}`);
  }
}
fs.writeFileSync('docs/coderabbit-backlog.md', lines.join('\n') + '\n');
console.log(`Applied ${applied} verdicts; ${done}/${backlog.length} triaged.`);