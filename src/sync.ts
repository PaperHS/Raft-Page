/**
 * Automatic document sync. When a bound channel goes quiet, the plugin asks the binding's steward agent to read the
 * new conversation and update the notes if anything in it belongs there. Requests and the steward's replies live in
 * one thread per binding; each request ends with a `raft-sync` block so any device can see how far syncing got.
 */
import type { Message, ThreadSummary } from './client';

export const QUIET_MS = 2 * 60_000;
const SYNC_BLOCK = /^```raft-sync\s*\r?\n([\s\S]*?)^```\s*$/m;
const NEED_BLOCK = /^```raft-need\s*\r?\n([\s\S]*?)^```\s*$/gm;
export const BIND_NOTICE = '📁 This channel is now bound to the Obsidian';
/** Opens the plugin's answer to a steward's edits; like sync requests, it is not conversation to record. */
export const EDIT_RECEIPT = '🧾 Edit receipt';

/** Bumped when the brief changes, so bindings start a fresh sync thread that carries the new one. */
export const BRIEF_VERSION = 7;

/**
 * The steward's instructions. They open the sync thread, and Raft shows a thread's first message with every reply it
 * delivers, so the agent needs no setup and never sees them outside this thread.
 */
export function syncRootMessage(binding: string, steward: string, channel: string): string {
  return [
    `📝 Document sync for \`${binding}\` (#${channel}) · steward @${steward}`,
    `@${steward}: keep these notes in step with what #${channel} decides. For each request, read the listed messages and record only decisions, changed requirements, corrections and to-dos (📌 = must record, 🚫 = never). Nothing to record → do not reply. Otherwise reply with one summary line and, per note, one code block fenced as \`\`\`raft-edit (not json) holding one valid JSON object. Need a note's text → \`\`\`raft-need block \`{"paths":[…]}\`. Reads and edits work here and in #${channel} or its threads; read replies stay in a thread. Paths are vault-relative (\`${binding}/…\`), never local filesystem paths.`,
    `Edit formats: change part of a note \`{"path","baseHash","ops":[…]}\` with ops \`{"op":"append","content","heading"?}\`, \`{"op":"replace_section","heading","content"}\` or \`{"op":"replace","find","with"}\` (find copied exactly from the note, matching one place); rewrite a whole note \`{"path","baseHash","content"}\`; an empty (0-byte) note is written the same way, with its listed hash and the full text as content; a note that does not exist yet \`{"path","create":true,"content"}\` with no baseHash. baseHash is the sha256 the plugin listed for that note — copy it, never compute or guess it; missing or stale → ask with raft-need first. Inside JSON strings write line breaks as \\n and quotes as \\". The plugin answers every edit: ✅ with the note's new sha256 (use it as the next baseHash), or a reason it was not saved — fix that block and send it again. Never report a note as recorded before its ✅.`,
    `Writing (vault _templates/文档规范.md): keep the YAML properties and set \`updated\` to today; fix the paragraph that is wrong instead of appending corrections; give facts a source link and mark unchecked ones 未核实; say who decided, with the message link; add one line per change under 变更记录. A new note starts with properties type (项目/调研/决策/现状/内容稿/知识), status, owner, tags [doc/<type>, …] and summary.`,
  ].join('\n');
}

export interface SyncMarker { binding: string; through: string }

export function parseSyncMarker(content: string): SyncMarker | null {
  const match = SYNC_BLOCK.exec(content);
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]);
    return typeof data.binding === 'string' && typeof data.through === 'string' && !Number.isNaN(Date.parse(data.through)) ? data : null;
  } catch { return null; }
}

/** The latest point a request for this binding covered, from any device. */
export function lastSyncedThrough(messages: Message[], binding: string): number {
  let latest = 0;
  for (const message of messages) {
    const marker = parseSyncMarker(message.content);
    if (marker?.binding === binding) latest = Math.max(latest, Date.parse(marker.through));
  }
  return latest;
}

/** Sync thread openers and requests (also ones older versions posted in the channel) are not conversation. */
export function isSyncMessage(content: string): boolean {
  return content.startsWith('📝 Document sync for') || content.startsWith(EDIT_RECEIPT) || SYNC_BLOCK.test(content);
}

