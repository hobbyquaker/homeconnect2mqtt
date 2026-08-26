# Changelog

## 0.1.0

First milestone (ROADMAP §6.1): the Home Connect api side without MQTT.

### Added

- `--login`: OAuth2 Device Flow (default, no redirect uri, no client secret) or Authorization
  Code Flow with a one-shot local callback server; tokens are stored in
  `<state-dir>/tokens.json` (0600), the refresh token rotation is honoured, the access token is
  refreshed proactively at 80 % of its 24 h lifetime.
- `--dump <dir>`: records appliances, status, settings, programs, options, constraints and
  commands of every appliance plus the all-appliances event stream for `--dump-minutes`
  (redacted by default) — the fixtures for the tests and for reports.
- Request budget (`lib/budget.js`) implementing the documented rate limits (1000/day with a
  reserve for commands, 50/min, 5 program starts and stops per minute, 10/100 token refreshes,
  successive-error pause, `Retry-After`), persisted in `<state-dir>/budget.json`.
- REST client (`lib/client.js`) on `fetch` with `ApiError`, one automatic retry after 401 and
  the budget wired in; SSE parser and `EventStream` (`lib/sse.js`) with keep-alive watchdog,
  backoff with jitter, 401/429 handling.
- Soft errors: 404/409 answers of the api (no program active, appliance offline) count as
  requests but not as failures; the event stream is never paused by the client's own error
  counter; `--dump` skips offline appliances and only asks for the active program while one can
  be running (first real-account run, 2026-08-26).
- Key vocabulary helpers (`lib/keys.js`): snake_case items, short enums and program names,
  reverse lookup.
