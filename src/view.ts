import { ItemView, MarkdownRenderer, Menu, Modal, Platform, requestUrl, setIcon, type App, type WorkspaceLeaf } from 'obsidian';
import type RaftPagePlugin from '../main';
import { RaftClientError, type Member, type Message, type ThreadSummary } from './client';
import { splitEditBlocks, splitNoteContext, type Proposal } from './documents';
import { isSyncMessage } from './sync';
import { isCustomAvatar, pixelAvatarUrl } from './avatar';

export const VIEW_TYPE = 'raft-page';
const PAGE_SIZE = 50;
const POLL_MS = 3000;
/** Raft's limits (free plan): 50 MB per file, 10 attachments per message, the attached note included. */
const MAX_FILE_BYTES = 50 * 1048576;
const MAX_ATTACHMENTS = 10;

type ChannelMember = Member;
type Thread = { root: Message; channelId: string | null; parentChannelId: string };
type HistoryPage = { messages: Message[]; hasMore?: boolean; historyLimited?: boolean; threadSummariesByParentMessageId?: Record<string, ThreadSummary> };

/** Native channel conversation pane. All document writes require a user action. */
export class RaftView extends ItemView {
  private epoch = 0;
  private closed = true;
  private timer: number | undefined;
  private request: { epoch: number; promise: Promise<void> } | null = null;
  private sending = false;
  private authenticating = false;
  private catalogLoading = false;
  private catalogRefreshing = false;
  private catalogAt = 0;
  private olderLoading = false;
  private hasMore = false;
  private historyLimited = false;
  private historyError = false;
  private thread: Thread | null = null;
  private messages = new Map<string, Message>();
  private nodes = new Map<string, { signature: string; element: HTMLElement }>();
  private drafts = new Map<string, string>();
  private channels: { id: string; name: string }[] = [];
  private members: ChannelMember[] = [];
  private images = new Map<string, Promise<string | null>>();
  private mentionMatches: ChannelMember[] = [];
  private mentionIndex = 0;
  private mentionMenu!: HTMLElement;
  private root!: HTMLElement;
  private history!: HTMLElement;
  private historyState!: HTMLElement;
  private messageList!: HTMLElement;
  private status!: HTMLElement;
  private alert!: HTMLElement;
  private channelSelect!: HTMLSelectElement;
  private headerTile!: HTMLButtonElement;
  private threadTitle!: HTMLElement;
  private composer!: HTMLTextAreaElement;
  private keyboardDebug = false;
  private keyboardDebugEl?: HTMLElement;
  private sendButton!: HTMLButtonElement;
  private refreshButton!: HTMLButtonElement;
  private olderButton!: HTMLButtonElement;
  private contextName!: HTMLElement;
  private contextDescription!: HTMLElement;
  private contextChip!: HTMLElement;
  private contextScope!: HTMLElement;
  private attachButton!: HTMLButtonElement;
  private fileButton!: HTMLButtonElement;
  private fileInput!: HTMLInputElement;
  private fileTray!: HTMLElement;
  private pendingFiles: { file: File; url?: string }[] = [];
  private selectionButton!: HTMLButtonElement;
  private mentionButton!: HTMLButtonElement;
  private signOutButton!: HTMLButtonElement;
  private bindButton!: HTMLButtonElement;
  private bindingSource!: HTMLElement;
  private bindingBar!: HTMLElement;
  private stewardBadge!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: RaftPagePlugin) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return 'Raft'; }
  getIcon(): string { return 'messages-square'; }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.schedulePoll()));
    this.registerDomEvent(this.containerEl.ownerDocument, 'visibilitychange', () => this.schedulePoll());
    this.watchKeyboard();
    await this.refresh();
  }

  /**
   * On phones the software keyboard covers the bottom of the view without resizing it, hiding the composer.
   *
   * Obsidian's mobile shell is Capacitor, whose Keyboard plugin emits `keyboardWillShow` / `keyboardDidShow` on
   * `window` with a `keyboardHeight` in the event detail. That is the only reliable signal here: on iOS neither
   * `innerHeight` nor `visualViewport` changes when the keyboard opens, so measuring the viewport finds nothing.
   * Fall back to a configured height, then to the viewport, for hosts that only offer those.
   */
  private watchKeyboard(): void {
    if (!Platform.isMobile) return;
    const win = this.containerEl.ownerDocument.defaultView;
    if (!win) return;
    const viewport = win.visualViewport;
    // Height reported by the Capacitor Keyboard plugin while the keyboard is up; 0 when unknown or hidden.
    let nativeHeight = 0;
    let keyboardVisible = false;

    const update = () => {
      const doc = this.containerEl.ownerDocument;
      const layoutBottom = win.innerHeight ?? doc.documentElement.clientHeight;
      const contentBottom = Math.round(this.contentEl.getBoundingClientRect().bottom);
      const manual = this.plugin.settings.mobileKeyboardHeight ?? 0;
      // Space the host already leaves below the composer (its own toolbar), which the keyboard overlaps too.
      const inset = Math.max(0, layoutBottom - contentBottom);
      let covered = 0;
      let source = 'viewport';
      if (nativeHeight > 0) {
        covered = Math.max(0, Math.round(nativeHeight - inset));
        source = 'native';
      } else if (keyboardVisible) {
        // The event fired without a usable height: prefer the configured value, else assume a typical keyboard.
        covered = manual > 0 ? manual : Math.max(0, Math.round(layoutBottom * 0.45) - inset);
        source = manual > 0 ? 'manual' : 'estimate';
      } else if (manual > 0 && doc.activeElement === this.composer) {
        covered = manual;
        source = 'manual';
      } else {
        const visibleBottom = viewport ? Math.min(layoutBottom, viewport.offsetTop + viewport.height) : layoutBottom;
        covered = Math.max(0, contentBottom - visibleBottom);
      }
      if (this.keyboardDebug) {
        this.renderKeyboardDebug({
          covered, layoutBottom, contentBottom, manual,
          nativeHeight, keyboardVisible: keyboardVisible ? 1 : 0,
          visibleHeight: viewport ? Math.round(viewport.height) : undefined,
        }, this.containerEl.ownerDocument.body.className, source);
      }
      const value = `${covered}px`;
      if (this.contentEl.style.getPropertyValue('--raft-keyboard') === value) return;
      this.contentEl.style.setProperty('--raft-keyboard', value);
      if (covered && this.composer && doc.activeElement === this.composer && this.history) {
        this.history.scrollTop = this.history.scrollHeight;
      }
    };

    const readHeight = (event: Event) => {
      const detail = (event as CustomEvent).detail as { keyboardHeight?: number } | undefined;
      let height = detail?.keyboardHeight ?? 0;
      // Capacitor reports points; guard against a device-pixel value just in case.
      if (height > 0 && height > win.innerHeight) height = height / (win.devicePixelRatio || 1);
      nativeHeight = height;
      keyboardVisible = true;
      update();
      for (const delay of [50, 150, 300, 600]) win.setTimeout(update, delay);
    };
    const onHide = () => { nativeHeight = 0; keyboardVisible = false; update(); };
    const remeasure = () => { for (const delay of [50, 150, 300, 600, 1000]) win.setTimeout(update, delay); };

    for (const name of ['keyboardWillShow', 'keyboardDidShow']) win.addEventListener(name, readHeight);
    for (const name of ['keyboardWillHide', 'keyboardDidHide']) win.addEventListener(name, onHide);
    this.register(() => {
      for (const name of ['keyboardWillShow', 'keyboardDidShow']) win.removeEventListener(name, readHeight);
      for (const name of ['keyboardWillHide', 'keyboardDidHide']) win.removeEventListener(name, onHide);
    });
    if (viewport) {
      viewport.addEventListener('resize', update);
      viewport.addEventListener('scroll', update);
      this.register(() => { viewport.removeEventListener('resize', update); viewport.removeEventListener('scroll', update); });
    }
    win.addEventListener('resize', update);
    win.addEventListener('orientationchange', update);
    this.register(() => { win.removeEventListener('resize', update); win.removeEventListener('orientationchange', update); });
    this.registerDomEvent(this.contentEl, 'focusin', remeasure);
    this.registerDomEvent(this.contentEl, 'focusout', remeasure);
  }

  /** Toggles the on-screen keyboard metrics overlay used to diagnose mobile layout issues. */
  public setKeyboardDebug(on: boolean): void {
    this.keyboardDebug = on;
    this.keyboardDebugEl?.remove();
    this.keyboardDebugEl = undefined;
    if (on) this.renderKeyboardDebug({});
  }

  private renderKeyboardDebug(metrics: Record<string, number | undefined>, bodyClass?: string, source?: string): void {
    if (!this.keyboardDebug) return;
    if (!this.keyboardDebugEl) {
      this.keyboardDebugEl = this.contentEl.createDiv({ cls: 'raft-keyboard-debug' });
      this.keyboardDebugEl.setAttribute('style', 'position:fixed;left:8px;top:8px;z-index:9999;padding:4px 6px;border-radius:6px;background:#000c;color:#fff;font:11px/14px monospace;white-space:pre-wrap;max-width:92vw;pointer-events:none');
    }
    const lines = Object.entries(metrics).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v ?? '-'}`);
    if (source) lines.push(`source: ${source}`);
    // The body class tells us whether the host marks the keyboard itself, which would beat the manual setting.
    if (bodyClass !== undefined) lines.push(`body: ${bodyClass || '(none)'}`);
    this.keyboardDebugEl.setText(lines.join('\n'));
  }

  async onClose(): Promise<void> {
    this.rememberDraft();
    this.closed = true;
    this.invalidate();
    this.contentEl.empty();
    for (const pending of this.images.values()) void pending.then(url => { if (url) URL.revokeObjectURL(url); });
    for (const item of this.pendingFiles) if (item.url) URL.revokeObjectURL(item.url);
    this.pendingFiles = [];
    this.images.clear();
  }

  /** Called by the plugin after a file-open event or a document operation. */
  public updateContext(): void {
    if (!this.contextName || this.closed || !this.plugin.session) return;
    const name = this.plugin.getAttachedName();
    const { attachDocument, useSelection } = this.plugin.settings;
    const attached = attachDocument && !!name;
    this.contextChip.hidden = !attached;
    this.contextName.setText(name ? name.split('/').pop() || name : '');
    this.contextChip.title = name || '';
    this.contextScope.setText(useSelection ? 'Selection' : '');
    this.contextScope.hidden = !useSelection;
    this.attachButton.toggleClass('is-active', attachDocument);
    this.attachButton.setAttribute('aria-pressed', String(attachDocument));
    this.attachButton.title = attachDocument ? (name ? `Attaching ${name}` : 'Open a note to attach it') : 'Attach current note';
    this.selectionButton.toggleClass('is-active', useSelection);
    this.selectionButton.setAttribute('aria-pressed', String(useSelection));
    this.selectionButton.hidden = !attachDocument;
    this.contextDescription.setText(attached
      ? `Next message carries ${useSelection ? 'the selected text from' : 'the current contents of'} ${name}.`
      : 'Next message carries no note.');
    this.updateBinding();
  }

  /** Shows which channel the open note is bound to, and offers a way back after a manual channel switch. */
  /** The binding shown in the header: the current channel's binding first, otherwise the open note's. */
  private headerBinding() {
    const channelId = this.thread?.parentChannelId || this.plugin.settings.channelId;
    return this.plugin.channelBinding(channelId) ?? this.plugin.bindingFor();
  }

  private updateBinding(): void {
    const noteBinding = this.plugin.bindingFor();
    const binding = this.headerBinding();
    const note = this.plugin.getAttachedName();
    this.bindButton.toggleClass('is-bound', !!binding);
    this.bindButton.disabled = !note && !binding;
    const label = binding ? `Bound to ${binding.path} (#${binding.channelName})`
      : note ? 'Bind this note to a channel' : 'Open a note to bind it to a channel';
    this.bindButton.setAttribute('aria-label', label);
    this.bindButton.title = label;
    this.bindingSource.hidden = !note && !binding;
    const steward = binding?.stewardId ? ` · steward @${binding.stewardName}${binding.paused ? ' (paused)' : ''}` : '';
    const source = !binding ? 'Not bound' : binding.kind === 'folder'
      ? `📁 ${binding.path}${noteBinding?.path === binding.path && noteBinding.inherited ? ' · from folder' : ''}`
      : `📄 ${binding.path.split('/').pop()}`;
    this.bindingSource.setText(source + steward);
    this.bindingSource.title = binding ? `${binding.path} → #${binding.channelName}` : '';
    this.renderSteward(binding?.stewardId ? binding : null);
    const away = !!noteBinding && noteBinding.channelId !== this.plugin.settings.channelId && this.channels.some(c => c.id === noteBinding.channelId);
    this.bindingBar.hidden = !away;
    if (away) {
      this.bindingBar.empty();
      this.bindingBar.createSpan({ text: `This note is bound to #${noteBinding.channelName}` });
      this.button(this.bindingBar, 'Return', () => { void this.changeChannel(noteBinding.channelId); });
    }
  }

  /** The steward's avatar with Raft's presence colours: online, busy (thinking/working), error, offline. */
  private renderSteward(binding: { stewardId?: string; stewardName?: string; paused?: boolean } | null): void {
    this.stewardBadge.empty();
    this.stewardBadge.hidden = !binding;
    if (!binding?.stewardId) return;
    const member = this.members.find(m => m.id === binding.stewardId);
    const activity = this.plugin.agentActivity.get(binding.stewardId) ?? member?.activity ?? 'offline';
    const presence = activity === 'online' ? 'online' : activity === 'thinking' || activity === 'working' ? 'busy' : activity === 'error' ? 'error' : 'offline';
    this.renderAvatar(this.stewardBadge, 'agent', member?.avatarUrl, undefined, 'raft-avatar-sm');
    this.stewardBadge.createSpan({ cls: `raft-presence is-${presence}` });
    const label = `Steward @${binding.stewardName} · ${binding.paused ? 'paused' : presence}`;
    this.stewardBadge.title = label;
    this.stewardBadge.setAttribute('aria-label', label);
  }

  /** Called when a note opens: a bound note brings its channel along. Unbound notes leave the conversation alone. */
  public followNote(): void {
    if (this.closed || !this.plugin.session || !this.channelSelect) return;
    const binding = this.plugin.bindingFor();
    if (!binding || binding.channelId === this.plugin.settings.channelId || this.sending) return;
    if (!this.channels.some(c => c.id === binding.channelId)) return;
    void this.changeChannel(binding.channelId);
  }

  private openBindMenu(event: MouseEvent): void {
    const file = this.app.workspace.getActiveFile();
    const note = this.plugin.getAttachedName();
    const target = note ? this.app.vault.getAbstractFileByPath(note) : file;
    const binding = this.headerBinding();
    if (!target && !binding) return;
    const channel = this.channels.find(c => c.id === this.plugin.settings.channelId);
    const menu = new Menu();
    if (binding) {
      menu.addItem(item => item.setTitle(`Rebind ${binding.path} to another channel…`).setIcon('link')
        .onClick(() => { const bound = this.app.vault.getAbstractFileByPath(binding.path); if (bound) this.plugin.chooseChannel(bound); }));
      menu.addItem(item => item.setTitle(binding.stewardId ? `Change steward (@${binding.stewardName})…` : 'Choose a steward…').setIcon('user-cog')
        .onClick(() => { void this.plugin.chooseSteward(binding.path).catch(cause => this.showError(cause, 'Could not load agents.')); }));
      if (binding.stewardId) {
        menu.addItem(item => item.setTitle('⚡ Sync now').setIcon('zap').onClick(() => this.plugin.syncNow(binding.path)));
        menu.addItem(item => item.setTitle(binding.paused ? 'Resume automatic updates' : 'Pause automatic updates').setIcon(binding.paused ? 'play' : 'pause')
          .onClick(() => { void this.plugin.setPaused(binding.path, !binding.paused); }));
      }
      menu.addItem(item => item.setTitle(`Unbind ${binding.path}`).setIcon('unlink').onClick(() => { void this.plugin.unbindPath(binding.path); }));
      menu.addItem(item => item.setTitle('Reveal in file explorer').setIcon('folder-search').onClick(() => this.plugin.revealInTree(binding.path)));
    } else if (channel && target) {
      const bindTo = (path: string, label: string) => {
        const found = this.app.vault.getAbstractFileByPath(path);
        if (found) menu.addItem(item => item.setTitle(label).setIcon('link').onClick(() => {
          void this.plugin.bindPath(found, channel).catch(cause => this.showError(cause, 'Could not bind.'));
        }));
      };
      bindTo(target.path, `Bind this note → #${channel.name}`);
      const folders = target.path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/')).reverse();
      if (folders[0]) bindTo(folders[0], `Bind folder ${folders[0]} → #${channel.name}`);
      for (const folder of folders.slice(1)) bindTo(folder, `Bind parent folder ${folder} → #${channel.name}`);
      menu.addItem(item => item.setTitle('Bind to another channel…').setIcon('list').onClick(() => this.plugin.chooseChannel(target)));
    }
    menu.showAtMouseEvent(event);
  }

  /** Starts over after a sign out or server switch made elsewhere, such as in settings. */
  public async reload(): Promise<void> {
    if (this.closed) return;
    // Drafts are already kept on every keystroke; the channel setting has moved on by now.
    this.invalidate();
    if (this.plugin.session) this.renderConversation();
    await this.refresh();
  }

  /** Refreshes login state, available channels, and channel-wide history. */
  public async refresh(): Promise<void> {
    if (this.closed) return;
    if (!this.plugin.session) {
      this.invalidate();
      this.renderLogin();
      return;
    }
    if (!this.root?.parentElement || !this.root.hasClass('raft-conversation')) this.renderConversation();
    const token = this.epoch;
    if (!this.channels.length && !this.catalogLoading) await this.loadCatalog(token);
    if (!this.isCurrent(token)) return;
    this.updateContext();
    await this.loadHistory();
    this.schedulePoll();
  }

  private invalidate(): number {
    this.epoch += 1;
    this.stopPoll();
    this.request = null;
    this.olderLoading = false;
    this.catalogLoading = false;
    return this.epoch;
  }

  private isCurrent(token: number): boolean {
    return !this.closed && this.epoch === token && !!this.plugin.session;
  }

  private stopPoll(): void {
    if (this.timer !== undefined) this.containerEl.ownerDocument.defaultView?.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private isActive(): boolean {
    return !this.closed && !this.containerEl.ownerDocument.hidden && this.containerEl.isShown();
  }

  private schedulePoll(): void {
    this.stopPoll();
    if (!this.isActive() || !this.plugin.session) return;
    this.timer = this.containerEl.ownerDocument.defaultView?.setTimeout(() => {
      this.timer = undefined;
      if (!this.isActive() || !this.plugin.session) return;
      if (Date.now() - this.catalogAt > 120_000) void this.refreshCatalog();
      void this.loadHistory().finally(() => this.schedulePoll());
    }, POLL_MS);
  }

  private renderLogin(): void {
    this.contentEl.empty();
    this.channels = [];
    this.members = [];
    this.messages.clear();
    this.nodes.clear();
    this.thread = null;
    this.root = this.contentEl.createDiv({ cls: 'raft-view raft-login' });
    const intro = this.root.createDiv({ cls: 'raft-login-intro' });
    intro.createEl('h2', { text: 'Raft' });
    intro.createEl('p', { text: 'Sign in to talk with your team and agents beside your notes.' });
    const form = this.root.createEl('form', { cls: 'raft-login-form' });
    const field = (title: string, type: string, value: string, autocomplete: string): HTMLInputElement => {
      const label = form.createEl('label', { cls: 'raft-field' });
      label.createSpan({ text: title });
      const input = label.createEl('input', { type, value });
      input.required = true;
      input.setAttribute('autocomplete', autocomplete);
      input.disabled = this.authenticating;
      return input;
    };
    const base = field('Server URL', 'url', this.plugin.settings.apiUrl, 'url');
    base.placeholder = 'https://your-raft-server';
    const settings = this.plugin.settings;
    const server = field('Server', 'text', settings.serverSlug ? `/${settings.serverSlug}` : settings.serverId, 'off');
    server.required = false;
    server.placeholder = '/myserver';
    const email = field('Email', 'email', '', 'username');
    const password = field('Password', 'password', '', 'current-password');
    const error = form.createDiv({ cls: 'raft-error', attr: { role: 'alert' } });
    const submit = form.createEl('button', { text: this.authenticating ? 'Signing in…' : 'Sign in', cls: 'mod-cta', type: 'submit' });
    submit.disabled = this.authenticating;
    form.createEl('p', { cls: 'raft-caption', text: 'Session stored using Obsidian secret storage when available; otherwise this session only.' });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (this.authenticating || !form.reportValidity()) return;
      const token = this.epoch;
      const credentials = password.value;
      password.value = '';
      this.authenticating = true;
      const inputs = [base, server, email, password];
      inputs.forEach(input => { input.disabled = true; });
      submit.disabled = true;
      submit.setText('Signing in…');
      error.empty();
      void (async () => {
        try {
          const session = await this.plugin.client.signIn(base.value.trim(), email.value.trim(), credentials, server.value);
          if (this.closed || token !== this.epoch) return;
          this.plugin.settings.apiUrl = base.value.trim();
          this.plugin.settings.serverId = session.serverId;
          this.plugin.settings.serverSlug = session.serverSlug ?? '';
          this.plugin.session = session;
          await this.plugin.saveSettings();
          if (this.closed || token !== this.epoch) return;
          this.invalidate();
          this.renderConversation();
          await this.refresh();
        } catch (cause) {
          if (!this.closed && token === this.epoch) error.setText(this.errorText(cause, 'Could not sign in. Check your server and credentials.'));
        } finally {
          this.authenticating = false;
          inputs.forEach(input => { input.disabled = false; });
          submit.disabled = false;
          submit.setText('Sign in');
        }
      })();
    });
  }

  private renderConversation(): void {
    this.contentEl.empty();
    this.messages.clear();
    this.nodes.clear();
    this.channels = [];
    this.members = [];
    this.thread = null;
    this.hasMore = false;
    this.historyLimited = false;
    this.root = this.contentEl.createDiv({ cls: 'raft-view raft-conversation' });
    const header = this.root.createEl('header', { cls: 'raft-header' });
    // In a thread the tile itself is the way back to the channel.
    this.headerTile = header.createEl('button', { cls: 'raft-channel-tile', attr: { type: 'button', tabindex: '-1', 'aria-hidden': 'true' } });
    this.headerTile.disabled = true;
    this.headerTile.addEventListener('click', () => this.closeThread());
    setIcon(this.headerTile, 'hash');
    const titleBox = header.createDiv({ cls: 'raft-header-title' });
    this.channelSelect = titleBox.createEl('select', { cls: 'raft-channel-select' });
    this.channelSelect.setAttribute('aria-label', 'Channel');
    this.channelSelect.addEventListener('change', () => { void this.changeChannel(this.channelSelect.value); });
    for (const event of ['focus', 'pointerdown']) this.channelSelect.addEventListener(event, () => { void this.refreshCatalog(); });
    this.threadTitle = titleBox.createDiv({ cls: 'raft-thread-heading' });
    this.threadTitle.hidden = true;
    this.bindingSource = titleBox.createDiv({ cls: 'raft-binding-source' });
    this.status = titleBox.createDiv({ cls: 'raft-status', attr: { role: 'status', 'aria-live': 'polite' } });
    this.stewardBadge = header.createSpan({ cls: 'raft-steward' });
    this.stewardBadge.hidden = true;
    const actions = header.createDiv({ cls: 'raft-header-actions' });
    this.bindButton = this.button(actions, '', () => {});
    this.bindButton.addClass('raft-icon-button', 'raft-bind-button');
    setIcon(this.bindButton, 'link');
    this.bindButton.addEventListener('click', event => this.openBindMenu(event));
    this.refreshButton = this.iconButton(actions, 'Refresh', 'refresh-cw', () => {
      void this.plugin.loadBindings().then(async () => { await this.refreshCatalog(true); this.updateContext(); this.followNote(); return this.refresh(); });
    });
    this.signOutButton = this.iconButton(actions, 'Sign out', 'log-out', () => { void this.signOut(); });
    this.alert = this.root.createDiv({ cls: 'raft-error raft-conversation-error', attr: { role: 'alert' } });
    this.bindingBar = this.root.createDiv({ cls: 'raft-binding-bar' });
    this.bindingBar.hidden = true;
    this.history = this.root.createDiv({ cls: 'raft-history scrollbar-quiet', attr: { 'aria-label': 'Conversation history', tabindex: '0' } });
    this.olderButton = this.button(this.history, 'Load older messages', () => { void this.loadOlder(); });
    this.olderButton.addClass('raft-load-older');
    this.olderButton.hidden = true;
    this.historyState = this.history.createDiv({ cls: 'raft-history-state' });
    this.messageList = this.history.createDiv({ cls: 'raft-message-list' });
    const footer = this.root.createEl('footer', { cls: 'raft-composer-host' });
    this.mentionMenu = footer.createDiv({ cls: 'raft-mention-menu', attr: { role: 'listbox', 'aria-label': 'Mention suggestions' } });
    this.mentionMenu.hidden = true;
    const box = footer.createDiv({ cls: 'raft-composer-box' });
    // The attached note sits as a small chip on top of the message box.
    this.contextChip = box.createDiv({ cls: 'raft-context-chip' });
    const chipIcon = this.contextChip.createSpan({ cls: 'raft-chip-icon', attr: { 'aria-hidden': 'true' } });
    setIcon(chipIcon, 'file-text');
    this.contextName = this.contextChip.createSpan({ cls: 'raft-context-name' });
    this.contextScope = this.contextChip.createSpan({ cls: 'raft-context-scope' });
    const detach = this.iconButton(this.contextChip, 'Detach note', 'x', () => this.setAttach(false));
    detach.addClass('raft-chip-close');
    this.contextDescription = box.createDiv({ cls: 'raft-visually-hidden' });
    this.fileTray = box.createDiv({ cls: 'raft-file-tray' });
    this.fileTray.hidden = true;
    this.fileInput = box.createEl('input', { type: 'file', attr: { multiple: '', hidden: '' } });
    this.fileInput.addEventListener('change', () => { this.addFiles(Array.from(this.fileInput.files ?? [])); this.fileInput.value = ''; });
    box.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); box.addClass('is-dropping'); } });
    box.addEventListener('dragleave', () => box.removeClass('is-dropping'));
    box.addEventListener('drop', event => {
      box.removeClass('is-dropping');
      const dropped = Array.from(event.dataTransfer?.files ?? []);
      if (!dropped.length) return;
      event.preventDefault();
      this.addFiles(dropped);
    });
    this.composer = box.createEl('textarea', { cls: 'raft-composer', attr: { 'aria-label': 'Message', rows: '1' } });
    this.composer.value = this.drafts.get(this.draftKey()) || '';
    this.composer.addEventListener('input', () => { this.rememberDraft(); this.autosize(); this.updateMentions(); this.updateControls(); });
    this.composer.addEventListener('click', () => this.updateMentions());
    this.composer.addEventListener('paste', event => {
      const pasted = Array.from(event.clipboardData?.files ?? []);
      if (!pasted.length) return;
      event.preventDefault();
      this.addFiles(pasted);
    });
    this.composer.addEventListener('blur', () => { window.setTimeout(() => this.closeMentions(), 120); });
    this.composer.addEventListener('keydown', event => {
      if (this.handleMentionKey(event)) return;
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        void this.send();
      }
    });
    const toolbar = box.createDiv({ cls: 'raft-composer-toolbar' });
    const left = toolbar.createDiv({ cls: 'raft-composer-tools' });
    this.attachButton = this.iconButton(left, 'Attach current note', 'paperclip', () => this.setAttach(!this.plugin.settings.attachDocument));
    this.selectionButton = this.iconButton(left, 'Send selected text only', 'text-cursor-input', () => {
      this.plugin.settings.useSelection = !this.plugin.settings.useSelection;
      this.updateContext();
      void this.savePreferences();
    });
    this.mentionButton = this.iconButton(left, 'Mention someone', 'at-sign', () => this.insertAtCursor('@'));
    this.fileButton = this.iconButton(left, 'Add images, videos or files', 'image-plus', () => this.fileInput.click());
    this.sendButton = this.iconButton(toolbar, 'Send', 'send-horizontal', () => { void this.send(); });
    this.sendButton.addClass('raft-send');
    this.updateContext();
    this.updateControls();
    this.autosize();
  }

  /** Files waiting to be sent with the next message, shown as removable chips (images as thumbnails). */
  private addFiles(files: File[]): void {
    const tooBig = files.filter(f => f.size > MAX_FILE_BYTES);
    const room = MAX_ATTACHMENTS - (this.plugin.settings.attachDocument ? 1 : 0);
    let skipped = 0;
    for (const file of files) if (file.size > 0 && file.size <= MAX_FILE_BYTES) {
      if (this.pendingFiles.length >= room) { skipped++; continue; }
      this.pendingFiles.push({ file, url: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined });
    }
    const problems = [
      tooBig.length ? `${tooBig.map(f => f.name).join(', ')}: Raft accepts files up to ${MAX_FILE_BYTES / 1048576} MB.` : '',
      skipped ? `A message can carry at most ${MAX_ATTACHMENTS} files${room < MAX_ATTACHMENTS ? ', including the attached note' : ''}; ${skipped} not added.` : '',
    ].filter(Boolean);
    this.alert.empty();
    if (problems.length) this.alert.setText(problems.join(' '));
    this.renderFiles();
  }

  private clearFiles(): void {
    for (const item of this.pendingFiles) if (item.url) URL.revokeObjectURL(item.url);
    this.pendingFiles = [];
    this.renderFiles();
  }

  private renderFiles(): void {
    this.fileTray.empty();
    this.fileTray.hidden = !this.pendingFiles.length;
    this.pendingFiles.forEach((item, index) => {
      const chip = this.fileTray.createDiv({ cls: 'raft-file-chip', attr: { title: item.file.name } });
      if (item.url) chip.createEl('img', { attr: { src: item.url, alt: '' } });
      else setIcon(chip.createSpan({ cls: 'raft-chip-icon', attr: { 'aria-hidden': 'true' } }), item.file.type.startsWith('video/') ? 'film' : 'file');
      chip.createSpan({ cls: 'raft-file-name', text: item.file.name });
      const remove = this.iconButton(chip, `Remove ${item.file.name}`, 'x', () => {
        if (this.sending) return;
        const [gone] = this.pendingFiles.splice(index, 1);
        if (gone?.url) URL.revokeObjectURL(gone.url);
        this.renderFiles();
      });
      remove.addClass('raft-chip-close');
    });
    this.updateControls();
  }

  private setAttach(value: boolean): void {
    this.plugin.settings.attachDocument = value;
    this.updateContext();
    void this.savePreferences();
  }

  private autosize(): void {
    if (!this.composer) return;
    this.composer.style.height = 'auto';
    this.composer.style.height = `${Math.min(this.composer.scrollHeight, 128)}px`;
  }

  private insertAtCursor(text: string): void {
    const start = this.composer.selectionStart ?? this.composer.value.length;
    const end = this.composer.selectionEnd ?? start;
    const before = this.composer.value.slice(0, start);
    const prefix = text === '@' && before && !/\s$/.test(before) ? ' ' : '';
    this.composer.setRangeText(prefix + text, start, end, 'end');
    this.composer.focus();
    this.composer.dispatchEvent(new Event('input'));
  }

  /** @mention suggestions from the current channel's agents and people. */
  private mentionQuery(): { start: number; query: string } | null {
    const caret = this.composer.selectionStart ?? 0;
    if (caret !== this.composer.selectionEnd) return null;
    const match = /(^|\s)@([^\s@]*)$/.exec(this.composer.value.slice(0, caret));
    return match ? { start: caret - match[2].length - 1, query: match[2].toLowerCase() } : null;
  }

  private updateMentions(): void {
    const query = this.mentionQuery();
    if (!query || !this.members.length) { this.closeMentions(); return; }
    this.mentionMatches = this.members.filter(member => member.id !== this.plugin.session?.userId &&
      (member.name.toLowerCase().includes(query.query) || member.displayName.toLowerCase().includes(query.query))).slice(0, 8);
    if (!this.mentionMatches.length) { this.closeMentions(); return; }
    this.mentionIndex = Math.min(this.mentionIndex, this.mentionMatches.length - 1);
    this.mentionMenu.empty();
    this.mentionMatches.forEach((member, index) => {
      const row = this.mentionMenu.createDiv({ cls: 'raft-mention-option', attr: { role: 'option', 'aria-selected': String(index === this.mentionIndex) } });
      row.toggleClass('is-active', index === this.mentionIndex);
      this.renderAvatar(row, member.kind === 'agent' ? 'agent' : 'user', member.avatarUrl, member.gravatarHash, 'raft-avatar-sm');
      row.createSpan({ cls: 'raft-mention-name', text: member.displayName });
      if (member.displayName !== member.name) row.createSpan({ cls: 'raft-mention-handle', text: `@${member.name}` });
      row.createSpan({ cls: 'raft-mention-kind', text: member.kind === 'agent' ? 'Agent' : '' });
      row.addEventListener('mousedown', event => { event.preventDefault(); this.chooseMention(member); });
    });
    this.mentionMenu.hidden = false;
  }

  private closeMentions(): void {
    if (!this.mentionMenu) return;
    this.mentionMenu.hidden = true;
    this.mentionMatches = [];
    this.mentionIndex = 0;
  }

  private chooseMention(member: ChannelMember): void {
    const query = this.mentionQuery();
    if (!query) return;
    const caret = this.composer.selectionStart ?? this.composer.value.length;
    this.composer.setRangeText(`@${member.name} `, query.start, caret, 'end');
    this.closeMentions();
    this.composer.focus();
    this.rememberDraft();
    this.updateControls();
  }

  private handleMentionKey(event: KeyboardEvent): boolean {
    if (this.mentionMenu.hidden || !this.mentionMatches.length) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      this.mentionIndex = (this.mentionIndex + step + this.mentionMatches.length) % this.mentionMatches.length;
      this.updateMentions();
      return true;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.isComposing) {
      event.preventDefault();
      this.chooseMention(this.mentionMatches[this.mentionIndex]);
      return true;
    }
    if (event.key === 'Escape') { event.preventDefault(); this.closeMentions(); return true; }
    return false;
  }

  private async loadCatalog(token: number): Promise<void> {
    this.catalogLoading = true;
    this.setStatus('Loading channels…');
    this.updateControls();
    try {
      const channels = await this.plugin.client.channels();
      if (!this.isCurrent(token)) return;
      this.catalogAt = Date.now();
      this.channels = channels;
      this.channelSelect.empty();
      if (!channels.length) this.channelSelect.createEl('option', { value: '', text: 'No channels available' });
      for (const channel of channels) this.channelSelect.createEl('option', { value: channel.id, text: channel.name });
      const bound = this.plugin.bindingFor()?.channelId;
      const selected = channels.find(channel => channel.id === bound)?.id ||
        channels.find(channel => channel.id === this.plugin.settings.channelId)?.id || channels[0]?.id || '';
      this.plugin.settings.channelId = selected;
      this.channelSelect.value = selected;
      this.restoreDraft();
      if (selected) this.plugin.watchChannel(selected);
      await this.loadMembers(token);
      if (this.isCurrent(token)) await this.savePreferences();
    } catch (cause) {
      if (this.isCurrent(token)) this.showError(cause, 'Could not load channels. Use Refresh to try again.');
    } finally {
      if (this.isCurrent(token)) { this.catalogLoading = false; this.updateControls(); }
    }
  }

  /**
   * Picks up channels created, joined or renamed since the list was loaded, without disturbing the open conversation.
   * Runs from Refresh, when the channel menu is opened, and now and then while polling.
   */
  async refreshCatalog(force = false): Promise<void> {
    const now = Date.now();
    if (!this.plugin.session || this.catalogLoading || this.catalogRefreshing || (!force && now - this.catalogAt < 10_000)) return;
    const token = this.epoch;
    this.catalogRefreshing = true;
    try {
      const channels = await this.plugin.client.channels();
      if (!this.isCurrent(token)) return;
      this.catalogAt = Date.now();
      const same = channels.length === this.channels.length && channels.every((c, i) => c.id === this.channels[i].id && c.name === this.channels[i].name);
      if (same) return;
      const current = this.plugin.settings.channelId;
      this.channels = channels;
      this.channelSelect.empty();
      if (!channels.length) this.channelSelect.createEl('option', { value: '', text: 'No channels available' });
      for (const channel of channels) this.channelSelect.createEl('option', { value: channel.id, text: channel.name });
      if (channels.some(c => c.id === current)) {
        this.channelSelect.value = current;
        this.updateContext();
        this.updateControls();
      } else if (channels[0]) await this.changeChannel(channels[0].id);
      else this.updateControls();
    } catch { /* The current list stays usable; the next refresh tries again. */ }
    finally { this.catalogRefreshing = false; }
  }

  private async loadMembers(token: number): Promise<void> {
    this.members = [];
    if (!this.plugin.settings.channelId) return;
    try {
      const members = await this.plugin.client.members(this.plugin.settings.channelId);
      if (!this.isCurrent(token)) return;
      this.members = members;
      if (this.stewardBadge) this.updateBinding();
    } catch (cause) {
      if (this.isCurrent(token)) this.showError(cause, 'Channel members could not be loaded. You can still type @name yourself.');
    }
  }

  private async changeChannel(channelId: string): Promise<void> {
    this.rememberDraft();
    const token = this.invalidate();
    this.plugin.settings.channelId = channelId;
    this.channelSelect.value = channelId;
    if (channelId) this.plugin.watchChannel(channelId);
    this.thread = null;
    this.resetHistory();
    this.updateThreadBar();
    this.restoreDraft();
    this.updateBinding();
    this.catalogLoading = true;
    this.updateControls();
    await this.loadMembers(token);
    if (!this.isCurrent(token)) return;
    this.catalogLoading = false;
    await this.savePreferences();
    if (!this.isCurrent(token)) return;
    await this.loadHistory();
    this.schedulePoll();
  }

  private resetHistory(): void {
    this.messages.clear();
    this.nodes.clear();
    this.messageList.empty();
    this.hasMore = false;
    this.historyLimited = false;
    this.olderButton.hidden = true;
    this.historyState.setText('Loading conversation…');
    this.alert.empty();
  }

  private historyChannel(): string | null {
    return this.thread ? this.thread.channelId : this.plugin.settings.channelId || null;
  }

  private loadHistory(): Promise<void> {
    const token = this.epoch;
    if (!this.isCurrent(token)) return Promise.resolve();
    if (this.request?.epoch === token) return this.request.promise;
    const promise = this.fetchHistory(token);
    this.request = { epoch: token, promise };
    void promise.finally(() => {
      if (this.request?.promise === promise) this.request = null;
    });
    return promise;
  }

  private async fetchHistory(token: number): Promise<void> {
    if (this.thread && !this.thread.channelId) {
      try {
        const threadChannel = await this.plugin.threadChannel(this.thread.parentChannelId, this.thread.root.id);
        if (!this.isCurrent(token)) return;
        this.thread.channelId = threadChannel;
      } catch (cause) {
        if (this.isCurrent(token)) this.showError(cause, 'Could not check thread replies. Use Refresh to try again.');
        return;
      }
    }
    const channelId = this.historyChannel();
    if (!channelId) {
      this.historyState.setText(this.thread ? 'No replies yet. Send the first reply below.' : 'Choose a channel to start a conversation.');
      this.setStatus(this.thread ? 'Thread' : 'No channel selected');
      this.updateControls();
      return;
    }
    const initial = this.messages.size === 0;
    this.setStatus('Checking for messages…');
    if (initial) this.historyState.setText('Loading conversation…');
    this.refreshButton.disabled = true;
    try {
      const known = [...this.messages.values()];
      let after: string | number | undefined = initial ? undefined : this.latestCursor(known);
      // Drain every available page so channel replies are never skipped on a busy channel.
      let keepReading = true;
      while (keepReading) {
        const page: HistoryPage = await this.plugin.client.messages(channelId, { ...(after === undefined ? {} : { after }), limit: PAGE_SIZE });
        if (!this.isCurrent(token)) return;
        this.historyLimited ||= !!page.historyLimited;
        if (initial && after === undefined) this.hasMore = page.hasMore ?? page.messages.length >= PAGE_SIZE;
        const updates = [...page.messages];
        for (const [id, summary] of Object.entries(page.threadSummariesByParentMessageId || {})) {
          const message = this.messages.get(id);
          if (message && !updates.some(update => update.id === id)) updates.push({ ...message, replyCount: summary.replyCount, threadSummary: summary });
        }
        await this.mergeMessages(updates, token, false);
        if (!this.isCurrent(token)) return;
        const next = page.messages.length ? this.latestCursor(page.messages) : after;
        keepReading = after !== undefined && (page.hasMore ?? page.messages.length >= PAGE_SIZE)
          && page.messages.length > 0 && next !== undefined && next !== after;
        after = next;
      }
      // Thread replies don't add channel messages, so an `after` read never refreshes the reply counts of messages
      // already shown. Re-read the latest page for its thread summaries (and any edits to recent messages).
      if (!initial) {
        const latest: HistoryPage = await this.plugin.client.messages(channelId, { limit: PAGE_SIZE });
        if (!this.isCurrent(token)) return;
        const updates = latest.messages.filter(message => this.messages.has(message.id));
        for (const [id, summary] of Object.entries(latest.threadSummariesByParentMessageId || {})) {
          const message = this.messages.get(id);
          if (message && !updates.some(update => update.id === id)) updates.push({ ...message, replyCount: summary.replyCount, threadSummary: summary });
        }
        await this.mergeMessages(updates, token, false);
        if (!this.isCurrent(token)) return;
      }
      // Applying a proposal changes local eligibility even when history has no new messages.
      await this.mergeMessages([...this.messages.values()], token, false);
      if (!this.isCurrent(token)) return;
      this.historyState.setText(this.messages.size ? this.historyLimited ? 'The server limits the available history.' : '' : 'No messages yet. Start a conversation below.');
      this.olderButton.hidden = !this.hasMore;
      if (this.historyError) { this.alert.empty(); this.historyError = false; }
      this.setStatus('Up to date');
    } catch (cause) {
      if (this.isCurrent(token)) {
        if (!this.messages.size) this.historyState.setText('Conversation could not be loaded.');
        this.showError(cause, 'Could not refresh messages. Use Refresh to try again.');
        this.historyError = true;
        this.setStatus('Connection interrupted');
      }
    } finally {
      if (this.isCurrent(token)) { this.refreshButton.disabled = false; this.updateControls(); }
    }
  }

  private async loadOlder(): Promise<void> {
    const channel = this.historyChannel();
    if (!channel || this.olderLoading || !this.hasMore || !this.messages.size) return;
    const token = this.epoch;
    this.olderLoading = true;
    this.olderButton.disabled = true;
    this.olderButton.setText('Loading older messages…');
    try {
      const sorted = [...this.messages.values()].sort((a, b) => this.compareMessages(a, b));
      const first = sorted[0];
      const before = first.seq ?? first.id;
      const page = await this.plugin.client.messages(channel, { before, limit: PAGE_SIZE });
      if (!this.isCurrent(token)) return;
      this.historyLimited ||= !!page.historyLimited;
      const addedOlderMessages = page.messages.some(message => !this.messages.has(message.id));
      await this.mergeMessages(page.messages, token, true);
      if (!this.isCurrent(token)) return;
      this.hasMore = addedOlderMessages && (page.hasMore ?? page.messages.length >= PAGE_SIZE);
      if (this.historyLimited) this.historyState.setText('The server limits the available history.');
      this.olderButton.hidden = !this.hasMore;
    } catch (cause) {
      if (this.isCurrent(token)) this.showError(cause, 'Could not load older messages. Try again.');
    } finally {
      if (this.isCurrent(token)) {
        this.olderLoading = false;
        this.olderButton.disabled = false;
        this.olderButton.setText('Load older messages');
      }
    }
  }

  private async mergeMessages(incoming: Message[], token: number, older: boolean): Promise<void> {
    const nearBottom = this.history.scrollHeight - this.history.scrollTop - this.history.clientHeight < 80;
    const initial = this.messages.size === 0;
    const previousHeight = this.history.scrollHeight;
    const previousTop = this.history.scrollTop;
    const rendered: { message: Message; signature: string; element: HTMLElement }[] = [];
    for (const message of incoming) {
      if (!this.thread && message.threadSummary) void this.plugin.scanThread(this.plugin.settings.channelId, message).catch(() => {});
      const signature = JSON.stringify([message, this.plugin.proposals(message).map(proposal => proposal.id), this.plugin.undoable(message.id).map(entry => entry.id)]);
      if (this.nodes.get(message.id)?.signature === signature) continue;
      const element = await this.renderMessage(message, token);
      if (!this.isCurrent(token)) return;
      rendered.push({ message, signature, element });
    }
    for (const entry of rendered) {
      this.nodes.get(entry.message.id)?.element.remove();
      this.messages.set(entry.message.id, entry.message);
      this.nodes.set(entry.message.id, { signature: entry.signature, element: entry.element });
    }
    this.layoutTimeline();
    if (older) this.history.scrollTop = previousTop + this.history.scrollHeight - previousHeight;
    else if (initial || nearBottom) this.history.scrollTop = this.history.scrollHeight;
  }

  /** Orders messages and inserts day dividers. Every message retains its avatar and sender. */
  private layoutTimeline(): void {
    this.messageList.querySelectorAll('.raft-day-divider').forEach(element => element.remove());
    const sorted = [...this.messages.values()].sort((a, b) => this.compareMessages(a, b));
    let previous: Message | null = null;
    for (const message of sorted) {
      const element = this.nodes.get(message.id)?.element;
      if (!element) continue;
      const day = this.dayKey(message), previousDay = previous ? this.dayKey(previous) : null;
      if (day && day !== previousDay) this.messageList.appendChild(this.dayDivider(message));
      element.removeClass('is-continuation');
      this.messageList.appendChild(element);
      previous = message;
    }
  }

  private dayKey(message: Message): string {
    const date = new Date(message.createdAt || '');
    return Number.isNaN(date.getTime()) ? '' : date.toDateString();
  }

  private dayDivider(message: Message): HTMLElement {
    const divider = this.containerEl.ownerDocument.createElement('div');
    divider.className = 'raft-day-divider';
    divider.setAttribute('role', 'separator');
    const date = new Date(message.createdAt || '');
    const today = new Date(), yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    const label = date.toDateString() === today.toDateString() ? 'Today'
      : date.toDateString() === yesterday.toDateString() ? 'Yesterday'
        : date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) });
    divider.createSpan({ cls: 'raft-rule' });
    divider.createSpan({ cls: 'raft-day-label', text: label });
    divider.createSpan({ cls: 'raft-rule' });
    return divider;
  }

  private renderAvatar(parent: HTMLElement, kind: 'agent' | 'user', avatarUrl?: string, gravatarHash?: string, extra = ''): HTMLElement {
    const slot = parent.createSpan({ cls: `raft-avatar is-${kind} ${extra}`.trim(), attr: { 'aria-hidden': 'true' } });
    const fallback = () => {
      slot.empty();
      if (kind === 'agent') slot.createEl('img', { attr: { src: pixelAvatarUrl(undefined) || '', alt: '' }, cls: 'is-pixel' });
      else setIcon(slot.createSpan({ cls: 'raft-avatar-icon' }), 'user');
    };
    let src: string | null = null;
    if (isCustomAvatar(avatarUrl)) src = this.absoluteUrl(avatarUrl!);
    else if (kind === 'agent') src = pixelAvatarUrl(avatarUrl);
    else if (gravatarHash && /^[a-f0-9]{32,64}$/i.test(gravatarHash)) src = `https://www.gravatar.com/avatar/${gravatarHash}?s=72&d=404`;
    if (!src) { fallback(); return slot; }
    const image = slot.createEl('img', { attr: { alt: '' } });
    if (src.startsWith('data:')) image.addClass('is-pixel');
    image.addEventListener('error', fallback, { once: true });
    this.loadImage(image, src);
    return slot;
  }

  /**
   * Raft serves avatars and thumbnails with Cross-Origin-Resource-Policy: same-origin, so an <img> pointing at the
   * server is blocked inside Obsidian. Fetch through Obsidian's network layer instead and show a local blob URL.
   */
  private loadImage(image: HTMLImageElement, url: string): void {
    if (url.startsWith('data:')) { image.src = url; return; }
    let pending = this.images.get(url);
    if (!pending) {
      pending = requestUrl({ url, method: 'GET', throw: false }).then(response => {
        const type = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? '';
        if (response.status !== 200 || !type.toLowerCase().startsWith('image/')) return null;
        return URL.createObjectURL(new Blob([response.arrayBuffer], { type }));
      }).catch(() => null);
      this.images.set(url, pending);
      // Failed loads are retried on a later render rather than cached forever.
      void pending.then(result => { if (!result && this.images.get(url) === pending) this.images.delete(url); });
    }
    void pending.then(result => {
      if (result) image.src = result;
      else image.dispatchEvent(new Event('error'));
    });
  }

  private absoluteUrl(url: string): string | null {
    try {
      const resolved = new URL(url, this.plugin.session?.apiUrl);
      return resolved.protocol === 'https:' || resolved.protocol === 'http:' ? resolved.href : null;
    } catch { return null; }
  }

  private async renderMessage(message: Message, token: number): Promise<HTMLElement> {
    const article = this.containerEl.ownerDocument.createElement('article');
    const created = new Date(message.createdAt || '');
    const hasTime = !Number.isNaN(created.getTime());
    if (isSystem(message)) {
      article.className = 'raft-system-message';
      article.createSpan({ cls: 'raft-rule' });
      if (hasTime) article.createEl('time', { text: formatClock(created), attr: { datetime: created.toISOString(), title: created.toLocaleString() } });
      article.createSpan({ cls: 'raft-system-text', text: message.content });
      article.createSpan({ cls: 'raft-rule' });
      return article;
    }
    article.className = 'raft-message';
    const raw = rawRecord(message);
    const kind = message.senderType === 'agent' ? 'agent' : 'user';
    if (message.senderId && message.senderId === this.plugin.session?.userId) article.addClass('is-self');
    const gutter = article.createDiv({ cls: 'raft-gutter' });
    // History rows rarely carry avatars; Raft web resolves them from member profiles, so do the same.
    const member = this.members.find(item => item.id === message.senderId);
    this.renderAvatar(gutter, kind, stringField(raw, 'senderAvatarUrl') ?? member?.avatarUrl, stringField(raw, 'senderGravatarHash') ?? member?.gravatarHash);
    if (hasTime) gutter.createEl('time', { cls: 'raft-gutter-time', text: formatClock(created), attr: { datetime: created.toISOString(), title: created.toLocaleString() } });
    const main = article.createDiv({ cls: 'raft-message-main' });
    const meta = main.createDiv({ cls: 'raft-message-meta' });
    meta.createSpan({ cls: 'raft-message-sender', text: message.senderName || 'Unknown sender' });
    const description = stringField(raw, 'senderDescription');
    if (description) meta.createSpan({ cls: 'raft-message-subtitle', text: description });
    if (hasTime) meta.createEl('time', { cls: 'raft-message-time', text: formatTimestamp(created), attr: { datetime: created.toISOString(), title: created.toLocaleString() } });
    const proposals = this.plugin.proposals(message);
    if (proposals.length) this.plugin.autoApply(message);
    const note = message.senderId === this.plugin.session?.userId ? splitNoteContext(message.content || '') : { text: message.content || '' };
    let displayContent = note.text;
    // Edit, file-request and sync blocks are protocol, not conversation: they show as cards or under a disclosure.
    const protocol = /^```raft-(?:need|sync)\s*\r?\n[\s\S]*?^```\s*$/gm;
    const split = splitEditBlocks(displayContent);
    const editBlocks = [...split.blocks, ...[...split.text.matchAll(protocol)].map(match => match[0])];
    if (editBlocks.length) displayContent = split.text.replace(protocol, '').trim();
    // Sync openers and requests fold to their first line; the steward brief and request details stay one click away.
    const sync = isSyncMessage(message.content || '');
    let syncDetails = '';
    if (sync) { const [first, ...rest] = displayContent.split('\n'); syncDetails = rest.join('\n').trim(); displayContent = first; }
    const body = main.createDiv({ cls: 'raft-message-body markdown-rendered' });
    try {
      await MarkdownRenderer.render(this.app, displayContent, body, this.app.workspace.getActiveFile()?.path || '', this);
    } catch {
      body.empty();
      body.setText(displayContent);
    }
    if (!this.isCurrent(token)) return article;
    this.decorateMentions(body);
    let attachments = message.attachments || [];
    if (note.path) {
      const path = note.path;
      const chip = main.createDiv({ cls: 'raft-sent-note', attr: { title: path } });
      setIcon(chip.createSpan({ cls: 'raft-chip-icon', attr: { 'aria-hidden': 'true' } }), 'file-text');
      chip.createSpan({ text: path.split('/').pop() || path });
      const disclosure = main.createEl('details', { cls: 'raft-sent-context' });
      disclosure.createEl('summary', { text: 'Sent note context' });
      disclosure.createEl('pre', { text: note.context || '' });
      // The uploaded copy of the note is already shown by the chip above.
      const base = (path.split('/').pop() || '').replace(/\.md$/i, '');
      attachments = attachments.filter(value => {
        const name = value && typeof value === 'object' ? attachmentName(value as Record<string, unknown>) : '';
        return !(name === `${base}.md` || name === `${base} (selection).md`);
      });
    }
    if (attachments.length) this.renderAttachments(main, attachments, token);
    for (const proposal of proposals) this.renderProposal(main, proposal, token);
    for (const entry of this.plugin.undoable(message.id)) {
      const row = main.createDiv({ cls: 'raft-applied-row' });
      row.createSpan({ text: `📝 ${entry.before === null ? 'Created' : 'Updated'} ${entry.path}` });
      this.button(row, 'Undo', button => {
        button.disabled = true;
        void this.plugin.undo(entry.id).catch(cause => { button.disabled = false; if (this.isCurrent(token)) this.showError(cause, 'Could not undo.'); });
      });
    }
    if (syncDetails) {
      const details = main.createEl('details', { cls: 'raft-sent-context' });
      details.createEl('summary', { text: 'Sync details' });
      details.createEl('pre', { text: syncDetails });
    }
    if (editBlocks.length && !sync) {
      const details = main.createEl('details', { cls: 'raft-sent-context' });
      details.createEl('summary', { text: proposals.length ? 'Change source' : 'Note change source' });
      details.createEl('pre', { text: editBlocks.join('\n\n') });
    }
    if (!this.thread && message.replyCount) this.renderThreadSummary(main, message);
    // Keep touch actions inside the message column: static flex siblings stretch to the entire row height on iOS.
    const toolbar = main.createDiv({ cls: 'raft-hover-toolbar' });
    if (!this.thread) this.iconButton(toolbar, 'Reply in thread', 'message-square-reply', () => { void this.openThread(message); });
    const insert = this.iconButton(toolbar, 'Insert reply into note', 'file-input', () => {
      insert.disabled = true;
      void this.plugin.insertReply(message).then(() => {
        if (this.isCurrent(token)) this.updateContext();
      }).catch(cause => {
        if (this.isCurrent(token)) this.showError(cause, 'Could not insert this reply into the note.');
      }).finally(() => { insert.disabled = false; });
    });
    return article;
  }

  /** Images render inline (Raft's 22.5rem gallery); other files stay as name chips. Image URLs come from Raft's short-lived attachment links. */
  private renderAttachments(parent: HTMLElement, values: unknown[], token: number): void {
    const attachments = values.map(value => value && typeof value === 'object' ? value as Record<string, unknown> : {});
    const images = attachments.filter(isImageAttachment);
    const files = attachments.filter(attachment => !isImageAttachment(attachment));
    if (images.length) {
      const gallery = parent.createDiv({ cls: `raft-image-gallery${images.length > 1 ? ' is-multiple' : ''}` });
      const pending: { id: string; image: HTMLImageElement; frame: HTMLElement }[] = [];
      for (const attachment of images) {
        const name = attachmentName(attachment);
        const frame = gallery.createEl('button', { cls: 'raft-image-frame is-loading', attr: { type: 'button', 'aria-label': `Open image ${name}`, title: name } });
        const image = frame.createEl('img', { attr: { alt: name, loading: 'lazy' } });
        image.addEventListener('load', () => frame.removeClass('is-loading'), { once: true });
        image.addEventListener('error', () => { frame.removeClass('is-loading'); frame.addClass('is-broken'); frame.setText(name); }, { once: true });
        frame.addEventListener('click', () => { if (image.src && !frame.hasClass('is-broken')) new ImageModal(this.app, image.src, name).open(); });
        const thumbnail = typeof attachment.thumbnailUrl === 'string' ? this.absoluteUrl(attachment.thumbnailUrl) : null;
        if (thumbnail) this.loadImage(image, thumbnail);
        else if (typeof attachment.id === 'string') pending.push({ id: attachment.id, image, frame });
      }
      if (pending.length) {
        void this.plugin.client.attachmentUrls(pending.map(item => item.id)).then(urls => {
          if (!this.isCurrent(token)) return;
          for (const item of pending) {
            const url = urls.get(item.id);
            const resolved = url ? this.absoluteUrl(url) : null;
            if (resolved) this.loadImage(item.image, resolved);
            else item.image.dispatchEvent(new Event('error'));
          }
        }).catch(() => { for (const item of pending) item.image.dispatchEvent(new Event('error')); });
      }
    }
    if (files.length) {
      const list = parent.createDiv({ cls: 'raft-attachments', attr: { 'aria-label': 'Attachments' } });
      for (const attachment of files) {
        const chip = list.createSpan({ cls: 'raft-attachment' });
        setIcon(chip.createSpan({ cls: 'raft-chip-icon', attr: { 'aria-hidden': 'true' } }), 'paperclip');
        chip.createSpan({ text: attachmentName(attachment) });
      }
    }
  }

  /** Raft's inline replies block, with participant previews and an explicit "open" affordance. */
  private renderThreadSummary(parent: HTMLElement, message: Message): void {
    const summary = message.threadSummary;
    const count = message.replyCount || summary?.replyCount || 0;
    const button = parent.createEl('button', { cls: 'raft-thread-summary', attr: { type: 'button', 'aria-label': `Open thread, ${count} ${count === 1 ? 'reply' : 'replies'}` } });
    button.addEventListener('click', () => { void this.openThread(message); });
    const head = button.createDiv({ cls: 'raft-thread-summary-head' });
    const faces = head.createDiv({ cls: 'raft-thread-faces' });
    const seen = new Set<string>();
    for (const reply of summary?.latestReplies || []) {
      const key = reply.senderId || reply.senderName;
      if (seen.has(key) || seen.size >= 3) continue;
      seen.add(key);
      const member = this.members.find(item => item.id === reply.senderId);
      this.renderAvatar(faces, reply.senderType === 'agent' ? 'agent' : 'user', reply.senderAvatarUrl ?? member?.avatarUrl, member?.gravatarHash, 'raft-avatar-sm');
    }
    if (!seen.size) faces.remove();
    head.createSpan({ cls: 'raft-thread-count', text: count === 1 ? '1 reply' : `${count} replies` });
    const last = summary?.lastReplyAt ? new Date(summary.lastReplyAt) : null;
    if (last && !Number.isNaN(last.getTime())) head.createSpan({ cls: 'raft-thread-last', text: `Last reply ${formatTimestamp(last)}` });
    head.createSpan({ cls: 'raft-thread-open', text: 'View thread' });
    setIcon(head.createSpan({ cls: 'raft-thread-chevron', attr: { 'aria-hidden': 'true' } }), 'chevron-right');
    for (const reply of (summary?.latestReplies || []).slice(-3)) {
      const row = button.createDiv({ cls: 'raft-thread-preview' });
      const member = this.members.find(item => item.id === reply.senderId);
      this.renderAvatar(row, reply.senderType === 'agent' ? 'agent' : 'user', reply.senderAvatarUrl ?? member?.avatarUrl, member?.gravatarHash, 'raft-avatar-sm');
      row.createSpan({ cls: 'raft-thread-preview-name', text: reply.senderName });
      row.createSpan({ cls: 'raft-thread-preview-text', text: splitNoteContext(reply.preview).text.replace(/\s+/g, ' ') });
      const at = reply.createdAt ? new Date(reply.createdAt) : null;
      if (at && !Number.isNaN(at.getTime())) row.createSpan({ cls: 'raft-thread-preview-time', text: formatClock(at) });
    }
  }

  /** Styles @handles of channel members the way Raft does; your own handle gets the yellow sticker. */
  private decorateMentions(body: HTMLElement): void {
    const names = this.members.map(member => member.name).filter(Boolean).sort((a, b) => b.length - a.length);
    if (!names.length) return;
    const self = this.members.find(member => member.id === this.plugin.session?.userId)?.name;
    const escaped = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp(`@(${escaped.join('|')})(?![\\w-])`, 'g');
    const walker = this.containerEl.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (!node.parentElement?.closest('code, pre, a') && pattern.test(node.data)) nodes.push(node);
      pattern.lastIndex = 0;
    }
    for (const node of nodes) {
      const fragment = this.containerEl.ownerDocument.createDocumentFragment();
      let last = 0;
      for (const match of node.data.matchAll(pattern)) {
        fragment.append(node.data.slice(last, match.index));
        const span = fragment.createSpan({ cls: match[1] === self ? 'raft-mention is-self' : 'raft-mention', text: match[0] });
        span.title = match[0];
        last = (match.index ?? 0) + match[0].length;
      }
      fragment.append(node.data.slice(last));
      node.replaceWith(fragment);
    }
  }

  private renderProposal(parent: HTMLElement, proposal: Proposal, token: number): void {
    const card = parent.createDiv({ cls: 'raft-proposal' });
    card.createDiv({ cls: 'raft-proposal-title', text: proposal.create ? 'Suggested new note' : proposal.ops ? 'Suggested partial change' : 'Suggested note change' });
    card.createDiv({ cls: 'raft-proposal-path', text: proposal.path });
    card.createDiv({ cls: 'raft-caption', text: this.plugin.settings.autoApply
      ? 'Applied automatically when the note is unchanged; otherwise preview it to compare.'
      : 'Preview before applying. Your note changes only when you apply.' });
    const actions = card.createDiv({ cls: 'raft-proposal-actions' });
    this.button(actions, 'Preview', () => this.plugin.previewProposal(proposal));
    const apply = this.button(actions, 'Apply', button => {
      button.disabled = true;
      button.setText('Applying…');
      void this.plugin.applyProposal(proposal).then(() => {
        button.setText('Applied');
        if (this.isCurrent(token)) this.updateContext();
      }).catch(cause => {
        button.disabled = false;
        button.setText('Apply');
        if (this.isCurrent(token)) this.showError(cause, 'Could not apply this change. Preview it and check the current note.');
      });
    });
    apply.addClass('mod-cta');
  }

  private async openThread(root: Message): Promise<void> {
    this.rememberDraft();
    const parentChannelId = this.plugin.settings.channelId;
    const token = this.invalidate();
    this.thread = { root, parentChannelId, channelId: null };
    this.resetHistory();
    this.updateThreadBar();
    this.restoreDraft();
    this.catalogLoading = true;
    this.updateControls();
    try {
      const channelId = await this.plugin.threadChannel(parentChannelId, root.id);
      if (!this.isCurrent(token)) return;
      this.thread.channelId = channelId;
    } catch (cause) {
      if (!this.isCurrent(token)) return;
      this.showError(cause, 'Could not open this thread. Return to the channel and try again.');
    } finally {
      if (this.isCurrent(token)) { this.catalogLoading = false; this.updateControls(); }
    }
    if (!this.isCurrent(token)) return;
    await this.loadHistory();
    this.schedulePoll();
  }

  private closeThread(): void {
    if (!this.thread) return;
    this.rememberDraft();
    this.invalidate();
    this.thread = null;
    this.resetHistory();
    this.updateThreadBar();
    this.restoreDraft();
    void this.refresh();
  }

  private updateThreadBar(): void {
    this.headerTile.disabled = !this.thread;
    this.headerTile.toggleClass('is-back', !!this.thread);
    if (this.thread) { this.headerTile.removeAttribute('aria-hidden'); this.headerTile.removeAttribute('tabindex'); this.headerTile.setAttribute('aria-label', 'Back to channel'); this.headerTile.title = 'Back to channel'; }
    else { this.headerTile.setAttribute('aria-hidden', 'true'); this.headerTile.setAttribute('tabindex', '-1'); this.headerTile.removeAttribute('aria-label'); this.headerTile.title = ''; }
    this.channelSelect.hidden = !!this.thread;
    this.threadTitle.hidden = !this.thread;
    this.threadTitle.empty();
    this.headerTile.empty();
    setIcon(this.headerTile, this.thread ? 'arrow-left' : 'hash');
    if (!this.thread) { this.threadTitle.title = ''; return; }
    const channel = this.channels.find(item => item.id === this.thread?.parentChannelId);
    const excerpt = splitNoteContext(this.thread.root.content).text.replace(/\s+/g, ' ').trim();
    if (channel) this.threadTitle.createSpan({ cls: 'raft-thread-channel', text: `#${channel.name}` });
    this.threadTitle.createSpan({ cls: 'raft-thread-title', text: this.thread.root.senderName });
    if (excerpt) this.threadTitle.createSpan({ cls: 'raft-thread-excerpt', text: excerpt.slice(0, 180) });
    this.threadTitle.title = [channel ? `#${channel.name}` : '', this.thread.root.senderName, excerpt].filter(Boolean).join(' · ');
  }

  private async send(): Promise<void> {
    const text = this.composer?.value || '';
    const channel = this.plugin.settings.channelId;
    const pending = [...this.pendingFiles];
    if ((!text.trim() && !pending.length) || !channel || !this.plugin.session || this.sending || this.catalogLoading) return;
    const token = this.epoch;
    const key = this.draftKey();
    const thread = this.thread;
    this.sending = true;
    this.rememberDraft();
    this.alert.empty();
    this.updateControls();
    try {
      // Recipients are @mentioned in the text itself, as in Raft.
      const files = await Promise.all(pending.map(async ({ file }) => ({ name: file.name || 'pasted-file', type: file.type, data: await file.arrayBuffer() })));
      await this.plugin.send(thread?.parentChannelId || channel, '', text,
        this.plugin.settings.attachDocument, this.plugin.settings.useSelection, thread?.root.id, files);
      if (this.drafts.get(key) === text) this.drafts.delete(key);
      if (!this.isCurrent(token)) return;
      if (pending.length) this.clearFiles();
      if (this.composer.value === text) { this.composer.value = ''; this.autosize(); }
      if (thread && !thread.channelId) {
        try {
          const threadChannel = await this.plugin.threadChannel(thread.parentChannelId, thread.root.id);
          if (!this.isCurrent(token)) return;
          thread.channelId = threadChannel;
        } catch (cause) {
          if (this.isCurrent(token)) this.showError(cause, 'Your reply was sent, but its thread could not be loaded. Use Refresh to try again.');
          return;
        }
      }
      await this.loadHistory();
      if (this.isCurrent(token)) this.history.scrollTop = this.history.scrollHeight;
    } catch (cause) {
      if (this.isCurrent(token)) this.showError(cause, 'Message was not sent. Your draft is kept; try again.');
    } finally {
      this.sending = false;
      if (!this.closed && this.plugin.session && this.root.hasClass('raft-conversation')) {
        this.updateControls();
        this.updateContext();
      }
    }
  }

  private async signOut(): Promise<void> {
    if (this.sending || this.authenticating) return;
    this.rememberDraft();
    this.invalidate();
    this.signOutButton.disabled = true;
    try {
      await this.plugin.signOut();
      if (this.closed) return;
      this.drafts.clear();
      this.renderLogin();
    } catch (cause) {
      if (this.closed) return;
      if (!this.plugin.session) this.renderLogin();
      else {
        this.signOutButton.disabled = false;
        this.showError(cause, 'Could not sign out. Try again.');
        this.schedulePoll();
      }
    }
  }

  private compareMessages(a: Message, b: Message): number {
    if (a.seq !== undefined && b.seq !== undefined) return a.seq - b.seq || a.id.localeCompare(b.id);
    const time = Date.parse(a.createdAt || '') - Date.parse(b.createdAt || '');
    return (Number.isFinite(time) && time !== 0 ? time : 0) || a.id.localeCompare(b.id);
  }
  private latestCursor(messages: Message[]): string | number | undefined {
    const sorted = [...messages].sort((a, b) => this.compareMessages(a, b));
    const last = sorted[sorted.length - 1];
    return last ? last.seq ?? last.id : undefined;
  }
  private draftKey(): string { return `${this.plugin.settings.channelId}:${this.thread?.root.id || 'channel'}`; }
  private rememberDraft(): void {
    if (this.composer && this.root?.hasClass('raft-conversation')) this.drafts.set(this.draftKey(), this.composer.value);
  }
  private restoreDraft(): void {
    this.composer.value = this.drafts.get(this.draftKey()) || '';
    this.autosize();
    this.updateControls();
  }
  private updateControls(): void {
    if (!this.sendButton) return;
    const busy = this.sending || this.catalogLoading || this.authenticating;
    this.sendButton.disabled = busy || !this.plugin.session || !this.plugin.settings.channelId || (!this.composer.value.trim() && !this.pendingFiles.length);
    this.sendButton.setAttribute('aria-label', this.sending ? 'Sending…' : this.thread ? 'Send reply' : 'Send');
    this.sendButton.title = this.sendButton.getAttribute('aria-label') || '';
    this.composer.disabled = this.authenticating || !this.plugin.session;
    this.channelSelect.disabled = busy || !this.channels.length;
    this.attachButton.disabled = this.sending;
    if (this.fileButton) this.fileButton.disabled = this.sending;
    this.selectionButton.disabled = this.sending || !this.plugin.settings.attachDocument;
    const channel = this.channels.find(item => item.id === this.plugin.settings.channelId);
    this.composer.placeholder = this.thread ? 'Reply in thread…' : channel ? `Message #${channel.name}` : 'Message';
    this.signOutButton.disabled = this.sending || this.authenticating;
  }
  private setStatus(text: string): void {
    this.status?.setText(text);
    if (this.refreshButton) this.refreshButton.title = text === 'Up to date' ? 'Refresh · Up to date' : `Refresh · ${text}`;
  }
  private showError(cause: unknown, fallback: string): void {
    this.historyError = false;
    this.alert?.setText(this.errorText(cause, fallback));
  }
  private errorText(cause: unknown, fallback: string): string {
    // Authentication errors can contain request details; never echo arbitrary response bodies.
    const status = cause && typeof cause === 'object' && 'status' in cause ? Number(cause.status) : undefined;
    if (status === 401 || status === 403) return 'Your session is unavailable or access was denied. Sign in again or check channel access.';
    if (cause instanceof RaftClientError) return `${fallback} ${cause.message}`;
    // The plugin's own validation errors explain missing selections, limits, and edit conflicts.
    if (cause instanceof Error) return `${fallback} ${cause.message}`;
    return fallback;
  }
  private async savePreferences(): Promise<void> {
    try { await this.plugin.saveSettings(); }
    catch (cause) { if (!this.closed) this.showError(cause, 'Could not save preferences. Your choices still apply to this session.'); }
  }
  private iconButton(parent: HTMLElement, label: string, icon: string, action: () => void): HTMLButtonElement {
    const button = this.button(parent, '', action);
    button.addClass('raft-icon-button');
    button.setAttribute('aria-label', label);
    button.title = label;
    setIcon(button, icon);
    return button;
  }
  private button(parent: HTMLElement, text: string, action: (button: HTMLButtonElement) => void): HTMLButtonElement {
    const button = parent.createEl('button', { text, type: 'button' });
    button.addEventListener('click', () => action(button));
    return button;
  }
}

