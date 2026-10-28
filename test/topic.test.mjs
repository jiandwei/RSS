import test from 'node:test';
import assert from 'node:assert/strict';
import { matchResearchTopic, researchDatabases, supplyChainAbstract } from '../src/topic.mjs';

test('common database names and historical aliases admit abstracts without the literal supply-chain phrase', () => {
  const examples = [
    ['We use FactSet Revere to study production networks.', 'factset-revere'],
    ["Evidence from FactSet’s Revere database.", 'factset-revere'],
    ['We use BLOOMBERG SPLC to map firms.', 'bloomberg-splc'],
    ['We build a network from Compustat Customer Segments.', 'compustat-customer'],
    ['Evidence from Capital IQ Business Relationships.', 'capital-iq'],
    ['We use Mergent Horizon for firm linkages.', 'mergent'],
    ['Shipping records from Panjiva identify trading partners.', 'panjiva'],
    ['We use Import Genius customs records.', 'importgenius'],
    ['利用国泰安供应商客户数据研究企业关联。', 'csmar'],
    ['We match Compustat firms to their major customers.', 'compustat-customer'],
    ['We map buyer–supplier relationships using Bloomberg.', 'bloomberg-splc'],
    ['使用 CSMAR 识别供应商和客户之间的关联。', 'csmar']
  ];
  for (const [text, id] of examples) {
    const result = matchResearchTopic(text);
    assert.equal(result.matched, true, text);
    assert.ok(result.databases.some(database => database.id === id), text);
  }
  assert.equal(researchDatabases.length, 8);
  assert.equal(new Set(researchDatabases.map(database => database.id)).size, researchDatabases.length);
});

test('generic financial vendors, unrelated words, and distant relationship context do not admit papers', () => {
  for (const text of ['Bloomberg measures stock returns.', 'We use Compustat to study profitability.',
    'FactSet analyst forecasts explain earnings.', 'Mergent reports company financials.',
    'Capital IQ provides balance sheet data.', 'CSMAR研究股票收益率。',
    'Paul Revere is a historical figure.', 'PanjivaLike is an invented word.',
    'We use Compustat. ' + 'Unrelated macroeconomic evidence. '.repeat(20) + 'We also discuss major customers.']) {
    assert.equal(supplyChainAbstract(text), false, text);
  }
  const combined = matchResearchTopic('<p>Supply‐chains using FactSet Revere and Panjiva.</p>');
  assert.equal(combined.supplyChainTerms, true);
  assert.deepEqual(combined.databases.map(database => database.id), ['factset-revere', 'panjiva']);
  assert.deepEqual(matchResearchTopic(''), { matched: false, supplyChainTerms: false, databases: [] });
});
