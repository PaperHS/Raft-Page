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
        async revoke(session) { (this.revoked ||= []).push(session); }
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

async function readFixture(open = false) {
  const f = await fixture(open);
  f.plugin.bindings = { Notes: { channelId: 'channel-a', channelName: 'a', serverId: 'server-a', kind: 'folder', stewardId: 'steward', stewardName: 'steward' } };
  const uploads: any[][] = [], sends: any[][] = [];
  f.plugin.client.uploadText = async (...args: any[]) => { uploads.push(args); return 'attachment-1'; };
  f.plugin.client.send = async (...args: any[]) => { sends.push(args); return { id: 'receipt' }; };
  f.plugin.client.ensureThread = async () => 'request-thread';
  // The reply conversation holds what this plugin already posted there.
  f.plugin.client.messages = async () => ({ messages: sends.map((args, i) => ({ id: `posted-${i}`, seq: 100 + i, channelId: args[0], senderId: 'alice', content: args[1] })) });
  const request = (paths = [f.file.path], extra: any = {}) => ({ id: 'need-1', seq: 1, channelId: 'channel-a', senderId: 'steward',
    senderType: 'agent', senderName: 'steward', createdAt: new Date().toISOString(),
    content: '```raft-need\n' + JSON.stringify({ paths }) + '\n```', ...extra });
  return { ...f, uploads, sends, request };
}

test('channel read requests use current editor text and reply in a thread without automatic edits enabled', async () => {
  const f = await readFixture(true);
  f.plugin.settings.autoApply = false;
  f.plugin.settings.channelId = 'unrelated-channel';
  f.view.editor.setValue('current unsaved text');
  f.plugin.client.messages = async () => ({ messages: [f.request()], hasMore: false });
  await f.plugin.syncTick();
  assert.deepEqual(f.uploads, [['request-thread', 'Original.md', 'current unsaved text']]);
  assert.equal(f.sends[0][0], 'request-thread');
  assert.match(f.sends[0][1], new RegExp(await hashText('current unsaved text')));
  assert.deepEqual(f.sends[0][3], ['attachment-1']);
  assert.equal(f.disk.get(f.file), 'original');
  assert.deepEqual(f.writes, []);
  await f.plugin.syncTick();
  assert.equal(f.sends.length, 1, 'a completed request does not upload or reply twice');
});

test('read requests under ordinary roots work without opening the thread and keep replies in that thread', async () => {
  const f = await readFixture();
  f.plugin.settings.autoApply = false;
  const root = { id: 'ordinary-root', seq: 1, senderName: 'helper', content: 'Discuss the plan', threadSummary: { replyCount: 1 } };
  f.plugin.client.threadChannel = async () => 'ordinary-thread';
  f.plugin.client.ensureThread = async () => { throw new Error('must not create a nested thread'); };
  f.plugin.client.messages = async (channel: string) => ({ messages: channel === 'channel-a' ? [root]
    : [f.request(undefined, { channelId: undefined })], hasMore: false });
  await f.plugin.syncTick();
  assert.equal(f.uploads[0][0], 'ordinary-thread');
  assert.equal(f.sends[0][0], 'ordinary-thread');
  await f.plugin.syncTick();
  assert.equal(f.sends.length, 1);
});

test('existing sync-DM reads still return full hashes and file attachments', async () => {
  const f = await readFixture();
  Object.assign(f.plugin.bindings.Notes, { syncChannelId: 'dm', syncRootId: 'sync-root' });
  f.plugin.client.threadChannel = async () => 'sync-thread';
  f.plugin.client.messages = async (channel: string) => ({ messages: channel === 'sync-thread'
    ? [f.request(undefined, { channelId: 'sync-thread' })] : [], hasMore: false });
  await f.plugin.syncTick();
  assert.deepEqual(f.uploads, [['sync-thread', 'Original.md', 'original']]);
  assert.match(f.sends[0][1], new RegExp(await hashText('original')));
});

