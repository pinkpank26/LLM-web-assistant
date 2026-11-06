'use strict';

const { parseSSE } = require('./utils');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Клиент для OpenAI-совместимого API (Chat Completions и Embeddings).
 * Подходит для OpenAI, локальных Ollama и LM Studio, а также
 * для других провайдеров с совместимым интерфейсом.
 */
class LLMClient {
  constructor({ baseUrl, apiKey, model, embedModel = '', temperature = 0.2,
                timeoutMs = 60_000, maxTokens = 0, mock = false }) {
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.embedModel = embedModel;
    this.temperature = temperature;
    this.timeoutMs = timeoutMs;
    this.maxTokens = maxTokens;
    this.mock = mock;
  }

  /**
   * Параметры генерации, общие для обычного и потокового запроса.
   * max_tokens передаётся только когда задан: ограничение сверху заметно
   * влияет на время ответа, ведь локальная модель генерирует несколько
   * токенов в секунду, а пустое поле некоторые провайдеры отвергают.
   */
  #generationParams() {
    return {
      temperature: this.temperature,
      ...(this.maxTokens > 0 ? { max_tokens: this.maxTokens } : {})
    };
  }

  /**
   * Общий метод POST-запроса к API с тайм-аутом и обработкой ошибок.
   * Тайм-аут считается как простой: ожидание данных, а не общая длительность
   * ответа. Вызов keepAlive() взводит таймер заново - потоковая генерация
   * использует это на каждом полученном фрагменте, иначе длинный ответ
   * обрывался бы на timeoutMs, даже когда модель исправно пишет текст.
   */
  async #post(endpoint, payload, externalSignal) {
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(new Error('timeout')), this.timeoutMs);
    const keepAlive = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error('timeout')), this.timeoutMs);
    };
    const onAbort = () => controller.abort(externalSignal.reason);
    externalSignal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {})
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!response.ok) {
        const details = await response.text();
        throw new Error(`LLM API вернул ${response.status}: ${details.slice(0, 300)}`);
      }
      return { response, done: () => clearTimeout(timer), keepAlive };
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError' || err.message === 'timeout') {
        throw new Error(externalSignal?.aborted
          ? 'Запрос отменён'
          : `Превышено время ожидания ответа модели (${this.timeoutMs} мс)`);
      }
      throw err;
    }
  }

  /**
   * Отправляет диалог модели и возвращает полный ответ одним объектом.
   * @param {Array<{role: string, content: string}>} messages
   */
  async chat(messages) {
    if (this.mock) return this.#mockAnswer(messages);
    const started = Date.now();
    const { response, done } = await this.#post('/chat/completions', {
      model: this.model, messages, ...this.#generationParams()
    });
    try {
      const data = await response.json();
      return {
        text: data.choices?.[0]?.message?.content ?? '',
        model: data.model || this.model,
        usage: data.usage || null,
        latencyMs: Date.now() - started
      };
    } finally {
      done();
    }
  }

  /**
   * Потоковая генерация: асинхронный генератор, выдающий фрагменты текста
   * по мере их генерации моделью. Последним возвращается объект со статистикой.
   * @param {Array<{role: string, content: string}>} messages
   * @param {AbortSignal} [signal] - позволяет прервать генерацию
   */
  async *chatStream(messages, signal) {
    if (this.mock) {
      yield* this.#mockStream(messages, signal);
      return;
    }
    const { response, done, keepAlive } = await this.#post('/chat/completions', {
      model: this.model,
      messages,
      ...this.#generationParams(),
      stream: true,
      stream_options: { include_usage: true }
    }, signal);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage = null;
    let model = this.model;
    try {
      while (true) {
        let value, finished;
        try {
          ({ value, done: finished } = await reader.read());
        } catch (err) {
          if (err.name === 'AbortError' || err.message === 'timeout') {
            throw new Error(signal?.aborted
              ? 'Запрос отменён'
              : `Модель молчит дольше ${this.timeoutMs} мс, генерация прервана`);
          }
          throw err;
        }
        if (finished) break;
        keepAlive();
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSSE(buffer);
        buffer = parsed.rest;
        for (const { data } of parsed.events) {
          if (data === '[DONE]') {
            yield { type: 'end', usage, model };
            return;
          }
          const chunk = JSON.parse(data);
          if (chunk.model) model = chunk.model;
          if (chunk.usage) usage = chunk.usage;
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) yield { type: 'delta', text: delta };
        }
      }
      yield { type: 'end', usage, model };
    } finally {
      done();
      reader.releaseLock();
    }
  }

  /**
   * Вычисляет векторные представления (эмбеддинги) для массива текстов.
   * @param {string[]} texts
   * @returns {Promise<number[][]>}
   */
  async embed(texts) {
    if (this.mock || !this.embedModel) {
      throw new Error('Модель эмбеддингов не настроена');
    }
    const { response, done } = await this.#post('/embeddings', {
      model: this.embedModel, input: texts
    });
    try {
      const data = await response.json();
      return data.data
        .sort((a, b) => a.index - b.index)
        .map((item) => item.embedding);
    } finally {
      done();
    }
  }

  /** Демонстрационный ответ без обращения к модели. */
  #mockText(messages) {
    const userText = messages.at(-1)?.content || '';
    if (userText.includes('<context>')) {
      return 'Демонстрационный режим: модель не вызывалась. Найденные фрагменты ' +
        'документации показаны в списке источников [1].';
    }
    return '```html\n' +
      '<button class="btn" type="button" aria-label="Демонстрационная кнопка">\n' +
      '  Нажми меня\n' +
      '</button>\n' +
      '<style>\n' +
      '  .btn { padding: 10px 20px; border: 0; border-radius: 8px;\n' +
      '         background: #2563eb; color: #fff; cursor: pointer; }\n' +
      '  .btn:hover { background: #1d4ed8; }\n' +
      '</style>\n' +
      '```\n' +
      `Демонстрационный режим (LLM_MOCK=1). Получено ${userText.length} символов запроса, ` +
      `сообщений в диалоге: ${messages.length - 1}.`;
  }

  async #mockAnswer(messages) {
    return { text: this.#mockText(messages), model: 'mock', usage: null, latencyMs: 0 };
  }

  async *#mockStream(messages, signal) {
    const words = this.#mockText(messages).split(/(?<=\s)/);
    for (const word of words) {
      if (signal?.aborted) return;
      await sleep(15);
      yield { type: 'delta', text: word };
    }
    yield { type: 'end', usage: null, model: 'mock' };
  }
}

module.exports = { LLMClient };
