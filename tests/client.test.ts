import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RaftClient, RaftClientError, normalizeApiUrl,
  type Session, type TransportRequest, type TransportResponse,
} from "../src/client";

const existingSession: Session = {
  apiUrl: "http://192.168.1.20:4000", accessToken: "access-secret",
  refreshToken: "refresh-secret", userId: "user-1", userName: "Alice", serverId: "server-1",
};

function harness(responses: TransportResponse[], initial: Session | null = existingSession) {
  let session: Session | null = initial ? { ...initial } : null;
  const requests: TransportRequest[] = [];
  const saved: Session[] = [];
  const client = new RaftClient(async (request) => {
    requests.push(request);
    const response = responses.shift();
    assert.ok(response, "Unexpected transport call");
    return response;
  }, () => session, (next) => { session = next; saved.push(next); });
  return { client, requests, saved, session: () => session };
}

function errorCode(code: string, status?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof RaftClientError);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  };
}

test("login uses the actual human login contract and only saves a validated session", async () => {
  const h = harness([{ status: 200, json: {
    user: { id: "u1", name: "alice", displayName: "Alice" },
    accessToken: "new-access", refreshToken: "new-refresh",
  } }], null);
  const result = await h.client.login("https://raft.example/base/", "alice@example.com", "password-secret", "srv");
  assert.deepEqual(result, {
    apiUrl: "https://raft.example/base", userId: "u1", userName: "Alice",
    accessToken: "new-access", refreshToken: "new-refresh", serverId: "srv",
  });
  assert.deepEqual(h.saved, [result]);
  assert.deepEqual(h.requests, [{
    url: "https://raft.example/base/api/auth/login", method: "POST",
    headers: { "Content-Type": "application/json", "X-Server-Id": "srv" },
    body: { email: "alice@example.com", password: "password-secret" },
  }]);
});

test("invalid login payload never replaces the existing session", async () => {
  for (const json of [null, {}, { user: { id: "u1" }, accessToken: "token" },
    { user: {}, accessToken: "token", refreshToken: "refresh" }]) {
    const h = harness([{ status: 200, json }]);
    await assert.rejects(h.client.login("http://localhost:3000", "alice", "password", "server"), errorCode("INVALID_RESPONSE"));
    assert.deepEqual(h.session(), existingSession);
    assert.equal(h.saved.length, 0);
  }
});

test("URLs allow HTTP LAN/localhost, HTTPS, ports and base paths", () => {
  assert.equal(normalizeApiUrl("http://localhost:3000/"), "http://localhost:3000");
  assert.equal(normalizeApiUrl("http://[::1]:3000/raft/"), "http://[::1]:3000/raft");
  assert.equal(normalizeApiUrl("http://192.168.10.2:5000"), "http://192.168.10.2:5000");
  assert.equal(normalizeApiUrl("https://raft.example/"), "https://raft.example");
});

test("unsafe URLs are rejected without sending credentials or reflecting the URL", async () => {
  for (const base of ["file:///tmp/secret", "javascript:alert(1)", "ftp://raft.example", "/relative",
    "https://name:password-secret@raft.example", "https://@raft.example", "http:raft.example", "https:///raft.example?token=access-secret", "https://raft.example?token=access-secret",
    "https://raft.example#access-secret", "https://raft.example?", "https://raft.example#",
    " https://raft.example", "https://raft.example\\other", "https://raft.example\n"]) {
    const h = harness([]);
    await assert.rejects(h.client.login(base, "email-secret", "password-secret", "server"), (error: unknown) => {
      assert.ok(error instanceof RaftClientError);
      assert.equal(error.code, "INVALID_URL");
      assert.doesNotMatch(error.message, /password-secret|access-secret|email-secret/);
      return true;
    });
    assert.equal(h.requests.length, 0);
  }
});

