/* ============================================================
 * store.mjs —— 存储层（零依赖，JSON + JSONL）
 *
 * 设计：
 *   · brain.json    全部记忆 + 实体 + 关系（内存中持有，原子写盘）
 *   · episodes.jsonl 只追加的原始对话（回溯 / 重新总结用）
 *   · digests.jsonl  每晚"三件事"（元记忆流水）
 *
 * 与 memory-brain 的关键差异：
 *   · 每条记忆带 owner（u:qq:xxx / g:群号 / global）—— 解决"全库共享串记忆"
 *   · 每条记忆带 visibility（public/private/group）—— 群里绝不召回私聊的话
 * ============================================================ */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const KINDS = new Set(['episode', 'fact', 'preference', 'relation', 'skill', 'digest', 'hypothesis']);
const VISIBILITY = new Set(['public', 'private', 'group']);

let state = null;
/* 数据目录惰性求值：必须在 import 之前设 MEMORY_DATA_DIR 才生效 → 改成首次调用时读 */
export const DATA_DIR = () => process.env.MEMORY_DATA_DIR
  ? path.resolve(process.env.MEMORY_DATA_DIR)
  : path.join(path.dirname(HERE), 'data');

function emptyState() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    seq: 0,                 // 记忆 id 计数
    memories: [],           // 记忆数组（活跃 + 归档）
    entities: {},           // name -> { type, count, first, last }
    relations: [],          // { src, dst, relation, weight, at }
    stats: { added: 0, hits: 0, archived: 0, merged: 0, purged: 0, forgotten: 0 },
  };
}

function files() {
  const dir = DATA_DIR();
  return {
    dir,
    brain: path.join(dir, 'brain.json'),
    episodes: path.join(dir, 'episodes.jsonl'),
    digests: path.join(dir, 'digests.jsonl'),
  };
}

export function load() {
  if (state) return state;
  const { dir, brain } = files();
  fs.mkdirSync(dir, { recursive: true });
  try {
    state = JSON.parse(fs.readFileSync(brain, 'utf8'));
  } catch {
    state = emptyState();
    save();
  }
  if (!state.memories) state.memories = [];
  if (!state.entities) state.entities = {};
  if (!state.relations) state.relations = [];
  return state;
}

let saveTimer = null;
/** 原子写盘：写临时文件再 rename；300ms 防抖合并连续写 */
export function save(immediate = false) {
  if (!state) return;
  const write = () => {
    const { brain } = files();
    const tmp = brain + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, brain);
  };
  if (immediate) { clearTimeout(saveTimer); saveTimer = null; write(); return; }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(write, 300);
}
export function flush() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } save(true); }
process.on('exit', () => { try { flush(); } catch { /* 退出时不阻塞 */ } });

export function nextId() {
  const s = load();
  s.seq += 1;
  return 'm' + String(s.seq).padStart(6, '0');
}

/** 追加一条记忆（已校验字段），返回完整对象 */
export function insertMemory(rec) {
  const s = load();
  const mem = {
    id: rec.id || nextId(),
    owner: rec.owner || 'global',
    visibility: VISIBILITY.has(rec.visibility) ? rec.visibility : 'public',
    kind: KINDS.has(rec.kind) ? rec.kind : 'episode',
    text: String(rec.text || '').slice(0, 1000),
    importance: clamp(rec.importance, 0.05, 1, 0.5),
    valence: clamp(rec.valence, -1, 1, 0),
    arousal: clamp(rec.arousal, 0, 1, 0),
    entities: (rec.entities || []).slice(0, 12),
    pin: !!rec.pin,
    status: 'active',
    source: rec.source || 'auto',
    created_at: rec.created_at || Date.now(),
    last_hit: rec.created_at || Date.now(),
    hits: 0,
    meta: rec.meta || {},
  };
  s.memories.push(mem);
  s.stats.added += 1;
  for (const name of mem.entities) upsertEntity(name, 'thing');
  save();
  return mem;
}

export function upsertEntity(name, type = 'thing', now = Date.now()) {
  const s = load();
  const key = String(name || '').trim().slice(0, 30);
  if (!key) return null;
  const e = s.entities[key] || (s.entities[key] = { type, count: 0, first: now, last: now });
  e.count += 1; e.last = now;
  if (type && type !== 'thing') e.type = type;
  return key;
}

export function addRelation(src, dst, relation, now = Date.now()) {
  const s = load();
  const a = String(src || '').trim(), b = String(dst || '').trim(), r = String(relation || '').trim();
  if (!a || !b || !r || a === b) return;
  s.relations.push({ src: a, dst: b, relation: r.slice(0, 12), at: now });
}

export function getMemory(id) { return load().memories.find((m) => m.id === id) || null; }

export function touch(ids, now = Date.now()) {
  const s = load();
  for (const m of s.memories) {
    if (ids.includes(m.id)) { m.last_hit = now; m.hits += 1; s.stats.hits += 1; }
  }
  save();
}

export function appendEpisode(row) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(EPISODES_FILE, JSON.stringify(row) + '\n');
}
export function appendDigest(row) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(DIGESTS_FILE, JSON.stringify(row) + '\n');
}
export function readEpisodes(sinceTs = 0) {
  try {
    return fs.readFileSync(EPISODES_FILE, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && r.at >= sinceTs);
  } catch { return []; }
}

export function stats() {
  const s = load();
  const active = s.memories.filter((m) => m.status === 'active');
  const kinds = {};
  for (const m of active) kinds[m.kind] = (kinds[m.kind] || 0) + 1;
  const owners = {};
  for (const m of active) {
    const k = m.owner.split('|')[0];
    owners[k] = (owners[k] || 0) + 1;
  }
  return {
    active: active.length,
    archived: s.memories.length - active.length,
    entities: Object.keys(s.entities).length,
    relations: s.relations.length,
    kinds, owners,
    avgImportance: active.length ? +(active.reduce((a, m) => a + m.importance, 0) / active.length).toFixed(3) : 0,
    ...s.stats,
  };
}

export function persistPath() { return files(); }

export function clamp(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}
export function isKind(k) { return KINDS.has(k); }