for (const denied of ['other-agent', 'other-server', 'paused', 'other-channel', 'other-sync-binding']) {
  test(`read requests disclose no note when ${denied}`, async () => {
    const f = await readFixture();
    const request = f.request(undefined, { senderId: denied === 'other-agent' ? 'helper' : 'steward' });
    if (denied === 'other-server') f.plugin.bindings.Notes.serverId = 'another';
    if (denied === 'paused') f.plugin.bindings.Notes.paused = true;
    if (denied === 'other-channel') request.channelId = 'channel-b';
    await f.plugin.answerNeeds(request, denied === 'other-channel' ? 'channel-b' : 'channel-a', denied === 'other-sync-binding' ? 'Other' : undefined);
    assert.deepEqual(f.uploads, []);
    assert.deepEqual(f.sends, []);
  });
}

test('read scope follows the nearest binding and reports missing or invalid paths without reading them', async () => {
  const f = await readFixture();
  f.plugin.bindings['Notes/Private'] = { ...f.plugin.bindings.Notes, channelId: 'private', stewardId: 'someone-else' };
  await f.plugin.answerNeeds(f.request(['../secret.md', '/tmp/secret.md', 'Notes/Private/x.md', 'Notes/Missing.md', 'Other.md']), 'channel-a');
  assert.deepEqual(f.uploads, []);
  assert.match(f.sends[0][1], /note not found in this binding/);
  assert.match(f.sends[0][1], /not available in this binding/);
});

test('failed uploads get an accurate receipt and retry until delivery succeeds without repeated warnings', async () => {
  const f = await readFixture();
  let fail = true, attempts = 0;
  f.plugin.client.uploadText = async () => { attempts++; if (fail) throw new Error('offline'); return 'file'; };
  await f.plugin.answerNeeds(f.request(), 'channel-a');
  assert.match(f.sends[0][1], /attachment upload failed; the plugin will retry/);
  assert.doesNotMatch(f.sends[0][1], /not available/);
  assert.equal(f.plugin.sentHashes.Notes, undefined);
  await f.plugin.answerNeeds(f.request(), 'channel-a');
  assert.equal(f.sends.length, 1, 'the same failure receipt is not repeated');
  fail = false;
  await f.plugin.answerNeeds(f.request(), 'channel-a');
  assert.equal(f.sends.length, 2);
  assert.deepEqual(f.sends[1][3], ['file']);
  assert.equal(f.plugin.sentHashes.Notes[f.file.path], await hashText('original'));
  await f.plugin.answerNeeds(f.request(), 'channel-a');
  assert.equal(attempts, 3);
});

test('a failed response does not complete a read request, so the next pass retries', async () => {
  const f = await readFixture();
  let attempts = 0;
  f.plugin.client.send = async () => { if (++attempts === 1) throw new Error('response dropped'); return { id: 'ok' }; };
  await f.plugin.answerNeeds(f.request(), 'channel-a');
  assert.equal(f.plugin.sentHashes.Notes, undefined);
  await f.plugin.answerNeeds(f.request(), 'channel-a');
  assert.equal(attempts, 2);
  assert.equal(f.plugin.sentHashes.Notes[f.file.path], await hashText('original'));
});

test('an empty note is represented explicitly with its real hash, without an invalid empty upload', async () => {
  const f = await readFixture(true);
  f.view.editor.setValue('');
  await f.plugin.answerNeeds(f.request(), 'channel-a');
  assert.deepEqual(f.uploads, []);
  assert.match(f.sends[0][1], /empty note \(0 bytes\)/);
  assert.ok(f.sends[0][1].includes(await hashText('')));
});

for (const change of ['account', 'unbind', 'pause', 'unload']) {
  test(`a read is not sent if ${change} occurs during its upload`, async () => {
    const f = await readFixture();
    f.plugin.client.uploadText = async () => {
      if (change === 'account') f.plugin.session = { ...session(), userId: 'bob' };
      if (change === 'unbind') f.plugin.bindings = {};
      if (change === 'pause') f.plugin.bindings.Notes.paused = true;
      if (change === 'unload') f.plugin.onunload();
      return 'attachment';
    };
    await f.plugin.answerNeeds(f.request(), 'channel-a');
    assert.deepEqual(f.sends, []);
  });
}

