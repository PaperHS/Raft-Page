import { Plugin, ItemView, WorkspaceLeaf, MarkdownView, TFile, TFolder, Notice, Modal, Setting, PluginSettingTab, FuzzySuggestModal, requestUrl, setIcon, type TAbstractFile, type Menu } from 'obsidian';
import { io, type Socket } from 'socket.io-client';
import { RaftClient, RaftClientError, type Session, type Message, type ServerInfo } from './src/client';
import { RaftView, VIEW_TYPE } from './src/view';
import { BRIEF_VERSION, QUIET_MS, composeSyncRequest, syncRootMessage, lastSyncedThrough, newActivity, parseNeeds } from './src/sync';
import { safeNotePath } from './src/edits';
import { TEMPLATE_FOLDER, fillTemplate, formatDate, mergeProperties, templateTypes } from './src/templates';
import { BINDINGS_FILE, bind, channelName, deleteBindings, folderManifest, parseBindings, renameBindings, resolveBinding, resolveChannelBinding, serializeBindings, unbind, type Bindings, type ResolvedBinding } from './src/bindings';
import { applyProposalText, composeMessage, hashText, parseProposals, sentDocumentId, sentNote, type DocumentContext, type DocumentSnapshot, type Proposal } from './src/documents';

interface Settings {
  apiUrl: string; serverId: string; serverSlug: string; channelId: string; agent: string;
  attachDocument: boolean; useSelection: boolean; autoApply: boolean;
  /** Agent name chosen as steward for new bindings when it is in the channel. */
  defaultSteward: string;
  /**
   * Keyboard height in px to reserve when the composer is focused. iOS Obsidian neither resizes the window nor the
   * visual viewport when the software keyboard opens, so nothing can be measured; 0 keeps the measured behaviour.
   */
  mobileKeyboardHeight: number;
}
const DEFAULTS: Settings = {
  apiUrl: 'https://api.raft.build', serverId: '', serverSlug: '',
  channelId: '', agent: '', attachDocument: true, useSelection: false, autoApply: true, defaultSteward: '',
  mobileKeyboardHeight: 0,
};
type UndoEntry = { id: string; path: string; before: string | null; after: string; senderName: string; at: number };
type Snapshot = Omit<DocumentSnapshot, 'content'> & { userId: string; apiUrl: string; serverId: string; threadChannels: string[] };
type RemoteDoc = { path: string; baseHash: string; channelId: string; createdAt: string; identity: string };

/** A Markdown link reference definition: Raft does not render it, but every device can find it. */
const REQUEST_TIMEOUT_MS = 60_000;
const SYNC_STALL_MS = 15 * 60_000;
const needMarker = (requestId: string) => `\n\n[raft-need]: <> '${requestId}'`;

export default class RaftPagePlugin extends Plugin {
  settings: Settings = { ...DEFAULTS };
  session?: Session;
  client!: RaftClient;
  snapshots: Record<string, Snapshot> = {};
  applied: string[] = [];
  private note: TFile | null = null;
  private capturedFiles = new WeakMap<DocumentContext, TFile>();
  private socket?: Socket;
  private watchedChannels = new Set<string>();
  private socketTimer?: number;
  private saving: Promise<void> = Promise.resolve();
  private active = true;
  private generation = 0;
  private secretId = '';
  private autoTried = new Set<string>();
  private scannedThreads = new Map<string, string>();
  private scanningThreads = new Map<string, Promise<Message[]>>();
  private scannedReplies = new Map<string, Message[]>();
  private applying: Promise<void> = Promise.resolve();
  /** Thread channel → the channel it belongs to, learned when a thread is opened or scanned. */
  private threadParents = new Map<string, string>();
  /** Applied changes that can still be undone, this session only: note text never goes into plugin data. */
  history: UndoEntry[] = [];
  /** Per binding: the hash of each note as last sent to its steward (hashes only, no note text). */
  sentHashes: Record<string, Record<string, string>> = {};
  private answeredNeeds: string[] = [];
  /** Earlier sync thread → reply count and last reply time when it was last read. */
  private scannedSyncThreads = new Map<string, string>();
  private answeringNeeds = new Set<string>();
  private needReceipts = new Map<string, string>();
  /** When the running sync pass started (0 = none); a pass stuck past SYNC_STALL_MS no longer blocks the next one. */
  private syncing = 0;
  private requestCount = 0;
  /** Recent background sync passes (duration, requests, slow steps), kept in sync-log-<device>.json for diagnosis. */
  private syncLog: unknown[] = [];
  bindings: Bindings = {};
  /** Live agent activity from Raft's `agent:activity` events, by agent id. */
  agentActivity = new Map<string, string>();
  private bindingWrites: Promise<void> = Promise.resolve();
  /**
   * Notes this account sent from another device (or an earlier session), read from the send messages themselves, so
   * replies to them apply on whichever device is open. Keyed by documentId; the base hash still guards every write.
   */
  private remoteDocs = new Map<string, RemoteDoc>();
  /** Changes applied on other devices, read from their applied-<device>.json next to bindings.json. */
  private sharedApplied = new Set<string>();
  private deviceId = '';

