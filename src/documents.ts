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
  return examineEditBlocks(content, messageId, senderName).proposals;
}

/** An edit block that could not be read, with what the agent should fix. `index` counts from 1 in message order. */
export interface EditProblem { id: string; index: number; path?: string; reason: string }

const HASH_HELP = 'Copy the sha256 the plugin listed for the note (a raft-need reply or the request\'s note list); never compute or guess it.';
const OPS_HELP = 'ops must be a non-empty list of {"op":"append","content","heading"?}, {"op":"replace_section","heading","content"} or {"op":"replace","find","with"}.';

/**
 * Reads every edit block in a message. Blocks that are meant as edits but cannot be used come back as problems, so the
 * agent can be told what to fix instead of the edit vanishing silently.
 */
export function examineEditBlocks(content: string, messageId: string, senderName: string): { proposals: ParsedProposal[]; problems: EditProblem[]; position: Map<string, number> } {
  const proposals: ParsedProposal[] = [], problems: EditProblem[] = [], position = new Map<string, number>();
  // Agents often label the block `json` instead of `raft-edit`; such blocks count when they have an edit's shape.
  // `raft-edit` blocks keep their original numbering so recorded applies stay matched.
  const tagged = [...content.matchAll(TAGGED_BLOCK)].map((m, i) => [m[1], `${messageId}:${i}`, true, m.index ?? 0] as const);
  const rest = content.replace(TAGGED_BLOCK, block => ' '.repeat(block.length));
  const loose = [...rest.matchAll(LOOSE_BLOCK)].map((m, i) => [m[1], `${messageId}:j${i}`, false, m.index ?? 0] as const);
  // Positions count in message order, for telling the agent which block; tagged blocks still apply first, as before.
  [...tagged, ...loose].sort((a, b) => a[3] - b[3]).forEach(([, id], i) => position.set(id, i + 1));
  for (const [body, id, isTagged] of [...tagged, ...loose]) {
    const problem = (reason: string, path?: unknown) => problems.push({ id, index: position.get(id)!, path: typeof path === 'string' ? path : undefined, reason });
    if (body.length > 1_000_000) { problem('The block is larger than 1 MB. Split the change.'); continue; }
    let data: any;
    try { data = JSON.parse(body); } catch (cause) {
      // An untagged block only counts as a broken edit when it plainly tries to be one.
      if (isTagged || /"(path|documentId|baseHash)"\s*:/.test(body)) {
        problem(`Not valid JSON (${cause instanceof Error ? cause.message : 'parse error'}). Inside strings write line breaks as \\n and quotes as \\".`, /"path"\s*:\s*"([^"]*)"/.exec(body)?.[1]);
      }
      continue;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) { if (isTagged) problem('A block must hold one JSON object.'); continue; }
    if (!isTagged && typeof data.documentId !== 'string' && typeof data.path !== 'string') continue;
    const hash = typeof data.baseHash === 'string' && /^[a-f0-9]{12,64}$/.test(data.baseHash) ? data.baseHash : undefined;
    const ops = data.ops === undefined ? undefined : parseOps(data.ops);
    const text = typeof data.content === 'string' ? data.content : undefined;
    if (ops === null) { problem(OPS_HELP, data.path); continue; }
    if (ops && text !== undefined) { problem('Give either ops or content, not both.', data.path); continue; }
    if (typeof data.documentId === 'string') {
      if (!hash || hash.length !== 64) { problem('baseHash must be the full 64-character sha256 of the note that was sent.'); continue; }
      if (!ops && text === undefined) { problem('The edit needs ops or content.'); continue; }
      proposals.push({ id, documentId: data.documentId, baseHash: hash, content: text, ops: ops ?? undefined, messageId, senderName });
      continue;
    }
    const path = safeNotePath(data.path);
    if (!path) { problem('path must be a vault-relative Markdown path such as "Folder/Note.md": no leading /, no .., ending in .md.', data.path); continue; }
    if (data.create === true) {
      if (text === undefined || ops) { problem('A new note is {"path","create":true,"content"}: content is the whole text, with no ops and no baseHash.', path); continue; }
      proposals.push({ id, path, create: true, content: text, messageId, senderName });
    } else if (!hash) {
      problem(`baseHash is missing or not hexadecimal. ${HASH_HELP} A note that does not exist yet uses "create":true instead.`, path);
    } else if (!ops && text === undefined) {
      problem('The edit needs ops or content (content replaces the whole note).', path);
    } else {
      proposals.push({ id, path, baseHash: hash, content: text, ops: ops ?? undefined, messageId, senderName });
    }
  }
  return { proposals, problems: problems.sort((a, b) => a.index - b.index), position };
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

/**
 * What another device needs to apply replies to a whole-note send: its documentId, path, and base hash, all read from
 * the sent message. Selection sends are left out, because the selected range is not part of the message.
 */
export function sentNote(content: string): { documentId: string; path: string; baseHash: string } | undefined {
  const { path, context } = splitNoteContext(content);
  const edit = context && /\{"documentId":"([^"]+)","baseHash":"([a-f0-9]{64})","content":"<complete updated note>"\}/.exec(context);
  const notePath = edit ? safeNotePath(path) : null;
  return edit && notePath ? { documentId: edit[1], path: notePath, baseHash: edit[2] } : undefined;
}