test("channels accepts the actual array or channels envelope, including a real empty list", async () => {
  const h = harness([
    { status: 200, json: [{ id: "c1", name: "general" }] },
    { status: 200, json: { channels: [{ id: "c2", name: "support" }] } },
    { status: 200, json: [] },
  ]);
  assert.deepEqual(await h.client.channels(), [{ id: "c1", name: "general" }]);
  assert.deepEqual(await h.client.channels(), [{ id: "c2", name: "support" }]);
  assert.deepEqual(await h.client.channels(), []);
  assert.deepEqual(h.requests[0], {
    url: `${existingSession.apiUrl}/api/channels`, method: "GET",
    headers: { Authorization: "Bearer access-secret", "X-Server-Id": "server-1" },
  });
});

test("channels excludes visible public channels the human has not joined", async () => {
  const h = harness([{ status: 200, json: [
    { id: "joined", name: "joined", joined: true },
    { id: "public", name: "public", joined: false },
  ] }]);
  assert.deepEqual(await h.client.channels(), [{ id: "joined", name: "joined" }]);
});

test("missing and malformed channel lists fail instead of becoming empty success", async () => {
  for (const json of [undefined, null, {}, { channels: null }, { channels: {} },
    [{ id: "c1" }], [{ name: "general" }], { success: false, channels: [] },
    { error: "server-secret", channels: [] }]) {
    const h = harness([{ status: 200, json }]);
    await assert.rejects(h.client.channels(), errorCode("INVALID_RESPONSE"));
  }
});

test("agents normalizes names and encodes the channel ID as a single path segment", async () => {
  const h = harness([{ status: 200, json: { agents: [
    { id: "a1", name: "reviewer", displayName: "Reviewer" },
    { id: "a2", name: "helper" }, { id: "a3", displayName: "Guest" },
  ], humans: [] } }]);
  assert.deepEqual(await h.client.agents("channel/with ?"), [
    { id: "a1", name: "reviewer", displayName: "Reviewer" },
    { id: "a2", name: "helper", displayName: "helper" }, { id: "a3", name: "Guest", displayName: "Guest" },
  ]);
  assert.equal(h.requests[0].url, `${existingSession.apiUrl}/api/channels/channel%2Fwith%20%3F/members`);
});

test("members lists agents then humans for mention suggestions", async () => {
  const h = harness([{ status: 200, json: { agents: [{ id: "a1", name: "writer", displayName: "Writer" }],
    humans: [{ id: "u1", name: "paperhs", displayName: "Bosco" }] } }]);
  assert.deepEqual(await h.client.members("c1"), [
    { id: "a1", name: "writer", displayName: "Writer", kind: "agent" },
    { id: "u1", name: "paperhs", displayName: "Bosco", kind: "human" },
  ]);
});

test("messages forwards paging cursors, defaults to 50, and preserves order and metadata", async () => {
  const raw = { id: "m1", seq: 0, content: "hello", senderId: "u1", senderDisplayName: "Alice",
    createdAt: "2026-11-04T12:00:00Z", attachments: [{ id: "file1" }] };
  const h = harness([
    { status: 200, json: { messages: [raw] } },
    { status: 200, json: { messages: [] } },
  ]);
  assert.deepEqual(await h.client.messages("c1", { before: "123", after: 0, limit: 25 }), { messages: [{
    id: "m1", seq: 0, content: "hello", senderName: "Alice", senderId: "u1",
    createdAt: raw.createdAt, attachments: raw.attachments, raw,
  }], hasMore: false });
  assert.equal(h.requests[0].url, `${existingSession.apiUrl}/api/messages/channel/c1?limit=25&before=123&after=0`);
  assert.deepEqual(await h.client.messages("c1"), { messages: [], hasMore: false });
  assert.equal(h.requests[1].url, `${existingSession.apiUrl}/api/messages/channel/c1?limit=50`);
});

