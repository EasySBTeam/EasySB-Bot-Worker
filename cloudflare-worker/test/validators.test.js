import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONVENTIONAL_TYPES,
  parseConventionalSubject,
  isAutosquash,
  isMergeCommit,
  isProtectedHeadBranch,
  isTrailersOnly,
  validateCommitMessage,
  validateCommits,
  validateDiffHygiene,
  buildCheckRuns,
} from '../src/validators.js';
import { DEFAULT_CONFIG } from '../src/config.js';

function commit(message, { sha = 'abcdef1234567890', parents = 1, email = 'dev@example.com' } = {}) {
  return {
    sha,
    parents: Array.from({ length: parents }, () => ({})),
    commit: { message, author: { name: 'Dev', email } },
  };
}

const cfg = (overrides = {}) => ({ ...DEFAULT_CONFIG, ...overrides });

test('parseConventionalSubject reads type, scope and breaking marker', () => {
  assert.deepEqual(parseConventionalSubject('feat(tui): add panel'), {
    type: 'feat', scope: 'tui', breaking: false, description: 'add panel',
  });
  assert.deepEqual(parseConventionalSubject('fix!: urgent'), {
    type: 'fix', scope: null, breaking: true, description: 'urgent',
  });
  assert.deepEqual(parseConventionalSubject('chore: tidy'), {
    type: 'chore', scope: null, breaking: false, description: 'tidy',
  });
  assert.equal(parseConventionalSubject('added a thing'), null);
  assert.equal(parseConventionalSubject('feat(tui) missing colon'), null);
});

test('isAutosquash and isMergeCommit and isProtectedHeadBranch', () => {
  assert.equal(isAutosquash('fixup! feat(tui): x'), true);
  assert.equal(isAutosquash('squash! x'), true);
  assert.equal(isAutosquash('feat: x'), false);
  assert.equal(isMergeCommit(commit('Merge branch', { parents: 2 })), true);
  assert.equal(isMergeCommit(commit('feat: x')), false);
  assert.equal(isProtectedHeadBranch('master'), true);
  assert.equal(isProtectedHeadBranch('Main'), true);
  assert.equal(isProtectedHeadBranch('feat/x'), false);
});

test('isTrailersOnly treats an empty or trailer-only body as no body', () => {
  assert.equal(isTrailersOnly([]), true);
  assert.equal(isTrailersOnly(['', 'Signed-off-by: Dev <d@e.com>']), true);
  assert.equal(isTrailersOnly(['This explains why.']), false);
  assert.equal(isTrailersOnly(['Signed-off-by: Dev <d@e.com>', 'And a real explanation.']), false);
});

