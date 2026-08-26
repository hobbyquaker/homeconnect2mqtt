import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {Budget, BudgetError} from '../lib/budget.js';

function clock(start = 1_000_000_000_000) {
    let t = start;
    return {now: () => t, advance: (ms) => (t += ms)};
}

describe('Budget', () => {
    test('counts requests and refuses background work at the reserve', () => {
        const c = clock();
        const b = new Budget({dailyLimit: 10, reserve: 3, minuteLimit: 100, now: c.now});
        for (let i = 0; i < 7; i++) {
            b.take('request');
        }
        assert.equal(b.snapshot().day.used, 7);
        assert.match(b.check('request').reason, /reserve/);
        assert.equal(b.check('request', {priority: 'command'}), null);
        b.take('request', {priority: 'command'});
        b.take('request', {priority: 'command'});
        b.take('request', {priority: 'command'});
        assert.match(b.check('request', {priority: 'command'}).reason, /daily request limit/);
        assert.throws(() => b.take('request', {priority: 'command'}), BudgetError);
        // the day window rolls over 24 h after the first request
        c.advance(24 * 60 * 60 * 1000);
        assert.equal(b.check('request'), null);
        assert.equal(b.snapshot().day.used, 0);
    });

    test('minute window', () => {
        const c = clock();
        const b = new Budget({minuteLimit: 3, now: c.now});
        b.take('request');
        b.take('request');
        b.take('start');
        assert.match(b.check('request').reason, /per minute/);
        c.advance(30_000);
        assert.match(b.check('request').reason, /per minute/);
        c.advance(31_000);
        assert.equal(b.check('request'), null);
    });

    test('program start/stop limits', () => {
        const c = clock();
        const b = new Budget({startLimit: 1, stopLimit: 1, now: c.now});
        b.take('start');
        assert.match(b.check('start').reason, /program start/);
        assert.equal(b.check('stop'), null);
        assert.equal(b.check('request'), null);
        b.take('stop');
        assert.match(b.check('stop').reason, /program stop/);
        assert.equal(b.snapshot().starts, 1);
        assert.equal(b.snapshot().stops, 1);
        c.advance(60_001);
        assert.equal(b.check('start'), null);
        assert.equal(b.check('stop'), null);
    });

    test('refresh quota is separate from the request quota', () => {
        const c = clock();
        const b = new Budget({refreshMinuteLimit: 2, refreshDayLimit: 3, now: c.now});
        b.take('refresh');
        b.take('refresh');
        assert.match(b.check('refresh').reason, /refresh limit per minute/);
        assert.equal(b.snapshot().day.used, 0);
        c.advance(61_000);
        b.take('refresh');
        assert.match(b.check('refresh').reason, /refresh limit per day/);
        assert.equal(b.snapshot().refresh.day, 3);
    });

    test('429 with retry-after blocks the kind; a long one is the daily limit', () => {
        const c = clock();
        const b = new Budget({now: c.now});
        b.take('start');
        b.record('start', {
            ok: false,
            status: 429,
            retryAfter: 52,
            description: 'The rate limit "5 start program calls per minute" was reached',
        });
        assert.match(b.check('start').reason, /blocked/);
        assert.equal(b.check('start').waitMs, 52_000);
        assert.equal(b.check('request'), null, 'other kinds are not blocked');
        c.advance(52_000);
        assert.equal(b.check('start'), null);

        b.take('request');
        b.record('request', {
            ok: false,
            status: 429,
            retryAfter: 18295,
            description: 'The rate limit "1000 calls in 1 day" was reached',
        });
        const snap = b.snapshot();
        assert.equal(snap.day.used, 1000);
        assert.match(b.check('request', {priority: 'command'}).reason, /daily/);
        assert.equal(b.check('request', {priority: 'command'}).waitMs, 18295_000);
        c.advance(18295_000);
        assert.equal(b.check('request'), null);
        assert.equal(b.snapshot().day.used, 0);
    });

    test('successive errors pause everything for 10 minutes', () => {
        const c = clock();
        const b = new Budget({errorLimit: 3, now: c.now});
        for (let i = 0; i < 3; i++) {
            b.take('request');
            b.record('request', {ok: false, status: 500});
        }
        assert.match(b.check('request').reason, /successive errors/);
        assert.equal(b.check('stream'), null, 'the stream is never paused by our own error counter');
        c.advance(10 * 60_000 + 1);
        assert.equal(b.check('request'), null);
        b.take('request');
        b.record('request', {ok: true});
        assert.equal(b.snapshot().errors, 0);
    });

    test('soft errors (404/409) count as requests but not as failures', () => {
        const c = clock();
        const b = new Budget({errorLimit: 2, now: c.now});
        for (let i = 0; i < 5; i++) {
            b.take('request');
            b.record('request', {ok: false, status: 409, soft: true});
        }
        assert.equal(b.check('request'), null);
        assert.equal(b.snapshot().errors, 0);
        assert.equal(b.snapshot().day.used, 5);
    });

    test('persists and reloads its counters', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-budget-'));
        const file = path.join(dir, 'budget.json');
        const c = clock();
        const b = new Budget({file, now: c.now});
        b.take('request');
        b.take('request');
        b.close();
        const b2 = new Budget({file, now: c.now});
        assert.equal(b2.snapshot().day.used, 2);
        fs.rmSync(dir, {recursive: true});
    });
});