/** Paths the steward asked for with a `raft-need` block. */
export function parseNeeds(content: string): string[] {
  const paths: string[] = [];
  for (const match of content.matchAll(NEED_BLOCK)) {
    try {
      const data = JSON.parse(match[1]);
      if (Array.isArray(data.paths)) paths.push(...data.paths.filter((p: unknown): p is string => typeof p === 'string'));
    } catch { /* Not a request. */ }
  }
  return paths.slice(0, 20);
}

export interface Activity {
  latest: number;
  messages: Message[];
  threads: string[];
  pinned: string[];
  excluded: string[];
}

const time = (value?: string) => { const t = Date.parse(value || ''); return Number.isFinite(t) ? t : 0; };

/** Who reacted with what, from Raft's reaction rows on a message. */
function reactions(message: Message): string[] {
  const raw = (message.raw && typeof message.raw === 'object' ? (message.raw as { reactions?: unknown }).reactions : undefined);
  return Array.isArray(raw) ? raw.map(r => (r as { emoji?: unknown })?.emoji).filter((e): e is string => typeof e === 'string') : [];
}

/**
 * New conversation in a bound channel after `since`: top-level messages, and threads with new replies. The sync
 * thread itself, the steward's own messages, and binding notices do not count as conversation.
 */
export function newActivity(messages: Message[], summaries: Record<string, ThreadSummary> | undefined, since: number,
  skip: { rootId?: string; stewardId?: string }): Activity {
  const result: Activity = { latest: 0, messages: [], threads: [], pinned: [], excluded: [] };
  for (const message of messages) {
    if (message.id === skip.rootId || isSyncMessage(message.content)) continue;
    const marks = reactions(message);
    if (marks.includes('🚫')) { if (time(message.createdAt) > since) result.excluded.push(message.id); continue; }
    if (marks.includes('📌') && time(message.createdAt) > since) result.pinned.push(message.id);
    const counts = message.senderId !== skip.stewardId && !message.content.startsWith(BIND_NOTICE);
    if (counts && time(message.createdAt) > since) {
      result.messages.push(message);
      result.latest = Math.max(result.latest, time(message.createdAt));
    }
    const summary = summaries?.[message.id] ?? message.threadSummary;
    const replied = time(summary?.lastReplyAt);
    const byOthers = summary?.latestReplies?.some(r => r.senderId !== skip.stewardId && !r.preview?.startsWith(EDIT_RECEIPT)) ?? true;
    if (replied > since && byOthers) {
      result.threads.push(message.id);
      result.latest = Math.max(result.latest, replied);
    }
  }
  return result;
}

export interface SyncRequest {
  steward: string; binding: string; kind: 'file' | 'folder'; vault: string; channelName: string;
  since: number; through: number; activity: Activity;
  files: { path: string; hash: string }[]; attached: string[];
}

const short = (id: string) => id.slice(0, 8);

/** Hash prefix shown in requests; edits may quote it as their baseHash. */
export const SHORT_HASH = 12;

export function composeSyncRequest(r: SyncRequest): string {
  const seqs = r.activity.messages.map(m => m.seq).filter((n): n is number => typeof n === 'number');
  const parts = [seqs.length ? `msgs seq ${Math.min(...seqs)}–${Math.max(...seqs)}`
    : r.activity.messages.length ? `msgs ${r.activity.messages.map(m => short(m.id)).join(',')}` : ''];
  if (r.activity.threads.length) parts.push(`threads ${r.activity.threads.map(short).join(',')}`);
  if (r.activity.pinned.length) parts.push(`📌 ${r.activity.pinned.map(short).join(',')}`);
  if (r.activity.excluded.length) parts.push(`🚫 ${r.activity.excluded.map(short).join(',')}`);
  const notes = r.files.slice(0, 50).map(f => `${f.path}@${f.hash.slice(0, SHORT_HASH)}${r.attached.includes(f.path) ? ' (attached)' : ''}`);
  if (r.files.length > 50) notes.push(`+${r.files.length - 50} more`);
  return [
    `@${r.steward} 📝 sync · ${parts.filter(Boolean).join(' · ')}`,
    `notes: ${notes.join(', ')}`,
    '```raft-sync', JSON.stringify({ binding: r.binding, through: new Date(r.through).toISOString() }), '```',
  ].join('\n');
}
