import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, parseOps, safeNotePath } from '../src/edits';
import { applyProposalText, parseProposals, splitEditBlocks } from '../src/documents';

const doc = '# Plan\n\nIntro.\n\n## 1. Goals\n\nOld goals.\n\n### 1.1 Detail\n\nDeep.\n\n## 2. Todo\n\n- a\n\n```\n## 1. Goals\n```\n';

test('replace_section swaps a section body, keeps subsections out of a sibling and ignores headings in code', () => {
  const out = applyOps(doc, [{ op: 'replace_section', heading: '## 2. Todo', content: '- b\n- c' }]);
  assert.equal(out, '# Plan\n\nIntro.\n\n## 1. Goals\n\nOld goals.\n\n### 1.1 Detail\n\nDeep.\n\n## 2. Todo\n\n- b\n- c\n');
  const goals = applyOps(doc, [{ op: 'replace_section', heading: '1. Goals', content: 'New goals.' }]);
  assert.ok(goals.includes('## 1. Goals\n\nNew goals.\n\n## 2. Todo'), 'the subsection belongs to the replaced section');
});

test('append adds to the end of a section or of the note', () => {
  assert.ok(applyOps(doc, [{ op: 'append', heading: '1.1 Detail', content: 'More.' }]).includes('Deep.\n\nMore.\n\n## 2. Todo'));
  assert.equal(applyOps('# A\n\ntext\n\n', [{ op: 'append', content: 'end' }]), '# A\n\ntext\n\nend\n');
});

test('every operation must find exactly one place, or the whole change is refused', () => {
  assert.throws(() => applyOps('a a', [{ op: 'replace', find: 'a', with: 'b' }]), /more than once/);
  assert.throws(() => applyOps('abc', [{ op: 'replace', find: 'b', with: 'x' }, { op: 'replace', find: 'zzz', with: 'y' }]), /not found/);
  assert.throws(() => applyOps('## X\n\n## X\n', [{ op: 'replace_section', heading: 'X', content: '' }]), /more than once/);
  assert.equal(applyOps('one two', [{ op: 'replace', find: 'two', with: '2' }]), 'one 2');
});

test('ops and paths are validated before anything can be proposed', () => {
  assert.equal(parseOps([{ op: 'delete_everything' }]), null);
  assert.equal(parseOps([]), null);
  for (const bad of ['/etc/passwd.md', '../x.md', 'a/../b.md', '.obsidian/x.md', 'note.txt']) assert.equal(safeNotePath(bad), null, bad);
  assert.equal(safeNotePath('product/新文档.md'), 'product/新文档.md');
  const hash = 'a'.repeat(64);
  const block = (data: unknown) => '```raft-edit\n' + JSON.stringify(data) + '\n```';
  const parsed = parseProposals([
    block({ path: 'p/a.md', baseHash: hash, ops: [{ op: 'replace', find: 'x', with: 'y' }] }),
    block({ path: 'p/new.md', create: true, content: '# New' }),
    block({ path: 'p/a.md', ops: [{ op: 'replace', find: 'x', with: 'y' }] }),
    block({ documentId: 'd', baseHash: hash, ops: [{ op: 'replace', find: 'x', with: 'y' }], content: 'both' }),
    block({ path: '../a.md', create: true, content: '' }),
    block({ path: 'p/short.md', baseHash: 'a'.repeat(12), content: 'short hash from a sync request' }),
    block({ documentId: 'd', baseHash: 'a'.repeat(12), content: 'note sends need the full hash' }),
    block({ path: 'p/tiny.md', baseHash: 'a'.repeat(8), content: 'too short' }),
  ].join('\n'), 'm', 'agent');
  assert.deepEqual(parsed.map(p => [p.path, !!p.create, !!p.ops]), [['p/a.md', false, true], ['p/new.md', true, false], ['p/short.md', false, false]]);
  assert.throws(() => applyProposalText('t', { ...parsed[0], path: 'p/a.md' }, { id: 'd', path: 'p/a.md', content: '', baseHash: hash, selection: { from: 0, to: 1 } }), /selected-text/);
});

test('edit blocks fenced as json (or unlabelled) count when shaped like an edit; other json stays text', () => {
  const hash = 'b'.repeat(64);
  const content = 'Here:\n```json\n' + JSON.stringify({ path: 'p/x.md', create: true, content: '# X' }) + '\n```\n\nconfig:\n```json\n{"theme": "dark"}\n```\n```raft-edit\n' +
    JSON.stringify({ path: 'p/y.md', baseHash: hash, content: 'y' }) + '\n```';
  const parsed = parseProposals(content, 'm', 'a');
  assert.deepEqual(parsed.map(p => [p.id, p.path]), [['m:0', 'p/y.md'], ['m:j0', 'p/x.md']]);
  const split = splitEditBlocks(content);
  assert.equal(split.blocks.length, 2);
  assert.ok(split.text.includes('{"theme": "dark"}') && !split.text.includes('p/x.md'));
});
