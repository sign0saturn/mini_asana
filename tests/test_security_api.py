#!/usr/bin/env python3
"""mini-asana API security regression suite (40 checks).

Covers: auth (Bearer, CF Access header opt-in, malformed/query-token rejection),
public surface, /api/auth_mode, body limits (413/invalid JSON), task field
validation, JSON-null field clearing, CSRF write-guard (403/415), payload
validation for projects/sections/groups/reorder.

Usage:
    python3 test_security_api.py <port> <token> [cf_email]

    port      port of a RUNNING mini-asana instance (auth enabled)
    token     contents of that instance's data/auth_token.txt
    cf_email  the allowlisted Access email the instance was started with
              (MINI_ASANA_ACCESS_EMAIL / data/access_email.txt);
              default owner@example.com — must match the instance config,
              the CF-header checks fail otherwise

Easiest: tests/run_local.sh spins up a throwaway instance and runs everything.
"""
import json
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

PORT = sys.argv[1] if len(sys.argv) > 1 else "8787"
TOKEN = sys.argv[2] if len(sys.argv) > 2 else ""
BASE = f"http://127.0.0.1:{PORT}"
CF_EMAIL = sys.argv[3] if len(sys.argv) > 3 else "owner@example.com"
fails = []


def req(method, path, body=None, headers=None, raw_ct=True):
    h = dict(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        if raw_ct:
            h.setdefault("Content-Type", "application/json")
    if TOKEN:
        h.setdefault("Authorization", f"Bearer {TOKEN}")
    r = urllib.request.Request(f"{BASE}{path}", data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {}


def check(name, got, want):
    ok = got == want
    if not ok:
        fails.append(name)
    print(f"{'PASS' if ok else 'FAIL'}  {name}: got {got}, want {want}")


def check_true(name, cond, detail=""):
    if not cond:
        fails.append(name)
    print(f"{'PASS' if cond else 'FAIL'}  {name} {detail}")


TOK = {"Authorization": f"Bearer {TOKEN}"}

# ---- baseline auth ----
s, _ = req("GET", "/api/tasks", headers={"Authorization": ""})
check("no-auth GET /api/tasks -> 401", s, 401)
s, _ = req("GET", "/api/tasks")
check("Bearer GET /api/tasks -> 200", s, 200)
s, _ = req("GET", "/api/tasks", headers={"Authorization": "Bearer zz"})
check("malformed token -> 401", s, 401)
s, _ = req("GET", f"/api/tasks?token={TOKEN}", headers={"Authorization": ""})
check("query token NOT accepted -> 401", s, 401)
r = urllib.request.urlopen(f"{BASE}/")
check("GET / public -> 200", r.status, 200)
s, m = req("GET", "/api/auth_mode", headers={"Authorization": ""})
check("auth_mode public -> 200", s, 200)
check("auth_mode(token ctx) == token", m.get("mode"), "token")
s, m = req("GET", "/api/auth_mode", headers={"Authorization": "", "Cf-Access-Authenticated-User-Email": CF_EMAIL})
check("auth_mode(CF ctx) == cf-access", m.get("mode"), "cf-access")

# ---- CF header opt-in ----
s, _ = req("GET", "/api/tasks", headers={"Authorization": "", "Cf-Access-Authenticated-User-Email": CF_EMAIL})
check("CF email matches allowlist -> 200", s, 200)
s, _ = req("GET", "/api/tasks", headers={"Authorization": "", "Cf-Access-Authenticated-User-Email": CF_EMAIL.upper()})
check("CF email case-insensitive -> 200", s, 200)
s, _ = req("GET", "/api/tasks", headers={"Authorization": "", "Cf-Access-Authenticated-User-Email": "stranger@example.com"})
check("CF email not in allowlist -> 401", s, 401)

# ---- body limits / JSON shape ----
# 413: the server replies without reading the body, then closes the connection — urllib sees a
# reset mid-send, so use curl (which tolerates early responses) and check the status line
with tempfile.NamedTemporaryFile(suffix=".bin") as big:
    big.write(b"x" * (1024 * 1024 + 1))
    big.flush()
    out = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST",
                          f"{BASE}/api/projects/x/tasks",
                          "-H", f"Authorization: Bearer {TOKEN}", "-H", "Content-Type: application/json",
                          "--data-binary", f"@{big.name}"], capture_output=True, text=True).stdout.strip()
check("body > 1 MiB -> 413", out, "413")
r = urllib.request.Request(f"{BASE}/api/projects/x/tasks", data=b"not json!", method="POST",
                           headers={**TOK, "Content-Type": "application/json"})
try:
    urllib.request.urlopen(r)
    s = 0
