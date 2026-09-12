#!/usr/bin/env python3
"""mini-asana: a local single-machine mini Asana (multi-project version).

Uses only the Python standard library. Listens on 127.0.0.1:8787.

REST API (projects):
  GET    /api/projects              -> {"projects": [{"id","name","task_count"}, ...]}
  POST   /api/projects              create project {"name": str}
  GET    /api/projects/<pid>        project detail
  PATCH  /api/projects/<pid>        rename project {"name": str}
  DELETE /api/projects/<pid>        delete project (the last remaining project cannot be deleted)

REST API (tasks/sections within a project scope; <pid> is the project id):
  GET    /api/projects/<pid>/tasks            -> {"project","sections","tasks"}
  POST   /api/projects/<pid>/tasks            create task (JSON body)
  PUT    /api/projects/<pid>/tasks/<id>       update task fields (partial update)
  DELETE /api/projects/<pid>/tasks/<id>       delete task
  POST   /api/projects/<pid>/sections         add section {"name": str}
  PUT    /api/projects/<pid>/sections/<name>  rename section {"name": new_name}
  DELETE /api/projects/<pid>/sections/<name>  delete section (its tasks move to the first remaining section)
  POST   /api/projects/<pid>/groups           create smart group {"name": str, "rules": obj}
  PUT    /api/projects/<pid>/groups/<gid>     update smart group (partial: name?/rules?)
  DELETE /api/projects/<pid>/groups/<gid>     delete smart group
  POST   /api/projects/<pid>/archive_completed  move all completed tasks into the Archive section
                                              (created when missing); returns {"archived": n, "sections"}
  POST   /api/projects/<pid>/tasks/bulk_offset  {"task_ids": [...], "days": N} shift start_on/due_on of
                                              many tasks by N days in one atomic write (no start_on -> only
                                              due_on moves; no dependency cascade); returns {"updated","missing"}
  POST   /api/projects/<pid>/reorder          {"section": str, "ids": [task_id, ...]} reorder within a section

Legacy single-project paths (/api/tasks, /api/sections, /api/reorder, etc.)
are still supported and apply to the first (oldest) project in the index.

Data layout:
  data/projects.json        project index {"projects": [{"id","name"}, ...]}; array order = project order
  data/projects/<pid>.json  one file per project {"project","sections","tasks"} (atomic writes)
  On startup, if only a legacy data/tasks.json exists it is auto-migrated into the
  first project and the old file is renamed data/tasks.json.migrated; a fresh
  install auto-creates a default project.

Static files: / -> static/index.html, /static/* -> static/*, /login -> login page

Auth (Cloudflare Access first, token fallback; enabled by default):
  - PRIMARY: Cf-Access-Authenticated-User-Email header auth is OPT-IN. It only
    engages when an allowlist email is configured (MINI_ASANA_ACCESS_EMAIL env
    or data/access_email.txt), and then the header value must match it
    (case-insensitive). Without a configured allowlist the header is IGNORED
    entirely — a misdirected local request or a stripped/spoofed header never
    grants access. (Cloudflare Access injects the header after the edge login;
    the origin listens on 127.0.0.1 only and is reachable solely through the
    cloudflared tunnel, so a matched header is trustworthy.)
  - FALLBACK: "Authorization: Bearer <token>" with the 32-char hex token from
    data/auth_token.txt (mode 600; malformed files are regenerated at startup).
    Keeps local scripts/watchdog working and covers Access being turned off.
    URL query tokens (?token=) are NOT accepted: they leak via logs, history
    and referrers. The frontend migrates old ?token= bookmarks into localStorage
    once (validated through the Bearer flow), then strips the query.
  - The static shell (/, /app.js, /style.css, /login) is PUBLIC — it contains no
    data (the source is public anyway). /login remains as the fallback login page.
  - Client tokens must match ^[0-9a-f]{32}$ before comparison (keeps
    hmac.compare_digest safe from non-ASCII/garbage input).
  - Every response carries Referrer-Policy: no-referrer, X-Content-Type-Options:
    nosniff, X-Frame-Options: DENY, a minimal CSP (frame-ancestors/object-src/
    base-uri) and Cache-Control: no-store.
  - Request bodies are capped at 1 MiB, must be JSON objects; task fields are
    type-checked (string lengths, bool completed, YYYY-MM-DD dates, http/https
    links only, start->due spans <= 3700 days). JSON null clears a field.
  - Write requests to /api/* with a body must use Content-Type: application/json
    (415 otherwise; a bodyless write without a Content-Type stays allowed for
    existing no-body operations) and, whenever an Origin/Referer header is
    present, its host must match the request Host (403) — CSRF protection for
    the Access cookie. Rejections close the connection (the body was not read).
  - Connections carry a 30s socket timeout (slowloris guard); unexpected errors
    answer a JSON 500 and the traceback goes to the server log only.
  - GET /api/auth_mode is public and reports "none"/"token"/"cf-access" so the
    UI knows whether logout must end the Cloudflare Access session too.
  - For local dev, auth can be disabled with --no-auth or MINI_ASANA_NO_AUTH=1.
  - Port can be overridden with --port or MINI_ASANA_PORT (default 8787).
"""
import argparse
import datetime
import hmac
import json
import mimetypes
import os
import posixpath
import re
import secrets
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE, "data")
DATA_FILE = os.path.join(DATA_DIR, "tasks.json")  # legacy single-project data file, used only for startup migration
TOKEN_FILE = os.path.join(DATA_DIR, "auth_token.txt")
ACCESS_EMAIL_FILE = os.path.join(DATA_DIR, "access_email.txt")
PROJECTS_DIR = os.path.join(DATA_DIR, "projects")
INDEX_FILE = os.path.join(DATA_DIR, "projects.json")
STATIC_DIR = os.path.join(BASE, "static")
HOST = "127.0.0.1"
PORT = 8787

