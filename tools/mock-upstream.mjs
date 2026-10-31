/* 离线自测用的假模型（OpenAI 兼容）：不出网、不花钱。
 * 用法：node tools/mock-upstream.mjs   （监听 8799）
 * 收到的请求体存到系统临时目录 cap.json，用来检查记忆有没有被注入。 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const CAP = path.join(os.tmpdir(), 'cap.json');
http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    fs.writeFileSync(CAP, b || '{}');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'mock', object: 'chat.completion', model: 'mock', created: Date.now() / 1000,
      choices: [{ index: 0, message: { role: 'assistant', content: '好（假模型回复）' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
    }));
  });
}).listen(8799, '127.0.0.1', () => console.log('mock upstream on 8799'));
