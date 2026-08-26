import path from 'node:path';
import {parseConfig} from 'mqtt-interfaces-core';
import pkg from './package.json' with {type: 'json'};

const stateDir = process.env.STATE_DIRECTORY || '.';

export const DEFAULT_SCOPES = 'IdentifyAppliance Monitor Control Settings';

export const OPTIONS = {
    'client-id': {
        alias: 'c',
        type: 'string',
        describe: 'client id of your application at developer.home-connect.com',
        demandOption: true,
        secret: true,
    },
    'client-secret': {
        type: 'string',
        describe: 'client secret (only for applications registered with a secret)',
        secret: true,
    },
    'auth-flow': {
        type: 'string',
        describe: 'oauth flow used by --login: device (no redirect uri) or code (browser redirect)',
        choices: ['device', 'code'],
        default: 'device',
    },
    scopes: {
        type: 'string',
        describe: 'oauth scopes requested by --login',
        default: DEFAULT_SCOPES,
    },
    'redirect-uri': {
        type: 'string',
        describe: 'redirect uri registered for the application (--auth-flow code)',
        default: 'http://127.0.0.1:8580/callback',
    },
    'auth-callback-port': {
        type: 'number',
        describe: 'local port the one-shot callback server of --auth-flow code listens on',
        default: 8580,
    },
    'state-dir': {
        type: 'string',
        describe: 'directory for tokens and counters (default: $STATE_DIRECTORY)',
        default: stateDir,
    },
    'token-file': {
        type: 'string',
        describe: 'oauth token file (default: <state-dir>/tokens.json)',
        file: {format: 'json', describe: 'oauth tokens written by --login'},
    },
    simulator: {
        type: 'boolean',
        describe: 'use simulator.home-connect.com instead of the production api',
        default: false,
    },
    language: {
        type: 'string',
        describe: 'accept-language for localized names (de-DE, en-GB, en-US)',
    },
    'daily-limit': {type: 'number', describe: 'api requests per day the budget allows', default: 1000},
    'minute-limit': {type: 'number', describe: 'api requests per minute the budget allows', default: 50},
    'budget-reserve': {
        type: 'number',
        describe: 'daily requests kept back for commands (background work stops earlier)',
        default: 100,
    },
    'stream-timeout': {
        type: 'number',
        describe: 'seconds without any event or keep-alive before the event stream is reconnected',
        default: 130,
    },
    login: {
        type: 'boolean',
        describe: 'run the oauth login interactively, store the tokens and exit',
        default: false,
    },
    dump: {
        type: 'string',
        describe: 'dump appliances, status, settings, programs and the event stream into this directory and exit',
    },
    'dump-minutes': {
        type: 'number',
        describe: 'how long --dump follows the event stream (0 = until ctrl-c)',
        default: 10,
    },
    'dump-redact': {
        type: 'boolean',
        describe: 'redact appliance ids and names in --dump output',
        default: true,
    },
};

const config = parseConfig({
    pkg,
    options: OPTIONS,
    defaults: {name: 'homeconnect'},
    examples: [
        ['$0 --login -c <client-id>', 'authorize once (device flow), tokens go to <state-dir>/tokens.json'],
        ['$0 -c <client-id> -u mqtt://broker', 'run in the foreground'],
        ['$0 -c <client-id> --dump fixtures --dump-minutes 30', 'record api responses and events'],
        [
            'sudo $0 --install -n homeconnect -c <client-id> -u mqtt://broker',
            'install as service homeconnect2mqtt@homeconnect',
        ],
    ],
});

if (config.tokenFile === undefined) {
    config.tokenFile = path.join(config.stateDir, 'tokens.json');
}

export default config;
