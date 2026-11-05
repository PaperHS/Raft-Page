export interface TransportRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: unknown;
  /** Pre-encoded body (multipart uploads); sent as-is instead of JSON. */
  rawBody?: ArrayBuffer;
}

/** A body that is already encoded, with its own Content-Type. */
class RawBody {
  constructor(readonly contentType: string, readonly data: ArrayBuffer) {}
}

export interface TransportResponse {
  status: number;
  json: any;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export interface Session {
  apiUrl: string;
  accessToken: string;
  refreshToken: string;
  userId: string;
  userName: string;
  /** The selected server is saved only through the caller's session callback. */
  serverId: string;
  /** The server's short name, as in Raft web addresses (/s/<slug>). */
  serverSlug?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads what the user typed for the server: "myserver", "/myserver", "/s/myserver", a Raft web URL, a server ID, or nothing. */
export function parseServerRef(input: string): { id?: string; slug?: string } {
  let value = (input || "").trim();
  if (/^https?:\/\//i.test(value)) { try { value = new URL(value).pathname; } catch { /* Treated as a name below. */ } }
  const parts = value.split("/").filter(Boolean);
  const name = parts[0] === "s" ? parts[1] : parts[0];
  if (!name) return {};
  return UUID.test(name) ? { id: name } : { slug: decodeURIComponent(name).toLowerCase() };
}

export interface Channel {
  id: string;
  name: string;
}

export interface Agent {
  id: string;
  name: string;
  displayName: string;
}

export interface Member extends Agent {
  kind: "agent" | "human";
  avatarUrl?: string;
  gravatarHash?: string;
  /** Raft agent activity: online, thinking, working, error or offline. */
  activity?: string;
}

export interface Message {
  id: string;
  channelId?: string;
  senderType?: string;
  /** Missing sequence numbers stay absent; they are never fabricated. */
  seq?: number;
  content: string;
  senderName: string;
  senderId?: string;
  createdAt?: string;
  attachments?: unknown[];
  threadId?: string;
  replyCount?: number;
  threadSummary?: ThreadSummary;
  pendingMentionActions?: PendingMentionAction[];
  unresolvedMentionHandles?: string[];
  deliveryWarnings?: MessageDeliveryWarning[];
  raw?: unknown;
}

export interface PendingMentionAction {
  resolutionId: string;
  messageId: string;
  targetType: string;
  targetHandle: string;
  reason: string;
  availableActions: string[];
  expiresAt?: string | null;
}

export interface MessageDeliveryWarning {
  targetType: string;
  targetId: string;
  reason: string;
}

export interface ThreadReplyPreview {
  senderId?: string;
  senderType?: string;
  senderName: string;
  senderAvatarUrl?: string;
  preview: string;
  createdAt?: string;
}

export interface ThreadSummary {
  replyCount: number;
  lastReplyAt?: string;
  latestReplies?: ThreadReplyPreview[];
}

export interface MessagePage {
  messages: Message[];
  hasMore: boolean;
  historyLimited?: boolean;
  threadSummariesByParentMessageId?: Record<string, ThreadSummary>;
}

export interface MessagePageOptions {
  before?: string | number;
  after?: string | number;
  limit?: number;
}

export type ClientErrorCode =
  | "INVALID_URL" | "INVALID_INPUT" | "NO_SESSION" | "AUTH_EXPIRED"
  | "HTTP_ERROR" | "NETWORK_ERROR" | "INVALID_RESPONSE"
  | "REFRESH_UNAVAILABLE" | "SESSION_ERROR" | "SERVER_CHOICE";

/** Deliberately excludes response bodies, request data, and transport error text. */
export class RaftClientError extends Error {
  constructor(
    public readonly code: ClientErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "RaftClientError";
  }
}

type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectValue : undefined;
}

function text(...values: unknown[]): string | undefined {
  return values.find((value): value is string =>
    typeof value === "string" && value.trim().length > 0);
}

function identifier(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  }
  return undefined;
}

function schemaError(): never {
  throw new RaftClientError("INVALID_RESPONSE", "Raft returned an invalid response.");
}

function requiredInput(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RaftClientError("INVALID_INPUT", `A valid ${label} is required.`);
  }
  return value;
}

