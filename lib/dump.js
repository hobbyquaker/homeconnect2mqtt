/**
 * --dump: record what the api says about the account's appliances, then follow the event
 * stream for a while. Produces fixtures for tests and a picture of a real installation:
 *
 *   <dir>/appliances.json
 *   <dir>/<haId>/{status,settings,programs,programs-available,program-active,program-selected,
 *                 options-active,options-selected,commands}.json   (errors as {error: {...}})
 *   <dir>/events.jsonl   one line per SSE event: {ts, type, haId, items|data}
 *   <dir>/summary.json   {started, ended, appliances, requests, events, budget}
 *
 * With `redact` (default) haIds become `<TYPE>-<n>` and appliance names `<type> <n>`.
 */

import fs from 'node:fs';
import path from 'node:path';
import {EventStream} from './sse.js';

export function makeRedactor(appliances, enabled) {
    const map = new Map();
    appliances.forEach((a, i) => {
        map.set(a.haId, {
            haId: `${(a.type || 'APPLIANCE').toUpperCase()}-${i + 1}`,
            name: `${a.type || 'appliance'} ${i + 1}`,
        });
    });
    return {
        haId: (haId) => (enabled ? (map.get(haId)?.haId ?? haId) : haId),
        name: (haId, name) => (enabled ? (map.get(haId)?.name ?? name) : name),
        text: (text) => {
            if (!enabled) {
                return text;
            }
            let out = text;
            for (const [haId, r] of map) {
                out = out.split(haId).join(r.haId);
            }
            return out;
        },
    };
}

/**
 * @param {object} options
 * @param {import('./client.js').HomeConnectClient} options.client
 * @param {import('./budget.js').Budget} options.budget
 * @param {object} options.log
 * @param {string} options.dir
 * @param {number} options.minutes 0 = until the signal aborts
 * @param {boolean} options.redact
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.streamTimeout] ms
 */
export async function runDump({client, budget, log, dir, minutes, redact, signal, streamTimeout}) {
    fs.mkdirSync(dir, {recursive: true});
    const started = new Date().toISOString();
    const write = (file, data) => {
        fs.mkdirSync(path.dirname(path.join(dir, file)), {recursive: true});
        fs.writeFileSync(path.join(dir, file), JSON.stringify(data, null, 2) + '\n');
    };
    const tryGet = async (label, fn) => {
        try {
            return await fn();
        } catch (err) {
            log.warn(`dump: ${label}: ${err.message}`);
            return {error: {status: err.status, key: err.key, description: err.description}};
        }
    };

    const appliances = await client.appliances();
    const r = makeRedactor(appliances, redact);
    log.info(`dump: ${appliances.length} appliance(s)`);
    write(
        'appliances.json',
        appliances.map((a) => ({...a, haId: r.haId(a.haId), name: r.name(a.haId, a.name)})),
    );

    for (const a of appliances) {
        const id = r.haId(a.haId);
        log.info(`dump: ${id} ${a.brand} ${a.vib} (${a.type}) connected=${a.connected}`);
        if (!a.connected) {
            // every per-appliance request of an offline appliance answers 409
            // SDK.Error.HomeAppliance.Connection.Initialization.Failed — do not spend the budget
            log.info(`dump: ${id} is offline, skipping`);
            continue;
        }
        const results = {};
        const fetchInto = async (name, fn) => {
            if (signal?.aborted) {
                return undefined;
            }
            results[name] = await tryGet(`${id} ${name}`, fn);
            write(`${id}/${name}.json`, results[name]);
            return results[name];
        };
        const status = await fetchInto('status', () => client.status(a.haId));
        await fetchInto('settings', () => client.settings(a.haId));
        await fetchInto('programs', () => client.programs(a.haId));
        await fetchInto('programs-available', () => client.availablePrograms(a.haId));
        const opState = Array.isArray(status)
            ? status.find((s) => s.key === 'BSH.Common.Status.OperationState')?.value
            : undefined;
        // programs/active answers 404 SDK.Error.NoProgramActive unless a program runs
        if (opState && !/\.(Inactive|Ready)$/.test(opState)) {
            await fetchInto('program-active', () => client.activeProgram(a.haId));
            await fetchInto('options-active', () => client.activeOptions(a.haId));
        }
        const sel = await fetchInto('program-selected', () => client.selectedProgram(a.haId));
        if (sel?.key) {
            await fetchInto('options-selected', () => client.selectedOptions(a.haId));
            // constraints of the selected program (the option table with min/max/allowedvalues)
            await fetchInto('program-available-selected', () => client.availableProgram(a.haId, sel.key));
        }
        await fetchInto('commands', () => client.commands(a.haId));
    }

    let events = 0;
    if (minutes !== 0 || !signal) {
        const out = fs.createWriteStream(path.join(dir, 'events.jsonl'), {flags: 'a'});
        const stream = new EventStream({
            open: (s) => client.openStream(s),
            log,
            keepaliveTimeout: streamTimeout,
            onUnauthorized: () => client.auth.refresh(),
        });
        stream.on('open', () => log.info('dump: event stream open'));
        stream.on('keepalive', () => log.debug('hc < KEEP-ALIVE'));
        stream.on('event', (e) => {
            events++;
            const line = {ts: Date.now(), type: e.type, haId: r.haId(e.haId), items: e.items};
            if (!e.items.length && e.data) {
                line.data = e.data;
            }
            // items carry the haId inside `uri` — redact the whole line, not just the id field
            out.write(r.text(JSON.stringify(line)) + '\n');
            log.info(
                `hc < ${e.type} ${line.haId} ${e.items.map((i) => `${i.key}=${JSON.stringify(i.value)}`).join(' ')}`,
            );
        });
        stream.start();
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
        stream.stop();
        out.end();
    }

    const summary = {
        started,
        ended: new Date().toISOString(),
        appliances: appliances.length,
        events,
        budget: budget.snapshot(),
    };
    write('summary.json', summary);
    log.info(`dump: done, ${events} events, ${summary.budget.day.used} requests used today`);
    return summary;
}
