#!/usr/bin/env node
/* ============================================================
 * dafenyu-memory 服务端 —— 零依赖记忆层
 *
 *   node server.mjs
 *   默认 http://127.0.0.1:8790
 *
 * 三种用法（可叠加）：
 *   A. OpenAI 兼容代理：把客户端 base_url 指到 /v1，记忆自动注入+自动记录
 *   B. 直接调接口：     POST /recall  POST /remember  GET /stats
 *   C. 大脑面板：       GET /panel    （力导向图，实时看"她在想什么"）
 *
 * 身份约定：
 *   每条请求必须带 user（如 "qq:10001"），群聊另带 x-channel: group 和 x-group: 888
 *   不带 user 的 /v1 请求返回 400 —— 防止所有人的记忆混在一起
 * ============================================================ */
'use strict';

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './lib/store.mjs';
import { recall, blockOf, nightly } from './lib/engine.mjs';
import { extractWithLLM, fallback, normalize } from './lib/extract.mjs';
import { buildAtlas, exportData, validateImport, retentionAt } from './lib/viewmodel.mjs';
import { makeEmbedder } from './lib/embed.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '2.0.0';
const STARTED = Date.now();

/* ---------------- 配置 ---------------- */
function loadConfig() {
  let fileCfg = {};
  try { fileCfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')); } catch { /* 用默认 */ }
  const env = process.env;
  const cfg = {
    port: Number(env.MEMORY_PORT || fileCfg.port || 8790),
    host: env.MEMORY_HOST || fileCfg.host || '127.0.0.1',
    token: env.MEMORY_TOKEN || fileCfg.token || '',
    llm: {
      baseUrl: env.MEMORY_LLM_BASE || fileCfg.llm?.baseUrl || '',
      apiKey: env.MEMORY_LLM_KEY || fileCfg.llm?.apiKey || '',
      model: env.MEMORY_LLM_MODEL || fileCfg.llm?.model || 'deepseek-chat',
    },
    upstream: {
      baseUrl: env.MEMORY_UPSTREAM_BASE || fileCfg.upstream?.baseUrl || '',
      apiKey: env.MEMORY_UPSTREAM_KEY || fileCfg.upstream?.apiKey || '',
      model: env.MEMORY_UPSTREAM_MODEL || fileCfg.upstream?.model || 'deepseek-chat',
    },
    embed: {
      baseUrl: env.MEMORY_EMBED_URL || fileCfg.embed?.baseUrl || '',
      model: env.MEMORY_EMBED_MODEL || fileCfg.embed?.model || 'bge-m3',
    },
    recall: Object.assign({ k: 5, minScore: 0.35, maxBytes: 1400, maxItems: 5 }, fileCfg.recall || {}),
    remember: Object.assign({ enabled: true, minChars: 6, importance: 0.4 }, fileCfg.remember || {}),
    shareGroupToPrivate: fileCfg.shareGroupToPrivate === true,
    debug: env.MEMORY_DEBUG === '1' || fileCfg.debug === true,
  };
  return cfg;
}
const CFG = loadConfig();
const log = (...a) => console.log('[dafenyu-memory]', ...a);

/* ---------------- 工具 ---------------- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
const ok = (res, data) => sendJson(res, 200, { status: 'ok', data });
const err = (res, code, message) => sendJson(res, code, { status: 'error', message });

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function lastUserText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user') return typeof m.content === 'string' ? m.content : (m.content || []).map((p) => p.text || '').join(' ');
  }
  return '';
}
function looksLikeQuestion(text) {
  const s = String(text || '').trim();
  if (/[?？]\s*$/.test(s)) return true;
  return /(吗|呢|怎么样|如何|是什么|为什么|为啥|哪个|多少|几点)\s*[。？?]?$/.test(s);
}

function ownerFor({ channel, user, group }) {
  return channel === 'group' && group ? 'g:' + group : 'u:' + (user || 'unknown');
}

/* ---------------- 记忆写入（自动 + 手动共用） ---------------- */
async function rememberConversation(text, { owner, user, channel, group, source = 'auto' }) {
  if (!CFG.remember.enabled) return null;
  const body = String(text || '').trim();
  if (body.length < CFG.remember.minChars) return null;
  if (/^[\s\p{Emoji}\p{P}]+$/u.test(body)) return null;
  if (looksLikeQuestion(body)) return null;

  let extracted = null;
  if (CFG.llm.apiKey) {
    const parsed = await extractWithLLM(body, CFG.llm);
    if (parsed?.skip) return null;
    extracted = normalize(parsed);
  }
  const rec = extracted || fallback([{ who: user || '用户', text: body }]);

  // 可选语义向量：配了 Ollama 才算，失败不阻断记忆（语义路退回 0）
  let vector;
  const embedder = makeEmbedder(CFG.embed);
  if (embedder) { try { vector = await embedder(rec.summary || body); } catch { vector = undefined; } }

  return store.insertMemory({
    text: rec.summary || body.slice(0, 800),
    kind: rec.kind,
    importance: rec.importance ?? CFG.remember.importance,
    valence: rec.valence,
    entities: (rec.entities || []).map((e) => e.name || e),
    pin: rec.pin === true,
    owner: ownerFor({ channel, user, group }),
    visibility: channel === 'group' ? 'group' : 'private',
    source,
    vector,
  });
}

/* ---------------- /v1 代理 ---------------- */
async function handleChatCompletions(req, res, body) {
  const owner = String(body.user || body.user_id || '').trim();
  if (!owner) return err(res, 400, '必须带 user 字段（如 "qq:10001"），避免不同用户的记忆混在一起');
  const channel = String(req.headers['x-channel'] || body.channel || 'private').toLowerCase() === 'group' ? 'group' : 'private';
  const group = String(req.headers['x-group'] || body.group || '').trim();

  if (!CFG.upstream.baseUrl) {
    return err(res, 503, '未配置上游模型（upstream.baseUrl）。只做记忆时请用 /recall 与 /remember');
  }

  const messages = Array.isArray(body.messages) ? body.messages.slice() : [];
  const userText = lastUserText(messages);

  /* 1) 注入记忆 */
  let block = '';
  if (userText) {
    const hits = await recall(userText, {
      owner, group, channel,
      k: CFG.recall.k, minScore: CFG.recall.minScore,
    });
    block = blockOf(hits);
    if (CFG.debug) log(`召回 ${hits.length} 条 [${hits.map((h) => h.score).join(',')}]`);
  }
  if (block) {
    const memorySystem = { role: 'system', content: '以下是你记得的旧事，用来接话，不要逐条复述：\n' + block };
    const sysIdx = messages.findIndex((m) => m?.role === 'system');
    if (sysIdx >= 0) {
      const old = typeof messages[sysIdx].content === 'string' ? messages[sysIdx].content : '';
      messages[sysIdx] = { ...messages[sysIdx], content: (old ? old + '\n\n' : '') + memorySystem.content };
    } else messages.unshift(memorySystem);
  }

  /* 2) 转发上游 */
  const payload = { ...body, model: body.model || CFG.upstream.model, messages };
  delete payload.user; delete payload.user_id; delete payload.channel; delete payload.group;

  let upRes;
  try {
    upRes = await fetch(CFG.upstream.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(CFG.upstream.apiKey ? { Authorization: 'Bearer ' + CFG.upstream.apiKey } : {}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(180000),
    });
  } catch (e) {
    return err(res, 502, '连不上上游模型：' + e.message);
  }

  /* 流式透传 */
  if (body.stream) {
    res.writeHead(upRes.status, {
      'Content-Type': upRes.headers.get('content-type') || 'text/event-stream',
      'Cache-Control': 'no-cache', Connection: 'keep-alive',
    });
    for await (const chunk of upRes.body) res.write(chunk);
    res.end();
    if (upRes.ok && userText) {
      rememberConversation(userText, { owner, user: owner.replace(/^u:/, ''), channel, group }).catch(() => {});
    }
    return;
  }

  const text = await upRes.text();
  res.writeHead(upRes.status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);

  if (upRes.ok && userText) {
    rememberConversation(userText, { owner, user: owner.replace(/^u:/, ''), channel, group }).catch(() => {});
  }
}

/* ---------------- /brain：面板数据 ---------------- */
function brainData() {
  const s = store.load();
  const active = s.memories.filter((m) => m.status === 'active');
  const entityNodes = Object.entries(s.entities).map(([name, e]) => ({
    id: 'e:' + name, label: name, type: 'entity', etype: e.type, weight: e.count,
  }));
  const memNodes = active.slice(-300).map((m) => ({
    id: 'm:' + m.id, label: m.text.slice(0, 24), type: 'memory', kind: m.kind,
    weight: 1 + m.hits, pin: m.pin, owner: m.owner,
  }));
  const nodeIds = new Set([...entityNodes.map((n) => n.id), ...memNodes.map((n) => n.id)]);
  const edges = [];
  for (const m of active.slice(-300)) {
    for (const e of m.entities) {
      if (nodeIds.has('e:' + e)) edges.push({ s: 'm:' + m.id, t: 'e:' + e, w: 1 });
    }
  }
  for (const r of s.relations.slice(-200)) {
    if (nodeIds.has('e:' + r.src) && nodeIds.has('e:' + r.dst)) edges.push({ s: 'e:' + r.src, t: 'e:' + r.dst, w: 2, label: r.relation });
  }
  return { nodes: [...entityNodes, ...memNodes], edges, stats: store.stats() };
}

/* ---------------- 路由 ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const auth = () => !CFG.token || (req.headers.authorization === 'Bearer ' + CFG.token);

  try {
    /* 面板（静态）：/panel 现在是 v2 多星图面板，旧版保留在 /panel-legacy */
    if (req.method === 'GET' && (p === '/' || p === '/panel')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(HERE, 'public', 'panel-v2.html')));
    }
    if (req.method === 'GET' && p === '/panel-legacy') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(HERE, 'public', 'panel.html')));
    }
    if (req.method === 'GET' && p === '/brain') return ok(res, brainData());

    /* 健康 */
    if (req.method === 'GET' && p === '/health') {
      return ok(res, {
        version: VERSION,
        uptimeSec: Math.floor((Date.now() - STARTED) / 1000),
        llm: !!CFG.llm.apiKey,
        upstream: !!CFG.upstream.baseUrl,
        ...store.stats(),
      });
    }

    /* 其余接口都要鉴权（配置了 token 时） */
    if (!auth()) return err(res, 401, 'unauthorized：请带 Authorization: Bearer <MEMORY_TOKEN>');

    if (req.method === 'GET' && p === '/stats') return ok(res, store.stats());

    /* v2 星图载荷：瘦节点 + 聚合，完整原文不进星图载荷 */
    if (req.method === 'GET' && p === '/atlas') {
      const q = url.searchParams;
      return ok(res, buildAtlas(store.load(), {
        kind: q.get('kind') || '',
        days: Number(q.get('days')) || 0,
        includeArchived: q.get('archived') === '1',
        includeSuperseded: q.get('superseded') === '1',
        limit: Math.min(1000, Math.max(50, Number(q.get('limit')) || 500)),
      }));
    }
    /* 模拟衰减预览：纯计算，绝不写库 */
    if (req.method === 'GET' && p === '/simulate-decay') {
      const daysAhead = Number(url.searchParams.get('days')) || 30;
      const mems = store.load().memories.filter((m) => m.status === 'active');
      return ok(res, {
        daysAhead,
        preview: mems.slice(0, 200).map((m) => ({ id: m.id, retention: retentionAt(m, daysAhead) })),
      });
    }
    /* 单条详情：点节点时才取完整原文 */
    if (req.method === 'GET' && p.startsWith('/memory/')) {
      const mem = store.getMemory(p.slice('/memory/'.length));
      if (!mem) return err(res, 404, '记忆不存在');
      const { vector, ...rest } = mem;
      return ok(res, rest);
    }
    if (req.method === 'GET' && p === '/export') return ok(res, exportData(store.load()));
    if (req.method === 'POST' && p === '/import') {
      const body = JSON.parse(await readBody(req) || '{}');
      const v = validateImport(body);
      if (!v.ok) return err(res, 400, v.error);
      return ok(res, store.importMemories(v.data, { replace: body.replace === true }));
    }

    if (req.method === 'POST' && p === '/remember') {
      const body = JSON.parse(await readBody(req) || '{}');
      const text = String(body.text || '').trim();
      if (!text) return err(res, 400, 'text 不能为空');
      const channel = body.channel === 'group' || (!body.user && body.group) ? 'group' : 'private';
      const mem = store.insertMemory({
        text,
        kind: body.kind,
        importance: body.importance,
        valence: body.valence,
        entities: (body.entities || []).map((e) => (typeof e === 'string' ? e : e.name)),
        pin: body.pin === true,
        owner: body.owner || ownerFor({ channel, user: body.user, group: body.group }),
        visibility: body.visibility || (channel === 'group' ? 'group' : 'private'),
        source: body.source || 'manual',
        vector: Array.isArray(body.vector) ? body.vector : undefined,
      });
      // 冲突标记：新事实取代旧事实时，旧的只标记 superseded，不删除
      let superseded = null;
      if (body.supersedes) {
        superseded = store.supersede(String(body.supersedes), mem.id, body.superseded_reason || '');
      }
      return ok(res, { id: mem.id, text: mem.text, kind: mem.kind, owner: mem.owner, superseded: superseded?.id || null });
    }

    if (req.method === 'POST' && p === '/recall') {
      const body = JSON.parse(await readBody(req) || '{}');
      const channel = body.channel === 'group' || (!body.user && body.group) ? 'group' : 'private';
      const embedder = body.embed === false ? null : makeEmbedder(CFG.embed);
      const hits = await recall(String(body.query || ''), {
        owner: body.user || '',
        group: body.group || '',
        channel,
        k: Number(body.k) || CFG.recall.k,
        minScore: Number.isFinite(Number(body.minScore)) ? Number(body.minScore) : CFG.recall.minScore,
        explain: body.explain === true,
        moodValence: body.mood_valence,
        embed: embedder,
      });
      return ok(res, { hits, block: blockOf(hits) });
    }

    if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/agent/chat')) {
      const body = JSON.parse(await readBody(req) || '{}');
      return await handleChatCompletions(req, res, body);
    }

    if ((req.method === 'POST' || req.method === 'GET') && p === '/nightly') {
      return ok(res, nightly());
    }

    if (req.method === 'POST' && p === '/digest') {
      /* 立即做一次"昨日三件事" */
      const body = JSON.parse(await readBody(req) || '{}');
      const since = Date.now() - 86400000;
      const high = store.load().memories
        .filter((m) => m.status === 'active' && m.created_at >= since && m.importance >= 0.5)
        .sort((a, b) => b.importance - a.importance).slice(0, 10);
      if (!high.length) return ok(res, { note: '昨天没有值得记的大事' });
      let rec;
      if (CFG.llm.apiKey) {
        const parsed = await extractWithLLM(high.map((m) => '- ' + m.text).join('\n'), CFG.llm);
        rec = parsed && !parsed.skip ? normalize(parsed) : null;
      }
      if (!rec) rec = fallback(high.map((m) => ({ who: '昨天', text: m.text })));
      const mem = store.insertMemory({
        text: '【昨日三件事】' + rec.summary, kind: 'digest', importance: 0.8,
        owner: 'global', visibility: 'public',
        entities: rec.entities.map((e) => e.name), source: 'digest',
      });
      return ok(res, { id: mem.id, summary: rec.summary });
    }

    return err(res, 404, 'not found: ' + p);
  } catch (e) {
    return err(res, 500, e.message || String(e));
  }
});

server.listen(CFG.port, CFG.host, () => {
  log(`大肥鱼记忆引擎 v${VERSION} 已启动  http://${CFG.host}:${CFG.port}`);
  log(`  面板     : http://${CFG.host}:${CFG.port}/panel`);
  log(`  代理端点 : ${CFG.upstream.baseUrl ? CFG.upstream.baseUrl : '(未配置 upstream，/v1 不可用)'}`);
  log(`  LLM 抽取 : ${CFG.llm.apiKey ? '已配置' : '未配置（用规则兜底）'}`);
  log(`  Embedding: ${CFG.embed.baseUrl ? CFG.embed.baseUrl + ' / ' + CFG.embed.model : '未配置（语义路为 0）'}`);
  log(`  星图面板 : http://${CFG.host}:${CFG.port}/panel  ·  旧版 /panel-legacy  ·  数据 /atlas`);
  log(`  鉴权     : ${CFG.token ? '已开启' : '未开启（仅本机使用）'}`);
  store.flush();
});