/** Accept HTTP for local/LAN installations as well as HTTPS and base paths. */
export function normalizeApiUrl(base: string): string {
  try {
    if (typeof base !== "string" || !/^https?:\/\//i.test(base) ||
        /[?#\\\u0000- \u007f]/.test(base) || base.split("/")[2]?.includes("@")) throw new Error();
    const url = new URL(base);
    if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password) {
      throw new Error();
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw new RaftClientError("INVALID_URL", "Use an HTTP or HTTPS server URL without credentials, a query, or a fragment.");
  }
}

function normalizeChannel(value: unknown): Channel {
  const row = object(value);
  const id = identifier(row?.id, row?.channelId);
  const name = text(row?.name, row?.channelName);
  if (!id || !name) return schemaError();
  return { id, name };
}

function member(value: unknown, kind: Member["kind"]): Member {
  const row = object(value);
  const result: Member = { ...normalizeAgent(value), kind };
  if (typeof row?.avatarUrl === "string" && row.avatarUrl) result.avatarUrl = row.avatarUrl;
  if (typeof row?.gravatarHash === "string" && row.gravatarHash) result.gravatarHash = row.gravatarHash;
  if (typeof row?.activity === "string" && row.activity) result.activity = row.activity;
  return result;
}

function normalizeAgent(value: unknown): Agent {
  const row = object(value);
  const id = identifier(row?.id, row?.agentId);
  const name = text(row?.name, row?.agentName, row?.displayName);
  const displayName = text(row?.displayName, name);
  if (!id || !name || !displayName) return schemaError();
  return { id, name, displayName };
}

function normalizeMessage(value: unknown): Message {
  const row = object(value);
  const id = identifier(row?.id, row?.messageId);
  if (!row || !id || typeof row.content !== "string") return schemaError();
  const sender = object(row.sender);
  const author = object(row.author);
  const senderId = identifier(row.senderId, sender?.id, sender?.userId, row.authorId, author?.id, author?.userId);
  const senderName = text(
    row.senderDisplayName, row.senderName, sender?.displayName, sender?.name,
    row.authorDisplayName, row.authorName, author?.displayName, author?.name,
    row.sender, row.author, senderId,
  ) ?? "Unknown";
  const message: Message = { id, content: row.content, senderName, raw: value };
  if (row.channelId !== undefined) {
    const channelId = identifier(row.channelId);
    if (!channelId) return schemaError();
    message.channelId = channelId;
  }
  if (row.senderType !== undefined) {
    const senderType = text(row.senderType);
    if (!senderType) return schemaError();
    message.senderType = senderType;
  }
  if (senderId) message.senderId = senderId;
  if (row.seq !== undefined && row.seq !== null) {
    if (typeof row.seq !== "number" || !Number.isSafeInteger(row.seq) || row.seq < 0) return schemaError();
    message.seq = row.seq;
  }
  if (row.createdAt !== undefined && row.createdAt !== null) {
    if (typeof row.createdAt !== "string") return schemaError();
    message.createdAt = row.createdAt;
  }
  if (row.attachments !== undefined && row.attachments !== null) {
    if (!Array.isArray(row.attachments)) return schemaError();
    message.attachments = row.attachments;
  }
  if (row.threadId !== undefined && row.threadId !== null) {
    const threadId = identifier(row.threadId);
    if (!threadId) return schemaError();
    message.threadId = threadId;
  }
  if (row.replyCount !== undefined && row.replyCount !== null) {
    if (typeof row.replyCount !== "number" || !Number.isSafeInteger(row.replyCount) || row.replyCount < 0) return schemaError();
    message.replyCount = row.replyCount;
  }
  return message;
}

/** Thread previews are decorative: malformed rows are skipped rather than failing the page. */
function replyPreview(value: unknown): ThreadReplyPreview[] {
  const row = object(value);
  if (!row || typeof row.preview !== "string") return [];
  const senderName = text(row.senderDisplayName, row.senderName);
  if (!senderName) return [];
  const result: ThreadReplyPreview = { senderName, preview: row.preview };
  for (const key of ["senderId", "senderType", "senderAvatarUrl", "createdAt"] as const) {
    if (typeof row[key] === "string" && row[key]) result[key] = row[key] as string;
  }
  return [result];
}

function normalizePage(value: unknown, limit: number): MessagePage {
  const row = object(value);
  if (!row || !Array.isArray(row.messages)) return schemaError();
  const messages = row.messages.map(normalizeMessage);
  const result: MessagePage = { messages, hasMore: messages.length >= limit };
  if (row.historyLimited !== undefined) {
    if (typeof row.historyLimited !== "boolean") return schemaError();
    result.historyLimited = row.historyLimited;
  }
  if (row.threadSummariesByParentMessageId !== undefined) {
    const summaries = object(row.threadSummariesByParentMessageId);
    if (!summaries) return schemaError();
    const entries = Object.entries(summaries).map(([id, value]): [string, ThreadSummary] => {
      const summary = object(value);
      if (!summary || typeof summary.replyCount !== "number" ||
          !Number.isSafeInteger(summary.replyCount) || summary.replyCount < 0) return schemaError();
      if (summary.lastReplyAt !== undefined && summary.lastReplyAt !== null && typeof summary.lastReplyAt !== "string") return schemaError();
      const latestReplies = Array.isArray(summary.latestReplies) ? summary.latestReplies.flatMap(replyPreview) : [];
      return [id, { replyCount: summary.replyCount,
        ...(typeof summary.lastReplyAt === "string" ? { lastReplyAt: summary.lastReplyAt } : {}),
        ...(latestReplies.length ? { latestReplies } : {}) }];
    });
    result.threadSummariesByParentMessageId = Object.fromEntries(entries);
    for (const message of messages) {
      const summary = result.threadSummariesByParentMessageId[message.id];
      if (summary) { message.replyCount = summary.replyCount; message.threadSummary = summary; }
    }
  }
  return result;
}

function normalizeSentMessage(value: unknown): Message {
  const envelope = object(value);
  const message = normalizeMessage(envelope?.message ?? value);
  if (!envelope?.message) return message;
  if (envelope.unresolvedMentionHandles !== undefined) {
    const handles = envelope.unresolvedMentionHandles;
    if (!Array.isArray(handles) || !handles.every((item) => typeof item === "string")) return schemaError();
    message.unresolvedMentionHandles = handles;
  }
  if (envelope.deliveryWarnings !== undefined) {
    if (!Array.isArray(envelope.deliveryWarnings)) return schemaError();
    message.deliveryWarnings = envelope.deliveryWarnings.map((value) => {
      const warning = object(value);
      const targetType = text(warning?.targetType);
      const targetId = identifier(warning?.targetId);
      const reason = text(warning?.reason);
      if (!targetType || !targetId || !reason) return schemaError();
      return { targetType, targetId, reason };
    });
  }
  if (envelope.pendingMentionActions !== undefined) {
    if (!Array.isArray(envelope.pendingMentionActions)) return schemaError();
    message.pendingMentionActions = envelope.pendingMentionActions.map((value) => {
      const action = object(value);
      if (!action || !text(action.resolutionId) || !text(action.messageId) ||
          !text(action.targetType) || !text(action.targetHandle) || !text(action.reason) ||
          !Array.isArray(action.availableActions) ||
          !action.availableActions.every((item) => typeof item === "string")) return schemaError();
      if (action.expiresAt !== undefined && action.expiresAt !== null && typeof action.expiresAt !== "string") return schemaError();
      return { ...action } as unknown as PendingMentionAction;
    });
  }
  return message;
}

function list(value: unknown, key: string): unknown[] {
  const rows = Array.isArray(value) ? value : object(value)?.[key];
  return Array.isArray(rows) ? rows : schemaError();
}

function pageQuery(options: MessagePageOptions): string {
  const params = new URLSearchParams();
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RaftClientError("INVALID_INPUT", "Message limit must be a positive integer.");
  }
  params.set("limit", String(limit));
  for (const key of ["before", "after"] as const) {
    const value = options[key];
    if (value === undefined) continue;
    if ((typeof value !== "string" && typeof value !== "number") ||
        !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
      throw new RaftClientError("INVALID_INPUT", "Message cursors must be nonnegative integer sequences.");
    }
    params.set(key, String(value));
  }
  return params.toString();
}

export class RaftClient {
  private generation = 0;
  private refreshing?: { session: Session; promise: Promise<Session> };

  constructor(
    private readonly transport: Transport,
    private readonly getSession: () => Session | null | undefined,
    private readonly setSession: (session: Session) => void | Promise<void>,
  ) {}

  async login(base: string, email: string, password: string, serverId: string): Promise<Session> {
    const apiUrl = normalizeApiUrl(base);
    requiredInput(email, "email");
    if (typeof password !== "string" || !password.length) {
      throw new RaftClientError("INVALID_INPUT", "A password is required.");
    }
    requiredInput(serverId, "server ID");
    const generation = ++this.generation;
    const payload = object(await this.request({
      url: `${apiUrl}/api/auth/login`, method: "POST",
      headers: { "Content-Type": "application/json", "X-Server-Id": serverId },
      body: { email, password },
    }));
    const user = object(payload?.user);
    const accessToken = text(payload?.accessToken);
    const refreshToken = text(payload?.refreshToken);
    const userId = identifier(user?.id, user?.userId);
    if (!accessToken || !refreshToken || !userId) return schemaError();
    const session: Session = {
      apiUrl, accessToken, refreshToken, userId, serverId,
      userName: text(user?.displayName, user?.name, user?.username) ?? userId,
    };
    if (generation !== this.generation) throw this.expired();
    try { await this.setSession(session); }
    catch { throw new RaftClientError("SESSION_ERROR", "Unable to save the Raft session."); }
    return session;
  }

  /**
   * Signs in by server name instead of server ID: the account's servers are listed after login and the one named
   * (or the only one) is chosen. The session is saved only once a server is settled.
   */
  async signIn(base: string, email: string, password: string, server: string): Promise<Session> {
    const apiUrl = normalizeApiUrl(base);
    requiredInput(email, "email");
    if (typeof password !== "string" || !password.length) throw new RaftClientError("INVALID_INPUT", "A password is required.");
    const ref = parseServerRef(server);
    const generation = ++this.generation;
    const payload = object(await this.request({
      url: `${apiUrl}/api/auth/login`, method: "POST",
      headers: { "Content-Type": "application/json", ...(ref.id ? { "X-Server-Id": ref.id } : {}) },
      body: { email, password },
    }));
    const user = object(payload?.user);
    const accessToken = text(payload?.accessToken);
    const refreshToken = text(payload?.refreshToken);
    const userId = identifier(user?.id, user?.userId);
    if (!accessToken || !refreshToken || !userId) return schemaError();
    const servers = list(await this.request({
      url: `${apiUrl}/api/servers`, method: "GET", headers: { Authorization: `Bearer ${accessToken}` },
    }), "servers").map(value => {
      const row = object(value);
      return { id: identifier(row?.id), slug: text(row?.slug), name: text(row?.name) };
    }).filter((row): row is { id: string; slug: string | undefined; name: string | undefined } => !!row.id);
    const chosen = ref.id ? servers.find(row => row.id === ref.id)
      : ref.slug ? servers.find(row => row.slug?.toLowerCase() === ref.slug)
      : servers.length === 1 ? servers[0] : undefined;
    if (!chosen) {
      const names = servers.map(row => row.slug ? `/${row.slug}` : row.name || row.id).join(", ");
      throw new RaftClientError("SERVER_CHOICE", ref.id || ref.slug
        ? `This account is not a member of ${server.trim()}. Available: ${names || "none"}.`
        : `Enter which server to use: ${names || "this account has no servers"}.`);
    }
    const session: Session = {
      apiUrl, accessToken, refreshToken, userId, serverId: chosen.id, ...(chosen.slug ? { serverSlug: chosen.slug } : {}),
      userName: text(user?.displayName, user?.name, user?.username) ?? userId,
    };
    if (generation !== this.generation) throw this.expired();
    try { await this.setSession(session); }
    catch { throw new RaftClientError("SESSION_ERROR", "Unable to save the Raft session."); }
    return session;
  }

  /** Concurrent 401s share the same rotating-token refresh request. */
  async refresh(): Promise<Session> {
    return this.refreshSession(this.session());
  }

  private refreshSession(session: Session): Promise<Session> {
    if (this.refreshing && this.sameSession(this.refreshing.session, session)) return this.refreshing.promise;
    const pending = { session, promise: this.rotateSession(session, this.generation) };
    this.refreshing = pending;
    void pending.promise.finally(() => {
      if (this.refreshing === pending) this.refreshing = undefined;
    }).catch(() => {});
    return pending.promise;
  }

  private async rotateSession(session: Session, generation: number): Promise<Session> {
    const payload = object(await this.request({
      url: `${normalizeApiUrl(session.apiUrl)}/api/auth/refresh`, method: "POST",
      headers: { "Content-Type": "application/json", "X-Server-Id": requiredInput(session.serverId, "server ID") },
      body: { refreshToken: requiredInput(session.refreshToken, "refresh token") },
    }));
    const accessToken = text(payload?.accessToken);
    const refreshToken = text(payload?.refreshToken);
    if (!accessToken || !refreshToken) return schemaError();
    if (generation !== this.generation || !this.sameSession(this.readSession(), session)) throw this.expired();
    const next = { ...session, accessToken, refreshToken };
    try { await this.setSession(next); }
    catch { throw new RaftClientError("SESSION_ERROR", "Unable to save the Raft session."); }
    return next;
  }

  async channels(): Promise<Channel[]> {
    return list(await this.authenticated("GET", "/api/channels"), "channels")
      .filter((value) => {
        const row = object(value);
        if (row?.joined !== undefined && typeof row.joined !== "boolean") return schemaError();
        return row?.joined !== false;
      }).map(normalizeChannel);
  }

  async agents(channelId: string): Promise<Agent[]> {
    const id = encodeURIComponent(requiredInput(channelId, "channel ID"));
    return list(await this.authenticated("GET", `/api/channels/${id}/members`), "agents").map(normalizeAgent);
  }

  /** Channel members for @mention suggestions: agents first, then humans. */
  async members(channelId: string): Promise<Member[]> {
    const id = encodeURIComponent(requiredInput(channelId, "channel ID"));
    const body = await this.authenticated("GET", `/api/channels/${id}/members`);
    const humans = object(body)?.humans;
    return [
      ...list(body, "agents").map(row => member(row, "agent")),
      ...(Array.isArray(humans) ? humans : []).map(row => member(row, "human")),
    ];
  }

  async messages(channelId: string, options: MessagePageOptions = {}): Promise<MessagePage> {
    const id = encodeURIComponent(requiredInput(channelId, "channel ID"));
    const query = pageQuery(options);
    return normalizePage(await this.authenticated("GET", `/api/messages/channel/${id}?${query}`), options.limit ?? 50);
  }

  async threadChannel(parentChannelId: string, rootId: string): Promise<string | null> {
    const channel = encodeURIComponent(requiredInput(parentChannelId, "channel ID"));
    const root = encodeURIComponent(requiredInput(rootId, "thread root ID"));
    try {
      const payload = object(await this.authenticated("GET", `/api/channels/${channel}/threads/${root}`));
      return identifier(payload?.threadChannelId) ?? schemaError();
    } catch (error) {
      if (error instanceof RaftClientError && error.status === 404) return null;
      throw error;
    }
  }

  /** Uploads a text file to Raft's attachment storage for the channel and returns its attachment ID. */
  async uploadText(channelId: string, filename: string, text: string, mimeType = "text/markdown"): Promise<string> {
    requiredInput(channelId, "channel ID");
    if (!text) throw new RaftClientError("INVALID_INPUT", "Raft does not accept empty files.");
    // Same shape as a browser FormData post: raw UTF-8 filename, channelId before the file.
    const boundary = `----raft-page-${globalThis.crypto.randomUUID()}`;
    const safeName = filename.replace(/["\r\n\\]/g, "_");
    const encoder = new TextEncoder();
    const head = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="channelId"\r\n\r\n${channelId}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${safeName}"\r\n` +
      `Content-Type: ${mimeType}; charset=utf-8\r\n\r\n`);
    const file = encoder.encode(text), tail = encoder.encode(`\r\n--${boundary}--\r\n`);
    const data = new Uint8Array(head.length + file.length + tail.length);
    data.set(head); data.set(file, head.length); data.set(tail, head.length + file.length);
    const payload = object(await this.authenticated("POST", "/api/attachments/upload",
      new RawBody(`multipart/form-data; boundary=${boundary}`, data.buffer)));
    const id = Array.isArray(payload?.attachments) ? object(payload.attachments[0])?.id : undefined;
    if (typeof id !== "string" || !id) return schemaError();
    return id;
  }

  /**
   * Posts a message. Raft has no reply-to field: a thread reply is an ordinary message in the thread's own channel,
   * which is created on first use. With `threadParentId`, the message goes to that thread.
   */
  async send(channelId: string, content: string, threadParentId?: string, attachmentIds?: string[]): Promise<Message> {
    requiredInput(channelId, "channel ID");
    if (typeof content !== "string" || !content.trim()) {
      throw new RaftClientError("INVALID_INPUT", "Message content is required.");
    }
    const target = threadParentId !== undefined ? await this.ensureThread(channelId, requiredInput(threadParentId, "thread parent ID")) : channelId;
    const body = {
      channelId: target, content, randomId: globalThis.crypto.randomUUID(),
      ...(attachmentIds?.length ? { attachmentIds } : {}),
    };
    const payload = await this.authenticated("POST", "/api/v2/messages", body);
    return normalizeSentMessage(payload);
  }

  /** The signed-in user's direct-message channel with an agent, opened if it does not exist yet. */
  async openDm(agentId: string): Promise<string> {
    const payload = object(await this.authenticated("POST", "/api/channels/dm", { agentId: requiredInput(agentId, "agent ID") }));
    return identifier(payload?.id, object(payload?.channel)?.id) ?? schemaError();
  }

  /** The thread channel of a message, created if the message has no thread yet. */
  async ensureThread(parentChannelId: string, rootId: string): Promise<string> {
    const existing = await this.threadChannel(parentChannelId, rootId);
    if (existing) return existing;
    const channel = encodeURIComponent(requiredInput(parentChannelId, "channel ID"));
    const payload = object(await this.authenticated("POST", `/api/channels/${channel}/threads`, { parentMessageId: rootId }));
    return identifier(payload?.threadChannelId) ?? schemaError();
  }

  private readSession(): Session | null | undefined {
    try { return this.getSession(); }
    catch { throw new RaftClientError("SESSION_ERROR", "Unable to read the Raft session."); }
  }

  private session(): Session {
    const session = this.readSession();
    if (!session || !text(session.accessToken)) {
      throw new RaftClientError("NO_SESSION", "Sign in to Raft first.");
    }
    return { ...session };
  }

  private sameSession(a: Session | null | undefined, b: Session): boolean {
    return !!a && a.apiUrl === b.apiUrl && a.serverId === b.serverId && a.userId === b.userId &&
      a.accessToken === b.accessToken && a.refreshToken === b.refreshToken;
  }

  private expired(): RaftClientError {
    return new RaftClientError("AUTH_EXPIRED", "Raft authentication failed or expired. Sign in again.", 401);
  }

  /** Short-lived URLs for showing image attachments inline, as Raft web does. */
  async attachmentUrls(ids: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const attachmentIds = ids.filter(id => typeof id === "string" && id);
    if (!attachmentIds.length) return result;
    const body = object(await this.authenticated("POST", "/api/attachments/urls", { attachmentIds }));
    const urls = Array.isArray(body?.urls) ? body.urls : [];
    for (const value of urls) {
      const row = object(value);
      if (typeof row?.id === "string" && typeof row.url === "string" && row.url) result.set(row.id, row.url);
    }
    return result;
  }

  private async authenticated(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const session = this.session();
    const generation = this.generation;
    try { return await this.authRequest(session, method, path, body); }
    catch (error) {
      if (!(error instanceof RaftClientError) || error.status !== 401) throw error;
      if (generation !== this.generation) throw this.expired();
      const current = this.readSession();
      let next: Session;
      if (this.sameSession(current, session)) next = await this.refreshSession(session);
      else {
        // A concurrent request may already have completed a refresh. Only reuse
        // its token when it still belongs to the same account and installation.
        if (!current || current.userId !== session.userId || current.apiUrl !== session.apiUrl ||
            current.serverId !== session.serverId) throw this.expired();
        next = { ...current };
      }
      if (generation !== this.generation || !this.sameSession(this.readSession(), next)) throw this.expired();
      return this.authRequest(next, method, path, body);
    }
  }

  private authRequest(session: Session, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    requiredInput(session.accessToken, "access token");
    const serverId = requiredInput(session.serverId, "server ID");
    const raw = body instanceof RawBody ? body : undefined;
    return this.request({
      url: `${normalizeApiUrl(session.apiUrl)}${path}`, method,
      headers: {
        Authorization: `Bearer ${session.accessToken}`, "X-Server-Id": serverId,
        ...(raw ? { "Content-Type": raw.contentType } : body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(raw ? { rawBody: raw.data } : body !== undefined ? { body } : {}),
    });
  }

  private async request(request: TransportRequest): Promise<unknown> {
    let response: TransportResponse;
    try { response = await this.transport(request); }
    catch { throw new RaftClientError("NETWORK_ERROR", "Unable to reach the Raft server."); }
    if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
      return schemaError();
    }
    if (response.status === 401) {
      throw new RaftClientError("AUTH_EXPIRED", "Raft authentication failed or expired. Sign in again.", 401);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new RaftClientError("HTTP_ERROR", `Raft request failed (HTTP ${response.status}).`, response.status);
    }
    const envelope = object(response.json);
    if (envelope && (envelope.success === false || envelope.error != null)) return schemaError();
    return response.json;
  }
}
