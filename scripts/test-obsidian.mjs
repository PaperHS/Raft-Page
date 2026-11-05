import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, copyFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../', import.meta.url));
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
const mock = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/attachments/upload') {
    // Minimal multipart read, enough to check what Raft's multer route would receive.
    const channelId = /name="channelId"\r\n\r\n([^\r]*)/.exec(raw)?.[1];
    const file = /name="files"; filename="([^"]*)"\r\nContent-Type: ([^\r]*)\r\n\r\n([\s\S]*?)\r\n--/.exec(raw);
    res.setHeader('content-type', 'application/json');
    if (!channelId || !file || !file[3]) { res.statusCode = 400; return res.end('{"error":"bad upload"}'); }
    const attachment = { id: crypto.randomUUID(), filename: file[1], mimeType: file[2], sizeBytes: Buffer.byteLength(file[3]) };
    uploads.push({ ...attachment, channelId, text: file[3] });
    return res.end(JSON.stringify({ attachments: [attachment] }));
  }
  const body = raw ? JSON.parse(raw) : {};
  if (url.pathname.startsWith('/files/') || url.pathname.startsWith('/api/avatars/')) {
    // Synthetic images for avatar and attachment rendering.
    const hue = url.pathname.includes('avatar') ? '#7c9cff' : '#f6c26b';
    res.setHeader('content-type', 'image/svg+xml');
    // Real Raft sends this header, which blocks a direct <img> load from Obsidian.
    res.setHeader('cross-origin-resource-policy', 'same-origin');
    return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><rect width="480" height="300" fill="${hue}"/><circle cx="240" cy="150" r="80" fill="#fff" opacity=".7"/></svg>`);
  }
  res.setHeader('content-type', 'application/json');
  const json = value => res.end(JSON.stringify(value));
  if (url.pathname === '/api/servers') return json([{ id: 'other-server', slug: 'other', name: 'Other' }, { id: 'test-server', slug: 'plugin-test', name: 'Plugin test' }]);
  if (url.pathname === '/api/auth/login') return json({ user: { id: 'test-human', name: 'Test user' }, accessToken: 'mock-access', refreshToken: 'mock-refresh' });
  if (url.pathname === '/api/channels') return json([{ id: 'test-channel', name: 'Plugin test', joined: true, type: 'channel' }, { id: 'second-channel', name: 'Second', joined: true, type: 'channel' }]);
  if (url.pathname.endsWith('/members')) return json({ agents: [{ id: 'test-agent', name: 'TestAgent', displayName: 'Test Agent', avatarUrl: 'pixel:random:test-agent', activity: 'online' }, { id: 'helper-agent', name: 'Helper', displayName: 'Helper', avatarUrl: 'pixel:robot' }], humans: [{ id: 'test-human', name: 'tester', displayName: 'Test user' }, { id: 'teammate', name: 'teammate', displayName: 'Teammate', avatarUrl: '/api/avatars/users/teammate.svg' }] });
  if (url.pathname === '/api/attachments/urls') return json({ urls: body.attachmentIds.map(id => ({ id, url: `/files/${id}.svg` })) });
  if (req.method === 'POST' && url.pathname === '/api/channels/dm') return json({ id: `dm-${body.agentId}`, type: 'dm' });
  if (req.method === 'POST' && url.pathname.endsWith('/threads')) { threads.add(body.parentMessageId); return json({ threadChannelId: `thread-${body.parentMessageId}` }); }
  if (url.pathname.includes('/threads/')) {
    const root = url.pathname.split('/threads/')[1];
    if (threads.has(root)) return json({ threadChannelId: `thread-${root}` });
    res.statusCode = 404; return json({ error: 'not found' });
  }
  if (url.pathname.startsWith('/api/messages/channel/')) {
    const after = Number(url.searchParams.get('after') || 0);
    const before = Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER);
    const limit = Number(url.searchParams.get('limit') || 50);
    const requested = decodeURIComponent(url.pathname.split('/').pop());
    // Thread replies live in their own thread channel; other channels share the fixture history.
    let rows = messages.filter(m => m.seq > after && m.seq < before && (/^(thread|dm)-/.test(requested) ? m.channelId === requested : !/^(thread|dm)-/.test(String(m.channelId))));
    rows = after ? rows.slice(0, limit) : rows.slice(-limit);
    const summaries = rows.some(m => m.id === 'old-52') ? { 'old-52': { replyCount: 2, lastReplyAt: new Date().toISOString(), latestReplies: [
      { senderId: 'test-agent', senderType: 'agent', senderName: 'TestAgent', senderDisplayName: 'Test Agent', senderAvatarUrl: 'pixel:random:test-agent', preview: 'Outline drafted in the note.', createdAt: new Date().toISOString() },
      { senderId: 'teammate', senderType: 'user', senderName: 'teammate', senderDisplayName: 'Teammate', preview: 'Looks good, thanks!', createdAt: new Date().toISOString() },
    ] } } : {};
    for (const [id, summary] of Object.entries(lateSummaries)) if (rows.some(m => m.id === id)) summaries[id] = summary;
    return json({ messages: rows, threadSummariesByParentMessageId: summaries, historyLimited: false });
  }
  if (url.pathname === '/api/v2/messages') {
    const attachments = (body.attachmentIds || []).map(id => uploads.find(upload => upload.id === id)).filter(Boolean).map(({ text, channelId, ...rest }) => rest);
    // Like real Raft: no reply-to field; a thread reply is posted to the thread channel itself.
    const message = { id: crypto.randomUUID(), seq: ++seq, channelId: body.channelId, senderId: 'test-human', senderType: 'user', senderName: 'Test user', content: body.content, attachments, createdAt: new Date().toISOString() };
    messages.push(message);
    // The steward answers a sync request in the sync thread with a partial edit named by path.
    const request = String(body.channelId).startsWith('thread-') && body.content.startsWith('@TestAgent 📝 sync')
      ? /(Synced\/Doc\.md)@([a-f0-9]{12})/.exec(body.content) : null;
    if (request) setTimeout(() => messages.push({ id: crypto.randomUUID(), seq: ++seq, channelId: message.channelId, ...agentFields, createdAt: new Date().toISOString(),
      content: '📝 Recorded the decision under Decisions.\n```raft-edit\n' + JSON.stringify({ path: request[1], baseHash: request[2], ops: [{ op: 'append', heading: 'Decisions', content: '- Sign in with the server name' }] }) + '\n```' }), 100);
    const found = body.content.match(/(\{"documentId":"[^"]+","baseHash":"[^"]+")/);
    if (found) found[1] += '}';
    if (found) {
      const metadata = JSON.parse(found[1]);
      setTimeout(() => messages.push({ id: crypto.randomUUID(), seq: ++seq, channelId: body.channelId, senderId: 'test-agent', senderType: 'agent', senderName: 'Test Agent',
        content: 'I prepared the requested change.\n```raft-edit\n' + JSON.stringify({ documentId: metadata.documentId, baseHash: metadata.baseHash, content: '# Updated by agent\n\nReal Obsidian write-back verified.\n' }) + '\n```', createdAt: new Date().toISOString() }), 100);
    }
    return json(message);
  }
  res.statusCode = 404; json({ error: 'missing test route' });
});
let seq = 55;
const uploads = [];
const threads = new Set();
// Replies that arrive after a message is already on screen; an `after` read alone never returns them.
const lateSummaries = {};
const agentFields = { senderId: 'test-agent', senderType: 'agent', senderName: 'Test Agent', senderAvatarUrl: 'pixel:random:test-agent', senderDescription: 'Writes and edits notes' };
const messages = Array.from({ length: 55 }, (_, i) => ({ id: `old-${i + 1}`, seq: i + 1, channelId: 'test-channel', ...agentFields, content: `Earlier message ${i + 1}`, createdAt: new Date(Date.now() - (60 - i) * 60000).toISOString() }));
// Visual fixtures near the end: a system note, a human with a reply thread, a mention of the signed-in user, and markdown.
Object.assign(messages[51], { senderType: 'user', senderId: 'teammate', senderName: 'Teammate', senderDescription: undefined, senderAvatarUrl: undefined, content: 'Can someone draft the outline? @TestAgent please take a look.', attachments: [{ id: 'sketch', filename: 'sketch.png', mimeType: 'image/png' }] });
Object.assign(messages[52], { messageType: 'system', senderName: 'System', content: '📌 @TestAgent started task #3 "Draft outline"' });
Object.assign(messages[53], { content: 'On it, @tester. Here is the plan:\n\n- Read the note\n- Propose `raft-edit` changes\n\n> You approve every write.' });
import { Server } from 'socket.io';
const live = new Server(mock);
live.on('connection', socket => socket.on('join:channel', id => socket.join(id)));
await new Promise(resolve => mock.listen(4488, '127.0.0.1', resolve));
const root = '/tmp/raft-page-obsidian-e2e';
const profile = `${root}/profile`;
const vault = `${root}/vault`;
await mkdir(`${vault}/.obsidian/plugins/raft-page`, { recursive: true });
await mkdir(profile, { recursive: true });
const { rm } = await import('node:fs/promises');
await rm(`${vault}/.obsidian/plugins/raft-page/data.json`, { force: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) await copyFile(`${repo}/${file}`, `${vault}/.obsidian/plugins/raft-page/${file}`);
// Obsidian self-updates; use whichever app bundle is installed now.
const appSupport = `${process.env.HOME}/Library/Application Support/obsidian`;
const asar = (await readdir(appSupport)).filter(name => /^obsidian-[\d.]+\.asar$/.test(name)).sort().pop();
if (asar) await copyFile(`${appSupport}/${asar}`, `${profile}/${asar}`);
await writeFile(`${profile}/obsidian.json`, JSON.stringify({ vaults: { 'aabbccddeeff0011': { path: vault, ts: Date.now(), open: true } } }));
await writeFile(`${vault}/.obsidian/community-plugins.json`, JSON.stringify(['raft-page']));
await writeFile(`${vault}/.obsidian/app.json`, JSON.stringify({ showInlineTitle: true }));
await writeFile(`${vault}/Test note.md`, '# Raft Page integration test\n\nThis is an isolated test vault.\n');
const child = spawn('/Applications/Obsidian.app/Contents/MacOS/Obsidian', [`--user-data-dir=${profile}`, '--remote-debugging-port=9227', '--no-sandbox'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdio: 'ignore',
});
let app;
for (let i = 0; i < 60; i++) {
  try { app = await chromium.connectOverCDP('http://127.0.0.1:9227'); break; }
  catch { await new Promise(r => setTimeout(r, 500)); }
}
if (!app) { child.kill(); throw new Error('Obsidian debugging port did not open'); }
let page;
for (let i = 0; i < 60; i++) {
  page = app.contexts().flatMap(c => c.pages()).find(p => p.url().includes('obsidian.md'));
  if (page) break;
  await new Promise(r => setTimeout(r, 500));
}
if (!page) { child.kill(); throw new Error('Obsidian vault window did not open'); }
page.on('console', msg => { if (msg.type() === 'error') console.log('BROWSER ERROR', msg.text()); });
await page.waitForTimeout(8000);
console.log('TITLE', await page.title());
console.log('BODY', (await page.locator('body').innerText()).slice(0, 3000));
await page.screenshot({ path: `${root}/initial.png` });
console.log('PLUGIN', await page.evaluate(async () => {
  const app = globalThis.app;
  const plugin = app.plugins.plugins['raft-page'];
  await plugin.signOut();
  // The manual preview/apply flow is checked first; automatic apply is checked later.
  plugin.settings.autoApply = false;
  await app.workspace.getLeaf().openFile(app.vault.getAbstractFileByPath('Test note.md'));
  await plugin.openView();
  return { available: !!app, plugins: Object.keys(app.plugins.plugins) };
}));
await page.locator('.raft-login-form').waitFor();
await page.screenshot({ path: `${root}/login.png` });
console.log('LOGIN UI verified');
const form = page.locator('.raft-login-form');
await form.locator('input[type="url"]').fill('http://127.0.0.1:4488');
await form.locator('input[type="text"]').fill('/plugin-test');
await form.locator('input[type="email"]').fill('test@example.invalid');
await form.locator('input[type="password"]').fill('mock-password');
await form.getByRole('button', { name: 'Sign in', exact: true }).click();
await page.locator('.raft-conversation').waitFor();
assert.equal(await page.evaluate(() => globalThis.app.plugins.plugins['raft-page'].session.serverId), 'test-server', 'server chosen by its short name');
await page.getByText('Earlier message 55', { exact: true }).waitFor();
await page.getByRole('button', { name: 'Load older messages', exact: true }).click();
await page.getByText('Earlier message 1', { exact: true }).waitFor();
console.log('CHANNEL history and paging verified');
await page.locator('.raft-thread-summary .raft-thread-preview').first().waitFor({ state: 'attached' });
// Images must actually decode, not just be attached: blob URLs fetched through Obsidian's network layer.
await page.waitForFunction(() => {
  const loaded = img => img && img.src.startsWith('blob:') && img.complete && img.naturalWidth > 0;
  return loaded(document.querySelector('.raft-image-frame img')) &&
    [...document.querySelectorAll('.raft-avatar.is-user img')].some(loaded);
}, null, { timeout: 15000 });
console.log('IMAGES, member avatars and thread previews verified');
lateSummaries['old-54'] = { replyCount: 1, lastReplyAt: new Date().toISOString(), latestReplies: [
  { senderId: 'test-agent', senderType: 'agent', senderName: 'TestAgent', senderDisplayName: 'Test Agent', preview: 'A late reply.', createdAt: new Date().toISOString() }] };
await page.locator('.raft-thread-summary').filter({ hasText: '1 reply' }).waitFor({ state: 'attached', timeout: 15000 });
console.log('LATE thread reply appears on an already shown message');
const composer = page.locator('textarea.raft-composer');
await composer.click();
await composer.pressSequentially('@Test');
await page.locator('.raft-mention-option', { hasText: 'Test Agent' }).waitFor();
await page.keyboard.press('Enter');
assert.equal(await composer.inputValue(), '@TestAgent ');
console.log('MENTION autocomplete verified');
await composer.pressSequentially('Update this note for the test.');
await page.getByRole('button', { name: 'Send', exact: true }).click();
await page.getByText('Suggested note change', { exact: true }).waitFor({ timeout: 15000 });
await page.locator('.raft-history').evaluate(el => { el.scrollTop = el.scrollHeight; });
await page.evaluate(() => { globalThis.app.workspace.rightSplit.setSize(420); });
await page.screenshot({ path: `${root}/chat.png` });
await page.locator('.raft-thread-summary').first().scrollIntoViewIfNeeded();
await page.locator('.raft-thread-summary').first().hover();
await page.screenshot({ path: `${root}/thread-summary.png` });
const theme = await page.evaluate(() => document.body.classList.contains('theme-dark') ? 'dark' : 'light');
const other = theme === 'dark' ? 'light' : 'dark';
await page.evaluate(([from, to]) => document.body.classList.replace(`theme-${from}`, `theme-${to}`), [theme, other]);
await page.screenshot({ path: `${root}/chat-${other}.png` });
await page.evaluate(([from, to]) => document.body.classList.replace(`theme-${from}`, `theme-${to}`), [other, theme]);
await page.getByRole('button', { name: 'Preview', exact: true }).click();
await page.getByRole('button', { name: 'Apply to note', exact: true }).click();
const saved = await page.evaluate(() => globalThis.app.vault.read(globalThis.app.vault.getAbstractFileByPath('Test note.md')));
assert.equal(saved, '# Updated by agent\n\nReal Obsidian write-back verified.\n');
console.log('DOCUMENT write-back verified');
const sentNote = messages.find(m => m.attachments?.length);
assert.ok(sentNote && !sentNote.content.includes('Raft Page integration test'), 'note text must not be inline in the message');
assert.equal(uploads[0].filename, 'Test note.md');
assert.equal(await page.locator('.raft-attachment', { hasText: 'Test note.md' }).count(), 0, 'own note upload is shown once, as the note chip');
console.log('NOTE sent as a file attachment with a one-line message');
const repliesBefore = messages.filter(m => m.content.startsWith('I prepared')).length;
await composer.fill('Propose another change, then I will edit locally.');
await page.getByRole('button', { name: 'Send', exact: true }).click();
for (let i = 0; i < 40 && messages.filter(m => m.content.startsWith('I prepared')).length === repliesBefore; i++) await new Promise(r => setTimeout(r, 200));
await page.evaluate(() => globalThis.app.plugins.plugins['raft-page'].app.workspace.getLeavesOfType('raft-page')[0].view.refresh());
await page.getByText('Suggested note change', { exact: true }).last().waitFor({ timeout: 15000 });
await page.evaluate(async () => {
  const a = globalThis.app; const leaf = a.workspace.getLeavesOfType('markdown').find(l => l.view.file?.path === 'Test note.md');
  leaf.view.editor.setValue('# Local edit to preserve\n'); await leaf.view.save();
});
await page.getByRole('button', { name: 'Preview', exact: true }).last().click();
await page.getByRole('button', { name: 'Apply to note', exact: true }).click();
await page.getByText('This note changed after it was sent. Send the latest version before applying edits.', { exact: true }).waitFor();
assert.equal(await page.evaluate(() => globalThis.app.vault.read(globalThis.app.vault.getAbstractFileByPath('Test note.md'))), '# Local edit to preserve\n');
console.log('STALE edit rejected without overwriting local changes');
await page.getByRole('button', { name: 'Cancel', exact: true }).click();
await page.evaluate(() => { globalThis.app.plugins.plugins['raft-page'].settings.autoApply = true; });
await composer.fill('Apply this one without a preview.');
await page.getByRole('button', { name: 'Send', exact: true }).click();
await page.waitForFunction(async () => (await globalThis.app.vault.read(globalThis.app.vault.getAbstractFileByPath('Test note.md'))).startsWith('# Updated by agent'), null, { timeout: 15000 });
console.log('AUTO apply wrote the agent edit without a click');
// Channel binding: header button, folder binding, auto-follow on open, the way back after a manual switch.
const selectValue = () => page.locator('.raft-channel-select').inputValue();
await page.evaluate(async () => {
  const app = globalThis.app;
  await app.plugins.plugins['raft-page'].saveBindings({});
  for (const leftover of ['Bound', 'Renamed']) { const f = app.vault.getAbstractFileByPath(leftover); if (f) await app.vault.delete(f, true); }
  if (!app.vault.getAbstractFileByPath('Bound')) await app.vault.createFolder('Bound');
  const note = app.vault.getAbstractFileByPath('Bound/Other.md') || await app.vault.create('Bound/Other.md', '# Bound note\n');
  await app.workspace.getLeaf().openFile(note);
});
await page.locator('.raft-binding-source').filter({ hasText: 'Not bound' }).waitFor({ timeout: 10000 });
console.log('NATIVE menus', await page.evaluate(() => globalThis.app.vault.getConfig('nativeMenus')));
// macOS may use native menus, which are outside the DOM; switch to Obsidian's own menus to click them.
await page.evaluate(() => globalThis.app.vault.setConfig('nativeMenus', false));
await page.locator('.raft-bind-button').click();
await page.locator('.menu-item').filter({ hasText: 'Bind folder Bound → #Plugin test' }).click();
// Binding then offers the steward step; the first option keeps the binding without automatic updates.
await page.locator('.prompt .suggestion-item').filter({ hasText: 'No steward' }).waitFor({ timeout: 10000 });
assert.ok(await page.locator('.prompt .suggestion-item').filter({ hasText: '@TestAgent' }).count());
await page.keyboard.press('Escape');
await page.locator('.raft-binding-source').filter({ hasText: 'Bound · from folder' }).waitFor({ timeout: 10000 });
assert.ok(await page.locator('.raft-bind-button.is-bound').count());
const stored = await page.evaluate(() => globalThis.app.vault.adapter.read(`${globalThis.app.plugins.plugins['raft-page'].manifest.dir}/bindings.json`));
assert.equal(JSON.parse(stored).bindings.Bound.channelId, 'test-channel');
await page.screenshot({ path: `${root}/bound-header.png` });
await page.evaluate(async () => {
  const app = globalThis.app, plugin = app.plugins.plugins['raft-page'];
  await app.workspace.getLeaf().openFile(app.vault.getAbstractFileByPath('Test note.md'));
  await plugin.bindPath(app.vault.getAbstractFileByPath('Bound'), { id: 'second-channel', name: 'Second' });
});
await page.locator('.prompt').waitFor({ timeout: 10000 });
await page.keyboard.press('Escape');
await page.locator('.raft-binding-source').filter({ hasText: 'Not bound' }).waitFor({ timeout: 10000 });
assert.equal(await selectValue(), 'test-channel', 'an unbound note keeps the current channel');
await page.evaluate(async () => { const app = globalThis.app; await app.workspace.getLeaf().openFile(app.vault.getAbstractFileByPath('Bound/Other.md')); });
await page.waitForFunction(() => document.querySelector('.raft-channel-select')?.value === 'second-channel', null, { timeout: 10000 });
await page.locator('.raft-channel-select').selectOption('test-channel');
await page.locator('.raft-binding-bar:not([hidden])').filter({ hasText: 'bound to #Second' }).waitFor({ timeout: 10000 });
await page.screenshot({ path: `${root}/binding-return.png` });
await page.locator('.raft-binding-bar button', { hasText: 'Return' }).click();
await page.waitForFunction(() => document.querySelector('.raft-channel-select')?.value === 'second-channel', null, { timeout: 10000 });
assert.ok(await page.locator('.raft-binding-bar[hidden]').count());
await page.evaluate(async () => {
  const app = globalThis.app;
  await app.vault.rename(app.vault.getAbstractFileByPath('Bound'), 'Renamed');
  await app.workspace.getLeaf().openFile(app.vault.getAbstractFileByPath('Test note.md'));
});
await page.waitForFunction(() => Object.keys(globalThis.app.plugins.plugins['raft-page'].bindings).join() === 'Renamed', null, { timeout: 10000 });
console.log('BINDING header button, folder bind, follow, return, rename verified');
// Steward sync: default steward assigned on bind, a forced sync posts the request in the sync thread with the note
// attached, the steward's partial edit by path applies on the next tick, and Undo restores the note.
const stewardResult = await page.evaluate(async () => {
  const app = globalThis.app, plugin = app.plugins.plugins['raft-page'];
  const old = app.vault.getAbstractFileByPath('Synced'); if (old) await app.vault.delete(old, true);
  await app.vault.createFolder('Synced');
  const doc = await app.vault.create('Synced/Doc.md', '# Doc\n\n## Decisions\n\n- none yet\n\n## Open\n\n- tbd\n');
  plugin.settings.defaultSteward = 'TestAgent';
  await plugin.bindPath(app.vault.getAbstractFileByPath('Synced'), { id: 'test-channel', name: 'Plugin test' });
  for (let i = 0; i < 50 && !plugin.bindings.Synced?.stewardId; i++) await new Promise(r => setTimeout(r, 100));
  await new Promise(r => setTimeout(r, 50));
  await plugin.client.send('test-channel', 'Decision: we sign in with the server name, not the ID.');
  await app.workspace.getLeaf().openFile(doc);
  await plugin.syncTick('Synced');
  await new Promise(r => setTimeout(r, 400));
  await plugin.syncTick();
  await plugin.applying;
  const after = await app.vault.read(app.vault.getAbstractFileByPath('Synced/Doc.md'));
  const entry = plugin.history[plugin.history.length - 1];
  await plugin.undo(entry.id);
  const inChannel = (await plugin.client.messages('test-channel', { limit: 50 })).messages.some(m => m.content.includes('📝'));
  const rootText = inChannel ? '' : (await plugin.client.messages(plugin.bindings.Synced.syncChannelId, { limit: 50 })).messages.find(m => m.id === plugin.bindings.Synced.syncRootId)?.content || '';
  return { steward: plugin.bindings.Synced.stewardName, root: rootText.includes('do not reply'), after,
    undone: await app.vault.read(app.vault.getAbstractFileByPath('Synced/Doc.md')) };
});
assert.equal(stewardResult.steward, 'TestAgent');
assert.ok(stewardResult.root, 'sync runs in a DM thread that opens with the steward brief; the channel gets no sync message');
assert.equal(stewardResult.after, '# Doc\n\n## Decisions\n\n- none yet\n\n- Sign in with the server name\n\n## Open\n\n- tbd\n');
assert.equal(stewardResult.undone, '# Doc\n\n## Decisions\n\n- none yet\n\n## Open\n\n- tbd\n');
await page.locator('.raft-binding-source').filter({ hasText: 'steward @TestAgent' }).waitFor({ timeout: 10000 });
await page.locator('.raft-steward:not([hidden]) .raft-presence').waitFor({ timeout: 10000 });
await page.screenshot({ path: `${root}/steward-header.png` });
console.log('STEWARD sync request, path edit, auto-apply and undo verified');
// Regression: a steward replies under an ordinary agent-authored root, not the sync root or a note send.
// Leave the sidebar on another channel and never open this thread; the plugin's background pass must find it.
const ordinaryHash = await page.evaluate(async () => {
  const plugin = globalThis.app.plugins.plugins['raft-page'];
  const bytes = new TextEncoder().encode(await plugin.currentText('Synced/Doc.md'));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
});
const ordinaryRoot = 'ordinary-steward-root';
threads.add(ordinaryRoot);
messages.push({ id: ordinaryRoot, seq: ++seq, channelId: 'test-channel', senderId: 'helper-agent', senderType: 'agent',
  senderName: 'Helper', content: 'An ordinary project discussion', createdAt: new Date().toISOString() });
messages.push({ id: 'ordinary-steward-edit', seq: ++seq, channelId: `thread-${ordinaryRoot}`, ...agentFields,
  content: 'Recorded the links.\n```raft-edit\n' + JSON.stringify({ path: 'Synced/Doc.md', baseHash: ordinaryHash,
    ops: [{ op: 'append', heading: 'Decisions', content: '- Ordinary thread works without Apply' }] }) + '\n```', createdAt: new Date().toISOString() });
lateSummaries[ordinaryRoot] = { replyCount: 1, lastReplyAt: new Date().toISOString(), latestReplies: [
  { senderId: 'test-agent', senderType: 'agent', senderName: 'Test Agent', preview: 'Recorded the links.' }] };
await page.locator('.raft-channel-select').selectOption('second-channel');
await page.evaluate(async () => {
  const plugin = globalThis.app.plugins.plugins['raft-page'];
  await plugin.syncTick(); await plugin.applying;
});
assert.equal(await page.locator('.raft-channel-select').inputValue(), 'second-channel');
assert.ok(await page.evaluate(async () => (await globalThis.app.plugins.plugins['raft-page'].currentText('Synced/Doc.md')).includes('Ordinary thread works without Apply')));
await page.evaluate(async () => {
  const plugin = globalThis.app.plugins.plugins['raft-page'];
  await plugin.syncTick(); await plugin.applying;
});
assert.equal(await page.evaluate(async () => (await globalThis.app.plugins.plugins['raft-page'].currentText('Synced/Doc.md')).split('Ordinary thread works without Apply').length - 1), 1);
console.log('ORDINARY THREAD steward edit applied without opening the thread or clicking Apply; no duplicate writes');
await page.evaluate(async () => { const app = globalThis.app; await app.workspace.getLeaf().openFile(app.vault.getAbstractFileByPath('Test note.md')); });
// A plugin update (BRAT) reloads the plugin while a note is already open, with no new file-open event.
await page.evaluate(async () => {
  const plugins = globalThis.app.plugins;
  await plugins.disablePlugin('raft-page');
  await plugins.enablePlugin('raft-page');
  await plugins.plugins['raft-page'].openView();
});
await page.locator('.raft-context-chip:not([hidden])').filter({ hasText: 'Test note.md' }).waitFor({ timeout: 15000 });
console.log('RELOAD keeps the open note attached');
await page.evaluate(() => { globalThis.app.workspace.rightSplit.setSize(340); });
await page.waitForTimeout(500);
await page.screenshot({ path: `${root}/narrow.png` });
const toolbarTall = await page.locator('.raft-message .raft-hover-toolbar').first().evaluate(el => el.getBoundingClientRect().height);
console.log('NARROW toolbar height', toolbarTall);
const lift = await page.evaluate(() => {
  const view = globalThis.app.workspace.getLeavesOfType('raft-page')[0].view;
  const box = () => document.querySelector('.raft-composer-box').getBoundingClientRect().bottom;
  const before = box();
  view.contentEl.style.setProperty('--raft-keyboard', '300px');
  const after = box();
  view.contentEl.style.setProperty('--raft-keyboard', '0px');
  return before - after;
});
assert.ok(Math.abs(lift - 300) < 2, `composer lifts by the keyboard height (got ${lift})`);
console.log('KEYBOARD inset lifts the composer by', lift);
console.log('OVERFLOW', await page.locator('.raft-view').evaluate(el => ({ width: el.clientWidth, scrollWidth: el.scrollWidth })));
await app.close();
child.kill();
await new Promise(resolve => live.close(resolve));
mock.close();
