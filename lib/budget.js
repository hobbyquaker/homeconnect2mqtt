/**
 * Request budget for the Home Connect API (rate limits per client_id + user account, see
 * ROADMAP §2.3 / §4.6):
 *
 *   1000 requests / day, 50 / minute, 5 program starts / minute, 5 program stops / minute,
 *   10 token refreshes / minute and 100 / day, 10 successive errors / 10 minutes → blocked 10 min.
 *
 * The budget counts every request the adapter makes, refuses background work when the daily
 * reserve for commands is reached, honours Retry-After blocks and persists its counters so a
 * restart does not forget what was already spent today.
 *
 * Pure apart from the optional file persistence; `now` is injectable for tests.
 */

import fs from 'node:fs';
import path from 'node:path';

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

export const KINDS = ['request', 'start', 'stop', 'refresh', 'stream'];

export class BudgetError extends Error {
    /**
     * @param {string} message
     * @param {{kind: string, reason: string, waitMs: number}} info
     */
    constructor(message, info) {
        super(message);
        this.name = 'BudgetError';
        this.kind = info.kind;
        this.reason = info.reason;
        this.waitMs = info.waitMs;
    }
}

function prune(list, now, window) {
    while (list.length && list[0] <= now - window) {
        list.shift();
    }
    return list;
}

export class Budget {
    /**
     * @param {object} [options]
     * @param {number} [options.dailyLimit]
     * @param {number} [options.minuteLimit]
     * @param {number} [options.startLimit] program starts per minute
     * @param {number} [options.stopLimit] program stops per minute
     * @param {number} [options.refreshMinuteLimit]
     * @param {number} [options.refreshDayLimit]
     * @param {number} [options.reserve] daily requests kept for `priority: 'command'`
     * @param {number} [options.errorLimit] consecutive errors before a self-imposed 10 min pause
     * @param {string} [options.file] persistence file (JSON); omit for in-memory only
     * @param {() => number} [options.now]
     * @param {object} [options.log]
     */
    constructor({
        dailyLimit = 1000,
        minuteLimit = 50,
        startLimit = 5,
        stopLimit = 5,
        refreshMinuteLimit = 10,
        refreshDayLimit = 100,
        reserve = 100,
        errorLimit = 5,
        file,
        now = () => Date.now(),
        log,
    } = {}) {
        this.limits = {
            dailyLimit,
            minuteLimit,
            startLimit,
            stopLimit,
            refreshMinuteLimit,
            refreshDayLimit,
            reserve,
            errorLimit,
        };
        this.file = file;
        this.now = now;
        this.log = log;
        this.state = {
            dayStart: null, // ms epoch of the first request of the current day window
            dayReset: null, // ms epoch when BSH said the day quota resets (from Retry-After)
            dayUsed: 0,
            minute: [], // timestamps of requests in the last minute
            starts: [],
            stops: [],
            refreshMinute: [],
            refreshDayStart: null,
            refreshDayUsed: 0,
            blockedUntil: {}, // kind → ms epoch
            consecutiveErrors: 0,
            lastError: null,
        };
        this.load();
    }

    load() {
        if (!this.file || !fs.existsSync(this.file)) {
            return;
        }
        try {
            const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            this.state = {...this.state, ...saved};
            this.log?.debug(`budget: loaded ${this.file} (${this.state.dayUsed} requests used today)`);
        } catch (err) {
            this.log?.warn(`budget: cannot read ${this.file}: ${err.message}`);
        }
    }

