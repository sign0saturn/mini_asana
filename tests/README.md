# tests/

Local regression suites for mini-asana. No browser, no external services — every suite
runs against a local instance over `127.0.0.1` HTTP. Nothing here contains real tokens,
emails, or hostnames; the Access allowlist email used in tests is the fixture value
`owner@example.com`.

## One-command run (recommended)

```bash
tests/run_local.sh          # uses port 8816; pass another port as $1 if needed
```

This copies `server.py` + `static/` from the repo checkout into a temp dir, starts a
throwaway instance (auth enabled, `data/access_email.txt` = the fixture email), runs all
three suites, and deletes the temp dir. Exit code is non-zero if any check fails.

## Individual suites

| Script | What it covers |
| --- | --- |
| `test_security_api.py` (40 checks) | Bearer auth, CF Access header opt-in (allowlist match/mismatch/case, ignored without config), malformed & `?token=` rejection, public static shell, `/api/auth_mode`, 1 MiB body cap (413), invalid JSON (400), task field validation (dates/links/name/span), JSON-null field clearing, CSRF write-guard (cross-origin 403, non-JSON 415, same-origin & header-less allowed), project/section/group name validation, reorder payload validation |
| `test_security_raw_socket.py` (11 checks) | write-guard connection hygiene at the socket level: 403/415/400 rejections close the connection so an unread body cannot poison keep-alive; 5000-digit / non-numeric `Content-Length` → 400 with no traceback leaked; normal write and bodyless write regressions |
| `test_render_grouping.js` (13 assertions) | the display-grouping rule "a subtask nests under its parent only in the same section": extracts the real helper functions from `static/app.js` and checks timeline / list / board row sets against a seeded bug scenario (parent in To do + archived children). Seeds and deletes its own throwaway project via the API |

Run individually against any running instance:

```bash
python3 tests/test_security_api.py <port> <token> [cf_email]
python3 tests/test_security_raw_socket.py <port> <token>
node    tests/test_render_grouping.js <port> <token>
```

- `<token>` = contents of the instance's `data/auth_token.txt`.
- `test_security_api.py` expects the instance to have an Access allowlist configured
  (`MINI_ASANA_ACCESS_EMAIL` or `data/access_email.txt`) matching `[cf_email]`
  (default `owner@example.com`); the three CF-header checks fail otherwise.
- `test_render_grouping.js` reads `static/app.js` from the repo root by default;
  override with `APP_JS=/path/to/app.js` to test a different checkout.
