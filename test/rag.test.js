'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { chunkMarkdown, tokenize, cosine, BM25Index, DocsIndex } = require('../src/rag');

test('chunkMarkdown: разбивает документ по заголовкам', () => {
  const md = '# Документ\n\n## Раздел А\nТекст А\n\n## Раздел Б\nТекст Б';
  const chunks = chunkMarkdown(md, 'doc.md');
  assert.deepStrictEqual(chunks.map((c) => c.heading), ['Раздел А', 'Раздел Б']);
  assert.strictEqual(chunks[0].source, 'doc.md');
});

test('chunkMarkdown: длинный раздел делится на несколько фрагментов', () => {
  const md = '## Длинный\n' + Array(10).fill('слово '.repeat(40)).join('\n\n');
  assert.ok(chunkMarkdown(md, 'x.md', 500).length > 1);
});

test('tokenize: приводит к нижнему регистру и отбрасывает короткие слова', () => {
  assert.deepStrictEqual(tokenize('API и Токены'), ['api', 'токе']);
});

test('cosine: близость одинаковых и ортогональных векторов', () => {
  assert.strictEqual(cosine([1, 2], [1, 2]).toFixed(5), '1.00000');
  assert.strictEqual(cosine([1, 0], [0, 1]), 0);
});

test('BM25Index: релевантный фрагмент получает наибольший вес', () => {
  const index = new BM25Index([
    { heading: 'Цвета', text: 'Основной цвет кнопки синий', source: 'a' },
    { heading: 'API', text: 'Маршрут корзины принимает productId', source: 'b' },
    { heading: 'Коммиты', text: 'Сообщения коммитов по Conventional Commits', source: 'c' }
  ]);
  const [best] = index.search('какой маршрут у корзины?');
  assert.strictEqual(best.source, 'b');
  assert.deepStrictEqual(index.search('квантовая физика'), []);
});

test('DocsIndex: поиск по документации проекта работает без модели (BM25)', async () => {
  const index = new DocsIndex(path.join(__dirname, '..', 'docs'), { mock: true });
  assert.ok(index.chunks.length >= 10);
  const results = await index.search('Сколько товаров может быть в корзине?');
  assert.strictEqual(results[0].source, 'api.md');
  assert.match(DocsIndex.formatContext(results), /^\[1\] \(api\.md/);
});
