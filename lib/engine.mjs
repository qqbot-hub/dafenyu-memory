/* ============================================================
 * engine.mjs —— 检索引擎：五路打分 + 图扩散 + 钉住激活 + 意图重排 + 去重
 *
 * 打分权重沿用 memory-brain 实测结论（中文短 query 下关键词比语义可靠）：
 *   score = 0.18*语义 + 0.46*关键词 + 0.14*重要性 + 0.11*新鲜度 + 0.11*图谱
 *
 * 在它基础上修的四个洞：
 *   ① 停用词 + IDF 加权      → "最近/怎么样"不再压过"团子"
 *   ② owner 归属过滤          → 群里绝不召回别人私聊的记忆
 *   ③ visibility 场合过滤     → 群聊场合召不回 private
 *   ④ 分数门槛 minScore       → 低分记忆不进 prompt
 * ============================================================ */
'use strict';

import * as store from './store.mjs';

/* ---------------- 权重与常量 ---------------- */
export const W = { semantic: 0.18, keyword: 0.46, importance: 0.14, recency: 0.11, graph: 0.11 };
const RECENCY_HALF_LIFE_DAYS = 14;
const DEDUP_SIMILARITY = 0.82;
const KIND_BOOST = 0.05;
const PIN_SCORE = 0.9;

const INTENT_HINTS = {
  fact: ['规则', '喜欢', '讨厌', '习惯', '叫什么', '生日', '不能', '永远', '是不是', '会不会', '住哪', '在哪'],
  episode: ['那天', '上次', '当时', '记得', '之前', '昨天', '今天', '说好', '答应', '后来', '约好'],
};

const STOPWORDS = new Set(('的 了 吗 呢 吧 啊 呀 哦 嗯 唉 哈 呗 嘛 么 什么 怎么样 怎么 如何 是不是 会不会 ' +
  '最近 现在 今天 昨天 前天 刚才 刚刚 那个 这 这个 这些 那些 事情 东西 时候 地方 还是 还有 就是 因为 所以 ' +
  '一个 一种 一下 一直 一起 一样 我们 你们 他们 她们 自己 大家 我 你 他 她 它 说 说话 问 回答 知道 不知道 ' +
  '记得 不记得 想起 想起来 忘 忘了 记住 请 帮 帮忙 可以 能 不能 有没有 是 在 的了 呀啦 咯 咧 啦').split(/\s+/));

/* ---------------- 文本处理 ---------------- */
export function bigrams(text) {
  const out = new Set();
  const s = String(text || '').toLowerCase();
  for (const w of s.split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    if (/^[a-z0-9]+$/.test(w)) { out.add(w); continue; }
    out.add(w);
    if (w.length === 2) { out.add(w); continue; }
    for (let i = 0; i < w.length - 1; i++) out.add(w.slice(i, i + 2));
  }
  return out;
}

