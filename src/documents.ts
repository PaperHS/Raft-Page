import { applyOps, parseOps, safeNotePath, type EditOp } from './edits';

export interface DocumentContext {
  id: string;
  path: string;
  content: string;
  baseHash: string;
  selection?: { from: number; to: number };
}

export interface DocumentSnapshot extends DocumentContext {
  channelId: string;
  agent: string;
  agentId?: string;
  createdAt: string;
}

/**
 * An agent's change. Replies to a sent note name its `documentId`; a binding's steward names a `path` inside the
 * bound note or folder instead, which can also create a new note (`create`). A change carries either the complete
 * new `content` or partial `ops`.
 */
export interface Proposal {
  id: string;
  documentId?: string;
  path: string;
  baseHash?: string;
  content?: string;
  ops?: EditOp[];
  create?: boolean;
  messageId: string;
  senderName: string;
}
export type ParsedProposal = Omit<Proposal, 'path'> & { path?: string };

export async function hashText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}

const TAGGED_BLOCK = /^```raft-edit\s*\r?\n([\s\S]*?)^```\s*$/gm;
const LOOSE_BLOCK = /^```(?:json)?\s*\r?\n([\s\S]*?)^```\s*$/gm;
const looksLikeEdit = (body: string) => { try { const d = JSON.parse(body); return !!d && typeof d === 'object' && (typeof d.documentId === 'string' || typeof d.path === 'string'); } catch { return false; } };

/** Splits off edit blocks (tagged, or json blocks shaped like an edit) so a message can show its text and cards. */
export function splitEditBlocks(content: string): { text: string; blocks: string[] } {
  const blocks: string[] = [];
  let text = content.replace(TAGGED_BLOCK, block => { blocks.push(block); return ''; });
  text = text.replace(LOOSE_BLOCK, (block, body: string) => { if (!looksLikeEdit(body)) return block; blocks.push(block); return ''; });
  return { text: blocks.length ? text.trim() : content, blocks };
}

export function parseProposals(content: string, messageId: string, senderName: string): ParsedProposal[] {
  const proposals: ParsedProposal[] = [];
  // Agents often label the block `json` instead of `raft-edit`; such blocks count when they have an edit's shape.
  // `raft-edit` blocks keep their original numbering so recorded applies stay matched.
  const tagged = [...content.matchAll(TAGGED_BLOCK)].map((m, i) => [m[1], `${messageId}:${i}`] as const);
  const loose = [...content.replace(TAGGED_BLOCK, '').matchAll(LOOSE_BLOCK)].map((m, i) => [m[1], `${messageId}:j${i}`] as const);
  for (const [body, id] of [...tagged, ...loose]) {
    if (body.length > 1_000_000) continue;
    try {
      const data = JSON.parse(body);
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      const hash = typeof data.baseHash === 'string' && /^[a-f0-9]{12,64}$/.test(data.baseHash) ? data.baseHash : undefined;
      const ops = data.ops === undefined ? undefined : parseOps(data.ops);
      const text = typeof data.content === 'string' ? data.content : undefined;
      if (ops === null || (ops && text !== undefined)) continue;
      if (typeof data.documentId === 'string') {
        if (!hash || hash.length !== 64 || (!ops && text === undefined)) continue;
        proposals.push({ id, documentId: data.documentId, baseHash: hash, content: text, ops: ops ?? undefined, messageId, senderName });
        continue;
      }
      const path = safeNotePath(data.path);
      if (!path) continue;
      if (data.create === true) {
        if (text === undefined || ops) continue;
        proposals.push({ id, path, create: true, content: text, messageId, senderName });
      } else if (hash && (ops || text !== undefined)) {
        proposals.push({ id, path, baseHash: hash, content: text, ops: ops ?? undefined, messageId, senderName });
      }
    } catch { /* Invalid edit blocks remain ordinary chat messages. */ }
  }
  return proposals;
}

/** The note text after a change: partial operations, a selection replacement, or the complete new text. */
export function applyProposalText(current: string, proposal: Proposal, snapshot?: DocumentContext): string {
  if (proposal.ops) {
    if (snapshot?.selection) throw new Error('Partial edits cannot target a selected-text send.');
    return applyOps(current, proposal.ops);
  }
  if (proposal.content === undefined) throw new Error('This change has no content.');
  return snapshot ? applyToText(current, snapshot, proposal.content) : proposal.content;
}

