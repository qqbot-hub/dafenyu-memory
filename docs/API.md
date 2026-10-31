# API（实测版）

> 服务默认 `http://127.0.0.1:8790`。所有响应都是 `{"status":"ok","data":{...}}` 或 `{"status":"error","message":"..."}`。
> 配置了 `token` 时，除 `/panel` `/brain` `/health` 外都要带 `Authorization: Bearer <token>`。

## 启动

```bash
node server.mjs
# 或配好 config.json 后
npm start
```

---

## POST /remember

写一条记忆。

```json
{
  "text": "他不吃香菜，闻到就难受",
  "kind": "preference",            // episode|fact|preference|relation|skill|digest|hypothesis
  "importance": 0.7,               // 0~1
  "valence": -0.3,                 // 可选，-1~1
  "pin": false,                    // 可选，钉住不衰减
  "visibility": "private",         // 可选，public|private|group
  "user": "qq:10001",              // 私聊场景：谁的语境
  "group": "888",                  // 群场景：群号（给了 group 则 owner=g:888）
  "owner": "global",               // 或者直接指定归属
  "entities": ["香菜"]             // 可选
}
```

响应：`{"status":"ok","data":{"id":"m000007","text":"...","kind":"preference","owner":"u:qq:10001"}}`

## POST /recall

```json
{
  "query": "团子最近怎么样",
  "user": "qq:10001",
  "channel": "private",            // 或 group（配合 group 字段）
  "group": "888",
  "k": 5,
  "minScore": 0.35,
  "explain": false,                // true 时带 why 打分明细
  "mood_valence": -0.5             // 可选，情绪一致性
}
```

响应：

```json
{"status":"ok","data":{
  "hits":[{"id":"m000009","text":"他养了一只叫团子的橘猫，很粘人","kind":"fact",
           "score":0.4417,"importance":0.8,"visibility":"public","created_at":1793417...,"pin":false}],
  "block":"- [2026-10-31] 他养了一只叫团子的橘猫，很粘人"
}}
```

`block` 可直接拼进 system prompt。

## POST /v1/chat/completions

OpenAI 兼容代理。请求：

```json
{"user":"qq:10001","messages":[{"role":"user","content":"团子最近怎么样"}]}
```

必带 `user`；群聊加头 `x-channel: group` 与 `x-group: <群号>`。

它按顺序做：取最后一条 user 消息 → recall → 注入 system → 转发 `upstream.baseUrl` → 返回上游响应 → 异步自动记忆（问句/太短/纯表情跳过）。

错误：
- 不带 user → 400 `必须带 user 字段…`
- 未配 upstream → 503 `未配置上游模型…`

## GET /stats

```json
{"status":"ok","data":{"active":5,"archived":0,"entities":2,"relations":0,
"kinds":{"fact":2,"preference":1,"episode":2},"owners":{"global":2,"u:qq:10001":2,"g:888":1},
"avgImportance":0.673,"added":6,"hits":26,"merged":0,"purged":0,"forgotten":0}}
```

## GET /health

版本、运行秒数、llm/upstream 配置状态 + 统计。

## GET /brain

面板数据：`{nodes:[...], edges:[...], stats:{...}}`。节点分 `type:entity|memory`。

## GET /panel

大脑面板（HTML）。

## POST /nightly

跑一次夜间整理。响应：

```json
{"status":"ok","data":{"decayed":10,"archived":1,"merged":0,"purged":0,"active":5}}
```

## POST /digest

立即提炼"昨日三件事"为元记忆（kind=digest，永不衰减）。需要配置 `llm`，没有则规则兜底。

---

## 环境变量（覆盖 config.json）

| 变量 | 对应 config |
| --- | --- |
| `MEMORY_PORT` / `MEMORY_HOST` | `port` / `host` |
| `MEMORY_TOKEN` | `token` |
| `MEMORY_LLM_BASE` / `MEMORY_LLM_KEY` / `MEMORY_LLM_MODEL` | `llm.*` |
| `MEMORY_UPSTREAM_BASE` / `MEMORY_UPSTREAM_KEY` / `MEMORY_UPSTREAM_MODEL` | `upstream.*` |
| `MEMORY_DATA_DIR` | 数据目录（默认 `<repo>/data`） |
| `MEMORY_DEBUG=1` | 打印召回分数 |

## 定时任务（Windows 示例）

```bat
schtasks /create /tn "Dafenyu.Memory" /tr "E:\dafenyu-memory\node.exe E:\dafenyu-memory\scripts\nightly.mjs" /sc daily /st 22:05
```
