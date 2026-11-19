// Test-only preload. Blocks Node provider egress before DNS/socket creation.
// Native Prisma is outside Node's sockets and is confined by the guarded URL.
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
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
function socketHost(args) {
  const first = args[0];
  // Socket.connect receives a normalized [options, callback] from net.connect.
  if (Array.isArray(first)) return socketHost(first);
  if (first && typeof first === 'object') {
    if (first.path) return null; // Local IPC used by runners/Prisma.
    return first.host ?? 'localhost';
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return null;
  return typeof args[1] === 'string' ? args[1] : 'localhost';
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
    return connect.apply(this, args);
  };
  const secureConnect = tls.connect;
  tls.connect = function (...args) {
    const host = socketHost(args);
    if (host !== null) check(host);
    return secureConnect.apply(this, args);
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
    check(url.hostname);
    // Redirected fetches are checked again at the socket layer.
    return fetch.call(this, input, init);
  };
  syncBuiltinESMExports();
}
