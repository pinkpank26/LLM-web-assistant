'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Загружает переменные окружения из файла .env (без сторонних библиотек).
 * Уже заданные переменные окружения не перезаписываются.
 */
function loadEnv(filePath = path.join(__dirname, '..', '.env')) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

/**
 * Проверяет входные данные запроса к API.
 * Возвращает строку с описанием ошибки или null, если данные корректны.
 */
function validateRequest(body, allowedModes, maxLength = 8000) {
  if (!body || typeof body !== 'object') return 'Тело запроса должно быть JSON-объектом';
  const { mode, input } = body;
  if (!allowedModes.includes(mode)) {
    return `Поле mode должно быть одним из: ${allowedModes.join(', ')}`;
  }
  if (typeof input !== 'string' || input.trim().length === 0) {
    return 'Поле input должно быть непустой строкой';
  }
  if (input.length > maxLength) {
    return `Длина input не должна превышать ${maxLength} символов`;
  }
  if (body.history !== undefined && !Array.isArray(body.history)) {
    return 'Поле history должно быть массивом сообщений';
  }
  return null;
}

/**
 * Очищает историю диалога, присланную клиентом: оставляет только сообщения
 * с ролями user/assistant, последние maxMessages штук и не более maxChars
 * символов суммарно (самые старые сообщения отбрасываются первыми).
 * Роль system от клиента не принимается - это защита от подмены инструкций.
 */
function sanitizeHistory(history, maxMessages = 10, maxChars = 12000) {
  if (!Array.isArray(history)) return [];
  const clean = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant')
      && typeof m.content === 'string' && m.content.trim() !== '')
    .map((m) => ({ role: m.role, content: m.content }))
    .slice(-maxMessages);

  let total = clean.reduce((sum, m) => sum + m.content.length, 0);
  while (clean.length && total > maxChars) {
    total -= clean.shift().content.length;
  }
  // диалог должен начинаться с реплики пользователя
  while (clean.length && clean[0].role !== 'user') clean.shift();
  return clean;
}

/**
 * Разбирает поток Server-Sent Events. Принимает накопленный буфер и
 * возвращает готовые события и необработанный остаток (неполное событие).
 * @returns {{events: Array<{event: string, data: string}>, rest: string}}
 */
function parseSSE(buffer) {
  const parts = buffer.replace(/\r\n/g, '\n').split('\n\n');
  const rest = parts.pop();
  const events = [];
  for (const part of parts) {
    let event = 'message';
    const data = [];
    for (const line of part.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length) events.push({ event, data: data.join('\n') });
  }
  return { events, rest };
}

/**
 * Извлекает первый блок кода из Markdown-ответа модели.
 * @returns {{language: string, code: string} | null}
 */
function extractCodeBlock(text) {
  const match = /```([\w-]*)\s*\n([\s\S]*?)```/.exec(text || '');
  if (!match) return null;
  return { language: match[1] || 'text', code: match[2].trimEnd() };
}

/**
 * Простейший ограничитель частоты запросов (алгоритм "фиксированное окно").
 * Хранит счётчики в памяти процесса - достаточно для учебного проекта.
 */
function createRateLimiter(limit, windowMs = 60_000) {
  const hits = new Map();
  return function isAllowed(key, now = Date.now()) {
    const entry = hits.get(key);
    if (!entry || now - entry.start >= windowMs) {
      hits.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

/**
 * Грубая оценка числа токенов: в среднем ~4 символа на токен для
 * английского текста и ~2.5 для русского. Используется для статистики.
 */
function estimateTokens(text) {
  if (!text) return 0;
  const cyrillic = (text.match(/[а-яё]/gi) || []).length;
  const other = text.length - cyrillic;
  return Math.ceil(cyrillic / 2.5 + other / 4);
}

module.exports = {
  loadEnv,
  validateRequest,
  sanitizeHistory,
  parseSSE,
  extractCodeBlock,
  createRateLimiter,
  estimateTokens
};