except urllib.error.HTTPError as e:
    s = e.code
check("invalid JSON -> 400", s, 400)

# ---- task field validation ----
s, m = req("GET", "/api/projects")
pid = m["projects"][0]["id"]


def post_task(b, hdr=None):
    return req("POST", f"/api/projects/{pid}/tasks", body=b, headers=hdr)


s, m = post_task({"name": "bad date", "due_on": "2026-13-99"})
check("bad date -> 400", s, 400)
s, m = post_task({"name": "bad link", "link": "javascript:alert(1)"})
check("javascript: link -> 400", s, 400)
s, m = post_task({"name": "   "})
check("blank name -> 400", s, 400)
s, m = post_task({"name": "span", "start_on": "2020-01-01", "due_on": "2040-01-01"})
check("span > 3700d -> 400", s, 400)

# ---- JSON null clears a field ----
s, t = post_task({"name": "null-test", "start_on": "2026-01-01", "due_on": "2026-01-05",
                  "notes": "n", "dependencies": ["x"]})
check("create null-test -> 201", s, 201)
tid = t.get("id")
s, t2 = req("PUT", f"/api/projects/{pid}/tasks/{tid}", body={"start_on": None, "due_on": None})
check("null clears dates -> 200", s, 200)
check_true("dates are null after clear", t2.get("start_on") is None and t2.get("due_on") is None)
s, t3 = req("PUT", f"/api/projects/{pid}/tasks/{tid}", body={"parent_id": None})
check("null parent_id -> 200", s, 200)
s, t4 = req("PUT", f"/api/projects/{pid}/tasks/{tid}", body={"section": None})
check("null section -> 200", s, 200)
check_true("section unchanged after null", t4.get("section") == t.get("section"), t4.get("section"))
s, t5 = req("PUT", f"/api/projects/{pid}/tasks/{tid}", body={"notes": None, "dependencies": None})
check("null notes/deps -> 200", s, 200)
check_true("notes=='' deps==[]", t5.get("notes") == "" and t5.get("dependencies") == [])
s, _ = req("DELETE", f"/api/projects/{pid}/tasks/{tid}")
check("cleanup delete -> 200", s, 200)
s, m = req("GET", f"/api/projects/{pid}/tasks")
check_true("no empty section created", "" not in m.get("sections", []), str(m.get("sections")))

# ---- CSRF write guard ----
s, _ = post_task({"name": "csrf-test"}, hdr={"Origin": "https://evil.example.com"})
check("cross-origin Origin -> 403", s, 403)
s, _ = post_task({"name": "csrf-test"}, hdr={"Referer": "https://evil.example.com/page"})
check("cross-origin Referer -> 403", s, 403)
r = urllib.request.Request(f"{BASE}/api/projects/{pid}/tasks", data=b"name=x", method="POST",
                           headers={**TOK, "Content-Type": "text/plain"})
try:
    urllib.request.urlopen(r)
    s = 0
except urllib.error.HTTPError as e:
    s = e.code
check("text/plain write -> 415", s, 415)
s, t = post_task({"name": "csrf-ok"}, hdr={"Origin": f"http://127.0.0.1:{PORT}"})
check("same-origin Origin -> 201", s, 201)
s, _ = req("DELETE", f"/api/projects/{pid}/tasks/{t['id']}")
check("same-origin delete -> 200", s, 200)
s, t = post_task({"name": "curl-ok"})  # no Origin/Referer at all
check("headerless curl write -> 201", s, 201)
req("DELETE", f"/api/projects/{pid}/tasks/{t['id']}")

# ---- name/reorder payload validation ----
s, m = req("POST", "/api/projects", body={"name": ["array"]})
check("project name array -> 400", s, 400)
s, m = req("GET", "/api/projects")
check("server alive after 400", s, 200)
s, m = req("POST", f"/api/projects/{pid}/sections", body={"name": None})
check("section name null -> 400", s, 400)
s, m = req("POST", f"/api/projects/{pid}/groups", body={"name": {"x": 1}})
check("group name object -> 400", s, 400)
s, m = req("POST", f"/api/projects/{pid}/reorder", body={"section": "To do", "ids": "abc"})
check("reorder ids not list -> 400", s, 400)
s, m = req("POST", f"/api/projects/{pid}/reorder", body={"section": "", "ids": []})
check("reorder empty section -> 400", s, 400)
s, m = req("POST", f"/api/projects/{pid}/reorder", body={"section": "To do", "ids": ["nope"]})
check("reorder valid payload -> 200", s, 200)

print()
if fails:
    print(f"{len(fails)} FAILED: {fails}")
    sys.exit(1)
print("ALL PASS")
