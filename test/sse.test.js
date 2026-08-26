import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {createParser, parseHomeConnectEvent, EventStream} from '../lib/sse.js';
import {ApiError} from '../lib/client.js';

const silent = {debug() {}, info() {}, warn() {}, error() {}};

describe('createParser', () => {
    test('dispatches on blank lines, handles CRLF/CR/LF and chunk boundaries', () => {
        const got = [];
        const p = createParser((e) => got.push(e));
        p.feed('event: STATUS\r\ndata: {"items":[1]}\r\nid: BOSCH-1\r\n\r\nevent: KEEP');
        p.feed('-ALIVE\n\n');
        p.feed('event: NOTIFY\rdata: {"a":1}\rid: X\r\r');
        assert.equal(got.length, 3);
        assert.deepEqual(got[0], {event: 'STATUS', data: '{"items":[1]}', id: 'BOSCH-1', retry: undefined});
        assert.equal(got[1].event, 'KEEP-ALIVE');
        assert.equal(got[1].data, '');
        assert.equal(got[2].event, 'NOTIFY');
        assert.equal(got[2].id, 'X');
    });

    test('multi-line data, comments, retry, no-space values, end()', () => {
        const got = [];
        const p = createParser((e) => got.push(e));
        p.feed(': heartbeat\n');
        p.feed('retry:5000\ndata:a\ndata: b\n\n');
        p.feed('data: tail');
        p.end();
        assert.equal(got.length, 2);
        assert.equal(got[0].data, 'a\nb');
        assert.equal(got[0].retry, 5000);
        assert.equal(got[0].event, 'message');
        assert.equal(got[1].data, 'tail');
    });

    test('blank lines without content dispatch nothing', () => {
        const got = [];
        const p = createParser((e) => got.push(e));
        p.feed('\n\n\n');
        p.feed(': only comments\n\n');
        assert.equal(got.length, 0);
    });
});

describe('parseHomeConnectEvent', () => {
    test('items and haId from id or data', () => {
        const e = parseHomeConnectEvent({
            event: 'NOTIFY',
            data: '{"items":[{"key":"BSH.Common.Root.SelectedProgram","value":"Dishcare.Dishwasher.Program.Eco50","timestamp":1479476432,"level":"hint","handling":"none"}]}',
            id: 'BOSCH-HCS02DWH1-7F930F92AD1403',
        });
        assert.equal(e.type, 'NOTIFY');
        assert.equal(e.haId, 'BOSCH-HCS02DWH1-7F930F92AD1403');
        assert.equal(e.items.length, 1);
        assert.equal(e.items[0].key, 'BSH.Common.Root.SelectedProgram');
        const all = parseHomeConnectEvent({event: 'STATUS', data: '{"haId":"X-1","items":[]}', id: 'X-1'});
        assert.equal(all.haId, 'X-1');
    });

    test('connection events carry the appliance in data', () => {
        const e = parseHomeConnectEvent({event: 'CONNECTED', data: '{"haId":"X-1","connected":true}', id: 'X-1'});
        assert.equal(e.type, 'CONNECTED');
        assert.deepEqual(e.items, []);
        assert.equal(e.data.connected, true);
        const d = parseHomeConnectEvent({event: 'DISCONNECTED', data: '', id: 'X-2'});
        assert.equal(d.haId, 'X-2');
        assert.equal(d.data, undefined);
    });
});

function bodyFrom(chunks) {
    // async iterable of Uint8Array like a fetch body
    return {
        async *[Symbol.asyncIterator]() {
            for (const c of chunks) {
                yield typeof c === 'string' ? new TextEncoder().encode(c) : await c;
            }
        },
    };
}

