// Derived from Raft (Copyright 2026 Botiverse, Inc.), licensed under FSL-1.1-ALv2; see NOTICE.
import pixelAvatars from './pixelAvatars.json';

// Mirrors Raft web's PixelAvatar so agents look the same here as in Raft.
type Palette = Record<string, string>;
const C = pixelAvatars.palette as Palette;
const AVATARS = pixelAvatars.avatars as Record<string, { bg: string; grid: string[] }>;

const COLOR_SCHEMES: [string, string][] = [
  [C.C, 'K'], [C.Y, 'K'], [C.L, 'K'], [C.P, 'W'], [C.V, 'K'],
  ['#1E1E1C', 'C'], ['#1E1E1C', 'G'], ['#1E1E1C', 'P'], ['#1E1E1C', 'Y'], ['#1E1E1C', 'V'],
  [C.O, 'K'], [C.C, 'W'],
];

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  return hash;
}

function generate(seed: string): { bg: string; grid: string[][] } {
  const rng = mulberry32(hashString(seed));
  const [bg, fg] = COLOR_SCHEMES[Math.floor(rng() * COLOR_SCHEMES.length)];
  const grid: string[][] = [];
  for (let y = 0; y < 8; y++) {
    const left: string[] = [];
    for (let x = 0; x < 4; x++) left.push(rng() < 0.45 ? fg : '_');
    grid.push([left[0], left[1], left[2], left[3], left[3], left[2], left[1], left[0]]);
  }
  return { bg, grid };
}

function sprite(key: string): { bg: string; grid: string[][] } | null {
  if (key.startsWith('random:')) return generate(key.slice(7));
  const avatar = AVATARS[key];
  if (!avatar) return null;
  return { bg: avatar.bg.startsWith('#') ? avatar.bg : C[avatar.bg], grid: avatar.grid.map(row => row.split('')) };
}

const cache = new Map<string, string | null>();

/** SVG data URL for a Raft agent avatar value ("pixel:key", "pixel:random:seed", or empty for the default). */
export function pixelAvatarUrl(avatarUrl: string | undefined): string | null {
  const key = avatarUrl?.startsWith('pixel:') ? avatarUrl.slice(6) : pixelAvatars.defaultKey;
  if (cache.has(key)) return cache.get(key)!;
  const data = sprite(key) ?? sprite(pixelAvatars.defaultKey);
  let url: string | null = null;
  if (data) {
    const cells = data.grid.flatMap((row, y) => row.flatMap((color, x) =>
      color === '_' ? [] : [`<rect x="${x}" y="${y}" width="1" height="1" fill="${C[color]}"/>`]));
    url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" shape-rendering="crispEdges"><rect width="8" height="8" fill="${data.bg}"/>${cells.join('')}</svg>`)}`;
  }
  cache.set(key, url);
  return url;
}

/** True when the avatar value is an uploaded image rather than pixel art. */
export function isCustomAvatar(avatarUrl: string | undefined): boolean {
  return !!avatarUrl && !avatarUrl.startsWith('pixel:');
}
