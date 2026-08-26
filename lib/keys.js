/**
 * Home Connect key vocabulary → mqtt item names (ROADMAP §4.3, decisions H-6 / H-7).
 *
 * Pure functions, no state:
 *  - snake('RemoteControlStartAllowed') → 'remote_control_start_allowed'
 *  - shortEnum('BSH.Common.EnumType.OperationState.DelayedStart') → 'delayed_start'
 *  - shortProgram('Cooking.Oven.Program.HeatingMode.HotAir') → 'heating_mode.hot_air'
 *  - itemFor('BSH.Common.Status.OperationState') → {category: 'status', item: 'operation_state'}
 *  - toValue(value) → the mqtt value for an api value (enums shortened, rest untouched)
 */

/**
 * CamelCase → snake_case. Acronyms stay together (`XLCoffee` → `xl_coffee`), a digit run in the
 * middle of a word gets its own segment (`DescalingIn20Cups` → `descaling_in_20_cups`,
 * `IDos1Active` → `i_dos_1_active`), trailing digits stay attached (`Eco50`, `RPM1400`, `GC40`).
 */
export function snake(s) {
    return String(s)
        .replace(/([a-z])([A-Z])/g, '$1_$2') // aB → a_B
        .replace(/(?<!^\d*)(\d)([A-Z])/g, '$1_$2') // 1B → 1_B, but a leading digit run stays (3DHotAir → 3d_hot_air)
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2') // XLCoffee → XL_Coffee
        .replace(/([a-zA-Z])(\d+)(?=[A-Za-z_])/g, '$1_$2') // In20_Cups → In_20_Cups (after the rules above)
        .toLowerCase();
}

/** `BSH.Common.EnumType.OperationState.Run` → `run`; non-enum strings are returned unchanged */
export function shortEnum(value) {
    if (typeof value !== 'string') {
        return value;
    }
    if (value.includes('.EnumType.')) {
        return snake(value.slice(value.lastIndexOf('.') + 1));
    }
    return value;
}

/** everything after `.Program.`, segments snake_cased and joined with `.` */
export function shortProgram(key) {
    if (typeof key !== 'string') {
        return key;
    }
    const i = key.indexOf('.Program.');
    if (i === -1) {
        return key;
    }
    return key
        .slice(i + '.Program.'.length)
        .split('.')
        .map(snake)
        .join('.');
}

/** api value → mqtt value: program keys shortened, enum keys shortened, everything else as is */
export function toValue(value) {
    if (typeof value === 'string') {
        if (value.includes('.Program.')) {
            return shortProgram(value);
        }
        return shortEnum(value);
    }
    return value;
}

/** well-known keys with dedicated item names */
const SPECIAL = {
    'BSH.Common.Status.OperationState': 'operation_state',
    'BSH.Common.Status.DoorState': 'door',
    'BSH.Common.Status.RemoteControlActive': 'remote_control',
    'BSH.Common.Status.RemoteControlStartAllowed': 'remote_start',
    'BSH.Common.Status.LocalControlActive': 'local_control',
    'BSH.Common.Setting.PowerState': 'power',
    'BSH.Common.Root.ActiveProgram': 'program/active',
    'BSH.Common.Root.SelectedProgram': 'program/selected',
    'BSH.Common.Option.ProgramProgress': 'program/progress',
    'BSH.Common.Option.RemainingProgramTime': 'program/remaining',
    'BSH.Common.Option.RemainingProgramTimeIsEstimated': 'program/remaining_estimated',
    'BSH.Common.Option.ElapsedProgramTime': 'program/elapsed',
    'BSH.Common.Option.EstimatedTotalProgramTime': 'program/estimated_total',
    'BSH.Common.Option.Duration': 'program/duration',
    'BSH.Common.Option.StartInRelative': 'program/start_in',
    'BSH.Common.Option.FinishInRelative': 'program/finish_in',
};

const CATEGORIES = {
    Status: 'status',
    Setting: 'setting',
    Option: 'option',
    Event: 'event',
    Command: 'command',
    Root: 'root',
    Program: 'program',
};

/**
 * @param {string} key full Home Connect key
 * @returns {{category: string, item: string, leaf: string}}
 *   category: status | setting | option | event | command | root | program | unknown;
 *   item: mqtt item relative to `status/<dev>/` (special keys) or `<category>/<leaf>`
 */
export function itemFor(key) {
    const parts = String(key).split('.');
    const catIndex = parts.findIndex((p) => p in CATEGORIES);
    const category = catIndex === -1 ? 'unknown' : CATEGORIES[parts[catIndex]];
    const rest = catIndex === -1 ? parts.slice(-1) : parts.slice(catIndex + 1);
    const leaf = rest.map(snake).join('/');
    if (SPECIAL[key]) {
        return {category, item: SPECIAL[key], leaf};
    }
    if (key.startsWith('Refrigeration.Common.Status.Door.')) {
        return {category, item: `door/${leaf.replace(/^door\//, '')}`, leaf};
    }
    switch (category) {
        case 'status':
            return {category, item: `status/${leaf}`, leaf};
        case 'setting':
            return {category, item: `setting/${leaf}`, leaf};
        case 'option':
            return {category, item: `option/${leaf}`, leaf};
        case 'event':
            return {category, item: `event/${leaf}`, leaf};
        case 'command':
            return {category, item: `command/${leaf}`, leaf};
        default:
            return {category, item: `unknown/${leaf}`, leaf};
    }
}

/**
 * Find the full enum key for a short value among allowed values.
 * @param {string} short e.g. 'gc40' or 'GC40' or the full key
 * @param {string[]} allowed full enum keys
 * @returns {string | undefined}
 */
export function fullEnum(short, allowed = []) {
    if (allowed.includes(short)) {
        return short;
    }
    const wanted = snake(String(short));
    return allowed.find((a) => shortEnum(a) === wanted);
}

/**
 * Find the full program key for a short program name among available programs.
 * @param {string} short 'eco50', 'heating_mode.hot_air' or the full key
 * @param {string[]} available full program keys
 */
export function fullProgram(short, available = []) {
    if (available.includes(short)) {
        return short;
    }
    const wanted = String(short).toLowerCase();
    return available.find((p) => shortProgram(p) === wanted || shortProgram(p).endsWith('.' + wanted));
}
