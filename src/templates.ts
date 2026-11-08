/**
 * Document types and templates. Templates live in the vault's `_templates/` folder (one note per type, plus the
 * written standard), so the user can edit them; the plugin only fills in a template and the binding's properties.
 */

export const TEMPLATE_FOLDER = '_templates';
export const STANDARD_NOTE = '文档规范';
export const DOC_TYPES = ['项目', '调研', '决策', '现状', '内容稿', '知识'] as const;

const pad = (n: number) => String(n).padStart(2, '0');

/** Local date in the given moment-style format; only the tokens templates use. */
export function formatDate(at: Date, format = 'YYYY-MM-DD'): string {
  return format.replace(/YYYY|MM|DD|HH|mm/g, token => ({
    YYYY: String(at.getFullYear()), MM: pad(at.getMonth() + 1), DD: pad(at.getDate()), HH: pad(at.getHours()), mm: pad(at.getMinutes()),
  })[token]!);
}

/** Fills `{{title}}`, `{{date}}` and `{{date:FORMAT}}` the way Obsidian's core Templates plugin does. */
export function fillTemplate(template: string, title: string, at: Date): string {
  return template
    .replace(/\{\{\s*title\s*\}\}/g, title)
    .replace(/\{\{\s*date(?::([^}]+))?\s*\}\}/g, (_, format?: string) => formatDate(at, format?.trim() || 'YYYY-MM-DD'));
}

/** Template note names in the folder listing, in standard order first; the written standard is not a template. */
export function templateTypes(names: string[]): string[] {
  const available = names.filter(n => n !== STANDARD_NOTE);
  return [...DOC_TYPES.filter(t => available.includes(t)), ...available.filter(n => !(DOC_TYPES as readonly string[]).includes(n)).sort()];
}

export interface BindingProperties { type?: string; channel: string; steward?: string; date: string }

/**
 * Properties a bound note should carry. Existing values win, except the binding's own channel and steward, and a
 * `doc/<type>` tag is added once.
 */
export function mergeProperties(front: Record<string, unknown>, p: BindingProperties): void {
  if (p.type) front.type = p.type;
  front.channel = `#${p.channel}`;
  if (p.steward) front.steward = p.steward; else delete front.steward;
  if (front.created === undefined || front.created === null || front.created === '') front.created = p.date;
  front.updated = p.date;
  const tags = Array.isArray(front.tags) ? front.tags.map(String) : typeof front.tags === 'string' && front.tags ? [front.tags] : [];
  if (p.type && !tags.includes(`doc/${p.type}`)) tags.unshift(`doc/${p.type}`);
  if (tags.length) front.tags = tags;
}
