/**
 * OAuth2 for the Home Connect API (ROADMAP §2.2 / §4.8).
 *
 *  - Device Flow (default): POST /security/oauth/device_authorization → user opens
 *    verification_uri_complete (or enters user_code), we poll /security/oauth/token with
 *    grant_type=device_code every `interval` s until `expires_in` (300 s).
 *  - Authorization Code: authorize url + one-shot local http callback server + code exchange.
 *  - Refresh: grant_type=refresh_token; access tokens live 86400 s, the refresh token rotates.
 *  - Token file: JSON {access_token, refresh_token, expires_at (ms), scope, obtained (iso)},
 *    mode 0600, in the state directory.
 *
 * Emits `tokens` after every successful token response, `required` (with the prompt) when a
 * refresh fails with invalid_grant and a new login is needed.
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PRODUCTION_HOST, SIMULATOR_HOST} from './client.js';

export class AuthError extends Error {
    constructor(message, {code, status, description} = {}) {
        super(message);
        this.name = 'AuthError';
        this.code = code;
        this.status = status;
        this.description = description;
    }
}

/**
 * Which address the one-shot callback server binds to: the host of the redirect uri when it is
 * an ip literal or `localhost` (loopback by default), otherwise all interfaces (a hostname the
 * browser resolves to this machine).
 */
export function callbackHostFor(redirectUri) {
    try {
        const host = new URL(redirectUri).hostname.replace(/^\[|\]$/g, '');
        if (host === 'localhost') {
            return '127.0.0.1';
        }
        if (/^[\d.]+$/.test(host) || host.includes(':')) {
            return host;
        }
    } catch {
        // fall through
    }
    return undefined;
}

const REFRESH_AT = 0.8; // of the access token lifetime
const MIN_VALIDITY = 5 * 60 * 1000; // refresh when less than this is left

export class Auth extends EventEmitter {
    /**
     * @param {object} options
     * @param {string} options.clientId
     * @param {string} [options.clientSecret]
     * @param {boolean} [options.simulator]
     * @param {string} [options.host]
     * @param {string} [options.tokenFile]
     * @param {string} [options.scopes] space separated
     * @param {string} [options.redirectUri]
     * @param {number} [options.callbackPort]
     * @param {object} options.log
     * @param {import('./budget.js').Budget} [options.budget] counts refreshes
     * @param {typeof fetch} [options.fetch]
     * @param {() => number} [options.now]
     * @param {(ms: number, fn: () => void) => any} [options.setTimeout]
     */
    constructor({
        clientId,
        clientSecret,
        simulator = false,
        host,
        tokenFile,
        scopes = 'IdentifyAppliance Monitor Control Settings',
        redirectUri = 'http://127.0.0.1:8580/callback',
        callbackPort = 8580,
        log,
        budget,
        fetch = globalThis.fetch,
        now = () => Date.now(),
        setTimeout: setTimer = globalThis.setTimeout,
    }) {
        super();
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.host = host || (simulator ? SIMULATOR_HOST : PRODUCTION_HOST);
        this.tokenFile = tokenFile;
        this.scopes = scopes;
        this.redirectUri = redirectUri;
        this.callbackPort = callbackPort;
        this.callbackHost = callbackHostFor(redirectUri);
        this.log = log;
        this.budget = budget;
        this.fetch = fetch;
        this.now = now;
        this.setTimer = setTimer;
        this.tokens = null;
        this.refreshing = null;
        this.refreshTimer = null;
        this.load();
    }

    // --- token file -------------------------------------------------------------------------

    load() {
        if (!this.tokenFile || !fs.existsSync(this.tokenFile)) {
            return false;
        }
        try {
            const t = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8'));
            if (t.refresh_token) {
                this.tokens = t;
                return true;
            }
        } catch (err) {
            this.log?.warn(`auth: cannot read ${this.tokenFile}: ${err.message}`);
        }
        return false;
    }

    save() {
        if (!this.tokenFile || !this.tokens) {
            return;
        }
        fs.mkdirSync(path.dirname(this.tokenFile), {recursive: true});
        fs.writeFileSync(this.tokenFile, JSON.stringify(this.tokens, null, 1), {mode: 0o600});
        try {
            fs.chmodSync(this.tokenFile, 0o600);
        } catch {
            // e.g. on Windows
        }
    }

    get hasTokens() {
        return Boolean(this.tokens?.refresh_token);
    }

    get expiresAt() {
        return this.tokens?.expires_at ?? 0;
    }

