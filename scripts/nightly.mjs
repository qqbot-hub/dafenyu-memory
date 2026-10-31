#!/usr/bin/env node
/* ============================================================
 * nightly.mjs —— 夜间整理（每天 22:05 由任务计划或手动触发）
 *
 *   node scripts/nightly.mjs                # 衰减/归档/合并/清除
 *   node scripts/nightly.mjs --digest       # 附带昨日"三件事"（需要 LLM 配置，可选）
 *
 * 做完必须打印数字（自证），说不出数的等于没做。
 * ============================================================ */
'use strict';

import fs from 'node:fs';
import * as store from '../lib/store.mjs';
import { nightly } from '../lib/engine.mjs';
import { extractWithLLM, fallback } from '../lib/extract.mjs';

const DAY = 86400000;
const argDigest = process.argv.includes('--digest');

function loadLLMConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync('config.json', 'utf8')); } catch { /* 无配置文件 */ }
  return {
    baseUrl: process.env.MEMORY_LLM_BASE || cfg.llm?.baseUrl || '',
    apiKey: process.env.MEMORY_LLM_KEY || cfg.llm?.apiKey || '',
    model: process.env.MEMORY_LLM_MODEL || cfg.llm?.model || 'deepseek-chat',
  };
}

async function main() {
  const result = nightly();
  const s = store.stats();

  let digestNote = '（未执行 --digest）';
  if (argDigest) {
    const llm = loadLLMConfig();
    const since = Date.now() - DAY;
    const episodes = store.readEpisodes(since);
    const highValue = store.load().memories
      .filter((m) => m.status === 'active' && m.created_at >= since && (m.importance >= 0.6 || Math.abs(m.valence) >= 0.4))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 10);

    let threeThings;
    if (llm.apiKey && highValue.length) {
      const conv = highValue.map((m) => `- ${m.text}`).join('\n');
      const parsed = await extractWithLLM(conv, llm);
      threeThings = parsed && !parsed.skip ? parsed : null;
    }
    if (!threeThings && highValue.length) {
      threeThings = fallback(highValue.map((m) => ({ who: m.owner, text: m.text })));
    }

    if (threeThings && !threeThings.skip) {
      const mem = store.insertMemory({
        text: `【昨日三件事】${threeThings.summary}`,
        kind: 'digest',
        importance: 0.8,
        owner: 'global',
        visibility: 'public',
        entities: (threeThings.entities || []).map((e) => e.name || e),
        source: 'digest',
        meta: { digestOf: new Date(Date.now() - DAY).toISOString().slice(0, 10) },
      });
      store.appendDigest({ at: Date.now(), id: mem.id, summary: threeThings.summary });
      digestNote = `已写入元记忆 ${mem.id}`;
    } else {
      digestNote = '昨天没有值得记的大事（正常）';
    }
  }

  const paths = store.persistPath();
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log('══════════════════════════════════════');
  console.log(`夜巡完成 ${stamp}`);
  console.log(`衰减 ${result.decayed} 条 · 归档 ${result.archived} 条 · 合并 ${result.merged} 组 · 清除 ${result.purged} 条`);
  console.log(`当前活跃 ${result.active} 条 · 实体 ${s.entities} 个 · 关系 ${s.relations} 条`);
  console.log(`元记忆：${digestNote}`);
  console.log(`数据：${paths.brain}`);
  console.log('══════════════════════════════════════');
  store.flush();
}

main().catch((e) => { console.error('夜巡失败:', e.message); process.exit(1); });
