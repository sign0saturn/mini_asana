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
  POST   /api/projects/<pid>/reorder          {"section": str, "ids": [task_id, ...]} reorder within a section

Legacy single-project paths (/api/tasks, /api/sections, /api/reorder, etc.)
are still supported and apply to the first (oldest) project in the index.

Data layout:
  data/projects.json        project index {"projects": [{"id","name"}, ...]}; array order = project order
  data/projects/<pid>.json  one file per project {"project","sections","tasks"} (atomic writes)
  On startup, if only a legacy data/tasks.json exists it is auto-migrated into the
  first project and the old file is renamed data/tasks.json.migrated; a fresh
  install auto-creates a default project.

Static files: / -> static/index.html, /static/* -> static/*

Auth (simple token auth for public exposure, enabled by default):
  - On first start, a 32-char hex token is generated into data/auth_token.txt
    (mode 600); existing files are read as-is.
  - All requests except the login page (including /, /app.js, /style.css, /api/*)
    require a valid token, accepted two ways: "Authorization: Bearer <token>"
    header or ?token=<token> query param.
  - API requests without a token get 401 {"error":"unauthorized"}; page requests
    get the login page HTML.
  - For local dev, auth can be disabled with --no-auth or MINI_ASANA_NO_AUTH=1.
  - Port can be overridden with --port or MINI_ASANA_PORT (default 8787).
"""
import argparse
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
from urllib.parse import parse_qs, unquote, urlparse

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE, "data")
DATA_FILE = os.path.join(DATA_DIR, "tasks.json")  # legacy single-project data file, used only for startup migration
TOKEN_FILE = os.path.join(DATA_DIR, "auth_token.txt")
PROJECTS_DIR = os.path.join(DATA_DIR, "projects")
INDEX_FILE = os.path.join(DATA_DIR, "projects.json")
STATIC_DIR = os.path.join(BASE, "static")
HOST = "127.0.0.1"
PORT = 8787

LOCK = threading.Lock()

AUTH_ENABLED = True
AUTH_TOKEN = None

TASK_FIELDS = {
    "name", "section", "assignee", "start_on", "due_on", "completed",
    "category", "effort", "priority", "dependencies", "notes", "link",
    "parent_id",
}

PID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
DEFAULT_SECTIONS = ["To do", "In progress"]

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
  function go(t) { location.replace("/?token=" + encodeURIComponent(t)); }
  function err(m) { document.getElementById("err").textContent = m; }
  function valid(t, ok, bad) {
    fetch("/api/tasks", { headers: { "Authorization": "Bearer " + t } })
      .then(function (r) { if (r.ok) ok(); else if (r.status === 401) bad(); else err(S.srvErr + r.status); })
      .catch(function () { err(S.netErr); });
  }
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


def load_or_create_token():
    """Read data/auth_token.txt; generate a 32-char hex token (mode 600) if missing."""
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE, encoding="utf-8") as f:
            return f.read().strip()
    token = secrets.token_hex(16)  # 32 hex chars
    fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
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


class Handler(BaseHTTPRequestHandler):
    server_version = "mini-asana/1.0"
    protocol_version = "HTTP/1.1"

    # ---------- helpers ----------
    def send_response(self, code, message=None):
        # Authenticated single-user app served through a CDN/edge tunnel: NOTHING may
        # ever be edge- or browser-cached (a cached login page or stale app.js would
        # be served to everyone). Central override so every response — static files,
        # API JSON, the login page, and errors — carries no-store.
        super().send_response(code, message)
        self.send_header("Cache-Control", "no-store")

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
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None

    def log_message(self, fmt, *args):  # quiet logging
        pass

    # ---------- auth ----------
    def _client_token(self):
        """Extract the token from the Authorization: Bearer header or the ?token= query param."""
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            return auth[7:].strip()
        qs = parse_qs(urlparse(self.path).query)
        vals = qs.get("token")
        return vals[0].strip() if vals else None

    def _authorized(self):
        if not AUTH_ENABLED:
            return True
        tok = self._client_token()
        return bool(tok) and bool(AUTH_TOKEN) and hmac.compare_digest(tok, AUTH_TOKEN)

    def _reject(self):
        """API requests get 401 JSON; page requests get the login page HTML."""
        if urlparse(self.path).path.startswith("/api/"):
            self._send_json({"error": "unauthorized"}, 401)
        else:
            body = LOGIN_HTML.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    # ---------- routing ----------
    def _route(self, method):
        """Unified API routing. Project entity -> project-scoped task routes -> legacy compat paths -> static files."""
        path = urlparse(self.path).path
        body = None
        if method in ("POST", "PUT", "PATCH"):
            body = self._read_body()
            if body is None:
                return self._send_error_json(400, "invalid JSON")

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
        if not self._authorized():
            return self._reject()
        self._route("GET")

    def do_POST(self):
        if not self._authorized():
            return self._reject()
        self._route("POST")

    def do_PUT(self):
        if not self._authorized():
            return self._reject()
        self._route("PUT")

    def do_PATCH(self):
        if not self._authorized():
            return self._reject()
        self._route("PATCH")

    def do_DELETE(self):
        if not self._authorized():
            return self._reject()
        self._route("DELETE")

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
        name = (body.get("name") or "").strip()
        if not name:
            return self._send_error_json(400, "name required")
        if len(name) > 200:
            return self._send_error_json(400, "name too long")
        with LOCK:
            idx = load_index()
            pid = new_project_id(idx)
            _write_new_project(pid, name)
            idx["projects"].append({"id": pid, "name": name})
            save_index(idx)
        self._send_json({"id": pid, "name": name, "task_count": 0}, 201)

    def _rename_project(self, pid, body):
        name = (body.get("name") or "").strip()
        if not name:
            return self._send_error_json(400, "name required")
        if len(name) > 200:
            return self._send_error_json(400, "name too long")
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
        name = (body.get("name") or "").strip()
        if not name:
            return self._send_error_json(400, "name required")
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
        with LOCK:
            db = load_db(pid)
            task = find_task(db, task_id)
            if not task:
                return self._send_error_json(404, "task not found")
            body = dict(body)
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
                if k == "completed":
                    v = bool(v)
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

    # ---------- section ops ----------
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
        name = (body.get("name") or "").strip()
        if not name:
            return self._send_error_json(400, "name required")
        if len(name) > 200:
            return self._send_error_json(400, "name too long")
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
                name = (body.get("name") or "").strip()
                if not name:
                    return self._send_error_json(400, "name required")
                if len(name) > 200:
                    return self._send_error_json(400, "name too long")
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
        name = (body.get("name") or "").strip()
        if not name:
            return self._send_error_json(400, "name required")
        with LOCK:
            db = load_db(pid)
            if name in db["sections"]:
                return self._send_error_json(409, "section exists")
            db["sections"].append(name)
            save_db(pid, db)
        self._send_json({"sections": db["sections"]}, 201)

    def _rename_section(self, pid, old, body):
        new = (body.get("name") or "").strip()
        if not new:
            return self._send_error_json(400, "name required")
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
        ids = body.get("ids") or []
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
        # when index.html is served after ?token= auth, append the token to static
        # asset links too, so browser navigation requests (which cannot carry the
        # Authorization header) also pass validation
        if AUTH_ENABLED and clean == "index.html":
            qs = parse_qs(urlparse(self.path).query)
            qt = (qs.get("token") or [None])[0]
            if qt and AUTH_TOKEN and hmac.compare_digest(qt.strip(), AUTH_TOKEN):
                tok = qt.strip()
                # append each asset's mtime as &v= cache-buster so deploys bypass stale caches
                for name, ref in (("app.js", "src"), ("style.css", "href")):
                    suffix = f'?token={tok}&v={self._asset_version(name)}'
                    data = data.replace(f'{ref}="/{name}"'.encode("utf-8"),
                                        f'{ref}="/{name}{suffix}"'.encode("utf-8"))
        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/") or ctype == "application/javascript" else ""))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    global AUTH_ENABLED, AUTH_TOKEN
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

    httpd = ThreadingHTTPServer((HOST, args.port), Handler)
    print(f"mini-asana running at http://{HOST}:{args.port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
