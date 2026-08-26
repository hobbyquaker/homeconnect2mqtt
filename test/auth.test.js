import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {Auth, AuthError, callbackHostFor} from '../lib/auth.js';
import {Budget} from '../lib/budget.js';

const silent = {debug() {}, info() {}, warn() {}, error() {}};

function jsonResponse(status, body) {
    return {ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body)};
}

function clock(start = 1_700_000_000_000) {
    let t = start;
    return {now: () => t, advance: (ms) => (t += ms)};
}

function tmpTokenFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-auth-'));
    return {file: path.join(dir, 'tokens.json'), cleanup: () => fs.rmSync(dir, {recursive: true})};
}

function params(init) {
    return Object.fromEntries(new URLSearchParams(init.body));
}

describe('Auth', () => {
    test('device flow: prompt, pending, slow_down, success; tokens saved 0600', async () => {
        const {file, cleanup} = tmpTokenFile();
        const c = clock();
        const calls = [];
        const responses = [
            jsonResponse(200, {
                device_code: 'DC',
                user_code: 'ABCD-EFGH',
                verification_uri: 'https://api.home-connect.com/security/oauth/device_verify',
                verification_uri_complete:
                    'https://api.home-connect.com/security/oauth/device_verify?user_code=ABCD-EFGH',
                expires_in: 300,
                interval: 5,
            }),
            jsonResponse(400, {error: 'authorization_pending'}),
            jsonResponse(400, {error: 'slow_down'}),
            jsonResponse(200, {access_token: 'AT', refresh_token: 'RT', expires_in: 86400, scope: 'Monitor'}),
        ];
        const auth = new Auth({
            clientId: 'CID',
            tokenFile: file,
            log: silent,
            now: c.now,
            fetch: async (url, init) => {
                calls.push({url, init});
                return responses.shift();
            },
        });
        let prompt;
        const sleeps = [];
        const tokens = await auth.loginDevice({
            onPrompt: (p) => (prompt = p),
            sleep: async (ms) => {
                sleeps.push(ms);
                c.advance(ms);
            },
        });
        assert.equal(prompt.code, 'ABCD-EFGH');
        assert.match(prompt.url, /user_code=ABCD-EFGH/);
        assert.equal(calls[0].url, 'https://api.home-connect.com/security/oauth/device_authorization');
        assert.deepEqual(params(calls[0].init), {
            client_id: 'CID',
            scope: 'IdentifyAppliance Monitor Control Settings',
        });
        assert.deepEqual(params(calls[1].init), {grant_type: 'device_code', device_code: 'DC', client_id: 'CID'});
        assert.deepEqual(sleeps, [5000, 5000, 10000], 'slow_down adds 5 s');
        assert.equal(tokens.access_token, 'AT');
        assert.equal(tokens.refresh_token, 'RT');
        assert.equal(tokens.expires_at, c.now() + 86400_000);
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(saved.refresh_token, 'RT');
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        // a new instance loads the file
        const auth2 = new Auth({clientId: 'CID', tokenFile: file, log: silent, now: c.now, fetch: async () => {}});
        assert.equal(auth2.hasTokens, true);
        assert.equal(await auth2.accessToken(), 'AT');
        cleanup();
    });

    test('device flow: expiry and access_denied', async () => {
        const c = clock();
        const mk = (pollResponses) =>
            new Auth({
                clientId: 'CID',
                log: silent,
                now: c.now,
                fetch: async () => {
                    if (pollResponses.first) {
                        pollResponses.first = false;
                        return jsonResponse(200, {
                            device_code: 'DC',
                            user_code: 'U',
                            verification_uri: 'v',
                            expires_in: 10,
                            interval: 5,
                        });
                    }
                    return pollResponses.next();
                },
            });
        const a1 = mk({first: true, next: () => jsonResponse(400, {error: 'authorization_pending'})});
        await assert.rejects(() => a1.loginDevice({sleep: async (ms) => c.advance(ms)}), {code: 'expired_token'});
        const a2 = mk({
            first: true,
            next: () => jsonResponse(400, {error: 'access_denied', error_description: 'denied'}),
        });
        await assert.rejects(() => a2.loginDevice({sleep: async (ms) => c.advance(ms)}), {code: 'access_denied'});
    });

    test('accessToken refreshes when nearly expired, rotates the refresh token, counts in the budget', async () => {
        const c = clock();
        const calls = [];
        const budget = new Budget({now: c.now});
        const auth = new Auth({
            clientId: 'CID',
            clientSecret: 'SEC',
            log: silent,
            now: c.now,
            budget,
            fetch: async (url, init) => {
                calls.push({url, init});
                return jsonResponse(200, {access_token: 'AT2', refresh_token: 'RT2', expires_in: 86400});
            },
        });
        auth.tokens = {access_token: 'AT1', refresh_token: 'RT1', expires_in: 86400, expires_at: c.now() + 60_000};
        const events = [];
        auth.on('tokens', (t) => events.push(t.access_token));
        assert.equal(await auth.accessToken(), 'AT2');
        assert.deepEqual(params(calls[0].init), {
            grant_type: 'refresh_token',
            refresh_token: 'RT1',
            client_id: 'CID',
            client_secret: 'SEC',
        });
        assert.equal(auth.tokens.refresh_token, 'RT2');
        assert.deepEqual(events, ['AT2']);
        assert.equal(budget.snapshot().refresh.day, 1);
        assert.equal(budget.snapshot().day.used, 0);
        // concurrent callers share one refresh
        auth.tokens.expires_at = c.now();
        await Promise.all([auth.accessToken(), auth.accessToken()]);
        assert.equal(calls.length, 2);
    });

    test('invalid_grant emits required', async () => {
        const auth = new Auth({
            clientId: 'CID',
            log: silent,
            fetch: async () => jsonResponse(400, {error: 'invalid_grant', error_description: 'invalid refresh_token'}),
        });
        auth.tokens = {access_token: 'x', refresh_token: 'dead', expires_at: 0};
        let required;
        auth.on('required', (e) => (required = e));
        await assert.rejects(() => auth.refresh(), {code: 'invalid_grant'});
        assert.ok(required instanceof AuthError);
    });

    test('no tokens → unauthorized', async () => {
        const auth = new Auth({clientId: 'CID', log: silent, fetch: async () => {}});
        assert.equal(auth.hasTokens, false);
        await assert.rejects(() => auth.accessToken(), {code: 'unauthorized'});
    });

    test('refreshDue is 80 % of the lifetime; scheduleRefresh uses it', () => {
        const c = clock();
        const timers = [];
        const auth = new Auth({
            clientId: 'CID',
            log: silent,
            now: c.now,
            fetch: async () => {},
            setTimeout: (fn, ms) => {
                timers.push(ms);
                return {unref() {}};
            },
        });
        auth.applyTokens({access_token: 'a', refresh_token: 'r', expires_in: 86400});
        assert.equal(auth.refreshDue, 0.8 * 86400_000);
        assert.deepEqual(timers, [0.8 * 86400_000]);
        auth.stop();
    });

    test('authorize url for the code flow', () => {
        const auth = new Auth({
            clientId: 'CID',
            log: silent,
            fetch: async () => {},
            redirectUri: 'http://127.0.0.1:8580/callback',
        });
        const u = new URL(auth.authorizeUrl('S1'));
        assert.equal(u.origin + u.pathname, 'https://api.home-connect.com/security/oauth/authorize');
        assert.equal(u.searchParams.get('client_id'), 'CID');
        assert.equal(u.searchParams.get('response_type'), 'code');
        assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:8580/callback');
        assert.equal(u.searchParams.get('state'), 'S1');
    });

    test('code flow: callback server receives the code and exchanges it', async () => {
        const calls = [];
        const auth = new Auth({
            clientId: 'CID',
            log: silent,
            callbackPort: 0,
            fetch: async (url, init) => {
                calls.push({url, init});
                return jsonResponse(200, {access_token: 'AT', refresh_token: 'RT', expires_in: 86400});
            },
        });
        // pick a free port
        const net = await import('node:net');
        const port = await new Promise((r) => {
            const s = net.createServer().listen(0, () => {
                const p = s.address().port;
                s.close(() => r(p));
            });
        });
        auth.callbackPort = port;
        auth.redirectUri = `http://127.0.0.1:${port}/callback`;
        const login = auth.loginCode({
            onPrompt: async ({url}) => {
                const state = new URL(url).searchParams.get('state');
                const res = await fetch(`http://127.0.0.1:${port}/callback?code=THECODE&state=${state}`);
                assert.equal(res.status, 200);
            },
        });
        const tokens = await login;
        assert.equal(tokens.access_token, 'AT');
        const p = params(calls[0].init);
        assert.equal(p.grant_type, 'authorization_code');
        assert.equal(p.code, 'THECODE');
        assert.equal(p.redirect_uri, auth.redirectUri);
    });
});

