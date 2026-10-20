export class AdminRequestError extends Error {
  constructor(message, { status = 0, code = null } = {}) { super(message); this.status = status; this.code = code; }
}

export function createAdminApi({ fetchFn = globalThis.fetch, timeoutMs = 25000 } = {}) {
  return async function request(endpoint, data) {
    if (typeof endpoint !== 'string' || !endpoint.startsWith('/api/admin/') || endpoint.includes('://')) throw new Error('Invalid administrative endpoint.');
    const response = await fetchFn(endpoint, {
      method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(timeoutMs), headers: data === undefined ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'FundraiserAcademy' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    let result;
    try { result = await response.json(); } catch { throw new AdminRequestError('The server returned an unreadable response. Refresh and try again.', { status: response.status }); }
    if (!response.ok) throw new AdminRequestError(typeof result.error === 'string' ? result.error : 'Your request could not be completed.', { status: response.status, code: result.code });
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new AdminRequestError('The server returned an invalid administrative response.');
    return result;
  };
}

export function administrativePermissions(access) {
  return new Set(Array.isArray(access?.permissions) ? access.permissions.filter(value => typeof value === 'string') : []);
}

export function pageRows(value, key = 'items') {
  const items = Array.isArray(value?.[key]) ? value[key] : key === 'staff' && Array.isArray(value?.items) ? value.items : null;
  if (!items || !Number.isSafeInteger(value.total ?? items.length) || (value.total ?? items.length) < items.length) throw new Error('This administrative list could not be read. Refresh and try again.');
  return { items, total: value.total ?? items.length, limit: value.limit ?? items.length, offset: value.offset ?? 0, nextOffset: value.nextOffset ?? null };
}

export function decimalToUnits(value, { scale = 2, allowNegative = false, maximum = 1000000000000 } = {}) {
  const raw = String(value ?? '').trim();
  const match = new RegExp(`^${allowNegative ? '-?' : ''}[0-9]+(?:\\.[0-9]{1,${scale}})?$`).exec(raw);
  if (!match) throw new Error(`Enter a valid amount with at most ${scale} decimal places.`);
  const negative = raw.startsWith('-');
  const [whole, fraction = ''] = raw.replace(/^-/, '').split('.');
  const amount = BigInt(whole) * (10n ** BigInt(scale)) + BigInt(fraction.padEnd(scale, '0'));
  const signed = negative ? -amount : amount;
  if (signed > BigInt(maximum) || signed < -BigInt(maximum)) throw new Error('That amount is outside the supported range.');
  return Number(signed);
}

export function positiveInteger(value, label = 'ID') {
  const raw = String(value ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error(`Enter a valid ${label}.`);
  return Number(raw);
}

export function queryString(values) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  return query.size ? `?${query}` : '';
}

export function csvDownloadName(type, date = new Date()) {
  const safe = /^[a-z_]+$/.test(type) ? type : 'report';
  return `fundraiser-academy-${safe}-${date.toISOString().slice(0, 10)}.csv`;
}
