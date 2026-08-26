/**
 * Thin Home Connect REST client on top of `fetch`.
 *
 *  - base url `https://api.home-connect.com/api` (or the simulator), `Accept` /
 *    `Content-Type: application/vnd.bsh.sdk.v1+json`, optional `Accept-Language`
 *  - bearer token from an `auth` object (`accessToken()`, `refresh()`); one automatic retry
 *    after a 401
 *  - every request goes through the `Budget` (`take()` before, `record()` after)
 *  - errors become `ApiError {status, key, description, retryAfter, method, path}`
 *  - `openStream()` returns the raw Response of the all-appliances SSE endpoint for `EventStream`
 */

export const PRODUCTION_HOST = 'https://api.home-connect.com';
export const SIMULATOR_HOST = 'https://simulator.home-connect.com';
export const MEDIA_TYPE = 'application/vnd.bsh.sdk.v1+json';

export class ApiError extends Error {
    constructor({status, key, description, retryAfter, method, path, cause}) {
        super(`${method} ${path} → ${status}${key ? ' ' + key : ''}${description ? ': ' + description : ''}`);
        this.name = 'ApiError';
        this.status = status;
        this.key = key;
        this.description = description;
        this.retryAfter = retryAfter;
        this.method = method;
        this.path = path;
        if (cause) {
            this.cause = cause;
        }
    }
}