export function applyToText(current: string, snapshot: DocumentContext, replacement: string): string {
  if (!snapshot.selection) return replacement;
  const { from, to } = snapshot.selection;
  if (from < 0 || to < from || to > current.length) throw new Error('The original selection is no longer valid.');
  return current.slice(0, from) + replacement + current.slice(to);
}

/** Start of the note line appended to a sent message; everything from here on is note context, not user text. */
export const NOTE_MARKER = '\n\n> 📎 Obsidian note ';
/**
 * When the note travels as a file, its edit details ride in a Markdown link reference definition. Raft (and any
 * CommonMark renderer) does not display definitions, so people see only their message and the file card, while
 * agents read the raw text and get the details.
 */
export const HIDDEN_NOTE_MARKER = "\n\n[raft-note]: <> '";
const LEGACY_MARKER = '\n\n---\nAttached Obsidian note: ';

/**
 * Builds the message for a send. With `attachedAsFile`, the note travels as a Raft file attachment and the message
 * carries one short line; otherwise the text follows in a fenced block (empty notes, or when uploads are unavailable).
 */
export function composeMessage(agent: string, text: string, context: DocumentContext | null, attachedAsFile = false, folder?: string): string {
  const mention = agent ? `@${agent} ` : '';
  if (!context) return mention + text;
  const selection = !!context.selection;
  const edit = JSON.stringify({ documentId: context.id, baseHash: context.baseHash,
    content: selection ? '<replacement for the selected text>' : '<complete updated note>' });
  const ops = (selection ? '' : '; for a partial change use `"ops":[{"op":"replace","find":"…","with":"…"}]` (or `replace_section`/`append` with `heading`) instead of `content`') +
    (folder ? `; to add a note to the bound folder \`${folder}\`, use \`{"path":"${folder}/<title>.md","create":true,"content":"…"}\`` : '');
  if (attachedAsFile) {
    const details = `📎 Obsidian note \`${context.path}\` — ${selection ? 'selected text' : 'full text'} in the attached file. To edit it, reply with a code block fenced as \`\`\`raft-edit containing \`${edit}\`${ops}`;
    return `${mention}${text}${HIDDEN_NOTE_MARKER}${details.replace(/[\\']/g, m => '\\' + m).replace(/\s*\n\s*/g, ' ')}'`;
  }
  const where = !context.content ? 'the note is empty' : `${selection ? 'selected text' : 'full text'} below`;
  let message = `${mention}${text}${NOTE_MARKER}\`${context.path}\` — ${where}. To edit it, reply with a \`raft-edit\` block: \`${edit}\`${ops}`;
  if (context.content) {
    const fence = '`'.repeat(Math.max(3, ...[...context.content.matchAll(/`{3,}/g)].map(m => m[0].length + 1)));
    message += `\n\n${fence}markdown\n${context.content}\n${fence}`;
  }
  return message;
}

/** Splits a sent message into the user's own text and the attached note path (if any). */
export function splitNoteContext(content: string): { text: string; path?: string; context?: string } {
  const hidden = content.indexOf(HIDDEN_NOTE_MARKER);
  if (hidden >= 0) {
    const details = content.slice(hidden + HIDDEN_NOTE_MARKER.length).replace(/'\s*$/, '').replace(/\\([\\'])/g, '$1');
    return { text: content.slice(0, hidden), path: /`([^`]+)`/.exec(details)?.[1], context: details };
  }
  const at = content.indexOf(NOTE_MARKER);
  if (at >= 0) {
    const path = /^`([^`]+)`/.exec(content.slice(at + NOTE_MARKER.length))?.[1];
    return { text: content.slice(0, at), path, context: content.slice(at + 2) };
  }
  const legacy = content.indexOf(LEGACY_MARKER);
  if (legacy >= 0) return { text: content.slice(0, legacy), path: content.slice(legacy + LEGACY_MARKER.length).split('\n')[0], context: content.slice(legacy + 2) };
  return { text: content };
}

/** The documentId a sent message bound its note to, in either message format. */
export function sentDocumentId(content: string): string | undefined {
  const { context } = splitNoteContext(content);
  return context ? /\{"documentId":"([^"]+)"/.exec(context)?.[1] : undefined;
}