function rawRecord(message: Message): Record<string, unknown> | null {
  const raw = (message as Message & { raw?: unknown }).raw;
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
}
function stringField(raw: Record<string, unknown> | null, key: string): string | undefined {
  const value = raw?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}
function isSystem(message: Message): boolean {
  return stringField(rawRecord(message), 'messageType') === 'system';
}
function formatClock(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
/** Raft's timestamp rule: today → time, yesterday → "Yesterday time", this year → MM/DD time, else YYYY/MM/DD time. */
export function formatTimestamp(date: Date, now = new Date()): string {
  const clock = formatClock(date);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === now.toDateString()) return clock;
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${clock}`;
  const md = `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
  return date.getFullYear() === now.getFullYear() ? `${md} ${clock}` : `${date.getFullYear()}/${md} ${clock}`;
}

function isImageAttachment(attachment: Record<string, unknown>): boolean {
  const mime = typeof attachment.mimeType === 'string' ? attachment.mimeType.split(';')[0].trim().toLowerCase() : '';
  if (mime === 'image/svg+xml') return typeof attachment.thumbnailUrl === 'string' || typeof attachment.rasterPreviewUrl === 'string';
  if (mime) return mime.startsWith('image/');
  return /\.(png|jpe?g|gif|webp|avif|heic)$/i.test(attachmentName(attachment));
}
function attachmentName(attachment: Record<string, unknown>): string {
  const name = attachment.filename ?? attachment.fileName ?? attachment.name;
  return typeof name === 'string' && name ? name : 'Attachment';
}

class ImageModal extends Modal {
  constructor(app: App, private readonly src: string, private readonly name: string) { super(app); }
  onOpen(): void {
    this.modalEl.addClass('raft-image-modal');
    this.titleEl.setText(this.name);
    this.contentEl.createEl('img', { attr: { src: this.src, alt: this.name } });
  }
  onClose(): void { this.contentEl.empty(); }
}
