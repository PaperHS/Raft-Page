import test from 'node:test';
import assert from 'node:assert/strict';
import { hashText, composeMessage, parseProposals, applyToText, sentDocumentId, sentNote, splitNoteContext } from '../src/documents';

test('edit protocol preserves Markdown including code fences and binds original note', async () => {
  const baseHash = await hashText('original');
  const context = { id: 'doc-1', path: 'Projects/Test.md', content: 'original', baseHash };
  const content = '# Updated\n\n```ts\nconst a = 1;\n```\n';
  const reply = 'Here is the change.\n```raft-edit\n' + JSON.stringify({ documentId: context.id, baseHash, content }) + '\n```';
  const [proposal] = parseProposals(reply, 'reply-1', 'Agent');
  assert.equal(proposal.content, content);
  assert.equal(proposal.baseHash, baseHash);
  assert.equal(proposal.documentId, 'doc-1');
  const sent = composeMessage('Sam哥', 'Please update this note', context);
  assert.match(sent, /📎 Obsidian note `Projects\/Test.md` — full text below/);
  assert.ok(sent.includes(`{"documentId":"doc-1","baseHash":"${baseHash}"`));
  assert.equal(sentDocumentId(sent), 'doc-1');
  assert.deepEqual(splitNoteContext(sent).text, '@Sam哥 Please update this note');
  // Fences inside the note never close the inline block early.
  const fenced = composeMessage('', 'x', { ...context, content: 'a\n````\nb' });
  assert.match(fenced, /`````markdown\na\n````\nb\n`````$/);
  const file = composeMessage('', 'x', { ...context, path: "Projects/It's.md" }, true);
  assert.doesNotMatch(file, /original/);
  // With the note attached, the details sit in a link reference definition that Raft does not display.
  assert.match(file, /^x\n\n\[raft-note\]: <> '📎 Obsidian note `Projects\/It\\'s.md` — full text in the attached file\. .*'$/);
  assert.equal(file.split('\n').length, 3, 'one hidden line');
  assert.equal(splitNoteContext(file).text, 'x');
  assert.equal(splitNoteContext(file).path, "Projects/It's.md");
  assert.equal(sentDocumentId(file), 'doc-1');
  assert.match(composeMessage('', 'x', { ...context, content: '' }), /the note is empty/);
});

test('legacy sent messages still split and bind', () => {
  const legacy = 'hi\n\n---\nAttached Obsidian note: a/b.md\nThe user attached…\nEdit metadata: {"documentId":"old","path":"a/b.md"}';
  assert.deepEqual(splitNoteContext(legacy).text, 'hi');
  assert.equal(splitNoteContext(legacy).path, 'a/b.md');
  assert.equal(sentDocumentId(legacy), 'old');
});

test('invalid and oversized proposals remain chat text', () => {
  assert.deepEqual(parseProposals('```raft-edit\n{"documentId":"x","baseHash":"bad","content":"x"}\n```', 'a', 'b'), []);
  assert.deepEqual(parseProposals('```raft-edit\nnot json\n```', 'a', 'b'), []);
  const text = '```raft-edit\n' + 'a'.repeat(1_000_001) + '\n```';
  assert.deepEqual(parseProposals(text, 'a', 'b'), []);
});

test('selection edits preserve text outside original selection', () => {
  const context = { id: 'd', path: 'Test.md', content: 'old', baseHash: 'hash', selection: { from: 7, to: 10 } };
  assert.equal(applyToText('before old after', context, 'NEW'), 'before NEW after');
  assert.throws(() => applyToText('short', context, 'NEW'), /no longer valid/);
});

test('full note replacement can intentionally produce an empty note', () => {
  assert.equal(applyToText('original', { id: 'd', path: 'a.md', content: '', baseHash: 'h' }, ''), '');
});

test('no attachment sends neither note metadata nor content', () => {
  assert.equal(composeMessage('Agent', 'Hello', null), '@Agent Hello');
  assert.equal(composeMessage('', 'Hello', null), 'Hello');
});

test('another device reads a whole-note send back from the message, never a selection send', async () => {
  const baseHash = await hashText('original');
  const context = { id: 'doc-9', path: 'Notes/Original.md', content: 'original', baseHash };
  const want = { documentId: 'doc-9', path: 'Notes/Original.md', baseHash };
  assert.deepEqual(sentNote(composeMessage('writer', 'tidy it', context, true)), want);
  assert.deepEqual(sentNote(composeMessage('writer', 'tidy it', context)), want);
  assert.equal(sentNote(composeMessage('writer', 'x', { ...context, selection: { from: 0, to: 3 } }, true)), undefined);
  assert.equal(sentNote(composeMessage('writer', 'x', { ...context, path: '../escape.md' }, true)), undefined);
  assert.equal(sentNote('plain chat'), undefined);
});