  async onload() {
    this.secretId = `raft-page-${await hashText(this.app.vault.getName()).then(s => s.slice(0, 24))}`;
    if (!this.active) return;
    const data = await this.loadData() || {};
    if (!this.active) return;
    this.settings = { ...DEFAULTS, ...data.settings };
    this.snapshots = data.snapshots || {};
    this.applied = data.applied || [];
    this.sentHashes = data.sentHashes || {};
    this.answeredNeeds = data.answeredNeeds || [];
    // The device id lives in this device's local storage, never in synced plugin data.
    const saved = this.app.loadLocalStorage?.('raft-page-device');
    this.deviceId = typeof saved === 'string' && /^[a-z0-9-]{8,64}$/.test(saved) ? saved : crypto.randomUUID();
    if (saved !== this.deviceId) this.app.saveLocalStorage?.('raft-page-device', this.deviceId);
    await this.loadSharedApplied();
    try {
      const value = this.app.secretStorage?.getSecret(this.secretId);
      if (value) {
        const saved = JSON.parse(value);
        if (saved.apiUrl === this.settings.apiUrl && saved.serverId === this.settings.serverId && saved.accessToken && saved.userId) this.session = saved;
      }
    } catch { new Notice('Raft: saved login could not be loaded. Please sign in again.'); }
    this.client = new RaftClient(async req => {
      // requestUrl has no timeout of its own; a request that never answers must not stall background syncing.
      let timer = 0;
      this.requestCount++;
      const res = await Promise.race([
        requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.rawBody ?? (req.body === undefined ? undefined : JSON.stringify(req.body)), throw: false }),
        new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error('Raft did not answer in time.')), REQUEST_TIMEOUT_MS); }),
      ]).finally(() => window.clearTimeout(timer));
      let json: unknown = {};
      try { json = res.json; } catch { /* Errors without JSON are handled by the client. */ }
      return { status: res.status, json };
    }, () => this.session, async session => {
      if (!this.active) return;
      if (this.identity(this.session) !== this.identity(session)) this.generation++;
      this.session = session;
      this.storeSession();
      this.connectRealtime();
    });
    this.registerView(VIEW_TYPE, leaf => new RaftView(leaf, this));
    this.addRibbonIcon('messages-square', 'Open Raft Page', () => void this.openView());
    this.addCommand({ id: 'open', name: 'Open channel conversations', callback: () => void this.openView() });
    this.addCommand({ id: 'attach-note', name: 'Attach current note to conversation', callback: () => {
      this.settings.attachDocument = true;
      void this.saveSettings(); void this.openView();
    } });
    this.addCommand({ id: 'bind-note', name: 'Bind current note or its folder to a channel', callback: () => {
      const file = this.app.workspace.getActiveFile();
      if (file) this.chooseChannel(file.parent && file.parent.path !== '/' ? file.parent : file);
    } });
    this.addCommand({ id: 'new-channel', name: 'New channel for the current note', callback: () => {
      const file = this.app.workspace.getActiveFile();
      if (file?.extension === 'md') this.newChannel(file); else new Notice('Raft: open a Markdown note first.');
    } });
    this.addCommand({ id: 'toggle-keyboard-debug', name: 'Toggle keyboard layout metrics overlay', callback: () => {
      this.keyboardDebug = !this.keyboardDebug;
      for (const view of this.views()) view.setKeyboardDebug(this.keyboardDebug);
    } });
    this.addSettingTab(new RaftSettingsTab(this.app, this));
    await this.loadBindings();
    this.registerEvent(this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => this.fileMenu(menu, file)));
    this.note = this.activeNote();
    // At startup the restored note is opened before or without a file-open event, so look again once the layout exists.
    this.app.workspace.onLayoutReady?.(() => {
      this.note ??= this.activeNote();
      this.views().forEach(v => v.updateContext());
    });
    this.registerEvent(this.app.workspace.on('file-open', file => {
      if (file?.extension === 'md') this.note = file;
      else if (file) this.note = null;
      this.views().forEach(v => { v.updateContext(); if (file) v.followNote(); });
    }));
    this.registerEvent(this.app.vault.on('delete', file => {
      this.invalidatePath(file.path);
      const next = deleteBindings(this.bindings, file.path);
      if (next) void this.saveBindings(next);
      if (this.note === file) this.note = null;
      this.views().forEach(v => v.updateContext());
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      this.invalidatePath(oldPath);
      const next = renameBindings(this.bindings, oldPath, file.path);
      if (next) void this.saveBindings(next);
      this.views().forEach(v => v.updateContext());
    }));
    this.connectRealtime();
    this.registerInterval?.(window.setInterval(() => void this.syncTick(), 30_000));
  }

  private identity(session?: Session) { return session ? [session.apiUrl, session.serverId, session.userId].join('|') : ''; }
  private assertSession(generation: number, identity: string) {
    if (!this.active || generation !== this.generation || identity !== this.identity(this.session)) throw new Error('The signed-in account changed. Please try again.');
  }
  private invalidatePath(path: string) {
    for (const [id, s] of Object.entries(this.snapshots)) if (s.path === path || s.path.startsWith(path + '/')) delete this.snapshots[id];
    for (const [id, d] of this.remoteDocs) if (d.path === path || d.path.startsWith(path + '/')) this.remoteDocs.delete(id);
    void this.saveSettings();
  }
  onunload() {
    this.generation++;
    this.active = false;
    this.socket?.disconnect();
    if (this.socketTimer) window.clearTimeout(this.socketTimer);
    this.session = undefined;
  }

  private keyboardDebug = false;

  private views(): RaftView[] {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE).map(l => l.view).filter((v): v is RaftView => v instanceof RaftView);
  }
  async openView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) as WorkspaceLeaf;
      if (!leaf) return;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }
  saveSettings(): Promise<void> {
    this.saving = this.saving.catch(() => {}).then(() => this.saveData({ settings: this.settings, snapshots: this.snapshots, applied: this.applied,
      sentHashes: this.sentHashes, answeredNeeds: this.answeredNeeds }));
    return this.saving;
  }
  private storeSession() {
    if (!this.app.secretStorage) return;
    try { this.app.secretStorage.setSecret(this.secretId, this.session ? JSON.stringify(this.session) : ''); }
    catch { new Notice('Raft: login is kept for this session only.'); }
  }
  async signOut() {
    const previous = this.session;
    this.generation++;
    this.session = undefined;
    this.storeSession();
    this.socket?.disconnect();
    this.watchedChannels.clear();
    this.settings.channelId = ''; this.settings.agent = '';
    await this.saveSettings();
    // Revoke after the local session is gone, so a slow or failed request never keeps anyone signed in.
    if (previous) void this.client.revoke(previous);
  }
  /** Moves the signed-in account to another of its servers. Raft tokens are per account; the server is a header. */
  async switchServer(server: ServerInfo) {
    const current = this.session;
    if (!current) throw new Error('Sign in first.');
    if (server.id === current.serverId) return;
    const next: Session = { ...current, serverId: server.id, serverSlug: server.slug, serverName: server.name };
    if (!next.serverSlug) delete next.serverSlug;
    if (!next.serverName) delete next.serverName;
    this.generation++;
    this.session = next;
    this.storeSession();
    this.watchedChannels.clear();
    this.agentActivity.clear();
    this.threadParents.clear();
    Object.assign(this.settings, { serverId: next.serverId, serverSlug: next.serverSlug ?? '', channelId: '', agent: '' });
    await this.saveSettings();
    this.connectRealtime();
    this.reloadViews();
  }
  /** Re-renders open Raft panes after the account or server changed outside them. */
  reloadViews() { for (const view of this.views()) void view.reload(); }
  private connectRealtime() {
    this.socket?.disconnect();
    if (!this.session || !this.active) return;
    this.socket = io(this.session.apiUrl, {
      transports: ['websocket'], auth: { token: this.session.accessToken, serverId: this.session.serverId, clientKind: 'desktop' },
      reconnectionDelayMax: 10000,
    });
    // Notifications trigger an authenticated history read, which also recovers missed events.
    this.socket.on('message:new', () => {
      if (this.socketTimer) return;
      this.socketTimer = window.setTimeout(() => {
        this.socketTimer = undefined;
        this.views().forEach(v => void v.refresh());
      }, 150);
    });
    this.socket.on('agent:activity', (event: { agentId?: unknown; activity?: unknown }) => {
      if (typeof event?.agentId !== 'string' || typeof event.activity !== 'string') return;
      this.agentActivity.set(event.agentId, event.activity);
      this.views().forEach(v => v.updateContext());
    });
    this.socket.on('connect', () => {
      if (this.settings.channelId) this.watchedChannels.add(this.settings.channelId);
      for (const channel of this.watchedChannels) this.socket?.emit('join:channel', channel);
    });
  }
  watchChannel(channelId: string) { this.watchedChannels.add(channelId); this.socket?.emit('join:channel', channelId); }

  private bindingsPath() { return `${this.pluginDir()}/${BINDINGS_FILE}`; }
  private pluginDir() { return this.manifest?.dir ?? `${this.app.vault.configDir}/plugins/raft-page`; }
  /** Reads the changes other devices applied; their files sync with the vault like bindings.json. */
  async loadSharedApplied() {
    const adapter = this.app.vault.adapter, own = `applied-${this.deviceId}.json`;
    if (!adapter) return;
    try {
      const listing = await adapter.list(this.pluginDir());
      const next = new Set<string>();
      for (const file of listing.files) {
        const name = file.split('/').pop() ?? '';
        if (!/^applied-[a-z0-9-]+\.json$/.test(name) || name === own) continue;
        try {
          const ids: unknown = JSON.parse(await adapter.read(file));
          if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') next.add(id);
        } catch { /* A half-synced file is read again next time. */ }
      }
      this.sharedApplied = next;
    } catch { /* No plugin folder yet. */ }
  }
  private async saveSharedApplied() {
    const adapter = this.app.vault.adapter;
    if (!adapter) return;
    try { await adapter.write(`${this.pluginDir()}/applied-${this.deviceId}.json`, JSON.stringify(this.applied)); }
    catch { /* The base hash still refuses a second apply on another device. */ }
  }
  /** Also called on refresh, so bindings made on another device show up without restarting Obsidian. */
  async loadBindings() {
    const adapter = this.app.vault.adapter, path = this.bindingsPath();
    await this.bindingWrites.catch(() => {});
    try {
      if (adapter && await adapter.exists(path)) this.bindings = parseBindings(await adapter.read(path));
    } catch { new Notice(`Raft: ${path} could not be read. Channel bindings are off until it is fixed.`); }
  }
  /** Writes are queued so a rename that lands during a bind cannot lose either change. */
  saveBindings(next: Bindings): Promise<void> {
    this.bindings = next;
    this.bindingWrites = this.bindingWrites.catch(() => {}).then(async () => {
      const adapter = this.app.vault.adapter;
      if (!adapter) return;
      const path = this.bindingsPath(), folder = path.slice(0, path.lastIndexOf('/'));
      if (!await adapter.exists(folder)) await adapter.mkdir(folder);
      await adapter.write(path, serializeBindings(this.bindings));
    });
    this.views().forEach(v => v.updateContext());
    return this.bindingWrites;
  }
  /** The binding that applies to a path (the attached note by default) for the signed-in server. */
  bindingFor(path = this.attachedNote()?.path): ResolvedBinding | null {
    return path && this.session ? resolveBinding(this.bindings, path, this.session.serverId) : null;
  }
  channelBinding(channelId = this.settings.channelId): ResolvedBinding | null {
    return channelId && this.session ? resolveChannelBinding(this.bindings, channelId, this.session.serverId) : null;
  }
  async bindPath(target: TAbstractFile, channel: { id: string; name: string }, steward?: { id: string; name: string } | null) {
    if (!this.session) throw new Error('Sign in to Raft first.');
    const kind = target instanceof TFolder ? 'folder' : 'file';
    const { bindings, replaced } = bind(this.bindings, target.path, { channelId: channel.id, channelName: channel.name, serverId: this.session.serverId, kind });
    await this.saveBindings(bindings);
    if (replaced.length) new Notice(`#${channel.name} was bound to ${replaced.join(', ')}; it now follows ${target.path}.`);
    // Tell the channel once, with the folder layout, so agents know which notes belong here without reading them all.
    const where = `${kind === 'folder' ? 'folder' : 'note'} \`${target.path}\` (vault “${this.app.vault.getName()}”)`;
    const manifest = target instanceof TFolder
      ? folderManifest(this.app.vault.getFiles().map(f => ({ path: f.path, size: f.stat?.size ?? 0 })), target.path) : '';
    try {
      await this.client.send(channel.id, `📁 This channel is now bound to the Obsidian ${where} via Raft Page.` +
        (manifest ? `\n\nFiles:\n${manifest}` : ''));
    } catch { new Notice('Raft: bound, but the notice could not be posted to the channel.'); }
    this.views().forEach(v => v.followNote());
    if (steward) await this.setSteward(target.path, steward);
    else if (steward === undefined) void this.chooseSteward(target.path, true).catch(() => {});
  }
  async unbindPath(path: string) { await this.saveBindings(unbind(this.bindings, path)); }
  chooseChannel(target: TAbstractFile, onDone?: () => void) {
    if (!this.session) { new Notice('Raft: sign in from the Raft sidebar first.'); return; }
    void this.client.channels().then(channels => new ChannelPicker(this, target, channels, onDone).open(),
      () => new Notice('Raft: channels could not be loaded.'));
  }
  revealInTree(path: string) {
    const target = this.app.vault.getAbstractFileByPath(path);
    const explorer = (this.app as unknown as { internalPlugins?: { getPluginById(id: string): { instance?: { revealInFolder?(f: TAbstractFile): void } } | null } })
      .internalPlugins?.getPluginById('file-explorer')?.instance;
    if (target && explorer?.revealInFolder) explorer.revealInFolder(target);
  }
  private fileMenu(menu: Menu, file: TAbstractFile) {
    if (!this.session || (file instanceof TFile && file.extension !== 'md')) return;
    const own = this.bindings[file.path];
    menu.addItem(item => item.setTitle(own ? `Rebind from #${own.channelName}…` : 'Bind to Raft channel…').setIcon('link')
      .onClick(() => this.chooseChannel(file)));
    menu.addItem(item => item.setTitle('New Raft channel for this ' + (file instanceof TFolder ? 'folder…' : 'note…')).setIcon('plus-circle')
      .onClick(() => this.newChannel(file)));
    if (own) menu.addItem(item => item.setTitle('Unbind from Raft channel').setIcon('unlink').onClick(() => void this.unbindPath(file.path)));
  }
  newChannel(target: TAbstractFile, onDone?: () => void) {
    if (!this.session) { new Notice('Raft: sign in from the Raft sidebar first.'); return; }
    void this.client.serverAgents().then(agents => new NewChannelModal(this, target, agents, onDone).open(),
      () => new NewChannelModal(this, target, [], onDone).open());
  }
  /** Creates a channel with the chosen agents and binds the note or folder to it; the first agent becomes its steward. */
  async createChannelFor(target: TAbstractFile, name: string, agents: { id: string; name: string }[], isPrivate: boolean, docType?: string) {
    if (!this.session) throw new Error('Sign in to Raft first.');
    const channel = await this.client.createChannel(name, { private: isPrivate, agentIds: agents.map(a => a.id),
      description: `Obsidian ${target instanceof TFolder ? 'folder' : 'note'} ${target.path}` });
    this.watchChannel(channel.id);
    await this.bindPath(target, channel, agents[0] ?? null);
    if (docType && target instanceof TFile) await this.applyDocType(target, docType, channel.name, agents[0]?.name);
    this.views().forEach(v => void v.refreshCatalog(true));
    return channel;
  }

  /** Document types that have a template note in the vault's `_templates/` folder. */
  docTypes(): string[] {
    const folder = this.app.vault.getAbstractFileByPath(TEMPLATE_FOLDER);
    return folder instanceof TFolder ? templateTypes(folder.children.filter((c): c is TFile => c instanceof TFile && c.extension === 'md').map(c => c.basename)) : [];
  }

  /** An empty note starts from its type's template; every note gets the type and its binding's properties. */
  async applyDocType(file: TFile, type: string, channel: string, steward?: string) {
    const template = this.app.vault.getAbstractFileByPath(`${TEMPLATE_FOLDER}/${type}.md`);
    if (template instanceof TFile) {
      const text = fillTemplate(await this.app.vault.read(template), file.basename, new Date());
      await this.app.vault.process(file, current => current.trim() ? current : text);
    }
    await this.setBindingProperties(file, { type, channel, steward });
  }

  async setBindingProperties(file: TFile, p: { type?: string; channel: string; steward?: string }) {
    const manager = (this.app as { fileManager?: { processFrontMatter?: (f: TFile, fn: (front: Record<string, unknown>) => void) => Promise<void> } }).fileManager;
    if (!manager?.processFrontMatter) return;
    await manager.processFrontMatter(file, front => mergeProperties(front, { ...p, date: formatDate(new Date()) }));
  }

  /** Sets or clears the steward of the binding at `path`. */
  async setSteward(path: string, agent: { id: string; name: string } | null) {
    const binding = this.bindings[path];
    if (!binding) throw new Error(`${path} is not bound.`);
    const next = { ...binding };
    if (agent) Object.assign(next, { stewardId: agent.id, stewardName: agent.name, stewardSince: new Date().toISOString(), paused: undefined });
    else { delete next.stewardId; delete next.stewardName; delete next.stewardSince; }
    // The sync thread opens with instructions addressed to its steward, so a new steward gets a new thread.
    if (agent?.id !== binding.stewardId) {
      delete next.syncRootId; delete next.syncBrief; delete next.syncChannelId;
      delete this.sentHashes[path];
      await this.saveSettings();
    }
    await this.saveBindings({ ...this.bindings, [path]: next });
    new Notice(agent ? `@${agent.name} now keeps ${path} up to date from #${binding.channelName}.` : `Automatic updates for ${path} are off.`);
  }
  async setPaused(path: string, paused: boolean) {
    const binding = this.bindings[path];
    if (binding) await this.saveBindings({ ...this.bindings, [path]: { ...binding, paused: paused || undefined } });
  }
  /** Offers the channel's agents as steward; the default steward is taken directly when it is in the channel. */
  async chooseSteward(path: string, useDefault = false) {
    const binding = this.bindings[path];
    if (!binding || !this.session) return;
    const agents = await this.client.agents(binding.channelId);
    const preferred = agents.find(a => a.name === this.settings.defaultSteward);
    if (useDefault && preferred) { await this.setSteward(path, preferred); return; }
    if (useDefault && !agents.length) return;
    new StewardPicker(this, path, agents).open();
  }

  /** Every 30 seconds: for each binding with a steward, answer its file requests and ask it to sync once the channel is quiet. */
  async syncTick(force?: string) {
    if ((this.syncing && Date.now() - this.syncing < SYNC_STALL_MS) || !this.session || !this.active) return;
    const started = this.syncing = Date.now(), requestsBefore = this.requestCount;
    const steps: Record<string, number> = {}, failures: string[] = [];
    const timed = async (name: string, step: () => Promise<unknown>) => {
      const at = Date.now();
      try { await step(); } catch (cause) { failures.push(`${name}: ${cause instanceof Error ? cause.message : cause}`); throw cause; }
      finally { steps[name] = Date.now() - at; }
    };
    try {
      await this.loadSharedApplied();
      const generation = this.generation, identity = this.identity(this.session);
      const channels = new Set(Object.values(this.bindings)
        .filter(b => b.stewardId && !b.paused && b.serverId === this.session!.serverId).map(b => b.channelId));
      // Applying received edits is separate from asking the steward to produce new ones: no quiet-period delay,
      // and no dependency on which channel or thread happens to be visible in the sidebar.
      for (const channel of channels) {
        try { await timed(`read ${this.bindingChannelName(channel)}`, () => this.ingestBoundChannel(channel)); }
        catch (cause) { if (force) new Notice(`Raft: could not read document updates. ${cause instanceof Error ? cause.message : ''}`); }
        if (!this.active || generation !== this.generation || identity !== this.identity(this.session)) return;
      }
      await this.applying;
      for (const [path, binding] of Object.entries(this.bindings)) {
        if (!this.active || generation !== this.generation || identity !== this.identity(this.session)) return;
        if (!binding.stewardId || binding.serverId !== this.session.serverId) continue;
        if (force ? force !== path : binding.paused) continue;
        try { await timed(`sync ${path}`, () => this.syncBinding(path, force === path)); }
        catch (cause) { if (force) new Notice(`Raft: sync failed. ${cause instanceof Error ? cause.message : ''}`); }
      }
    } finally {
      if (this.syncing === started) this.syncing = 0;
      void this.recordSync({ at: new Date(started).toISOString(), ms: Date.now() - started, requests: this.requestCount - requestsBefore,
        slow: Object.fromEntries(Object.entries(steps).filter(([, ms]) => ms > 2000).sort((a, b) => b[1] - a[1])), failures });
    }
  }
  private bindingChannelName(channelId: string) {
    return Object.values(this.bindings).find(b => b.channelId === channelId)?.channelName ?? channelId;
  }
  private async recordSync(entry: unknown) {
    this.syncLog = [...this.syncLog, entry].slice(-50);
    const adapter = this.app.vault.adapter;
    if (!adapter || !this.deviceId) return;
    try { await adapter.write(`${this.pluginDir()}/sync-log-${this.deviceId}.json`, JSON.stringify(this.syncLog, null, 1)); } catch { /* diagnostics only */ }
  }
  syncNow(path: string) { void this.syncTick(path); }

  private async syncBinding(path: string, force: boolean) {
    let binding = this.bindings[path];
    const steward = { id: binding.stewardId!, name: binding.stewardName || '' };
    let threadId: string | null = null;
    let through = Date.parse(binding.stewardSince || '') || Date.now();
    if (binding.syncRootId && binding.syncChannelId) {
      threadId = await this.threadChannel(binding.syncChannelId, binding.syncRootId);
      if (threadId) {
        const replies = (await this.channelHistory(threadId)).map(m => ({ ...m, channelId: threadId! }));
        through = Math.max(through, lastSyncedThrough(replies, path));
        for (const reply of replies) if (reply.senderId === steward.id) this.autoApply(reply);
        await this.applying;
        for (const reply of replies) if (reply.senderId === steward.id) {
          await this.answerNeeds(reply, binding.syncChannelId, path);
        }
      }
    }
    if (binding.syncChannelId) await this.ingestOtherSyncReplies(path, binding.syncChannelId, binding.syncRootId, steward.id);
    const page = await this.client.messages(binding.channelId, { limit: 50 });
    through = Math.max(through, lastSyncedThrough(page.messages, path));
    const activity = newActivity(page.messages, page.threadSummariesByParentMessageId, through, { rootId: binding.syncRootId, stewardId: steward.id });
    if (!activity.latest) { if (force) new Notice('Raft: nothing new to sync.'); return; }
    if (!force && Date.now() - activity.latest < QUIET_MS) return;
    // The thread's first message carries the steward's instructions; a thread from an older brief (or another
    // steward) is replaced by a new one.
    // Syncing happens in a direct message with the steward, so the bound channel never sees it.
    if (!binding.syncRootId || !binding.syncChannelId || binding.syncBrief !== BRIEF_VERSION) {
      const dm = await this.client.openDm(steward.id);
      const root = await this.client.send(dm, syncRootMessage(path, steward.name, binding.channelName));
      binding = { ...binding, syncChannelId: dm, syncRootId: root.id, syncBrief: BRIEF_VERSION };
      // A new conversation has no attachment history, even if a previous thread received the same version.
      delete this.sentHashes[path];
      await this.saveSettings();
      await this.saveBindings({ ...this.bindings, [path]: binding });
    }
    const files = await this.bindingFiles(path, binding);
    const sent = this.sentHashes[path] ?? {};
    const firstFolderSync = binding.kind === 'folder' && !Object.keys(sent).length;
    const small = files.reduce((n, f) => n + f.text.length, 0) < 60_000;
    // The steward gets a note's text when it changes (or, for a small folder, all notes the first time);
    // anything else it asks for with a raft-need block.
    const changed = files.filter(f => sent[f.path] ? sent[f.path] !== f.hash : binding.kind === 'file' || (firstFolderSync && small)).slice(0, 10);
    threadId = await this.client.ensureThread(binding.syncChannelId!, binding.syncRootId!);
    this.threadParents.set(threadId, binding.syncChannelId!);
    // Only notes that actually uploaded count as sent; the rest go again next time.
    const { ids: attachmentIds, paths: uploaded } = await this.uploadNotes(threadId, changed);
    const content = composeSyncRequest({ steward: steward.name, binding: path, kind: binding.kind, vault: this.app.vault.getName(),
      channelName: binding.channelName, since: through, through: activity.latest, activity,
      files: files.map(f => ({ path: f.path, hash: f.hash })), attached: uploaded });
    await this.client.send(threadId, content, undefined, attachmentIds.length ? attachmentIds : undefined);
    for (const f of changed) if (uploaded.includes(f.path)) sent[f.path] = f.hash;
    this.sentHashes[path] = sent;
    await this.saveSettings();
  }
  /**
   * A steward may answer in an earlier sync thread for the same note (a new thread starts whenever the steward or the
   * brief changes) or directly in the direct message. Those replies count too; only the latest page of the direct
   * message is read, and a thread is read again only when its last reply changes.
   */
  private async ingestOtherSyncReplies(path: string, dm: string, currentRoot: string | undefined, stewardId: string) {
    const page = await this.client.messages(dm, { limit: 50 });
    const opener = `📝 Document sync for \`${path}\``;
    for (const message of page.messages) {
      if (message.senderId === stewardId) this.autoApply({ ...message, channelId: message.channelId ?? dm });
      const summary = page.threadSummariesByParentMessageId?.[message.id] ?? message.threadSummary;
      if (message.id === currentRoot || !message.content.startsWith(opener) || !summary?.replyCount) continue;
      const stamp = `${summary.replyCount}:${summary.lastReplyAt ?? ''}`;
      if (this.scannedSyncThreads.get(message.id) === stamp) continue;
      const threadId = await this.threadChannel(dm, message.id);
      if (!threadId) continue;
      const replies = (await this.channelHistory(threadId)).map(m => ({ ...m, channelId: threadId }));
      for (const reply of replies) if (reply.senderId === stewardId) this.autoApply(reply);
      await this.applying;
      for (const reply of replies) if (reply.senderId === stewardId) await this.answerNeeds(reply, dm, path);
      this.scannedSyncThreads.set(message.id, stamp);
    }
    await this.applying;
  }
  /** The notes a binding covers, with their current text and hash. */
  private async bindingFiles(path: string, binding: { kind: 'file' | 'folder' }) {
    const files = binding.kind === 'file' ? [this.app.vault.getAbstractFileByPath(path)].filter((f): f is TFile => f instanceof TFile)
      : this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(path + '/') && resolveBinding(this.bindings, f.path, this.session!.serverId)?.path === path);
    return Promise.all(files.slice(0, 300).map(async f => {
      const text = (await this.currentText(f.path)) ?? '';
      return { path: f.path, text, hash: await hashText(text) };
    }));
  }
  private async uploadNotes(channelId: string, notes: { path: string; text: string }[]) {
    const ids: string[] = [], paths: string[] = [];
    for (const note of notes) {
      if (!note.text) continue;
      try { ids.push(await this.client.uploadText(channelId, note.path.split('/').pop() || 'note.md', note.text)); paths.push(note.path); }
      catch (cause) { if (cause instanceof RaftClientError && cause.status === 401) throw cause; }
    }
    return { ids, paths };
  }
  /**
   * Answers the steward in the conversation where it asked: ordinary channel requests get a reply thread, while
   * existing threads (including the sync DM thread) keep the reply there. Never uses guessed filesystem paths.
   */
  private async answerNeeds(message: Message, parentChannelId: string, syncPath?: string) {
    if (!this.session || !message.senderId || !message.channelId || !/^```raft-need\s*\r?\n/m.test(message.content)) return;
    const generation = this.generation, identity = this.identity(this.session), serverId = this.session.serverId;
    const eligible = () => Object.entries(this.bindings).filter(([path, b]) => b.serverId === serverId &&
      b.stewardId === message.senderId && !b.paused && (syncPath === undefined ? b.channelId === parentChannelId
        : path === syncPath && b.syncChannelId === parentChannelId));
    const bindings = eligible();
    if (!bindings.length || !this.inBindingChannel(parentChannelId, message.channelId)) return;
    const policy = () => JSON.stringify(eligible().map(([path, b]) => [path, b.channelId, b.syncChannelId, b.stewardId]));
    const originalPolicy = policy();
    const assertCurrent = () => {
      this.assertSession(generation, identity);
      if (policy() !== originalPolicy) throw new Error('The document binding changed while reading.');
    };
    const key = JSON.stringify([identity, parentChannelId, message.channelId, message.id, syncPath ?? null]);
    // Old versions recorded only the message ID for sync requests. Respect those receipts after an upgrade.
    if (this.answeredNeeds.includes(key) || (syncPath !== undefined && this.answeredNeeds.includes(message.id)) || this.answeringNeeds.has(key)) return;
    this.answeringNeeds.add(key);
    try {
      const paths = [...new Set(parseNeeds(message.content))];
      let complete = true;
      const lines = [`@${message.senderName} Requested notes (path · sha256):`];
      const attachments: string[] = [];
      const delivered: { binding: string; path: string; hash: string }[] = [];
      const target = message.channelId === parentChannelId ? await this.client.ensureThread(parentChannelId, message.id) : message.channelId;
      assertCurrent();
      this.threadParents.set(target, parentChannelId);
      // The local record is per device and per sign-in. The conversation itself says whether any device already answered.
      if (await this.needAnswered(target, message)) {
        assertCurrent();
        this.answeredNeeds.push(key); this.answeredNeeds = this.answeredNeeds.slice(-200);
        this.needReceipts.delete(key);
        await this.saveSettings();
        return;
      }
      assertCurrent();
      if (!paths.length) lines.push('Invalid raft-need request. Use {"paths":["folder/note.md"]} with vault-relative Markdown paths.');
      for (const [index, requested] of paths.entries()) {
        const path = safeNotePath(requested);
        const resolved = path ? resolveBinding(this.bindings, path, serverId) : null;
        if (!path || !resolved || !bindings.some(([root]) => root === resolved.path)) {
          lines.push(`- ${requested}: not available in this binding.`); continue;
        }
        if (index >= 10) { lines.push(`- ${path}: request limit reached; ask for this note in a separate request.`); continue; }
        let text: string | null;
        try { text = await this.currentText(path); }
        catch { assertCurrent(); complete = false; lines.push(`- ${path}: read failed; the plugin will retry.`); continue; }
        assertCurrent();
        if (text === null) { lines.push(`- ${path}: note not found in this binding.`); continue; }
        const hash = await hashText(text);
        assertCurrent();
        // Raft rejects empty uploads. This receipt is an unambiguous representation of an empty note.
        if (text === '') {
          lines.push(`- ${path} · ${hash} · empty note (0 bytes).`);
          delivered.push({ binding: resolved.path, path, hash });
          continue;
        }
        try {
          const id = await this.client.uploadText(target, path.split('/').pop() || 'note.md', text);
          assertCurrent();
          attachments.push(id);
          delivered.push({ binding: resolved.path, path, hash });
          lines.push(`- ${path} · ${hash} · attached.`);
        } catch (cause) {
          assertCurrent();
          if (cause instanceof RaftClientError && (cause.status === 401 || cause.status === 403)) throw cause;
          complete = false;
          lines.push(`- ${path}: attachment upload failed; the plugin will retry.`);
        }
      }
      // Only a complete answer carries the hidden marker, so a failed read is still retried by any device.
      const content = lines.join('\n') + (complete ? needMarker(message.id) : '');
      // A repeated failure gets one receipt, not another warning every 30 seconds. A successful retry always sends.
      if (this.needReceipts.get(key) !== content || complete) {
        assertCurrent();
        await this.client.send(target, content, undefined, attachments.length ? attachments : undefined);
        assertCurrent();
        this.needReceipts.set(key, content);
        for (const note of delivered) {
          (this.sentHashes[note.binding] ??= {})[note.path] = note.hash;
        }
      }
      // Completion is recorded only after the response is acknowledged; transport failures remain retryable.
      if (complete) {
        this.answeredNeeds.push(key); this.answeredNeeds = this.answeredNeeds.slice(-200);
        this.needReceipts.delete(key);
      }
      await this.saveSettings();
    } catch {
      // A dropped response must not mark the request answered. The next background pass will retry it.
      if (this.active && generation === this.generation && identity === this.identity(this.session) && !this.needReceipts.has(key)) {
        new Notice('Raft: a document read could not be delivered. The plugin will retry.');
        this.needReceipts.set(key, 'delivery-failed');
      }
    } finally { this.answeringNeeds.delete(key); }
  }

  private activeNote(): TFile | null {
    const file = this.app.workspace.getActiveFile();
    return file?.extension === 'md' ? file : null;
  }
  private attachedNote(): TFile | null {
    if (!this.note) this.note = this.activeNote();
    return this.note?.extension === 'md' ? this.note : null;
  }
  getAttachedName(): string | null { return this.attachedNote()?.path ?? null; }
  async captureDocument(useSelection: boolean): Promise<DocumentContext | null> {
    const file = this.attachedNote();
    if (!file || file.extension !== 'md') return null;
    const path = file.path;
    const view = this.app.workspace.getLeavesOfType('markdown').map(l => l.view)
      .find((v): v is MarkdownView => v instanceof MarkdownView && v.file === file);
    const full = view ? view.editor.getValue() : await this.app.vault.read(file);
    const selectedRange = useSelection && view?.editor.somethingSelected() ? {
      from: view.editor.posToOffset(view.editor.getCursor('from')), to: view.editor.posToOffset(view.editor.getCursor('to')),
    } : undefined;
    if (useSelection && !selectedRange) throw new Error('Select text in the attached note first, or turn off Selected text.');
    const context: DocumentContext = { id: crypto.randomUUID(), path, content: full, baseHash: await hashText(full), selection: selectedRange };
    if (file.path !== path || this.app.vault.getAbstractFileByPath(path) !== file) throw new Error('The attached note was moved or deleted. Please try again.');
    if (selectedRange) context.content = full.slice(selectedRange.from, selectedRange.to);
    this.capturedFiles.set(context, file);
    if (context.content.length > 100_000) throw new Error('The attached text exceeds 100,000 characters. Select a smaller section.');
    return context;
  }
  private assertCaptured(context: DocumentContext) {
    const file = this.capturedFiles.get(context);
    if (!file || file.path !== context.path || this.app.vault.getAbstractFileByPath(context.path) !== file) throw new Error('The attached note was moved or deleted. Please try again.');
  }
  async send(channelId: string, agent: string, text: string, attach: boolean, useSelection: boolean, threadParentId?: string) {
    if (!this.session) throw new Error('Sign in to Raft first.');
    const generation = this.generation, identity = this.identity(this.session), owner = this.session;
    const context = attach ? await this.captureDocument(useSelection) : null;
    this.assertSession(generation, identity);
    if (attach && !context) throw new Error('Open a Markdown note to attach it, or turn off Attach note.');
    if (context) {
      const selected = (await this.client.agents(channelId)).find(a => a.name === agent);
      this.assertSession(generation, identity);
      this.assertCaptured(context);
      const { content: _, ...metadata } = context;
      this.snapshots[context.id] = { ...metadata, channelId, agent, agentId: selected?.id,
        userId: owner.userId, apiUrl: owner.apiUrl, serverId: owner.serverId, createdAt: new Date().toISOString(), threadChannels: [] };
      const keys = Object.keys(this.snapshots);
      for (const key of keys.slice(0, Math.max(0, keys.length - 200))) delete this.snapshots[key];
      // Persist the binding before sending, so fast replies have a document target.
      await this.saveSettings();
    }
    this.assertSession(generation, identity);
    if (context) this.assertCaptured(context);
    // The note travels as a file so the message itself stays readable in Raft. Raft rejects empty files, and a
    // server without attachment storage cannot take one, so those sends carry the text inline instead.
    // A thread reply is posted in the thread's own channel, and its file is uploaded there too.
    const target = threadParentId ? await this.client.ensureThread(channelId, threadParentId) : channelId;
    this.assertSession(generation, identity);
    let attachmentId: string | undefined;
    if (context?.content) {
      const name = (context.path.split('/').pop() || 'note.md').replace(/\.md$/i, '') + (context.selection ? ' (selection).md' : '.md');
      try { attachmentId = await this.client.uploadText(target, name, context.content); }
      catch (cause) { if (cause instanceof RaftClientError && cause.status === 401) throw cause; }
      this.assertSession(generation, identity);
      this.assertCaptured(context);
    }
    const binding = context ? this.bindingFor(context.path) : null;
    const sent = await this.client.send(target, composeMessage(agent, text, context, !!attachmentId, binding?.kind === 'folder' ? binding.path : undefined),
      undefined, attachmentId ? [attachmentId] : undefined);
    if (target !== channelId) this.threadParents.set(target, channelId);
    if (sent.unresolvedMentionHandles?.length || sent.pendingMentionActions?.length || sent.deliveryWarnings?.length) {
      new Notice('Message sent, but Raft reports that the mention may not have reached the agent. Check the channel in Raft.', 12000);
    }
    this.watchChannel(channelId);
  }
  async threadChannel(parentChannelId: string, rootId: string): Promise<string | null> {
    const id = await this.client.threadChannel(parentChannelId, rootId);
    if (id) {
      this.threadParents.set(id, parentChannelId);
      this.watchChannel(id);
      for (const snapshot of Object.values(this.snapshots)) {
        if (snapshot.channelId === parentChannelId && !snapshot.threadChannels.includes(id)) snapshot.threadChannels.push(id);
      }
    }
    return id;
  }
  proposals(message: Message): Proposal[] {
    if (!this.session || this.applied.includes(message.id)) return [];
    const session = this.session;
    this.learnSend(message);
    return parseProposals(message.content, message.id, message.senderName).flatMap((p): Proposal[] => {
      if (this.applied.includes(p.id) || this.sharedApplied.has(p.id)) return [];
      if (p.documentId) {
        const s = this.snapshots[p.documentId];
        if (!s) { const remote = this.remoteDoc(p.documentId, p.baseHash, message); return remote ? [{ ...p, path: remote.path }] : []; }
        if ( s.apiUrl !== session.apiUrl || s.serverId !== session.serverId || s.userId !== session.userId || s.baseHash !== p.baseHash ||
          // Any agent in the bound conversation may answer; the user still reviews and the base hash still guards the write.
          (message.senderType !== 'agent' && (!s.agentId || message.senderId !== s.agentId))) return [];
        const channelId = message.channelId;
        if (channelId !== s.channelId && !s.threadChannels.includes(channelId || '')) return [];
        return [{ ...p, path: s.path }];
      }
      // Changes named by path must target a note inside a binding of the channel they were posted in.
      const binding = p.path ? resolveBinding(this.bindings, p.path, session.serverId) : null;
      if (!binding || (binding.kind === 'file' && p.create) || !(this.inBindingChannel(binding.channelId, message.channelId) ||
        (binding.syncChannelId && this.inBindingChannel(binding.syncChannelId, message.channelId)))) return [];
      // With a steward, only the steward changes the notes; other agents' edits are conversation it may record.
      if (binding.stewardId ? message.senderId !== binding.stewardId : message.senderType !== 'agent') return [];
      return [{ ...p, path: p.path! }];
    });
  }
  /** Remembers a whole-note send this account made, wherever it was made. */
  private learnSend(message: Message) {
    if (!this.session || message.senderId !== this.session.userId || !message.channelId) return;
    const note = sentNote(message.content);
    if (!note || this.snapshots[note.documentId] || this.remoteDocs.has(note.documentId)) return;
    this.remoteDocs.set(note.documentId, { path: note.path, baseHash: note.baseHash, channelId: message.channelId,
      createdAt: message.createdAt || '', identity: this.identity(this.session) });
    for (const key of [...this.remoteDocs.keys()].slice(0, Math.max(0, this.remoteDocs.size - 200))) this.remoteDocs.delete(key);
  }
  /**
   * A reply to a note sent from another device: the same account, an agent replying in the send's conversation, and
   * the note bound to that conversation. Unbound notes keep applying only on the device that sent them.
   */
  private remoteDoc(documentId: string, baseHash: string | undefined, message?: Message): RemoteDoc | undefined {
    const d = this.remoteDocs.get(documentId);
    if (!d || !this.session || d.identity !== this.identity(this.session) || d.baseHash !== baseHash) return;
    if (message && (message.senderType !== 'agent' || !message.channelId ||
      (message.channelId !== d.channelId && this.threadParents.get(message.channelId) !== d.channelId))) return;
    const home = this.threadParents.get(d.channelId) ?? d.channelId;
    const binding = resolveBinding(this.bindings, d.path, this.session.serverId);
    return binding && binding.channelId === home ? d : undefined;
  }
  /** Whether a message's channel is the bound channel or one of its threads. */
  inBindingChannel(channelId: string, messageChannel?: string) {
    return !!messageChannel && (messageChannel === channelId || this.threadParents.get(messageChannel) === channelId);
  }
  /**
   * Writes eligible agent edits straight into the note (the user asked for no preview step). The base-hash and
   * identity checks in applyProposal still refuse anything sent against an older version of the note.
   */
  autoApply(message: Message) {
    if (!this.settings.autoApply) return;
    for (const proposal of this.proposals(message)) {
      if (this.autoTried.has(proposal.id)) continue;
      if (proposal.documentId) {
        const snapshot = this.snapshots[proposal.documentId];
        // A bound note only takes automatic edits from its own channel; edits arriving from elsewhere stay as cards.
        // (remoteDoc already checked the binding for notes sent from another device.)
        const binding = snapshot && resolveBinding(this.bindings, snapshot.path, snapshot.serverId);
        if (binding && binding.channelId !== snapshot.channelId) continue;
        // Only replies to the latest send of a note apply on their own, whichever device sent it. Replies to earlier
        // sends stay as manual cards, so an old proposal can never be written ahead of the one the user is waiting for.
        const target = snapshot ?? this.remoteDocs.get(proposal.documentId);
        if (!target) continue;
        const at = Date.parse(target.createdAt) || 0;
        if ([...Object.values(this.snapshots), ...this.remoteDocs.values()].some(other => other.path === target.path && (Date.parse(other.createdAt) || 0) > at)) continue;
      } else {
        // Changes by path apply on their own from the binding's steward while syncing is not paused, or from any
        // agent when the binding has no steward. Nobody is asked to apply them by hand.
        const binding = resolveBinding(this.bindings, proposal.path, this.session!.serverId);
        if (!binding || binding.paused || (binding.stewardId && message.senderId !== binding.stewardId)) continue;
      }
      const generation = this.generation, identity = this.identity(this.session);
      const binding = this.bindingFor(proposal.path);
      if (!proposal.documentId && (binding?.paused || (binding?.stewardId && message.senderId !== binding.stewardId))) continue;
      this.autoTried.add(proposal.id);
      const recent = Date.now() - new Date(message.createdAt || 0).getTime() < 10 * 60_000;
      this.applying = this.applying.catch(() => {}).then(() => {
        this.assertSession(generation, identity);
        if (!this.settings.autoApply) { this.autoTried.delete(proposal.id); return; }
        const binding = this.bindingFor(proposal.path);
        if (!proposal.documentId && (binding?.paused || (binding?.stewardId && message.senderId !== binding.stewardId))) {
          this.autoTried.delete(proposal.id); return;
        }
        if (!this.proposals(message).some(p => p.id === proposal.id)) return;
        return this.applyProposal(proposal);
      }).catch(async cause => {
        // Another device may have applied it first; its record (or the changed note) arrives with the vault sync.
        await this.loadSharedApplied();
        if (this.sharedApplied.has(proposal.id)) return;
        if (proposal.documentId && !this.snapshots[proposal.documentId]) { this.autoTried.delete(proposal.id); return; }
        if (recent) new Notice(`Raft: ${proposal.senderName}'s change was not applied. ${cause instanceof Error ? cause.message : ''}`, 10000);
      });
    }
  }
  /** Read received edits in every page, including old root messages whose threads have new replies. */
  private async ingestBoundChannel(channelId: string) {
    const generation = this.generation, identity = this.identity(this.session);
    const received: Message[] = [];
    for (const root of await this.channelHistory(channelId)) {
      this.assertSession(generation, identity);
      received.push({ ...root, channelId });
      try { await this.scanThread(channelId, root, message => received.push(message)); }
      catch { this.assertSession(generation, identity); /* One inaccessible thread must not block other updates. */ }
    }
    // A reply under an old root can depend on a later top-level edit. Order edits by their own sequence,
    // never by the position of their root in the channel.
    const ordered = received.sort((a, b) => this.compareMessages(a, b));
    for (const message of ordered) this.autoApply(message);
    await this.applying;
    for (const message of ordered) await this.answerNeeds(message, channelId);
  }
  /**
   * Whether a complete answer to this read request is already in the conversation where it would be posted: one
   * carrying its hidden marker, or, from versions before the marker, this account's receipt for the same sender that
   * follows the request before that sender's next request and reports no failure.
   */
  private async needAnswered(target: string, request: Message): Promise<boolean> {
    const page = await this.client.messages(target, { limit: 100, ...(request.seq !== undefined && target === request.channelId ? { after: request.seq } : {}) });
    const later = page.messages.filter(m => m.id !== request.id && (request.seq === undefined || m.seq === undefined || m.seq > request.seq))
      .sort((a, b) => this.compareMessages(a, b));
    if (later.some(m => m.content.includes(needMarker(request.id)))) return true;
    for (const m of later) {
      if (m.senderId === request.senderId && /^```raft-need\s*\r?\n/m.test(m.content)) return false;
      if (m.senderId === this.session?.userId && m.content.startsWith(`@${request.senderName} Requested notes`) &&
        !m.content.includes('[raft-need]: <>') && !/will retry/.test(m.content)) return true;
    }
    return false;
  }
  /** History is oldest first before application, so dependent edits land in the order they were sent. */
  private async channelHistory(channelId: string): Promise<Message[]> {
    const generation = this.generation, identity = this.identity(this.session);
    const messages = new Map<string, Message>();
    const summaries: Record<string, NonNullable<Message['threadSummary']>> = {};
    const cursors = new Set<string>();
    let before: string | number | undefined;
    for (;;) {
      const page = await this.client.messages(channelId, { limit: 50, ...(before === undefined ? {} : { before }) });
      this.assertSession(generation, identity);
      for (const [id, summary] of Object.entries(page.threadSummariesByParentMessageId ?? {})) summaries[id] ??= summary;
      for (const message of page.messages) messages.set(message.id, message);
      if (!page.hasMore || !page.messages.length) break;
      const oldest = page.messages.reduce((a, b) => this.compareMessages(a, b) < 0 ? a : b);
      before = oldest.seq ?? oldest.id;
      if (cursors.has(String(before))) throw new Error('History pagination did not advance. Updates will be retried.');
      cursors.add(String(before));
    }
    return [...messages.values()].map(m => ({ ...m, threadSummary: summaries[m.id] ?? m.threadSummary }))
      .sort((a, b) => this.compareMessages(a, b));
  }
  private compareMessages(a: Message, b: Message) {
    if (a.seq !== undefined && b.seq !== undefined) return a.seq - b.seq;
    return Date.parse(a.createdAt || '') - Date.parse(b.createdAt || '') || a.id.localeCompare(b.id);
  }
  /** Reads ordinary threads as well as threads attached to note sends, even when their root was posted by an agent. */
  async scanThread(parentChannelId: string, root: Message, receive: (message: Message) => void = message => this.autoApply(message)): Promise<void> {
    const summary = root.threadSummary;
    if (!summary?.replyCount || !this.session) return;
    const bound = Object.values(this.bindings).some(b => b.serverId === this.session!.serverId &&
      b.channelId === parentChannelId && b.stewardId && !b.paused);
    const documentId = sentDocumentId(root.content);
    if (!bound && (!this.settings.autoApply || root.senderId !== this.session.userId || !documentId || !this.snapshots[documentId])) return;
    const generation = this.generation, identity = this.identity(this.session);
    const policy = JSON.stringify([this.settings.autoApply, Object.entries(this.bindings)
      .filter(([, b]) => b.serverId === this.session!.serverId && b.channelId === parentChannelId)
      .map(([path, b]) => [path, b.stewardId, b.paused])]);
    const key = `${generation}|${identity}|${parentChannelId}|${root.id}|${policy}`;
    const marker = `${summary.replyCount}|${summary.lastReplyAt ?? ''}`;
    if (this.scannedThreads.get(key) === marker) {
      for (const message of this.scannedReplies.get(key) ?? []) receive(message);
      return;
    }
    let scan = this.scanningThreads.get(key);
    if (!scan) {
      scan = (async (): Promise<Message[]> => {
        const channelId = await this.threadChannel(parentChannelId, root.id);
        this.assertSession(generation, identity);
        if (!channelId) return [];
        const replies = (await this.channelHistory(channelId)).map(message => ({ ...message, channelId }));
        this.scannedReplies.set(key, replies);
        this.scannedThreads.set(key, marker);
        return replies;
      })();
      this.scanningThreads.set(key, scan);
    }
    try {
      const replies = await scan;
      this.assertSession(generation, identity);
      for (const message of replies) receive(message);
    } finally { if (this.scanningThreads.get(key) === scan) this.scanningThreads.delete(key); }
  }
  previewProposal(proposal: Proposal) { new EditPreview(this, proposal).open(); }
  /** Reads the text a change applies to: the open editor when the note is open, otherwise the file. */
  async currentText(path: string): Promise<string | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    const view = this.markdownView(file);
    return view ? view.editor.getValue() : this.app.vault.read(file);
  }
  private markdownView(file: TFile): MarkdownView | undefined {
    return this.app.workspace.getLeavesOfType('markdown').map(l => l.view)
      .find((v): v is MarkdownView => v instanceof MarkdownView && v.file === file);
  }
  async applyProposal(proposal: Proposal) {
    if (!this.session) throw new Error('Sign in to Raft first.');
    if (this.applied.includes(proposal.id) || this.applied.includes(proposal.messageId)) throw new Error('This proposal has already been applied.');
    const generation = this.generation, identity = this.identity(this.session);
    let before: string | null, after: string;
    const remote = proposal.documentId && !this.snapshots[proposal.documentId] ? this.remoteDoc(proposal.documentId, proposal.baseHash) : undefined;
    if (remote) {
      ({ before, after } = await this.writeNote(remote.path, remote.baseHash, current => applyProposalText(current, proposal), () => {
        this.assertSession(generation, identity);
        if (this.remoteDocs.get(proposal.documentId!) !== remote) throw new Error('The original note was moved or deleted. Send its current version again.');
      }, 'This note changed after it was sent. Send the latest version before applying edits.'));
    } else if (proposal.documentId) {
      const snapshot = this.snapshots[proposal.documentId];
      if (!snapshot || snapshot.userId !== this.session.userId || snapshot.apiUrl !== this.session.apiUrl || snapshot.serverId !== this.session.serverId ||
        snapshot.baseHash !== proposal.baseHash) throw new Error('This edit no longer belongs to the current document session.');
      ({ before, after } = await this.writeNote(snapshot.path, snapshot.baseHash, current => applyProposalText(current, proposal, { ...snapshot, content: '' }), () => {
        this.assertSession(generation, identity);
        if (this.snapshots[proposal.documentId!] !== snapshot) throw new Error('The original note was moved or deleted. Send its current version again.');
      }, 'This note changed after it was sent. Send the latest version before applying edits.'));
    } else if (proposal.create) {
      if (this.app.vault.getAbstractFileByPath(proposal.path)) throw new Error(`${proposal.path} already exists.`);
      const folder = proposal.path.split('/').slice(0, -1).join('/');
      if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
      this.assertSession(generation, identity);
      const created = await this.app.vault.create(proposal.path, proposal.content ?? '');
      // A steward's new note in a bound folder carries that binding's channel and steward, like notes made from the dialog.
      const owner = resolveBinding(this.bindings, proposal.path, this.session.serverId);
      if (owner && created instanceof TFile) {
        await this.setBindingProperties(created, { channel: owner.channelName || owner.channelId, steward: owner.stewardName });
      }
      before = null; after = created instanceof TFile ? await this.app.vault.read(created) : proposal.content ?? '';
    } else {
      ({ before, after } = await this.writeNote(proposal.path, proposal.baseHash!, current => applyProposalText(current, proposal),
        () => this.assertSession(generation, identity), 'This note changed after the agent read it. The change was not applied.'));
    }
    this.applied.push(proposal.id); this.applied = this.applied.slice(-500);
    void this.saveSharedApplied();
    this.history.push({ id: proposal.id, path: proposal.path, before, after, senderName: proposal.senderName, at: Date.now() });
    this.history = this.history.slice(-30);
    await this.saveSettings();
    this.noticeApplied(this.history[this.history.length - 1]);
    this.views().forEach(v => void v.refresh());
  }
  /**
   * Replaces a note's text after checking it still has `baseHash`. Open notes change through the editor, which keeps
   * Cmd+Z; closed notes change on disk and are rechecked inside the write.
   */
  private async writeNote(path: string, baseHash: string, change: (current: string) => string, assertCurrent: () => void, stale: string) {
    if (!/^[a-f0-9]{12,64}$/.test(baseHash)) throw new Error('This change does not say which version of the note it was made for.');
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension !== 'md') throw new Error('The original note was moved or deleted. Send its current version again.');
    const view = this.markdownView(file);
    if (view) {
      const targetEditor = view.editor;
      const current = targetEditor.getValue();
      if (!(await hashText(current)).startsWith(baseHash)) throw new Error(stale);
      assertCurrent();
      if (view.file !== file || view.editor !== targetEditor || this.app.vault.getAbstractFileByPath(path) !== file) throw new Error('The open note changed. Please try again.');
      // Recheck synchronously after hashing; preserve native editor undo history.
      if (targetEditor.getValue() !== current) throw new Error('The note changed while checking the edit. Please try again.');
      const next = change(current);
      view.editor.transaction({ changes: [{ from: { line: 0, ch: 0 }, to: view.editor.offsetToPos(current.length), text: next }] });
      await view.save();
      return { before: current, after: next };
    }
    const original = await this.app.vault.read(file);
    if (!(await hashText(original)).startsWith(baseHash)) throw new Error(stale);
    assertCurrent();
    const next = change(original);
    await this.app.vault.process(file, current => {
      assertCurrent();
      if (this.app.vault.getAbstractFileByPath(path) !== file) throw new Error('The original note changed identity. Send it again.');
      if (current !== original) throw new Error('The note changed while saving. No edit was applied.');
      return next;
    });
    return { before: original, after: next };
  }
  private noticeApplied(entry: UndoEntry) {
    const text = `${entry.before === null ? 'Created' : 'Updated'} ${entry.path}`;
    if (typeof document === 'undefined') { new Notice(text); return; }
    const fragment = document.createDocumentFragment();
    fragment.append(`📝 ${text} · ${entry.senderName} `);
    const undo = document.createElement('a');
    undo.textContent = 'Undo';
    undo.addEventListener('click', () => void this.undo(entry.id).catch(cause => new Notice(`Raft: ${cause instanceof Error ? cause.message : 'Undo failed.'}`)));
    fragment.append(undo);
    new Notice(fragment, 8000);
  }
  /** Changes from this message that can still be undone. */
  undoable(messageId: string) { return this.history.filter(entry => entry.id.startsWith(messageId + ':')); }
  /** Puts a note back as it was before an applied change, if nobody has edited it since. */
  async undo(proposalId: string) {
    const entry = this.history.find(e => e.id === proposalId);
    if (!entry) throw new Error('This change can no longer be undone.');
    const file = this.app.vault.getAbstractFileByPath(entry.path);
    if (!(file instanceof TFile)) throw new Error(`${entry.path} is gone.`);
    const current = await this.currentText(entry.path);
    if (current !== entry.after) throw new Error(`${entry.path} was edited after this change, so it was not undone.`);
    if (entry.before === null) await this.app.vault.trash(file, true);
    else await this.writeNote(entry.path, await hashText(entry.after), () => entry.before!, () => {}, `${entry.path} changed. Nothing was undone.`);
    this.history = this.history.filter(e => e !== entry);
    new Notice(`Undid the change to ${entry.path}`);
    this.views().forEach(v => void v.refresh());
  }
  async insertReply(message: Message) {
    if (!this.session) throw new Error('Sign in to Raft first.');
    const generation = this.generation, identity = this.identity(this.session);
    const context = await this.captureDocument(false);
    this.assertSession(generation, identity);
    if (!context || !this.session) throw new Error('Open a note before inserting a reply.');
    const selected = (await this.client.agents(this.settings.channelId)).find(a => a.id === message.senderId);
    this.assertSession(generation, identity);
    if (!selected) throw new Error('Only an agent reply can be inserted.');
    this.assertCaptured(context);
    const { content: _, ...metadata } = context;
    this.snapshots[context.id] = { ...metadata, channelId: this.settings.channelId, agent: selected.name, agentId: selected.id,
      userId: this.session.userId, apiUrl: this.session.apiUrl, serverId: this.session.serverId, threadChannels: [], createdAt: new Date().toISOString() };
    this.previewProposal({ id: message.id + ':insert', documentId: context.id, path: context.path, baseHash: context.baseHash,
      content: context.content + '\n\n' + message.content + '\n', messageId: message.id, senderName: message.senderName });
  }
}
export { RaftPagePlugin };

class EditPreview extends Modal {
  constructor(private plugin: RaftPagePlugin, private proposal: Proposal) { super(plugin.app); }
  async onOpen() {
    this.titleEl.setText('Review document change');
    const { contentEl } = this;
    contentEl.addClass('raft-edit-preview');
    contentEl.createEl('p', { text: `${this.proposal.senderName} → ${this.proposal.path}` });
    const file = this.app.vault.getAbstractFileByPath(this.proposal.path);
    const view = this.app.workspace.getLeavesOfType('markdown').map(l => l.view)
      .find((v): v is MarkdownView => v instanceof MarkdownView && v.file === file);
    const current = view ? view.editor.getValue() : file instanceof TFile ? await this.app.vault.read(file) : '(Note unavailable)';
    const snapshot = this.proposal.documentId ? this.plugin.snapshots[this.proposal.documentId] : undefined;
    let proposed: string;
    try { proposed = this.proposal.create ? this.proposal.content ?? '' : this.proposal.ops && typeof current === 'string' && file
      ? applyProposalText(current, this.proposal, snapshot && { ...snapshot, content: '' }) : this.proposal.content ?? ''; }
    catch (cause) { proposed = `This change cannot be applied: ${cause instanceof Error ? cause.message : ''}`; }
    const grid = contentEl.createDiv({ cls: 'raft-edit-columns' });
    grid.createDiv().createEl('h4', { text: this.proposal.create ? 'New note' : 'Current note' }).parentElement!.createEl('pre', { text: this.proposal.create ? '' : current });
    grid.createDiv().createEl('h4', { text: snapshot?.selection ? 'Replacement for selected text' : 'Proposed note' }).parentElement!.createEl('pre', { text: proposed });
    const error = contentEl.createDiv({ cls: 'raft-error' });
    new Setting(contentEl).addButton(b => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton(b => b.setButtonText('Apply to note').setCta().onClick(async () => {
        b.setDisabled(true);
        try { await this.plugin.applyProposal(this.proposal); this.close(); }
        catch (e) { error.setText(e instanceof Error ? e.message : 'Could not apply this edit.'); b.setDisabled(false); }
      }));
  }
  onClose() { this.contentEl.empty(); }
}
class ChannelPicker extends FuzzySuggestModal<{ id: string; name: string }> {
  constructor(private plugin: RaftPagePlugin, private target: TAbstractFile, private channels: { id: string; name: string }[],
    private onDone?: () => void) {
    super(plugin.app);
    this.setPlaceholder(`Bind ${target.path} to a channel…`);
  }
  getItems() { return this.channels; }
  getItemText(channel: { id: string; name: string }) { return `#${channel.name}`; }
  onChooseItem(channel: { id: string; name: string }) {
    void this.plugin.bindPath(this.target, channel).then(() => new Notice(`Bound ${this.target.path} to #${channel.name}`),
      cause => new Notice(`Raft: ${cause instanceof Error ? cause.message : 'binding failed.'}`))
      .finally(() => this.onDone?.());
  }
}
/** Name, visibility and agents for a new channel bound to a note or folder. */
class NewChannelModal extends Modal {
  constructor(private plugin: RaftPagePlugin, private target: TAbstractFile, private agents: { id: string; name: string; displayName?: string }[],
    private onDone?: () => void) { super(plugin.app); }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: `New Raft channel for ${this.target.path}` });
    const base = this.target instanceof TFile ? this.target.basename : this.target.name;
    let name = channelName(base), isPrivate = false;
    const picked = new Set<string>();
    const preferred = this.agents.find(a => a.name === this.plugin.settings.defaultSteward);
    if (preferred) picked.add(preferred.id);
    new Setting(contentEl).setName('Channel name').addText(t => t.setValue(name).onChange(v => { name = v; }));
    new Setting(contentEl).setName('Private').setDesc('Only you and the agents below can see it.').addToggle(t => t.setValue(false).onChange(v => { isPrivate = v; }));
    let docType = '';
    const types = this.target instanceof TFile ? this.plugin.docTypes() : [];
    if (types.length) new Setting(contentEl).setName('Document type')
      .setDesc(`Sets the note's type and properties. An empty note starts from ${TEMPLATE_FOLDER}/<type>.md.`)
      .addDropdown(d => { d.addOption('', 'None'); for (const t of types) d.addOption(t, t); d.onChange(v => { docType = v; }); });
    contentEl.createEl('h4', { text: 'Agents' });
    contentEl.createEl('p', { cls: 'setting-item-description', text: 'The first agent you tick keeps the note up to date (steward); you can change it later.' });
    const order: string[] = preferred ? [preferred.id] : [];
    if (!this.agents.length) contentEl.createEl('p', { text: 'No agents could be loaded. You can add them in Raft later.' });
    for (const agent of this.agents) new Setting(contentEl)
      .setName(`@${agent.name}${agent.displayName && agent.displayName !== agent.name ? ` (${agent.displayName})` : ''}`)
      .addToggle(t => t.setValue(picked.has(agent.id)).onChange(v => {
        if (v) { picked.add(agent.id); order.push(agent.id); } else { picked.delete(agent.id); order.splice(order.indexOf(agent.id), 1); }
      }));
    const error = contentEl.createDiv({ cls: 'raft-error' });
    new Setting(contentEl).addButton(b => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton(b => b.setButtonText('Create and bind').setCta().onClick(async () => {
        if (!name.trim()) { error.setText('Enter a channel name.'); return; }
        b.setDisabled(true);
        const agents = order.map(id => this.agents.find(a => a.id === id)!).filter(Boolean);
        try {
          const channel = await this.plugin.createChannelFor(this.target, name, agents, isPrivate, docType || undefined);
          new Notice(`Created #${channel.name} and bound ${this.target.path} to it.`);
          this.close(); this.onDone?.();
        } catch (e) { error.setText(e instanceof Error ? e.message : 'The channel could not be created.'); b.setDisabled(false); }
      }));
  }
  onClose() { this.contentEl.empty(); }
}
type StewardChoice = { id: string; name: string; displayName?: string } | null;
class StewardPicker extends FuzzySuggestModal<StewardChoice> {
  constructor(private plugin: RaftPagePlugin, private path: string, private agents: { id: string; name: string; displayName?: string }[],
    private onDone?: () => void) {
    super(plugin.app);
    this.setPlaceholder(`Choose the agent that keeps ${path} up to date…`);
  }
  getItems(): StewardChoice[] { return [null, ...this.agents]; }
  getItemText(agent: StewardChoice) { return agent ? `@${agent.name}${agent.displayName && agent.displayName !== agent.name ? ` (${agent.displayName})` : ''}` : 'No steward — no automatic updates'; }
  onChooseItem(agent: StewardChoice) {
    void this.plugin.setSteward(this.path, agent)
      .catch(cause => new Notice(`Raft: ${cause instanceof Error ? cause.message : 'could not set the steward.'}`))
      .finally(() => this.onDone?.());
  }
}
class RaftSettingsTab extends PluginSettingTab {
  constructor(app: RaftPagePlugin['app'], private plugin: RaftPagePlugin) { super(app, plugin); }
  display() {
    const el = this.containerEl; el.empty();
    el.createEl('h2', { text: 'Raft Page' });
    el.createEl('p', { text: 'Open the Raft sidebar to sign in and choose a channel. Only attached notes or selected text are sent with your messages.' });
    this.renderAccount(el);
    el.createEl('p', { text: this.app.secretStorage ? 'Login tokens use Obsidian SecretStorage. Passwords are never saved.' : 'This Obsidian version has no SecretStorage. Login lasts until the plugin closes; passwords and tokens are not written to plugin settings.' });
    new Setting(el).setName('Apply agent edits automatically')
      .setDesc('Write an agent\'s change into the note as soon as it arrives. A change is still refused if the note was edited after it was sent. Turn off to review each change first.')
      .addToggle(t => t.setValue(this.plugin.settings.autoApply).onChange(value => { this.plugin.settings.autoApply = value; void this.plugin.saveSettings(); }));
    new Setting(el).setName('Default steward')
      .setDesc('Agent name (without @) that new bindings use to keep notes up to date from the conversation, when it is in the channel. Leave empty to choose each time.')
      .addText(t => t.setPlaceholder('scribe').setValue(this.plugin.settings.defaultSteward).onChange(value => {
        this.plugin.settings.defaultSteward = value.trim().replace(/^@/, ''); void this.plugin.saveSettings();
      }));
    new Setting(el).setName('Mobile keyboard height')
      .setDesc('Pixels to lift the message box on phones. iOS Obsidian neither resizes the window nor the visual viewport when the software keyboard opens, so the height cannot be detected. Enter roughly how far the box needs to move so it clears the keyboard (about 330 on a modern iPhone), and adjust until it sits just above it. 0 keeps the detected behaviour.')
      .addText(t => t.setPlaceholder('0').setValue(String(this.plugin.settings.mobileKeyboardHeight || '')).onChange(value => {
        const parsed = Number.parseInt(value, 10);
        this.plugin.settings.mobileKeyboardHeight = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
        void this.plugin.saveSettings();
      }));
    new Setting(el).setName('Open Raft conversations').addButton(b => b.setButtonText('Open sidebar').onClick(() => void this.plugin.openView()));
    this.renderBindings(el);
  }