test("messages accepts sender and author variants without inventing IDs or sequences", async () => {
  const rows = [
    { id: "m1", content: "", sender: { id: "a1", name: "bot", displayName: "Bot" } },
    { id: "m2", content: "two", author: { id: "u2", name: "Alice" } },
    { id: "m3", content: "three", senderName: "Named" },
    { messageId: "m4", content: "four", author: "Author string" },
    { id: "m5", content: "five" },
    { id: "m6", content: "six", senderId: "u6" },
  ];
  const h = harness([{ status: 200, json: { messages: rows } }]);
  const { messages } = await h.client.messages("c1");
  assert.deepEqual(messages.map((m) => m.senderName), ["Bot", "Alice", "Named", "Author string", "Unknown", "u6"]);
  assert.equal(messages[0].senderId, "a1");
  assert.equal(messages[1].senderId, "u2");
  assert.equal(messages[2].senderId, undefined);
  assert.equal(messages[0].seq, undefined);
  assert.equal(messages[0].content, "");
});

test("history rejects messages lacking stable IDs and invalid optional metadata", async () => {
  for (const row of [{ content: "no id" }, { id: "", content: "no id" }, { id: "m1" },
    { id: "m1", content: 123 }, { id: "m1", content: "a", seq: "1" },
    { id: "m1", content: "a", attachments: {} }]) {
    const h = harness([{ status: 200, json: { messages: [row] } }]);
    await assert.rejects(h.client.messages("c1"), errorCode("INVALID_RESPONSE"));
  }
});

test("send posts channel messages, and thread replies into the thread's own channel (created on first use)", async () => {
  const h = harness([
    { status: 201, json: { id: "m1", seq: 1, content: "hello", senderName: "Alice" } },
    { status: 404, json: { error: "not found" } },
    { status: 201, json: { threadChannelId: "t1" } },
    { status: 200, json: { message: { id: "m2", content: "reply", senderName: "Alice" } } },
    { status: 200, json: { threadChannelId: "t1" } },
    { status: 200, json: { message: { id: "m3", content: "again", senderName: "Alice" } } },
  ]);
  assert.equal((await h.client.send("c1", "hello")).id, "m1");
  assert.equal((await h.client.send("c1", "reply", "m1")).id, "m2");
  assert.equal((await h.client.send("c1", "again", "m1")).id, "m3");
  const first = h.requests[0];
  assert.equal(first.url, `${existingSession.apiUrl}/api/v2/messages`);
  assert.equal(first.method, "POST");
  assert.equal(first.headers["Content-Type"], "application/json");
  const body = first.body as Record<string, unknown>;
  assert.equal(body.channelId, "c1");
  assert.equal(body.content, "hello");
  assert.match(body.randomId as string, /^[0-9a-f-]{36}$/);
  assert.deepEqual(h.requests.slice(1).map(r => [r.method, r.url.replace(existingSession.apiUrl, "")]), [
    ["GET", "/api/channels/c1/threads/m1"], ["POST", "/api/channels/c1/threads"], ["POST", "/api/v2/messages"],
    ["GET", "/api/channels/c1/threads/m1"], ["POST", "/api/v2/messages"]]);
  assert.deepEqual(h.requests[2].body, { parentMessageId: "m1" });
  const replyBody = h.requests[3].body as Record<string, unknown>;
  assert.equal(replyBody.channelId, "t1");
  assert.equal("threadParentId" in replyBody, false, "Raft has no reply-to field; it would be ignored");
  assert.notEqual(body.randomId, replyBody.randomId);
});

test("an empty or success-only send response never fabricates an acknowledged message", async () => {
  for (const json of [undefined, null, {}, { success: true }, { id: "id-only" }]) {
    const h = harness([{ status: 200, json }]);
    await assert.rejects(h.client.send("c1", "hello"), errorCode("INVALID_RESPONSE"));
  }
});