    /** ms until the access token should be refreshed (may be ≤ 0) */
    get refreshDue() {
        if (!this.tokens) {
            return 0;
        }
        const lifetime = (this.tokens.expires_in ?? 86400) * 1000;
        return this.tokens.expires_at - lifetime * (1 - REFRESH_AT) - this.now();
    }

    // --- http helpers -----------------------------------------------------------------------

    async post(pathname, params) {
        const body = new URLSearchParams(params).toString();
        this.log?.debug(`hc > POST ${pathname} ${body.replace(/(secret|token|code)=[^&]+/g, '$1=***')}`);
        let response;
        try {
            response = await this.fetch(this.host + pathname, {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json'},
                body,
                signal: AbortSignal.timeout(30000),
            });
        } catch (err) {
            throw new AuthError(`${pathname}: ${err.message}`, {code: 'network'});
        }
        const text = await response.text();
        let json;
        try {
            json = JSON.parse(text);
        } catch {
            json = {};
        }
        if (!response.ok) {
            // oauth errors: {error, error_description}; api-style errors: {error: {key, description}}
            const apiStyle = json.error && typeof json.error === 'object';
            const code = (apiStyle ? json.error.key : json.error) || String(response.status);
            const description = apiStyle ? json.error.description : json.error_description;
            throw new AuthError(`${pathname} → ${response.status} ${code}${description ? ': ' + description : ''}`, {
                code,
                status: response.status,
                description,
            });
        }
        return json;
    }

    applyTokens(json) {
        const expiresIn = Number(json.expires_in) || 86400;
        this.tokens = {
            access_token: json.access_token,
            refresh_token: json.refresh_token ?? this.tokens?.refresh_token,
            expires_in: expiresIn,
            expires_at: this.now() + expiresIn * 1000,
            scope: json.scope,
            id_token: json.id_token,
            obtained: new Date(this.now()).toISOString(),
        };
        this.save();
        this.emit('tokens', this.tokens);
        this.scheduleRefresh();
        return this.tokens;
    }

    // --- access -----------------------------------------------------------------------------

    /**
     * A valid access token; refreshes when the token is (nearly) expired.
     * @returns {Promise<string>}
     */
    async accessToken() {
        if (!this.tokens) {
            throw new AuthError('not authorized — run --login first', {code: 'unauthorized'});
        }
        if (this.tokens.expires_at - this.now() < MIN_VALIDITY) {
            await this.refresh();
        }
        return this.tokens.access_token;
    }

    /**
     * Refresh the access token (deduplicated: concurrent callers share one request).
     */
    refresh() {
        if (!this.refreshing) {
            this.refreshing = this.doRefresh().finally(() => {
                this.refreshing = null;
            });
        }
        return this.refreshing;
    }

    async doRefresh() {
        if (!this.tokens?.refresh_token) {
            throw new AuthError('no refresh token — run --login first', {code: 'unauthorized'});
        }
        this.budget?.take('refresh');
        try {
            const json = await this.post('/security/oauth/token', {
                grant_type: 'refresh_token',
                refresh_token: this.tokens.refresh_token,
                client_id: this.clientId,
                ...(this.clientSecret && {client_secret: this.clientSecret}),
            });
            this.budget?.record('refresh', {ok: true});
            this.log?.info('auth: access token refreshed');
            return this.applyTokens(json);
        } catch (err) {
            this.budget?.record('refresh', {ok: false, status: err.status, description: err.description});
            if (err.code === 'invalid_grant' || err.code === 'invalid_token' || err.status === 400) {
                // the refresh token is dead (BSH reset, revoked, expired) — a new login is needed
                this.log?.warn(`auth: refresh rejected (${err.code}), a new login is required`);
                this.emit('required', err);
            }
            throw err;
        }
    }

    /** proactive refresh at 80 % of the lifetime */
    scheduleRefresh() {
        clearTimeout(this.refreshTimer);
        if (!this.tokens) {
            return;
        }
        const due = Math.max(1000, this.refreshDue);
        this.refreshTimer = this.setTimer(() => {
            this.refresh().catch((err) => {
                this.log?.warn(`auth: scheduled refresh failed: ${err.message}`);
                if (err.code !== 'invalid_grant') {
                    // retry with growing delays, bounded by the refresh quota through the budget
                    this.retryDelay = Math.min((this.retryDelay ?? 30000) * 2, 15 * 60 * 1000);
                    this.refreshTimer = this.setTimer(() => this.scheduleRefreshNow(), this.retryDelay);
                    this.refreshTimer.unref?.();
                }
            });
        }, due);
        this.refreshTimer.unref?.();
        this.retryDelay = undefined;
    }

