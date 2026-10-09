import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, getLabelsForChangedFiles, getAllChangedFiles, normalizePath, globToRegex } from '../src/labeler.js';

test('normalizePath trims leading ./ and /', () => {
  assert.equal(normalizePath('./internal/tui/x.go'), 'internal/tui/x.go');
  assert.equal(normalizePath('/docs/x.md'), 'docs/x.md');
});

test('a ** glob crosses directory separators', () => {
  assert.equal(globToRegex('internal/**').test('internal/tui/view.go'), true);
  assert.equal(globToRegex('docs/*.md').test('docs/a.md'), true);
  assert.equal(globToRegex('docs/*.md').test('docs/sub/a.md'), false);
});

test('getAllChangedFiles reads both diff headers and ignores /dev/null', () => {
  const diff = [
    'diff --git a/internal/tui/view.go b/internal/tui/view.go',
    '--- a/internal/tui/view.go',
    '+++ b/internal/tui/view.go',
    'diff --git a/old.go b/old.go',
    '--- a/old.go',
    '+++ /dev/null',
  ].join('\n');
  const files = getAllChangedFiles(diff);
  assert.deepEqual(files.sort(), ['internal/tui/view.go', 'old.go']);
});

test('parseYaml reads the v5 changed-files shape', () => {
  const yaml = [
    '"area: tui":',
    '  - changed-files:',
    '      - any-glob-to-any-file:',
    '          - internal/tui/**',
    '          - internal/i18n/**',
    '',
    '"docs":',
    '  - changed-files:',
    '      - any-glob-to-any-file: ["docs/**", "*.md"]',
  ].join('\n');
  const parsed = parseYaml(yaml);
  assert.deepEqual(parsed['area: tui'], ['internal/tui/**', 'internal/i18n/**']);
  assert.deepEqual(parsed.docs, ['docs/**', '*.md']);
});

test('getLabelsForChangedFiles matches each label against the changed paths', () => {
  const parsed = {
    docs: ['docs/**'],
    'area: tui': ['internal/tui/**'],
  };
  const labels = getLabelsForChangedFiles(['internal/tui/view.go'], parsed);
  assert.deepEqual(labels, ['area: tui']);
});
