This private compatibility package replaces the URI parser used by Socket.IO 2
and Engine.IO 3. It preserves their CommonJS function and required field names
while using Node's native `URL` parser. It does not contain upstream parser code.

The accepted protocols are HTTP, HTTPS, WS, and WSS. Embedded credentials,
whitespace/control characters, and values above 128 KiB are rejected. Default
ports are explicit in the returned value, IPv6 hosts omit brackets as the older
clients expect, and encoded query values remain encoded for the transport's own
query decoder. Query maps have no object prototype.

This adapter keeps the existing Socket.IO 2 / Engine.IO 3 wire protocol. It is
not an upgrade to Socket.IO 4. The MetaApi integration must use its official
unbundled SDK entry so patched external dependencies and this adapter apply.
