'use strict';

// Socket.IO 2 and Engine.IO 3 expect parseuri's original CommonJS function and
// field names. Its newer package is an incompatible ESM API. Use Node's URL
// implementation here instead of either upstream regular-expression parser.
const maximumLength = 128 * 1024;
const defaultPorts = Object.freeze({ 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443' });

module.exports = function parseuri(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new TypeError('Provide a bounded network URI without control characters.');
  }
  const absolute = value.startsWith('//') ? 'https:' + value : value.includes('://') ? value : 'https://' + value;
  const url = new URL(absolute);
  if (!Object.hasOwn(defaultPorts, url.protocol) || !url.hostname || url.username || url.password) {
    throw new TypeError('Only HTTP and WebSocket URIs without embedded credentials are supported.');
  }
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const query = url.search.slice(1);
  const queryKey = Object.create(null);
  for (const part of query.split('&')) {
    if (!part) continue;
    const separator = part.indexOf('=');
    const key = separator < 0 ? part : part.slice(0, separator);
    if (key) queryKey[key] = separator < 0 ? '' : part.slice(separator + 1);
  }
  const lastSlash = url.pathname.lastIndexOf('/');
  return {
    source: value,
    protocol: url.protocol.slice(0, -1),
    authority: url.host,
    userInfo: '', user: '', password: '',
    host,
    port: url.port || defaultPorts[url.protocol],
    relative: url.pathname + url.search + url.hash,
    path: url.pathname,
    directory: url.pathname.slice(0, lastSlash + 1),
    file: url.pathname.slice(lastSlash + 1),
    query,
    anchor: url.hash.slice(1),
    pathNames: url.pathname.split('/').filter(Boolean),
    queryKey,
    ...(host.includes(':') ? { ipv6uri: true } : {}),
  };
};
