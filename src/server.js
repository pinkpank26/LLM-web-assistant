'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { loadEnv, validateRequest, sanitizeHistory, extractCodeBlock,
        createRateLimiter, estimateTokens } = require('./utils');
const { MODES, buildMessages } = require('./prompts');
const { LLMClient } = require('./llmClient');
const { DocsIndex } = require('./rag');

loadEnv();

const PORT = Number(process.env.PORT) || 3000;
const PROJECT_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(PROJECT_DIR, 'public');
const DOCS_DIR = path.resolve(PROJECT_DIR, process.env.DOCS_DIR || 'docs');
const MAX_BODY_BYTES = 64 * 1024;

const llm = new LLMClient({
  baseUrl: process.env.LLM_BASE_URL || 'http://localhost:11434/v1',
  apiKey: process.env.LLM_API_KEY || '',
  model: process.env.LLM_MODEL || 'qwen2.5-coder:7b',
  embedModel: process.env.LLM_EMBED_MODEL || '',
  temperature: Number(process.env.LLM_TEMPERATURE ?? 0.2),
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 60_000,
  maxTokens: Number(process.env.LLM_MAX_TOKENS) || 0,
  mock: process.env.LLM_MOCK === '1'
});

const docsIndex = new DocsIndex(DOCS_DIR, llm);
const isAllowed = createRateLimiter(Number(process.env.RATE_LIMIT_PER_MINUTE) || 20);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};

/** Ошибка с HTTP-кодом ответа. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Отправка JSON-ответа. */
function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/** Чтение тела запроса с ограничением размера. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) {
        return reject(new HttpError(413, 'Слишком большое тело запроса'));
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/**
 * Общая подготовка запроса к модели: ограничение частоты, чтение и проверка
 * тела, очистка истории диалога, поиск по документации (режим RAG),
 * формирование массива сообщений.
 */
async function prepareRequest(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (!isAllowed(ip)) {
    throw new HttpError(429, 'Слишком много запросов, повторите через минуту');
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'Некорректный JSON');
  }

  const error = validateRequest(body, Object.keys(MODES));
  if (error) throw new HttpError(400, error);

  const history = sanitizeHistory(body.history);
  let sources = [];
  let context = '';
  if (MODES[body.mode].usesRetrieval) {
    sources = await docsIndex.search(body.input, 3);
    context = DocsIndex.formatContext(sources);
  }

  return {
    mode: body.mode,
    messages: buildMessages(body.mode, body.input, { history, context }),
    sources: sources.map((s, i) => ({
      n: i + 1,
      source: s.source,
      heading: s.heading,
      score: Number(s.score.toFixed(3))
    }))
  };
}

/** Статистика токенов: от провайдера или приблизительная оценка. */
function tokenStats(usage, messages, answer) {
  return usage || {
    prompt_tokens: estimateTokens(messages.map((m) => m.content).join('\n')),
    completion_tokens: estimateTokens(answer),
    estimated: true
  };
}

/** POST /api/assist - ответ модели целиком одним JSON-объектом. */
async function handleAssist(req, res) {
  try {
    const { mode, messages, sources } = await prepareRequest(req);
    const result = await llm.chat(messages);
    sendJson(res, 200, {
      mode,
      answer: result.text,
      code: extractCodeBlock(result.text),
      sources,
      model: result.model,
      latencyMs: result.latencyMs,
      tokens: tokenStats(result.usage, messages, result.text)
    });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error('[LLM]', err.message);
    sendJson(res, err.status || 502, {
      error: err.status ? err.message : 'Ошибка обращения к языковой модели: ' + err.message
    });
  }
}

/**
 * POST /api/assist/stream - потоковая передача ответа модели клиенту
 * по технологии Server-Sent Events. События: meta, delta, done, error.
 */
async function handleAssistStream(req, res) {
  let prepared;
  try {
    prepared = await prepareRequest(req);
  } catch (err) {
    return sendJson(res, err.status || 500, { error: err.message });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no' // отключает буферизацию в прокси nginx
  });
  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // если пользователь закрыл страницу или нажал «Стоп» - прерываем генерацию
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  const { messages, sources } = prepared;
  const started = Date.now();
  let answer = '';
  const model = llm.mock ? 'mock' : llm.model;
  send('meta', { model, sources, ragMode: docsIndex.mode });

  try {
    for await (const part of llm.chatStream(messages, controller.signal)) {
      if (part.type === 'delta') {
        answer += part.text;
        send('delta', { text: part.text });
      } else if (part.type === 'end') {
        send('done', {
          code: extractCodeBlock(answer),
          model: part.model,
          latencyMs: Date.now() - started,
          tokens: tokenStats(part.usage, messages, answer)
        });
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error('[LLM stream]', err.message);
      send('error', { error: 'Ошибка обращения к модели: ' + err.message });
    }
  } finally {
    res.end();
  }
}

/** Раздача статических файлов клиентской части. */
function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));

  // Защита от выхода за пределы каталога public (path traversal)
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Не найдено');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
}

/** Маршрутизация запросов. */
const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && pathname === '/api/assist') return handleAssist(req, res);
  if (req.method === 'POST' && pathname === '/api/assist/stream') return handleAssistStream(req, res);
  if (req.method === 'GET' && pathname === '/api/modes') {
    const modes = Object.entries(MODES).map(([id, m]) => ({ id, title: m.title }));
    return sendJson(res, 200, {
      modes, model: llm.mock ? 'mock' : llm.model, docsChunks: docsIndex.chunks.length
    });
  }
  if (req.method === 'GET') return serveStatic(req, res);
  sendJson(res, 405, { error: 'Метод не поддерживается' });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Сервер запущен: http://localhost:${PORT}`);
    console.log(`Модель: ${llm.mock ? 'демонстрационный режим' : llm.model}`);
    console.log(`Документация для RAG: ${docsIndex.chunks.length} фрагментов из ${DOCS_DIR}`);
  });
}

module.exports = { server };
