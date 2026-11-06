'use strict';

// Ссылки на элементы интерфейса
const $ = (id) => document.getElementById(id);
const form = $('assist-form');
const modeSelect = $('mode');
const input = $('input');
const submitBtn = $('submit-btn');
const stopBtn = $('stop-btn');
const chatEl = $('chat');
const statusEl = $('status');
const previewBlock = $('preview-block');
const preview = $('preview');
const previewBgInput = $('preview-bg');
const chatListEl = $('chat-list');
const historyEmptyEl = $('history-empty');
const themeBtn = $('theme-btn');
const themeLabel = $('theme-label');

const HISTORY_LIMIT = 10;          // сколько последних сообщений отправлять модели
const MAX_CHATS = 30;              // сколько диалогов хранить в браузере
const DEFAULT_BG = '#ffffff';
const KEYS = {
  chats: 'llm-assistant:chats',
  theme: 'llm-assistant:theme',
  bg: 'llm-assistant:preview-bg'
};

let history = [];           // история текущего диалога: [{ role, content }]
let controller = null;      // AbortController текущего запроса
let lastCode = '';
let chats = [];             // сохранённые диалоги
let currentChatId = null;   // id текущего диалога в списке, null - ещё не сохранён

/* ------------------------------ хранилище ------------------------------ */
// localStorage недоступен в приватном режиме и при запрете данных сайта,
// поэтому каждое обращение обёрнуто: интерфейс должен работать и без него.

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

/** Читает сохранённые диалоги, отбрасывая повреждённые записи. */
function loadChats() {
  try {
    const parsed = JSON.parse(storageGet(KEYS.chats) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c) => c && typeof c.id === 'string' && Array.isArray(c.messages));
  } catch {
    return [];
  }
}

function saveChats() {
  if (!storageSet(KEYS.chats, JSON.stringify(chats))) {
    setStatus('История не сохранена: браузер запретил локальное хранилище', true);
  }
}

/* -------------------------------- тема -------------------------------- */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const dark = theme === 'dark';
  themeLabel.textContent = dark ? 'Светлая тема' : 'Тёмная тема';
  themeBtn.setAttribute('aria-pressed', String(dark));
}

themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  storageSet(KEYS.theme, next);
});

/* ------------------------------ интерфейс ------------------------------ */

/** Отображение статуса запроса. */
function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

/** Добавляет сообщение в окно диалога и возвращает элемент с текстом. */
function addMessage(role, text = '') {
  const item = document.createElement('div');
  item.className = `msg msg--${role}`;
  const label = document.createElement('div');
  label.className = 'msg__role';
  label.textContent = role === 'user' ? 'Вы' : 'Модель';
  const body = document.createElement('pre');
  body.className = 'msg__text';
  body.textContent = text; // textContent исключает внедрение HTML
  item.append(label, body);
  chatEl.append(item);
  chatEl.scrollTop = chatEl.scrollHeight;
  return { item, body };
}

/** Выводит список фрагментов документации, использованных в режиме RAG. */
function addSources(item, sources) {
  if (!sources.length) return;
  const list = document.createElement('ol');
  list.className = 'msg__sources';
  for (const s of sources) {
    const li = document.createElement('li');
    li.textContent = `${s.source} - «${s.heading}» (релевантность ${s.score})`;
    list.append(li);
  }
  item.append(list);
}

/** Начинает новый диалог: очищает историю и окно сообщений. */
function resetDialog(message = 'Начат новый диалог') {
  controller?.abort();
  history = [];
  currentChatId = null;
  chatEl.textContent = '';
  previewBlock.hidden = true;
  lastCode = '';
  renderChatList();
  setStatus(message);
}

/* --------------------------- история диалогов --------------------------- */

