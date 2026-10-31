# 🧠 dafenyu-memory — 大肥鱼记忆引擎

> v2.0.0：多星图 Atlas 面板（总览星海 / 时间遗忘 / 人格核心环 / 实体子图 / 唤起热力）+ 导出导入 + 冲突取代 + 可选 Ollama embedding。改动、研究来源与诚实边界见 [docs/V2.md](docs/V2.md)。旧版面板在 `/panel-legacy`。

**给 AI QQ 机器人一副跨会话的长期记忆。** 零依赖 · 单文件部署 · 自带"大脑"可视化面板。

> 她不再隔一天就忘了你。她记得你不吃香菜、记得约好周五开黑、记得她上周读《三体》——
> 而且**群里绝不知道你们私聊说过什么**。

[![Node](https://img.shields.io/badge/node-%E2%89%A518-blue)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Deps](https://img.shields.io/badge/依赖-0-brightgreen)](#快速开始)
[![Tests](https://img.shields.io/badge/自测-14%20通过-9cf)](scripts/test.mjs)
[![M8ven Verified](https://m8ven.ai/badge/mcp/qqbot-hub-dafenyu-memory-1rrmes?v=27ccc599f2a310ff1ef41fe4ff037c79&variant=verified)](https://m8ven.ai/mcp/qqbot-hub-dafenyu-memory-1rrmes?s=readme)

---

## 它解决什么

把大模型接进 QQ 之后，机器人最大的问题不是不聪明，而是**没有记性**：

| 现状 | 装上本引擎 |
| --- | --- |
| 隔一天就失忆 | 跨会话记住长期事实、约定、偏好 |
| 上下文越滚越长，越来越贵 | 每轮只注入 ≤1400 字节的相关记忆，成本恒定 |
| 群里随口说出私聊的秘密 | **owner + visibility 双重隔离**，隐私红线写进引擎 |
| "最近/怎么样"这类虚词干扰检索 | 停用词 + IDF 加权，问"团子最近怎么样"就命中团子 |

**与链路无关**：只要求"客户端能把请求发给我"，不管你用 SnowLuma / NapCat / Lagrange，
不管桥接是 qq-bridge 还是 SurfCore。

## 快速开始

```bash
git clone https://github.com/qqbot-hub/dafenyu-memory.git
cd dafenyu-memory
node server.mjs          # http://127.0.0.1:8790  ·  面板 /panel
node scripts/test.mjs    # 14 项自测（用临时目录，不污染数据）
```

**接入（OpenAI 兼容代理）**：在 `config.json` 里填 `upstream`（你的 DeepSeek Key），
然后把客户端的 `base_url` 改成 `http://127.0.0.1:8790/v1`。之后每一轮对话：

1. 自动检索相关记忆，注入 system prompt
2. 转发给真正的模型
3. 自动把值得记的内容写回记忆库

请求必须带 `user`（如 `"qq:10001"`），群聊另带 `x-channel: group` 与 `x-group: 群号`。
不带 user 会返回 400——**这是为了不让所有人的记忆混在一起**。

```bash
curl -X POST http://127.0.0.1:8790/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-channel: group" -H "x-group: 888" \
  -d '{"user":"qq:10001","messages":[{"role":"user","content":"我的猫叫什么来着"}]}'
```

## 大脑面板

打开 `http://127.0.0.1:8790/panel`：

- 力导向实时图：记忆按类型着色（事件/事实/偏好/关系/技能/元记忆），实体按提及次数变大
- 拖拽节点、滚轮缩放、点节点看她记得的原文
- 顶栏 KPI：记忆数 / 实体 / 关系 / 被想起次数 / 已遗忘
- 一键夜巡：衰减 → 归档 → 合并 → 清除，当场报数字

## 记忆怎么运作

```
每轮对话（零成本）  →  值得记的自动写入（LLM 抽摘要，没配 LLM 用规则兜底）
                        每条带 owner + visibility + kind + importance + 实体
检索（毫秒级）      →  五路打分融合：
                        0.46 关键词(IDF) + 0.18 语义(可选) + 0.14 重要性
                      + 0.11 新鲜度(半衰期14天) + 0.11 实体图谱扩散
                      → 意图重排 → 相似去重 → 分数门槛 → Top-K 注入
每晚夜巡            →  衰减 ×0.995 → 归档(低价值/30天未想起) → 合并(相似≥0.92) → 清除(180天)
每周                →  "昨天印象最深的三件事"沉淀为元记忆
```

**三条铁律**：

1. **被想起 = 续命**：命中的记忆刷新 `last_hit`，半衰期重新计算（间隔重复效应）
2. **性格底色永不淘汰**：`pin` 的记忆（称呼/账号/约定）不参与衰减；夜间整理跳过
3. **隐私优先**：`visibility=private` 的记忆在任何群聊场合都召不回——这条在引擎里，不靠提示词

## 五类记忆 + 元记忆

| kind | 含义 | 例 |
| --- | --- | --- |
| `episode` | 发生了什么 | 周五晚九点约好开黑 |
| `fact` | 事实 | 养了只叫团子的橘猫 |
| `preference` | 偏好 | 不吃香菜 |
| `relation` | 关系 | 小美是老王的妹妹 |
| `skill` | 学会的做法 | 他说困了就该劝睡觉 |
| `digest` | 元记忆 | 【昨日三件事】…（夜巡产物，永不衰减） |

## 对比主流方案（为什么造这个轮子）

调研过的项目：[mem0](https://github.com/mem0ai/mem0)（41k★ 记忆层）、[Letta/MemGPT](https://github.com/letta-ai/letta)（19k★ Agent 运行时）、[MemU](https://zylos.ai/research/2026-01-09-memu-memory-framework)（文件系统派）、[Zep](https://github.com/getzep/zep)（图数据库派）、[memory-brain](https://github.com/peterpoal134/memory-brain)（AstrBot 记忆层，AGPL）。

| | 它们 | 本引擎 |
| --- | --- | --- |
| 定位 | 记忆层 / 运行时 | **记忆层**（轻量，可插任何链路） |
| 依赖 | Python + 向量库/图库/Postgres | **零依赖**（纯 Node 内置模块） |
| 中文检索 | 语义为主 | **关键词 IDF 主导**（实测中文短句更可靠，权重来自 memory-brain 的评估集结论） |
| 多用户隔离 | 各有方案 | **owner 字段进引擎**（memory-brain 实测无 user 维度，群里会串记忆——本引擎从表结构上解决） |
| 隐私场合 | 部分有 | **visibility 三态**（public/private/group），群聊场合召不回 private |
| 噪声治理 | 阈值不一 | 停用词 + IDF + minScore 门槛（实测修复"最近"压过"团子"的问题） |
| 可视化 | 面板/无 | 自带力导向"大脑"面板，零依赖 |
| 许可 | Apache/AGPL 混杂 | MIT |

完整调研与实测记录见 [docs/DESIGN.md](docs/DESIGN.md)。

## 接入 qqbot-plugins 插件市场

仓库 `mcp/memory_brain.mjs` 是市场插件（`mem_recall` / `mem_remember` / `mem_stats`），
复制到市场 `plugins/` 并把条目加进 `data/catalog/plugins.json` 即可。
让模型**主动**回忆与记录；自动注入则由代理模式承担。

## 配置

`config.json`（参考 `docs/API.md`），全部字段可用环境变量覆盖：

| 字段 | 说明 |
| --- | --- |
| `port` / `host` | 监听，默认 `8790` / `127.0.0.1` |
| `token` | 鉴权令牌；暴露到非本机时**必须**设置 |
| `upstream.baseUrl / apiKey / model` | 代理上游（DeepSeek 等），不配则 `/v1` 不可用（其余接口正常） |
| `llm.*` | 记忆抽取用的 LLM；不配走规则兜底 |
| `recall.minScore / maxBytes / maxItems` | 门槛与注入预算 |
| `remember.enabled / minChars` | 自动记忆开关与最短长度 |

## 定时任务（可选）

```bash
node scripts/nightly.mjs             # 衰减/归档/合并/清除，打印数字
node scripts/nightly.mjs --digest    # 附带昨日三件事（需配 llm）
```

Windows 任务计划：每天 22:05 跑一次即可。手动触发也可以 `curl -X POST http://127.0.0.1:8790/nightly`。

## API

全部接口（含实测请求/响应）见 [docs/API.md](docs/API.md)。核心三个：

```bash
# 写入
curl -X POST http://127.0.0.1:8790/remember -H "Content-Type: application/json" \
  -d '{"text":"他不吃香菜","kind":"preference","importance":0.7,"user":"qq:10001"}'

# 检索
curl -X POST http://127.0.0.1:8790/recall -H "Content-Type: application/json" \
  -d '{"query":"团子","user":"qq:10001","channel":"private"}'

# 统计
curl http://127.0.0.1:8790/stats
```

## 自测

```bash
node scripts/test.mjs
```

14 项：建库、噪声修复、用户隔离、场合隔离、跨群隔离、钉住激活/不滥用、touch 续命、去重、夜间衰减、权重约定。全部用临时目录，不碰真实数据。

## 安全提醒

- `8780/8790` 这类服务**不要暴露公网**：代理模式会把你的 upstream Key 拿去用
- 记忆库是明文 JSON（`data/brain.json`），含用户聊天内容，注意备份与隐私
- `visibility=private` 是引擎级保证，但最终请遵守你所在平台的规则与当地法律

## License

MIT © [qqbot-hub](https://github.com/qqbot-hub)

致谢：打分权重与实体图谱思路来自 [memory-brain](https://github.com/peterpoal134/memory-brain)（AGPL，本项目仅借鉴思路、全部代码重写）；
分层与预算思想来自 [Companion-AI-Memory](https://github.com/) 与 dsh-chain；架构调研参考 [mem0](https://github.com/mem0ai/mem0) 与 [Letta](https://github.com/letta-ai/letta)。
