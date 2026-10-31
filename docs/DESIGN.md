# 设计文档（DESIGN）

> 版本 1.0.0 · 为什么这样设计、调研了什么、修了哪些别人踩过的坑。

---

## 1. 调研：2026 年记忆方案全景

| 项目 | star | 定位 | 记忆模型 | 依赖 |
| --- | --- | --- | --- | --- |
| [mem0](https://github.com/mem0ai/mem0) | ~41k | 记忆层（可插拔） | 向量版 + 图谱版（Mem0g）双存储 | Python，向量库 |
| [Letta/MemGPT](https://github.com/letta-ai/letta) | ~19k | Agent 运行时 | Core/Recall/Archival 三级，LLM 自管 | Python 全栈 |
| [MemU](https://zylos.ai/research/2026-01-09-memu-memory-framework) | 新 | 个人记忆 | 三层文件系统 + 知识图谱 | 轻量 |
| [Zep](https://github.com/getzep/zep) | — | 记忆服务 | Postgres + Neo4j | 重 |
| [memory-brain](https://github.com/peterpoal134/memory-brain) | 30 | AstrBot 记忆层 | SQLite + FTS5 + 向量 + 图谱 | Python + numpy |
| **本引擎** | — | 记忆层（轻量） | JSON + 内存索引 + 可选向量 | **零依赖** |

两条路线的分野：**记忆层**（mem0/本引擎，挂到任意 agent）vs **运行时**（Letta，agent 本身有状态）。
社区评测（LoCoMo / LongMemEval）存在争议，选型应以自己的场景实测为准。

结论：QQ 机器人场景要的是「轻、能插、中文检索可靠、隐私可控」——现有方案没有同时满足的，所以自己写。

---

## 2. memory-brain 实测（本引擎的起点）

我们完整实测了 [memory-brain](https://github.com/peterpoal134/memory-brain)（AGPL-3.0，Python）。
**它的五路打分框架是可靠的，我们沿用其权重；但它有三个实测缺陷，本引擎从结构上修复。**

实测环境：Windows + Python 3.12 + numpy 2.5.4，逐条 curl。

### 沿用的（实测有效）

| 机制 | 实测结果 |
| --- | --- |
| 五路打分 `0.46 关键词 + 0.18 语义 + 0.14 重要性 + 0.11 新鲜度 + 0.11 图谱` | 中文短 query 关键词确实更可靠（作者评估集结论 + 我们复现） |
| `/v1` OpenAI 兼容代理自动注入 | 假 LLM 抓包证实：system 里多出"以下是你记得的旧事…" |
| `visibility`（public/private/group） | 群聊调用确实召不回 private |
| touch 续命 | `last_access` 刷新，半衰期重算 |
| 钉住（pin）+ 问法激活 | 问"QQ号"拉满 0.9，问别的只 +0.1 保底 |
| 三段式遗忘 | 衰减 → 归档 → 180 天清除 |

### 修复的（实测缺陷）

| 缺陷 | 实测复现 | 本引擎的修复 |
| --- | --- | --- |
| **无用户隔离**：`memories` 表没有 user_id，`recall` 不接收 user，全库共享 | A 说"不吃香菜"，换 B 问"吃饭"也召回 | `owner` 字段进存储与检索：`u:qq:x` / `g:群号` / `global` |
| **查询噪声**：无停用词无 IDF，"最近"命中《三体》记忆压过"团子" | 问「团子最近怎么样」→ 第一名 0.654 是《三体》，0.222 才是团子 | 停用词剔除 + IDF 加权 + minScore 门槛（复测：团子第一） |
| **无分数门槛**：k=5 硬条数，0.2 分的噪声也注入 | `/v1` 注入了 2 条，其中 1 条无关 | `minScore`（默认 0.35）+ `maxBytes`（1400）+ `maxItems`（5） |

另加两项它没有的：

- **问句不写入**：'上海那边怎么样' 不是事实，不该进记忆库
- **群记忆默认不进私聊**：防跨场合泄露（可配 `shareGroupToPrivate`）

---

## 3. 本引擎架构

```
server.mjs                HTTP：/v1 代理 + /recall /remember /stats /panel /brain /nightly
lib/
  store.mjs               存储：brain.json（原子写+防抖）+ episodes.jsonl + digests.jsonl
  engine.mjs              五路打分 / owner+visibility 过滤 / pin / 意图重排 / 去重 / 夜间整理
  extract.mjs             对话→JSON 记忆（LLM 优先，规则兜底；pin/情绪/实体）
public/panel.html         大脑面板：力导向 canvas（斥力+弹簧+阻尼），零依赖
mcp/memory_brain.mjs      插件市场适配（mem_recall / mem_remember / mem_stats）
scripts/
  nightly.mjs             夜巡入口（自证数字）
  test.mjs                14 项自测（临时数据目录）
```

### 3.1 数据模型

```js
{
  id: 'm000001',
  owner: 'u:qq:10001' | 'g:888' | 'global',   // 谁的语境（修复①）
  visibility: 'public' | 'private' | 'group',  // 场合红线
  kind: 'episode|fact|preference|relation|skill|digest|hypothesis',
  text, importance(0~1), valence(-1~1), arousal(0~1),
  entities: ['团子', '三体'],                   // 图谱节点
  pin: false,                                   // 钉住（不衰减，问对拉满）
  status: 'active' | 'archived',
  created_at, last_hit, hits,                   // touch 续命
  source: 'auto|manual|digest',
}
```

存储选 JSON 而非 SQLite：零依赖 + 单机几百到几万条完全够用 + 可直接手改手备份。
写入是"内存改 + 300ms 防抖原子落盘"，崩溃最多丢 300ms。

### 3.2 可见性语义（隐私优先）

```
群聊（channel=group, group=888）可见：
    owner=g:888（本群的事）+ owner=global + visibility=public
私聊（channel=private, owner=qq:10001）可见：
    owner=u:qq:10001（他对我说的话）+ owner=global
群记忆默认不进私聊（shareGroupToPrivate=false）——防跨场合泄露
```

### 3.3 打分细节

```
s_kw  = Σ idf(命中token) / Σ idf(全部查询token)      // IDF 让常用虚词失重
s_rec = 0.5 ^ (距 last_hit 天数 / 14)                 // 被想起就重算
s_graph = min(1, 与Top5命中共享实体数 / 3)             // 1 跳扩散
score = 0.46 s_kw + 0.18 s_sem + 0.14 s_imp + 0.11 s_rec + 0.11 s_graph
        + 0.05 意图加成(fact/episode) + 0.10 pin 保底
pin 激活 → score = max(score, 0.9)
去重 → 二元组重合度 ≥ 0.82 只留最高分
门槛 → score ≥ minScore(0.35) 才注入
```

### 3.4 成本

| 项 | 频次 | 开销 |
| --- | --- | --- |
| 写入（无 LLM） | 每轮 | 0（纯文件） |
| 写入（LLM 抽取） | 每轮 | ~200 token |
| 注入 | 每轮 | ≤1400 字节（恒定） |
| 夜巡 | 1 次/天 | 0（纯计算） |
| 三件事 | 1 次/天 | ~600 token |

---

## 4. 已知边界（诚实清单）

- **语义路默认关闭**：不配 embedding 就没有跨词面联想（"拍胶片的机器"→"胶片相机"靠实体共现补）。配 Ollama bge-m3 即可打开（`lib/engine.mjs` 的 `opts.embed`）。
- **JSON 全量加载**：十万条以上会吃内存。到时候再分片/上 SQLite，现在不提前优化。
- **关系抽取是规则兜底**：没有 LLM 时只有实体没有关系边。
- **中文分词是二元组**：不是真分词，靠 IDF + 停用词保证精度。实测够用。

---

## 5. 路线图

- [ ] embedding 适配器（Ollama / OpenAI）
- [ ] 面板加时间轴过滤
- [ ] 记忆导出/导入（迁移到别的机器）
- [ ] 与 SurfCore 记忆卡的互通适配器
