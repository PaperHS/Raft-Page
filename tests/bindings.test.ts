import test from 'node:test';
import assert from 'node:assert/strict';
import { bind, channelName, deleteBindings, folderManifest, parseBindings, renameBindings, resolveBinding, resolveChannelBinding, mergeBindings, serializeBindings, type Bindings } from '../src/bindings';

const b = (channelId: string, kind: 'file' | 'folder' = 'folder', serverId = 's1') => ({ channelId, channelName: channelId, serverId, kind });

test('the nearest binding wins, from the note itself up through its folders', () => {
  const bindings: Bindings = { Projects: b('all'), 'Projects/Raft': b('raft'), 'Projects/Raft/Spec.md': b('spec', 'file') };
  assert.equal(resolveBinding(bindings, 'Projects/Raft/Spec.md', 's1')?.channelId, 'spec');
  assert.deepEqual(resolveBinding(bindings, 'Projects/Raft/Notes/a.md', 's1'), { ...b('raft'), path: 'Projects/Raft', inherited: true });
  assert.equal(resolveBinding(bindings, 'Projects/Other.md', 's1')?.channelId, 'all');
  assert.equal(resolveBinding(bindings, 'Inbox/x.md', 's1'), null);
  assert.equal(resolveBinding(bindings, 'Projects/Raft/x.md', 's2'), null, 'bindings of another server are ignored');
});

test('a channel keeps one root: binding it elsewhere moves the binding', () => {
  const { bindings, replaced } = bind({ A: b('c1'), B: b('c2') }, 'C', b('c1'));
  assert.deepEqual(Object.keys(bindings).sort(), ['B', 'C']);
  assert.deepEqual(replaced, ['A']);
});

test('renames and deletes carry nested bindings and leave look-alike siblings alone', () => {
  const bindings: Bindings = { Notes: b('n'), 'Notes/Deep/x.md': b('x', 'file'), 'Notes2': b('other') };
  assert.deepEqual(Object.keys(renameBindings(bindings, 'Notes', 'Archive/Notes')!).sort(), ['Archive/Notes', 'Archive/Notes/Deep/x.md', 'Notes2']);
  assert.equal(renameBindings(bindings, 'Elsewhere', 'X'), null);
  assert.deepEqual(Object.keys(deleteBindings(bindings, 'Notes')!), ['Notes2']);
});

test('bindings round-trip and malformed entries are dropped', () => {
  const bindings: Bindings = { 'Projects/Raft': b('raft') };
  assert.deepEqual(parseBindings(serializeBindings(bindings)), bindings);
  assert.deepEqual(parseBindings(JSON.stringify({ bindings: { x: { channelName: 'no id' }, '': b('empty') } })), {});
});

test('folder manifests list sizes relative to the folder and cap long lists', () => {
  const files = [{ path: 'P/b.md', size: 2048 }, { path: 'P/a.md', size: 10 }, { path: 'Q/c.md', size: 1 }, { path: 'P/d.md', size: 5 }];
  assert.equal(folderManifest(files, 'P', 2), '- a.md (10 B)\n- b.md (2.0 KB)\n- … 1 more');
});

test('a new channel name is suggested from the note title in any script', () => {
  assert.equal(channelName('Trip to Lisbon (draft)'), 'trip-to-lisbon-draft');
  assert.equal(channelName('小票 扫描_方案'), '小票-扫描-方案');
  assert.equal(channelName('  --Hello!!  '), 'hello');
});

test('a channel finds its bound note or folder on the current server even when another note is open', () => {
  const bindings: Bindings = { 'product/cq': b('cq'), 'product/note.md': b('note', 'file'), 'other': { ...b('cq'), serverId: 's2' } };
  assert.deepEqual(resolveChannelBinding(bindings, 'cq', 's1')?.path, 'product/cq');
  assert.deepEqual(resolveChannelBinding(bindings, 'note', 's1')?.path, 'product/note.md');
  assert.equal(resolveChannelBinding(bindings, 'missing', 's1'), null);
});

test('a device with an old copy writes only its own change, keeping bindings another device added', () => {
  const before: Bindings = { A: b('a'), B: b('b') };
  const disk: Bindings = { A: b('a'), B: b('b'), Phone: b('phone') };
  // This device binds C and unbinds B; the phone meanwhile added Phone.
  const after: Bindings = { A: b('a'), C: b('c') };
  assert.deepEqual(Object.keys(mergeBindings(before, after, disk)).sort(), ['A', 'C', 'Phone']);
  // Changing a steward updates only that entry.
  const steward = { ...b('a'), stewardId: 's', stewardName: 'scribe' };
  assert.equal(mergeBindings(before, { ...before, A: steward }, disk).A.stewardId, 's');
  assert.ok(mergeBindings(before, { ...before, A: steward }, disk).Phone);
});
