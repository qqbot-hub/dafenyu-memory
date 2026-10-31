/* memory_brain —— 大肥鱼记忆引擎的市场插件（mem_recall / mem_remember / mem_stats）
 *
 * 对接本仓库的 dafenyu-memory 服务（默认 http://127.0.0.1:8790）。
 * 归属过滤由引擎完成（每条记忆带 owner），插件只传身份。
 * 无第三方依赖。
 */
'use strict';
import { num, str } from './_lib.mjs';

const cfgOf = (ctx) => (ctx && ctx.cfg) || {};
const base = (ctx) => str(cfgOf(ctx).serverUrl || 'http://127.0.0.1:8790').replace(/\/+$/, '');

async function call(ctx, endpoint, payload, method = 'POST') {
  const c = cfgOf(ctx);
  const headers = { 'Content-Type': 'application/json' };
  if (c.serverToken) headers.Authorization = 'Bearer ' + c.serverToken;
  let res;
  try {
    res = await fetch(base(ctx) + endpoint, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(payload || {}),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new Error(`连不上记忆引擎（${base(ctx)}）：确认 dafenyu-memory 已启动（node server.mjs）`);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('记忆引擎返回非 JSON：' + text.slice(0, 120)); }
  if (data.status === 'error') throw new Error(data.message || '记忆引擎错误');
  return data.data;
}

/** 身份与场合：群聊记到群上，私聊记到人上 */
function identity(a) {
  const gid = num(a.group_id);
  const uid = str(a.user_id) ? 'qq:' + str(a.user_id) : '';
  const channel = gid ? 'group' : 'private';
  return { user: uid, group: gid ? String(gid) : '', channel };
}

export default {
  meta: {
    id: 'memory_brain',
    name: 'memory_brain',
    description: '大肥鱼记忆引擎：长期记忆检索/写入/统计（按人隔离、按群隔离、会遗忘、有钉住）',
    category: '群互动',
  },

  settings: {
    title: '大肥鱼记忆引擎',
    intro: '需要先在本机跑 dafenyu-memory（node server.mjs，端口 8790）。记忆自动注入请在桥接侧把 base_url 指到引擎的 /v1。',
    fields: [
      { key: 'serverUrl', label: '记忆引擎地址', type: 'text', placeholder: 'http://127.0.0.1:8790' },
      { key: 'serverToken', label: '访问令牌', type: 'password', placeholder: '留空（未开启鉴权时）' },
      { key: 'k', label: '每次召回条数', type: 'number', default: 5 },
      { key: 'minScore', label: '相关度门槛', type: 'number', default: 0.35 },
    ],
  },

  tools: [
    {
      name: 'mem_recall',
      description: '回忆和当前话题相关的旧事。群友问"你还记得…吗""上次说的"时用。自动过滤别人的私聊记忆。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词或整句话' },
          k: { type: 'number', description: '返回几条，默认 5' },
          group_id: { type: 'number', description: '群号（群聊时传）' },
          user_id: { type: 'number', description: '当前说话人 QQ 号' },
        },
        required: ['query'],
      },
      run: async (a, ctx) => {
        const c = cfgOf(ctx);
        const id = identity(a);
        const data = await call(ctx, '/recall', {
          query: str(a.query),
          k: Math.min(Math.max(Math.trunc(num(a.k) || num(c.k) || 5), 1), 12),
          minScore: Number.isFinite(Number(c.minScore)) ? Number(c.minScore) : 0.35,
          user: id.user, group: id.group, channel: id.channel,
        });
        if (!data.hits.length) return `没找到和「${str(a.query)}」相关的记忆。`;
        return '🧠 我想起来了：\n' + data.hits
          .map((h, i) => `${i + 1}. ${h.text}　（${h.kind}，${h.score}）`)
          .join('\n');
      },
    },
    {
      name: 'mem_remember',
      description: '记一条长期记忆。群友说"记住…""别忘了…"时用。涉及称呼/账号/长期约定的加 pin:true。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要记住的内容' },
          kind: { type: 'string', description: 'episode 事件 / fact 事实 / preference 偏好 / relation 关系 / skill 做法' },
          importance: { type: 'number', description: '0-1，默认 0.5；约定偏好 0.7' },
          pin: { type: 'boolean', description: '长期必须记得的（称呼/账号/约定）设 true' },
          group_id: { type: 'number', description: '群号（群聊时传）' },
          user_id: { type: 'number', description: '当前说话人 QQ 号' },
        },
        required: ['text'],
      },
      run: async (a, ctx) => {
        const text = str(a.text);
        if (!text) return '要记什么？把内容说清楚。';
        const id = identity(a);
        const mem = await call(ctx, '/remember', {
          text,
          kind: str(a.kind) || undefined,
          importance: Number.isFinite(num(a.importance)) ? num(a.importance) : 0.5,
          pin: a.pin === true,
          user: id.user, group: id.group, channel: id.channel,
          visibility: id.channel === 'group' ? 'group' : 'private',
        });
        return `🧠 记住了（${mem.id}，${mem.kind}，归属 ${mem.owner}）`;
      },
    },
    {
      name: 'mem_stats',
      description: '看记忆库规模：多少条、什么类型、平均重要度。',
      inputSchema: { type: 'object', properties: {} },
      run: async (a, ctx) => {
        const s = await call(ctx, '/stats', null, 'GET');
        const kinds = Object.entries(s.kinds || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || '空';
        return `📊 记忆库：${s.active} 条（归档 ${s.archived}）\n类型：${kinds}\n实体 ${s.entities} · 关系 ${s.relations}\n平均重要度 ${s.avgImportance} · 被想起 ${s.hits} 次`;
      },
    },
  ],
};
