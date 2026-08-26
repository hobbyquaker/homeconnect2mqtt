# Roadmap & implementation spec — homeconnect2mqtt

MQTT interface for BSH **Home Connect** appliances (Bosch, Siemens, Neff, Gaggenau, Thermador,
Constructa, Profilo, Balay …: dishwashers, washers, dryers, washer-dryers, ovens, cooktops, hoods,
coffee machines, fridges/freezers, wine coolers, warming drawers, cleaning robots, cook processors,
microwaves, air conditioners), following the
[mqtt-smarthome](https://github.com/mqtt-smarthome/mqtt-smarthome) architecture and the
`xyz2mqtt` fleet conventions. It is built on
[mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core) (config, MQTT,
`{val, ts, lc}` payloads, `info` / `maintenance` topics, discovery publishing, installer,
logging); this adapter is left with the Home Connect protocol (OAuth, REST, SSE), the key→item
table and the entity map. It replaces a Node-RED flow built on
[node-red-contrib-homeconnect](https://github.com/alexkn/node-red-contrib-homeconnect).

Like alexa-remote-mqtt and cul2mqtt it is a **bridge**: one instance = one Home Connect account
= all appliances paired to that account, addressed as `<name>/status/<appliance>/<item>`.

Fleet-wide decisions D-1 … D-13 live in the mqtt-interfaces master roadmap; the core's are C-n,
alexa-remote-mqtt's A-n, wiim2mqtt's W-n. This file uses **H-n** for homeconnect2mqtt decisions
and **OQ-Hn** for its open questions (to be folded into the fleet numbering when the master
roadmap picks them up). Status 2026-08-26: research + spec; the npm name `homeconnect2mqtt` is
reserved with a placeholder 0.0.1 (see §7); no adapter code yet.

Contents: 1 prior art · 2 Home Connect facts · 3 what users struggle with elsewhere ·
4 implementation spec · 5 decisions · 6 milestones · 7 housekeeping · 8 open questions ·
9 sources.

---

## 1. Prior art

### 1.1 The Node-RED flow being replaced (`flow.json`, analysed 2026-08-26, then deleted)

One tab "Home Connect", 24 nodes, `node-red-contrib-homeconnect` 0.6.8, one `home-connect-auth`
config node (Authorization Code, callback `https://node-red/homeconnect/auth/callback`,
production API). Three appliances, each wired identically:

| appliance (app name → topic level) | haId                              | nodes                                                                                                                                     |
| ---------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Spülmaschine (Siemens SN658X06TE)  | `SIEMENS-SN658X06TE-XXXXXXXXXXXX` | `home-connect-event` (SSE per appliance) → function → mqtt; inject every **3600 s** → `home-connect-request get_status` → function → mqtt |
| Waschmaschine (Bosch WAU28P40)     | `BOSCH-WAU28P40-XXXXXXXXXXXX`     | same                                                                                                                                      |
| Ofen                               | `XXXXXXXXXXXXXXXXXX-001`          | same (the newer numeric haId format)                                                                                                      |

Plus a manual inject → `get_home_appliances` → debug (used once to find the haIds).

What it publishes — all retained, QoS 0, broker `mqtt.lan.raff.rocks`:

- `bsh/status/<Name>/<KeyLeaf>` where `<KeyLeaf>` is the last dot-segment of the Home Connect
  key (`BSH.Common.Status.OperationState` → `OperationState`,
  `BSH.Common.Option.RemainingProgramTime` → `RemainingProgramTime`,
  `Dishcare.Dishwasher.Event.SaltNearlyEmpty` → `SaltNearlyEmpty`, …) — for **every** item of
  every SSE event type (STATUS, NOTIFY, EVENT) and for every entry of the hourly `get_status`
  (`RemoteControlActive`, `RemoteControlStartAllowed`, `LocalControlActive`, `OperationState`,
  `DoorState`, …).
- Payload `{val, ts, unit, level, handling}` from events (`ts` = the event's `timestamp`, in
  **seconds**, not ms), `{val, ts}` from the poll (`ts` = now in ms) — inconsistent units.
- `val` is the enum leaf (`Run`, `Closed`, `Eco50`, `GC40`) or the raw number/boolean; a final
  function booleanises three keys and keeps the leaf in `val_enum`: `DoorState` → `val !==
'Closed'` (true = open **or locked**), `PowerState` → `val === 'On'`, `OperationState` →
  `val === 'Run'`.

Observations that feed the spec:

1. **Request budget**: 3 hourly polls = 72 requests/day + 3 stream opens per Node-RED restart —
   cheap, but the poll only exists because the flow has no seeding and no way to know it missed
   events; §4.6/4.7 replace it with seed-once + stream watchdog (steady state 0 requests/day).
2. **3 of the 10 SSE channels** are used (one per appliance); the global stream (§2.4) needs 1.
3. **Leaf-only item names collide** across categories (`Temperature` is a washer option key and
   also a status on other types; `Door.Freezer` vs `DoorState`) and lose the category
   (`ProgramFinished` is an event, `ProgramProgress` an option, `OperationState` a status —
   all flat). The new layout keeps the category as a topic level (§4.3) and the full key under
   `key/`.
4. **Events are retained** (`ProgramFinished` stays `Present` forever until the next one) — the
   split into non-retained `event/` + latched `alert/` (H-8) is exactly what automations need.
5. No `connected`/availability, no commands at all (the flow is read-only), no HA discovery,
   no re-auth handling (auth node refreshes at expiry, once), `ts` unit mismatch, hard-coded
   haIds and names in 21 nodes.
6. The three booleanised items (`DoorState`, `PowerState`, `OperationState` → bool) are what
   the existing automations consume; §4.12 maps them.

**Migration table** `bsh/status/<Name>/…` (1 flow) → `homeconnect/status/<dev>/…` (this
adapter, `<dev>` = `spuelmaschine`, `waschmaschine`, `ofen` by default, §4.4):

| flow topic                                                                                                                     | new topic                                                                                                                                                     | `val`                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `…/OperationState` (bool, `val_enum`)                                                                                          | `…/operation_state`                                                                                                                                           | `run`, `ready`, … (string; automations compare `== 'run'`); `…/running` bool helper (H-15) |
| `…/DoorState` (bool open/locked, `val_enum`)                                                                                   | `…/door`                                                                                                                                                      | `open`/`closed`/`locked`; `…/door_open` bool helper (H-15)                                 |
| `…/PowerState` (bool, `val_enum`)                                                                                              | `…/power`                                                                                                                                                     | `on`/`off`/`standby`; `…/power_on` bool helper (H-15)                                      |
| `…/RemoteControlActive` etc.                                                                                                   | `…/remote_control`, `…/remote_start`, `…/local_control`                                                                                                       | bool                                                                                       |
| `…/ActiveProgram`, `…/SelectedProgram`                                                                                         | `…/program/active`, `…/program/selected`                                                                                                                      | `eco50`, `cotton`, `heating_mode.hot_air`                                                  |
| `…/ProgramProgress`, `…/RemainingProgramTime`, `…/ElapsedProgramTime`, `…/StartInRelative`, `…/FinishInRelative`, `…/Duration` | `…/program/progress`, `…/program/remaining`, `…/program/elapsed`, `…/program/start_in`, `…/program/finish_in`, `…/program/duration` (+ `…/program/finish_at`) | numbers, `unit` kept as extra field                                                        |
| `…/Temperature`, `…/SpinSpeed`, `…/SetpointTemperature`, `…/FastPreHeat`, … (options)                                          | `…/option/temperature`, `…/option/spin_speed`, `…/option/setpoint_temperature`, `…/option/fast_pre_heat`                                                      | leaf snake_case                                                                            |
| `…/ChildLock`, `…/AlarmClock`, … (settings)                                                                                    | `…/setting/child_lock`, `…/setting/alarm_clock`                                                                                                               |                                                                                            |
| `…/ProgramFinished`, `…/SaltNearlyEmpty`, `…/RinseAidNearlyEmpty`, `…/PreheatFinished`, … (events, retained `Present`)         | `…/event/program_finished` (not retained) + `…/alert/program_finished` (retained bool)                                                                        | `present`/`off`/`confirmed`; bool                                                          |
| anything else                                                                                                                  | `…/status/<leaf>` / `…/key/<Full.Key>`                                                                                                                        | verbatim                                                                                   |

Payload becomes the core's `{val, ts, lc}`, `ts` in **ms** everywhere; the flow's `unit`,
`level`, `handling` fields are dropped from status payloads (H-16: units are fixed per item,
level/handling travel inside the `event/<x>` value). `--name bsh` reproduces the old prefix if
wanted; the appliance level and item names change regardless (D-2 style hard break, documented
in the README).

### 1.2 node-red-contrib-homeconnect 0.4.2 (fork in `~/WebstormProjects`, upstream 0.6.8)

Three nodes: `home-connect-auth` (config node), `home-connect-request`, `home-connect-event`.

| concern         | how the nodes do it                                                                                                                                                                                                                             | lesson for homeconnect2mqtt                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| authorization   | Authorization Code Grant: `RED.httpAdmin` routes `/homeconnect/auth/{start,callback,polltoken}`, browser is sent to `/security/oauth/authorize`, callback URL must be reachable by the browser (issue #100: users port-forward Node-RED for it) | Prefer the **Device Flow** (no redirect URI, no client secret, works headless, H-3); keep Auth Code as fallback with a one-shot local callback server |
| token storage   | `~/.node-red/homeconnect_tokens.json`, plain JSON; note in `TokenStorage.js`: "on the simulator the refresh_token changes at every request"                                                                                                     | tokens in `STATE_DIRECTORY/tokens.json` 0600; always persist the refresh token returned by a refresh (rotation-safe)                                  |
| token refresh   | `setTimeout(expires_at - now)` — refreshes exactly at expiry, once; a failed refresh is logged and never retried; every refresh tears down and re-creates the SSE + swagger client of every dependent node                                      | refresh at ~80 % of the 24 h lifetime with retry/backoff bounded by the refresh-token quota (10/min, 100/day, §2.3); SSE reconnects only on 401       |
| requests        | `swagger-client` against `hcsdk-production.yaml` (~110 kB download at every token refresh); user picks `tag`/`operationId`/`haid`/`body` per node — the flow author writes all logic                                                            | own thin client on `fetch`, no swagger; the adapter owns the logic (seeding, program start preconditions, option constraints)                         |
| events          | one `EventSource` **per appliance** on `/homeappliances/{haId}/events` (counts against the 10-channel limit, §2.3); only STATUS/EVENT/NOTIFY/CONNECTED/DISCONNECTED handled, no KEEP-ALIVE watchdog, no PAIRED/DEPAIRED, no reconnect on error  | one stream on `/homeappliances/events` for all appliances (1 channel, 1 request), keep-alive watchdog, backoff, PAIRED/DEPAIRED → re-list             |
| rate limits     | none; `request-node` on an inject loop = polling; issue #49 "rate limit for refresh token requests was reached"                                                                                                                                 | a request budget with counters (§4.6)                                                                                                                 |
| dependencies    | `request` (deprecated 2020), `eventsource` 1.x, `swagger-client`; ESLint 6                                                                                                                                                                      | zero runtime deps beyond the core (`fetch` + own SSE parser on `node:https`)                                                                          |
| recent breakage | #99 (2024-10 → 2026-06, open): authorize URL answers 403 when `redirect_uri` is sent — the portal now validates it strictly; workaround: omit it and rely on the URI registered in the portal                                                   | Device Flow avoids the redirect URI entirely; for the Auth Code path send **exactly** the registered URI                                              |

### 1.3 Other integrations (what they do, what to copy, what to avoid)

| project                                                                                     | state (2026-08)                              | approach / notable design                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [HA core `home_connect`](https://www.home-assistant.io/integrations/home_connect/)          | official, rewritten 2025 on `aiohomeconnect` | Auth Code via `my.home-assistant.io`; one SSE stream for all appliances; static entity tables per appliance type (binary_sensor/sensor/switch/select/number/button/light/time/event); program options as entities only "once available in the selected or active program"; per-appliance reload via `homeassistant.update_entity` (2026.6) to save quota; 258 closed + 7 open issues, the big ones are auth and quota (§3)                           |
| [ekutner/home-connect-hass](https://github.com/ekutner/home-connect-hass) ("Alt")           | 999 ★, active                                | **everything dynamic from the API** (programs, options, settings → entities), language/translation options, custom HA events for every API status update, program-start/finish triggers, multi-instance with separate developer apps as the quota workaround, "sensors update interval" option, delayed-start as `time` entity (#570)                                                                                                                |
| [ioBroker.homeconnect](https://github.com/iobroker-community-adapters/ioBroker.homeconnect) | 1.6.1 (2026-05), 24 open issues              | **Device Flow** login (link in the log); state tree `status/settings/programs.{active,selected}.options/events/commands`; keys as ids with `.`→`_`; 50 req/min governor at startup; option "don't fetch programs on connect"; restart-in-20-min loop on refresh failure (#396)                                                                                                                                                                       |
| [openHAB `homeconnect`](https://www.openhab.org/addons/bindings/homeconnect/)               | maintained; SSE per appliance (old mode)     | typed channels per thing type (`operation_state`, `door_state`, `remote_start_allowance_state`, `program_progress_state`, …), `basic_actions_state` accepts raw JSON program starts, built-in request log UI `/homeconnect/log/requests` to watch quota; hit the 10-channel limit until BSH allowed one stream for all                                                                                                                               |
| [openHAB `homeconnectdirect`](https://www.openhab.org/addons/bindings/homeconnectdirect/)   | bruestel, local only                         | local WebSocket protocol; profiles (keys + feature XML) via the external [Home Connect Profile Downloader](https://github.com/bruestel/homeconnect-profile-downloader); mDNS discovery; dynamic channels for any profile UID; robots are cloud-only                                                                                                                                                                                                  |
| [homebridge-homeconnect](https://github.com/thoukydides/homebridge-homeconnect)             | 167 ★, very mature                           | Device Flow ("Client Secret: No, PKCE: disabled"); one HomeKit switch per program; per-type functionality matrix on the wiki; the most complete list of appliance quirks                                                                                                                                                                                                                                                                             |
| [hcpy2-0/hcpy](https://github.com/hcpy2-0/hcpy) (fork of osresearch/hcpy, 521 ★)            | 388 ★, pushed 2026-08-24, HA add-on          | **local** WebSocket (TLS-PSK :443 or AES-CBC/HMAC :80), keys via cloud login once; MQTT `homeconnect/<dev>/{state,set,activeProgram,selectedProgram,refresh}` + HA discovery; login now needs the browser redirect-URL dance (SingleKey ID captcha); recurring issues: connection loss (#120, #222), event storms on reconnect (#269), and 2026-08-19 #278: BSH let PKI generations 15/16 DNS expire → some appliances can no longer register at all |
| [SukramJ/go-homeconnect2mqtt](https://github.com/SukramJ/go-homeconnect2mqtt)               | 1 ★, started 2026-08                         | local, Go; topics `<topic>/<device>/<Feature/Path>/{state,set}` (dotted keys → slashes), `availability`, `connection_state`; HA discovery; profiles from the same downloader                                                                                                                                                                                                                                                                         |
| [chris-mc1/homeconnect_local_hass](https://github.com/chris-mc1/homeconnect_local_hass)     | HACS, on `homeconnect-websocket` (PyPI)      | local, profile upload in the config flow, 60 open issues                                                                                                                                                                                                                                                                                                                                                                                             |
| npm                                                                                         |                                              | `home-connect-js` 0.1.3 (2022, swagger based, dead); no maintained JS client — write our own                                                                                                                                                                                                                                                                                                                                                         |

**Conclusion.** Cloud API first (H-1): every mature integration uses it, it covers all appliance
types including the cloud-only robots, and the local protocol needs a one-time cloud login anyway
plus an external profile tool. The things that make cloud integrations painful are all
avoidable with discipline: (a) one SSE stream instead of polling, (b) a request budget that is
visible over MQTT, (c) a headless Device-Flow login with a re-auth path that survives BSH
invalidating tokens, (d) not fetching program constraints eagerly. A local transport is a
possible 2.x (OQ-H5); the topic layout must not depend on the transport.

---

## 2. Home Connect facts (research summary, sources in §9)

### 2.1 Endpoints

- Base `https://api.home-connect.com/api` (simulator `https://simulator.home-connect.com/api`,
  China `api.home-connect.cn`). `Accept: application/vnd.bsh.sdk.v1+json`; every body is
  `{"data": …}` or `{"error": {"key", "description"}}`. `Accept-Language: de-DE|en-GB|en-US`
  adds `name`/`displayvalue` to keys.
- `GET /homeappliances` → `{homeappliances: [{haId, name, brand, vib, type, enumber, connected}]}`;
  `haId` looks like `BOSCH-SMV68TX06E-68A40E123456` or `305090427249000124-001`; `type` is one
  of `Dishwasher, Washer, Dryer, WasherDryer, Oven, Hob, Hood, CoffeeMaker, FridgeFreezer,
Refrigerator, Freezer, WineCooler, WarmingDrawer, CleaningRobot, CookProcessor, Microwave,
AirConditioner`.
- Per appliance: `status`, `status/{key}`, `settings`, `settings/{key}` (GET/PUT),
  `programs`, `programs/available`, `programs/available/{key}` (constraints), `programs/active`
  (GET/PUT = start/DELETE = stop), `programs/active/options[/{key}]` (GET/PUT),
  `programs/selected` (GET/PUT = select), `programs/selected/options[/{key}]`, `commands` (GET),
  `commands/{key}` (PUT), `images`, `images/{key}`, `events` (SSE or one-shot JSON).
- Global: `GET /homeappliances/events` — SSE for **all** appliances of the account; the only
  interface that also delivers `PAIRED`/`DEPAIRED`.
- Values: enums are full keys (`BSH.Common.EnumType.OperationState.Run`), numbers carry
  `unit` (`seconds`, `°C`, `%`, `ml`), booleans plain. Constraints on options/settings:
  `{min, max, stepsize, allowedvalues[], default, liveupdate, access: readOnly|readWrite,
execution: selectonly|startonly|selectandstart}` (execution on programs).
- Documented keys: ~570 extracted from the docs into `prior-art/homeconnect-api-keys.txt`, grouped
  `BSH.Common.{Status,Setting,Option,Event,Command,Root,EnumType}`, `Dishcare.Dishwasher.*`,
  `LaundryCare.{Washer,Dryer,WasherDryer,Common}.*`, `Cooking.{Oven,Hood,Hob,Common}.*`,
  `ConsumerProducts.{CoffeeMaker,CleaningRobot}.*`, `Refrigeration.{Common,FridgeFreezer}.*`,
  `HeatingVentilationAirConditioning.AirConditioner.*`. Appliances also emit **undocumented**
  keys (HA: `Cooking.Oven.Program.HeatingMode.3DHotAir` vs documented `HotAir`, #175598;
  `LaundryCare.Common.Program.Memory1`, ioBroker #251) — the adapter must pass unknown keys
  through (H-6).

### 2.2 Authorization

- OAuth2, two flows: **Authorization Code Grant** (`/security/oauth/authorize` +
  `/security/oauth/token`, needs a registered redirect URI, client secret optional per app
  settings) and **Device Flow** (`POST /security/oauth/device_authorization` →
  `{device_code, user_code, verification_uri, verification_uri_complete, expires_in: 300,
interval: 5}`, then poll `/security/oauth/token` with `grant_type=device_code`). Device Flow
  needs no redirect URI and no secret; the app must have "Device Flow" enabled in the portal
  (homebridge: "Client Secret: No, PKCE: disabled").
- The simulator answers 404 for `/security/oauth/device_authorization` (checked 2026-08-26):
  Device Flow is production-only, the simulator needs the Authorization Code flow.
- Tokens: `access_token` **86400 s (24 h)**, `refresh_token` (rotates — always store the newly
  returned one), `id_token`, `scope`. Refresh: `grant_type=refresh_token&refresh_token=…
[&client_secret=…]`.
- Scopes: `IdentifyAppliance`, `Monitor`, `Control`, `Settings`, `Images`, plus per type
  (`Dishwasher-Monitor`, `Dishwasher-Control`, `Dishwasher-Settings`, …, `CoffeeMaker`,
  `FridgeFreezer`, `CleaningRobot`, …). Ask for `IdentifyAppliance Monitor Control Settings`
  (Images only with `--images`).
- Developer account rules (source of most support threads): the developer account's
  "Default Home Connect User Account for Testing" must be the e-mail of the Home Connect app
  account, **all lowercase**; portal changes take **15 min**; log out of the developer portal
  before authorizing; since SingleKey ID, the error "The given user is not assigned to this app
  in the developer portal" means the wrong account was used at login. Client secrets can be
  rotated in the portal (2026-05). EU Data Act mode exists since 2025-09-12 (data access for
  users; the portal briefly lost the Images scopes for it).
- May 2026 (HA #169982, ioBroker #396, Node-RED #99): BSH invalidated existing refresh tokens
  (`invalid_grant: invalid refresh_token`, token endpoint 400) and tightened redirect-URI checks;
  every integration needed a fresh login. Re-authorization must therefore be a first-class,
  well-signalled path (H-4), not an error.

### 2.3 Rate limits (per `(client_id, user)` pair; every REST request counts, retries included)

| limit                                                           | consequence                              |
| --------------------------------------------------------------- | ---------------------------------------- |
| **1000 requests / day**                                         | 429, `Retry-After` = seconds until reset |
| 50 requests / minute                                            | blocked for 1 min                        |
| 10 requests / s average, 20 burst (leaky bucket)                | 429, no `Retry-After`                    |
| 5 program starts / min, 5 program stops / min                   | blocked for 1 min                        |
| 10 successive error responses / 10 min                          | blocked for 10 min                       |
| 10 token refreshes / min, 100 / day                             | 429                                      |
| **10 event-monitoring channels** per client+account at any time | further streams refused                  |
| one monitoring channel per appliance                            | —                                        |

SSE: opening a stream counts as 1 request; messages and keep-alives do not count; a clean close
frees the channel immediately. BSH's own best-practice budget: "54 requests to get the full
state of 6 appliances" (list + status + settings + active + selected + events each) — i.e.
**seeding costs ~4–5 requests per appliance**, and a naive 1-min poll of one endpoint already
burns 1440/day. Everything in §4.6 follows from this table.

### 2.4 Events (SSE)

- Event types: `KEEP-ALIVE` (no data, periodic), `STATUS` (status keys), `NOTIFY` (settings,
  program/option values, progress), `EVENT` (`*.Event.*` with `EventPresentState`
  `Present|Off|Confirmed`), `CONNECTED`, `DISCONNECTED`, `PAIRED`, `DEPAIRED` (last two only on
  the global stream). `id:` = `haId`; `data` = `{"items":[{key, value, unit?, timestamp,
level: hint|info|warning|alert|critical, handling: none|acknowledge|decision, uri?, name?,
displayvalue?}]}`; the global stream additionally has `haId` in `data`.
- Progress keys arrive as NOTIFY on `BSH.Common.Option.{ProgramProgress (%),
RemainingProgramTime (s), RemainingProgramTimeIsEstimated, ElapsedProgramTime,
EstimatedTotalProgramTime, StartInRelative, FinishInRelative, Duration}`; program keys on
  `BSH.Common.Root.{ActiveProgram,SelectedProgram}` (value `null`/absent when none).
- State keys: `OperationState` (`Inactive, Ready, DelayedStart, Run, Pause, ActionRequired,
Finished, Error, Aborting`), `DoorState` (`Open, Closed, Locked`; fridges use
  `Refrigeration.Common.Status.Door.<Compartment>` with `Refrigeration.Common.EnumType.Door.States.*`),
  `RemoteControlActive` (user-set on the appliance; API may only disable),
  `RemoteControlStartAllowed` (user-set on the appliance, **auto-expires after ~24 h**),
  `LocalControlActive` (true while someone touches the appliance, reverts after seconds),
  `PowerState` setting (`On`, `Off` **or** `Standby` — which one an appliance accepts is in its
  `allowedvalues`; sending the wrong one → 528 `BSH.Common.Error.WriteRequest.NotAvailableByList`,
  HA #146889).
- Appliance events worth first-class items: `ProgramFinished`, `ProgramAborted`,
  `AlarmClockElapsed`, `PreheatFinished`/`RegularPreheatFinished`, `DryingProcessFinished`
  (dryer, before WrinkleGuard ends), dishwasher `SaltNearlyEmpty/SaltLack/RinseAidNearlyEmpty/
RinseAidLack/ProgramBlockedSaltLack/MachineCare*Reminder/SmartFilterCleaningReminder`, washer
  `IDos1FillLevelPoor/IDos2FillLevelPoor`, coffee `BeanContainerEmpty/WaterTankEmpty/DripTrayFull/
DescalingIn{5,10,15,20}Cups/CalcNCleanIn*/DeviceShouldBe{Cleaned,Descaled,CalcNCleaned}/
Device*Overdue/Device*Blockage/KeepMilkTankCool`, fridge `DoorAlarmFreezer/DoorAlarmRefrigerator/
TemperatureAlarmFreezer`, hood `GreaseFilterMaxSaturation{Nearly,}Reached`, robot
  `RobotIsStuck/DockingStationNotFound/EmptyDustBoxAndCleanFilter`, and (2026-05) external
  triggers `BSH.Common.Event.Favorite.00{1,2}.ExternalTrigger` on hoods/cooktops.
- Observed on the real account (2026-08-26, dump run): every per-appliance GET of an
  **offline** appliance answers `409 SDK.Error.HomeAppliance.Connection.Initialization.Failed:
HomeAppliance is offline`; `programs/active` answers `404 SDK.Error.NoProgramActive` while
  `OperationState` is `Inactive`/`Ready`, `programs/selected` `404 SDK.Error.NoProgramSelected`
  on the oven; `name` and `displayvalue` are returned even without `Accept-Language`; the
  programs list carries `constraints: {available, execution: selectandstart}`; the device-flow
  code was valid for **1800 s** (docs say 300). Consequence (H-17): never query offline
  appliances, never query `programs/active` unless a program can be running, and treat 404/409
  as _soft_ errors in the budget — but assume BSH's "10 successive errors" counter does see them.
- Timing measured 2026-08-26: `KEEP-ALIVE` every **55 s** on the all-appliances stream; a
  `PUT settings/PowerState` on the oven produced its `NOTIFY` on the stream ~200 ms later,
  followed by `STATUS OperationState Ready` (+0.8 s) and `CurrentCavityTemperature` (+2.5 s;
  it jumped from a stale 59 °C to 20 °C when the oven woke up — the docs' warning about that
  sensor is justified); `Standby` again gave `OperationState Inactive` + `PowerState Standby`
  in one flush. Events carry `uri`, `name`, `displayvalue`, `level`, `handling`, `timestamp` (s).
- Behaviour seen in the wild: appliances that go to `Inactive`/off stop reporting and the API
  answers 4xx for status/settings until they are on again (HA "entities unavailable" family:
  #153578, #159411, #138612); firmware may move progress keys from `programs/active` to
  `programs/selected` (ioBroker #359); some appliances flap `CONNECTED`/`DISCONNECTED` many
  times per hour (HA #147299 — re-seeding on each event burned the quota); values can arrive in
  the wrong magnitude (`CurrentCavityTemperature` ×10 on a warming drawer, #179912).

### 2.5 Program start preconditions (BSH best practice)

`connected == true` ∧ `RemoteControlActive` ∧ `RemoteControlStartAllowed` ∧
`¬LocalControlActive` ∧ `OperationState == Ready`; then `PUT programs/active {key, options}` and
verify that `OperationState` becomes `Run` (or `DelayedStart`). Errors:
`SDK.Error.WrongOperationState`, `SDK.Error.UnsupportedOperation`, `SDK.Error.UnsupportedProgram`,
`SDK.Error.UnsupportedOption`, `SDK.Error.ProgramNotAvailable`, `SDK.Error.NoProgramActive`,
`SDK.Error.NoProgramSelected`, `SDK.Error.ActiveProgramNotSet`, `SDK.Error.SelectedProgramNotSet`,
`SDK.Error.HomeAppliance` (528 with an appliance error key), plus the 429s of §2.3 (error
`key` is `"429"`, the description names the limit). Delayed start: `StartInRelative` (dishwasher, oven,
microwave; 0–86340 s) and `FinishInRelative` (washer, dryer, washer-dryer; 0–86400 s) are
**start-only** options (rejected on select) and can be updated while in `DelayedStart`.
Options and their constraints are appliance- and program-specific: "first select the program
without options, then read `programs/selected/options` / `programs/available/{key}`".

### 2.6 Local protocol and Matter (for OQ-H5, not for 1.0)

- Appliances speak a local WebSocket protocol: older generation TLS-PSK
  (`ECDHE-PSK-CHACHA20-POLY1305`, `wss://<ip>:443/homeconnect`), newer AES-CBC + HMAC-SHA256
  on `ws://<ip>:80/homeconnect`; PSK/IV per appliance are obtained once from the BSH cloud
  (`hc-login` in hcpy, or bruestel's Profile Downloader, GUI, SingleKey login via redirect URL)
  together with the feature XML (UID → `BSH.Common.*` name, access mode, enum values).
  Resources: `/ei/initialValues`, `/ci/services`, `/ni/info`, `/ro/allMandatoryValues`,
  `/ro/allDescriptionChanges`, `/ro/values`. Robots are cloud-only. mDNS discovery.
- Same key vocabulary as the cloud API, so §4.3's item table can be shared.
- Matter: BSH ships Matter only on new cooling appliances (since IFA 2024), "most existing
  products cannot be upgraded" — irrelevant for this adapter's lifetime.

---

## 3. What users struggle with elsewhere (→ requirements)

Collected from HA core issues (top by comments), the HA community, ioBroker forum/issues,
openHAB threads, Node-RED issues, hcpy issues; the most common first.

| #   | pain point                                                                                                                                                                                                                           | seen in                                                            | requirement for homeconnect2mqtt                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **OAuth setup**: developer app, redirect URI, e-mail must match and be lowercase, 15-min propagation, wrong account at SingleKey login, "unauthorized_client", token endpoint 400, "reauthentication required" after BSH-side resets | HA #169982 (84 c), #139991 (70), #135327 (58), #72810; NR #99; ioB | R1 Device Flow by default, `--login` CLI that prints URL + code; `status/bridge/auth` item + HA sensor with the verification URL; README checklist of the portal pitfalls; re-auth without reinstalling                 |
| 2   | **1000/day quota**: polling, reload-everything on any event, option fetching per program, several integrations sharing one app; "second developer app" as the workaround                                                             | HA #139328 (65), #119129, #42291; ekutner #331; ioB #58, #327      | R2 no polling at all in steady state; seeding ≤ 5 req/appliance; constraint cache; budget counters published as `status/bridge/quota`; refuse (and log) rather than run into 429; `--budget-reserve` for manual actions |
| 3   | **Entities unavailable while the appliance is off** / after reload; program list only refreshable when the appliance is on                                                                                                           | HA #153578 (51), #159411 (59), #138612 (40), #129146, #130894      | R3 retained topics keep the last known value; per-appliance `connected` + `power` drive availability; re-seed on `CONNECTED` with a per-appliance cool-down; never clear items because a request failed                 |
| 4   | **Connected/paired event storms** → integration disables itself                                                                                                                                                                      | HA #147299 (37)                                                    | R4 rate-limit re-seeding per appliance (max once per 15 min, then only on demand), count storms into `status/<dev>/reconnects`                                                                                          |
| 5   | **Remote start** disabled/expired (24 h), local control active → start rejected with unhelpful errors                                                                                                                                | all                                                                | R5 check preconditions before `PUT programs/active`, publish a readable reason on `status/<dev>/last_error`, expose `remote_start` so automations can nag                                                               |
| 6   | **PowerState** Off vs Standby not distinguishable → `NotAvailableByList`                                                                                                                                                             | HA #146889, #113435                                                | R6 read `allowedvalues` of `PowerState` once, map `set/<dev>/power false` to whichever of Off/Standby is allowed                                                                                                        |
| 7   | **Unknown / undocumented keys** silently dropped (`3DHotAir`, `Memory1`, hob "Favourite" button, ambient-light RGB)                                                                                                                  | HA #175598, #159791, #141424; ioB #251, #398                       | R7 every key is published — mapped ones as friendly items, the rest verbatim (H-6); `set` accepts full keys                                                                                                             |
| 8   | **Progress/remaining time** not updating, moving between active/selected, "finish time" wanted as a timestamp                                                                                                                        | ioB #359; ekutner #249, #291; HA "Finish time" sensor              | R8 progress items are fed from both `programs/active` and `programs/selected` NOTIFYs; `program/finish_at` ISO timestamp derived from `RemainingProgramTime`; estimated duration on selection                           |
| 9   | **Delayed start** (`StartInRelative`/`FinishInRelative`) hard to use; `time` entity flaky                                                                                                                                            | ekutner #570 (open); ioB #322                                      | R9 `set/<dev>/program/start` accepts `{program, options, start_in \| finish_in \| finish_at}`; absolute time converted locally                                                                                          |
| 10  | **Energy/water consumption** as shown in the app is not in the API (only `BSH.Common.Option.EnergyForecast`/`WaterForecast` in %)                                                                                                    | HA community 679890/771298; ekutner #420                           | R10 publish the forecast percentages as items, document that kWh/l are not available (pair with a metering plug via cul2mqtt/other)                                                                                     |
| 11  | **SSE stream dies silently** (internet outage, token expiry), integration shows online                                                                                                                                               | openHAB thread; hcpy #120; NR #56                                  | R11 keep-alive watchdog, exponential backoff with jitter, `connected` 1 while the stream is down, `status/bridge/stream` item                                                                                           |
| 12  | **Appliance names / topic ids**: haId is ugly, HA names like "Siemens Siemens …", entity ids starting with digits                                                                                                                    | ekutner #242, #482                                                 | R12 topic level from the app name (sanitised) with a map file override (like cul2mqtt), HA device name = app name, brand/model from `brand`+`vib`                                                                       |
| 13  | **Local control wish** (no cloud, latency, BSH outages/PKI expiry)                                                                                                                                                                   | hcpy, go-homeconnect2mqtt, HA community 687153                     | OQ-H5: transport abstraction now, local transport later                                                                                                                                                                 |
| 14  | Notifications: "program finished", salt/rinse aid, bean container, water tank, drip tray, descaling, door alarms — the actual reason most people integrate these appliances                                                          | everywhere                                                         | R14 every `*.Event.*` as a non-retained event item **and** a retained "latched" state (`present` until `Off`/`Confirmed`), HA `event` + `binary_sensor` discovery                                                       |
| 15  | Fridge cameras (images), robot maps, coffee counters                                                                                                                                                                                 | openHAB thread; HA sensors                                         | images opt-in (`--images`, 13+ requests per refresh); counters as diagnostic items                                                                                                                                      |

---

## 4. Implementation spec

### 4.1 Architecture

```
index.js            createAdapter() + wiring (events → pubStatus, set → actions)
config.js           parseConfig(): OPTIONS below
lib/install.js      createInstaller(); beforeStart copies tokens.json into STATE_DIRECTORY
lib/auth.js         OAuth: device flow, auth code (one-shot callback server), refresh, token store
lib/client.js       REST client: fetch, headers, error mapping (ApiError{status,key,description,retryAfter}),
                    request accounting hook
lib/budget.js       quota governor (day/minute/burst/start/stop counters, persisted, Retry-After aware)
lib/sse.js          SSE parser + stream lifecycle (global stream, keep-alive watchdog, backoff)
lib/appliance.js    per-appliance state model: seed, apply events, derived items, program/option cache
lib/keys.js         key ↔ item table (pure): full key → {item, kind, enum map, unit}; reverse for set
lib/actions.js      set-topic → API call(s): power, program start/select/stop/pause/resume, options,
                    settings, commands, refresh; precondition checks; PowerState Off/Standby mapping
lib/hadiscovery.js  pure: appliances + their known items → HA device blocks (bridge + one per appliance)
test/*.test.js      node:test with recorded fixtures (SSE transcripts, REST bodies from the simulator
                    and from real appliances via scripts/dump.js)
scripts/dump.js     logs in, dumps appliances/status/settings/programs and 10 min of SSE (redacted)
example-map.json, map.schema.json
```

No runtime dependency besides `mqtt-interfaces-core` (`fetch`, `node:https`, `node:crypto`).

### 4.2 Topics

Default `--name homeconnect`. `<dev>` is the appliance's topic name (§4.4).

| topic                                       | retained | payload / notes                                                                                                            |
| ------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `<name>/connected`                          | yes      | core: `0` LWT, `1` MQTT only, `2` MQTT + Home Connect (token valid **and** SSE stream open)                                |
| `<name>/info`                               | yes      | core fields + `api` (`production`/`simulator`), `clientId` (truncated), `appliances` count                                 |
| `<name>/status/bridge/auth`                 | yes      | `{state: ok\|required\|pending, url?, code?, expires?}` — the Device-Flow prompt lives here so HA/she can show it          |
| `<name>/status/bridge/quota`                | yes      | `{day: {used, limit, reset}, minute: {used, limit}, starts: n, stops: n, blockedUntil?}`                                   |
| `<name>/status/bridge/stream`               | yes      | `open\|reconnecting\|closed`, `since`, `keepalive` ts                                                                      |
| `<name>/status/bridge/appliances`           | yes      | `[{haId, topic, name, brand, model (vib), enumber, type, connected}]`                                                      |
| `<name>/status/<dev>/connected`             | yes      | `true/false` from the `connected` flag / `CONNECTED`-`DISCONNECTED` events → per-device HA availability (A-6 pattern)      |
| `<name>/status/<dev>/<item>`                | yes      | the friendly items of §4.3                                                                                                 |
| `<name>/status/<dev>/event/<item>`          | **no**   | one publish per `EVENT` (`present\|off\|confirmed`), `{key, level, handling}` as extra fields                              |
| `<name>/status/<dev>/alert/<item>`          | yes      | latched: `true` while an event is `Present`, `false` on `Off`/`Confirmed` (R14)                                            |
| `<name>/status/<dev>/key/<Full.Key>`        | yes      | **every** received key verbatim (value as delivered, `unit` as extra field) — the escape hatch for undocumented keys (H-6) |
| `<name>/status/<dev>/last_error`            | no       | `{action, status, key, description}` for a rejected `set` (R5)                                                             |
| `<name>/set/<dev>/<item>`                   | —        | commands, §4.5                                                                                                             |
| `<name>/set/bridge/refresh`                 | —        | re-list appliances (PAIRED/DEPAIRED normally handles this)                                                                 |
| `<name>/set/raw`                            | —        | `{method, path, body}` passthrough, **off by default** (`--raw-set`); responses on `<name>/raw`                            |
| `<name>/maintenance/set/{loglevel,restart}` | —        | core                                                                                                                       |

### 4.3 Items (per appliance) — the key → item table (`lib/keys.js`)

Values are booleans, numbers, or the **enum leaf in snake_case** (`Run` → `run`, `Eco50` →
`eco50`, `RPM1400` → `rpm1400`, `GC40` → `gc40`); the full key stays available under `key/`.
Program keys are shortened to the part after `.Program.` (`Dishcare.Dishwasher.Program.Eco50` →
`eco50`, `Cooking.Oven.Program.HeatingMode.HotAir` → `heating_mode.hot_air`,
`ConsumerProducts.CoffeeMaker.Program.Beverage.Espresso` → `beverage.espresso`).

| item                                                                                  | source key(s)                                                                                                                | notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operation_state`                                                                     | `BSH.Common.Status.OperationState`                                                                                           | `inactive\|ready\|delayed_start\|run\|pause\|action_required\|finished\|error\|aborting`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `power`                                                                               | `BSH.Common.Setting.PowerState`                                                                                              | `on\|off\|standby`; `allowedvalues` cached for R6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `door`                                                                                | `BSH.Common.Status.DoorState`                                                                                                | `open\|closed\|locked`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `door/<compartment>`                                                                  | `Refrigeration.Common.Status.Door.*`                                                                                         | `open\|closed`; `refrigerator`, `freezer`, `bottle_cooler`, `chiller*`, `flex_compartment`, `wine_compartment`, `refrigerator2/3`                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `remote_control`, `remote_start`, `local_control`                                     | `BSH.Common.Status.{RemoteControlActive,RemoteControlStartAllowed,LocalControlActive}`                                       | booleans                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `program/active`, `program/selected`                                                  | `BSH.Common.Root.{ActiveProgram,SelectedProgram}`                                                                            | short program key or `null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `program/available`                                                                   | `GET programs/available` (seeded once per power-on, cached)                                                                  | `[{key, short, name?}]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `program/progress`                                                                    | `BSH.Common.Option.ProgramProgress`                                                                                          | %                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `program/remaining`, `program/elapsed`, `program/duration`, `program/estimated_total` | `BSH.Common.Option.{RemainingProgramTime,ElapsedProgramTime,Duration,EstimatedTotalProgramTime}`                             | seconds; `remaining_estimated` bool alongside                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `program/finish_at`                                                                   | derived                                                                                                                      | ISO timestamp = now + remaining, re-published only when it moves by > 60 s (avoids churn)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `program/start_in`, `program/finish_in`                                               | `BSH.Common.Option.{StartInRelative,FinishInRelative}`                                                                       | seconds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `option/<opt>`                                                                        | every `*.Option.*` of the active **or** selected program                                                                     | `temperature`, `spin_speed`, `drying_target`, `setpoint_temperature`, `fast_pre_heat`, `level`, `bean_amount`, `fill_quantity`, `venting_level`, `i_dos_1_active`, `vario_perfect`, `program_mode`, `energy_forecast`, `water_forecast`, … (leaf snake_case)                                                                                                                                                                                                                                                                                                               |
| `option/<opt>/constraints`                                                            | `programs/selected/options` / `programs/available/{key}`                                                                     | `{min, max, stepsize, allowedvalues (short), default, access}` — cached, R2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `setting/<setting>`                                                                   | every `*.Setting.*`                                                                                                          | `child_lock`, `alarm_clock`, `temperature_unit`, `cup_warmer`, `setpoint_temperature_refrigerator`, `super_mode_freezer`, `eco_mode`, `sabbath_mode`, `vacation_mode`, `fresh_mode`, `dispenser_enabled`, `light/internal/power`, `light/external/brightness`, `ambient_light/enabled`, `ambient_light/color`, `ambient_light/custom_color`, `ambient_light/brightness`, `lighting`, `lighting_brightness`, `color_temperature`, `color_temperature_percent`, `venting_level`, `ventilation`, `i_dos_1_base_level`, `current_map`, …                                       |
| `status/<status>`                                                                     | every other `*.Status.*`                                                                                                     | `current_cavity_temperature`, `beverage_counter/<kind>`, `battery_level`, `battery_charging_state`, `charging_connection`, `dust_box_inserted`, `lost`, `lifted`, `process_phase`, `last_selected_map`, `camera_state`, `door_camera_present`, …                                                                                                                                                                                                                                                                                                                           |
| `event/<event>` (not retained), `alert/<event>`                                       | every `*.Event.*`                                                                                                            | `program_finished`, `program_aborted`, `alarm_clock_elapsed`, `preheat_finished`, `regular_preheat_finished`, `drying_process_finished`, `salt_nearly_empty`, `salt_lack`, `rinse_aid_nearly_empty`, `rinse_aid_lack`, `program_blocked_salt_lack`, `machine_care_reminder`, `i_dos_1_fill_level_poor`, `bean_container_empty`, `water_tank_empty`, `drip_tray_full`, `descaling_in_20_cups`, `device_should_be_descaled`, `door_alarm_freezer`, `temperature_alarm_freezer`, `grease_filter_max_saturation_reached`, `robot_is_stuck`, `favorite_001_external_trigger`, … |
| `program/favorite/<n>`                                                                | `BSH.Common.Setting.Favorite.<n>.Name` + `BSH.Common.Program.Favorite.<n>` / `BSH.Common.Event.Favorite.<n>.ExternalTrigger` | favourites of hobs/hoods/ovens resolved to their user-given names (HA #159791); `set/<dev>/program/start favorite/<n>` starts one                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `last_seen`                                                                           | derived                                                                                                                      | ts of the last event or seed for this appliance (health; HA diagnostic `timestamp` sensor); `stale` bool when older than `--stale-after` (default 24 h) **and** `connected`                                                                                                                                                                                                                                                                                                                                                                                                |
| `running`, `door_open`, `power_on`                                                    | derived (H-15)                                                                                                               | booleans; `running` = `operation_state == run`, `door_open` = `door != closed`, `power_on` = `power == on`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `connected`                                                                           | `homeappliances[].connected`, `CONNECTED`/`DISCONNECTED`                                                                     | availability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `info`                                                                                | `homeappliances[]` entry                                                                                                     | `{haId, name, brand, vib, enumber, type}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `key/<Full.Key>`                                                                      | everything                                                                                                                   | verbatim mirror (H-6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

The table is generated from the docs' key list (`prior-art/homeconnect-api-keys.txt`) plus a hand-maintained
alias list; unknown keys fall back to a mechanical mapping (`<Category>` = last segment before
the leaf: `Option`→`option/`, `Setting`→`setting/`, `Status`→`status/`, `Event`→`event/`) so a
new BSH key appears in the right place without a release. `--items compact|full` (OQ-H3) may
later reduce the default set for small brokers.

### 4.4 Appliance topic names

`<dev>` = the name given in the Home Connect app (`homeappliances[].name`, e.g. "Geschirrspüler"),
sanitised like alexa-remote-mqtt's `topicName()` (lower-case, umlauts transliterated,
`/`,`+`,`#`, spaces → `_`), with collisions suffixed by `_2`; `bridge` is reserved. Overrides via
`--map-file` (`{"BOSCH-SMV68TX06E-68A40E123456": "dishwasher"}`), `set` accepts the haId too.
Renames in the app do not change topics until the map is edited or the instance restarted with
`--rename-follows-app` (OQ-H2).

### 4.5 Commands (`<name>/set/<dev>/…`)

| topic                             | payload                                                                                                                                                                    | API                                                                                                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `power`                           | `on\|off\|standby\|true\|false`                                                                                                                                            | `PUT settings/BSH.Common.Setting.PowerState`; `false` → `Off` or `Standby` per `allowedvalues` (R6)                                                        |
| `program/start`                   | `eco50` / full key / `{"program": "eco50", "options": {"temperature": "gc40", "spin_speed": 1400}, "start_in": 3600 \| "finish_in": … \| "finish_at": "2026-08-27T06:30"}` | precondition check (§2.5) → `PUT programs/active`; option values translated back to full enum keys via the constraint cache; `finish_at` → seconds locally |
| `program/select`                  | same without delay fields                                                                                                                                                  | `PUT programs/selected` (then the NOTIFYs deliver the options + constraints)                                                                               |
| `program/stop`                    | any                                                                                                                                                                        | `DELETE programs/active`                                                                                                                                   |
| `program/pause`, `program/resume` | any                                                                                                                                                                        | `PUT commands/BSH.Common.Command.{PauseProgram,ResumeProgram}`                                                                                             |
| `program/start_selected`          | any / `{start_in}`                                                                                                                                                         | `PUT programs/active {key: <selected>}` — the "one-touch start" people ask for                                                                             |
| `option/<opt>`                    | value (short enum or number)                                                                                                                                               | `PUT programs/active/options/<key>` while running, else `programs/selected/options/<key>`                                                                  |
| `setting/<setting>`               | value                                                                                                                                                                      | `PUT settings/<key>`                                                                                                                                       |
| `command/<cmd>`                   | any                                                                                                                                                                        | `PUT commands/<key>` (`open_door`, `partly_open_door`, and any key in `GET commands`)                                                                      |
| `refresh`                         | any                                                                                                                                                                        | re-seed this appliance (counts ~4 requests; refused when the budget reserve is exhausted)                                                                  |
| `alarm_clock`                     | seconds                                                                                                                                                                    | alias of `setting/alarm_clock`                                                                                                                             |

Every `set` is verified by the resulting event, not echoed (core rule); a rejection publishes
`last_error` and logs at `warn` with the API's `key` + `description`.

**Write gating (H-18).** Before any `PUT`, the command is checked against what the appliance
last told us: the option/setting exists in the cached constraints, `access` is `readWrite`,
the value is inside `allowedvalues` / `min..max..stepsize` (a float with `stepsize: 1` is sent
as an integer), enum values are matched case-insensitively and accepted in short or full form.
A command that cannot succeed is refused locally with a readable `last_error` — it costs no
request and cannot feed BSH's successive-error counter. Read tolerantly, write strictly:
unknown values _from_ the appliance are passed through, values _to_ it are normalised.

**Start paths per appliance type** (what "start" means differs; verified against the fixtures
as they come in):

| type                        | start                                                                                                                                                        | delayed start                        | stop / off                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | --------------------------------------------------------------- |
| dishwasher                  | `PUT programs/active {key, options}`                                                                                                                         | `BSH.Common.Option.StartInRelative`  | `DELETE programs/active`                                        |
| washer, dryer, washer-dryer | same                                                                                                                                                         | `BSH.Common.Option.FinishInRelative` | same; `PauseProgram`/`ResumeProgram` where listed in `commands` |
| oven, warming drawer        | same (`HeatingMode.*`, `Microwave.*`); `PreHeating` + `Duration` for pre-heat                                                                                | `StartInRelative`                    | same                                                            |
| hood                        | `Cooking.Common.Program.Hood.Venting` with `Option.Hood.VentingLevel` — level changes are option writes, **fan off = `DELETE programs/active`**, not level 0 | —                                    | `DELETE programs/active`; `DelayedShutOff` program              |
| cooktop (hob)               | programs mostly need on-device confirmation; a rejected start is expected; expose `Favorite.*` triggers                                                      | —                                    | —                                                               |
| coffee machine              | `Beverage.*` / `CoffeeWorld.*` with `FillQuantity`, `BeanAmount`, … (5 starts/min!)                                                                          | —                                    | `DELETE programs/active` (abort the beverage)                   |
| cleaning robot              | `Cleaning.CleanAll` / `CleanMap` + `ReferenceMapId`; `Basic.GoHome`                                                                                          | —                                    | `Pause`/`Resume`, `GoHome`                                      |
| fridge/freezer, wine cooler | no programs — settings only (`SuperMode*`, setpoints, lights, `Dispenser`)                                                                                   | —                                    | —                                                               |

### 4.6 Quota governor (`lib/budget.js`) — the core of the design

- Counters: requests per day (rolling from the first request of the UTC day BSH uses — assume
  the reset time from the first `Retry-After` seen and persist it), per minute, per 10 s burst,
  program starts/min, stops/min, consecutive errors, token refreshes/min/day. Persisted in
  `STATE_DIRECTORY/budget.json` so a restart does not reset them (ioBroker #327 lesson).
- Priorities: `set` commands > re-seed on `CONNECTED` > `refresh` > constraint fetch > images.
  `--budget-reserve 100` requests/day are kept for user commands; background work stops when
  `used ≥ limit − reserve`, commands stop at the limit with a `warn` and `last_error`.
- Per-appliance re-seed cool-down: `--reseed-cooldown 900` s (R4); a flapping appliance gets
  `status/<dev>/connected` toggled but is re-seeded at most once per cool-down.
- Steady state budget: 1 (stream) + N×4 (seed) at start, then **0 requests** until something
  happens; a program start from MQTT costs 1–2 (start, optionally a select first). A restart
  costs a new seed → `--seed-on-start full|lazy`: `lazy` seeds only appliances that are
  `connected` and publishes the rest from the retained MQTT state (read back by the core on
  reconnect? — no: the adapter cannot read its own retained topics without subscribing; it
  keeps a `STATE_DIRECTORY/state.json` snapshot instead, OQ-H4).
- Every 429 is honoured: `Retry-After` → block that class until then; no `Retry-After` (burst)
  → 2 s backoff. 10 successive errors within 10 min block everything for 10 min, so the client
  stops after 5 consecutive errors and waits.
- The counters are the `status/bridge/quota` item and a `sensor` in HA (diagnostic).

### 4.7 Stream (`lib/sse.js`)

- One `GET /homeappliances/events` with `Accept: text/event-stream`, `Authorization: Bearer`,
  `Accept-Language` when `--language` is set. Own parser (`event:`, `data:`, `id:` lines,
  blank-line dispatch, comment lines) — `EventSource` is not in Node and the npm package is
  unnecessary.
- Watchdog: BSH sends `KEEP-ALIVE` periodically (interval undocumented; well under a minute in
  other clients' logs — measure it in milestone 0.1 and set the default from it); no event for
  `--stream-timeout 130` s → close + reconnect. Reconnect backoff 5 s → 5 min with jitter; 401 → refresh token first;
  429 (channel limit) → wait `Retry-After` or 60 s, log at `warn` once ("another client of this
  app+account holds the channels"). `connected` is `2` only while the stream is open.
- `PAIRED` → list appliances (1 request), seed the new one; `DEPAIRED` → `clearStatus` of its
  items, discovery array shrinks (core clears the HA device); `CONNECTED` → `connected true` +
  cool-down-guarded re-seed; `DISCONNECTED` → `connected false`, items kept.
- Events are applied through `appliance.apply(item)` which also feeds derived items
  (`finish_at`, `alert/*`) and the `key/*` mirror. **Order is preserved and pulses are never
  coalesced**: an `EVENT` `Present → Off` pair must reach the broker as two publishes even
  under load (the core's mqtt client queues in order; nothing in the adapter may debounce
  event items — only `finish_at` and discovery are debounced).
- **Flap damping** (done in 0.1): the reconnect backoff only resets after a stream has been
  open for 10 s; a server that accepts and immediately drops the connection therefore backs
  off instead of looping. The same rule applies to appliance `CONNECTED`/`DISCONNECTED`
  flapping through the re-seed cool-down (R4).

### 4.8 Authorization (`lib/auth.js`)

- `--client-id` (required), `--client-secret` (optional, `secret: true`; only Auth-Code apps
  with a secret need it), `--auth-flow device|code` (default `device`), `--scopes` (default
  `IdentifyAppliance Monitor Control Settings`), `--simulator` (host switch), `--language`.
- `homeconnect2mqtt --login [--name n]` runs the flow interactively before `--install`:
  Device Flow prints `verification_uri_complete` + `user_code` (and a QR code as ASCII when
  on a TTY) and polls at `interval` until `expires_in` (300 s); Auth Code starts a one-shot
  HTTP server on `--auth-callback-port 8580`, prints the authorize URL with the registered
  redirect URI (`--redirect-uri`, default `http://127.0.0.1:8580/callback`; the browser, not
  BSH, hits it — no port forwarding), exchanges the code. Tokens →
  `STATE_DIRECTORY/tokens.json` (or `--token-file`), `0600`; `beforeStart` of the installer
  copies a token file from the invoking user's directory into the instance's state dir (the
  lgtv2mqtt pairing-key pattern).
- At runtime the same flow is re-entered automatically when a refresh fails with
  `invalid_grant`: `status/bridge/auth` → `{state: required, url, code, expires}`, log at
  `warn` (action required, names the URL), HA gets a `sensor` with the URL as state and the
  code as attribute; polling stops after `expires_in` and restarts on `set/bridge/login`
  (so nobody has to ssh in — R1, and the May-2026 mass invalidation becomes a notification).
- Proactive refresh at 80 % of `expires_in` (~19 h), retry 1 min / 5 min / 15 min, never more
  than 10/min or 100/day; the persisted refresh token is replaced on every response.

### 4.9 Home Assistant discovery (`lib/hadiscovery.js`)

One bridge device (`homeconnect2mqtt_<name>`) with `auth`, `quota`, `stream` diagnostics, and
one device per appliance (`via_device` bridge, `mf` = brand, `mdl` = vib, `sn` = haId,
availability = `<name>/connected` ≥ 2 **and** `status/<dev>/connected`, `avty_mode: all`).
Entities are derived from the items the appliance has actually reported (dynamic, the ekutner
lesson) plus a static per-type baseline so that sensors exist before the first event:

| platform        | items                                                                                                                                                                                                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sensor`        | `operation_state` (enum), `program/active`, `program/selected`, `program/progress` (%), `program/remaining` (s, `duration`), `program/finish_at` (`timestamp`), `door` (enum), counters, temperatures, `battery_level`                                                                  |
| `binary_sensor` | `connected` (connectivity), `remote_control`, `remote_start`, `local_control`, `door` (opening) where binary, `alert/*` (problem)                                                                                                                                                       |
| `switch`        | `power` (with the Off/Standby mapping), boolean settings (`child_lock`, `super_mode_*`, `eco_mode`, `sabbath_mode`, `vacation_mode`, `fresh_mode`, `cup_warmer`, `dispenser_enabled`, `lighting`), boolean options while selectable (`fast_pre_heat`, `i_dos_1_active`, `half_load`, …) |
| `select`        | `program/select` (options = `program/available`), enum options and settings with `allowedvalues` (`option/temperature`, `option/spin_speed`, `option/drying_target`, `setting/venting_level`, `setting/ambient_light/color`, …)                                                         |
| `number`        | numeric options/settings with `min/max/stepsize` (`option/setpoint_temperature`, `option/duration`, `option/fill_quantity`, `setting/setpoint_temperature_*`, `setting/alarm_clock`, `program/start_in`, `program/finish_in`)                                                           |
| `button`        | `program/start_selected`, `program/stop`, `program/pause`, `program/resume`, `command/open_door`, `command/partly_open_door`, `refresh`                                                                                                                                                 |
| `event`         | `event/*` with `event_types: [present, off, confirmed]`                                                                                                                                                                                                                                 |
| `light`         | `setting/light/internal`, `setting/light/external`, `setting/ambient_light`, hood `lighting` (brightness; RGB via `ambient_light/custom_color`)                                                                                                                                         |

Discovery is re-published (debounced) when an appliance reports a key that has no entity yet
or when `program/available` / constraints change (`markDiscoveryDirty()`).

Rules every MQTT bridge that targets HA discovery learns the hard way (H-19):

- **Validate per platform before publishing** — HA discards the _whole_ entity on one invalid
  field and only logs it: `dev_cla: enum` exists on `sensor` only and requires `options`;
  `unit_of_meas` only on `sensor`/`number`; `stat_cla` only on `sensor`; `binary_sensor`,
  `switch`, `button` have their own fixed class lists; `select` takes none; a `button` needs a
  `cmd_t` and no `stat_t`. The builder in `lib/hadiscovery.js` applies these filters and the
  tests assert them; if the core's `entity()` grows a validator this moves there (B-8).
- **Unresolvable enum states publish `None`**, not the raw value: an active/selected program
  that is not in `options` (or `null` while idle) would otherwise make HA log "Invalid option"
  and keep the stale value; `None` clears a `select` and sets a `sensor` to unknown.
- **`--ha-entities curated|full`** (default `curated`): `curated` announces the primary set —
  `connected`, `power`, `operation_state`, `door`, `program/active|selected|progress|remaining|finish_at`,
  `remote_start`, `alert/*` for the well-known events, the type-specific main options; `full`
  additionally announces every `setting/*`, `option/*`, `status/*` and `event/*` item **disabled
  by default** (`en: false`) with `ent_cat: diagnostic|config` — one click in HA enables one,
  and an idle washer does not dump 150 entities on the dashboard. The `key/*` mirror is never
  announced.
- **Entity names** are the API's localized `name` when `--language` is set (they arrive with
  every status/setting/event item at no extra request), entity **ids** stay English and stable
  (`uniq_id` = `<id>_<item>`); enum values stay technical (`eco50`), only labels are localized.
- **Orphans**: when an appliance's item set shrinks (depaired, `--ha-entities` switched from
  `full` to `curated`, an item renamed in a major release) the retained config must go. With
  device-based discovery the core clears a vanished device; for a vanished _component_ inside
  a device HA needs the component published with only its `platform` (check that the core does
  this — core B-8, OQ-H10). A `--ha-discovery-refresh` one-shot that clears and re-publishes
  everything this instance owns covers what HA caches at first registration (`ent_cat`, name).
- **Birth**: re-publish discovery when HA announces itself on `<ha-prefix>/status online` —
  the core does not do this today (checked `lib/adapter.js`), OQ-H10.

### 4.10 CLI / env (`HOMECONNECT2MQTT_*`)

Shared options from the core plus: `--client-id` (required, `secret`), `--client-secret`
(`secret`), `--auth-flow`, `--scopes`, `--redirect-uri`, `--auth-callback-port`, `--token-file`
(`file`), `--simulator`, `--language`, `--map-file` (`file`, json + schema), `--appliances`
(filter: haIds or topic names, default all), `--seed-on-start`, `--reseed-cooldown`,
`--budget-reserve`, `--daily-limit 1000` / `--minute-limit 50` (in case BSH changes them),
`--stream-timeout`, `--images` (off), `--publish-keys` (the `key/*` mirror; default **on**,
OQ-H3), `--ha-entities curated|full`, `--ha-discovery-refresh` (one-shot), `--stale-after`,
`--raw-set` (off), `--login` (action), `--dump` (action: write fixtures). `mqttInterfaces:
{needs: ["network-host"]}` — no, plain internet is enough: `needs: []`.

### 4.11 Logging

`debug`: every request as `hc > GET /homeappliances/…/status` with the running day counter,
every SSE event as `hc < NOTIFY <dev> <key>=<value>`, keep-alives collapsed to one line per 10.
`info`: login ok, N appliances, stream open, discovery published, re-seed. `warn`: stream lost
(transition), 429 (once per class with the wait), rejected `set` with reason, re-auth required
(with URL), appliance flapping (once per cool-down). `error`: bad config, token file
unreadable, quota exhausted for commands.

---

## 5. Decisions

| ID   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H-1  | **Cloud API first.** 1.x talks to `api.home-connect.com` only; the local WebSocket protocol is a possible 2.x transport (OQ-H5). Topic layout and item names are transport-neutral (the key vocabulary is the same).                                                                                                                                                                                                                                                                       |
| H-2  | **Bridge layout** like alexa-remote-mqtt: `<name>/status/<dev>/<item>`, pseudo device `bridge` for account-level state, `<name>/connected` 2 = token valid + stream open, per-appliance `status/<dev>/connected` for HA availability.                                                                                                                                                                                                                                                      |
| H-3  | **Device Flow is the default login**; Authorization Code with a one-shot local callback as the alternative. No redirect URI, no client secret, no web UI in the adapter. The login is a CLI action (`--login`) and, at runtime, an MQTT-visible prompt (`status/bridge/auth`).                                                                                                                                                                                                             |
| H-4  | **Re-authorization is a normal path**, not a crash: `invalid_grant` → `auth: required` + URL, keep running (retained state stays), resume automatically after the user completes the flow. Never loop on the token endpoint (refresh quota 10/min, 100/day).                                                                                                                                                                                                                               |
| H-5  | **Zero polling.** State comes from one global SSE stream; REST is used for seeding, on `CONNECTED` (cool-down guarded), on explicit `refresh`, and for commands. A persisted budget governor with a command reserve makes the 1000/day limit an observable quantity (`status/bridge/quota`) instead of a surprise.                                                                                                                                                                         |
| H-6  | **Every key is published.** Documented keys become friendly items via `lib/keys.js`; every key is also mirrored verbatim under `status/<dev>/key/<Full.Key>` (default on) so undocumented keys and new BSH additions are usable immediately; `set/<dev>/option                                                                                                                                                                                                                             | setting | command/<Full.Key>` accepts full keys too. |
| H-7  | **Enum values are the short snake_case leaf** in items (`run`, `eco50`, `gc40`), full keys in the `key/` mirror; the mapping is bijective per item via the cached constraints, so `set` accepts both forms. Program names are shortened after `.Program.`.                                                                                                                                                                                                                                 |
| H-8  | **Events twice**: non-retained `event/<x>` (`present\|off\|confirmed`, one publish per occurrence — `pubStatus(…, {retain: false})`) and retained latched `alert/<x>` boolean. HA gets an `event` entity and a `binary_sensor` (problem).                                                                                                                                                                                                                                                  |
| H-9  | **Options are one namespace**: `option/<x>` reflects the option of the active program while one runs, else of the selected program; `set/<dev>/option/<x>` goes to `programs/active/options` when running, else `programs/selected/options`. (ioBroker's active/selected split is what confused users in #359.)                                                                                                                                                                            |
| H-10 | **Program start is guarded**: preconditions of §2.5 are checked locally first (no request wasted, readable `last_error`), then `PUT programs/active`, then verification by `OperationState`. Delayed start via `start_in`/`finish_in`/`finish_at` in the start payload only (API rule).                                                                                                                                                                                                    |
| H-11 | **PowerState off** is translated to whichever of `Off`/`Standby` the appliance lists in `allowedvalues` (cached at seed); `on` always `On`.                                                                                                                                                                                                                                                                                                                                                |
| H-12 | **Images, raw passthrough, and `key/` mirror** are options (`--images` off, `--raw-set` off, `--publish-keys` on); nothing else is configurable per item in 1.0 — the map file only renames appliances.                                                                                                                                                                                                                                                                                    |
| H-13 | **No swagger, no `eventsource`, no `axios`**: `fetch` + own SSE parser; fixtures recorded from the simulator and from real appliances drive the tests; the simulator (`--simulator`) is the CI target for the client (its refresh token rotates on every request — good for testing rotation).                                                                                                                                                                                             |
| H-14 | **Fleet conventions are a hard requirement** (core README §1–12): ESM, no TypeScript, node ≥ 20.19, `node --test`, eslint+prettier from the core, CI/release workflows copied, `--config-schema` with `x-secret` on `client-id`/`client-secret` and `x-file` on token and map files, systemd template unit, Dockerfile.                                                                                                                                                                    |
| H-15 | **Boolean helper items** next to the enum items: `running` (`operation_state == run`), `door_open` (`door != closed`, i.e. open or locked — the semantics the flow had), `power_on` (`power == on`). The existing automations move with a topic rename only, and the HA `binary_sensor`s need no templates.                                                                                                                                                                                |
| H-17 | **Expected negative answers are not failures.** 404 (`NoProgramActive`, `NoProgramSelected`) and 409 (`HomeAppliance is offline`, `WrongOperationState`) are _soft_ in the budget (counted as requests, not towards the self-imposed error pause), and the seeding logic avoids provoking them (offline → no requests; `programs/active` only when `OperationState` ∉ {Inactive, Ready}). The self-imposed pause never blocks the event stream. `EventStream` emits `lost`, never `error`. |
| H-18 | **Write gating before every PUT** against the cached constraints (exists, `readWrite`, in `allowedvalues`/`min..max..stepsize`, float with `stepsize 1` sent as integer, enums case-insensitive, short or full form). A command that cannot succeed is refused locally with a readable `last_error` — no request spent, nothing fed to BSH's error counter. Read tolerantly, write strictly.                                                                                               |
| H-19 | **Discovery payloads are validated per platform** before publishing (HA drops the whole entity on one invalid field), unresolvable enum states publish `None`, `--ha-entities curated` (default) announces the primary set and `full` the long tail disabled-by-default with `ent_cat`; entity names may be localized (`--language`, from the API's `name`), ids and values never are.                                                                                                     |
| H-20 | **Per-appliance isolation and health.** Seeding, commands and derived state are per appliance; one appliance's 409/404/flapping never delays another's. Each appliance has `last_seen` and `stale`; the bridge has `stream`, `quota`, `auth`. No web UI of our own — she and HA are the UIs.                                                                                                                                                                                               |
| H-21 | **Secrets never leave the process in clear**: `client-id`/`client-secret`/tokens are masked in every log line (`auth.post()`), `--dump` output is redacted by default, the code-flow callback server binds to the redirect uri's host (loopback by default, done in 0.1).                                                                                                                                                                                                                  |
| H-16 | **No extra payload fields.** The core's `pubStatus()` builds exactly `{val, ts, lc}` (checked in `lib/adapter.js`), so `unit`, `level`, `handling` are not carried in the payload: units are fixed per item and documented (seconds, %, °C, ml); an event's `level`/`handling` go into the non-retained `event/<x>` value as an object `{state, level, handling}`. Closes OQ-H9.                                                                                                           |

---

## 6. Milestones / build order

1. **0.1 — client + login + dump** (no MQTT yet) — _code done 2026-08-26_ (`lib/auth.js`
   both flows + token store + refresh, `lib/client.js`, `lib/budget.js`, `lib/sse.js`,
   `lib/keys.js`, `lib/dump.js` behind `--dump`, 46 unit tests, lint/CI boilerplate).
   **Gate 2026-08-26 evening**: `--login` (device flow, `grant_type=device_code`) worked on
   the first try with a Device-Flow application; a 30-min `--dump` on the real account
   (dishwasher off, washer offline, oven standby → switched On/Standby via the api as the
   only traffic) gave 11 events, 0 reconnects, KEEP-ALIVE every 55 s, 36 requests for the
   whole evening (login + two dump seeds + 4 for the oven) — fixtures in
   `test/fixtures/real/` (redacted). Still open: a refresh against the live token endpoint
   (first one is due ~19 h after login), a dump with a running program, the simulator with
   `--auth-flow code`, and a 24 h stream soak.
2. **0.2 — bridge on the core**: `index.js`, `config.js`, `lib/install.js`, `lib/appliance.js`,
   `lib/keys.js`, topics of §4.2/4.3, `set` of §4.5 for power/program/option/setting/command,
   `status/bridge/*`. Runs next to the Node-RED flow; compare topics against the flow's
   (§1.1 once `flow.json` is there).
3. **0.3 — Home Assistant discovery** (§4.9), `--map-file`, `--appliances`, re-auth over MQTT,
   README (portal checklist!), CHANGELOG, Dockerfile, deploy.sh, CI. Checklist §12 of the core
   README; she shows the instance, secrets masked, token/map files editable.
4. **1.0.0** — after two weeks of production use replacing the flow, Node-RED flow removed.
   Publish to npm (replaces the placeholder), release workflow with provenance.
5. **1.x** — images, coffee/robot specifics, `--items compact`, `--rename-follows-app`,
   consumption forecast → HA energy-ish sensors, multi-account (`--name` per account is already
   enough: one instance per account, each its own developer app — this is also the quota
   multiplier the HA people use).
6. **2.x (OQ-H5)** — local transport (`lib/transport-local.js`) with profiles from the Profile
   Downloader, mDNS discovery, same items; cloud stays for robots and as fallback.

---

## 7. Housekeeping

- **Published**: the placeholder `0.0.1` reserved the npm name on 2026-08-26 18:03 (manual
  `npm publish --otp`); `0.1.0` followed the same evening with provenance through the release
  workflow on the `v0.1.0` tag (trusted publishing works). Keep `version` < 1.0 until the
  flow is retired.
- `flow.json` (the Node-RED export) was analysed into §1.1 and deleted on 2026-08-26; the
  flow keeps running on the Node-RED host until milestone 4. Its three haIds are in §1.1 for
  the map file / `--appliances` filter.
- Move the fork at `~/WebstormProjects/node-red-contrib-homeconnect` to `prior-art/` notes or
  drop it; upstream is at 0.6.8 and the fork's two commits (`callback_url`) are obsolete with
  Device Flow.
- Register a dedicated developer application for this adapter ("homeconnect2mqtt", Device
  Flow enabled, no secret, Auth Code redirect URI `http://127.0.0.1:8580/callback` for the
  fallback) — do not share the client id with the Node-RED flow while both run, the quota is
  per `(client_id, user)`.

---

## 8. Open questions

- **OQ-H1** Simulator coverage: the simulator's appliances only expose a subset of keys and its
  refresh token rotates per request; is it enough for CI of the client, or do recorded fixtures
  from real appliances have to be the primary test input (probably both)?
- **OQ-H2** Topic name source: app name (readable, but users rename appliances) vs haId
  (stable, ugly) vs map-file-only. Proposal: app name + map override (§4.4), topics frozen at
  first sight and persisted in `STATE_DIRECTORY/names.json` so a rename in the app does not
  silently move topics; `--rename-follows-app` opts into following.
- **OQ-H3** Default breadth: is the `key/*` mirror on by default too chatty for small brokers
  (a washer emits ~40 keys)? Alternative: `--items compact|full` with `compact` = §4.3 friendly
  items only.
- **OQ-H4** State snapshot across restarts: persisting the last appliance state in
  `STATE_DIRECTORY/state.json` allows `--seed-on-start lazy` (no requests for offline
  appliances) — is stale-but-retained better than unknown-until-seeded? (HA users say yes,
  #153578.)
- **OQ-H5** Local transport in 2.x: worth it given hcpy2 (388 ★), go-homeconnect2mqtt and
  homeconnect_local_hass exist and BSH's cloud has had PKI/DNS incidents (hcpy #278)? Blockers:
  profile download needs a GUI tool with a SingleKey browser login; older TLS-PSK appliances
  need `ECDHE-PSK-CHACHA20-POLY1305` — Node's `tls.connect()` has `pskCallback` (since 10.12)
  but whether the OpenSSL build exposes that PSK cipher suite must be verified; robots are
  cloud-only.
- **OQ-H6** Quota reset boundary: BSH does not document when the daily window resets (UTC
  midnight? rolling 24 h? first-request anchored?). Derive from the first `Retry-After` and
  persist; document what was observed.
- **OQ-H7** Should `program/finish_at` be republished every minute (nice for HA timestamps,
  chatty) or only on > 60 s drift (§4.3)? Start with drift.
- **OQ-H10** Core discovery gaps to verify/add (feed into core B-8): re-publish on HA birth
  (`<ha-prefix>/status online` — not handled by `lib/adapter.js` today), removal of a single
  component inside a device-based config (publish `{platform}` only), per-platform payload
  validation in `entity()`.
- ~~**OQ-H9** extra payload fields~~ — resolved by H-16 (the core does not support them; units
  are per-item constants, event level/handling live in the event value).
- **OQ-H8** HA `select` for `program/select` when the appliance is off: `program/available`
  can only be fetched while on — keep the last list retained and mark the select unavailable
  via `connected`/`power`? (HA's "reload while on" advice is the thing to avoid.)

---

## 9. Sources

Official: [API docs — general/rate limiting](https://api-docs.home-connect.com/general#rate-limiting),
[authorization](https://api-docs.home-connect.com/authorization),
[programs and options](https://api-docs.home-connect.com/programs-and-options),
[states](https://api-docs.home-connect.com/states), [settings](https://api-docs.home-connect.com/settings),
[events](https://api-docs.home-connect.com/events), [commands](https://api-docs.home-connect.com/commands),
[swagger `hcsdk-production.yaml`](https://apiclient.home-connect.com/hcsdk-production.yaml),
[developer changelog](https://developer.home-connect.com/changelog), [news](https://developer.home-connect.com/news),
[FAQ](https://developer.home-connect.com/support/faq),
[BSH Matter press release (CES 2025)](https://www.bsh-group.com/us/press/press-releases/bsh-drives-matter-connectivity-standard-forward-for-home-appliances-at-ces-2025-highlighting-bosch-groups-powerful-position-in-the-smart-home-space).

Integrations: [HA home_connect docs](https://www.home-assistant.io/integrations/home_connect/),
[aiohomeconnect](https://github.com/MartinHjelmare/aiohomeconnect),
[ekutner/home-connect-hass](https://github.com/ekutner/home-connect-hass),
[ioBroker.homeconnect](https://github.com/iobroker-community-adapters/ioBroker.homeconnect),
[openHAB homeconnect](https://www.openhab.org/addons/bindings/homeconnect/),
[openHAB homeconnectdirect](https://www.openhab.org/addons/bindings/homeconnectdirect/),
[homebridge-homeconnect](https://github.com/thoukydides/homebridge-homeconnect) +
[Functionality wiki](https://github.com/thoukydides/homebridge-homeconnect/wiki/Functionality),
[node-red-contrib-homeconnect](https://github.com/alexkn/node-red-contrib-homeconnect),
[hcpy2-0/hcpy](https://github.com/hcpy2-0/hcpy), [osresearch/hcpy](https://github.com/osresearch/hcpy),
[trmm.net write-up of the local protocol](https://trmm.net/homeconnect/),
[go-homeconnect2mqtt](https://github.com/SukramJ/go-homeconnect2mqtt),
[homeconnect_local_hass](https://github.com/chris-mc1/homeconnect_local_hass),
[homeconnect-profile-downloader](https://github.com/bruestel/homeconnect-profile-downloader).

Pain points: HA core issues [#169982](https://github.com/home-assistant/core/issues/169982),
[#139991](https://github.com/home-assistant/core/issues/139991),
[#139328](https://github.com/home-assistant/core/issues/139328),
[#159411](https://github.com/home-assistant/core/issues/159411),
[#153578](https://github.com/home-assistant/core/issues/153578),
[#147299](https://github.com/home-assistant/core/issues/147299),
[#146889](https://github.com/home-assistant/core/issues/146889),
[#175598](https://github.com/home-assistant/core/issues/175598),
[#179912](https://github.com/home-assistant/core/issues/179912);
HA community [rate limit thread](https://community.home-assistant.io/t/home-connect-integration-rate-limit-of-1000-apicalls/327460),
[statistics request](https://community.home-assistant.io/t/home-connect-integration-get-statistics-data/771298),
[local MQTT bridge thread](https://community.home-assistant.io/t/homeconnect-elegant-solution-based-on-a-mqtt-bridge-local-no-cloud/687153);
ioBroker [#327](https://github.com/iobroker-community-adapters/ioBroker.homeconnect/issues/327),
[#396](https://github.com/iobroker-community-adapters/ioBroker.homeconnect/issues/396),
[#359](https://github.com/iobroker-community-adapters/ioBroker.homeconnect/issues/359),
[forum: Bosch devices](https://forum.iobroker.net/topic/83263/homeconnect-probleme-mit-bosch-ger%C3%A4ten);
openHAB [binding thread p.48](https://community.openhab.org/t/home-connect-binding/49702?page=48);
ekutner [#331](https://github.com/ekutner/home-connect-hass/issues/331),
[#420](https://github.com/ekutner/home-connect-hass/issues/420),
[#570](https://github.com/ekutner/home-connect-hass/issues/570);
Node-RED [#99](https://github.com/alexkn/node-red-contrib-homeconnect/issues/99),
[#100](https://github.com/alexkn/node-red-contrib-homeconnect/issues/100);
hcpy [#278](https://github.com/hcpy2-0/hcpy/issues/278), [#120](https://github.com/hcpy2-0/hcpy/issues/120).