    save() {
        if (!this.file) {
            return;
        }
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            try {
                fs.mkdirSync(path.dirname(this.file), {recursive: true});
                fs.writeFileSync(this.file, JSON.stringify(this.state, null, 1));
            } catch (err) {
                this.log?.warn(`budget: cannot write ${this.file}: ${err.message}`);
            }
        }, 1000);
        this.saveTimer.unref?.();
    }

    close() {
        clearTimeout(this.saveTimer);
        if (this.file) {
            try {
                fs.mkdirSync(path.dirname(this.file), {recursive: true});
                fs.writeFileSync(this.file, JSON.stringify(this.state, null, 1));
            } catch {
                // ignore on shutdown
            }
        }
    }

    /** roll the windows forward */
    tick() {
        const now = this.now();
        const s = this.state;
        if (s.dayStart !== null) {
            const end = s.dayReset ?? s.dayStart + DAY;
            if (now >= end) {
                s.dayStart = null;
                s.dayReset = null;
                s.dayUsed = 0;
            }
        }
        if (s.refreshDayStart !== null && now >= s.refreshDayStart + DAY) {
            s.refreshDayStart = null;
            s.refreshDayUsed = 0;
        }
        prune(s.minute, now, MINUTE);
        prune(s.starts, now, MINUTE);
        prune(s.stops, now, MINUTE);
        prune(s.refreshMinute, now, MINUTE);
        for (const [kind, until] of Object.entries(s.blockedUntil)) {
            if (until <= now) {
                delete s.blockedUntil[kind];
            }
        }
        return now;
    }

    /**
     * Can a request of this kind be made now?
     * @param {string} [kind] request | start | stop | refresh | stream
     * @param {{priority?: 'background' | 'command'}} [options]
     * @returns {null | {reason: string, waitMs: number}} null when allowed
     */
    check(kind = 'request', {priority = 'background'} = {}) {
        const now = this.tick();
        const s = this.state;
        const L = this.limits;
        const blocked = s.blockedUntil[kind] ?? s.blockedUntil.request;
        if (blocked && blocked > now) {
            return {reason: `blocked by the api (retry-after)`, waitMs: blocked - now};
        }
        // the self-imposed pause never blocks the event stream: it is the cheapest and most
        // important request, and an api-side block shows up there as a 429 anyway
        if (
            kind !== 'stream' &&
            s.consecutiveErrors >= L.errorLimit &&
            s.lastError &&
            s.lastError > now - 10 * MINUTE
        ) {
            return {
                reason: `${s.consecutiveErrors} successive errors, pausing`,
                waitMs: s.lastError + 10 * MINUTE - now,
            };
        }
        if (kind === 'refresh') {
            if (s.refreshMinute.length >= L.refreshMinuteLimit) {
                return {reason: 'token refresh limit per minute', waitMs: s.refreshMinute[0] + MINUTE - now};
            }
            if (s.refreshDayUsed >= L.refreshDayLimit) {
                return {reason: 'token refresh limit per day', waitMs: s.refreshDayStart + DAY - now};
            }
            return null;
        }
        const dayEnd = s.dayStart === null ? now : (s.dayReset ?? s.dayStart + DAY);
        const dayLimit = priority === 'command' ? L.dailyLimit : L.dailyLimit - L.reserve;
        if (s.dayUsed >= dayLimit) {
            return {
                reason: priority === 'command' ? 'daily request limit reached' : 'daily budget reserve reached',
                waitMs: Math.max(0, dayEnd - now),
            };
        }
        if (s.minute.length >= L.minuteLimit) {
            return {reason: 'request limit per minute', waitMs: s.minute[0] + MINUTE - now};
        }
        if (kind === 'start' && s.starts.length >= L.startLimit) {
            return {reason: 'program start limit per minute', waitMs: s.starts[0] + MINUTE - now};
        }
        if (kind === 'stop' && s.stops.length >= L.stopLimit) {
            return {reason: 'program stop limit per minute', waitMs: s.stops[0] + MINUTE - now};
        }
        return null;
    }

    /**
     * Reserve one request of this kind or throw a BudgetError.
     */
    take(kind = 'request', options = {}) {
        const refused = this.check(kind, options);
        if (refused) {
            throw new BudgetError(`budget: ${refused.reason} (wait ${Math.ceil(refused.waitMs / 1000)} s)`, {
                kind,
                ...refused,
            });
        }
        const now = this.now();
        const s = this.state;
        if (kind === 'refresh') {
            s.refreshMinute.push(now);
            if (s.refreshDayStart === null) {
                s.refreshDayStart = now;
            }
            s.refreshDayUsed++;
        } else {
            if (s.dayStart === null) {
                s.dayStart = now;
            }
            s.dayUsed++;
            s.minute.push(now);
            if (kind === 'start') {
                s.starts.push(now);
            }
            if (kind === 'stop') {
                s.stops.push(now);
            }
        }
        this.save();
    }

    /**
     * Record the outcome of a request.
     * @param {string} kind
     * @param {{ok: boolean, status?: number, retryAfter?: number, description?: string, soft?: boolean}} result
     *   `soft`: an expected negative answer (appliance offline, no program active) — counted as a
     *   request but not as a failure of ours
     */
    record(kind, {ok, status, retryAfter, description, soft = false} = {}) {
        const now = this.now();
        const s = this.state;
        if (ok) {
            s.consecutiveErrors = 0;
        } else if (!soft) {
            s.consecutiveErrors++;
            s.lastError = now;
        }
        if (status === 429) {
            const wait = (retryAfter ?? (kind === 'stream' ? 60 : 2)) * 1000;
            const daily = /day/i.test(description || '') || (retryAfter ?? 0) > 600;
            if (daily && kind !== 'refresh') {
                s.dayUsed = Math.max(s.dayUsed, this.limits.dailyLimit);
                s.dayStart ??= now;
                s.dayReset = now + wait;
                this.log?.warn(`budget: daily limit reached, blocked for ${Math.ceil(wait / 1000)} s`);
            } else {
                s.blockedUntil[kind] = now + wait;
                this.log?.warn(`budget: ${kind} blocked for ${Math.ceil(wait / 1000)} s (${description || '429'})`);
            }
        }
        this.save();
    }

    /** retained `status/bridge/quota` payload */
    snapshot() {
        const now = this.tick();
        const s = this.state;
        const L = this.limits;
        const blocked = Object.entries(s.blockedUntil).map(([kind, until]) => ({
            kind,
            until: new Date(until).toISOString(),
        }));
        return {
            day: {
                used: s.dayUsed,
                limit: L.dailyLimit,
                reserve: L.reserve,
                reset: s.dayStart === null ? null : new Date(s.dayReset ?? s.dayStart + DAY).toISOString(),
            },
            minute: {used: s.minute.length, limit: L.minuteLimit},
            starts: s.starts.length,
            stops: s.stops.length,
            refresh: {minute: s.refreshMinute.length, day: s.refreshDayUsed, dayLimit: L.refreshDayLimit},
            errors: s.consecutiveErrors,
            blocked,
            ts: now,
        };
    }
}
