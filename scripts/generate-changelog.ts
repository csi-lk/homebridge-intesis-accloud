/**
 * Generate a changelog section from git commits since the last release tag.
 *
 * Reads conventional-commit messages (`feat:`, `fix:`, `chore:`, `docs:`,
 * `refactor:`, `test:`, `perf:`, `build:`) between the most recent `v*` tag
 * and HEAD, and prints a markdown section prefixed with the given version.
 *
 * Usage: bun scripts/generate-changelog.ts <version>
 */
import { execSync } from 'node:child_process';

const version = process.argv[2];
if (!version) {
  console.error('Usage: bun scripts/generate-changelog.ts <version>');
  process.exit(1);
}

function git(args: string): string {
  return execSync(`git ${args}`, { encoding: 'utf8' }).trim();
}

// Find the last release tag reachable from HEAD (excluding the current one).
let range = '';
try {
  const lastTag = git('describe --tags --abbrev=0 HEAD~0 2>/dev/null || true');
  range = lastTag ? `${lastTag}..HEAD` : '';
} catch {
  range = '';
}

const subjects = git(
  `log --no-merges --pretty=format:%s ${range}`,
).split('\n').filter(Boolean).reverse();

const groups: Record<string, string[]> = {
  Features: [],
  Fixes: [],
  Docs: [],
  Chores: [],
  Refactors: [],
  Tests: [],
  Performance: [],
  Build: [],
  Other: [],
};

const typeMap: Array<[RegExp, string]> = [
  [/^feat(\(.+\))?:\s*/, 'Features'],
  [/^fix(\(.+\))?:\s*/, 'Fixes'],
  [/^docs(\(.+\))?:\s*/, 'Docs'],
  [/^chore(\(.+\))?:\s*/, 'Chores'],
  [/^refactor(\(.+\))?:\s*/, 'Refactors'],
  [/^test(\(.+\))?:\s*/, 'Tests'],
  [/^perf(\(.+\))?:\s*/, 'Performance'],
  [/^build(\(.+\))?:\s*/, 'Build'],
];

for (const subject of subjects) {
  const clean = subject.replace(/\s*\[skip ci\]\s*$/, '').trim();
  let placed = false;
  for (const [re, group] of typeMap) {
    if (re.test(clean)) {
      groups[group].push(clean.replace(re, '').replace(/^./, c => c.toUpperCase()));
      placed = true;
      break;
    }
  }
  if (!placed) {
    groups.Other.push(clean.replace(/^./, c => c.toUpperCase()));
  }
}

const lines: string[] = [`## [${version}] - ${new Date().toISOString().slice(0, 10)}`, ''];
let any = false;
for (const [group, items] of Object.entries(groups)) {
  if (items.length === 0) {
    continue;
  }
  any = true;
  lines.push(`### ${group}`, '');
  for (const item of items) {
    lines.push(`- ${item}`);
  }
  lines.push('');
}

if (!any) {
  lines.push('- No notable changes.');
  lines.push('');
}

console.log(lines.join('\n'));
