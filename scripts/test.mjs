#!/usr/bin/env node
/* ============================================================
 * test.mjs —— 自测：复刻 memory-brain 的实测场景 + 验证四个缺陷已修复
 *
 *   node scripts/test.mjs
 *
 * 全部用临时数据目录（MEMORY_DATA_DIR），不碰真实数据。
 * ============================================================ */
'use strict';

process.env.MEMORY_DATA_DIR = process.env.MEMORY_DATA_DIR
  || os.tmpdir().replace(/\\/g, '/') + '/dafenyu-test-' + Date.now();

import fs from 'node:fs';
import os from 'node:os';
import * as store from '../lib/store.mjs';
import { recall, nightly, cleanQuery, visibleIn, W } from '../lib/engine.mjs';

let pass = 0, fail = 0;
const ok = (name, extra = '') => { pass++; console.log('✅', name, extra); };
const bad = (name, why) => { fail++; console.log('❌', name, '→', why); };

async function main() {
  console.log('数据目录:', process.env.MEMORY_DATA_DIR, '\n');

  /* ── ① 建库：复刻 memory-brain 实测的数据 ── */
  store.insertMemory({ text: '他最近在读《三体》，读到第二部了', kind: 'fact', importance: 0.6, owner: 'global', visibility: 'public', entities: ['三体'] });
  store.insertMemory({ text: '他养了一只叫团子的橘猫，很粘人', kind: 'fact', importance: 0.8, owner: 'global', visibility: 'public', entities: ['团子'] });
  store.insertMemory({ text: '他不吃香菜，闻到就难受', kind: 'preference', importance: 0.7, owner: 'u:qq:10001', visibility: 'private' });
  store.insertMemory({ text: '周五晚上九点约好一起开黑', kind: 'episode', importance: 0.6, owner: 'g:888', visibility: 'group' });
  ok('建库 4 条（含 owner/visibility 标注）');

  /* ── ② 噪声测试（memory-brain 的翻车场景）── */
  const r1 = await recall('团子最近怎么样', { owner: 'qq:10001', channel: 'private', k: 3, minScore: -1 });
  const top = r1[0];
  if (top && top.text.includes('团子')) ok('噪声修复：「团子最近怎么样」命中团子', `score=${top.score}`);
  else bad('噪声修复', '第一名是「' + (top ? top.text : '空') + '」');

  const cleaned = cleanQuery('团子最近怎么样');
  if (!cleaned.some(t => t.includes('最近'))) ok('查询清洗：虚词「最近」被剔除', cleaned.join(','));
  else bad('查询清洗', '仍包含「最近」: ' + cleaned.join(','));

  /* ── ③ 用户隔离（memory-brain 没有的）── */
  const r2 = await recall('香菜', { owner: 'qq:99999', channel: 'private', k: 5, minScore: -1 });
  if (!r2.some(h => h.text.includes('香菜'))) ok('用户隔离：别人问不到 10001 的私聊记忆');
  else bad('用户隔离', '99999 居然召回了 10001 的记忆');

  const r3 = await recall('香菜', { owner: 'qq:10001', channel: 'private', k: 5, minScore: -1 });
  if (r3.some(h => h.text.includes('香菜'))) ok('本人可召回：10001 能想起不吃香菜', `score=${r3[0].score}`);
  else bad('本人可召回', '没召回');

  /* ── ④ 场合隔离：群里不能召回私聊的话 ── */
  const r4 = await recall('香菜 开黑 团子', { owner: 'qq:10001', group: '888', channel: 'group', k: 8, minScore: -1 });
  if (!r4.some(h => h.text.includes('香菜'))) ok('场合隔离：群里召不回 private 记忆');
  else bad('场合隔离', '群里召回了私聊记忆！');
  if (r4.some(h => h.text.includes('开黑'))) ok('群记忆：本群能召回群里的约定');
  else bad('群记忆', '没召回');
  if (!r4.some(h => h.owner === 'g:999')) ok('跨群隔离：别的群的内容不在');

  /* ── ⑤ 钉住（pin）── */
  store.insertMemory({ text: '他的 QQ 号是 123456789', kind: 'fact', importance: 0.6, owner: 'u:qq:10001', visibility: 'private', pin: true });
  const r5a = await recall('他的QQ号是多少', { owner: 'qq:10001', channel: 'private', k: 3, minScore: -1 });
  if (r5a[0] && r5a[0].text.includes('123456789') && r5a[0].score >= 0.9) ok('钉住激活：问对了拉满', `score=${r5a[0].score}`);
  else bad('钉住激活', JSON.stringify(r5a.slice(0, 1)));
  const r5b = await recall('团子最近怎么样', { owner: 'qq:10001', channel: 'private', k: 5, minScore: -1 });
  const pinned = r5b.find(h => h.pin);
  if (!pinned || pinned.score < 0.9) ok('钉住不滥用：没问对就不拉满', pinned ? `score=${pinned.score}` : '未召回');
  else bad('钉住不滥用', '没问对也拉满了');

  /* ── ⑥ touch 续命 ── */
  const before = store.getMemory(r1[0].id).hits;
  const r6 = await recall('团子', { owner: 'qq:10001', channel: 'private', k: 1, minScore: -1 });
  const after = store.getMemory(r1[0].id).hits;
  after > before ? ok('被想起=续命：hits 自增', `${before}→${after}`) : bad('touch 续命', '没变');

  /* ── ⑦ 去重 ── */
  store.insertMemory({ text: '他养了一只叫团子的橘猫，很粘人', kind: 'fact', importance: 0.8, owner: 'global', visibility: 'public' });
  const r7 = await recall('团子', { owner: 'qq:10001', channel: 'private', k: 10, minScore: -1 });
  const dup = r7.filter(h => h.text.includes('团子'));
  dup.length === 1 ? ok('去重：相似记忆只留一条') : bad('去重', `出现 ${dup.length} 条`);

  /* ── ⑧ 夜间整理 ── */
  const nm = nightly();
  if (nm.decayed > 0) ok('夜间衰减', `衰减 ${nm.decayed} 条`);
  else bad('夜间衰减', '没衰减任何条目');

  /* ── ⑨ 权重与约定 ── */
  const wSum = W.keyword + W.semantic + W.importance + W.recency + W.graph;
  Math.abs(wSum - 1) < 0.001 ? ok('五路权重和为 1', JSON.stringify(W)) : bad('权重', wSum);

  console.log('\n────────────────────────────');
  console.log(`通过 ${pass} · 失败 ${fail}`);
  store.flush();

  /* 清理临时目录 */
  try { fs.rmSync(process.env.MEMORY_DATA_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => { console.error('自测脚本出错:', e); process.exit(1); });
