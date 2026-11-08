import test from 'node:test';
import assert from 'node:assert/strict';
import { composeSyncRequest, syncRootMessage, lastSyncedThrough, newActivity, parseNeeds } from '../src/sync';

const at = (min: number) => new Date(Date.UTC(2026, 10, 5, 2, min)).toISOString();
const msg = (id: string, min: number, extra: Record<string, unknown> = {}) => ({ id, content: 'hi', senderName: 'x', senderId: 'human', createdAt: at(min), ...extra }) as any;

test('new activity skips the sync thread, the steward, bind notices and old messages, and reads 📌/🚫', () => {
  const since = Date.parse(at(10));
  const messages = [
    msg('old', 5), msg('root', 11), msg('steward', 12, { senderId: 'st' }), msg('notice', 12, { content: '📁 This channel is now bound to the Obsidian note `x`' }),
    msg('new', 13, { seq: 41 }), msg('pin', 14, { seq: 42, raw: { reactions: [{ emoji: '📌', count: 1 }] } }),
    msg('skip', 15, { raw: { reactions: [{ emoji: '🚫', count: 1 }] } }),
    msg('threaded', 1, { threadSummary: { replyCount: 2, lastReplyAt: at(16), latestReplies: [{ senderId: 'human', senderName: 'h', preview: '' }] } }),
    msg('stewardThread', 1, { threadSummary: { replyCount: 1, lastReplyAt: at(17), latestReplies: [{ senderId: 'st', senderName: 's', preview: '' }] } }),
  ];
  const a = newActivity(messages, undefined, since, { rootId: 'root', stewardId: 'st' });
  assert.deepEqual(a.messages.map(m => m.id), ['new', 'pin']);
  assert.deepEqual(a.threads, ['threaded']);
  assert.deepEqual(a.pinned, ['pin']);
  assert.deepEqual(a.excluded, ['skip']);
  assert.equal(a.latest, Date.parse(at(16)));
  assert.equal(newActivity(messages, undefined, Date.parse(at(20)), { rootId: 'root', stewardId: 'st' }).latest, 0);
});

test('requests carry a marker any device can read back, and steward file requests are parsed', () => {
  const content = composeSyncRequest({ steward: 'scribe', binding: 'product', kind: 'folder', vault: 'V', channelName: 'c', since: Date.parse(at(10)), through: Date.parse(at(16)),
    activity: { latest: 0, messages: [msg('a', 13, { seq: 41 }), msg('b', 14, { seq: 45 })], threads: ['threaded-root-id'], pinned: [], excluded: [] },
    files: [{ path: 'product/a.md', hash: 'h1' }], attached: ['product/a.md'] });
  assert.equal(content.split('\n')[0], '@scribe 📝 sync · msgs seq 41–45 · threads threaded');
  assert.equal(content.split('\n')[1], 'notes: product/a.md@h1 (attached)');
  assert.ok(content.split('\n').length <= 5, 'a request stays a few lines');
  assert.equal(lastSyncedThrough([{ id: 'r', content, senderName: 'me' }, { id: 'o', content: '```raft-sync\n{"binding":"other","through":"' + at(30) + '"}\n```', senderName: 'me' }], 'product'), Date.parse(at(16)));
  assert.deepEqual(parseNeeds('Need these:\n```raft-need\n{"paths":["product/b.md", 3]}\n```'), ['product/b.md']);
});

test('the sync thread opens with the steward brief addressed to the steward', () => {
  const root = syncRootMessage('product', 'scribe', 'plan');
  assert.ok(root.startsWith('📝 Document sync for `product` (#plan) · steward @scribe'));
  for (const part of ['do not reply', 'replace_section', 'raft-need', 'baseHash', 'vault-relative', 'Missing or stale cache', 'Confirm the response']) assert.ok(root.includes(part), part);
  assert.ok(root.includes('Reads and edits work here and in #plan or its threads'));
  for (const part of ['文档规范', 'instead of appending corrections', '未核实', '变更记录', 'doc/<type>']) assert.ok(root.includes(part), part);
  assert.ok(root.split('\n').length === 3 && root.length < 1800, 'kept short: it is shown with every request');
});

test('sync openers and requests, even ones posted in the channel by older versions, are not conversation', () => {
  const marker = '```raft-sync\n{"binding":"p","through":"' + at(12) + '"}\n```';
  const a = newActivity([msg('req', 12, { content: '@s 📝 sync\n' + marker }), msg('open', 12, { content: '📝 Document sync for `p` · steward @s' }), msg('real', 13)],
    undefined, Date.parse(at(10)), {});
  assert.deepEqual(a.messages.map(m => m.id), ['real']);
});
