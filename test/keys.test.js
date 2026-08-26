import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {snake, shortEnum, shortProgram, toValue, itemFor, fullEnum, fullProgram} from '../lib/keys.js';

describe('snake', () => {
    test('camel case, acronyms, digits', () => {
        assert.equal(snake('RemoteControlStartAllowed'), 'remote_control_start_allowed');
        assert.equal(snake('DelayedStart'), 'delayed_start');
        assert.equal(snake('XLCoffee'), 'xl_coffee');
        assert.equal(snake('IDos1Active'), 'i_dos_1_active');
        assert.equal(snake('DescalingIn20Cups'), 'descaling_in_20_cups');
        assert.equal(snake('HotAir30Steam'), 'hot_air_30_steam');
        assert.equal(snake('Eco50'), 'eco50');
        assert.equal(snake('RPM1400'), 'rpm1400');
        assert.equal(snake('GC40'), 'gc40');
        assert.equal(snake('Level01'), 'level01');
        assert.equal(snake('3DHotAir'), '3d_hot_air');
        assert.equal(snake('CurrentCavityTemperature'), 'current_cavity_temperature');
        assert.equal(snake('BeverageCounterRistrettoEspresso'), 'beverage_counter_ristretto_espresso');
    });
});

describe('shortEnum / shortProgram / toValue', () => {
    test('enums', () => {
        assert.equal(shortEnum('BSH.Common.EnumType.OperationState.Run'), 'run');
        assert.equal(shortEnum('BSH.Common.EnumType.OperationState.DelayedStart'), 'delayed_start');
        assert.equal(shortEnum('LaundryCare.Washer.EnumType.Temperature.GC40'), 'gc40');
        assert.equal(shortEnum('LaundryCare.Washer.EnumType.SpinSpeed.RPM1400'), 'rpm1400');
        assert.equal(shortEnum('BSH.Common.EnumType.EventPresentState.Present'), 'present');
        assert.equal(shortEnum('plain'), 'plain');
        assert.equal(shortEnum(42), 42);
    });

    test('programs', () => {
        assert.equal(shortProgram('Dishcare.Dishwasher.Program.Eco50'), 'eco50');
        assert.equal(shortProgram('Cooking.Oven.Program.HeatingMode.HotAir'), 'heating_mode.hot_air');
        assert.equal(shortProgram('ConsumerProducts.CoffeeMaker.Program.Beverage.Espresso'), 'beverage.espresso');
        assert.equal(shortProgram('LaundryCare.Washer.Program.Cotton.Eco4060'), 'cotton.eco4060');
        assert.equal(shortProgram('no program here'), 'no program here');
    });

    test('toValue', () => {
        assert.equal(toValue('Dishcare.Dishwasher.Program.Eco50'), 'eco50');
        assert.equal(toValue('BSH.Common.EnumType.DoorState.Closed'), 'closed');
        assert.equal(toValue(1800), 1800);
        assert.equal(toValue(true), true);
        assert.equal(toValue(null), null);
    });
});

describe('itemFor', () => {
    test('special keys', () => {
        assert.deepEqual(itemFor('BSH.Common.Status.OperationState'), {
            category: 'status',
            item: 'operation_state',
            leaf: 'operation_state',
        });
        assert.equal(itemFor('BSH.Common.Setting.PowerState').item, 'power');
        assert.equal(itemFor('BSH.Common.Status.DoorState').item, 'door');
        assert.equal(itemFor('BSH.Common.Root.ActiveProgram').item, 'program/active');
        assert.equal(itemFor('BSH.Common.Option.RemainingProgramTime').item, 'program/remaining');
        assert.equal(itemFor('BSH.Common.Option.StartInRelative').item, 'program/start_in');
    });

    test('categories', () => {
        assert.deepEqual(itemFor('Cooking.Oven.Status.CurrentCavityTemperature'), {
            category: 'status',
            item: 'status/current_cavity_temperature',
            leaf: 'current_cavity_temperature',
        });
        assert.equal(itemFor('BSH.Common.Setting.ChildLock').item, 'setting/child_lock');
        assert.equal(itemFor('LaundryCare.Washer.Option.SpinSpeed').item, 'option/spin_speed');
        assert.equal(itemFor('Dishcare.Dishwasher.Event.SaltNearlyEmpty').item, 'event/salt_nearly_empty');
        assert.equal(itemFor('BSH.Common.Event.ProgramFinished').item, 'event/program_finished');
        assert.equal(itemFor('BSH.Common.Command.PauseProgram').item, 'command/pause_program');
        assert.equal(itemFor('Refrigeration.Common.Setting.Light.Internal.Power').item, 'setting/light/internal/power');
        assert.equal(itemFor('Refrigeration.Common.Status.Door.Freezer').item, 'door/freezer');
        assert.equal(itemFor('Refrigeration.Common.Status.Door.WineCompartment').item, 'door/wine_compartment');
        assert.equal(
            itemFor('ConsumerProducts.CoffeeMaker.Status.BeverageCounterCoffee').item,
            'status/beverage_counter_coffee',
        );
        assert.equal(
            itemFor('BSH.Common.Event.Favorite.001.ExternalTrigger').item,
            'event/favorite/001/external_trigger',
        );
    });

    test('unknown shape', () => {
        assert.equal(itemFor('Something.Weird').category, 'unknown');
        assert.equal(itemFor('Something.Weird').item, 'unknown/weird');
    });
});

describe('reverse lookup', () => {
    const temps = [
        'LaundryCare.Washer.EnumType.Temperature.Cold',
        'LaundryCare.Washer.EnumType.Temperature.GC40',
        'LaundryCare.Washer.EnumType.Temperature.GC60',
    ];
    test('fullEnum accepts short, mixed case and full keys', () => {
        assert.equal(fullEnum('gc40', temps), 'LaundryCare.Washer.EnumType.Temperature.GC40');
        assert.equal(fullEnum('GC40', temps), 'LaundryCare.Washer.EnumType.Temperature.GC40');
        assert.equal(fullEnum('cold', temps), 'LaundryCare.Washer.EnumType.Temperature.Cold');
        assert.equal(fullEnum('LaundryCare.Washer.EnumType.Temperature.GC60', temps), temps[2]);
        assert.equal(fullEnum('gc95', temps), undefined);
    });

    const programs = ['Dishcare.Dishwasher.Program.Eco50', 'Cooking.Oven.Program.HeatingMode.HotAir'];
    test('fullProgram accepts short and full keys, and the last segment', () => {
        assert.equal(fullProgram('eco50', programs), programs[0]);
        assert.equal(fullProgram('heating_mode.hot_air', programs), programs[1]);
        assert.equal(fullProgram('hot_air', programs), programs[1]);
        assert.equal(fullProgram(programs[0], programs), programs[0]);
        assert.equal(fullProgram('quick45', programs), undefined);
    });
});
