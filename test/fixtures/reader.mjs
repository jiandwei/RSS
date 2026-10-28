export const readerOptions = {
  title: 'Research & Supply Chains', origin: 'https://reader.example', accessKey: 'test-reader-secret-0123456789abcdef0123456789',
  window: { from: '2026-08-28', to: '2026-10-28', timeZone: 'Asia/Shanghai' }, updatedAt: '2026-10-28T00:00:00Z', health: 'healthy'
};

export const readerPapers = [
  { id: 'paper-a', title: 'Production Networks and Resilience', url: 'https://example.com/paper?a=1&b=2', authors: ['Alice Researcher'],
    journal: 'Management Science', doi: '10.5555/networks', categories: ['UTD24', 'FT50'],
    date: { value: '2026-10-24', precision: 'day', source: 'Publisher' },
    abstract: 'We use FactSet Revere to examine firm linkages.\n\nA second paragraph preserves the full research abstract.', abstractSource: 'Crossref',
    records: [{ pageURL: 'https://example.com/source', url: 'https://example.com/other-paper', groups: ['FT50'] }] },
  { id: 'paper-b', title: 'Trade Finance with Customs Records', url: 'https://example.com/trade.pdf', authors: ['Bob Author'], journal: 'Journal of Finance',
    categories: ['NBER'], date: { value: '2026-10-01', precision: 'month', source: 'Crossref' },
    abstract: 'Shipping records from Panjiva identify trading partners.', abstractSource: 'OpenAlex', records: [] },
  { id: 'paper-c', title: 'Labor and Management', url: 'https://example.com/labor', authors: ['C. Researcher'], categories: ['David Autor'],
    date: { value: '2026-09-14', precision: 'day', source: 'Publisher' }, abstract: '', records: [] }
];
