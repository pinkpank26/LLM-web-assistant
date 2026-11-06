'use strict';

/**
 * Тесты тайм-аута клиента модели. Поддельный сервер отдаёт поток медленно,
 * чтобы проверить главное: тайм-аут считается как простой между фрагментами,
 * а не как общая длительность ответа.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { LLMClient } = require('../src/llmClient');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Поднимает поддельный OpenAI-совместимый сервер.
 * @param {(res: http.ServerResponse) => Promise<void>} handler
 */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        handler(res);
      });
    }).listen(0, () => resolve(server));
  });
}

const sse = (text) => `data: ${JSON.stringify({
  model: 'fake', choices: [{ delta: { content: text } }]
})}\n\n`;

async function collect(client) {
  const parts = [];
  for await (const chunk of client.chatStream([{ role: 'user', content: 'привет' }])) {
    if (chunk.type === 'delta') parts.push(chunk.text);
  }
  return parts.join('');
}

test('chatStream: медленный поток не обрывается, пока модель присылает фрагменты', async () => {
  // Пауза между фрагментами (100 мс) заметно меньше тайм-аута (500 мс),
  // а общая длительность (~1500 мс) заметно больше: запас в обе стороны
  // трёхкратный, чтобы тест не зависел от загруженности машины.
  const server = await startServer(async (res) => {
    for (let i = 0; i < 15; i++) {
      await sleep(100);
      res.write(sse(`фрагмент ${i} `));
    }
    res.end('data: [DONE]\n\n');
  });

  const client = new LLMClient({
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: 'fake',
    timeoutMs: 500
  });

  try {
    const text = await collect(client);
    assert.match(text, /фрагмент 0/);
    assert.match(text, /фрагмент 14/); // дошли до конца, несмотря на общую длительность
  } finally {
    server.close();
  }
});

test('chatStream: молчание модели дольше тайм-аута прерывает генерацию с понятной ошибкой', async () => {
  const server = await startServer(async (res) => {
    res.write(sse('начало ответа'));
    // дальше тишина: поток не закрывается, данные не идут
  });

  const client = new LLMClient({
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: 'fake',
    timeoutMs: 300
  });

  try {
    await assert.rejects(() => collect(client), /Модель молчит дольше 300 мс/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
