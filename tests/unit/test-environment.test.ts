import { afterEach, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { offlineTestEnvironment, testEnvironment } from '../../scripts/test-environment.mts';

afterEach(() => vi.unstubAllEnvs());
it('never falls back to the application DATABASE_URL', () => {
  vi.stubEnv('TEST_DATABASE_URL', '');
  vi.stubEnv('DATABASE_URL', 'postgresql://localhost/application');
  expect(() => testEnvironment()).toThrow('explicitly');
});
it.each([
  'postgresql://remote.example/test',
  'postgresql://localhost/application',
  'postgresql://localhost/app_test?host=remote.example',
  'https://localhost/app_test',
  'postgresql://localhost/app_test?HOST=remote.example',
  'postgresql://localhost/app_test?hostaddr=203.0.113.1',
  'postgresql://localhost/app_test?options=unsafe',
])('rejects unsafe test target %s', url => {
  vi.stubEnv('TEST_DATABASE_URL', url);
  expect(() => testEnvironment()).toThrow();
});
it('overrides provider credentials and the database with test-only values', () => {
  vi.stubEnv('TEST_DATABASE_URL', 'postgresql://localhost/app_test');
  const env = testEnvironment();
  expect(env.DATABASE_URL).toBe('postgresql://localhost/app_test');
  expect(env.AWS_ACCESS_KEY_ID).toBe('test-only');
  expect(env.OPENAI_API_KEY).toBe('test-only');
  expect(env.STRIPE_SECRET_KEY).toBe('');
  expect(env.STRIPE_WEBHOOK_SECRET).toBe('');
  expect(env.RESEND_API_KEY).toBe('');
  expect(env.ORDER_SHIPPING_POLICY_JSON).toBe('');
});

it('drops inherited credentials, session rotation keys, proxies, and Node loaders', () => {
  for (const name of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY',
    'AWS_SESSION_TOKEN', 'AUTH_SECRET_3', 'NEXTAUTH_SECRET', 'DIRECT_URL',
    'ADMIN_PASSWORD', 'HTTPS_PROXY', 'NODE_OPTIONS', 'UNRELATED_PROVIDER_TOKEN', 'ORDER_SHIPPING_POLICY_JSON']) {
    vi.stubEnv(name, 'inherited-sensitive-value');
  }
  const env = offlineTestEnvironment();
  expect(Object.values(env)).not.toContain('inherited-sensitive-value');
  expect(env.UNRELATED_PROVIDER_TOKEN).toBeUndefined();
  expect(env.NODE_OPTIONS).toContain('test-network-guard.mjs');
  expect(env.DATABASE_URL).toBe('postgresql://127.0.0.1:1/isolated_unit_test');
});

it.each(['localhost', '127.0.0.1', '[::1]'])('allows explicit local test URLs on %s', host => {
  const url = `postgresql://${host}/app_test?schema=public&connection_limit=1`;
  vi.stubEnv('TEST_DATABASE_URL', url);
  expect(testEnvironment().DATABASE_URL).toBe(url);
});

function guardedChild(source: string) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    env: offlineTestEnvironment(), encoding: 'utf8', timeout: 15000,
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result.stdout;
}

it('blocks fetch, HTTP, HTTPS, TCP, and TLS in an inherited child before DNS', () => {
  const output = guardedChild(`
    import assert from 'node:assert/strict';
    import dns from 'node:dns';
    import net from 'node:net';
    import tls from 'node:tls';
    import http from 'node:http';
    import https from 'node:https';
    let lookups = 0;
    dns.lookup = () => { lookups++; throw new Error('Unexpected DNS lookup'); };
    await assert.rejects(fetch('https://provider.example.invalid'), {code: 'TEST_EGRESS_BLOCKED'});
    for (const invoke of [
      () => http.get('http://provider.example.invalid'),
      () => https.request('https://provider.example.invalid'),
      () => http.request('http://localhost', {hostname: 'provider.example.invalid'}),
      () => net.connect(443, 'provider.example.invalid'),
      () => new net.Socket().connect({host: '203.0.113.1', port: 443}),
      () => tls.connect({host: 'provider.example.invalid', port: 443}),
    ]) assert.throws(invoke, {code: 'TEST_EGRESS_BLOCKED'});
    assert.equal(lookups, 0);
    console.log('blocked-before-dns');
  `);
  expect(output).toContain('blocked-before-dns');
});

it('blocks the installed S3, Stripe, OpenAI, and Resend SDK transports', () => {
  const output = guardedChild(`
    import assert from 'node:assert/strict';
    import {S3Client, HeadObjectCommand} from '@aws-sdk/client-s3';
    import Stripe from 'stripe';
    import OpenAI from 'openai';
    import {Resend} from 'resend';
    const s3 = new S3Client({region: 'us-east-1', maxAttempts: 1,
      credentials: {accessKeyId: 'test-only', secretAccessKey: 'test-only'}});
    await assert.rejects(s3.send(new HeadObjectCommand({Bucket: 'test-only', Key: 'fixture'})), /External network forbidden/);
    const stripe = new Stripe('sk_test_isolation_only', {maxNetworkRetries: 0});
    await assert.rejects(stripe.checkout.sessions.list({limit: 1}), error =>
      error.detail?.code === 'TEST_EGRESS_BLOCKED' || String(error.detail?.message).includes('External network forbidden'));
    const ai = new OpenAI({apiKey: 'test-only', maxRetries: 0});
    await assert.rejects(ai.models.list(), error => error.cause?.code === 'TEST_EGRESS_BLOCKED');
    const guardedFetch = globalThis.fetch;
    let resendBlocked = false;
    globalThis.fetch = async (...args) => {
      try { return await guardedFetch(...args); }
      catch (error) { resendBlocked = error.code === 'TEST_EGRESS_BLOCKED'; throw error; }
    };
    const email = await new Resend('re_test_only').domains.list();
    assert.ok(email.error);
    assert.equal(resendBlocked, true);
    console.log('all-provider-transports-blocked');
  `);
  expect(output).toContain('all-provider-transports-blocked');
}, 20000); // SDK imports can exceed Vitest's 5s default under full-suite contention.

it('allows local HTTP and rejects a redirect to a provider', () => {
  const output = guardedChild(`
    import assert from 'node:assert/strict';
    import http from 'node:http';
    const server = http.createServer((req, res) => {
      if (req.url === '/redirect') { res.writeHead(302, {Location: 'https://provider.example.invalid'}); res.end(); }
      else res.end('local-only');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    try {
      assert.equal(await (await fetch(origin)).text(), 'local-only');
      await assert.rejects(fetch(origin + '/redirect'), error => {
        return error.cause?.code === 'TEST_EGRESS_BLOCKED';
      });
      console.log('local-pass-redirect-blocked');
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  `);
  expect(output).toContain('local-pass-redirect-blocked');
});
