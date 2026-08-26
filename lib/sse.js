/**
 * Server-Sent Events for the Home Connect API.
 *
 * `createParser()` is a pure, incremental parser of the text/event-stream format (fields
 * `event`, `data`, `id`, `retry`, comment lines, CR/LF/CRLF line endings, multi-line data).
 *
 * `EventStream` keeps one stream open forever: it opens it through a caller-supplied
 * `open(signal)` (the client's `openStream()`), feeds the parser, watches for keep-alives and
 * reconnects with exponential backoff and jitter. Home Connect event types: KEEP-ALIVE, STATUS,
 * NOTIFY, EVENT, CONNECTED, DISCONNECTED, PAIRED, DEPAIRED — `id:` carries the haId, `data:` the
 * JSON `{items: [...]}` (the all-appliances stream also puts `haId` into the data).
 */

import {EventEmitter} from 'node:events';
import {ApiError} from './client.js';

/**
 * @param {(event: {event: string, data: string, id: string | undefined, retry: number | undefined}) => void} onEvent
 */
export function createParser(onEvent) {
    let buffer = '';
    let eventType = '';
    let data = [];
    let id;
    let retry;

    function dispatch() {
        if (data.length > 0 || eventType) {
            onEvent({event: eventType || 'message', data: data.join('\n'), id, retry});
        }
        eventType = '';
        data = [];
        // id is sticky per spec; Home Connect sets it on every event anyway
    }

    function line(l) {
        if (l === '') {
            dispatch();
            return;
        }
        if (l.startsWith(':')) {
            return; // comment / heartbeat
        }
        const colon = l.indexOf(':');
        const field = colon === -1 ? l : l.slice(0, colon);
        let value = colon === -1 ? '' : l.slice(colon + 1);
        if (value.startsWith(' ')) {
            value = value.slice(1);
        }
        switch (field) {
            case 'event':
                eventType = value;
                break;
            case 'data':
                data.push(value);
                break;
            case 'id':
                id = value;
                break;
            case 'retry': {
                const n = Number.parseInt(value, 10);
                if (!Number.isNaN(n)) {
                    retry = n;
                }
                break;
            }
            default:
            // ignore unknown fields
        }
    }

    return {
        /** @param {string} chunk */
        feed(chunk) {
            buffer += chunk;
            // normalise line endings: CRLF, CR, LF all terminate a line
            let idx;
            while ((idx = buffer.search(/\r\n|\r|\n/)) !== -1) {
                const l = buffer.slice(0, idx);
                buffer = buffer.slice(idx + (buffer[idx] === '\r' && buffer[idx + 1] === '\n' ? 2 : 1));
                line(l);
            }
        },
        end() {
            if (buffer) {
                line(buffer);
                buffer = '';
            }
            dispatch();
        },
    };
}

/**
 * Parse a Home Connect SSE event into `{type, haId, items}`; `items` is `[]` for KEEP-ALIVE,
 * CONNECTED, DISCONNECTED, PAIRED, DEPAIRED (their `data` is the appliance object or empty).
 */
export function parseHomeConnectEvent({event, data, id}) {
    let parsed;
    if (data) {
        try {
            parsed = JSON.parse(data);
        } catch {
            parsed = undefined;
        }
    }
    return {
        type: event,
        haId: parsed?.haId ?? id ?? null,
        items: Array.isArray(parsed?.items) ? parsed.items : [],
        data: parsed,
    };
}

export class EventStream extends EventEmitter {
    /**
     * @param {object} options
     * @param {(signal: AbortSignal) => Promise<Response>} options.open returns the fetch Response (status checked here)
     * @param {object} options.log
     * @param {number} [options.keepaliveTimeout] ms without any bytes before reconnecting (default 130 s)
     * @param {number} [options.minBackoff] ms
     * @param {number} [options.maxBackoff] ms
     * @param {() => Promise<void>} [options.onUnauthorized] called before reconnecting after a 401
     * @param {(err: Error) => void} [options.onRefused] called with the error of a refused open (429 etc.)
     * @param {(ms: number, fn: () => void) => any} [options.setTimeout]
     * @param {() => number} [options.random]
     */
    constructor({
        open,
        log,
        keepaliveTimeout = 130000,
        minBackoff = 5000,
        maxBackoff = 300000,
        onUnauthorized,
        onRefused,
        setTimeout: setTimer = globalThis.setTimeout,
        random = Math.random,
    }) {
        super();
        this.open = open;
        this.log = log;
        this.keepaliveTimeout = keepaliveTimeout;
        this.minBackoff = minBackoff;
        this.maxBackoff = maxBackoff;
        this.onUnauthorized = onUnauthorized;
        this.onRefused = onRefused;
        this.setTimer = setTimer;
        this.random = random;
        this.backoff = minBackoff;
        this.running = false;
        this.connected = false;
        this.abort = null;
        this.watchdog = null;
        this.reconnectTimer = null;
        this.lastEvent = null;
    }