test('changing the steward resets delivered hashes so a new steward receives the current note', async () => {
  const f = await readFixture();
  f.plugin.sentHashes.Notes = { [f.file.path]: 'already-sent-to-old-steward' };
  await f.plugin.setSteward('Notes', { id: 'new', name: 'new' });
  assert.equal(f.plugin.sentHashes.Notes, undefined);
});

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
  assert.deepEqual(f.writes, [], 'only the steward changes the notes');
  assert.equal(f.plugin.proposals(message('other', 'helper', 'channel-a', edit)).length, 0, 'and nobody is asked to apply another agent\'s edit');
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

  // Without a steward, any agent in the bound channel may change the notes; no card for the user either.
  delete f.plugin.bindings.Notes.stewardId; delete f.plugin.bindings.Notes.paused;
  f.plugin.autoApply(message('h1', 'helper', 'channel-a', { ...edit, baseHash: await hashText('original') }));
  await f.plugin.applying;
  assert.equal(f.disk.get(f.file), 'synced');
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

test('switching server keeps the account tokens, moves the session and settings, and cancels pending work', async () => {
  const f = await fixture();
  f.plugin.settings.channelId = 'channel-a'; f.plugin.settings.agent = 'writer'; f.plugin.settings.apiUrl = 'https://raft.test';
  await f.plugin.switchServer({ id: 'server-b', slug: 'bee', name: 'Bee' });
  assert.equal(f.plugin.session.serverId, 'server-b');
  assert.equal(f.plugin.session.serverSlug, 'bee');
  assert.equal(f.plugin.session.serverName, 'Bee');
  assert.equal(f.plugin.session.accessToken, 'secret-token');
  assert.equal(f.plugin.settings.serverId, 'server-b');
  assert.equal(f.plugin.settings.serverSlug, 'bee');
  assert.equal(f.plugin.settings.channelId, '');
  assert.equal(f.plugin.settings.agent, '');
  const stored = JSON.parse([...f.secrets.values()][0]);
  assert.equal(stored.serverId, 'server-b');
  // The stored session still matches settings, so it is restored after a restart.
  const again = new Plugin(f.app); await again.onload();
  assert.equal(again.session?.serverId, 'server-b');
  // A note snapshot taken on the old server is no longer applicable.
  await assert.rejects(f.plugin.applyProposal(f.proposal));
});

test('sign out revokes the old refresh token after clearing the local session', async () => {
  const f = await fixture();
  await f.plugin.signOut();
  assert.equal(f.plugin.session, undefined);
  assert.equal(f.plugin.client.revoked?.[0]?.refreshToken, 'refresh-secret');
  await f.plugin.signOut();
  assert.equal(f.plugin.client.revoked.length, 1, 'nothing to revoke when already signed out');
});

test('a read request answered by another device or sign-in is not answered again', async () => {
  const replies = (thread: any[]) => async (channelId: string) => ({ messages: channelId === 'request-thread' ? thread : [], hasMore: false });
  const answered = async (thread: any[]) => {
    const f = await readFixture();
    const request = f.request();
    f.plugin.client.messages = async (channelId: string) => channelId === 'channel-a' ? { messages: [request], hasMore: false } : replies(thread)(channelId);
    await f.plugin.syncTick();
    return f;
  };
  // Another device posted a complete receipt carrying the marker.
  assert.equal((await answered([{ id: 'r', seq: 5, senderId: 'other-user', content: "@steward Requested notes\n\n[raft-need]: <> 'need-1'" }])).sends.length, 0);
  // A receipt from a version before the marker, by this account, for this sender.
  assert.equal((await answered([{ id: 'r', seq: 5, senderId: 'alice', content: '@steward Requested notes (path · sha256):\n- Notes/Original.md · abc · attached.' }])).sends.length, 0);
  // A failed receipt still gets a complete answer, and that answer carries the marker for every device.
  const retried = await answered([{ id: 'r', seq: 5, senderId: 'alice', content: '@steward Requested notes (path · sha256):\n- Notes/Original.md: read failed; the plugin will retry.' }]);
  assert.equal(retried.sends.length, 1);
  assert.ok(retried.sends[0][1].endsWith("\n\n[raft-need]: <> 'need-1'"));
  // A marker for a different request does not count.
  assert.equal((await answered([{ id: 'r', seq: 5, senderId: 'other-user', content: "[raft-need]: <> 'need-0'" }])).sends.length, 1);
});

