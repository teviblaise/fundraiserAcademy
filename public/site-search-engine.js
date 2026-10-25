import { searchEntries } from './site-search-index.js';

export const MAX_QUERY_LENGTH = 160;
export const searchCategories = Object.freeze(['Academy', 'Assessment', 'Sponsorship & payouts', 'Account & security', 'Help']);

const stopWords = new Set('a an and are as at be can could do does for from get have how i in is it many me my need of on or our please show take takes that the their this to us want was what when where which who will with would you your'.split(' '));
const aliases = new Map();
for (const group of [
  ['trade', 'trades', 'trading'], ['sponsor', 'sponsorship', 'sponsored', 'funding', 'funded'],
  ['profit', 'profits'], ['payout', 'payouts', 'withdraw', 'withdrawal', 'withdrawals'],
  ['fee', 'fees', 'cost', 'costs'], ['certificate', 'certificates', 'certification'],
  ['nickname', 'nicknames'], ['password', 'passwords'], ['2fa', 'authentication', 'authenticator', 'totp', 'mfa', 'twofactor'],
  ['close', 'closure', 'delete', 'deletion'], ['limit', 'limits'], ['notification', 'notifications'],
  ['alert', 'alerts'], ['forex', 'fx'], ['crypto', 'cryptocurrency'],
  ['metatrader', 'mt4', 'mt5', 'metaapi'], ['register', 'registration', 'signup'],
  ['login', 'signin'], ['session', 'sessions'], ['device', 'devices'],
  ['name', 'names'], ['edit', 'change', 'update'], ['payment', 'payments', 'paid'],
  ['report', 'reports'], ['result', 'results'], ['day', 'days'], ['tier', 'tiers'],
  ['loss', 'losses'], ['account', 'accounts'], ['firm', 'firms'], ['country', 'countries'],
  ['guarantee', 'guarantees', 'guaranteed'], ['suspend', 'suspended', 'suspension'],
  ['3', 'three'], ['5', 'five'], ['10', 'ten'], ['50', 'fifty'], ['60', 'sixty'], ['70', 'seventy'],
  ['10000', '10k'], ['25000', '25k'],
]) for (const word of group) aliases.set(word, group[0]);

function normalized(value) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/\bdraw[\s-]+down\b/g, 'drawdown').replace(/\bhow\s+long\b/g, 'duration')
    .replace(/\btwo[\s-]+factor\b/g, '2fa').replace(/\bsign[\s-]+up\b/g, 'signup')
    .replace(/\b(?:sign|log)[\s-]+in\b/g, 'login').replace(/(\d),(?=\d)/g, '$1');
}
function words(value) {
  return [...new Set((normalized(value).match(/[\p{L}\p{N}]+/gu) || [])
    .filter(word => !stopWords.has(word)).map(word => aliases.get(word) || word))];
}

// One insertion, deletion, substitution or adjacent transposition. Avoid a
// general edit-distance matrix and never fuzzy-match short/numeric keywords.
function oneEditApart(left, right) {
  if (left.length < 5 || right.length < 4 || Math.abs(left.length - right.length) > 1) return false;
  if (!/^\p{L}+$/u.test(left) || !/^\p{L}+$/u.test(right)) return false;
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  if (start === Math.min(left.length, right.length)) return true;
  if (left.length === right.length) {
    if (left.slice(start + 1) === right.slice(start + 1)) return true;
    return left[start] === right[start + 1] && left[start + 1] === right[start] && left.slice(start + 2) === right.slice(start + 2);
  }
  return left.length > right.length ? left.slice(start + 1) === right.slice(start) : left.slice(start) === right.slice(start + 1);
}

const records = searchEntries.map((entry, order) => ({ entry, order, title: words(entry.title), keywords: words(entry.keywords.join(' ')), description: words(entry.description), phrase: normalized(entry.title) }));
function tokenScore(token, field, weight) {
  if (field.includes(token)) return weight;
  if (token.length >= 3 && !/^\d+$/.test(token) && field.some(word => word.startsWith(token))) return weight * 0.72;
  if (field.some(word => oneEditApart(token, word))) return weight * 0.45;
  return 0;
}

export function searchSite(query, options = {}) {
  if (typeof query !== 'string') return { results: [], total: 0, query: '', truncated: false };
  const cleanQuery = query.slice(0, MAX_QUERY_LENGTH).trim();
  const settings = options && typeof options === 'object' ? options : {};
  const category = settings.category ?? 'All';
  const limit = Number.isInteger(settings.limit) ? Math.max(1, Math.min(50, settings.limit)) : 20;
  if (category !== 'All' && !searchCategories.includes(category)) return { results: [], total: 0, query: cleanQuery, truncated: false };
  const tokens = words(cleanQuery).slice(0, 16);
  const blank = cleanQuery.length === 0;
  const found = [];
  for (const record of records) {
    if (category !== 'All' && record.entry.category !== category) continue;
    let score = 0;
    if (!blank) {
      if (!tokens.length) continue;
      let matched = true;
      for (const token of tokens) {
        const match = Math.max(tokenScore(token, record.title, 120), tokenScore(token, record.keywords, 85), tokenScore(token, record.description, 25));
        if (!match) { matched = false; break; }
        score += match;
      }
      if (!matched) continue;
      if (record.phrase === normalized(cleanQuery)) score += 200;
      else if (record.phrase.includes(normalized(cleanQuery))) score += 60;
    }
    found.push({ ...record, score });
  }
  found.sort((a, b) => b.score - a.score || a.order - b.order);
  return { results: found.slice(0, limit).map(({ entry, score }) => ({ ...entry, score })), total: found.length, query: cleanQuery, truncated: found.length > limit };
}