test("uploadText posts the same multipart shape as Raft web and sends attachment IDs", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const h = harness([
    { status: 200, json: { attachments: [{ id, filename: "笔记.md" }] } },
    { status: 200, json: { id: "m1", content: "hi", senderName: "Alice" } },
  ]);
  assert.equal(await h.client.uploadText("c1", "笔记.md", "# 内容"), id);
  const upload = h.requests[0];
  assert.equal(upload.url, `${existingSession.apiUrl}/api/attachments/upload`);
  assert.match(upload.headers["Content-Type"], /^multipart\/form-data; boundary=----raft-page-/);
  assert.equal(upload.body, undefined);
  const text = new TextDecoder().decode(upload.rawBody);
  assert.ok(text.indexOf('name="channelId"\r\n\r\nc1\r\n') < text.indexOf('name="files"; filename="笔记.md"'));
  assert.match(text, /Content-Type: text\/markdown; charset=utf-8\r\n\r\n# 内容\r\n--/);
  await h.client.send("c1", "hi", undefined, [id]);
  assert.deepEqual((h.requests[1].body as Record<string, unknown>).attachmentIds, [id]);
  await assert.rejects(h.client.uploadText("c1", "a.md", ""), errorCode("INVALID_INPUT"));
});

test("uploadFile sends binary bytes unchanged with their own content type", async () => {
  const id = "00000000-0000-4000-8000-000000000002";
  const h = harness([{ status: 200, json: { attachments: [{ id }] } }]);
  const bytes = new Uint8Array([0, 255, 137, 80, 78, 71, 13, 10]);
  assert.equal(await h.client.uploadFile("c1", "shot.png", bytes.buffer, "image/png"), id);
  const raw = new Uint8Array(h.requests[0].rawBody!);
  const text = new TextDecoder("latin1").decode(raw);
  assert.match(text, /filename="shot.png"\r\nContent-Type: image\/png\r\n\r\n/);
  const start = text.indexOf("image/png\r\n\r\n") + "image/png\r\n\r\n".length;
  assert.deepEqual([...raw.slice(start, start + bytes.length)], [...bytes]);
  await assert.rejects(h.client.uploadFile("c1", "e.png", new ArrayBuffer(0)), errorCode("INVALID_INPUT"));
});

test("refresh failure is explicit, attempted once, and preserves the session", async () => {
  const h = harness([
    { status: 401, json: { error: "access-secret" } },
    { status: 401, json: { error: "refresh-secret" } },
  ]);
  await assert.rejects(h.client.channels(), errorCode("AUTH_EXPIRED", 401));
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].url, `${existingSession.apiUrl}/api/auth/refresh`);
  assert.equal(h.saved.length, 0);
  assert.deepEqual(h.session(), existingSession);
});

test("each authenticated request reads the caller's current session", async () => {
  let session = { ...existingSession };
  const requests: TransportRequest[] = [];
  const client = new RaftClient(async (request) => {
    requests.push(request);
    return { status: 200, json: [] };
  }, () => session, () => {});
  await client.channels();
  session = { ...session, accessToken: "rotated-token", serverId: "server-2" };
  await client.channels();
  assert.equal(requests[1].headers.Authorization, "Bearer rotated-token");
  assert.equal(requests[1].headers["X-Server-Id"], "server-2");
});

test("missing session stops before the transport", async () => {
  const h = harness([], null);
  await assert.rejects(h.client.channels(), errorCode("NO_SESSION"));
  assert.equal(h.requests.length, 0);
});

