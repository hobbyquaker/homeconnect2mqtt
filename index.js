#!/usr/bin/env node
/**
 * homeconnect2mqtt — Home Connect (BSH) to MQTT bridge.
 *
 * 0.1: the api side only — `--login` (oauth device/code flow, tokens to the state dir) and
 * `--dump` (record api responses + the event stream). The MQTT bridge follows in 0.2
 * (see ROADMAP.md §6).
 */

import path from 'node:path';
import {createLogger} from 'mqtt-interfaces-core';
import config from './config.js';
import {Auth} from './lib/auth.js';
import {Budget} from './lib/budget.js';
import {HomeConnectClient} from './lib/client.js';
import {runDump} from './lib/dump.js';

const log = createLogger({envPrefix: config.$envPrefix, level: config.verbosity});

const budget = new Budget({
    dailyLimit: config.dailyLimit,
    minuteLimit: config.minuteLimit,
    reserve: config.budgetReserve,
    file: path.join(config.stateDir, 'budget.json'),
    log,
});

const auth = new Auth({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    simulator: config.simulator,
    tokenFile: config.tokenFile,
    scopes: config.scopes,
    redirectUri: config.redirectUri,
    callbackPort: config.authCallbackPort,
    log,
    budget,
});

const client = new HomeConnectClient({auth, budget, log, simulator: config.simulator, language: config.language});

const abort = new AbortController();
// the debounced budget save must not be lost on a crash or an explicit exit
process.on('exit', () => budget.close());
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        log.info(`${sig}, stopping`);
        abort.abort();
    });
}

function printPrompt({url, code, expires}) {
    log.warn(`auth: open ${url}${code ? ` and enter the code ${code}` : ''}`);
    if (expires) {
        log.warn(`auth: the code expires at ${new Date(expires).toLocaleTimeString()}`);
    }
}

async function login() {
    log.info(`login via ${config.authFlow} flow against ${auth.host} (scopes: ${config.scopes})`);
    try {
        if (config.authFlow === 'device') {
            await auth.loginDevice({onPrompt: printPrompt, signal: abort.signal});
        } else {
            await auth.loginCode({onPrompt: printPrompt});
        }
    } catch (err) {
        if (err.code === 'unauthorized_client' && /grant_type/.test(err.description || '')) {
            log.error(
                `the application is not registered for the ${config.authFlow === 'device' ? 'Device' : 'Authorization Code'} flow. ` +
                    'Register a new application at https://developer.home-connect.com/applications with ' +
                    `OAuth Flow "${config.authFlow === 'device' ? 'Device Flow' : 'Authorization Code Grant Flow'}" ` +
                    '(new applications take about 15 minutes to become active), or pass --auth-flow ' +
                    `${config.authFlow === 'device' ? 'code --redirect-uri <the uri registered for it>' : 'device'}.`,
            );
        }
        throw err;
    }
    log.info(`tokens written to ${config.tokenFile}`);
    const appliances = await client.appliances();
    for (const a of appliances) {
        log.info(`  ${a.haId}  ${a.brand} ${a.vib} (${a.type}) "${a.name}" connected=${a.connected}`);
    }
}

async function main() {
    if (config.login) {
        await login();
        return;
    }
    if (!auth.hasTokens) {
        log.error(`no tokens in ${config.tokenFile} — run: homeconnect2mqtt --login -c <client-id>`);
        process.exit(2);
    }
    if (config.dump !== undefined) {
        await runDump({
            client,
            budget,
            log,
            dir: config.dump || 'dump',
            minutes: config.dumpMinutes,
            redact: config.dumpRedact,
            signal: abort.signal,
            streamTimeout: config.streamTimeout * 1000,
        });
        return;
    }
    log.error('0.1 implements --login and --dump only; the mqtt bridge comes with 0.2');
    process.exit(2);
}

main()
    .then(() => {
        auth.stop();
        budget.close();
        process.exit(0);
    })
    .catch((err) => {
        log.error(err.message);
        if (config.verbosity === 'debug') {
            log.debug(err.stack);
        }
        auth.stop();
        budget.close();
        process.exit(1);
    });
