// Test-only preload. Blocks Node provider egress before DNS/socket creation.
// Native Prisma is outside Node's sockets and is confined by the guarded URL.
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';

const installed = Symbol.for('titchybook.testNetworkGuard');
const local = host => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host).toLowerCase());
function check(host) {
  if (!local(host)) {
    const error = new Error(`External network forbidden in isolated tests: ${host}`);
    error.code = 'TEST_EGRESS_BLOCKED';
    throw error;
  }
}
// Node's isPipeName: Number() trims whitespace, so ' 80 ' is a TCP port, not IPC.
const isPipeName = value => typeof value === 'string' && !(Number(value) >= 0);
function socketHost(args) {
  const first = args[0];
  // Socket.connect receives a normalized [options, callback] from net.connect.
  if (Array.isArray(first)) return socketHost(first);
  if (first && typeof first === 'object') {
    if (first.path) return null; // Local IPC used by runners/Prisma.
    return first.host ?? 'localhost';
  }
  if (isPipeName(first)) return null;
  return typeof args[1] === 'string' ? args[1] : 'localhost';
}
const loopbackAddress = address =>
  address === '::1' || /^127\./.test(address) || /^::ffff:127\./i.test(address);
// 'localhost' passes the name check before DNS runs; a custom lookup could
// still resolve it to a remote address, so every candidate is validated.
function guardedLookup(original = dns.lookup) {
  return function (hostname, ...rest) {
    const callback = rest.pop();
    return original(hostname, ...rest, (error, address, family) => {
      if (!error) {
        const candidates = Array.isArray(address) ? address : [{ address }];
        for (const candidate of candidates) {
          if (!loopbackAddress(candidate.address)) {
            const blocked = new Error(`External network forbidden in isolated tests: ${hostname} resolved to ${candidate.address}`);
            blocked.code = 'TEST_EGRESS_BLOCKED';
            return callback(blocked);
          }
        }
      }
      callback(error, address, family);
    });
  };
}
function withGuardedLookup(args) {
  const first = args[0];
  // net.connect hands Socket.connect an already-normalized [options, callback]
  // array; keep the callback and Node's internal markers intact.
  if (Array.isArray(first)) {
    const inner = withGuardedLookup(first);
    if (inner === first) return args;
    const normalized = [...inner];
    for (const symbol of Object.getOwnPropertySymbols(first)) normalized[symbol] = first[symbol];
    return [normalized, ...args.slice(1)];
  }
  if (first && typeof first === 'object') {
    if (first.path || (first.host ?? 'localhost') !== 'localhost') return args;
    return [{ ...first, lookup: guardedLookup(first.lookup) }, ...args.slice(1)];
  }
  if (isPipeName(first)) return args;
  const host = typeof args[1] === 'string' ? args[1] : 'localhost';
  if (host !== 'localhost') return args;
  const rest = typeof args[1] === 'string' ? args.slice(2) : args.slice(1);
  return [{ port: first, host, lookup: guardedLookup() }, ...rest];
}
function requestHost(args) {
  const first = args[0];
  if (typeof first === 'string' || first instanceof URL) return new URL(first).hostname;
  if (first?.socketPath) return null;
  return first?.hostname ?? first?.host ?? 'localhost';
}
if (!globalThis[installed]) {
  globalThis[installed] = true;
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const host = socketHost(args);
    if (host !== null) check(host);
    return connect.apply(this, host === null ? args : withGuardedLookup(args));
  };
  const secureConnect = tls.connect;
  tls.connect = function (...args) {
    const host = socketHost(args);
    if (host !== null) check(host);
    return secureConnect.apply(this, host === null ? args : withGuardedLookup(args));
  };
  for (const transport of [http, https]) {
    const request = transport.request;
    transport.request = function (...args) {
      const host = requestHost(args);
      if (host !== null) check(host);
      // A loopback URL with an explicit remote host override must also fail.
      if ((typeof args[0] === 'string' || args[0] instanceof URL) && args[1] && typeof args[1] === 'object') {
        if (args[1].hostname || args[1].host) check(args[1].hostname ?? args[1].host);
      }
      return request.apply(this, args);
    };
    transport.get = function (...args) {
      const result = transport.request(...args);
      result.end();
      return result;
    };
  }
  const fetch = globalThis.fetch;
  globalThis.fetch = async function (input, init) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    // data:/blob: carry local bytes with no network host; native fetch reads them.
    if (url.protocol === 'http:' || url.protocol === 'https:') check(url.hostname);
    // Redirected fetches are checked again at the socket layer.
    return fetch.call(this, input, init);
  };
  syncBuiltinESMExports();
}