test("HTTP and transport errors cannot expose credentials or server response text", async () => {
  const h = harness([{ status: 500, json: { error: "password-secret access-secret" } }]);
  await assert.rejects(h.client.channels(), (error: unknown) => {
    assert.ok(error instanceof RaftClientError);
    assert.equal(error.code, "HTTP_ERROR");
    assert.doesNotMatch(String(error), /password-secret|access-secret/);
    return true;
  });
  const client = new RaftClient(async () => { throw new Error("password-secret access-secret"); }, () => existingSession, () => {});
  await assert.rejects(client.login("https://raft.example", "email-secret", "password-secret", "server"), (error: unknown) => {
    assert.ok(error instanceof RaftClientError);
    assert.equal(error.code, "NETWORK_ERROR");
    assert.doesNotMatch(String(error), /password-secret|access-secret|email-secret/);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("invalid message inputs and pagination stop before the transport", async () => {
  const h = harness([]);
  await assert.rejects(h.client.send("", "hello"), errorCode("INVALID_INPUT"));
  await assert.rejects(h.client.send("c1", "  "), errorCode("INVALID_INPUT"));
  await assert.rejects(h.client.send("c1", "hello", ""), errorCode("INVALID_INPUT"));
  for (const limit of [0, -1, 1.2, NaN, Infinity]) {
    await assert.rejects(h.client.messages("c1", { limit }), errorCode("INVALID_INPUT"));
  }
  await assert.rejects(h.client.messages("c1", { before: "" }), errorCode("INVALID_INPUT"));
  await assert.rejects(h.client.messages("c1", { after: -1 }), errorCode("INVALID_INPUT"));
  assert.equal(h.requests.length, 0);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("concurrent 401s share a single rotating refresh and retry with the new token", async () => {
  let session = { ...existingSession };
  const requests: TransportRequest[] = [];
  const started = deferred<void>();
  const refresh = deferred<TransportResponse>();
  const client = new RaftClient(async (request) => {
    requests.push(request);
    if (request.url.endsWith("/api/auth/refresh")) {
      started.resolve();
      return refresh.promise;
    }
    return request.headers.Authorization === "Bearer access-secret"
      ? { status: 401, json: {} } : { status: 200, json: [] };
  }, () => session, (next) => { session = next; });
  const first = client.channels();
  const second = client.channels();
  await started.promise;
  refresh.resolve({ status: 200, json: { accessToken: "rotated-access", refreshToken: "rotated-refresh" } });
  assert.deepEqual(await Promise.all([first, second]), [[], []]);
  assert.equal(requests.filter((request) => request.url.endsWith("/api/auth/refresh")).length, 1);
  assert.deepEqual(requests.find((request) => request.url.endsWith("/api/auth/refresh"))?.body,
    { refreshToken: "refresh-secret" });
  assert.equal(session.accessToken, "rotated-access");
  assert.equal(session.refreshToken, "rotated-refresh");
  assert.equal(requests.filter((request) => request.headers.Authorization === "Bearer rotated-access").length, 2);
});

test("refresh cannot restore a logged-out or switched account", async () => {
  for (const replacement of [null, { ...existingSession, userId: "other-user", accessToken: "other-token" }]) {
    let session: Session | null = { ...existingSession };
    const refresh = deferred<TransportResponse>();
    let saves = 0;
    const client = new RaftClient(async () => refresh.promise, () => session, (next) => {
      saves++;
      session = next;
    });
    const pending = client.refresh();
    session = replacement;
    refresh.resolve({ status: 200, json: { accessToken: "stale-access", refreshToken: "stale-refresh" } });
    await assert.rejects(pending, errorCode("AUTH_EXPIRED"));
    assert.equal(saves, 0);
    assert.equal(session, replacement);
  }
});

test("401 after successful refresh fails without another refresh loop", async () => {
  const h = harness([
    { status: 401, json: {} },
    { status: 200, json: { accessToken: "new-access", refreshToken: "new-refresh" } },
    { status: 401, json: {} },
  ]);
  await assert.rejects(h.client.channels(), errorCode("AUTH_EXPIRED"));
  assert.equal(h.requests.length, 3);
  assert.equal(h.saved.length, 1);
});

test("send retries reuse the random ID and surface delivery and mention warnings", async () => {
  const warning = { targetType: "agent", targetId: "agent-1", reason: "agent_stopped" };
  const action = { resolutionId: "resolution-1", messageId: "m1", targetType: "agent",
    targetHandle: "helper", reason: "not_joined", availableActions: ["add", "notify"] };
  const h = harness([
    { status: 401, json: {} },
    { status: 200, json: { accessToken: "new-access", refreshToken: "new-refresh" } },
    { status: 200, json: { message: { id: "m1", content: "@helper hello", senderName: "Alice" },
      pendingMentionActions: [action], unresolvedMentionHandles: ["missing"], deliveryWarnings: [warning] } },
  ]);
  const result = await h.client.send("c1", "@helper hello");
  assert.deepEqual(h.requests[0].body, h.requests[2].body);
  assert.deepEqual(result.pendingMentionActions, [action]);
  assert.deepEqual(result.unresolvedMentionHandles, ["missing"]);
  assert.deepEqual(result.deliveryWarnings, [warning]);
});

test("history keeps history restrictions separate from inferred paging and preserves threads", async () => {
  const h = harness([{ status: 200, json: {
    messages: [{ id: "root", channelId: "c1", senderType: "agent", content: "root", threadId: "thread-1" }],
    historyLimited: true, threadSummariesByParentMessageId: { root: { replyCount: 3, lastReplyAt: "2026-11-04" } },
  } }]);
  const page = await h.client.messages("c1", { limit: 1 });
  assert.equal(page.hasMore, true);
  assert.equal(page.historyLimited, true);
  assert.equal(page.messages[0].threadId, "thread-1");
  assert.equal(page.messages[0].replyCount, 3);
  assert.equal(page.messages[0].channelId, "c1");
  assert.equal(page.messages[0].senderType, "agent");
  assert.equal(page.threadSummariesByParentMessageId?.root.lastReplyAt, "2026-11-04");
});

test("thread channel lookup returns a confirmed channel or null only on 404", async () => {
  const h = harness([
    { status: 200, json: { threadChannelId: "thread-1" } },
    { status: 404, json: {} }, { status: 403, json: {} }, { status: 200, json: {} },
  ]);
  assert.equal(await h.client.threadChannel("c1", "root/1"), "thread-1");
  assert.equal(h.requests[0].url, `${existingSession.apiUrl}/api/channels/c1/threads/root%2F1`);
  assert.equal(await h.client.threadChannel("c1", "root"), null);
  await assert.rejects(h.client.threadChannel("c1", "root"), errorCode("HTTP_ERROR", 403));
  await assert.rejects(h.client.threadChannel("c1", "root"), errorCode("INVALID_RESPONSE"));
});

test("agents lacking identity cannot be used for authorization", async () => {
  const h = harness([{ status: 200, json: { agents: [{ name: "untrusted" }] } }]);
  await assert.rejects(h.client.agents("c1"), errorCode("INVALID_RESPONSE"));
});

test("session callback errors are sanitized", async () => {
  const readClient = new RaftClient(async () => ({ status: 200, json: [] }),
    () => { throw new Error("access-secret"); }, () => {});
  await assert.rejects(readClient.channels(), errorCode("SESSION_ERROR"));
  const saveClient = new RaftClient(async () => ({ status: 200, json: {
    user: { id: "u1" }, accessToken: "access-secret", refreshToken: "refresh-secret",
  } }), () => null, () => { throw new Error("refresh-secret"); });
  await assert.rejects(saveClient.login("https://raft.example", "alice", "password", "server"), (error: unknown) => {
    assert.ok(error instanceof RaftClientError);
    assert.equal(error.code, "SESSION_ERROR");
    assert.doesNotMatch(String(error), /access-secret|refresh-secret/);
    return true;
  });
});

test("sign in picks the server by its short name, or the only server, and never needs a server ID", async () => {
  const login = { status: 200, json: { user: { id: "u1", name: "alice" }, accessToken: "a", refreshToken: "r" } };
  const servers = (rows: unknown[]) => ({ status: 200, json: rows });
  for (const typed of ["myserver", "/myserver", "/s/myserver/channels/general", "http://raft.example/s/Myserver"]) {
    const h = harness([login, servers([{ id: "s-other", slug: "other" }, { id: "s-om", slug: "myserver" }])], null);
    const session = await h.client.signIn("https://raft.example", "alice", "pw", typed);
    assert.equal(session.serverId, "s-om");
    assert.equal(session.serverSlug, "myserver");
    assert.deepEqual(h.requests[0].headers, { "Content-Type": "application/json" });
    assert.deepEqual(h.requests[1], { url: "https://raft.example/api/servers", method: "GET", headers: { Authorization: "Bearer a" } });
  }
  const only = harness([login, servers([{ id: "s-om", slug: "myserver" }])], null);
  assert.equal((await only.client.signIn("https://raft.example", "alice", "pw", "")).serverId, "s-om");

  const many = harness([login, servers([{ id: "s1", slug: "one" }, { id: "s2", slug: "two" }])], null);
  await assert.rejects(many.client.signIn("https://raft.example", "alice", "pw", " "), (error: unknown) =>
    error instanceof RaftClientError && error.code === "SERVER_CHOICE" && error.message.includes("/one, /two"));
  assert.deepEqual(many.saved, [], "no session is saved until a server is chosen");

  const missing = harness([login, servers([{ id: "s1", slug: "one" }])], null);
  await assert.rejects(missing.client.signIn("https://raft.example", "alice", "pw", "/nope"), errorCode("SERVER_CHOICE"));

  const byId = harness([login, servers([{ id: "00000000-1111-4222-8333-444444444444", slug: "x" }])], null);
  await byId.client.signIn("https://raft.example", "alice", "pw", "00000000-1111-4222-8333-444444444444");
  assert.equal(byId.requests[0].headers["X-Server-Id"], "00000000-1111-4222-8333-444444444444");
});

test("servers lists the account's servers with the current server header, and revoke posts the refresh token", async () => {
  const h = harness([{ status: 200, json: [{ id: "s1", slug: "one", name: "One" }, { id: "s2" }, { slug: "no-id" }] }, { status: 200, json: { ok: true } }]);
  assert.deepEqual(await h.client.servers(), [{ id: "s1", slug: "one", name: "One" }, { id: "s2" }]);
  assert.equal(h.requests[0].url, "http://192.168.1.20:4000/api/servers");
  assert.equal(h.requests[0].headers["X-Server-Id"], "server-1");
  await h.client.revoke(existingSession);
  assert.deepEqual(h.requests[1], {
    url: "http://192.168.1.20:4000/api/auth/logout", method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer access-secret" },
    body: { refreshToken: "refresh-secret" },
  });
  const offline = new RaftClient(async () => { throw new Error("offline"); }, () => existingSession, () => {});
  await offline.revoke(existingSession);
});

test("sign in keeps the server's display name", async () => {
  const h = harness([{ status: 200, json: { user: { id: "u1" }, accessToken: "a", refreshToken: "r" } },
    { status: 200, json: [{ id: "s1", slug: "one", name: "Team One" }] }], null);
  assert.equal((await h.client.signIn("https://raft.example", "alice", "pw", "")).serverName, "Team One");
});

test("a new channel is created with the chosen agents and visibility, and agents are listed server-wide", async () => {
  const h = harness([
    { status: 200, json: [{ id: "a1", name: "holiday", displayName: "Holiday" }] },
    { status: 201, json: { id: "c9", name: "trip-plan", visibility: "private" } },
  ]);
  assert.deepEqual(await h.client.serverAgents(), [{ id: "a1", name: "holiday", displayName: "Holiday" }]);
  assert.deepEqual(await h.client.createChannel("#trip-plan", { private: true, agentIds: ["a1"], description: "note" }), { id: "c9", name: "trip-plan" });
  assert.equal(h.requests[0].method, "GET");
  assert.match(h.requests[0].url, /\/api\/agents$/);
  assert.equal(h.requests[1].method, "POST");
  assert.match(h.requests[1].url, /\/api\/channels$/);
  assert.deepEqual(h.requests[1].body, { name: "trip-plan", description: "note", visibility: "private", agentIds: ["a1"], userIds: [] });
});

test("an agent is added to an existing channel the way the web app does it", async () => {
  const h = harness([{ status: 200, json: { ok: true } }]);
  await h.client.addAgent("c9", "a1");
  assert.equal(h.requests[0].method, "POST");
  assert.match(h.requests[0].url, /\/api\/channels\/c9\/members$/);
  assert.deepEqual(h.requests[0].body, { agentId: "a1" });
});
