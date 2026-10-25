import { isIP } from 'node:net';

// Trust is an operator decision about the path to this server, never a value
// supplied by the request. Directly exposed servers must keep the default.
export function parseTrustProxyHops(value) {
  if (value === undefined || value === '') return 0;
  if (!/^(?:[0-9]|10)$/.test(String(value))) throw new TypeError('TRUST_PROXY_HOPS must be an integer between 0 and 10.');
  return Number(value);
}

export function requestClientAddress(req, trustedHops = 0) {
  const peer = req.socket?.remoteAddress || 'unknown';
  if (!trustedHops || !isIP(peer)) return peer;
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded !== 'string' || forwarded.length > 2048) return peer;
  // Node joins duplicate field lines. Reject ambiguous input instead of
  // depending on a proxy/parser's interpretation of that joined value.
  let fields = 0;
  for (let i = 0; i < (req.rawHeaders?.length ?? 0); i += 2) {
    if (req.rawHeaders[i].toLowerCase() === 'x-forwarded-for') fields++;
  }
  if (fields > 1) return peer;
  const addresses = forwarded.split(',').map(value => value.trim());
  if (addresses.length < trustedHops || addresses.length > 64 || addresses.some(value => !isIP(value) || value.includes('%'))) return peer;
  return addresses[addresses.length - trustedHops];
}

export function applyNetworkHeaders(res, { appOrigin, sameOriginFrame = false } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', sameOriginFrame ? 'SAMEORIGIN' : 'DENY');
  res.setHeader('Content-Security-Policy', `base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors ${sameOriginFrame ? "'self'" : "'none'"}`);
  let https = false;
  try { https = new URL(appOrigin).protocol === 'https:'; } catch { /* Local HTTP has no HSTS policy. */ }
  if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}