  /** Shows where the plugin is signed in, and lets the user switch server or sign out without opening the sidebar. */
  private renderAccount(el: HTMLElement) {
    el.createEl('h3', { text: 'Account' });
    const session = this.plugin.session;
    new Setting(el).setName('Server URL').setDesc(session?.apiUrl ?? this.plugin.settings.apiUrl);
    if (!session) {
      new Setting(el).setName('Not signed in').setDesc('Sign in from the Raft sidebar.')
        .addButton(b => b.setButtonText('Open sidebar').onClick(() => void this.plugin.openView()));
      return;
    }
    const label = (server: ServerInfo) => [server.name, server.slug ? `/${server.slug}` : null].filter(Boolean).join(' · ') || server.id;
    const current: ServerInfo = { id: session.serverId, slug: session.serverSlug, name: session.serverName };
    const server = new Setting(el).setName('Server').setDesc(label(current));
    server.settingEl.addClass('raft-account-server');
    server.addDropdown(dropdown => {
      dropdown.addOption(session.serverId, label(current)).setValue(session.serverId).setDisabled(true);
      void this.plugin.client.servers().then(servers => {
        if (this.plugin.session !== session) return;
        const known = servers.find(s => s.id === session.serverId);
        // Fill in a name or slug saved before the plugin kept them.
        if (known) server.setDesc(label(known));
        dropdown.selectEl.empty();
        for (const s of known ? servers : [current, ...servers]) dropdown.addOption(s.id, label(s));
        dropdown.setValue(session.serverId).setDisabled(servers.length < 2);
        dropdown.onChange(id => {
          const chosen = servers.find(s => s.id === id);
          if (!chosen) return;
          void this.plugin.switchServer(chosen).then(() => {
            new Notice(`Raft: switched to ${label(chosen)}.`);
            this.display();
          }, cause => { new Notice(`Raft: ${cause instanceof Error ? cause.message : 'could not switch server.'}`); this.display(); });
        });
      }, () => { if (this.plugin.session === session) server.setDesc(`${label(current)} · server list unavailable`); });
    });
    new Setting(el).setName('Signed in as').setDesc(session.userName || session.userId)
      .addButton(b => b.setButtonText('Sign out').setWarning().onClick(() => {
        b.setDisabled(true);
        void this.plugin.signOut().then(() => {
          this.plugin.reloadViews();
          new Notice('Raft: signed out.');
          this.display();
        });
      }));
    el.createEl('p', { cls: 'setting-item-description', text: 'To use a different server URL or account, sign out and sign in again from the sidebar.' });
  }

