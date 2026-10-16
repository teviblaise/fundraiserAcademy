import { randomUUID } from 'node:crypto';
import { contractConsentStatement } from './contracts.mjs';

export class LeaderboardError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const scope = 'qualification_current_contract';
const ranking = Object.freeze({
  metric: 'verified_realized_qualification_return_percent',
  tieRule: 'Equal displayed returns share a competition rank.',
});

function cleanAlias(value) {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) throw new LeaderboardError(400, 'Choose a public alias with 1–40 letters, numbers, spaces, apostrophes, or hyphens.');
  const alias = value.normalize('NFKC').trim().replace(/\p{Zs}+/gu, ' ');
  if (!alias || [...alias].length > 40 || !/^[\p{L}\p{M}\p{N} '\u2019-]+$/u.test(alias) || !/[\p{L}\p{N}]/u.test(alias)) throw new LeaderboardError(400, 'Choose a public alias with 1–40 letters, numbers, spaces, apostrophes, or hyphens.');
  return alias;
}

// The contract signature identifies a single completed attempt. A later reset,
// new practice balance, or edited certificate display name cannot change it.
function qualifyingResult(row) {
  if (!row || row.price_mode !== 'reference' || !Number.isSafeInteger(row.trading_days) || row.trading_days < 3 ||
      !Number.isFinite(row.initial_balance) || row.initial_balance <= 0 || !Number.isFinite(row.final_balance) ||
      !Number.isFinite(row.profit_percent) || row.profit_percent < 10 || !Number.isSafeInteger(row.issued_at) || row.issued_at <= 0) return null;
  const realizedProfit = row.final_balance - row.initial_balance;
  const actualReturn = (row.final_balance / row.initial_balance - 1) * 100;
  if (!Number.isFinite(realizedProfit) || !Number.isFinite(actualReturn) || actualReturn < 10 ||
      Math.abs(actualReturn - row.profit_percent) > Math.max(1e-8, Math.abs(actualReturn) * 1e-10)) return null;
  const basisPoints = Math.round(actualReturn * 100);
  if (!Number.isSafeInteger(basisPoints)) return null;
  return { returnPercent: basisPoints / 100, realizedProfit, tradingDays: row.trading_days, completedAt: row.issued_at };
}

export function createLeaderboard(db, { now = Date.now } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS leaderboard_profiles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    public_id TEXT UNIQUE NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
    alias TEXT NOT NULL DEFAULT '',
    alias_key TEXT UNIQUE,
    updated_at INTEGER NOT NULL
  );`);
  const active = () => db.prepare('SELECT d.id,d.version,d.hash,d.published_at FROM active_contract a JOIN contract_documents d ON d.id=a.contract_id WHERE a.singleton=1').get();
  const signatureFor = (userId, documentId) => db.prepare(`SELECT s.contract_version,s.contract_hash,s.consent_statement,s.signed_at,
      c.user_id AS certificate_owner,c.initial_balance,c.final_balance,c.profit_percent,c.trading_days,c.issued_at,c.price_mode
    FROM contract_signatures s LEFT JOIN certificates c ON c.id=s.certificate_id
    WHERE s.user_id=? AND s.contract_id=?`).get(userId, documentId);
  const profileFor = userId => db.prepare('SELECT * FROM leaderboard_profiles WHERE user_id=?').get(userId);

  function signedResult(userId, document) {
    const signed = signatureFor(userId, document.id);
    if (!signed) return null;
    const result = qualifyingResult(signed);
    if (!result || signed.certificate_owner !== userId || signed.contract_version !== document.version ||
        signed.contract_hash !== document.hash || signed.consent_statement !== contractConsentStatement ||
        !Number.isSafeInteger(signed.signed_at) || signed.signed_at < Math.max(signed.issued_at, document.published_at)) return null;
    return result;
  }

  function eligibility(userId, document = active()) {
    const results = db.prepare('SELECT * FROM certificates WHERE user_id=?').all(userId);
    const passed = results.some(row => qualifyingResult(row));
    if (!passed) return { eligible: false, status: 'assessment_required' };
    if (!document) return { eligible: false, status: 'awaiting_contract' };
    const signed = signatureFor(userId, document.id);
    if (!signed) return { eligible: false, status: 'signature_required' };
    if (!signedResult(userId, document)) return { eligible: false, status: 'ineligible_certificate' };
    return { eligible: true, status: 'eligible' };
  }

  function rankedEntries() {
    const document = active();
    if (!document) return [];
    const rows = db.prepare('SELECT user_id,public_id,alias FROM leaderboard_profiles WHERE enabled=1').all();
    const entries = [];
    for (const profile of rows) {
      const result = signedResult(profile.user_id, document);
      if (!result) continue;
      entries.push({ userId: profile.user_id, publicEntryId: profile.public_id, displayAlias: profile.alias, ...result });
    }
    entries.sort((a, b) => b.returnPercent - a.returnPercent || a.completedAt - b.completedAt || a.publicEntryId.localeCompare(b.publicEntryId));
    let rank = 0;
    return entries.map((entry, index) => {
      if (index === 0 || entry.returnPercent !== entries[index - 1].returnPercent) rank = index + 1;
      return { ...entry, rank };
    });
  }
  function publicEntry(entry) {
    if (!entry) return null;
    const { userId: _userId, ...safe } = entry;
    return safe;
  }
  function page({ limit = 20, offset = 0 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new LeaderboardError(400, 'Use a leaderboard limit from 1–100 and a non-negative offset up to 1000000.');
    const entries = rankedEntries();
    return {
      scope, ranking, updatedAt: now(), total: entries.length, limit, offset,
      nextOffset: offset + limit < entries.length ? offset + limit : null,
      entries: entries.slice(offset, offset + limit).map(publicEntry),
    };
  }
  function preferences(userId) {
    const profile = profileFor(userId);
    const state = eligibility(userId);
    return {
      enabled: Boolean(profile?.enabled), alias: profile?.alias || '', eligibility: state,
      entry: profile?.enabled && state.eligible ? publicEntry(rankedEntries().find(entry => entry.userId === userId)) : null,
    };
  }
  function setPreferences(userId, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['enabled', 'alias'].includes(key)) || typeof data.enabled !== 'boolean') throw new LeaderboardError(400, 'Update only leaderboard visibility and your public alias.');
    const old = profileFor(userId);
    const alias = Object.hasOwn(data, 'alias') ? (data.alias === '' && !data.enabled ? '' : cleanAlias(data.alias)) : old?.alias || '';
    if (data.enabled && !alias) throw new LeaderboardError(400, 'Choose a public alias before joining the leaderboard.');
    const aliasKey = alias ? alias.toLocaleLowerCase('en-US') : null;
    try {
      db.prepare(`INSERT INTO leaderboard_profiles(user_id,public_id,enabled,alias,alias_key,updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,alias=excluded.alias,alias_key=excluded.alias_key,updated_at=excluded.updated_at`).run(userId, old?.public_id || randomUUID(), data.enabled ? 1 : 0, alias, aliasKey, now());
    } catch (error) {
      if (error.message?.includes('UNIQUE constraint failed: leaderboard_profiles.alias_key')) throw new LeaderboardError(409, 'That public alias is already reserved. Choose another alias.');
      throw error;
    }
    return preferences(userId);
  }
  return { page, preferences, setPreferences };
}