describe('EventStream', () => {
    test('emits open, events, keepalive, close and reconnects with backoff', async () => {
        const timers = [];
        const setTimer = (fn, ms) => {
            const t = {fn, ms, unref() {}};
            timers.push(t);
            return t;
        };
        let opens = 0;
        const stream = new EventStream({
            open: async () => {
                opens++;
                if (opens === 1) {
                    return {
                        body: bodyFrom([
                            'event: KEEP-ALIVE\n\n',
                            'event: STATUS\ndata: {"items":[{"key":"k","value":1}]}\nid: A-1\n\n',
                        ]),
                    };
                }
                throw new ApiError({status: 0, description: 'ECONNRESET', method: 'GET', path: '/x'});
            },
            log: silent,
            setTimeout: setTimer,
            random: () => 0,
            minBackoff: 1000,
        });
        const seen = [];
        stream.on('open', () => seen.push('open'));
        stream.on('keepalive', () => seen.push('keepalive'));
        stream.on('event', (e) => seen.push(`event:${e.type}:${e.haId}:${e.items[0].value}`));
        stream.on('close', (why) => seen.push(`close:${why}`));
        stream.on('lost', () => {});
        stream.start();
        // wait for the first connect to finish
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        assert.deepEqual(seen, ['open', 'keepalive', 'event:STATUS:A-1:1', 'close:lost']);
        // a reconnect timer with the min backoff was set (watchdog timers have the keepalive timeout)
        const reconnect = timers.find((t) => t.ms === 1000);
        assert.ok(reconnect, 'reconnect scheduled');
        // fire it: the second open fails → backoff doubles
        reconnect.fn();
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        assert.equal(opens, 2);
        assert.ok(
            timers.some((t) => t.ms === 2000),
            'backoff doubled',
        );
        stream.stop();
    });

    test('flap damping: a stream that dies right after opening keeps the grown backoff', async () => {
        const timers = [];
        const setTimer = (fn, ms) => {
            const t = {fn, ms, unref() {}};
            timers.push(t);
            return t;
        };
        let opens = 0;
        const stream = new EventStream({
            open: async () => {
                opens++;
                if (opens <= 2) {
                    throw new ApiError({status: 0, description: 'ECONNRESET', method: 'GET', path: '/x'});
                }
                // accepted, then immediately closed by the server
                return {body: bodyFrom([])};
            },
            log: silent,
            setTimeout: setTimer,
            random: () => 0,
            minBackoff: 1000,
            flapWindow: 10000,
        });
        stream.on('lost', () => {});
        stream.start();
        const settle = async () => {
            for (let i = 0; i < 4; i++) {
                await new Promise((r) => setImmediate(r));
            }
        };
        await settle();
        timers.find((t) => t.ms === 1000).fn(); // reconnect #1 → fails → backoff 2 s
        await settle();
        timers.find((t) => t.ms === 2000).fn(); // reconnect #2 → opens, closes at once
        await settle();
        assert.equal(opens, 3);
        // the backoff was 4 s when the short-lived stream opened and must still be 4 s
        assert.ok(
            timers.some((t) => t.ms === 4000),
            'backoff not reset by the flapping stream',
        );
        stream.stop();
    });

    test('429 waits retry-after, 401 calls onUnauthorized', async () => {
        const timers = [];
        const setTimer = (fn, ms) => {
            const t = {fn, ms, unref() {}};
            timers.push(t);
            return t;
        };
        let refreshed = 0;
        let opens = 0;
        const stream = new EventStream({
            open: async () => {
                opens++;
                if (opens === 1) {
                    throw new ApiError({
                        status: 429,
                        description: 'Too many parallel monitoring connections',
                        retryAfter: 42,
                        method: 'GET',
                        path: '/x',
                    });
                }
                throw new ApiError({status: 401, method: 'GET', path: '/x'});
            },
            log: silent,
            setTimeout: setTimer,
            random: () => 0,
            onUnauthorized: async () => {
                refreshed++;
            },
        });
        stream.on('lost', () => {});
        stream.start();
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        assert.ok(
            timers.some((t) => t.ms === 42000),
            'waits retry-after',
        );
        timers.find((t) => t.ms === 42000).fn();
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        assert.equal(refreshed, 1);
        stream.stop();
    });
});
