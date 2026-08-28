# homeconnect2mqtt

Interface between BSH **Home Connect** appliances (Bosch, Siemens, Neff, Gaggenau, …) and MQTT,
following the [mqtt-smarthome](https://github.com/mqtt-smarthome/mqtt-smarthome) convention,
with Home Assistant discovery. Built on
[mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core).

**Status: 0.1 — api side only.** `--login` and `--dump` work; the MQTT bridge follows in 0.2.
See [ROADMAP.md](ROADMAP.md) for the analysis, the spec and the plan.

## Prerequisites: a Home Connect developer application

1. Register at <https://developer.home-connect.com>. Under _Default Home Connect User Account
   for Testing_ enter the e-mail of your Home Connect app account — **all lowercase** — it must
   be the account the appliances are paired with.
2. _Applications → Register Application_: any name, OAuth flow **Device Flow** (the default of
   this adapter; no redirect URI, no client secret needed). If you prefer the Authorization Code
   flow, register the redirect URI `http://127.0.0.1:8580/callback` (or whatever you pass as
   `--redirect-uri`).
3. Copy the _Client ID_. Portal changes take about 15 minutes to become active. Log out of the
   developer portal before authorizing, and log in with the **app** account at the SingleKey ID
   page, not with the developer account.

Use a dedicated application for this adapter: the api quota (1000 requests per day) is counted
per application and account.

## Login

```
homeconnect2mqtt --login -c <client-id>
```

prints a URL and a code; open the URL, log in with your Home Connect account, confirm. The
tokens land in `<state-dir>/tokens.json` (`--state-dir`, default `$STATE_DIRECTORY` or the
current directory). `--auth-flow code` uses the browser redirect instead.

The **simulator** (`--simulator`) has no device-flow endpoint (404): use `--auth-flow code`
there, with the redirect URI registered for your simulator application.

## Dump

```
homeconnect2mqtt -c <client-id> --dump fixtures --dump-minutes 30
```

writes `appliances.json`, one directory per appliance with status, settings, programs, options
and constraints, and `events.jsonl` with 30 minutes of the event stream; appliance ids and names
are redacted (`--no-dump-redact` keeps them). The dump costs about 10 requests per appliance.

## Docker

Multi-arch image (amd64, arm64, armv7). Authorize once into the volume, then run:

```
docker run --rm -it -v homeconnect2mqtt:/data \
  -e HOMECONNECT2MQTT_CLIENT_ID=<client-id> \
  ghcr.io/hobbyquaker/homeconnect2mqtt --login

docker run -d --name homeconnect2mqtt --restart unless-stopped -v homeconnect2mqtt:/data \
  -e HOMECONNECT2MQTT_CLIENT_ID=<client-id> -e HOMECONNECT2MQTT_MQTT_URL=mqtt://broker \
  ghcr.io/hobbyquaker/homeconnect2mqtt
```

`/data` is the state directory: `tokens.json` and the api budget counters live there. Without the
volume every restart needs a new `--login` and the daily request budget starts over.

## Options

Run `homeconnect2mqtt --help` for the full list; every option is also an environment variable
(`HOMECONNECT2MQTT_CLIENT_ID`, …), see `--config-schema`.

| option                 | default                                      |                                                |
| ---------------------- | -------------------------------------------- | ---------------------------------------------- |
| `--client-id`, `-c`    |                                              | application client id (required)               |
| `--client-secret`      |                                              | only for applications registered with a secret |
| `--auth-flow`          | `device`                                     | `device` or `code`                             |
| `--scopes`             | `IdentifyAppliance Monitor Control Settings` |                                                |
| `--redirect-uri`       | `http://127.0.0.1:8580/callback`             | code flow                                      |
| `--auth-callback-port` | `8580`                                       | code flow                                      |
| `--state-dir`          | `$STATE_DIRECTORY` or `.`                    | tokens, counters                               |
| `--token-file`         | `<state-dir>/tokens.json`                    |                                                |
| `--simulator`          | off                                          | use simulator.home-connect.com                 |
| `--language`           |                                              | `de-DE`, `en-GB`, `en-US` for localized names  |
| `--daily-limit`        | `1000`                                       | requests per day the budget allows             |
| `--minute-limit`       | `50`                                         |                                                |
| `--budget-reserve`     | `100`                                        | daily requests kept for commands               |
| `--stream-timeout`     | `130`                                        | seconds without keep-alive before reconnecting |
| `--login`              |                                              | run the login and exit                         |
| `--dump <dir>`         |                                              | record api responses + events and exit         |
| `--dump-minutes`       | `10`                                         | `0` = until ctrl-c                             |
| `--dump-redact`        | on                                           |                                                |

## License

MIT © Sebastian Raff
