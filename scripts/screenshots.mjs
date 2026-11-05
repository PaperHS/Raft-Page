// Generates the README screenshots in an isolated Obsidian vault against a local mock Raft server.
// The conversation is fictional; the photo is CC0 (see assets/CREDITS.md). macOS only, like test-obsidian.mjs.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, copyFile, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const out = `${repo}assets`;
const photo = await readFile(`${repo}assets/source/lisbon-tram.jpg`);
const NOTE = 'Guides/Lisbon/Weekend plan.md';
const noteText = `# Lisbon weekend plan

## Day 1 — Alfama

- Morning: walk from the Sé to Castelo de São Jorge
- Lunch: to decide

## Day 2 — Belém

- Mosteiro dos Jerónimos, then the riverside walk to the tower

## Open questions

- Best viewpoint for sunset?
`;
const hash = createHash('sha256').update(noteText).digest('hex');

const today = new Date(); today.setHours(9, 0, 0, 0);
const at = minutes => new Date(today.getTime() + minutes * 60_000).toISOString();
const people = {
  maya: { senderId: 'maya', senderType: 'user', senderName: 'Maya', senderAvatarUrl: '/api/avatars/maya.svg' },
  leo: { senderId: 'leo', senderType: 'user', senderName: 'Leo', senderAvatarUrl: '/api/avatars/leo.svg' },
  atlas: { senderId: 'atlas', senderType: 'agent', senderName: 'Atlas', senderAvatarUrl: 'pixel:random:atlas', senderDescription: 'Itinerary research' },
  scribe: { senderId: 'scribe', senderType: 'agent', senderName: 'Scribe', senderAvatarUrl: 'pixel:random:scribe', senderDescription: 'Keeps the guide up to date' },
};
let seq = 0;
const say = (who, minutes, content, extra = {}) => ({ id: `m${++seq}`, seq, channelId: 'lisbon', ...people[who], content, createdAt: at(minutes), ...extra });
const messages = [
  say('maya', 12, 'Back from the Alfama walk. Tram 28 was packed by ten — we should tell people to board at **Martim Moniz** early.',
    { attachments: [{ id: 'tram', filename: 'tram-28.jpg', mimeType: 'image/jpeg' }] }),
  say('leo', 14, 'Agreed. And Miradouro de Santa Luzia was a lot quieter than Senhora do Monte for sunset.'),
  say('atlas', 15, 'Day 1 already starts in Alfama in the morning, so an early tram fits without moving anything else.'),
  say('maya', 17, "Let's make that the plan: board tram 28 at Martim Moniz before 9, and sunset at Santa Luzia. @Scribe"),
];
const stewardEdit = say('scribe', 20, '📝 Recorded the tram tip under Day 1 and answered the sunset question.\n```raft-edit\n' + JSON.stringify({
  path: NOTE, baseHash: hash.slice(0, 12), ops: [
    { op: 'append', heading: 'Day 1 — Alfama', content: '- Board tram 28 at Martim Moniz before 9:00; it is packed by 10:00' },
    { op: 'replace', find: '- Best viewpoint for sunset?', with: '- ~~Best viewpoint for sunset?~~ Miradouro de Santa Luzia (quieter than Senhora do Monte)' },
  ] }) + '\n```');