function parseRetryAfter(headers) {
    const v = headers?.get?.('retry-after');
    if (!v) {
        return undefined;
    }
    const n = Number.parseInt(v, 10);
    if (!Number.isNaN(n)) {
        return n;
    }
    const date = Date.parse(v);
    return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

export class HomeConnectClient {
    /**
     * @param {object} options
     * @param {{accessToken: () => Promise<string>, refresh: () => Promise<any>}} options.auth
     * @param {import('./budget.js').Budget} options.budget
     * @param {object} options.log
     * @param {boolean} [options.simulator]
     * @param {string} [options.host] overrides simulator/production
     * @param {string} [options.language] Accept-Language
     * @param {typeof fetch} [options.fetch]
     * @param {number} [options.timeout] ms per request (not for streams)
     */
    constructor({auth, budget, log, simulator = false, host, language, fetch = globalThis.fetch, timeout = 30000}) {
        this.auth = auth;
        this.budget = budget;
        this.log = log;
        this.host = host || (simulator ? SIMULATOR_HOST : PRODUCTION_HOST);
        this.base = `${this.host}/api`;
        this.language = language;
        this.fetch = fetch;
        this.timeout = timeout;
    }

    async headers(extra = {}) {
        const token = await this.auth.accessToken();
        return {
            Authorization: `Bearer ${token}`,
            Accept: MEDIA_TYPE,
            ...(this.language && {'Accept-Language': this.language}),
            ...extra,
        };
    }

    /**
     * @param {string} method
     * @param {string} path relative to /api, e.g. /homeappliances
     * @param {object} [options]
     * @param {object} [options.data] request body (wrapped as {data})
     * @param {'request'|'start'|'stop'} [options.kind] budget class
     * @param {'background'|'command'} [options.priority]
     * @param {boolean} [options.retried] internal
     * @returns {Promise<any>} the `data` member of the response (undefined for 204)
     */
    async request(method, path, {data, kind = 'request', priority = 'background', retried = false} = {}) {
        this.budget.take(kind, {priority});
        const url = this.base + path;
        const body = data === undefined ? undefined : JSON.stringify({data});
        this.log.debug(`hc > ${method} ${path}${body ? ' ' + body : ''}`);
        let response;
        try {
            response = await this.fetch(url, {
                method,
                headers: await this.headers(body ? {'Content-Type': MEDIA_TYPE} : {}),
                body,
                signal: AbortSignal.timeout(this.timeout),
            });
        } catch (err) {
            this.budget.record(kind, {ok: false});
            throw new ApiError({status: 0, description: err.message, method, path, cause: err});
        }
        const text = await response.text();
        let json;
        if (text) {
            try {
                json = JSON.parse(text);
            } catch {
                json = undefined;
            }
        }
        if (response.ok) {
            this.budget.record(kind, {ok: true});
            this.log.debug(`hc < ${response.status} ${path}${text ? ' ' + text.slice(0, 500) : ''}`);
            return json?.data;
        }
        const retryAfter = parseRetryAfter(response.headers);
        const err = new ApiError({
            status: response.status,
            key: json?.error?.key,
            description: json?.error?.description ?? (json ? undefined : text.slice(0, 200)),
            retryAfter,
            method,
            path,
        });
        // 404 (no program active/selected) and 409 (appliance offline, wrong operation state, …)
        // are the appliance saying no — expected answers, not failures of the client
        const soft = response.status === 404 || response.status === 409;
        this.budget.record(kind, {ok: false, status: response.status, retryAfter, description: err.description, soft});
        if (response.status === 401 && !retried) {
            this.log.debug('hc: 401, refreshing the access token and retrying once');
            await this.auth.refresh();
            return this.request(method, path, {data, kind, priority, retried: true});
        }
        this.log.debug(`hc < ${response.status} ${path} ${text.slice(0, 300)}`);
        throw err;
    }

    get(path, options) {
        return this.request('GET', path, options);
    }

    put(path, data, options) {
        return this.request('PUT', path, {...options, data});
    }

    delete(path, options) {
        return this.request('DELETE', path, options);
    }

    // --- appliances -------------------------------------------------------------------------

    /** @returns {Promise<Array<{haId: string, name: string, brand: string, vib: string, type: string, enumber: string, connected: boolean}>>} */
    async appliances(options) {
        const data = await this.get('/homeappliances', options);
        return data?.homeappliances ?? [];
    }

    appliance(haId, options) {
        return this.get(`/homeappliances/${haId}`, options);
    }

    /** @returns {Promise<Array<{key: string, value: any, unit?: string}>>} */
    async status(haId, options) {
        return (await this.get(`/homeappliances/${haId}/status`, options))?.status ?? [];
    }

    async settings(haId, options) {
        return (await this.get(`/homeappliances/${haId}/settings`, options))?.settings ?? [];
    }

    setting(haId, key, options) {
        return this.get(`/homeappliances/${haId}/settings/${key}`, options);
    }

    setSetting(haId, key, value, options) {
        return this.put(`/homeappliances/${haId}/settings/${key}`, {key, value}, {priority: 'command', ...options});
    }

    async programs(haId, options) {
        return (await this.get(`/homeappliances/${haId}/programs`, options))?.programs ?? [];
    }

    async availablePrograms(haId, options) {
        return (await this.get(`/homeappliances/${haId}/programs/available`, options))?.programs ?? [];
    }

    availableProgram(haId, key, options) {
        return this.get(`/homeappliances/${haId}/programs/available/${key}`, options);
    }

    activeProgram(haId, options) {
        return this.get(`/homeappliances/${haId}/programs/active`, options);
    }

    selectedProgram(haId, options) {
        return this.get(`/homeappliances/${haId}/programs/selected`, options);
    }

    async activeOptions(haId, options) {
        return (await this.get(`/homeappliances/${haId}/programs/active/options`, options))?.options ?? [];
    }

    async selectedOptions(haId, options) {
        return (await this.get(`/homeappliances/${haId}/programs/selected/options`, options))?.options ?? [];
    }

    /**
     * @param {string} haId
     * @param {string} key full program key
     * @param {Array<{key: string, value: any, unit?: string}>} [programOptions]
     */
    startProgram(haId, key, programOptions = [], options) {
        return this.put(
            `/homeappliances/${haId}/programs/active`,
            {key, options: programOptions},
            {kind: 'start', priority: 'command', ...options},
        );
    }

    selectProgram(haId, key, programOptions = [], options) {
        return this.put(
            `/homeappliances/${haId}/programs/selected`,
            {key, options: programOptions},
            {priority: 'command', ...options},
        );
    }

    stopProgram(haId, options) {
        return this.delete(`/homeappliances/${haId}/programs/active`, {kind: 'stop', priority: 'command', ...options});
    }

    setActiveOption(haId, key, value, unit, options) {
        return this.put(
            `/homeappliances/${haId}/programs/active/options/${key}`,
            {key, value, ...(unit && {unit})},
            {priority: 'command', ...options},
        );
    }

    setSelectedOption(haId, key, value, unit, options) {
        return this.put(
            `/homeappliances/${haId}/programs/selected/options/${key}`,
            {key, value, ...(unit && {unit})},
            {priority: 'command', ...options},
        );
    }

    async commands(haId, options) {
        return (await this.get(`/homeappliances/${haId}/commands`, options))?.commands ?? [];
    }

    command(haId, key, value = true, options) {
        return this.put(`/homeappliances/${haId}/commands/${key}`, {key, value}, {priority: 'command', ...options});
    }

    async images(haId, options) {
        return (await this.get(`/homeappliances/${haId}/images`, options))?.images ?? [];
    }

    /** one-shot JSON snapshot of the event endpoint of one appliance */
    async events(haId, options) {
        return (await this.get(`/homeappliances/${haId}/events`, options))?.items ?? [];
    }

    // --- stream -----------------------------------------------------------------------------

    /**
     * Open the all-appliances event stream. Resolves with the Response once headers are in;
     * rejects with an ApiError for non-2xx.
     * @param {AbortSignal} signal
     * @param {string} [haId] stream of one appliance instead of all
     */
    async openStream(signal, haId) {
        const path = haId ? `/homeappliances/${haId}/events` : '/homeappliances/events';
        this.budget.take('stream');
        let response;
        try {
            response = await this.fetch(this.base + path, {
                method: 'GET',
                headers: await this.headers({Accept: 'text/event-stream'}),
                signal,
            });
        } catch (err) {
            this.budget.record('stream', {ok: false});
            throw new ApiError({status: 0, description: err.message, method: 'GET', path, cause: err});
        }
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            let json;
            try {
                json = JSON.parse(text);
            } catch {
                json = undefined;
            }
            const retryAfter = parseRetryAfter(response.headers);
            const err = new ApiError({
                status: response.status,
                key: json?.error?.key,
                description: json?.error?.description,
                retryAfter,
                method: 'GET',
                path,
            });
            this.budget.record('stream', {
                ok: false,
                status: response.status,
                retryAfter,
                description: err.description,
            });
            throw err;
        }
        this.budget.record('stream', {ok: true});
        return response;
    }
}