    scheduleRefreshNow() {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = this.setTimer(() => this.scheduleRefresh(), 0);
    }

    stop() {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
    }

    // --- login: device flow -----------------------------------------------------------------

    /**
     * @param {object} [options]
     * @param {(prompt: {url: string, code: string, expires: number}) => void} [options.onPrompt]
     * @param {AbortSignal} [options.signal]
     * @param {(ms: number) => Promise<void>} [options.sleep]
     */
    async loginDevice({onPrompt, signal, sleep} = {}) {
        const wait = sleep || ((ms) => new Promise((r) => this.setTimer(r, ms)));
        const dev = await this.post('/security/oauth/device_authorization', {
            client_id: this.clientId,
            scope: this.scopes,
        });
        const expires = this.now() + (Number(dev.expires_in) || 300) * 1000;
        let interval = (Number(dev.interval) || 5) * 1000;
        const url = dev.verification_uri_complete || dev.verification_uri;
        onPrompt?.({url, code: dev.user_code, expires, verificationUri: dev.verification_uri});
        this.emit('prompt', {url, code: dev.user_code, expires});
        while (this.now() < expires) {
            if (signal?.aborted) {
                throw new AuthError('login aborted', {code: 'aborted'});
            }
            await wait(interval);
            try {
                const json = await this.post('/security/oauth/token', {
                    grant_type: 'device_code',
                    device_code: dev.device_code,
                    client_id: this.clientId,
                    ...(this.clientSecret && {client_secret: this.clientSecret}),
                });
                this.log?.info('auth: login successful');
                return this.applyTokens(json);
            } catch (err) {
                if (err.code === 'authorization_pending') {
                    continue;
                }
                if (err.code === 'slow_down') {
                    interval += 5000;
                    continue;
                }
                throw err;
            }
        }
        throw new AuthError('login timed out — the code expired', {code: 'expired_token'});
    }

    // --- login: authorization code ----------------------------------------------------------

    authorizeUrl(state) {
        const u = new URL('/security/oauth/authorize', this.host);
        u.searchParams.set('client_id', this.clientId);
        u.searchParams.set('response_type', 'code');
        u.searchParams.set('redirect_uri', this.redirectUri);
        u.searchParams.set('scope', this.scopes);
        u.searchParams.set('state', state);
        return u.toString();
    }

    /**
     * Start a one-shot http server on the callback port, print the authorize url, wait for the
     * browser redirect with the code, exchange it.
     * @param {object} [options]
     * @param {(prompt: {url: string}) => void} [options.onPrompt]
     * @param {number} [options.timeoutMs]
     */
    async loginCode({onPrompt, timeoutMs = 10 * 60 * 1000} = {}) {
        const state = crypto.randomBytes(16).toString('hex');
        const url = this.authorizeUrl(state);
        const code = await new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => {
                const q = new URL(req.url, 'http://localhost').searchParams;
                if (q.get('state') !== state) {
                    res.writeHead(400, {'Content-Type': 'text/plain'}).end('state mismatch');
                    return;
                }
                if (q.get('error')) {
                    res.writeHead(400, {'Content-Type': 'text/plain'}).end(`error: ${q.get('error')}`);
                    finish(new AuthError(`authorization failed: ${q.get('error')}`, {code: q.get('error')}));
                    return;
                }
                res.writeHead(200, {'Content-Type': 'text/plain'}).end(
                    'homeconnect2mqtt: authorized, you can close this tab',
                );
                finish(null, q.get('code'));
            });
            const timer = setTimeout(() => finish(new AuthError('login timed out', {code: 'timeout'})), timeoutMs);
            function finish(err, value) {
                clearTimeout(timer);
                server.close();
                if (err) {
                    reject(err);
                } else {
                    resolve(value);
                }
            }
            server.on('error', (err) => finish(err));
            // bind only where the registered redirect uri points (loopback by default) — the
            // callback server must not become a listener on every interface
            server.listen(this.callbackPort, this.callbackHost, () => {
                onPrompt?.({url});
                this.emit('prompt', {url});
            });
        });
        const json = await this.post('/security/oauth/token', {
            grant_type: 'authorization_code',
            client_id: this.clientId,
            ...(this.clientSecret && {client_secret: this.clientSecret}),
            code,
            redirect_uri: this.redirectUri,
        });
        this.log?.info('auth: login successful');
        return this.applyTokens(json);
    }
}
