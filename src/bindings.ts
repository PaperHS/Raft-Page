/**
 * Channel bindings: a vault path (file or folder) belongs to one Raft channel. They are stored as BINDINGS_FILE in
 * the plugin's folder inside the vault, which vault sync carries to other devices (Obsidian Sync skips other hidden
 * folders); they never hold login data. A note uses its own binding, otherwise that of the nearest folder above it.
 */
export const BINDINGS_FILE = 'bindings.json';

export interface Binding {
  channelId: string; channelName: string; serverId: string; kind: 'file' | 'folder';
  /** The agent that keeps these notes up to date from the conversation; its edits apply on their own. */
  stewardId?: string; stewardName?: string;
  /** When the steward was chosen; the first sync covers conversation from here on. */
  stewardSince?: string;
  /** Automatic sync requests are paused; the steward's edits then arrive as cards. */
  paused?: boolean;
  /** Direct-message channel with the steward where syncing happens, so the bound channel stays quiet. */
  syncChannelId?: string;
  /** Message in that channel whose thread carries sync requests and the steward's replies. */
  syncRootId?: string;
  /** Version of the steward instructions carried by that thread's first message. */
  syncBrief?: number;
}
export type Bindings = Record<string, Binding>;
export interface ResolvedBinding extends Binding { path: string; inherited: boolean }

export function parseBindings(text: string): Bindings {
  const data = JSON.parse(text) as { bindings?: unknown };
  const out: Bindings = {};
  if (!data || typeof data.bindings !== 'object' || !data.bindings) return out;
  for (const [path, value] of Object.entries(data.bindings as Record<string, unknown>)) {
    const b = value as Partial<Binding>;
    if (!path || typeof b?.channelId !== 'string' || typeof b.serverId !== 'string') continue;
    out[path] = { channelId: b.channelId, channelName: typeof b.channelName === 'string' ? b.channelName : '', serverId: b.serverId,
      kind: b.kind === 'folder' ? 'folder' : 'file' };
    if (typeof b.stewardId === 'string' && b.stewardId) {
      out[path].stewardId = b.stewardId;
      out[path].stewardName = typeof b.stewardName === 'string' ? b.stewardName : '';
      if (typeof b.stewardSince === 'string') out[path].stewardSince = b.stewardSince;
    }
    if (b.paused === true) out[path].paused = true;
    if (typeof b.syncRootId === 'string' && b.syncRootId) out[path].syncRootId = b.syncRootId;
    if (typeof b.syncChannelId === 'string' && b.syncChannelId) out[path].syncChannelId = b.syncChannelId;
    if (typeof b.syncBrief === 'number') out[path].syncBrief = b.syncBrief;
  }
  return out;
}

/**
 * Applies the change from `before` to `after` onto the bindings now on disk, so a device whose copy is out of date
 * (another device bound or unbound something meanwhile) only writes what it changed instead of its whole stale list.
 */
export function mergeBindings(before: Bindings, after: Bindings, disk: Bindings): Bindings {
  const out: Bindings = { ...disk };
  for (const path of Object.keys(before)) if (!(path in after)) delete out[path];
  for (const [path, value] of Object.entries(after)) {
    if (JSON.stringify(before[path]) !== JSON.stringify(value)) out[path] = value;
  }
  return out;
}

export function serializeBindings(bindings: Bindings): string {
  const sorted = Object.fromEntries(Object.entries(bindings).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({ version: 1, bindings: sorted }, null, 2) + '\n';
}

/** The binding that applies to `path` on this server: the path itself first, then each folder above it. */
export function resolveBinding(bindings: Bindings, path: string, serverId: string): ResolvedBinding | null {
  for (let candidate = path, inherited = false; candidate; inherited = true) {
    const b = bindings[candidate];
    if (b && b.serverId === serverId && (b.kind === 'folder' || !inherited)) return { ...b, path: candidate, inherited };
    const slash = candidate.lastIndexOf('/');
    candidate = slash > 0 ? candidate.slice(0, slash) : '';
  }
  return null;
}

/**
 * Binds `path` to a channel. A channel has one root on each server, so an older binding of the same channel is
 * dropped; its path is returned so the caller can say what moved.
 */

/** The note or folder bound to `channelId` on this server, when one exists. */
export function resolveChannelBinding(bindings: Bindings, channelId: string, serverId: string): ResolvedBinding | null {
  for (const [path, b] of Object.entries(bindings)) {
    if (b.serverId === serverId && b.channelId === channelId) return { ...b, path, inherited: false };
  }
  return null;
}

export function bind(bindings: Bindings, path: string, binding: Binding): { bindings: Bindings; replaced: string[] } {
  const next: Bindings = {};
  const replaced: string[] = [];
  for (const [key, value] of Object.entries(bindings)) {
    if (key === path) continue;
    if (value.channelId === binding.channelId && value.serverId === binding.serverId) { replaced.push(key); continue; }
    next[key] = value;
  }
  next[path] = binding;
  return { bindings: next, replaced };
}

export function unbind(bindings: Bindings, path: string): Bindings {
  const next = { ...bindings };
  delete next[path];
  return next;
}

/** Keeps bindings attached when a file or folder is renamed or moved. Returns null when nothing changed. */
export function renameBindings(bindings: Bindings, oldPath: string, newPath: string): Bindings | null {
  let changed = false;
  const next: Bindings = {};
  for (const [key, value] of Object.entries(bindings)) {
    if (key === oldPath || key.startsWith(oldPath + '/')) { next[newPath + key.slice(oldPath.length)] = value; changed = true; }
    else next[key] = value;
  }
  return changed ? next : null;
}

/** Drops bindings of a deleted file or folder. Returns null when nothing changed. */
export function deleteBindings(bindings: Bindings, path: string): Bindings | null {
  const keys = Object.keys(bindings).filter(key => key === path || key.startsWith(path + '/'));
  if (!keys.length) return null;
  const next = { ...bindings };
  for (const key of keys) delete next[key];
  return next;
}

/** A short file list for the first message in a bound folder, so agents see the layout without every file's text. */
export function folderManifest(files: { path: string; size: number }[], root: string, limit = 200): string {
  const inside = files.filter(f => f.path.startsWith(root + '/')).sort((a, b) => a.path.localeCompare(b.path));
  const lines = inside.slice(0, limit).map(f => `- ${f.path.slice(root.length + 1)} (${formatSize(f.size)})`);
  if (inside.length > limit) lines.push(`- … ${inside.length - limit} more`);
  return lines.join('\n');
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A channel name suggested from a note title: lower case, spaces as dashes, letters of any script kept. */
export function channelName(title: string): string {
  return title.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}
