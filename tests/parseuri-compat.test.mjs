import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';
import parseuri from '../vendor/parseuri-compat/index.cjs';

const require = createRequire(import.meta.url);

test('native URI compatibility preserves MetaApi network fields, ports, and encoded query values', () => {
  for (const [input, expected] of [
    ['https://mt-client-api-v1.london-a.agiliumtrade.ai/socket.io/?application=Academy&auth-token=a%2Fb%3D#fragment', ['https', 'mt-client-api-v1.london-a.agiliumtrade.ai', '443', '/socket.io/', 'application=Academy&auth-token=a%2Fb%3D']],
    ['http://localhost:4059/a/b', ['http', 'localhost', '4059', '/a/b', '']],
    ['wss://EXAMPLE.com:443/', ['wss', 'example.com', '443', '/', '']],
    ['ws://[::1]:8080/socket.io/?key=x%26y', ['ws', '::1', '8080', '/socket.io/', 'key=x%26y']],
    ['//broker.example:8443/path', ['https', 'broker.example', '8443', '/path', '']],
    ['broker.example:8443/path', ['https', 'broker.example', '8443', '/path', '']],
  ]) {
    const result = parseuri(input);
    assert.deepEqual([result.protocol, result.host, result.port, result.path, result.query], expected);
    assert.equal(result.source, input);
  }
  const result = parseuri('https://example.test/folder/file?key=a%2Fb%3D&flag#anchor');
  assert.equal(result.directory, '/folder/');
  assert.equal(result.file, 'file');
  assert.equal(result.anchor, 'anchor');
  assert.deepEqual(result.pathNames, ['folder', 'file']);
  assert.equal(result.queryKey.key, 'a%2Fb%3D');
  assert.equal(result.queryKey.flag, '');
});

test('URI rejection is bounded and query keys cannot mutate object prototypes', () => {
  for (const value of [null, {}, '', 'file:///private/data', 'ftp://example.test/file', 'data://example.test/text', 'https://user:password@example.test', 'https://example.test/\nheader', 'https://example.test/has space', 'https://example.test:99999', 'https://[invalid]/', 'x'.repeat(128 * 1024 + 1)]) assert.throws(() => parseuri(value));
  const long = parseuri('https://example.test/?auth-token=' + 'a'.repeat(64 * 1024));
  assert.equal(long.host, 'example.test');
  const result = parseuri('https://example.test/?__proto__=polluted&constructor=not-code&toString=text');
  assert.equal(Object.getPrototypeOf(result.queryKey), null);
  assert.equal(result.queryKey.__proto__, 'polluted');
  assert.equal({}.polluted, undefined);
});

test('Socket.IO keeps the Engine.IO 3 protocol while using the local native parser', async () => {
  const io = require('socket.io-client');
  const engine = require('engine.io-client');
  const socketRequire = createRequire(require.resolve('socket.io-client'));
  const engineRequire = createRequire(socketRequire.resolve('engine.io-client'));
  assert.equal(socketRequire('parseuri'), parseuri);
  assert.equal(engineRequire('parseuri'), parseuri);
  assert.equal(io.protocol, 4, 'Socket.IO 2 uses Socket.IO parser protocol 4');
  assert.equal(engine.protocol, 3, 'The MetaApi transport still uses Engine.IO 3');
  const WebSocketServer = require('ws').WebSocketServer || require('ws').Server;
  const server = http.createServer();
  const sockets = new WebSocketServer({server, path: '/socket.io/'});
  const seen = [];
  sockets.on('connection', (socket, request) => {
    seen.push(new URL(request.url, 'http://localhost'));
    socket.send('0' + JSON.stringify({sid: 'native-url-fixture', upgrades: [], pingInterval: 25000, pingTimeout: 5000}));
    socket.send('40');
    socket.on('message', data => {
      const payload = data.toString();
      if (payload === '2') socket.send('3');
      if (payload.startsWith('42')) socket.send('42["academy-response",{"readOnly":true}]');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = io(`http://127.0.0.1:${server.address().port}`, {transports: ['websocket'], reconnection: false, forceNew: true, timeout: 2000, autoConnect: false, query: {application: 'Academy fixture', marker: 'a/b=c'}});
  try {
    const received = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Local Socket.IO handshake timed out')), 4000);
      client.once('connect_error', error => {clearTimeout(timer); reject(error);});
      client.once('academy-response', value => {clearTimeout(timer); resolve(value);});
      client.once('connect', () => client.emit('academy-read', {account: 'fixture-only'}));
    });
    client.connect();
    assert.deepEqual(await received, {readOnly: true});
    assert.equal(seen.length, 1);
    assert.equal(seen[0].searchParams.get('EIO'), '3');
    assert.equal(seen[0].searchParams.get('transport'), 'websocket');
    assert.equal(seen[0].searchParams.get('application'), 'Academy fixture');
    assert.equal(seen[0].searchParams.get('marker'), 'a/b=c');
  } finally {
    client.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
});

test('the official unbundled MetaApi class resolves without a bundled client entry', async () => {
  const entry = require.resolve('metaapi.cloud-sdk/dist/metaApi/metaApi');
  assert.match(entry, /metaapi\.cloud-sdk[\\/]dist[\\/]metaApi[\\/]metaApi\.js$/);
  const imported = await import('metaapi.cloud-sdk/dist/metaApi/metaApi');
  const MetaApi = typeof imported.default === 'function' ? imported.default : imported.default?.default;
  assert.equal(typeof MetaApi, 'function');
  assert.equal(typeof MetaApi.enableLog4jsLogging, 'function');
});
