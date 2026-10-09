/**
 * The local transport: the appliances on the lan through homeconnect-local, without a developer
 * application, a quota or the cloud in the loop after the one-time login (ROADMAP §2.6, OQ-H5).
 *
 * What it gives the rest of the adapter is the cloud's vocabulary: appliances in the shape of
 * `client.appliances()`, and events in the shape of `sse.js` — `{type, haId, items}` with full
 * keys (`BSH.Common.Status.OperationState`) and full enum values
 * (`BSH.Common.EnumType.OperationState.Run`), so `keys.js` and everything above it need not
 * know which transport delivered them.
 *
 *   localLogin()      the app's own oauth flow (code + pkce), then the account's appliances with
 *                     their local keys and profiles, written to <state-dir>/local.json
 *   readLocalFile()   that file, with the profiles parsed from the stored xml
 *   LocalAppliances   one session per appliance; `appliances()` and `event` events
 *   runLocalDump()    --dump over the local transport, same files as the cloud dump
 *
 * Not here yet: discovery (the appliance's address comes from --local-hosts), DISCONNECTED
 * events (the session reconnects by itself and reports CONNECTED again), units.
 */

import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {
    HomeConnectDevice,
    beginLogin,
    decodeValue,
    exchangeCode,
    fetchAppliances,
    parseAuthCode,
    parseProfile,
} from 'homeconnect-local';
import {makeRedactor} from './dump.js';

/** `SIEMENS-HB000000000-68A40E000000` → `HB000000000`: the haId carries brand, vib and serial */
export function vibOf(haId) {
    const parts = String(haId).split('-');
    return parts.length >= 3 ? parts[1] : '';
}

/** `--local-hosts a=1.2.3.4,b=1.2.3.5` → `{a: '1.2.3.4', b: '1.2.3.5'}` */
export function parseHosts(text) {
    const hosts = {};
    for (const pair of String(text || '').split(',')) {
        const [id, ip] = pair.split('=').map((s) => s.trim());
        if (id && ip) {
            hosts[id] = ip;
        }
    }
    return hosts;
}

/**
 * The value of a reported feature in the cloud's vocabulary: enum members as the full enum
 * key, programs as their full name, numbers and booleans as they are.
 */
export function cloudValue(profile, feature, value) {
    const decoded = decodeValue(profile, feature, value);
    if (feature.values && typeof decoded === 'string') {
        return feature.enumType ? `${feature.enumType}.${decoded}` : decoded;
    }
    if (feature.kind === 'activeProgram' || feature.kind === 'selectedProgram') {
        return programName(profile, value);
    }
    return decoded;
}

/** The full name of a program by uid, or null for "none" */
export function programName(profile, uid) {
    if (uid === null || uid === undefined || uid === 0) {
        return null;
    }
    return profile.features[String(uid)]?.name ?? String(uid);
}

/** Reported `{uid, value}` updates as event items `{key, value}` with the cloud's names */
export function toItems(profile, updates) {
    const items = [];
    for (const {uid, value} of updates) {
        const feature = profile.features[String(uid)];
        if (!feature) {
            continue;
        }
        items.push({key: feature.name, value: cloudValue(profile, feature, value)});
    }
    return items;
}

/**
 * Log in with the Home Connect account the way the app does and fetch the paired appliances
 * with their local keys and profiles. `onPrompt({url})` shows the login url; `ask(question)`
 * returns what the person pasted back (the hcauth://… address or the code).
 */
export async function localLogin({file, log, onPrompt, ask}) {
    const login = beginLogin();
    onPrompt({url: login.url});
    log.warn('auth: the browser ends at an hcauth://auth/prod?code=… address that does not load');
    const pasted = await ask('paste that address (or just the code) here: ');
    const token = await exchangeCode(login.verifier, parseAuthCode(pasted));
    const {configs, xml} = await fetchAppliances((m) => log.info(`local: ${m}`), token);
    // the parsed profile is not stored: it is re-read from the xml, so a parser update applies
    const stored = {
        version: 1,
        configs: configs.map(({profile: _profile, ...rest}) => rest),
        xml,
    };
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify(stored, null, 2) + '\n', {mode: 0o600});
    log.info(`local: ${configs.length} appliance(s) written to ${file}`);
    for (const c of configs) {
        log.info(`  ${c.identifier}  ${c.brand} ${c.type} key=${c.keyType}`);
    }
    return configs;
}

/** The appliances of a local.json, with their profiles parsed from the stored xml */
export function readLocalFile(file) {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    const configs = [];
    for (const c of stored.configs ?? []) {
        const xml = stored.xml?.[c.identifier];
        if (!xml) {
            continue;
        }
        configs.push({...c, profile: parseProfile(xml.deviceDescription, xml.featureMapping)});
    }
    return {configs, xml: stored.xml ?? {}};
}