const initials = { maya: ['M', '#F6C26B'], leo: ['L', '#8EC5FF'] };
const mock = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const url = new URL(req.url, 'http://localhost');
  const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
  const body = raw && !url.pathname.includes('upload') ? JSON.parse(raw) : {};
  if (url.pathname === '/files/tram.jpg') { res.setHeader('content-type', 'image/jpeg'); return res.end(photo); }
  const avatar = /^\/api\/avatars\/(\w+)\.svg$/.exec(url.pathname);
  if (avatar && initials[avatar[1]]) {
    const [letter, fill] = initials[avatar[1]];
    res.setHeader('content-type', 'image/svg+xml');
    return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${fill}"/><text x="32" y="43" font-family="Helvetica" font-weight="700" font-size="30" text-anchor="middle" fill="#141111">${letter}</text></svg>`);
  }
  if (url.pathname === '/api/servers') return json([{ id: 'srv', slug: 'lisbon-team', name: 'Lisbon team' }]);
  if (url.pathname === '/api/auth/login') return json({ user: { id: 'maya', name: 'maya', displayName: 'Maya' }, accessToken: 'demo', refreshToken: 'demo' });
  if (url.pathname === '/api/channels') return json([{ id: 'lisbon', name: 'lisbon-guide', joined: true }, { id: 'general', name: 'general', joined: true }]);
  if (url.pathname.endsWith('/members')) return json({
    agents: [{ id: 'scribe', name: 'Scribe', displayName: 'Scribe', avatarUrl: 'pixel:random:scribe', activity: 'online' },
      { id: 'atlas', name: 'Atlas', displayName: 'Atlas', avatarUrl: 'pixel:random:atlas', activity: 'working' }],
    humans: [{ id: 'maya', name: 'maya', displayName: 'Maya', avatarUrl: '/api/avatars/maya.svg' }, { id: 'leo', name: 'leo', displayName: 'Leo', avatarUrl: '/api/avatars/leo.svg' }] });
  if (url.pathname === '/api/attachments/urls') return json({ urls: body.attachmentIds.map(id => ({ id, url: `/files/${id}.jpg` })) });
  if (url.pathname.includes('/threads')) { res.statusCode = 404; return json({ error: 'not found' }); }
  if (url.pathname.startsWith('/api/messages/channel/')) {
    const channel = decodeURIComponent(url.pathname.split('/').pop());
    const after = Number(url.searchParams.get('after') || 0);
    return json({ messages: channel === 'lisbon' ? messages.filter(m => m.seq > after) : [], threadSummariesByParentMessageId: {}, historyLimited: false });
  }
  // Binding notices and anything else the plugin posts are accepted but not shown.
  if (url.pathname === '/api/v2/messages') return json({ id: `sent-${Date.now()}`, content: body.content, senderName: 'Maya', channelId: body.channelId });
  if (url.pathname === '/api/channels/dm') return json({ id: 'dm-scribe' });
  res.statusCode = 404; json({ error: 'missing route' });
});
await new Promise(resolve => mock.listen(4489, '127.0.0.1', resolve));

const root = '/tmp/raft-page-screenshots';
await rm(root, { recursive: true, force: true });
const profile = `${root}/profile`, vault = `${root}/vault`;
await mkdir(`${vault}/.obsidian/plugins/raft-page`, { recursive: true });
await mkdir(`${vault}/Guides/Lisbon`, { recursive: true });
await mkdir(profile, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) await copyFile(`${repo}${file}`, `${vault}/.obsidian/plugins/raft-page/${file}`);
const appSupport = `${process.env.HOME}/Library/Application Support/obsidian`;
const asar = (await readdir(appSupport)).filter(name => /^obsidian-[\d.]+\.asar$/.test(name)).sort().pop();
if (asar) await copyFile(`${appSupport}/${asar}`, `${profile}/${asar}`);
await writeFile(`${profile}/obsidian.json`, JSON.stringify({ vaults: { 'ffeeddccbbaa0011': { path: vault, ts: Date.now(), open: true } } }));
await writeFile(`${vault}/.obsidian/community-plugins.json`, JSON.stringify(['raft-page']));
await writeFile(`${vault}/.obsidian/app.json`, JSON.stringify({ showInlineTitle: false, nativeMenus: false }));
await writeFile(`${vault}/${NOTE}`, noteText);
await writeFile(`${vault}/Guides/Lisbon/Food.md`, '# Food\n\n- Pastéis de nata in Belém\n');
await writeFile(`${vault}/Guides/Packing list.md`, '# Packing list\n\n- Comfortable shoes (hills!)\n');

