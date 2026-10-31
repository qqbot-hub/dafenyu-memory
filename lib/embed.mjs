/* ============================================================
 * embed.mjs —— 可选 embedding 客户端（Ollama，默认 bge-m3）
 * 不配就不启用，语义路为 0，不报错；配了但连不上也只降级，不阻断记忆。
 * ============================================================ */
'use strict';

/** 返回 async (text) => number[] | null；未配置返回 null */
export function makeEmbedder(cfg = {}) {
  const baseUrl = (cfg.baseUrl || process.env.MEMORY_EMBED_URL || '').replace(/\/+$/, '');
  const model = cfg.model || process.env.MEMORY_EMBED_MODEL || 'bge-m3';
  if (!baseUrl) return null;
  return async (text) => {
    const body = JSON.stringify({ model, input: String(text || '').slice(0, 4000) });
    // 先试 /api/embed（Ollama 新接口），失败再试 /api/embeddings
    for (const path of ['/api/embed', '/api/embeddings']) {
      try {
        const res = await fetch(baseUrl + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: path === '/api/embed' ? body : JSON.stringify({ model, prompt: String(text || '').slice(0, 4000) }),
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) continue;
        const data = await res.json();
        const vec = data.embeddings?.[0] || data.embedding || null;
        if (Array.isArray(vec) && vec.length) return vec;
      } catch { /* 降级到下一接口 / 返回 null */ }
    }
    return null;
  };
}