/** 查询清洗：去标点/停用词/虚词，只留实词。清洗过短则退回原句分词 */
export function cleanQuery(text) {
  let s = String(text || '')
    .replace(/[?？!！。，,、；;：:"'“”‘’（）()\[\]{}<>《》…·—~～]+/g, ' ')
    .replace(/^(你|您|她|他|它|帮我|请|请问|我想|想知道|还记得|记得|问问|查查)+/g, ' ')
    .replace(/(你还?记得|记得|怎么样|如何|什么|啥|哪|谁|多少|为什么|为啥|了吗|了吗|呢|吗)+/g, ' ');
  const tokens = s.split(/\s+/).flatMap((w) => {
    if (!w) return [];
    if (/^[a-z0-9]+$/i.test(w)) return [w.toLowerCase()];
    const pieces = [];
    for (let i = 0; i < w.length - 1; i++) pieces.push(w.slice(i, i + 2));
    if (pieces.length === 0) pieces.push(w);
    return pieces;
  }).filter((t) => t && !STOPWORDS.has(t));
  const uniq = [...new Set(tokens)];
  return uniq.length >= 1 ? uniq : bigrams(String(text || ''));
}

function similarity(a, b) {
  const ga = bigrams(a), gb = bigrams(b);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / Math.min(ga.size, gb.size);
}

/* ---------------- 归属与场合过滤 ---------------- */
/** 返回该记忆在当前场合是否可见。隐私优先：拿不准就不给。 */
export function visibleIn(mem, { channel, group, owner }) {
  if (mem.status !== 'active') return false;
  const o = mem.owner || 'global';
  if (channel === 'group') {
    // 群聊：本群的事 + 全局 + 明确标记 public 的（他人私聊的话默认 private，不会漏出去）
    if (o === 'g:' + group) return true;
    if (o === 'global') return true;
    return mem.visibility === 'public';
  }
  // 私聊（owner = u:qq:xxx）：本人的 + 全局 + 本人所在群的话（可选，默认关）
  if (o === 'global') return true;
  if (o === 'u:' + owner) return true;
  return false;
}

/* ---------------- 主检索 ---------------- */
/**
 * recall(query, opts)
 *   opts.owner  'qq:10001'        当前说话人
 *   opts.group  '888'             当前群号（群聊时）
 *   opts.channel 'group'|'private'
 *   opts.k       默认 5
 *   opts.minScore 默认 0.35
 *   opts.embed   可选 (text)=>Promise<Float32Array|number[]>
 *   opts.explain 返回打分明细
 */
export async function recall(query, opts = {}) {
  const {
    owner = '', group = '', channel = 'private',
    k = 5, minScore = 0.35, embed = null, explain = false, moodValence = null,
  } = opts;
  const now = Date.now();
  const q = String(query || '').trim();
  if (!q) return [];

  const qTokens = cleanQuery(q);
  const qSet = new Set(qTokens);
  if (!qSet.size) return [];

  const s = store.load();
  const active = s.memories.filter((m) => visibleIn(m, { channel, group, owner }));

  /* 关键词路：IDF 加权的 token 重合度 */
  const N = Math.max(1, active.length);
  const df = new Map();
  const tokenSets = new Map();
  for (const m of active) {
    const ts = new Set([...bigrams(m.text), ...m.entities.map((e) => e.toLowerCase())]);
    tokenSets.set(m.id, ts);
    for (const t of ts) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = (t) => Math.log(1 + N / (1 + (df.get(t) || 0)));
  const totalIdf = qTokens.reduce((a, t) => a + idf(t), 0) || 1;

  /* 语义路：可选 */
  let qVec = null;
  if (embed) { try { qVec = await embed(q); } catch { qVec = null; } }
  const cos = (a, b) => {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  };

  /* 意图判定：问事实还是问往事 */
  let bestKind = '', bestHits = 0;
  for (const [kind, hints] of Object.entries(INTENT_HINTS)) {
    const n = hints.filter((h) => q.includes(h)).length;
    if (n > bestHits) { bestKind = kind; bestHits = n; }
  }

  const rows = [];
  const seedEntities = new Set();
  const firstPass = [];
  for (const m of active) {
    const ts = tokenSets.get(m.id);
    let hitIdf = 0;
    for (const t of qTokens) if (ts.has(t)) hitIdf += idf(t);
    const sKw = hitIdf / totalIdf;
    const sImp = m.importance;
    const days = Math.max(0, (now - (m.last_hit || m.created_at)) / 86400000);
    const sRec = Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS);
    let sSem = 0;
    if (qVec) sSem = Math.max(0, cos(qVec, m.vector));

    const base = W.keyword * sKw + W.importance * sImp + W.recency * sRec + W.semantic * sSem;
    firstPass.push({ m, sKw, sSem, sImp, sRec, base });
  }

  /* 图谱扩散：取关键词最强的 5 条，用它们的实体找 1 跳邻居 */
  firstPass.sort((a, b) => b.base - a.base);
  const seeds = firstPass.slice(0, 5);
  for (const { m } of seeds) for (const e of m.entities) seedEntities.add(e);
  const inSeeds = new Set(seeds.map(({ m }) => m.id));
  for (const m of active) {
    if (inSeeds.has(m.id)) continue;
    const shared = m.entities.filter((e) => seedEntities.has(e)).length;
    if (shared > 0) firstPass.push({ m, sKw: 0, sSem: 0, sImp: m.importance, sRec: 0, graphOnly: true, shared });
  }

  /* 汇总打分 */
  const memEntityCache = new Map();
  for (const row of firstPass) {
    const m = row.m;
    if (!memEntityCache.has(m.id)) memEntityCache.set(m.id, new Set(m.entities));
    const shared = [...memEntityCache.get(m.id)].filter((e) => seedEntities.has(e)).length;
    const sGraph = Math.min(1, shared / 3);

    let sImp = row.sImp;
    /* 情绪一致：心情差时略微偏负向记忆（权重很小） */
    if (moodValence != null) {
      const mv = Math.max(-1, Math.min(1, moodValence));
      if ((mv < -0.15 && m.valence < -0.1) || (mv > 0.15 && m.valence > 0.1)) sImp = Math.min(1, sImp + 0.03);
    }

    let score = W.keyword * row.sKw + W.semantic * row.sSem + W.importance * sImp
      + W.recency * row.sRec + W.graph * sGraph;

    /* 钉住：身份/约定类事实，问对了就拉满，问不对不占预算 */
    if (m.pin) {
      const pinTokens = new Set([...bigrams(m.text), ...m.entities.map((e) => e.toLowerCase())]);
      const relevant = qTokens.some((t) => pinTokens.has(t)) || row.sKw >= 0.3;
      if (relevant) score = Math.max(score, PIN_SCORE);
      else score += 0.1;   // 没问对也给一点保底
    }

    /* 意图重排 */
    if (bestHits && m.kind === bestKind) score += KIND_BOOST;

    if (score <= 0) continue;
    const item = {
      id: m.id, owner: m.owner, text: m.text, kind: m.kind,
      importance: +sImp.toFixed(3), score: +score.toFixed(4),
      created_at: m.created_at, visibility: m.visibility, pin: m.pin,
    };
    if (explain) {
      item.why = {
        keyword: +row.sKw.toFixed(3), semantic: +row.sSem.toFixed(3),
        importance: +sImp.toFixed(3), recency: +row.sRec.toFixed(3),
        graph: +sGraph.toFixed(3), graphOnly: !!row.graphOnly,
        intent: bestKind || null,
      };
    }
    rows.push(item);
  }

  rows.sort((a, b) => b.score - a.score);

  /* 去重：二元组重合度 ≥ 0.82 的只留最高分 */
  const picked = [];
  for (const r of rows) {
    if (picked.some((p) => similarity(p.text, r.text) >= DEDUP_SIMILARITY)) continue;
    picked.push(r);
    if (picked.length >= k) break;
  }
  const out = picked.filter((r) => r.score >= minScore);

  /* 被想起 = 续命 */
  if (out.length) store.touch(out.map((r) => r.id), now);
  return out;
}

/* ---------------- 遗忘治理 ---------------- */
/**
 * nightly 一趟：
 *   1. 衰减：importance *= rate（pin 豁免）
 *   2. 归档：importance < 0.15；或 30 天未想起且 importance < 0.3
 *   3. 合并：相似度 ≥ 0.92 且同 owner → 并入较新的一条
 *   4. 清除：归档超过 180 天 → 删除
 */
export function nightly(opts = {}) {
  const { rate = 0.995, now = Date.now() } = opts;
  const s = store.load();
  const DAY = 86400000;
  let archived = 0, merged = 0, purged = 0, decayed = 0;

  const active = s.memories.filter((m) => m.status === 'active');
  for (const m of active) {
    if (m.pin) continue;
    m.importance = +Math.max(0.02, m.importance * rate).toFixed(4);
    decayed++;
  }

  for (const m of active) {
    if (m.pin || m.source === 'digest') continue;
    const idleDays = (now - (m.last_hit || m.created_at)) / DAY;
    const shouldArchive = m.importance < 0.15 || (idleDays > 30 && m.importance < 0.3);
    if (shouldArchive) { m.status = 'archived'; m.archived_at = now; s.stats.archived += 1; archived++; }
  }

  /* 合并：同 owner、相似度超阈值 → 并入较新的 */
  const active2 = s.memories.filter((m) => m.status === 'active');
  const dropped = new Set();
  for (let i = 0; i < active2.length; i++) {
    const a = active2[i];
    if (dropped.has(a.id) || a.pin) continue;
    for (let j = i + 1; j < active2.length; j++) {
      const b = active2[j];
      if (dropped.has(b.id) || b.pin || b.owner !== a.owner) continue;
      if (similarity(a.text, b.text) >= 0.92) {
        const [keep, drop] = a.created_at >= b.created_at ? [a, b] : [b, a];
        keep.importance = Math.max(keep.importance, drop.importance);
        keep.hits += drop.hits;
        keep.entities = [...new Set([...keep.entities, ...drop.entities])].slice(0, 12);
        drop.status = 'archived'; drop.archived_at = now;
        dropped.add(drop.id);
        merged++;
      }
    }
  }

  /* 清除：归档超 180 天 */
  const before = s.memories.length;
  s.memories = s.memories.filter((m) => !(m.status === 'archived' && m.archived_at && now - m.archived_at > 180 * DAY));
  purged = before - s.memories.length;
  s.stats.purged += purged;
  s.stats.merged += merged;
  s.stats.forgotten += archived;

  store.save(true);
  return { decayed, archived, merged, purged, active: s.memories.filter((m) => m.status === 'active').length };
}

/** 摘要块：给 /v1 注入用的文本 */
export function blockOf(hits) {
  if (!hits.length) return '';
  const lines = hits.map((h) => {
    const day = new Date(h.created_at).toISOString().slice(0, 10);
    return `- [${day}] ${h.text}`;
  });
  return lines.join('\n');
}
