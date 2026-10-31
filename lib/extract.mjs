/* ============================================================
 * extract.mjs —— 对话 → 结构化记忆（LLM 优先，规则兜底）
 *
 * 提示词参照 memory-brain 的 extractor 重写：摘要 + 类型 + 情绪 + 实体 + 关系。
 * 模型输出不合法 → 返回 null，调用方走规则兜底（不阻塞）。
 * ============================================================ */
'use strict';

const KINDS = new Set(['episode', 'fact', 'preference', 'relation', 'skill']);
const ENTITY_TYPES = new Set(['person', 'place', 'thing', 'topic', 'skill']);

const SYSTEM_PROMPT = '你在整理一个 AI 角色的长期记忆。只输出 JSON，不要解释、不要 Markdown 代码块。';

const USER_PROMPT = `下面是一段对话，请整理成一条记忆，输出 JSON：

{{
  "summary": "一句话概括，不超过 80 字，用第三人称（他/她）",
  "kind": "episode|fact|preference|relation|skill",
  "importance": 0.5,
  "valence": 0.0,
  "entities": [{{"name": "实体名", "type": "person|place|thing|topic|skill"}}],
  "pin": false
}}

规则：
- 只写对话里真实出现的信息，不编造、不脑补。
- summary 要能单独看懂，别写"他们聊了聊"这种空话。
- entities 只取有长期价值的人、地点、物件、话题；忽略"嗯""哈哈"这类语气词。
- importance：寒暄 0.2、日常 0.4、约定/偏好 0.6、重要事件或情绪波动 0.8。
- valence：-1 很糟 到 1 很好。
- pin：涉及称呼、账号、长期约定这类"每次都该记得"的信息时为 true。
- 如果只是问问题、没有新信息，输出 {{"skip": true}}。

对话：
{conversation}
`;

export function buildPrompt(conversation) {
  return USER_PROMPT.replace('{conversation}', String(conversation || '').slice(0, 3000));
}

export function parseJson(text) {
  if (!text) return null;
  let raw = String(text).trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fence) raw = fence[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(raw.slice(start, end + 1));
    return data && typeof data === 'object' ? data : null;
  } catch { return null; }
}

const clip = (v, lo, hi, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};

/** 校验并裁剪模型输出；不可用返回 null */
export function normalize(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.skip === true) return { skip: true };
  const summary = String(payload.summary || '').replace(/\s+/g, ' ').trim();
  if (summary.length < 4) return null;
  let kind = String(payload.kind || 'episode').toLowerCase();
  if (!KINDS.has(kind)) kind = 'episode';

  const entities = [];
  const seen = new Set();
  for (const item of Array.isArray(payload.entities) ? payload.entities.slice(0, 12) : []) {
    const name = String(typeof item === 'string' ? item : item?.name || '').trim().slice(0, 30);
    if (!name || seen.has(name)) continue;
    let type = String(typeof item === 'object' ? item?.type : 'thing').toLowerCase();
    if (!ENTITY_TYPES.has(type)) type = 'thing';
    seen.add(name);
    entities.push({ name, type });
  }

  return {
    summary: summary.slice(0, 300),
    kind,
    importance: clip(payload.importance, 0.05, 1, 0.45),
    valence: clip(payload.valence, -1, 1, 0),
    entities,
    pin: payload.pin === true,
  };
}

/** 没有模型时的规则兜底：拼原文 + 发言人当人物节点 */
export function fallback(rows) {
  const text = rows.map((r) => `${r.who || '用户'}：${String(r.text || '').slice(0, 120)}`).join('；').slice(0, 500);
  const names = [...new Set(rows.map((r) => r.who).filter(Boolean))].slice(0, 8);
  return {
    summary: text,
    kind: 'episode',
    importance: 0.4,
    valence: 0,
    entities: names.map((n) => ({ name: n, type: 'person' })),
    pin: false,
    fallback: true,
  };
}

/** 调 LLM 抽取（OpenAI 兼容）。失败返回 null */
export async function extractWithLLM(conversation, { baseUrl, apiKey, model, timeoutMs = 30000 }) {
  if (!baseUrl || !apiKey) return null;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(String(baseUrl).replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: model || 'deepseek-chat',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildPrompt(conversation) },
        ],
        temperature: 0.2,
        max_tokens: 500,
      }),
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    return parseJson(text);
  } catch {
    return null;
  } finally { clearTimeout(t); }
}