test('a steward edit posted in an earlier sync thread for the same note is still applied, and read once', async () => {
  const f = await readFixture();
  Object.assign(f.plugin.bindings.Notes, { syncChannelId: 'dm', syncRootId: 'new-root', syncBrief: 5 });
  const edit = '```raft-edit\n' + JSON.stringify({ path: f.file.path, baseHash: await hashText('original'), content: 'updated by steward' }) + '\n```';
  const oldRoot = { id: 'old-root', seq: 1, channelId: 'dm', senderId: 'alice', content: '📝 Document sync for `Notes` (#a) · steward @steward',
    createdAt: new Date().toISOString(), threadSummary: { replyCount: 1, lastReplyAt: '2026-11-06T13:38:00Z' } };
  const otherNote = { ...oldRoot, id: 'other-root', content: '📝 Document sync for `Elsewhere` (#b) · steward @steward' };
  const reads: string[] = [];
  f.plugin.client.threadChannel = async (_dm: string, root: string) => { reads.push(root); return `${root}-thread`; };
  f.plugin.client.messages = async (channel: string) => ({ hasMore: false, messages: channel === 'dm' ? [oldRoot, otherNote]
    : channel === 'old-root-thread' ? [{ id: 'reply', seq: 2, channelId: channel, senderId: 'steward', senderType: 'agent', senderName: 'steward',
      content: edit, createdAt: new Date().toISOString() }] : [] });
  await f.plugin.syncTick();
  assert.equal(f.disk.get(f.file), 'updated by steward');
  assert.ok(!reads.includes('other-root'), 'sync threads for other notes are not read');
  const before = reads.filter(r => r === 'old-root').length;
  await f.plugin.syncTick();
  assert.equal(reads.filter(r => r === 'old-root').length, before, 'an unchanged earlier thread is not read again');
});

test('replies to a note sent from another device apply here when the note is bound to that conversation', async () => {
  const { composeMessage } = await import('../src/documents');
  const sendFrom = (f: any, senderId = 'alice', channelId = 'channel-a') => ({ id: 'send', seq: 1, senderId, senderType: 'user', channelId,
    createdAt: new Date().toISOString(), content: composeMessage('writer', 'tidy it', { id: 'phone-doc', path: f.file.path, content: 'original', baseHash: f.proposal.baseHash }, true) });
  const reply = (f: any, extra: any = {}) => ({ id: 'reply', seq: 2, senderId: 'agent-b', senderType: 'agent', senderName: 'writer', channelId: 'channel-a',
    createdAt: new Date().toISOString(), content: '```raft-edit\n' + JSON.stringify({ documentId: 'phone-doc', baseHash: f.proposal.baseHash, content: 'from phone' }) + '\n```', ...extra });
  const bound = (f: any) => { f.plugin.snapshots = {}; f.plugin.bindings = { Notes: { channelId: 'channel-a', channelName: 'a', serverId: 'server-a', kind: 'folder' } }; };
  const store = new Map<string, string>();
  const adapter = { list: async () => ({ files: [...store.keys()], folders: [] }), read: async (p: string) => store.get(p)!, write: async (p: string, t: string) => { store.set(p, t); },
    exists: async (p: string) => store.has(p), mkdir: async () => {} };

  let f = await fixture();
  bound(f);
  f.plugin.autoApply(sendFrom(f)); f.plugin.autoApply(reply(f));
  await f.plugin.applying;
  assert.deepEqual(f.writes, [{ file: f.file, text: 'from phone' }]);

  // Not this account's send, not bound to the conversation, or answered in another channel: no change, no card.
  for (const [send, setup, extra] of [['bob', bound, {}], ['alice', (f: any) => { f.plugin.snapshots = {}; }, {}], ['alice', bound, { channelId: 'channel-b' }]] as const) {
    f = await fixture();
    setup(f);
    f.plugin.autoApply(sendFrom(f, send)); f.plugin.autoApply(reply(f, extra));
    await f.plugin.applying;
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.plugin.proposals(reply(f, extra)), []);
  }

  // Applied on this device: recorded for the other devices. Applied on another device: skipped here.
  f = await fixture();
  bound(f); f.app.vault.adapter = adapter; f.app.vault.configDir = '.obsidian';
  f.plugin.autoApply(sendFrom(f)); f.plugin.autoApply(reply(f));
  await f.plugin.applying; await new Promise(r => setTimeout(r, 0));
  const [record] = [...store.keys()];
  assert.match(record, /^\.obsidian\/plugins\/raft-page\/applied-[a-z0-9-]+\.json$/);
  assert.deepEqual(JSON.parse(store.get(record)!), ['reply:0']);
  store.set('.obsidian/plugins/raft-page/applied-other-device.json', store.get(record)!); store.delete(record);
  f = await fixture();
  bound(f); f.app.vault.adapter = adapter; f.app.vault.configDir = '.obsidian';
  await f.plugin.loadSharedApplied();
  f.plugin.autoApply(sendFrom(f)); f.plugin.autoApply(reply(f));
  await f.plugin.applying;
  assert.deepEqual(f.writes, []);
});

