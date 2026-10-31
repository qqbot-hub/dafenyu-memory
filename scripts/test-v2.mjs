#!/usr/bin/env node
/* test-v2.mjs —— v2 新增能力自测（不碰真实数据，用临时目录） */
'use strict';
process.env.MEMORY_DATA_DIR = process.env.MEMORY_DATA_DIR
  || (await import('node:os')).tmpdir().replace(/\\/g, '/') + '/dafenyu-test-v2-' + Date.now();
import fs from 'node:fs';
import * as store from '../lib/store.mjs';
import { buildAtlas, retentionOf, retentionAt, exportData, validateImport } from '../lib/viewmodel.mjs';
import { recall } from '../lib/engine.mjs';

let pass = 0, fail = 0;
const ok = (n, e = '') => { pass++; console.log('✅', n, e); };
const bad = (n, w) => { fail++; console.log('❌', n, '→', w); };

const old = store.insertMemory({ text: '他住在杭州，喜欢西湖边的雨', kind: 'fact', importance: 0.8, owner: 'global', visibility: 'public', entities: ['杭州'] });
const pinned = store.insertMemory({ text: '她叫大肥鱼，是 DeepSeek 的鲸鱼', kind: 'fact', importance: 0.9, owner: 'global', visibility: 'public', pin: true, entities: ['大肥鱼'] });
const priv = store.insertMemory({ text: '他私聊说不吃香菜', kind: 'preference', importance: 0.7, owner: 'u:qq:10001', visibility: 'private' });

// 1. 留存度：pin 豁免，普通随时间衰减
if (retentionOf(pinned) === 1) ok('留存：pin 永不衰减'); else bad('留存 pin', retentionOf(pinned));
if (retentionAt(old, 365) < retentionOf(old)) ok('模拟衰减：+365 天后留存下降，且未写库', `${retentionOf(old)} → ${retentionAt(old, 365)}`);
else bad('模拟衰减', '未下降');
if (store.getMemory(old.id).importance === 0.8) ok('模拟衰减不写库：原重要度未变'); else bad('模拟写库', '被改了');

// 2. 星图载荷：瘦节点、分类、聚合
const atlas = buildAtlas(store.load(), {});
if (atlas.nodes.every((n) => n.type === 'entity' || n.label.length <= 20)) ok('星图载荷：节点只给短标签'); else bad('星图载荷', '有长文本');
if (atlas.stats.byCategory.core >= 1) ok('星图分类：核心至少 1 条', JSON.stringify(atlas.stats.byCategory)); else bad('星图分类', JSON.stringify(atlas.stats.byCategory));
if (atlas.timeline.length === 30 && atlas.heat.length === 28) ok('时间线 30 天 + 热力 28 天'); else bad('时间聚合', `${atlas.timeline.length}/${atlas.heat.length}`);

// 3. 冲突取代：旧的不删除，只标记
const newer = store.insertMemory({ text: '他搬到上海了', kind: 'fact', importance: 0.8, owner: 'global', visibility: 'public', entities: ['上海'] });
store.supersede(old.id, newer.id, '住址更新');
if (store.getMemory(old.id).status === 'superseded' && store.getMemory(old.id).superseded_by === newer.id) ok('冲突标记：旧事实标记 superseded，不删除'); else bad('冲突标记', store.getMemory(old.id).status);
const hits = await recall('杭州', { owner: '', channel: 'private', k: 5, minScore: -1 });
if (!hits.some((h) => h.id === old.id)) ok('被取代的记忆不再参与 active 召回'); else bad('被取代召回', '仍召回');

// 4. 导出 / 导入往返
const exp = exportData(store.load());
const v = validateImport(exp);
if (v.ok && v.data.memories.length >= 3) ok('导出导入：格式校验通过', `${v.data.memories.length} 条`); else bad('导出导入', '校验失败');
if (!validateImport({ format: 'other', memories: [] }).ok) ok('导入校验：拒绝非本格式'); else bad('导入校验', '放行了');

// 5. 隐私：星图载荷本身不做场合过滤的承诺外推——只检查 private 字段仍在节点上，可供面板过滤
const privNode = atlas.nodes.find((n) => n.memId === priv.id);
if (privNode && privNode.visibility === 'private') ok('星图节点保留 visibility，供面板过滤'); else bad('星图隐私字段', '缺失');

console.log(`\n通过 ${pass} · 失败 ${fail}`);
store.flush();
try { fs.rmSync(process.env.MEMORY_DATA_DIR, { recursive: true, force: true }); } catch {}
process.exitCode = fail ? 1 : 0;