export class LocalAppliances extends EventEmitter {
    /**
     * @param {object} options
     * @param {Array<object>} options.configs appliances with profiles, from readLocalFile()
     * @param {Record<string, string>} [options.hosts] haId (or name) → ip
     * @param {object} options.log
     * @param {number} [options.pollInterval] ms between full value refreshes
     */
    constructor({configs, hosts = {}, log, pollInterval = 60000}) {
        super();
        this.configs = configs;
        this.hosts = hosts;
        this.log = log;
        this.pollInterval = pollInterval;
        this.devices = new Map();
    }

    /** @returns {Array<{haId: string, name: string, brand: string, vib: string, type: string, enumber: string, connected: boolean}>} */
    appliances() {
        return this.configs.map((c) => ({
            haId: c.identifier,
            name: c.name,
            brand: c.brand,
            vib: vibOf(c.identifier),
            type: c.type,
            enumber: '',
            connected: this.devices.get(c.identifier)?.connected ?? false,
        }));
    }

    hostOf(c) {
        return this.hosts[c.identifier] ?? this.hosts[c.name] ?? null;
    }

    start() {
        for (const c of this.configs) {
            const ip = this.hostOf(c);
            if (!ip) {
                this.log.warn(`local: no address for ${c.identifier}; pass --local-hosts ${c.identifier}=<ip>`);
                continue;
            }
            const device = new HomeConnectDevice(
                {host: c.host, ip, key: c.key, keyType: c.keyType, iv: c.iv},
                this.pollInterval,
            );
            device.on('log', (m) => this.log.debug(`local ${c.name}: ${m}`));
            device.on('connected', () =>
                this.emit('event', {type: 'CONNECTED', haId: c.identifier, items: [], data: {haId: c.identifier}}),
            );
            device.on('state', (updates, action) =>
                this.emit('event', {
                    type: action === 'NOTIFY' ? 'NOTIFY' : 'STATUS',
                    haId: c.identifier,
                    items: toItems(c.profile, updates),
                }),
            );
            device.on('program', (p) =>
                this.emit('event', {
                    type: 'NOTIFY',
                    haId: c.identifier,
                    items: [
                        {
                            key:
                                p.resource === '/ro/activeProgram'
                                    ? 'BSH.Common.Root.ActiveProgram'
                                    : 'BSH.Common.Root.SelectedProgram',
                            value: programName(c.profile, p.program),
                        },
                    ],
                }),
            );
            this.devices.set(c.identifier, device);
            device.connect().catch((err) => this.log.warn(`local ${c.name}: ${err.message}`));
        }
    }

    stop() {
        for (const device of this.devices.values()) {
            device.disconnect();
        }
        this.devices.clear();
    }
}

/** A profile as the dump shows it: every feature by key, with what the profile says about it */
export function describeProfile(profile) {
    const out = {};
    for (const [uid, f] of Object.entries(profile.features)) {
        const entry = {uid: Number(uid), name: f.name, kind: f.kind, access: f.access};
        for (const k of ['min', 'max', 'step', 'default', 'values', 'enumType', 'execution']) {
            if (f[k] !== undefined) {
                entry[k] = f[k];
            }
        }
        if (f.options?.length) {
            entry.options = f.options;
        }
        out[f.key] = entry;
    }
    return out;
}

/**
 * --dump over the local transport: appliances.json, <id>/profile.json, events.jsonl and
 * summary.json, in the shape of the cloud dump.
 */
export async function runLocalDump({local, log, dir, minutes, redact, signal}) {
    fs.mkdirSync(dir, {recursive: true});
    const started = new Date().toISOString();
    const write = (file, data) => {
        fs.mkdirSync(path.dirname(path.join(dir, file)), {recursive: true});
        fs.writeFileSync(path.join(dir, file), JSON.stringify(data, null, 2) + '\n');
    };
    const appliances = local.appliances();
    const r = makeRedactor(appliances, redact);
    log.info(`dump: ${appliances.length} appliance(s), local transport`);
    write(
        'appliances.json',
        appliances.map((a) => ({...a, haId: r.haId(a.haId), name: r.name(a.haId, a.name)})),
    );
    for (const c of local.configs) {
        write(`${r.haId(c.identifier)}/profile.json`, describeProfile(c.profile));
    }

    let events = 0;
    const out = fs.createWriteStream(path.join(dir, 'events.jsonl'), {flags: 'a'});
    local.on('event', (e) => {
        events++;
        const line = {ts: Date.now(), type: e.type, haId: r.haId(e.haId), items: e.items};
        out.write(r.text(JSON.stringify(line)) + '\n');
        log.info(`hc < ${e.type} ${line.haId} ${e.items.map((i) => `${i.key}=${JSON.stringify(i.value)}`).join(' ')}`);
    });
    local.start();
    await new Promise((resolve) => {
        let timer;
        if (minutes > 0) {
            timer = setTimeout(resolve, minutes * 60 * 1000);
        }
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        });
    });
    local.stop();
    out.end();

    const summary = {
        started,
        ended: new Date().toISOString(),
        transport: 'local',
        appliances: appliances.length,
        events,
    };
    write('summary.json', summary);
    log.info(`dump: done, ${events} events`);
    return summary;
}
