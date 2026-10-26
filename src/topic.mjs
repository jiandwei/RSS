import { decodeHTML } from 'entities';

export function abstractText(value = '') {
  return decodeHTML(String(value)).replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ').trim().replace(/^abstract\s*:?[\s.]*/i, '');
}

// Deliberately tests only the abstract supplied by the metadata source, never the title.
export function supplyChainAbstract(value) {
  return /\bsupply[\s\-\u2010-\u2015]+chains?\b|供应链/iu.test(abstractText(value));
}

export function reconstructAbstract(index) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) return '';
  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) if (Number.isInteger(position) && position >= 0 && position < 50000) words[position] = word;
  }
  return abstractText(words.join(' '));
}