    start() {
        if (this.running) {
            return;
        }
        this.running = true;
        this.connect();
    }

    stop() {
        this.running = false;
        clearTimeout(this.reconnectTimer);
        this.stopWatchdog();
        this.abort?.abort();
        this.abort = null;
        if (this.connected) {
            this.connected = false;
            this.emit('close', 'stopped');
        }
    }

    resetWatchdog() {
        this.stopWatchdog();
        this.watchdog = this.setTimer(() => {
            this.log.warn(`hc: no event or keep-alive for ${Math.round(this.keepaliveTimeout / 1000)} s, reconnecting`);
            this.abort?.abort();
        }, this.keepaliveTimeout);
        this.watchdog.unref?.();
    }

    stopWatchdog() {
        clearTimeout(this.watchdog);
        this.watchdog = null;
    }

    async connect() {
        if (!this.running) {
            return;
        }
        const abort = new AbortController();
        this.abort = abort;
        let waitMs = null;
        try {
            this.log.debug('hc > GET /homeappliances/events (stream)');
            const response = await this.open(abort.signal);
            this.backoff = this.minBackoff;
            this.connected = true;
            this.emit('open');
            this.resetWatchdog();
            await this.read(response, abort.signal);
            // clean end of stream
            this.log.warn('hc: event stream ended by the server');
        } catch (err) {
            if (abort.signal.aborted && !this.running) {
                return; // stopped on purpose
            }
            if (err instanceof ApiError) {
                if (err.status === 401) {
                    this.log.warn('hc: event stream rejected (401), refreshing the token');
                    try {
                        await this.onUnauthorized?.();
                    } catch (e) {
                        this.log.warn(`hc: token refresh failed: ${e.message}`);
                    }
                } else if (err.status === 429) {
                    waitMs = (err.retryAfter ?? 60) * 1000;
                    this.log.warn(
                        `hc: event stream refused (429 ${err.description || ''}), retry in ${waitMs / 1000} s`,
                    );
                    this.onRefused?.(err);
                } else {
                    this.log.warn(`hc: event stream error ${err.status} ${err.key || ''} ${err.description || ''}`);
                }
            } else if (!abort.signal.aborted) {
                this.log.warn(`hc: event stream lost: ${err.message}`);
            }
            // not 'error': an unreachable api is normal operation for a daemon, and an
            // unhandled 'error' event would kill the process
            this.emit('lost', err);
        } finally {
            this.stopWatchdog();
            if (this.connected) {
                this.connected = false;
                this.emit('close', abort.signal.aborted ? 'watchdog' : 'lost');
            }
        }
        if (!this.running) {
            return;
        }
        const jitter = 1 + this.random() * 0.5;
        const delay = waitMs ?? Math.round(this.backoff * jitter);
        this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
        this.log.debug(`hc: reconnecting the event stream in ${Math.round(delay / 1000)} s`);
        this.reconnectTimer = this.setTimer(() => this.connect(), delay);
    }

    async read(response, signal) {
        const decoder = new TextDecoder();
        const parser = createParser((raw) => {
            this.lastEvent = Date.now();
            if (raw.event === 'KEEP-ALIVE') {
                this.emit('keepalive');
                return;
            }
            const event = parseHomeConnectEvent(raw);
            this.emit('event', event);
        });
        for await (const chunk of response.body) {
            if (signal.aborted) {
                break;
            }
            this.resetWatchdog();
            parser.feed(decoder.decode(chunk, {stream: true}));
        }
        parser.end();
    }
}
