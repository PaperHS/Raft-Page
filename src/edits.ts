/**
 * Partial edits. An agent can change one part of a note instead of sending the whole note back. Every operation has
 * to find exactly one place in the note; if any operation cannot, the whole edit is refused so nothing lands in the
 * wrong spot.
 */
export type EditOp =
  | { op: 'replace'; find: string; with: string }
  | { op: 'replace_section'; heading: string; content: string }
  | { op: 'append'; heading?: string; content: string };

export function parseOps(value: unknown): EditOp[] | null {
  if (!Array.isArray(value) || !value.length || value.length > 50) return null;
  const ops: EditOp[] = [];
  for (const raw of value) {
    const o = raw as Record<string, unknown>;
    if (o?.op === 'replace' && typeof o.find === 'string' && o.find && typeof o.with === 'string') ops.push({ op: 'replace', find: o.find, with: o.with });
    else if (o?.op === 'replace_section' && typeof o.heading === 'string' && o.heading.trim() && typeof o.content === 'string') ops.push({ op: 'replace_section', heading: o.heading, content: o.content });
    else if (o?.op === 'append' && typeof o.content === 'string' && (o.heading === undefined || typeof o.heading === 'string')) ops.push({ op: 'append', heading: o.heading as string | undefined, content: o.content });
    else return null;
  }
  return ops;
}

interface Heading { line: number; level: number; text: string }

function headings(lines: string[]): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  lines.forEach((line, index) => {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; return; }
    if (fence) return;
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) out.push({ line: index, level: h[1].length, text: h[2].trim() });
  });
  return out;
}

const headingText = (heading: string) => heading.trim().replace(/^#{1,6}\s+/, '').trim();

/** The section of `heading`: its heading line and the line where the section ends (exclusive). */
function section(lines: string[], heading: string): { start: number; end: number } {
  const wanted = headingText(heading);
  const all = headings(lines);
  const found = all.filter(h => h.text === wanted);
  if (found.length !== 1) throw new Error(found.length ? `The heading "${wanted}" appears more than once.` : `The heading "${wanted}" was not found.`);
  const h = found[0];
  const next = all.find(other => other.line > h.line && other.level <= h.level);
  return { start: h.line, end: next ? next.line : lines.length };
}

const bodyLines = (content: string) => content.replace(/^\n+|\s+$/g, '').split('\n');

export function applyOps(text: string, ops: EditOp[]): string {
  for (const op of ops) {
    if (op.op === 'replace') {
      const first = text.indexOf(op.find);
      if (first < 0) throw new Error('A text to replace was not found.');
      if (text.indexOf(op.find, first + 1) >= 0) throw new Error('A text to replace appears more than once.');
      text = text.slice(0, first) + op.with + text.slice(first + op.find.length);
      continue;
    }
    const lines = text.split('\n');
    if (op.op === 'replace_section') {
      const { start, end } = section(lines, op.heading);
      // A section running to the end of the note keeps the note's final newline.
      const tail = end < lines.length || text.endsWith('\n') ? [''] : [];
      lines.splice(start + 1, end - start - 1, '', ...bodyLines(op.content), ...tail);
    } else if (op.heading) {
      const { start } = section(lines, op.heading);
      let { end } = section(lines, op.heading);
      while (end > start + 1 && lines[end - 1].trim() === '') end--;
      // A blank line already separating the section from the next heading is reused.
      const tail = end < lines.length && lines[end].trim() !== '' ? [''] : [];
      lines.splice(end, 0, '', ...bodyLines(op.content), ...tail);
    } else {
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
      if (lines.length) lines.push('');
      lines.push(...bodyLines(op.content), '');
    }
    text = lines.join('\n');
  }
  return text;
}

/** Vault-relative Markdown path an agent may name: no absolute paths, no `..`, no hidden folders. */
export function safeNotePath(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  const clean = path.trim().replace(/\\/g, '/');
  if (!clean || clean.length > 300 || clean.startsWith('/') || !/\.md$/i.test(clean)) return null;
  if (clean.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) return null;
  return clean;
}