LOCK = threading.Lock()

AUTH_ENABLED = True
AUTH_TOKEN = None
ACCESS_EMAIL = None          # optional allowlist for the Cf-Access-Authenticated-User-Email value
_CF_ACCESS_SEEN = set()      # emails already logged this process (one line each)

TASK_FIELDS = {
    "name", "section", "assignee", "start_on", "due_on", "completed",
    "category", "effort", "priority", "dependencies", "notes", "link",
    "parent_id",
}

PID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
TOKEN_RE = re.compile(r"[0-9a-f]{32}")
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
MAX_BODY_BYTES = 1024 * 1024   # request-body cap: 1 MiB
MAX_TASK_SPAN_DAYS = 3700      # the calendar expands every day of a task's range — reject absurd spans
DEFAULT_SECTIONS = ["To do", "In progress"]

# task string-field length limits (notes get more room)
TASK_STR_LIMITS = {
    "name": 500, "section": 500, "assignee": 500, "category": 500, "effort": 500,
    "priority": 500, "link": 500, "parent_id": 500, "notes": 20000,
}

LOGIN_HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>登录 - mini-asana</title>
<style>
  body { margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #f9f8f8; font-family: -apple-system, "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif; }
  .card { background: #fff; border: 1px solid #e8e9eb; border-radius: 12px; padding: 36px 40px;
          width: 320px; box-shadow: 0 4px 16px rgba(0,0,0,0.06); text-align: center; }
  .logo { font-weight: 700; font-size: 18px; color: #e06a5a; margin-bottom: 8px; }
  .tip { color: #6d6e6f; font-size: 13px; margin: 0 0 20px; }
  input { width: 100%; box-sizing: border-box; padding: 9px 12px; font-size: 14px; margin-bottom: 12px;
          border: 1px solid #e8e9eb; border-radius: 6px; outline: none; }
  input:focus { border-color: #4573d2; }
  button { width: 100%; padding: 9px 0; font-size: 14px; color: #fff; background: #4573d2;
           border: none; border-radius: 6px; cursor: pointer; }
  button:hover { background: #3a63b8; }
  .err { color: #d45b4d; font-size: 12px; min-height: 16px; margin: 10px 0 0; }
</style>
</head>
<body>
  <div class="card">
    <div class="logo">◆ mini-asana</div>
    <p class="tip" id="tip">Home improvement tracker · 请输入访问 token</p>
    <form id="lf">
      <input type="password" id="tok" placeholder="访问 token" autocomplete="off" autofocus>
      <button type="submit" id="enter">进入</button>
    </form>
    <p class="err" id="err"></p>
  </div>
<script>
(function () {
  var KEY = "mini_asana_token";
  // auto-detect UI language (no server-side negotiation): zh* stays Chinese, others get English
  var EN = !/^zh/i.test(navigator.language || "");
  var S = EN ? {
    title: "Log in - mini-asana",
    tip: "Home improvement tracker · Enter access token",
    ph: "Access token",
    enter: "Enter",
    badToken: "Incorrect token, please try again",
    netErr: "Network error, please try again",
    srvErr: "Server error ",
    expired: "Saved token has expired, please enter again"
  } : {
    title: "登录 - mini-asana",
    tip: "Home improvement tracker · 请输入访问 token",
    ph: "访问 token",
    enter: "进入",
    badToken: "token 不正确，请重试",
    netErr: "网络错误，请重试",
    srvErr: "服务器错误 ",
    expired: "已保存的 token 已失效，请重新输入"
  };
  document.title = S.title;
  document.documentElement.lang = EN ? "en" : "zh-CN";
  document.getElementById("tip").textContent = S.tip;
  document.getElementById("tok").placeholder = S.ph;
  document.getElementById("enter").textContent = S.enter;
  // the token is already in localStorage by the time go() runs; / is a public static shell,
  // the app boots from the stored token via the Authorization: Bearer header (no query tokens)
  function go() { location.replace("/"); }
  function err(m) { document.getElementById("err").textContent = m; }
  function valid(t, ok, bad) {
    fetch("/api/tasks", { headers: { "Authorization": "Bearer " + t } })
      .then(function (r) { if (r.ok) ok(); else if (r.status === 401) bad(); else err(S.srvErr + r.status); })
      .catch(function () { err(S.netErr); });
  }
  // behind Cloudflare Access the API answers without any token: skip the form entirely
  fetch("/api/tasks").then(function (r) { if (r.ok) go(); }).catch(function () {});
  var saved = "";
  try { saved = localStorage.getItem(KEY) || ""; } catch (e) {}
  if (saved) {
    valid(saved, function () { go(saved); }, function () {
      try { localStorage.removeItem(KEY); } catch (e) {}
      err(S.expired);
    });
  }
  document.getElementById("lf").addEventListener("submit", function (e) {
    e.preventDefault();
    var t = document.getElementById("tok").value.trim();
    if (!t) return;
    valid(t, function () {
      try { localStorage.setItem(KEY, t); } catch (e) {}
      go(t);
    }, function () { err(S.badToken); });
  });
})();
</script>
</body>
</html>
"""


def load_access_email():
    """Allowlist for the Cf-Access-Authenticated-User-Email value:
    MINI_ASANA_ACCESS_EMAIL env var wins, then data/access_email.txt. Empty/unset =
    CF-header auth is DISABLED (the header is not trusted at all)."""
    email = (os.environ.get("MINI_ASANA_ACCESS_EMAIL") or "").strip()
    if not email and os.path.exists(ACCESS_EMAIL_FILE):
        with open(ACCESS_EMAIL_FILE, encoding="utf-8") as f:
            email = f.read().strip()
    return email or None


def load_or_create_token():
    """Read data/auth_token.txt; generate a 32-char hex token (mode 600) when the file is
    missing, and also when its content is malformed (a corrupt token file must not become
    the effective auth secret — regenerate instead)."""
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE, encoding="utf-8") as f:
            token = f.read().strip()
        if TOKEN_RE.fullmatch(token):
            return token
        print("[auth] data/auth_token.txt 内容格式非法（应为 32 位小写 hex），已重新生成 token")
    token = secrets.token_hex(16)  # 32 hex chars
    # O_TRUNC covers the malformed-file regeneration path (file already exists)
    fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(token + "\n")
    os.chmod(TOKEN_FILE, 0o600)
    print(f"[auth] 首次启动，已生成访问 token 写入 {TOKEN_FILE}（权限 600）")
    print("[auth] 公网访问请携带该 token；本地开发可用 --no-auth 或 MINI_ASANA_NO_AUTH=1 关闭认证")
    return token


# ---------- project data layout ----------

def valid_pid(pid):
    return bool(pid) and bool(PID_RE.fullmatch(pid))


def project_file(pid):
    return os.path.join(PROJECTS_DIR, pid + ".json")


def load_index():
    with open(INDEX_FILE, encoding="utf-8") as f:
        return json.load(f)


def save_index(idx):
    tmp = INDEX_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(idx, f, ensure_ascii=False, indent=1)
    os.replace(tmp, INDEX_FILE)


def new_project_id(idx):
    """Generate a short random id that collides with no existing project/file (urlsafe charset, satisfies valid_pid)."""
    ids = {p["id"] for p in idx["projects"]}
    while True:
        pid = secrets.token_urlsafe(6)  # 8 chars
        if valid_pid(pid) and pid not in ids and not os.path.exists(project_file(pid)):
            return pid


def default_project_id():
    """Id of the first (oldest) project in the index; None when there are no projects."""
    try:
        idx = load_index()
    except (OSError, ValueError):
        return None
    projects = idx.get("projects") or []
    return projects[0]["id"] if projects else None


def load_db(pid):
    with open(project_file(pid), encoding="utf-8") as f:
        db = json.load(f)
    db.setdefault("smart_groups", [])  # tolerate project files from before smart groups
    return db


def save_db(pid, db):
    path = project_file(pid)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def _write_new_project(pid, name):
    save_db(pid, {"project": name, "sections": list(DEFAULT_SECTIONS), "tasks": [], "smart_groups": []})


def ensure_data_layout():
    """Ensure the multi-project data layout is ready at startup:
    - data/projects/ with a valid index: use as-is
    - only legacy data/tasks.json: migrate into the first project, old file renamed tasks.json.migrated
    - fresh install: create the default project
    - projects/ exists but index missing/empty: rebuild the index from project files; add a default project if none
    """
    os.makedirs(DATA_DIR, exist_ok=True)

    if not os.path.isdir(PROJECTS_DIR):
        if os.path.exists(DATA_FILE):
            # migrate legacy single-project data
            with open(DATA_FILE, encoding="utf-8") as f:
                old = json.load(f)
            name = (old.get("project") or old.get("name") or "Default Project")
            name = str(name).strip() or "Default Project"
            idx = {"projects": []}
            pid = new_project_id(idx)
            os.makedirs(PROJECTS_DIR)
            save_db(pid, {
                "project": name,
                "sections": list(old.get("sections") or DEFAULT_SECTIONS),
                "tasks": list(old.get("tasks") or []),
            })
            idx["projects"].append({"id": pid, "name": name})
            save_index(idx)
            os.rename(DATA_FILE, DATA_FILE + ".migrated")
            print(f"[data] 已将旧版 data/tasks.json 迁移为项目「{name}」(id={pid})，"
                  f"原文件已改名 data/tasks.json.migrated")
            return
        # fresh install
        idx = {"projects": []}
        pid = new_project_id(idx)
        os.makedirs(PROJECTS_DIR)
        _write_new_project(pid, "Default Project")
        idx["projects"].append({"id": pid, "name": "Default Project"})
        save_index(idx)
        print(f"[data] 全新安装，已创建默认项目「Default Project」(id={pid})")
        return

    # projects/ exists: validate the index
    idx = None
    if os.path.exists(INDEX_FILE):
        try:
            idx = load_index()
        except (OSError, ValueError):
            idx = None
    if idx and idx.get("projects"):
        return

    # rebuild the index from project files
    projects = []
    for fn in sorted(os.listdir(PROJECTS_DIR)):
        pid = fn[:-5] if fn.endswith(".json") else None
        if not pid or not valid_pid(pid):
            continue
        name = pid
        try:
            with open(os.path.join(PROJECTS_DIR, fn), encoding="utf-8") as f:
                name = (json.load(f).get("project") or pid)
                name = str(name).strip() or pid
        except (OSError, ValueError):
            pass
        projects.append({"id": pid, "name": name})
    if not projects:
        pid = new_project_id({"projects": []})
        _write_new_project(pid, "Default Project")
        projects = [{"id": pid, "name": "Default Project"}]
        print(f"[data] projects/ 为空，已创建默认项目「Default Project」(id={pid})")
    save_index({"projects": projects})
    print(f"[data] 已重建 projects.json（{len(projects)} 个项目）")


def find_task(db, task_id):
    for t in db["tasks"]:
        if t["id"] == task_id:
            return t
    return None


def shift_date_str(s, days):
    """'YYYY-MM-DD' + N days -> 'YYYY-MM-DD' (None/empty passes through)."""
    if not s:
        return s
    return (datetime.date.fromisoformat(s) + datetime.timedelta(days=days)).isoformat()


def _valid_date_str(s):
    """Strict YYYY-MM-DD with a real calendar date."""
    if not DATE_RE.fullmatch(s):
        return False
    try:
        datetime.date.fromisoformat(s)
        return True
    except ValueError:
        return False


def valid_name(body, field="name", maxlen=200):
    """Shared payload guard for project/section/group names. Returns (name, None) or (None, error)."""
    v = body.get(field)
    if not isinstance(v, str):
        return None, f"field '{field}' must be a string"
    v = v.strip()
    if not v:
        return None, f"field '{field}' must not be empty"
    if len(v) > maxlen:
        return None, f"field '{field}' is too long (max {maxlen} chars)"
    return v, None


def validate_task_fields(body):
    """Strict per-field validation for task create/update bodies (unknown keys are ignored,
    same as the writers which filter by TASK_FIELDS). Returns an error message, or None.
    None (JSON null) is accepted for every field except name/completed and means
    "clear/empty" — the frontend sends null when clearing dates or un-parenting."""
    for k, v in body.items():
        if k not in TASK_FIELDS:
            continue
        if k in TASK_STR_LIMITS:
            if v is None and k != "name":
                continue  # null clears the field (normalized to "" by the writers)
            if not isinstance(v, str):
                return f"field '{k}' must be a string"
            if len(v) > TASK_STR_LIMITS[k]:
                return f"field '{k}' is too long (max {TASK_STR_LIMITS[k]} chars)"
        elif k == "completed":
            if not isinstance(v, bool):
                return "field 'completed' must be a boolean"
        elif k in ("start_on", "due_on"):
            if v is None:
                continue  # null clears the date
            if not isinstance(v, str):
                return f"field '{k}' must be a string"
            if v and not _valid_date_str(v):
                return f"field '{k}' must be '' or a valid YYYY-MM-DD date"
        elif k == "dependencies":
            if v is None:
                continue  # null clears the list
            if not isinstance(v, list) or not all(isinstance(d, str) for d in v):
                return "field 'dependencies' must be a list of strings"
    name = body.get("name")
    if name is not None and isinstance(name, str) and not name.strip():
        return "field 'name' must not be empty"
    link = body.get("link")
    if isinstance(link, str) and link and not link.startswith(("http://", "https://")):
        return "field 'link' must start with http:// or https://"
    return None


def task_span_error(start_on, due_on):
    """Reject absurd start->due spans (the calendar view expands every single day of a range)."""
    if start_on and due_on:
        span = abs((datetime.date.fromisoformat(due_on) - datetime.date.fromisoformat(start_on)).days)
        if span > MAX_TASK_SPAN_DAYS:
            return f"start_on -> due_on span exceeds {MAX_TASK_SPAN_DAYS} days"
    return None


class Handler(BaseHTTPRequestHandler):
    server_version = "mini-asana/1.0"
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.connection.settimeout(30)  # slowloris guard: idle/slow connections die after 30s

    # ---------- helpers ----------
    def send_response(self, code, message=None):
        # Authenticated single-user app served through a CDN/edge tunnel: NOTHING may
        # ever be edge- or browser-cached (a cached login page or stale app.js would
        # be served to everyone). Central override so every response — static files,
        # API JSON, the login page, and errors — carries no-store plus the security
        # headers (no script-src/style-src in the CSP on purpose: the login page is an
        # inline script and the app uses inline styles).
        super().send_response(code, message)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'none'")

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, status, msg):
        self._send_json({"error": msg}, status)

    def _read_body(self):
        """Read and validate the JSON request body.
        Returns (dict, None) on success, or (None, (status, message)) on failure:
        Content-Length missing counts as 0; a non-numeric/negative Content-Length is a 400;
        over 1 MiB is a 413 (the body is NOT read); undecodable JSON is a 400; a JSON top
        level that is not an object is a 400."""
        raw = self.headers.get("Content-Length")
        length = 0
        if raw is not None:
            if not re.fullmatch(r"\d+", raw.strip()):
                return None, (400, "invalid Content-Length")
            length = int(raw.strip(), 10)
            if length > MAX_BODY_BYTES:
                return None, (413, "request body too large (max 1 MiB)")
        if length == 0:
            return {}, None
        data = self.rfile.read(length)
        try:
            body = json.loads(data.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None, (400, "invalid JSON")
        if not isinstance(body, dict):
            return None, (400, "JSON body must be an object")
        return body, None

    def log_message(self, fmt, *args):  # quiet logging
        pass

    # ---------- auth ----------
    def _cf_access_email(self):
        """Email injected by Cloudflare Access after a successful edge login.
        Trustworthy because the origin listens on 127.0.0.1 and external traffic
        can only arrive through the cloudflared tunnel (which scrubs/overwrites
        client-supplied Cf-* headers at the edge)."""
        email = (self.headers.get("Cf-Access-Authenticated-User-Email") or "").strip()
        return email or None

    def _cf_authorized(self):
        """CF-header auth is OPT-IN: it only engages when an allowlist email is configured
        (MINI_ASANA_ACCESS_EMAIL or data/access_email.txt), and then the header value must
        match it (case-insensitive). Without a configured allowlist the header is ignored
        entirely — a misdirected local request or a stripped header never grants access."""
        email = self._cf_access_email()
        if not ACCESS_EMAIL or not email or email.lower() != ACCESS_EMAIL.lower():
            return False
        if email.lower() not in _CF_ACCESS_SEEN:
            _CF_ACCESS_SEEN.add(email.lower())
            print(f"[auth] Cloudflare Access 用户已放行: {email}", flush=True)
        return True

    def _client_token(self):
        """Extract the token from the Authorization: Bearer header ONLY.
        URL query tokens (?token=) were removed: they leak into server logs, browser
        history and referrers. Old bookmarks are migrated by the frontend instead."""
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            return auth[7:].strip()
        return None

    def _authorized(self):
        if not AUTH_ENABLED:
            return True
        # primary: Cloudflare Access header (opt-in via configured email allowlist)
        if self._cf_authorized():
            return True
        # fallback: Bearer token
        tok = self._client_token()
        # strict format gate BEFORE compare_digest: garbage/non-ASCII tokens would
        # otherwise raise TypeError inside hmac.compare_digest (traceback noise)
        if not tok or not AUTH_TOKEN or not TOKEN_RE.fullmatch(tok):
            return False
        return hmac.compare_digest(tok, AUTH_TOKEN)

    def _auth_mode(self):
        """GET /api/auth_mode — public, tells the UI where logout should land:
        'cf-access' (Access session must be ended at /cdn-cgi/access/logout),
        'token' (plain token flow), 'none' (auth disabled)."""
        if not AUTH_ENABLED:
            mode = "none"
        elif self._cf_authorized():
            mode = "cf-access"
        else:
            mode = "token"
        self._send_json({"mode": mode})

    def _reject_api(self):
        self.close_connection = True  # an unread request body must not poison keep-alive
        self._send_json({"error": "unauthorized"}, 401)

    # ---------- routing ----------
    def _route(self, method):
        """Unified API routing. Project entity -> project-scoped task routes -> legacy compat paths -> static files."""
        path = urlparse(self.path).path
        body = None
        if method in ("POST", "PUT", "PATCH"):
            body, err = self._read_body()
            if err is not None:
                status, msg = err
                # any body-level failure leaves bytes unread or state uncertain — drop the connection
                self.close_connection = True
                return self._send_error_json(status, msg)

        # project collection
        if path == "/api/projects":
            if method == "GET":
                return self._list_projects()
            if method == "POST":
                return self._create_project(body)
            return self._send_error_json(405, "method not allowed")

        # project entity
        m = re.fullmatch(r"/api/projects/([A-Za-z0-9_-]{1,64})", path)
        if m:
            pid = m.group(1)
            if method == "GET":
                return self._get_project(pid)
            if method == "PATCH":
                return self._rename_project(pid, body)
            if method == "DELETE":
                return self._delete_project(pid)
            return self._send_error_json(405, "method not allowed")

        # project-scoped tasks/sections/reorder/groups/archive_completed
        m = re.fullmatch(r"/api/projects/([A-Za-z0-9_-]{1,64})(/(?:tasks|sections|reorder|groups|archive_completed)(?:/.*)?)", path)
        if m:
            pid, sub = m.group(1), m.group(2)
            if not os.path.isfile(project_file(pid)):
                return self._send_error_json(404, "project not found")
            return self._tasks_route(method, pid, sub, body)

        # legacy single-project path compat: applies to the first (oldest) project in the index
        if re.fullmatch(r"/api/(?:tasks|sections|reorder)(?:/.*)?", path):
            pid = default_project_id()
            if pid is None:
                return self._send_error_json(404, "no project")
            return self._tasks_route(method, pid, path[len("/api"):], body)

        if path.startswith("/api/"):
            return self._send_error_json(404, "not found")
        if method == "GET":
            if path == "/login":
                return self._serve_login()
            return self._serve_static(path)
        self._send_error_json(404, "not found")

    def _tasks_route(self, method, pid, sub, body):
        """Project-scoped task/section/reorder routing.
        sub looks like /tasks, /tasks/<id>, /sections, /sections/<name>, /reorder."""
        if sub == "/tasks":
            if method == "GET":
                with LOCK:
                    self._send_json(load_db(pid))
                return
            if method == "POST":
                return self._create_task(pid, body)
        elif sub == "/sections" and method == "POST":
            return self._create_section(pid, body)
        elif sub == "/groups" and method == "POST":
            return self._create_group(pid, body)
        elif sub.startswith("/groups/") and method == "PUT":
            return self._update_group(pid, unquote(sub[len("/groups/"):]), body)
        elif sub.startswith("/groups/") and method == "DELETE":
            return self._delete_group(pid, unquote(sub[len("/groups/"):]))
        elif sub == "/reorder" and method == "POST":
            return self._reorder(pid, body)
        elif sub == "/tasks/bulk_offset" and method == "POST":
            return self._bulk_offset(pid, body)
        elif sub == "/archive_completed" and method == "POST":
            return self._archive_completed(pid)
        elif sub.startswith("/tasks/") and method == "PUT":
            return self._update_task(pid, unquote(sub[len("/tasks/"):]), body)
        elif sub.startswith("/tasks/") and method == "DELETE":
            return self._delete_task(pid, unquote(sub[len("/tasks/"):]))
        elif sub.startswith("/sections/") and method == "PUT":
            return self._rename_section(pid, unquote(sub[len("/sections/"):]), body)
        elif sub.startswith("/sections/") and method == "DELETE":
            return self._delete_section(pid, unquote(sub[len("/sections/"):]))
        self._send_error_json(404, "not found")

    def do_GET(self):
        # the static shell (/, /app.js, /style.css, /login) is public — it holds no data;
        # every /api/* request needs a valid Bearer token
        path = urlparse(self.path).path
        if path == "/api/auth_mode":  # public: tells the UI where logout should land
            return self._auth_mode()
        if path.startswith("/api/") and not self._authorized():
            return self._reject_api()
        self._safe_route("GET")

    def _write_guard(self):
        """Auth + CSRF gates for write requests. Returns True when routing may proceed.
        CSRF model with the CF Access cookie: cross-site form/fetch writes are blocked by
        requiring Content-Type: application/json (415) — plus, whenever Origin/Referer is
        present, its host must match the request Host (403). A bodyless write without a
        Content-Type stays allowed (existing no-body operations); header-less curl is
        unaffected. Every rejection closes the connection: it fires before the body is
        read, and leftover bytes must not poison keep-alive parsing."""
        if not self._authorized():
            self._reject_api()
            return False
        if not urlparse(self.path).path.startswith("/api/"):
            return True  # non-API writes 404 in routing; nothing to protect
        # validate the Content-Length TEXT before any int() — a garbage or absurdly long
        # digit string would raise ValueError outside _safe_route (Python 3.11+ caps
        # int() at 4300 digits)
        cl = (self.headers.get("Content-Length") or "").strip()
        if cl and not re.fullmatch(r"\d{1,10}", cl):
            self.close_connection = True
            return self._send_error_json(400, "invalid Content-Length") or False
        has_body = bool(cl and int(cl) > 0)
        ct = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ct != "application/json" and (ct or has_body):
            self.close_connection = True
            return self._send_error_json(415, "writes require Content-Type: application/json") or False
        host = (self.headers.get("Host") or "").lower()
        for h in ("Origin", "Referer"):
            v = self.headers.get(h)
            if v and urlparse(v).netloc.lower() != host:
                self.close_connection = True
                return self._send_error_json(403, "cross-origin write rejected") or False
        return True

    def _safe_route(self, method):
        """Route with a last-resort 500 JSON — an unexpected exception must never leak a
        traceback to the client (it goes to the server log instead)."""
        try:
            self._route(method)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass  # client vanished; nothing to answer
        except Exception:
            import traceback
            traceback.print_exc()
            try:
                self._send_error_json(500, "internal error")
            except Exception:
                pass

    def do_POST(self):
        if self._write_guard():
            self._safe_route("POST")

    def do_PUT(self):
        if self._write_guard():
            self._safe_route("PUT")

    def do_PATCH(self):
        if self._write_guard():
            self._safe_route("PATCH")

    def do_DELETE(self):
        if self._write_guard():
            self._safe_route("DELETE")

    def _serve_login(self):
        body = LOGIN_HTML.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---------- project ops ----------
    @staticmethod
    def _project_entry(idx, pid):
        for p in idx["projects"]:
            if p["id"] == pid:
                return p
        return None

    def _task_count(self, pid):
        try:
            with open(project_file(pid), encoding="utf-8") as f:
                return len(json.load(f).get("tasks") or [])
        except (OSError, ValueError):
            return 0

    def _list_projects(self):
        with LOCK:
            idx = load_index()
            out = [{"id": p["id"], "name": p["name"], "task_count": self._task_count(p["id"])}
                   for p in idx["projects"]]
        self._send_json({"projects": out})

    def _get_project(self, pid):
        with LOCK:
            idx = load_index()
            p = self._project_entry(idx, pid)
            if not p or not os.path.isfile(project_file(pid)):
                return self._send_error_json(404, "project not found")
            out = {"id": p["id"], "name": p["name"], "task_count": self._task_count(pid)}
        self._send_json(out)

    def _create_project(self, body):
        name, err = valid_name(body)
        if err:
            return self._send_error_json(400, err)
        with LOCK:
            idx = load_index()
            pid = new_project_id(idx)
            _write_new_project(pid, name)
            idx["projects"].append({"id": pid, "name": name})
            save_index(idx)
        self._send_json({"id": pid, "name": name, "task_count": 0}, 201)

    def _rename_project(self, pid, body):
        name, err = valid_name(body)
        if err:
            return self._send_error_json(400, err)
        with LOCK:
            idx = load_index()
            p = self._project_entry(idx, pid)
            if not p:
                return self._send_error_json(404, "project not found")
            p["name"] = name
            save_index(idx)
            try:
                db = load_db(pid)
                db["project"] = name
                save_db(pid, db)
            except OSError:
                pass
        self._send_json({"id": pid, "name": name})

    def _delete_project(self, pid):
        with LOCK:
            idx = load_index()
            p = self._project_entry(idx, pid)
            if not p:
                return self._send_error_json(404, "project not found")
            if len(idx["projects"]) <= 1:
                return self._send_error_json(400, "cannot delete last project")
            idx["projects"] = [x for x in idx["projects"] if x["id"] != pid]
            save_index(idx)
            try:
                os.remove(project_file(pid))
            except OSError:
                pass
        self._send_json({"ok": True})

    # ---------- task ops ----------
    @staticmethod
    def _validate_parent(db, parent_id, task_id=None):
        """one-level subtask rule; returns an error message, or None when valid"""
        if not parent_id:
            return None
        if task_id and parent_id == task_id:
            return "a task cannot be its own parent"
        parent = next((t for t in db["tasks"] if t["id"] == parent_id), None)
        if not parent:
            return "parent task not found in this project"
        if parent.get("parent_id"):
            return "only one level of subtasks is allowed: the parent must be top-level"
        if task_id and any(t.get("parent_id") == task_id for t in db["tasks"]):
            return "a task that has subtasks cannot become a subtask"
        return None

    def _create_task(self, pid, body):
        err = validate_task_fields(body)
        if err:
            return self._send_error_json(400, err)
        name = (body.get("name") or "").strip()
        if not name:
            return self._send_error_json(400, "name required")
        span_err = task_span_error(body.get("start_on") or None, body.get("due_on") or None)
        if span_err:
            return self._send_error_json(400, span_err)
        with LOCK:
            db = load_db(pid)
            parent_id = body.get("parent_id") or None
            err = self._validate_parent(db, parent_id)
            if err:
                return self._send_error_json(400, err)
            section = body.get("section") or (db["sections"][0] if db["sections"] else "To do")
            if section not in db["sections"]:
                db["sections"].append(section)
            order = max((t["order"] for t in db["tasks"] if t["section"] == section), default=-1) + 1
            task = {
                "id": uuid.uuid4().hex[:12],
                "name": name,
                "section": section,
                "assignee": body.get("assignee") or "",
                "start_on": body.get("start_on") or None,
                "due_on": body.get("due_on") or None,
                "completed": bool(body.get("completed", False)),
                "category": body.get("category") or "",
                "effort": body.get("effort") or "",
                "priority": body.get("priority") or "",
                "dependencies": list(body.get("dependencies") or []),
                "notes": body.get("notes") or "",
                "link": body.get("link") or "",
                "order": order,
            }
            if parent_id:
                task["parent_id"] = parent_id
            db["tasks"].append(task)
            save_db(pid, db)
        self._send_json(task, 201)

    def _update_task(self, pid, task_id, body):
        err = validate_task_fields(body)
        if err:
            return self._send_error_json(400, err)
        with LOCK:
            db = load_db(pid)
            task = find_task(db, task_id)
            if not task:
                return self._send_error_json(404, "task not found")
            body = dict(body)
            # span limit applies to the MERGED dates (patch values win over stored ones)
            span_err = task_span_error(body.get("start_on", task.get("start_on")) or None,
                                       body.get("due_on", task.get("due_on")) or None)
            if span_err:
                return self._send_error_json(400, span_err)
            if "parent_id" in body:
                new_parent = body.pop("parent_id") or None
                err = self._validate_parent(db, new_parent, task_id)
                if err:
                    return self._send_error_json(400, err)
                if new_parent:
                    task["parent_id"] = new_parent
                else:
                    task.pop("parent_id", None)
            old_section = task["section"]
            for k, v in body.items():
                if k not in TASK_FIELDS:
                    continue
                if k in ("start_on", "due_on"):
                    v = v or None
                if k in TASK_STR_LIMITS and v is None:
                    v = ""  # null clears string fields
                if k == "dependencies" and v is None:
                    v = []  # null clears the dependency list
                if k == "completed":
                    v = bool(v)
                if k == "section" and not v:
                    continue  # null/"" section = no change (never create an empty section)
                if k == "section" and v not in db["sections"]:
                    db["sections"].append(v)
                task[k] = v
            # subtasks follow their parent's section (one level deep)
            if task["section"] != old_section:
                for t in db["tasks"]:
                    if t.get("parent_id") == task_id:
                        t["section"] = task["section"]
            save_db(pid, db)
        self._send_json(task)

    def _delete_task(self, pid, task_id):
        with LOCK:
            db = load_db(pid)
            task = find_task(db, task_id)
            if not task:
                return self._send_error_json(404, "task not found")
            db["tasks"] = [t for t in db["tasks"] if t["id"] != task_id]
            for t in db["tasks"]:  # clean up dependency references
                if task_id in t.get("dependencies", []):
                    t["dependencies"] = [d for d in t["dependencies"] if d != task_id]
                if t.get("parent_id") == task_id:  # deleted parent's subtasks become top-level
                    t.pop("parent_id", None)
            save_db(pid, db)
        self._send_json({"ok": True})

    # ---------- bulk ops ----------
    def _bulk_offset(self, pid, body):
        """Shift start_on/due_on of many tasks by the same number of days in ONE atomic write
        (timeline marquee/multi-select batch move). Tasks without start_on keep it empty (only due_on
        moves); dependencies are not cascaded — exactly like the single-bar drag."""
        ids = body.get("task_ids")
        days = body.get("days")
        if not isinstance(ids, list) or not ids or not all(isinstance(i, str) for i in ids):
            return self._send_error_json(400, "task_ids must be a non-empty list")
        if isinstance(days, bool) or not isinstance(days, int) or days == 0:
            return self._send_error_json(400, "days must be a non-zero integer")
        with LOCK:
            db = load_db(pid)
            idset = set(ids)
            updated = []
            for t in db["tasks"]:
                if t["id"] not in idset:
                    continue
                if t.get("start_on"):
                    t["start_on"] = shift_date_str(t["start_on"], days)
                if t.get("due_on"):
                    t["due_on"] = shift_date_str(t["due_on"], days)
                updated.append(t)
            save_db(pid, db)
        missing = sorted(idset - {t["id"] for t in updated})
        self._send_json({"updated": updated, "missing": missing, "days": days})

    # ---------- archive ops ----------
    def _archive_completed(self, pid):
        """Move every completed task not already in "Archive" into the Archive section (created at the
        end when missing). Idempotent: repeated calls archive 0 additional tasks. Incomplete tasks untouched."""
        with LOCK:
            db = load_db(pid)
            if "Archive" not in db["sections"]:
                db["sections"].append("Archive")
            order = max((t["order"] for t in db["tasks"] if t["section"] == "Archive"), default=-1) + 1
            n = 0
            for t in db["tasks"]:
                if t.get("completed") and t.get("section") != "Archive":
                    t["section"] = "Archive"
                    t["order"] = order
                    order += 1
                    n += 1
            save_db(pid, db)
        self._send_json({"archived": n, "sections": db["sections"]})

    # ---------- smart group ops (saved cross-section filter views; tasks are never modified) ----------
    @staticmethod
    def _validate_group_rules(rules):
        return isinstance(rules, dict)

    def _create_group(self, pid, body):
        name, err = valid_name(body)
        if err:
            return self._send_error_json(400, err)
        rules = body.get("rules") or {}
        if not self._validate_group_rules(rules):
            return self._send_error_json(400, "rules must be an object")
        with LOCK:
            db = load_db(pid)
            group = {"id": secrets.token_urlsafe(6), "name": name, "rules": rules}
            db["smart_groups"].append(group)
            save_db(pid, db)
        self._send_json(group, 201)

    def _update_group(self, pid, gid, body):
        with LOCK:
            db = load_db(pid)
            group = next((g for g in db["smart_groups"] if g["id"] == gid), None)
            if not group:
                return self._send_error_json(404, "group not found")
            if "name" in body:
                name, err = valid_name(body)
                if err:
                    return self._send_error_json(400, err)
                group["name"] = name
            if "rules" in body:
                if not self._validate_group_rules(body["rules"]):
                    return self._send_error_json(400, "rules must be an object")
                group["rules"] = body["rules"]
            save_db(pid, db)
        self._send_json(group)

    def _delete_group(self, pid, gid):
        with LOCK:
            db = load_db(pid)
            before = len(db["smart_groups"])
            db["smart_groups"] = [g for g in db["smart_groups"] if g["id"] != gid]
            if len(db["smart_groups"]) == before:
                return self._send_error_json(404, "group not found")
            save_db(pid, db)
        self._send_json({"ok": True})

    def _create_section(self, pid, body):
        name, err = valid_name(body)
        if err:
            return self._send_error_json(400, err)
        with LOCK:
            db = load_db(pid)
            if name in db["sections"]:
                return self._send_error_json(409, "section exists")
            db["sections"].append(name)
            save_db(pid, db)
        self._send_json({"sections": db["sections"]}, 201)

    def _rename_section(self, pid, old, body):
        new, err = valid_name(body)
        if err:
            return self._send_error_json(400, err)
        with LOCK:
            db = load_db(pid)
            if old not in db["sections"]:
                return self._send_error_json(404, "section not found")
            if new != old and new in db["sections"]:
                return self._send_error_json(409, "section exists")
            db["sections"] = [new if s == old else s for s in db["sections"]]
            for t in db["tasks"]:
                if t["section"] == old:
                    t["section"] = new
            save_db(pid, db)
        self._send_json({"sections": db["sections"]})

    def _delete_section(self, pid, name):
        with LOCK:
            db = load_db(pid)
            if name not in db["sections"]:
                return self._send_error_json(404, "section not found")
            if len(db["sections"]) <= 1:
                return self._send_error_json(400, "cannot delete last section")
            db["sections"] = [s for s in db["sections"] if s != name]
            fallback = db["sections"][0]
            for t in db["tasks"]:
                if t["section"] == name:
                    t["section"] = fallback
            save_db(pid, db)
        self._send_json({"sections": db["sections"], "moved_to": fallback})

    def _reorder(self, pid, body):
        section = body.get("section")
        ids = body.get("ids")
        if not (isinstance(section, str) and section.strip()):
            return self._send_error_json(400, "section must be a non-empty string")
        if not (isinstance(ids, list) and all(isinstance(i, str) for i in ids)):
            return self._send_error_json(400, "ids must be a list of strings")
        section = section.strip()
        with LOCK:
            db = load_db(pid)
            in_section = [t for t in db["tasks"] if t["section"] == section]
            by_id = {t["id"]: t for t in in_section}
            order = 0
            for tid in ids:
                t = by_id.pop(tid, None)
                if t:
                    t["order"] = order
                    order += 1
            for t in sorted(by_id.values(), key=lambda x: x["order"]):
                t["order"] = order
                order += 1
            save_db(pid, db)
        self._send_json({"ok": True})

    # ---------- static ----------
    @staticmethod
    def _asset_version(name):
        """mtime-based cache-buster for static assets (0 when the file is missing)"""
        try:
            return int(os.path.getmtime(os.path.join(STATIC_DIR, name)))
        except OSError:
            return 0

    def _serve_static(self, path):
        if path == "/":
            path = "/index.html"
        # prevent directory traversal
        clean = posixpath.normpath(unquote(path)).lstrip("/")
        full = os.path.join(STATIC_DIR, clean)
        if not os.path.abspath(full).startswith(os.path.abspath(STATIC_DIR)) or not os.path.isfile(full):
            self.send_response(404)
            self.send_header("Content-Length", "9")
            self.end_headers()
            self.wfile.write(b"not found")
            return
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as f:
            data = f.read()
        # append each asset's mtime as a ?v= cache-buster so deploys bypass stale caches
        # (no token in URLs — static files are public and auth lives in the Bearer header)
        if clean == "index.html":
            for name, ref in (("app.js", "src"), ("style.css", "href")):
                data = data.replace(f'{ref}="/{name}"'.encode("utf-8"),
                                    f'{ref}="/{name}?v={self._asset_version(name)}"'.encode("utf-8"))
        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/") or ctype == "application/javascript" else ""))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    global AUTH_ENABLED, AUTH_TOKEN, ACCESS_EMAIL
    ap = argparse.ArgumentParser(description="mini-asana 本地单机版简易 Asana")
    ap.add_argument("--no-auth", action="store_true",
                    help="关闭 token 认证（本地开发用；也可用环境变量 MINI_ASANA_NO_AUTH=1）")
    ap.add_argument("--port", type=int, default=int(os.environ.get("MINI_ASANA_PORT", PORT)),
                    help="监听端口（默认 8787，也可用环境变量 MINI_ASANA_PORT）")
    args = ap.parse_args()

    # multi-project data layout: auto-migrate legacy data/tasks.json or create the default project when needed
    ensure_data_layout()

    if args.no_auth or os.environ.get("MINI_ASANA_NO_AUTH") == "1":
        AUTH_ENABLED = False
        print("[auth] token 认证已关闭（--no-auth / MINI_ASANA_NO_AUTH=1）")
    else:
        AUTH_TOKEN = load_or_create_token()
        print("[auth] token 认证已启用，token 见 data/auth_token.txt")
        ACCESS_EMAIL = load_access_email()
        if ACCESS_EMAIL:
            print(f"[auth] Cloudflare Access 头认证已启用，邮箱白名单: {ACCESS_EMAIL}")
        else:
            print("[auth] Cloudflare Access 头认证未启用（未配置邮箱白名单，Cf-* 头将被忽略；"
                  "可用 MINI_ASANA_ACCESS_EMAIL 或 data/access_email.txt 开启）")

    httpd = ThreadingHTTPServer((HOST, args.port), Handler)
    print(f"mini-asana running at http://{HOST}:{args.port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