/** Заголовок диалога в списке - начало первого вопроса пользователя. */
function chatTitle(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return 'Без названия';
  return clean.length > 60 ? `${clean.slice(0, 60)}…` : clean;
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU',
    { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Сохраняет текущий обмен репликами в список диалогов. */
function persistCurrentChat(firstQuestion) {
  const existing = chats.find((c) => c.id === currentChatId);
  if (existing) {
    existing.messages = history.slice();
    existing.updatedAt = new Date().toISOString();
  } else {
    currentChatId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    chats.unshift({
      id: currentChatId,
      title: chatTitle(firstQuestion),
      mode: modeSelect.value,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: history.slice()
    });
    chats = chats.slice(0, MAX_CHATS); // старые диалоги вытесняются
  }
  saveChats();
  renderChatList();
}

/** Перерисовывает список сохранённых диалогов. */
function renderChatList() {
  chatListEl.textContent = '';
  historyEmptyEl.hidden = chats.length > 0;

  for (const chat of chats) {
    const li = document.createElement('li');

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'chat-item';
    if (chat.id === currentChatId) open.setAttribute('aria-current', 'true');

    const title = document.createElement('span');
    title.className = 'chat-item__title';
    title.textContent = chat.title;

    const meta = document.createElement('span');
    meta.className = 'chat-item__meta';
    const option = [...modeSelect.options].find((o) => o.value === chat.mode);
    meta.textContent = `${option?.textContent || chat.mode} · ${formatDate(chat.updatedAt)} · ` +
      `${chat.messages.length} сообщ.`;

    open.append(title, meta);
    open.addEventListener('click', () => openChat(chat.id));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'chat-delete';
    del.textContent = '×';
    del.title = 'Удалить диалог';
    del.setAttribute('aria-label', `Удалить диалог «${chat.title}»`);
    del.addEventListener('click', () => deleteChat(chat.id));

    li.append(open, del);
    chatListEl.append(li);
  }
}

/** Достаёт из ответа модели HTML-блок, чтобы вернуть предпросмотр. */
function restorePreviewFrom(text) {
  const match = /```html\s*\n([\s\S]*?)```/i.exec(text);
  if (match) showPreview(match[1].trim());
}

/** Открывает сохранённый диалог: восстанавливает режим, сообщения и предпросмотр. */
function openChat(id) {
  const chat = chats.find((c) => c.id === id);
  if (!chat) return;
  controller?.abort();

  history = chat.messages.slice();
  currentChatId = id;
  if (chat.mode) modeSelect.value = chat.mode;

  chatEl.textContent = '';
  previewBlock.hidden = true;
  lastCode = '';
  for (const msg of chat.messages) {
    addMessage(msg.role, msg.content);
    if (msg.role === 'assistant') restorePreviewFrom(msg.content);
  }
  renderChatList();
  setStatus(`Открыт диалог: ${chat.title}`);
}

function deleteChat(id) {
  chats = chats.filter((c) => c.id !== id);
  saveChats();
  if (id === currentChatId) {
    resetDialog('Диалог удалён');
  } else {
    renderChatList();
    setStatus('Диалог удалён');
  }
}

$('clear-history-btn').addEventListener('click', () => {
  if (!chats.length) return;
  if (!confirm('Удалить все сохранённые диалоги?')) return;
  chats = [];
  saveChats();
  resetDialog('История диалогов очищена');
});

/* ------------------------------- запросы ------------------------------- */

/** Загрузка списка режимов и имени модели с сервера. */
async function loadModes() {
  try {
    const data = await (await fetch('/api/modes')).json();
    for (const mode of data.modes) {
      modeSelect.append(new Option(mode.title, mode.id));
    }
    $('model-name').textContent = `${data.model} · документация: ${data.docsChunks} фрагм.`;
  } catch {
    setStatus('Не удалось получить список режимов', true);
  }
  renderChatList(); // названия режимов для списка известны только после загрузки
}

/**
 * Читает поток Server-Sent Events из ответа fetch и вызывает onEvent
 * для каждого события. EventSource не подходит: он поддерживает только GET.
 */
async function readEventStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop();
    for (const part of parts) {
      const event = /^event: (.*)$/m.exec(part)?.[1] || 'message';
      const data = /^data: (.*)$/m.exec(part)?.[1];
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}

/** Отправка запроса и потоковый вывод ответа модели. */
async function submitRequest(event) {
  event?.preventDefault();
  const text = input.value.trim();
  if (!text || controller) return;

  const payload = { mode: modeSelect.value, input: text, history: history.slice(-HISTORY_LIMIT) };
  addMessage('user', text);
  const answer = addMessage('assistant');
  answer.item.classList.add('msg--typing');
  input.value = '';
  $('char-count').textContent = '0';

  controller = new AbortController();
  submitBtn.disabled = true;
  stopBtn.disabled = false;
  setStatus('Модель генерирует ответ…');
  let fullText = '';

  try {
    const res = await fetch('/api/assist/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!res.ok) throw new Error((await res.json()).error || `Ошибка ${res.status}`);

    await readEventStream(res, (type, data) => {
      if (type === 'meta') {
        addSources(answer.item, data.sources);
      } else if (type === 'delta') {
        fullText += data.text;
        answer.body.textContent = fullText;
        chatEl.scrollTop = chatEl.scrollHeight;
      } else if (type === 'done') {
        const t = data.tokens || {};
        setStatus(`Готово за ${data.latencyMs} мс · ${data.model} · токены: ` +
          `${t.prompt_tokens ?? '?'} + ${t.completion_tokens ?? '?'}${t.estimated ? ' (оценка)' : ''}`);
        if (data.code?.language === 'html') showPreview(data.code.code);
      } else if (type === 'error') {
        throw new Error(data.error);
      }
    });

    // в историю попадает только успешно завершённый обмен репликами
    history.push({ role: 'user', content: text }, { role: 'assistant', content: fullText });
    persistCurrentChat(text);
  } catch (err) {
    if (err.name === 'AbortError') {
      setStatus('Генерация остановлена пользователем');
    } else {
      setStatus(err.message, true);
      answer.body.textContent = fullText || '(ответ не получен)';
    }
  } finally {
    answer.item.classList.remove('msg--typing');
    controller = null;
    submitBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

/* ----------------------------- предпросмотр ----------------------------- */

/**
 * Собирает документ для iframe: компонент центрируется, фон задаёт пользователь.
 * Модель возвращает то фрагмент разметки, то целый документ, поэтому в первом
 * случае код оборачивается, а во втором оформление дописывается в <head>.
 * Правила помечены !important, иначе стили из сгенерированного кода
 * переопределяли бы центрирование и выбранный фон.
 */
function buildPreviewDoc(code, bg) {
  const frame = `<style>
    html, body { margin: 0; }
    body {
      min-height: 100vh;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      padding: 16px;
      background: ${bg} !important;
    }
  </style>`;

  if (/<html[\s>]/i.test(code)) {
    return /<\/head>/i.test(code)
      ? code.replace(/<\/head>/i, `${frame}</head>`)
      : code.replace(/<html([^>]*)>/i, `<html$1><head>${frame}</head>`);
  }
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">${frame}</head>` +
    `<body>${code}</body></html>`;
}

/** Показывает HTML-код в изолированном окне предпросмотра. */
function showPreview(code) {
  lastCode = code;
  preview.srcdoc = buildPreviewDoc(code, previewBgInput.value);
  previewBlock.hidden = false;
}

/** Перерисовывает предпросмотр с текущим фоном, не теряя код. */
function refreshPreview() {
  if (lastCode) preview.srcdoc = buildPreviewDoc(lastCode, previewBgInput.value);
}

previewBgInput.addEventListener('input', () => {
  storageSet(KEYS.bg, previewBgInput.value);
  refreshPreview();
});
$('preview-bg-reset').addEventListener('click', () => {
  previewBgInput.value = DEFAULT_BG;
  storageSet(KEYS.bg, DEFAULT_BG);
  refreshPreview();
});

/* ------------------------------- события ------------------------------- */

input.addEventListener('input', () => {
  $('char-count').textContent = input.value.length;
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.ctrlKey) submitRequest();
});
modeSelect.addEventListener('change', () => resetDialog('Режим изменён - начат новый диалог'));
stopBtn.addEventListener('click', () => controller?.abort());
$('new-btn').addEventListener('click', () => resetDialog());
$('copy-btn').addEventListener('click', async () => {
  await navigator.clipboard.writeText(lastCode);
  setStatus('Код скопирован в буфер обмена');
});

form.addEventListener('submit', submitRequest);

applyTheme(document.documentElement.dataset.theme || 'light');
previewBgInput.value = storageGet(KEYS.bg) || DEFAULT_BG;
chats = loadChats();
loadModes();
