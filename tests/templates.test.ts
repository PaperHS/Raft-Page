import test from 'node:test';
import assert from 'node:assert/strict';
import { fillTemplate, formatDate, mergeProperties, templateTypes } from '../src/templates';

const at = new Date(2026, 10, 8, 9, 5);

test('templates fill title and dates like Obsidian core Templates', () => {
  assert.equal(formatDate(at), '2026-11-08');
  assert.equal(fillTemplate('# {{title}}\ncreated: {{date:YYYY-MM-DD}}\n{{date}} {{ date:HH:mm }}', '需求雷达', at), '# 需求雷达\ncreated: 2026-11-08\n2026-11-08 09:05');
});

test('template types keep the standard order, list custom ones after, and skip the written standard', () => {
  assert.deepEqual(templateTypes(['知识', '文档规范', '会议', '项目', '调研']), ['项目', '调研', '知识', '会议']);
});

test('binding properties add the type tag once and keep what the note already says', () => {
  const front: Record<string, unknown> = { tags: ['topic/seo', 'doc/调研'], created: '2026-10-01', owner: 'paperhs', steward: 'old' };
  mergeProperties(front, { type: '调研', channel: '需求雷达', date: '2026-11-08' });
  assert.deepEqual(front, { tags: ['topic/seo', 'doc/调研'], created: '2026-10-01', owner: 'paperhs', type: '调研', channel: '#需求雷达', updated: '2026-11-08' });
  const fresh: Record<string, unknown> = { tags: 'idea' };
  mergeProperties(fresh, { type: '项目', channel: 'plan', steward: 'Holiday', date: '2026-11-08' });
  assert.deepEqual(fresh, { tags: ['doc/项目', 'idea'], type: '项目', channel: '#plan', steward: 'Holiday', created: '2026-11-08', updated: '2026-11-08' });
});
