import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {HomeConnectClient, ApiError, MEDIA_TYPE} from '../lib/client.js';
import {Budget} from '../lib/budget.js';

const silent = {debug() {}, info() {}, warn() {}, error() {}};

function response(status, body, headers = {}) {
    const text = typeof body === 'string' ? body : body === undefined ? '' : JSON.stringify(body);
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: {get: (k) => headers[k.toLowerCase()]},
        text: async () => text,
    };
}

function setup({responses, simulator = false} = {}) {
    const calls = [];
    let refreshes = 0;
    const auth = {
        accessToken: async () => 'tok' + refreshes,
        refresh: async () => {
            refreshes++;
        },
    };
    const fetch = async (url, init) => {
        calls.push({url, init});
        const next = responses.shift();
        if (typeof next === 'function') {
            return next(url, init);
        }
        return next;
    };
    const budget = new Budget({});
    const client = new HomeConnectClient({auth, budget, log: silent, fetch, simulator, language: 'de-DE'});
    return {client, calls, budget, refreshes: () => refreshes};
}

describe('HomeConnectClient', () => {
    test('GET unwraps data and sends the bsh headers', async () => {
        const {client, calls} = setup({
            responses: [response(200, {data: {homeappliances: [{haId: 'A', name: 'Spülmaschine'}]}})],
        });
        const list = await client.appliances();
        assert.deepEqual(list, [{haId: 'A', name: 'Spülmaschine'}]);
        assert.equal(calls[0].url, 'https://api.home-connect.com/api/homeappliances');
        assert.equal(calls[0].init.headers.Authorization, 'Bearer tok0');
        assert.equal(calls[0].init.headers.Accept, MEDIA_TYPE);
        assert.equal(calls[0].init.headers['Accept-Language'], 'de-DE');
        assert.equal(calls[0].init.body, undefined);
    });

    test('simulator host', () => {
        const {client} = setup({responses: [], simulator: true});
        assert.equal(client.base, 'https://simulator.home-connect.com/api');
    });

    test('PUT wraps the body in {data} and uses the start budget class', async () => {
        const {client, calls, budget} = setup({responses: [response(204)]});
        const r = await client.startProgram('A', 'Dishcare.Dishwasher.Program.Eco50', [
            {key: 'BSH.Common.Option.StartInRelative', value: 1800, unit: 'seconds'},
        ]);
        assert.equal(r, undefined);
        assert.equal(calls[0].init.method, 'PUT');
        assert.equal(calls[0].url, 'https://api.home-connect.com/api/homeappliances/A/programs/active');
        assert.equal(calls[0].init.headers['Content-Type'], MEDIA_TYPE);
        assert.deepEqual(JSON.parse(calls[0].init.body), {
            data: {
                key: 'Dishcare.Dishwasher.Program.Eco50',
                options: [{key: 'BSH.Common.Option.StartInRelative', value: 1800, unit: 'seconds'}],
            },
        });
        assert.equal(budget.snapshot().starts, 1);
        assert.equal(budget.snapshot().day.used, 1);
    });

    test('api errors become ApiError with key, description and retry-after', async () => {
        const {client, budget} = setup({
            responses: [
                response(
                    429,
                    {error: {key: '429', description: 'The rate limit "5 start program calls per minute" was reached'}},
                    {'retry-after': '52'},
                ),
            ],
        });
        await assert.rejects(
            () => client.startProgram('A', 'X'),
            (err) => {
                assert.ok(err instanceof ApiError);
                assert.equal(err.status, 429);
                assert.equal(err.key, '429');
                assert.equal(err.retryAfter, 52);
                assert.match(err.message, /PUT \/homeappliances\/A\/programs\/active → 429/);
                return true;
            },
        );
        assert.match(budget.check('start').reason, /blocked/);
    });

    test('528 appliance errors carry the bsh error key', async () => {
        const {client, budget} = setup({
            responses: [
                response(409, {
                    error: {
                        key: 'SDK.Error.WrongOperationState',
                        description: 'HomeAppliance is in wrong operation state',
                    },
                }),
            ],
        });
        await assert.rejects(() => client.stopProgram('A'), {status: 409, key: 'SDK.Error.WrongOperationState'});
        assert.equal(budget.snapshot().errors, 0, '409 is a soft error');
    });

    test('404 no program active is a soft error, 500 is not', async () => {
        const {client, budget} = setup({
            responses: [
                response(404, {error: {key: 'SDK.Error.NoProgramActive', description: 'There is no program active'}}),
                response(500, {error: {key: 'SDK.Error.Internal'}}),
            ],
        });
        await assert.rejects(() => client.activeProgram('A'), {status: 404, key: 'SDK.Error.NoProgramActive'});
        assert.equal(budget.snapshot().errors, 0);
        await assert.rejects(() => client.activeProgram('A'), {status: 500});
        assert.equal(budget.snapshot().errors, 1);
    });

    test('401 refreshes the token and retries once', async () => {
        const {client, calls, refreshes} = setup({
            responses: [
                response(401, {error: {key: 'invalid_token'}}),
                response(200, {data: {status: [{key: 'k', value: 1}]}}),
            ],
        });
        const status = await client.status('A');
        assert.deepEqual(status, [{key: 'k', value: 1}]);
        assert.equal(refreshes(), 1);
        assert.equal(calls.length, 2);
        assert.equal(calls[1].init.headers.Authorization, 'Bearer tok1');
    });

    test('a second 401 is thrown', async () => {
        const {client} = setup({responses: [response(401, {}), response(401, {})]});
        await assert.rejects(() => client.status('A'), {status: 401});
    });

    test('network errors become status 0 and count as errors', async () => {
        const {client, budget} = setup({
            responses: [
                () => {
                    throw new Error('ECONNRESET');
                },
            ],
        });
        await assert.rejects(() => client.appliances(), {status: 0, description: 'ECONNRESET'});
        assert.equal(budget.snapshot().errors, 1);
    });

    test('the budget refuses before fetch is called', async () => {
        const {client, calls, budget} = setup({responses: []});
        budget.limits.dailyLimit = 1;
        budget.limits.reserve = 0;
        budget.take('request');
        await assert.rejects(() => client.appliances(), {name: 'BudgetError'});
        assert.equal(calls.length, 0);
    });

    test('openStream asks for text/event-stream and rejects non-2xx', async () => {
        const {client, calls, budget} = setup({
            responses: [
                response(429, {
                    error: {key: '429', description: 'Too many parallel monitoring connections. Maximum is 10.'},
                }),
                {ok: true, status: 200, headers: {get: () => undefined}, body: {}},
            ],
        });
        await assert.rejects(() => client.openStream(new AbortController().signal), {status: 429});
        // a 429 without retry-after blocks the stream class for 60 s
        assert.match(budget.check('stream').reason, /blocked/);
        assert.equal(budget.check('request'), null);
        budget.state.blockedUntil = {};
        const r = await client.openStream(new AbortController().signal);
        assert.equal(r.status, 200);
        assert.equal(calls[1].init.headers.Accept, 'text/event-stream');
        assert.equal(calls[1].url, 'https://api.home-connect.com/api/homeappliances/events');
    });
});