describe('Auth.post error shapes', () => {
    test('oauth {error, error_description} and api-style {error: {key, description}}', async () => {
        const mk = (body, status = 400) =>
            new Auth({clientId: 'CID', log: silent, fetch: async () => jsonResponse(status, body)});
        await assert.rejects(
            () => mk({error: 'unauthorized_client', error_description: 'request rejected'}).post('/x', {}),
            {code: 'unauthorized_client', status: 400, description: 'request rejected'},
        );
        await assert.rejects(
            () =>
                mk({error: {key: '404', description: 'The requested resource could not be found.'}}, 404).post(
                    '/x',
                    {},
                ),
            (err) => {
                assert.equal(err.code, '404');
                assert.equal(err.status, 404);
                assert.match(err.message, /404 404: The requested resource/);
                return true;
            },
        );
        await assert.rejects(() => mk({}, 500).post('/x', {}), {code: '500', status: 500});
    });
});

describe('callbackHostFor', () => {
    test('loopback and ip literals bind narrowly, hostnames bind everywhere', () => {
        assert.equal(callbackHostFor('http://127.0.0.1:8580/callback'), '127.0.0.1');
        assert.equal(callbackHostFor('http://localhost:8580/callback'), '127.0.0.1');
        assert.equal(callbackHostFor('http://192.168.1.10:8580/callback'), '192.168.1.10');
        assert.equal(callbackHostFor('http://[::1]:8580/callback'), '::1');
        assert.equal(callbackHostFor('https://node-red.lan/homeconnect/auth/callback'), undefined);
        assert.equal(callbackHostFor('not a url'), undefined);
    });
});