test('a well-formed conventional commit with a body passes', () => {
  const message = 'feat(tui): 新增设备信息面板\n\n展示节点端口与运行状态。';
  const { errors, warnings } = validateCommitMessage(commit(message), cfg());
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('an unknown type is rejected', () => {
  const shaped = validateCommitMessage(commit('feature(tui): x\n\nbody'), cfg());
  assert.equal(shaped.errors.length, 1);
  assert.match(shaped.errors[0], /is not one of/);

  const unshaped = validateCommitMessage(commit('Added a feature\n\nbody'), cfg());
  assert.match(unshaped.errors.join('\n'), /not a conventional commit/);
  assert.ok(CONVENTIONAL_TYPES.includes('feat'));
});

test('a subject ending in a period is rejected', () => {
  const { errors } = validateCommitMessage(commit('fix(tui): 修正问题。\n\n原因说明。'), cfg());
  assert.match(errors.join('\n'), /must not end with a period/);
});

test('subject length uses soft warnings and hard errors', () => {
  const soft = validateCommitMessage(commit(`feat(tui): ${'a'.repeat(70)}\n\nbody`), cfg());
  assert.equal(soft.errors.length, 0);
  assert.equal(soft.warnings.length, 1);

  const hard = validateCommitMessage(commit(`feat(tui): ${'a'.repeat(100)}\n\nbody`), cfg());
  assert.match(hard.errors.join('\n'), /hard limit/);
});

test('a missing blank line before the body is an error', () => {
  const { errors } = validateCommitMessage(commit('feat(tui): x\nnot blank\n\nmore'), cfg());
  assert.match(errors.join('\n'), /blank line must separate/);
});

test('feat/fix demand a body, other types do not', () => {
  assert.match(validateCommitMessage(commit('feat(tui): x'), cfg()).errors.join('\n'), /needs a description body/);
  assert.deepEqual(validateCommitMessage(commit('chore: bump deps'), cfg()).errors, []);
});

test('a body of only trailers does not satisfy the description rule', () => {
  const { errors } = validateCommitMessage(commit('fix(tui): x\n\nSigned-off-by: Dev <dev@example.com>'), cfg());
  assert.match(errors.join('\n'), /only trailers/);
});

test('a co-author trailer is rejected when the rule is on', () => {
  const message = 'feat(tui): x\n\nbody\n\nCo-authored-by: Bot <bot@example.com>';
  assert.match(validateCommitMessage(commit(message), cfg()).errors.join('\n'), /Co-authored-by/);
  assert.deepEqual(validateCommitMessage(commit(message), cfg({ check_coauthor: false })).errors, []);
});

test('the sign-off rule checks presence and the matching email', () => {
  const without = validateCommitMessage(commit('feat(tui): x\n\nbody'), cfg({ check_signoff: true }));
  assert.match(without.errors.join('\n'), /missing a `Signed-off-by:`/);

  const wrong = commit('feat(tui): x\n\nbody\n\nSigned-off-by: Dev <other@example.com>');
  assert.match(validateCommitMessage(wrong, cfg({ check_signoff: true })).errors.join('\n'), /does not match/);

  const ok = commit('feat(tui): x\n\nbody\n\nSigned-off-by: Dev <dev@example.com>');
  assert.deepEqual(validateCommitMessage(ok, cfg({ check_signoff: true })).errors, []);
});

test('autosquash commits bypass the rules', () => {
  const { errors, warnings } = validateCommitMessage(commit('fixup! feat(tui): x'), cfg());
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('a revert subject is accepted without a type', () => {
  const message = 'Revert "feat(tui): add panel"\n\nThis reverts commit abcdef1.';
  const { errors } = validateCommitMessage(commit(message), cfg());
  assert.deepEqual(errors, []);
});

test('validateCommits flags a protected head branch and merge commits', () => {
  const commits = [commit('Merge branch master', { parents: 2 })];
  const { errors } = validateCommits(commits, cfg(), { headBranch: 'master' });
  const text = errors.map(e => e.message).join('\n');
  assert.match(text, /protected branch/);
  assert.match(text, /merge commit/);
});

test('validateCommits caps the audit on very large pull requests', () => {
  const commits = Array.from({ length: 250 }, (_, i) => commit(`chore: x${i}`));
  const { commitScanCapped } = validateCommits(commits, cfg());
  assert.equal(commitScanCapped, true);
});

test('validateDiffHygiene finds CRLF and missing trailing newlines', () => {
  const diff = [
    'diff --git a/a.go b/a.go',
    '--- a/a.go',
    '+++ b/a.go',
    '@@ -1 +1 @@',
    '-old',
    '+new\r',
    '\\ No newline at end of file',
  ].join('\n');
  const { errors, warnings } = validateDiffHygiene(diff, cfg());
  assert.match(errors.join('\n'), /`a\.go` uses CRLF/);
  assert.match(warnings.join('\n'), /`a\.go` does not end with a newline/);
});

test('buildCheckRuns reports a protected branch as a failure but a clean PR as passing', () => {
  const clean = buildCheckRuns({ commits: [commit('feat(tui): x\n\nbody')], diffText: '', config: cfg(), headBranch: 'feat/x', allowBranch: false });
  assert.equal(clean.failed, false);

  const flagged = buildCheckRuns({ commits: [commit('feat(tui): x\n\nbody')], diffText: '', config: cfg(), headBranch: 'master', allowBranch: false });
  assert.equal(flagged.failed, true);

  const bypassed = buildCheckRuns({ commits: [commit('feat(tui): x\n\nbody')], diffText: '', config: cfg(), headBranch: 'master', allowBranch: true });
  assert.equal(bypassed.failed, false);
});
