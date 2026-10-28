import { decodeHTML } from 'entities';
import researchDatabases from '../research-databases.json' with { type: 'json' };

export { researchDatabases };

const normalized = value => abstractText(value).normalize('NFKC').replace(/[\u2010-\u2015]/g, '-').replace(/[\u2018\u2019]/g, "'");
const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pattern = value => new RegExp('(?<![a-z0-9])' + normalized(value).split(/[\s-]+/).map(escapePattern).join('[\\s-]+') + '(?![a-z0-9])', 'giu');
const identifiers = new Set();
const databasePatterns = researchDatabases.map(database => {
  if (!/^[a-z0-9-]+$/.test(database.id) || identifiers.has(database.id) || !database.name ||
      !database.reference?.startsWith('https://') || !database.aliases?.length ||
      !Array.isArray(database.contextualAliases) || [...database.aliases, ...database.contextualAliases].some(alias => typeof alias !== 'string' || !alias.trim())) {
    throw new Error('Invalid research database definition');
  }
  identifiers.add(database.id);
  return { id: database.id, name: database.name, aliases: database.aliases.map(pattern), contextual: database.contextualAliases.map(pattern) };
});
const relationshipContext = /\b(?:supply[\s-]+chains?|(?:customer[\s-]+supplier|supplier[\s-]+customer|buyer[\s-]+supplier)(?:[\s-]+relationships?)?|(?:major|principal|key)[\s-]+customers?|customer[\s-]+segments?)\b|供应链|供应商.{0,12}客户|客户.{0,12}供应商/iu;

export function abstractText(value = '') {
  return decodeHTML(String(value)).replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ').trim().replace(/^abstract\s*:?[\s.]*/i, '');
}

// Names are evidence of an abstract mention, not proof of licensed data use.
// Broad vendor names require relationship context within 180 characters.
export function matchResearchTopic(value) {
  const text = normalized(value);
  const supplyChainTerms = /\bsupply[\s-]+chains?\b|供应链/iu.test(text);
  const databases = databasePatterns.filter(database =>
    database.aliases.some(alias => { alias.lastIndex = 0; return alias.test(text); }) ||
    database.contextual.some(alias => {
      alias.lastIndex = 0;
      for (const match of text.matchAll(alias)) {
        if (relationshipContext.test(text.slice(Math.max(0, match.index - 180), match.index + match[0].length + 180))) return true;
      }
      return false;
    })
  ).map(({ id, name }) => ({ id, name }));
  return { matched: supplyChainTerms || databases.length > 0, supplyChainTerms, databases };
}

// Deliberately tests only the abstract supplied by the metadata source, never the title.
export function supplyChainAbstract(value) {
  return matchResearchTopic(value).matched;
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