test('a new channel for a note is created with its agents, bound, announced, and gets the first agent as steward', async () => {
  const f = await fixture();
  const created: any[] = [], sends: any[] = [];
  f.plugin.client.createChannel = async (...args: any[]) => { created.push(args); return { id: 'new-ch', name: 'original' }; };
  f.plugin.client.send = async (...args: any[]) => { sends.push(args); return { id: 'notice' }; };
  f.plugin.client.agents = async () => { throw new Error('the steward is chosen in the dialog, not looked up'); };
  const store = new Map<string, string>();
  f.app.vault.adapter = { exists: async (p: string) => store.has(p), mkdir: async () => {}, write: async (p: string, t: string) => { store.set(p, t); }, read: async (p: string) => store.get(p)! };
  f.app.vault.configDir = '.obsidian';
  await f.plugin.createChannelFor(f.file, 'original', [{ id: 'agent-h', name: 'holiday' }, { id: 'agent-c', name: 'cool' }], true);
  assert.deepEqual(created[0][0], 'original');
  assert.deepEqual({ private: created[0][1].private, agentIds: created[0][1].agentIds }, { private: true, agentIds: ['agent-h', 'agent-c'] });
  const binding = f.plugin.bindings['Notes/Original.md'];
  assert.equal(binding.channelId, 'new-ch'); assert.equal(binding.kind, 'file');
  assert.equal(binding.stewardId, 'agent-h');
  assert.equal(sends[0][0], 'new-ch'); assert.match(sends[0][1], /now bound to the Obsidian note `Notes\/Original.md`/);
});

test('a sync pass that never finishes stops blocking background syncing after a few minutes', async () => {
  const f = await fixture(false);
  f.plugin.bindings = { Notes: { channelId: 'channel-a', channelName: 'a', serverId: 'server-a', kind: 'folder', stewardId: 'steward', stewardName: 'steward', paused: true } };
  let reads = 0;
  f.plugin.client.messages = async () => { reads++; return { messages: [] }; };
  (f.plugin as any).syncing = Date.now() - 60_000;
  await f.plugin.syncTick();
  assert.equal(reads, 0, 'a recent pass is still running');
  (f.plugin as any).syncing = Date.now() - 6 * 60_000;
  f.plugin.bindings.Notes.paused = undefined;
  await f.plugin.syncTick().catch(() => {});
  assert.ok(reads > 0, 'a stalled pass no longer blocks');
  assert.equal((f.plugin as any).syncing, 0);
});
