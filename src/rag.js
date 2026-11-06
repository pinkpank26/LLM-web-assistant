'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Модуль поиска по документации проекта для подхода RAG
 * (Retrieval-Augmented Generation - генерация, дополненная поиском).
 *
 * Индексация: Markdown-файлы из каталога docs разбиваются на фрагменты.
 * Поиск: если настроена модель эмбеддингов - векторный (косинусная близость),
 * иначе - лексический по алгоритму BM25, не требующий внешних сервисов.
 */

/** Разбивает Markdown-документ на фрагменты по заголовкам и по размеру. */
function chunkMarkdown(text, source, maxChars = 900) {
  const chunks = [];
  let heading = '';
  let buffer = [];

  const flush = () => {
    const body = buffer.join('\n').trim();
    if (body) chunks.push({ source, heading, text: body });
    buffer = [];
  };

  for (const line of text.split(/\r?\n/)) {
    const h = /^#{1,3}\s+(.*)/.exec(line);
    if (h) {
      flush();
      heading = h[1].trim();
      continue;
    }
    // длинный раздел делится по абзацам, чтобы фрагмент не превышал maxChars
    if (line.trim() === '' && buffer.join('\n').length > maxChars) flush();
    buffer.push(line);
  }
  flush();
  return chunks;
}

/** Нормализация и разбиение текста на термы для лексического поиска. */
function tokenize(text) {
  return (text.toLowerCase().replace(/ё/g, 'е').match(/[a-zа-я0-9_]+/g) || [])
    .filter((t) => t.length > 1)
    // грубый стемминг: отбрасываем типичные окончания русских слов
    .map((t) => (/[а-я]/.test(t) && t.length > 5 ? t.slice(0, -2) : t));
}

/** Косинусная близость двух векторов. */
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Лексический поисковый индекс по алгоритму BM25. */
class BM25Index {
  constructor(chunks, { k1 = 1.5, b = 0.75 } = {}) {
    this.chunks = chunks;
    this.k1 = k1;
    this.b = b;
    this.docs = chunks.map((c) => tokenize(`${c.heading} ${c.text}`));
    const total = this.docs.reduce((s, d) => s + d.length, 0);
    this.avgLen = total / (this.docs.length || 1);
    this.df = new Map();
    for (const doc of this.docs) {
      for (const term of new Set(doc)) {
        this.df.set(term, (this.df.get(term) || 0) + 1);
      }
    }
  }

  search(query, limit = 3) {
    const terms = tokenize(query);
    const N = this.docs.length;
    return this.docs
      .map((doc, i) => {
        let score = 0;
        for (const term of terms) {
          const tf = doc.filter((t) => t === term).length;
          if (!tf) continue;
          const df = this.df.get(term);
          const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
          score += idf * (tf * (this.k1 + 1)) /
            (tf + this.k1 * (1 - this.b + this.b * doc.length / this.avgLen));
        }
        return { ...this.chunks[i], score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

/** Индекс документации: загружает файлы и выполняет поиск. */
class DocsIndex {
  constructor(docsDir, llm) {
    this.llm = llm;
    this.chunks = [];
    if (fs.existsSync(docsDir)) {
      for (const file of fs.readdirSync(docsDir).filter((f) => f.endsWith('.md'))) {
        const text = fs.readFileSync(path.join(docsDir, file), 'utf8');
        this.chunks.push(...chunkMarkdown(text, file));
      }
    }
    this.bm25 = new BM25Index(this.chunks);
    this.vectors = null; // эмбеддинги вычисляются при первом запросе
    this.mode = 'bm25';
  }

  async #ensureVectors() {
    if (this.vectors || this.vectorsFailed || !this.llm.embedModel || this.llm.mock) return false;
    this.vectors = await this.llm.embed(this.chunks.map((c) => `${c.heading}\n${c.text}`));
    this.mode = 'embeddings';
    return true;
  }

  /** Возвращает наиболее релевантные вопросу фрагменты документации. */
  async search(query, limit = 3) {
    try {
      await this.#ensureVectors();
      if (this.vectors && !this.vectorsFailed) {
        const [q] = await this.llm.embed([query]);
        return this.chunks
          .map((c, i) => ({ ...c, score: cosine(q, this.vectors[i]) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
      }
    } catch (err) {
      this.vectorsFailed = true; // больше не пытаемся, работаем через BM25
      console.warn('[RAG] векторы недоступны, используется BM25:', err.message);
    }
    return this.bm25.search(query, limit);
  }

  /** Формирует текст контекста для промпта: пронумерованные фрагменты. */
  static formatContext(results) {
    return results
      .map((r, i) => `[${i + 1}] (${r.source}, раздел «${r.heading}»)\n${r.text}`)
      .join('\n\n');
  }
}

module.exports = { chunkMarkdown, tokenize, cosine, BM25Index, DocsIndex };