  /** Lists every channel binding with its steward, so both can be reviewed and changed without hunting the vault. */
  private renderBindings(el: HTMLElement) {
    const bindings = Object.entries(this.plugin.bindings).sort(([a], [b]) => a.localeCompare(b));
    el.createEl('h3', { text: 'Channel bindings' });
    if (!bindings.length) {
      el.createEl('p', { text: 'No notes or folders are bound yet. Right-click a note or folder and choose “Bind to Raft channel…”.' });
      return;
    }
    const serverId = this.plugin.session?.serverId;
    el.createEl('p', { text: `${bindings.length} bound ${bindings.length === 1 ? 'path' : 'paths'}. A note without its own binding follows the nearest folder above it.` });
    for (const [path, binding] of bindings) {
      const elsewhere = serverId && binding.serverId !== serverId;
      const setting = new Setting(el)
        .setName(binding.kind === 'folder' ? `${path}/` : path)
        .setDesc([`#${binding.channelName || binding.channelId}`,
          binding.stewardName ? `steward @${binding.stewardName}` : 'no steward',
          binding.paused ? 'paused' : null,
          elsewhere ? 'another server' : null].filter(Boolean).join(' · '));
      setting.settingEl.addClass('raft-binding-row');
      if (binding.kind === 'folder') setting.nameEl.prepend(this.iconEl('folder'));
      else setting.nameEl.prepend(this.iconEl('file-text'));

      // A binding made against another server cannot be queried through this session's client, so only offer the
      // actions that stay local.
      const local = !elsewhere;
      // Change steward: offer the channel's agents, plus "no steward".
      if (local) setting.addExtraButton(button => button.setIcon('bot').setTooltip(binding.stewardName ? 'Change steward' : 'Choose steward')
        .onClick(() => {
          if (!this.plugin.session) { new Notice('Raft: sign in from the Raft sidebar first.'); return; }
          void this.plugin.client.agents(binding.channelId).then(agents => {
            new StewardPicker(this.plugin, path, agents, () => this.display()).open();
          }, () => new Notice('Raft: the channel members could not be loaded.'));
        }));
      if (local && binding.stewardName) {
        setting.addExtraButton(button => button.setIcon('user-x').setTooltip('Remove steward')
          .onClick(() => void this.plugin.setSteward(path, null).then(() => this.display())));
      }
      if (local) setting.addExtraButton(button => button.setIcon(binding.paused ? 'play' : 'pause')
        .setTooltip(binding.paused ? 'Resume automatic updates' : 'Pause automatic updates')
        .onClick(() => void this.plugin.setPaused(path, !binding.paused).then(() => this.display())));
      if (local) setting.addExtraButton(button => button.setIcon('link-2').setTooltip('Rebind to another channel')
        .onClick(() => {
          const target = this.app.vault.getAbstractFileByPath(path);
          if (!target) { new Notice(`Raft: ${path} is no longer in this vault.`); return; }
          this.plugin.chooseChannel(target, () => this.display());
        }));
      setting.addExtraButton(button => button.setIcon('unlink').setTooltip('Unbind')
        .onClick(() => void this.plugin.unbindPath(path).then(() => { new Notice(`Raft: ${path} is no longer bound.`); this.display(); })));
      setting.addExtraButton(button => button.setIcon('crosshair').setTooltip('Show in file explorer')
        .onClick(() => this.plugin.revealInTree(path)));
    }
  }

  private iconEl(name: string): HTMLElement {
    const span = document.createElement('span');
    span.addClass('raft-binding-icon');
    setIcon(span, name);
    return span;
  }
}