const child = spawn('/Applications/Obsidian.app/Contents/MacOS/Obsidian', [`--user-data-dir=${profile}`, '--remote-debugging-port=9228', '--no-sandbox'],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdio: 'ignore' });
let app, page;
try {
  for (let i = 0; i < 60 && !app; i++) { try { app = await chromium.connectOverCDP('http://127.0.0.1:9228'); } catch { await new Promise(r => setTimeout(r, 500)); } }
  for (let i = 0; i < 60 && !page; i++) { page = app.contexts().flatMap(c => c.pages()).find(p => p.url().includes('obsidian.md')); if (!page) await new Promise(r => setTimeout(r, 500)); }
  await page.waitForTimeout(6000);
  // A fresh vault starts in restricted mode; turn community plugins on for this throwaway vault.
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const plugins = globalThis.app.plugins;
    if (!plugins.isEnabled?.()) await plugins.setEnable(true);
    if (!plugins.plugins['raft-page']) await plugins.enablePlugin('raft-page');
  });
  await page.waitForTimeout(1500);
  const clean = () => page.evaluate(() => document.querySelectorAll('.notice-container .notice').forEach(n => n.remove()));
  const shoot = async name => { await clean(); await page.waitForTimeout(400); await page.screenshot({ path: `${out}/${name}.png` }); console.log('SHOT', name); };
  await page.evaluate(async note => {
    const app = globalThis.app, plugin = app.plugins.plugins['raft-page'];
    await plugin.signOut();
    plugin.settings.apiUrl = 'http://127.0.0.1:4489';
    await app.workspace.getLeaf().openFile(app.vault.getAbstractFileByPath(note));
    await plugin.openView();
    app.workspace.rightSplit.setSize(470);
  }, NOTE);
  const form = page.locator('.raft-login-form');
  await form.waitFor();
  await form.locator('input[type="url"]').fill('https://api.raft.build');
  await form.locator('input[type="text"]').fill('/lisbon-team');
  await form.locator('input[type="email"]').fill('maya@example.com');
  await form.locator('input[type="password"]').fill('demo');
  await shoot('signin');
  // The screenshot shows the official server; the session itself talks to the local mock.
  await form.locator('input[type="url"]').fill('http://127.0.0.1:4489');
  await form.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByText('Back from the Alfama walk', { exact: false }).waitFor();
  await page.locator('.raft-image-frame img').first().waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('.raft-history').evaluate(el => { el.scrollTop = el.scrollHeight; });

  // 1. Binding: the 🔗 menu on a note inside the Lisbon folder.
  await page.locator('.raft-bind-button').click();
  await page.locator('.menu').waitFor();
  await shoot('bind-menu');
  await page.locator('.menu-item').filter({ hasText: 'Bind folder Guides/Lisbon' }).click();
  // 2. Choosing a steward, offered right after binding.
  await page.locator('.prompt .suggestion-item').filter({ hasText: '@Scribe' }).waitFor({ timeout: 10000 });
  await shoot('choose-steward');
  await page.locator('.prompt .suggestion-item').filter({ hasText: '@Scribe' }).click();
  await page.locator('.raft-steward:not([hidden]) .raft-presence').waitFor({ timeout: 10000 });

  // 3. The steward records the decision; the plugin applies it with an Undo.
  messages.push(stewardEdit);
  await page.evaluate(async () => { const plugin = globalThis.app.plugins.plugins['raft-page']; await plugin.syncTick(); await plugin.applying;
    await globalThis.app.workspace.getLeavesOfType('raft-page')[0].view.refresh(); });
  await page.locator('.raft-applied-row').waitFor({ timeout: 10000 });
  await page.locator('.raft-history').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await shoot('steward-update-light');
  await page.evaluate(() => document.body.classList.replace('theme-light', 'theme-dark'));
  await shoot('steward-update-dark');
} finally {
  await app?.close().catch(() => {});
  child.kill();
  mock.close();
}
