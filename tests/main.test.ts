import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { hashText } from '../src/documents';

// Bundle the real plugin, replacing only its host, transport, and UI dependencies.
// The document protocol remains real; the hash hook controls its async boundary.
const root = fileURLToPath(new URL('../', import.meta.url));
let Plugin: any, MarkdownView: any, TFile: any, setHashHook: any;
before(async () => {
const result = await build({
  stdin: {
    contents: `export { default as Plugin } from ${JSON.stringify(root + 'main.ts')};
      export { MarkdownView, TFile } from 'obsidian';
      export { setHashHook } from './src/documents';`,
    resolveDir: root, loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  plugins: [{ name: 'mock-host', setup(builder) {
    builder.onResolve({ filter: /^(obsidian|socket\.io-client|\.\/src\/(client|view|documents))$/ }, args => ({ path: args.path, namespace: 'mock' }));
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => {
      if (args.path === './src/documents') return { contents: `
        export * from ${JSON.stringify(root + 'src/documents.ts')};
        import { hashText as realHash } from ${JSON.stringify(root + 'src/documents.ts')};
        let hook;
        export function setHashHook(value) { hook = value; }
        export async function hashText(text) { if (hook) await hook(); return realHash(text); }
      `, resolveDir: root };
      if (args.path === './src/client') return { contents: `export class RaftClientError extends Error {}
        export class RaftClient {
        constructor(transport, getSession, setSession) { this.publishSession = setSession; }
      }` };
      if (args.path === './src/view') return { contents: `export const VIEW_TYPE = 'raft-page'; export class RaftView {}` };
      if (args.path === 'socket.io-client') return { contents: `export function io() { return { on() {}, emit() {}, disconnect() {} }; }` };
      return { contents: `
        export class Plugin {
          constructor(app) { this.app = app; }
          async loadData() { return this.app.saved || {}; }
          async saveData(data) { this.app.saved = JSON.parse(JSON.stringify(data)); }
          registerEvent() {} registerView() {} addRibbonIcon() {} addCommand() {} addSettingTab() {}
        }
        export class TFile { constructor(path) { this.path = path; this.extension = 'md'; } }
        export class TFolder { constructor(path) { this.path = path; } }
        export class FuzzySuggestModal {} export class Menu {}
        export class MarkdownView {}
        export class ItemView {} export class WorkspaceLeaf {} export class Notice {}
        export class Modal {} export class Setting {} export class PluginSettingTab {}
        export function requestUrl() { throw new Error('Network access is forbidden in main tests'); }
        export function setIcon() {}
      ` };
    });
  } }],
});
const bundled = { exports: {} as any };
new Function('module', 'exports', 'require', result.outputFiles[0].text)(bundled, bundled.exports, createRequire(import.meta.url));
({ Plugin, MarkdownView, TFile, setHashHook } = bundled.exports);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function emitter() {
  const handlers = new Map<string, Array<(...args: any[]) => void>>();
  return {
    on(name: string, fn: (...args: any[]) => void) {
      const list = handlers.get(name) || []; list.push(fn); handlers.set(name, list);
    },
    emit(name: string, ...args: any[]) { for (const fn of handlers.get(name) || []) fn(...args); },
  };
}
const session = () => ({ apiUrl: 'https://raft.test', serverId: 'server-a', userId: 'alice', accessToken: 'secret-token', refreshToken: 'refresh-secret' });

async function fixture(open = true) {
  setHashHook(undefined);
  const files = new Map<string, any>();
  const disk = new Map<any, string>();
  const vaultEvents = emitter(), workspaceEvents = emitter();
  const file = new TFile('Notes/Original.md'); files.set(file.path, file); disk.set(file, 'original');
  const writes: Array<{ file: any; text: string }> = [];
  const view = new MarkdownView(); view.file = file;
  let text = 'original';
  view.editor = {
    getValue: () => text,
    setValue: (value: string) => { text = value; },
    offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
    somethingSelected: () => true,
    getCursor: (end: string) => ({ line: 0, ch: end === 'from' ? 0 : 3 }),
    posToOffset: (pos: { ch: number }) => pos.ch,
    transaction: ({ changes }: any) => { text = changes[0].text; writes.push({ file: view.file, text }); },
  };
  view.save = async () => { disk.set(view.file, text); };
  const leaves = open ? [{ view }] : [];
  const secrets = new Map<string, string>();
  const app: any = {
    vault: {
      ...vaultEvents, getName: () => 'Test Vault',
      getAbstractFileByPath: (path: string) => files.get(path),
      read: async (target: any) => disk.get(target),
      process: async (target: any, update: (current: string) => string) => {
        const next = update(disk.get(target)!); disk.set(target, next); writes.push({ file: target, text: next });
      },
    },
    workspace: { ...workspaceEvents, getActiveFile: () => file, getLeavesOfType: (type: string) => type === 'markdown' ? leaves : [] },
    secretStorage: { getSecret: (key: string) => secrets.get(key), setSecret: (key: string, value: string) => secrets.set(key, value) },
  };
  const plugin = new Plugin(app);
  await plugin.onload();
  await plugin.client.publishSession(session());
  const baseHash = await hashText('original');
  plugin.snapshots.doc = {
    id: 'doc', path: file.path, baseHash, channelId: 'channel-a', agent: 'writer', agentId: 'agent-a',
    userId: 'alice', apiUrl: 'https://raft.test', serverId: 'server-a', threadChannels: [], createdAt: new Date().toISOString(),
  };
  const proposal = { id: 'reply:0', documentId: 'doc', messageId: 'reply', path: file.path, baseHash, content: 'replacement', senderName: 'writer' };
  return { plugin, app, file, files, disk, view, leaves, writes, proposal, secrets, vaultEvents };
}

async function duringHash(f: Awaited<ReturnType<typeof fixture>>, mutate: () => void | Promise<void>) {
  const entered = deferred(), resume = deferred();
  setHashHook(async () => { entered.resolve(); await resume.promise; });
  const applying = f.plugin.applyProposal(f.proposal);
  await entered.promise;
  await mutate();
  resume.resolve();
  await assert.rejects(applying);
  assert.deepEqual(f.writes, []);
  setHashHook(undefined);
}

test('applies an unchanged original note through the editor and preserves an undo transaction', async () => {
  const f = await fixture();
  await f.plugin.applyProposal(f.proposal);
  assert.deepEqual(f.writes, [{ file: f.file, text: 'replacement' }]);
  assert.deepEqual(f.plugin.applied, ['reply:0']);
  await assert.rejects(f.plugin.applyProposal(f.proposal), /already been applied/);
});

test('refuses a pane switched to another note with identical text while hashing', async () => {
  const f = await fixture();
  await duringHash(f, () => { f.view.file = new TFile('Notes/Other.md'); });
});

test('refuses a replaced editor and user edits made while hashing', async () => {
  let f = await fixture();
  await duringHash(f, () => { f.view.editor = { ...f.view.editor }; });
  f = await fixture();
  await duringHash(f, () => { f.view.editor.setValue('user typed more'); });
  assert.equal(f.view.editor.getValue(), 'user typed more');
});

for (const [field, value] of [['userId', 'bob'], ['serverId', 'server-b'], ['apiUrl', 'https://other.test']] as const) {
  test(`refuses apply when ${field} changes during hashing`, async () => {
    const f = await fixture();
    await duringHash(f, () => f.plugin.client.publishSession({ ...session(), [field]: value }));
  });
}

test('sign out and back into the same account cancels an already pending apply', async () => {
  const f = await fixture();
  await duringHash(f, async () => { await f.plugin.signOut(); await f.plugin.client.publishSession(session()); });
});

test('unloading the plugin cancels an already pending apply', async () => {
  const f = await fixture();
  await duringHash(f, () => f.plugin.onunload());
});

test('token refresh for the same identity allows the pending apply', async () => {
  const f = await fixture();
  setHashHook(async () => { await f.plugin.client.publishSession({ ...session(), accessToken: 'refreshed' }); });
  await f.plugin.applyProposal(f.proposal);
  assert.equal(f.disk.get(f.file), 'replacement');
  setHashHook(undefined);
});

for (const event of ['rename', 'delete', 'folder-rename']) {
  test(`${event} invalidates snapshots before a same-path same-text replacement can be edited`, async () => {
    const f = await fixture();
    const oldPath = f.file.path;
    f.files.delete(oldPath);
    if (event === 'rename') { f.file.path = 'Archive.md'; f.vaultEvents.emit('rename', f.file, oldPath); }
    else if (event === 'delete') f.vaultEvents.emit('delete', f.file);
    else { f.file.path = 'Archive/Original.md'; f.vaultEvents.emit('rename', { path: 'Archive' }, 'Notes'); }
    const replacement = new TFile(oldPath); f.files.set(oldPath, replacement); f.disk.set(replacement, 'original');
    await assert.rejects(f.plugin.applyProposal(f.proposal), /no longer belongs|moved or deleted/);
    assert.deepEqual(f.writes, []);
    assert.equal(f.disk.get(replacement), 'original');
    await f.plugin.saveSettings();
    assert.equal(f.app.saved.snapshots.doc, undefined);
  });
}

test('rename during hashing invalidates an in-flight editor apply', async () => {
  const f = await fixture();
  await duringHash(f, () => { const old = f.file.path; f.file.path = 'Moved.md'; f.vaultEvents.emit('rename', f.file, old); });
});

test('closed-note process protects user text changed after the original read', async () => {
  const f = await fixture(false);
  const process = f.app.vault.process;
  f.app.vault.process = async (file: any, update: any) => { f.disk.set(file, 'new user text'); await process(file, update); };
  await assert.rejects(f.plugin.applyProposal(f.proposal), /changed while saving/);
  assert.equal(f.disk.get(f.file), 'new user text');
  assert.deepEqual(f.writes, []);
});

test('closed-note process rechecks account and file identity inside its callback', async () => {
  for (const change of ['account', 'file', 'unload']) {
    const f = await fixture(false);
    const process = f.app.vault.process;
    f.app.vault.process = async (file: any, update: any) => {
      if (change === 'account') await f.plugin.client.publishSession({ ...session(), userId: 'bob' });
      else if (change === 'file') f.files.set(file.path, new TFile(file.path));
      else f.plugin.onunload();
      await process(file, update);
    };
    await assert.rejects(f.plugin.applyProposal(f.proposal));
    assert.deepEqual(f.writes, []);
  }
});

for (const boundary of ['capture', 'agents', 'save']) {
  test(`account switch during pending send at ${boundary} never submits note content`, async () => {
    const f = await fixture();
    let sends = 0;
    const switchAccount = () => f.plugin.client.publishSession({ ...session(), userId: 'bob' });
    if (boundary === 'capture') setHashHook(switchAccount);
    f.plugin.client.agents = async () => { if (boundary === 'agents') await switchAccount(); return [{ id: 'agent-a', name: 'writer' }]; };
    f.plugin.client.send = async () => { sends++; return {}; };
    if (boundary === 'save') {
      const save = f.plugin.saveSettings.bind(f.plugin);
      f.plugin.saveSettings = async () => { await save(); await switchAccount(); };
    }
    await assert.rejects(f.plugin.send('channel-a', 'writer', 'edit', true, false), /account changed/);
    assert.equal(sends, 0);
    setHashHook(undefined);
  });
}

for (const boundary of ['capture', 'agents', 'save']) {
  test(`rename during pending send at ${boundary} refuses a same-path replacement`, async () => {
    const f = await fixture();
    let sends = 0;
    const rename = () => {
      const old = f.file.path;
      f.files.delete(old); f.file.path = 'Archive.md'; f.files.set(f.file.path, f.file);
      f.vaultEvents.emit('rename', f.file, old);
      const replacement = new TFile(old); f.files.set(old, replacement); f.disk.set(replacement, 'original');
    };
    if (boundary === 'capture') setHashHook(rename);
    f.plugin.client.agents = async () => { if (boundary === 'agents') rename(); return [{ id: 'agent-a', name: 'writer' }]; };
    f.plugin.client.send = async () => { sends++; return {}; };
    if (boundary === 'save') {
      const save = f.plugin.saveSettings.bind(f.plugin);
      let renamed = false;
      f.plugin.saveSettings = async () => {
        await save();
        if (!renamed) { renamed = true; rename(); }
      };
    }
    await assert.rejects(f.plugin.send('channel-a', 'writer', 'edit', true, false), /moved or deleted/);
    assert.equal(sends, 0);
    assert.deepEqual(f.writes, []);
    setHashHook(undefined);
  });
}

test('selection capture freezes offsets together with the original text before hashing', async () => {
  const f = await fixture();
  setHashHook(async () => { f.view.editor.getCursor = (end: string) => ({ line: 0, ch: end === 'from' ? 3 : 8 }); });
  const context = await f.plugin.captureDocument(true);
  assert.deepEqual(context.selection, { from: 0, to: 3 });
  assert.equal(context.content, 'ori');
  setHashHook(undefined);
});

test('normal attached sends persist the original binding before transport and omit text from plugin data', async () => {
  const f = await fixture();
  let sends = 0;
  f.plugin.client.agents = async () => [{ id: 'agent-a', name: 'writer' }];
  f.plugin.client.send = async (channel: string, body: string) => {
    sends++;
    assert.equal(channel, 'channel-a');
    assert.match(body, /📎 Obsidian note `Notes\/Original.md`/);
    assert.match(body, /original/);
    const snapshot: any = Object.values(f.app.saved.snapshots).find((value: any) => value.id !== 'doc');
    assert.equal(snapshot.userId, 'alice'); assert.equal(snapshot.serverId, 'server-a');
    assert.equal(snapshot.content, undefined);
    return {};
  };
  await f.plugin.send('channel-a', 'writer', 'edit', true, false);
  assert.equal(sends, 1);
});

test('attached notes travel as an uploaded file and the message keeps only a short note line', async () => {
  const f = await fixture();
  const uploads: any[] = [], sends: any[] = [];
  f.plugin.client.agents = async () => [{ id: 'agent-a', name: 'writer' }];
  f.plugin.client.uploadText = async (...args: any[]) => { uploads.push(args); return '00000000-0000-4000-8000-000000000001'; };
  f.plugin.client.send = async (...args: any[]) => { sends.push(args); return {}; };
  await f.plugin.send('channel-a', 'writer', 'edit', true, false);
  assert.deepEqual(uploads, [['channel-a', 'Original.md', 'original']]);
  const [, body, , attachmentIds] = sends[0];
  assert.deepEqual(attachmentIds, ['00000000-0000-4000-8000-000000000001']);
  assert.match(body, /^@writer edit\n\n\[raft-note\]: <> '📎 Obsidian note `Notes\/Original.md` — full text in the attached file\./);
  assert.doesNotMatch(body, /```markdown/);
  // An upload failure (for example no attachment storage) still sends, with the text inline.
  f.plugin.client.uploadText = async () => { throw new Error('no storage'); };
  await f.plugin.send('channel-a', 'writer', 'edit', true, false);
  assert.equal(sends[1][3], undefined);
  assert.match(sends[1][1], /full text below[\s\S]*```markdown\noriginal\n```$/);
});

test('two edit blocks in one message can independently update two original notes', async () => {
  const f = await fixture(false);
  const second = new TFile('Notes/Second.md'); f.files.set(second.path, second); f.disk.set(second, 'original');
  f.plugin.snapshots.second = { ...f.plugin.snapshots.doc, id: 'second', path: second.path };
  const block = (documentId: string, content: string) => '```raft-edit\n' + JSON.stringify({ documentId, content, baseHash: f.proposal.baseHash }) + '\n```';
  const message = { id: 'reply', senderId: 'agent-a', senderName: 'writer', channelId: 'channel-a', content: block('doc', 'first change') + '\n' + block('second', 'second change') };
  const proposals = f.plugin.proposals(message);
  assert.equal(proposals.length, 2);
  await f.plugin.applyProposal(proposals[0]);
  assert.deepEqual(f.plugin.proposals(message).map((p: any) => p.id), ['reply:1']);
  await f.plugin.applyProposal(proposals[1]);
  assert.equal(f.disk.get(f.file), 'first change');
  assert.equal(f.disk.get(second), 'second change');
  assert.deepEqual(f.plugin.proposals(message), []);
});

test('proposal eligibility enforces sender, channel, user, API, and server bindings', async () => {
  const f = await fixture();
  const message = { id: 'reply', senderId: 'agent-a', senderName: 'writer', channelId: 'channel-a', content: '```raft-edit\n' + JSON.stringify({ documentId: 'doc', baseHash: f.proposal.baseHash, content: 'change' }) + '\n```' };
  assert.equal(f.plugin.proposals(message).length, 1);
  for (const patch of [{ senderId: 'other-agent' }, { senderId: 'human-b', senderType: 'user' }, { channelId: 'other-channel' }]) assert.deepEqual(f.plugin.proposals({ ...message, ...patch }), []);
  // The agent picked in the selector need not be the one that answers, as long as Raft marks the sender as an agent.
  assert.equal(f.plugin.proposals({ ...message, senderId: 'other-agent', senderType: 'agent' }).length, 1);
  for (const patch of [{ userId: 'bob' }, { serverId: 'server-b' }, { apiUrl: 'https://other.test' }]) {
    await f.plugin.client.publishSession({ ...session(), ...patch });
    assert.deepEqual(f.plugin.proposals(message), []);
    await assert.rejects(f.plugin.applyProposal(f.proposal), /no longer belongs/);
  }
});

test('legacy whole-message applied records remain respected', async () => {
  const f = await fixture(); f.plugin.applied = ['reply'];
  await assert.rejects(f.plugin.applyProposal(f.proposal), /already been applied/);
  assert.deepEqual(f.writes, []);
});

test('agent edits apply automatically, once, unless turned off or superseded by a later send', async () => {
  const edit = (f: any) => ({ id: 'reply', senderId: 'agent-a', senderType: 'agent', senderName: 'writer', channelId: 'channel-a', createdAt: new Date().toISOString(),
    content: '```raft-edit\n' + JSON.stringify({ documentId: 'doc', baseHash: f.proposal.baseHash, content: 'auto' }) + '\n```' });
  let f = await fixture();
  f.plugin.autoApply(edit(f)); f.plugin.autoApply(edit(f));
  await f.plugin.applying;
  assert.deepEqual(f.writes, [{ file: f.file, text: 'auto' }]);

  f = await fixture();
  f.plugin.settings.autoApply = false;
  f.plugin.autoApply(edit(f));
  await f.plugin.applying;
  assert.deepEqual(f.writes, []);

  f = await fixture();
  f.plugin.snapshots.doc.createdAt = '2026-01-01T00:00:00Z';
  f.plugin.snapshots.newer = { ...f.plugin.snapshots.doc, id: 'newer', createdAt: '2026-02-01T00:00:00Z' };
  f.plugin.autoApply(edit(f));
  await f.plugin.applying;
  assert.deepEqual(f.writes, []);
});

test('a bound note only takes automatic edits from its own channel and bindings follow renames', async () => {
  const edit = (f: any) => ({ id: 'reply', senderId: 'agent-a', senderType: 'agent', senderName: 'writer', channelId: 'channel-a', createdAt: new Date().toISOString(),
    content: '```raft-edit\n' + JSON.stringify({ documentId: 'doc', baseHash: f.proposal.baseHash, content: 'auto' }) + '\n```' });
  const folder = (channelId: string) => ({ Notes: { channelId, channelName: channelId, serverId: 'server-a', kind: 'folder' } });
  let f = await fixture();
  f.plugin.bindings = folder('channel-b');
  f.plugin.autoApply(edit(f));
  await f.plugin.applying;
  assert.deepEqual(f.writes, []);
  assert.equal(f.plugin.proposals(edit(f)).length, 1, 'the edit is still offered as a card');

  f = await fixture();
  f.plugin.bindings = folder('channel-a');
  f.plugin.autoApply(edit(f));
  await f.plugin.applying;
  assert.deepEqual(f.writes, [{ file: f.file, text: 'auto' }]);

  f = await fixture();
  f.plugin.bindings = folder('channel-a');
  assert.equal(f.plugin.bindingFor()?.path, 'Notes');
  f.vaultEvents.emit('rename', { path: 'Archive' }, 'Notes');
  assert.deepEqual(Object.keys(f.plugin.bindings), ['Archive']);
  f.vaultEvents.emit('delete', { path: 'Archive' });
  assert.deepEqual(f.plugin.bindings, {});
});

test('a steward edits notes in its bound folder by path, creates notes there, and every applied change can be undone', async () => {
  const f = await fixture(false);
  f.app.vault.create = async (path: string, text: string) => { const file = new TFile(path); f.files.set(path, file); f.disk.set(file, text); return file; };
  f.app.vault.createFolder = async () => {};
  f.app.vault.trash = async (file: any) => { f.files.delete(file.path); };
  f.plugin.bindings = { Notes: { channelId: 'channel-a', channelName: 'a', serverId: 'server-a', kind: 'folder', stewardId: 'steward' } };
  const hash = await hashText('original');
  const block = (data: unknown) => '```raft-edit\n' + JSON.stringify(data) + '\n```';
  const message = (id: string, senderId: string, channelId: string, data: unknown) =>
    ({ id, senderId, senderType: 'agent', senderName: senderId, channelId, createdAt: new Date().toISOString(), content: block(data) });
  const edit = { path: 'Notes/Original.md', baseHash: hash, ops: [{ op: 'replace', find: 'original', with: 'synced' }] };

  f.plugin.autoApply(message('other', 'helper', 'channel-a', edit));
  await f.plugin.applying;
  assert.deepEqual(f.writes, [], 'another agent only gets a card');
  assert.equal(f.plugin.proposals(message('other', 'helper', 'channel-a', edit)).length, 1);
  assert.equal(f.plugin.proposals(message('elsewhere', 'steward', 'channel-b', edit)).length, 0, 'path edits only count in the bound channel');
  assert.equal(f.plugin.proposals(message('outside', 'steward', 'channel-a', { ...edit, path: 'Other/x.md' })).length, 0, 'and only inside the binding');

  f.plugin.autoApply(message('s1', 'steward', 'channel-a', edit));
  await f.plugin.applying;
  assert.equal(f.disk.get(f.file), 'synced');
  f.plugin.autoApply(message('s2', 'steward', 'channel-a', { path: 'Notes/New.md', create: true, content: '# New' }));
  await f.plugin.applying;
  assert.equal(f.disk.get(f.files.get('Notes/New.md')), '# New');

  assert.equal(f.plugin.undoable('s1').length, 1);
  await f.plugin.undo('s1:0');
  assert.equal(f.disk.get(f.file), 'original');
  await f.plugin.undo('s2:0');
  assert.equal(f.files.has('Notes/New.md'), false);

  f.plugin.bindings.Notes.paused = true;
  f.plugin.autoApply(message('s3', 'steward', 'channel-a', { ...edit, baseHash: await hashText('original') }));
  await f.plugin.applying;
  assert.equal(f.disk.get(f.file), 'original', 'a paused steward\'s edits wait as cards');
});

test('background polling applies steward edits in unopened ordinary threads, including old roots and reply pages', async () => {
  const f = await fixture(false);
  f.plugin.settings.channelId = 'some-other-channel';
  f.plugin.bindings = { Notes: { channelId: 'channel-a', channelName: 'a', serverId: 'server-a', kind: 'folder', stewardId: 'steward' } };
  // No quiet interval has passed, and the thread root is an agent message with no attached note metadata.
  const root = { id: 'old-root', seq: 1, senderId: 'helper', content: 'An ordinary discussion', senderName: 'helper',
    createdAt: new Date().toISOString(), threadSummary: { replyCount: 51, lastReplyAt: new Date().toISOString() } };
  const edit = { id: 'thread-edit', seq: 2, senderId: 'steward', senderType: 'agent', senderName: 'steward',
    content: '```raft-edit\n' + JSON.stringify({ path: f.file.path, baseHash: f.proposal.baseHash,
      ops: [{ op: 'append', content: '98 links' }] }) + '\n```' };
  const filler = (n: number, prefix: string) => Array.from({ length: 50 }, (_, i) => ({ id: `${prefix}-${i}`, seq: n + i, content: 'chat', senderName: 'helper' }));
  let channelReads = 0, threadReads = 0;
  f.plugin.client.threadChannel = async (_channel: string, id: string) => id === root.id ? 'ordinary-thread' : null;
  f.plugin.client.messages = async (channel: string, options: any) => {
    if (channel === 'channel-a') {
      channelReads++;
      return options.before ? { messages: [root], hasMore: false }
        : { messages: filler(100, 'root'), hasMore: true };
    }
    assert.equal(channel, 'ordinary-thread'); threadReads++;
    return options.before ? { messages: [edit], hasMore: false }
      : { messages: filler(200, 'reply'), hasMore: true };
  };
  await f.plugin.syncTick();
  assert.equal(f.disk.get(f.file), 'original\n\n98 links\n');
  assert.ok(channelReads >= 2 && threadReads === 2);
  await f.plugin.syncTick();
  await f.plugin.scanThread('channel-a', root);
  assert.equal(f.writes.length, 1, 'polling and opening the same thread never apply twice');
  assert.equal(threadReads, 2, 'unchanged thread summaries do not reread replies');
  assert.equal(f.plugin.undoable('thread-edit').length, 1);
});

test('a paused binding sharing a channel is rescanned after resuming without new replies', async () => {
  const f = await fixture(false);
  f.plugin.bindings = {
    Notes: { channelId: 'channel-a', channelName: 'a', serverId: 'server-a', kind: 'folder', stewardId: 'steward', paused: true },
    Other: { channelId: 'channel-a', channelName: 'a', serverId: 'server-a', kind: 'folder', stewardId: 'helper' },
  };
  const root = { id: 'root', content: '', senderName: 'helper', threadSummary: { replyCount: 1 } };
  const reply = { id: 'reply', senderId: 'steward', senderType: 'agent', senderName: 'steward', content: '```raft-edit\n' +
    JSON.stringify({ path: f.file.path, baseHash: f.proposal.baseHash, content: 'resumed' }) + '\n```' };
  f.plugin.client.threadChannel = async () => 'thread';
  f.plugin.client.messages = async () => ({ messages: [reply], hasMore: false });
  await f.plugin.scanThread('channel-a', root); await f.plugin.applying;
  assert.deepEqual(f.writes, []);
  f.plugin.bindings.Notes.paused = false;
  await f.plugin.scanThread('channel-a', root); await f.plugin.applying;
  assert.equal(f.disk.get(f.file), 'resumed');
});

test('ordinary thread discovery retries failures and missing threads with an unchanged summary', async () => {
  const f = await fixture(false);
  f.plugin.bindings = { Notes: { channelId: 'channel-a', channelName: 'a', serverId: 'server-a', kind: 'folder', stewardId: 'steward' } };
  const root = { id: 'root', content: '', senderName: 'helper', threadSummary: { replyCount: 1 } };
  let missing = true, fail = true, reads = 0;
  f.plugin.client.threadChannel = async () => missing ? null : 'thread';
  f.plugin.client.messages = async () => {
    reads++;
    if (fail) throw new Error('temporary');
    return { messages: [], hasMore: false };
  };
  await f.plugin.scanThread('channel-a', root);
  missing = false;
  await assert.rejects(f.plugin.scanThread('channel-a', root), /temporary/);
  fail = false;
  await Promise.all([f.plugin.scanThread('channel-a', root), f.plugin.scanThread('channel-a', root)]);
  assert.equal(reads, 2, 'failure retried, simultaneous scans share one successful read');
});

for (const blocked of ['disabled', 'paused', 'other-agent', 'stale', 'other-server', 'changed-account', 'unloaded']) {
  test(`background thread updates refuse writes when ${blocked}`, async () => {
    const f = await fixture(false);
    f.plugin.bindings = { Notes: { channelId: 'channel-a', channelName: 'a', serverId: 'server-a', kind: 'folder', stewardId: 'steward',
      paused: blocked === 'paused' } };
    if (blocked === 'disabled') f.plugin.settings.autoApply = false;
    if (blocked === 'other-server') f.plugin.bindings.Notes.serverId = 'other-server';
    const root = { id: 'root', seq: 1, content: '', senderName: 'helper', createdAt: new Date().toISOString(), threadSummary: { replyCount: 1 } };
    const edit = { id: 'reply', seq: 2, senderId: blocked === 'other-agent' ? 'helper' : 'steward', senderType: 'agent', senderName: 'steward',
      content: '```raft-edit\n' + JSON.stringify({ path: f.file.path,
        baseHash: blocked === 'stale' ? 'b'.repeat(64) : f.proposal.baseHash, content: 'changed' }) + '\n```' };
    f.plugin.client.threadChannel = async () => 'thread';
    f.plugin.client.messages = async (channel: string) => {
      if (channel === 'channel-a') return { messages: [root], hasMore: false };
      if (blocked === 'changed-account') f.plugin.session = { ...session(), userId: 'other-user' };
      if (blocked === 'unloaded') f.plugin.onunload();
      return { messages: [edit], hasMore: false };
    };
    await f.plugin.syncTick().catch(() => {});
    await f.plugin.applying;
    assert.deepEqual(f.writes, []);
  });
}

test('background updates follow edit order across roots and retain cross-page summaries despite history limits', async () => {
  const f = await fixture(false);
  f.plugin.bindings = { Notes: { channelId: 'channel-a', channelName: 'a', serverId: 'server-a', kind: 'folder', stewardId: 'steward' } };
  const makeEdit = (id: string, seq: number, baseHash: string, content: string) => ({ id, seq, senderId: 'steward', senderType: 'agent', senderName: 'steward',
    content: '```raft-edit\n' + JSON.stringify({ path: f.file.path, baseHash, content }) + '\n```' });
  const a = makeEdit('first', 100, f.proposal.baseHash, 'first');
  const b = makeEdit('second', 200, await hashText('first'), 'second');
  f.plugin.client.threadChannel = async (_c: string, root: string) => root === 'bad-root' ? Promise.reject(new Error('403')) : 'thread';
  f.plugin.client.messages = async (channel: string, options: any) => channel === 'thread' ? { messages: [b], hasMore: false }
    : options.before ? { messages: [
      { id: 'bad-root', seq: 0, content: '', senderName: 'helper', threadSummary: { replyCount: 1 } },
      { id: 'old-root', seq: 1, content: '', senderName: 'helper' }], hasMore: false }
    : { messages: [a], hasMore: true, historyLimited: true, threadSummariesByParentMessageId: { 'old-root': { replyCount: 1 } } };
  await f.plugin.syncTick();
  assert.equal(f.disk.get(f.file), 'second');
  assert.deepEqual(f.writes.map(w => w.text), ['first', 'second']);
});

test('temporarily disabled queued edits can be retried after resuming', async () => {
  const f = await fixture(false);
  f.plugin.bindings = { Notes: { channelId: 'channel-a', channelName: 'a', serverId: 'server-a', kind: 'folder', stewardId: 'steward' } };
  const edit = { id: 'reply', senderId: 'steward', senderType: 'agent', senderName: 'steward', channelId: 'channel-a', content: '```raft-edit\n' +
    JSON.stringify({ path: f.file.path, baseHash: f.proposal.baseHash, content: 'resumed' }) + '\n```' };
  const gate = deferred(); f.plugin.applying = gate.promise;
  f.plugin.autoApply(edit);
  f.plugin.settings.autoApply = false; gate.resolve();
  await f.plugin.applying;
  assert.deepEqual(f.writes, []);
  f.plugin.settings.autoApply = true;
  f.plugin.autoApply(edit); await f.plugin.applying;
  assert.equal(f.disk.get(f.file), 'resumed');
});

test('a note restored at startup is attached even without a file-open event', async () => {
  const f = await fixture();
  let active: any = null;
  f.app.workspace.getActiveFile = () => active;
  const plugin = new Plugin(f.app);
  await plugin.onload();
  assert.equal(plugin.getAttachedName(), null);
  active = f.file;
  assert.equal(plugin.getAttachedName(), 'Notes/Original.md');
});

test('credentials use SecretStorage and never enter plugin data', async () => {
  const f = await fixture();
  await f.plugin.saveSettings();
  assert.ok([...f.secrets.values()].some(value => value.includes('secret-token')));
  assert.doesNotMatch(JSON.stringify(f.app.saved), /secret-token|refresh-secret|accessToken|refreshToken/);
  await f.plugin.signOut();
  assert.ok([...f.secrets.values()].every(value => value === ''));
});
