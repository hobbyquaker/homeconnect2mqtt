import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {cloudValue, parseHosts, readLocalFile, toItems, vibOf, LocalAppliances} from '../lib/local.js';
import {itemFor, shortEnum, toValue} from '../lib/keys.js';

const fixture = path.join(import.meta.dirname, 'fixtures', 'local.json');
const HA_ID = 'SIEMENS-HB000000000-68A40E000000';
const log = {info() {}, warn() {}, debug() {}};

describe('local transport', () => {
    test('a local.json yields appliances in the shape of client.appliances()', () => {
        const {configs} = readLocalFile(fixture);
        assert.equal(configs.length, 1);
        assert.equal(Object.keys(configs[0].profile.features).length, 31);
        const local = new LocalAppliances({configs, log});
        assert.deepEqual(local.appliances(), [
            {
                haId: HA_ID,
                name: 'oven',
                brand: 'SIEMENS',
                vib: 'HB000000000',
                type: 'Oven',
                enumber: '',
                connected: false,
            },
        ]);
    });

    test('reported values become event items with the cloud vocabulary, so keys.js applies unchanged', () => {
        const {configs} = readLocalFile(fixture);
        const profile = configs[0].profile;
        const byName = (name) => Number(Object.entries(profile.features).find(([, f]) => f.name === name)[0]);
        const items = toItems(profile, [
            {uid: byName('BSH.Common.Status.OperationState'), value: 3},
            {uid: byName('BSH.Common.Status.RemoteControlStartAllowed'), value: true},
            {uid: byName('Cooking.Oven.Status.Cavity.001.CurrentTemperature'), value: 182.5},
            {uid: 999999, value: 1},
        ]);
        assert.deepEqual(items, [
            {key: 'BSH.Common.Status.OperationState', value: 'BSH.Common.EnumType.OperationState.Run'},
            {key: 'BSH.Common.Status.RemoteControlStartAllowed', value: true},
            {key: 'Cooking.Oven.Status.Cavity.001.CurrentTemperature', value: 182.5},
        ]);
        const item = itemFor(items[0].key);
        assert.equal(item.category, 'status');
        assert.equal(item.item, 'operation_state');
        assert.equal(shortEnum(items[0].value), 'run');
        assert.equal(toValue(items[0].value), 'run');
        assert.equal(
            cloudValue(profile, profile.features[String(byName('BSH.Common.Root.ActiveProgram'))], 8208),
            'Cooking.Oven.Program.HeatingMode.HotAir',
        );
    });

    test('hosts and vibs', () => {
        assert.deepEqual(parseHosts(' a=10.0.0.1, b = 10.0.0.2 ,,'), {a: '10.0.0.1', b: '10.0.0.2'});
        assert.deepEqual(parseHosts(undefined), {});
        assert.equal(vibOf(HA_ID), 'HB000000000');
        assert.equal(vibOf('nodash'), '');
    });
});
