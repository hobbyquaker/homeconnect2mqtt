import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {makeRedactor} from '../lib/dump.js';

describe('makeRedactor', () => {
    const appliances = [
        {haId: 'SIEMENS-SN658X06TE-0123456789AB', type: 'Dishwasher', name: 'Geschirrspüler'},
        {haId: '012345678901234567-001', type: 'Oven', name: 'Backofen'},
    ];

    test('redacts ids and names, including inside event uris', () => {
        const r = makeRedactor(appliances, true);
        assert.equal(r.haId('012345678901234567-001'), 'OVEN-2');
        assert.equal(r.name('SIEMENS-SN658X06TE-0123456789AB', 'Geschirrspüler'), 'Dishwasher 1');
        const line = JSON.stringify({
            haId: 'OVEN-2',
            items: [{uri: '/api/homeappliances/012345678901234567-001/status/X', key: 'X'}],
        });
        assert.doesNotMatch(r.text(line), /012345678901234567/);
        assert.match(r.text(line), /homeappliances\/OVEN-2\/status/);
        assert.equal(r.haId('unknown'), 'unknown');
    });

    test('disabled redactor is the identity', () => {
        const r = makeRedactor(appliances, false);
        assert.equal(r.haId('012345678901234567-001'), '012345678901234567-001');
        assert.equal(r.name('x', 'Backofen'), 'Backofen');
        assert.equal(r.text('abc 012345678901234567-001'), 'abc 012345678901234567-001');
    });
});
