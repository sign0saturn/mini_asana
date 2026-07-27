#!/usr/bin/env python3
"""mini-asana: 本地单机版简易 Asana（多项目版）。

仅使用 Python 标准库。监听 127.0.0.1:8787。

REST API（项目）:
  GET    /api/projects              -> {"projects": [{"id","name","task_count"}, ...]}
  POST   /api/projects              新建项目 {"name": str}
  GET    /api/projects/<pid>        项目详情
  PATCH  /api/projects/<pid>        重命名项目 {"name": str}
  DELETE /api/projects/<pid>        删除项目（最后一个项目不可删）

REST API（项目作用域内的任务/分组；<pid> 为项目 id）:
  GET    /api/projects/<pid>/tasks            -> {"project","sections","tasks"}
  POST   /api/projects/<pid>/tasks            创建任务 (JSON body)
  PUT    /api/projects/<pid>/tasks/<id>       更新任务字段 (部分更新)
  DELETE /api/projects/<pid>/tasks/<id>       删除任务
  POST   /api/projects/<pid>/sections         新增 section {"name": str}
  PUT    /api/projects/<pid>/sections/<name>  重命名 section {"name": new_name}
  DELETE /api/projects/<pid>/sections/<name>  删除 section (其任务移到第一个剩余 section)
  POST   /api/projects/<pid>/reorder          {"section": str, "ids": [task_id, ...]} 重排 section 内顺序

兼容旧版单项目路径（/api/tasks、/api/sections、/api/reorder 等），
自动作用于 index 中的第一个项目（最老项目）。

数据布局:
  data/projects.json        项目索引 {"projects": [{"id","name"}, ...]}，数组顺序即项目顺序
  data/projects/<pid>.json  每个项目一个文件 {"project","sections","tasks"}（原子写入）
  启动时若只有旧版 data/tasks.json，会自动迁移为第一个项目，
  旧文件改名 data/tasks.json.migrated；全新安装则自动创建默认项目。

静态文件: / -> static/index.html, /static/* -> static/*

认证（为公网部署准备的简单 token 认证，默认开启）:
  - 首次启动自动生成 32 位十六进制 token 写入 data/auth_token.txt（权限 600），
    已存在则直接读取。
  - 除登录页外所有请求（含 /、/app.js、/style.css、/api/*）都需有效 token，
    接受两种方式: "Authorization: Bearer <token>" 请求头 或 ?token=<token> query 参数。
  - API 请求无 token 返回 401 {"error":"unauthorized"}；页面请求返回登录页 HTML。
  - 本地开发可用 --no-auth 参数或环境变量 MINI_ASANA_NO_AUTH=1 关闭认证。
  - 端口可用 --port 或环境变量 MINI_ASANA_PORT 覆盖（默认 8787）。
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
DATA_FILE = os.path.join(DATA_DIR, "tasks.json")  # 旧版单项目数据文件，仅用于启动时迁移
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
    <p class="tip">Home improvement tracker · 请输入访问 token</p>
    <form id="lf">
      <input type="password" id="tok" placeholder="访问 token" autocomplete="off" autofocus>
      <button type="submit">进入</button>
    </form>
    <p class="err" id="err"></p>
  </div>
<script>
(function () {
  var KEY = "mini_asana_token";
  function go(t) { location.replace("/?token=" + encodeURIComponent(t)); }
  function err(m) { document.getElementById("err").textContent = m; }
  function valid(t, ok, bad) {
    fetch("/api/tasks", { headers: { "Authorization": "Bearer " + t } })
      .then(function (r) { if (r.ok) ok(); else if (r.status === 401) bad(); else err("服务器错误 " + r.status); })
      .catch(function () { err("网络错误，请重试"); });
  }
  var saved = "";
  try { saved = localStorage.getItem(KEY) || ""; } catch (e) {}
  if (saved) {
    valid(saved, function () { go(saved); }, function () {
      try { localStorage.removeItem(KEY); } catch (e) {}
      err("已保存的 token 已失效，请重新输入");
    });
  }
  document.getElementById("lf").addEventListener("submit", function (e) {
    e.preventDefault();
    var t = document.getElementById("tok").value.trim();
    if (!t) return;
    valid(t, function () {
      try { localStorage.setItem(KEY, t); } catch (e) {}
      go(t);
    }, function () { err("token 不正确，请重试"); });
  });
})();
</script>
</body>
</html>
"""


def load_or_create_token():
    """读取 data/auth_token.txt；不存在则生成 32 位十六进制 token（权限 600）。"""
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE, encoding="utf-8") as f:
            return f.read().strip()
    token = secrets.token_hex(16)  # 32 位十六进制
    fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(token + "\n")
    os.chmod(TOKEN_FILE, 0o600)
    print(f"[auth] 首次启动，已生成访问 token 写入 {TOKEN_FILE}（权限 600）")
    print("[auth] 公网访问请携带该 token；本地开发可用 --no-auth 或 MINI_ASANA_NO_AUTH=1 关闭认证")
    return token


# ---------- 项目数据布局 ----------

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
    """生成不与现有项目/文件冲突的短随机 id（urlsafe 字符集，满足 valid_pid）。"""
    ids = {p["id"] for p in idx["projects"]}
    while True:
        pid = secrets.token_urlsafe(6)  # 8 个字符
        if valid_pid(pid) and pid not in ids and not os.path.exists(project_file(pid)):
            return pid


def default_project_id():
    """index 中第一个项目（最老项目）的 id；无项目时返回 None。"""
    try:
        idx = load_index()
    except (OSError, ValueError):
        return None
    projects = idx.get("projects") or []
    return projects[0]["id"] if projects else None


def load_db(pid):
    with open(project_file(pid), encoding="utf-8") as f:
        return json.load(f)


def save_db(pid, db):
    path = project_file(pid)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def _write_new_project(pid, name):
    save_db(pid, {"project": name, "sections": list(DEFAULT_SECTIONS), "tasks": []})


def ensure_data_layout():
    """启动时确保多项目数据布局就绪：
    - 已有 data/projects/ 且 index 有效：直接使用
    - 只有旧版 data/tasks.json：迁移为第一个项目，旧文件改名 tasks.json.migrated
    - 全新安装：创建默认项目
    - projects/ 存在但 index 缺失/为空：从项目文件重建 index；无任何项目则补默认项目
    """
    os.makedirs(DATA_DIR, exist_ok=True)

    if not os.path.isdir(PROJECTS_DIR):
        if os.path.exists(DATA_FILE):
            # 迁移旧版单项目数据
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
        # 全新安装
        idx = {"projects": []}
        pid = new_project_id(idx)
        os.makedirs(PROJECTS_DIR)
        _write_new_project(pid, "Default Project")
        idx["projects"].append({"id": pid, "name": "Default Project"})
        save_index(idx)
        print(f"[data] 全新安装，已创建默认项目「Default Project」(id={pid})")
        return

    # projects/ 已存在：校验 index
    idx = None
    if os.path.exists(INDEX_FILE):
        try:
            idx = load_index()
        except (OSError, ValueError):
            idx = None
    if idx and idx.get("projects"):
        return

    # 从项目文件重建 index
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

    def log_message(self, fmt, *args):  # 简化日志
        pass

    # ---------- auth ----------
    def _client_token(self):
        """从 Authorization: Bearer 请求头或 ?token= query 参数提取 token。"""
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
        """API 请求返回 401 JSON；页面请求返回登录页 HTML。"""
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
        """统一 API 路由。项目本体 -> 项目作用域任务路由 -> 旧版兼容路径 -> 静态文件。"""
        path = urlparse(self.path).path
        body = None
        if method in ("POST", "PUT", "PATCH"):
            body = self._read_body()
            if body is None:
                return self._send_error_json(400, "invalid JSON")

        # 项目集合
        if path == "/api/projects":
            if method == "GET":
                return self._list_projects()
            if method == "POST":
                return self._create_project(body)
            return self._send_error_json(405, "method not allowed")

        # 项目本体
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

        # 项目作用域内的任务/分组/排序
        m = re.fullmatch(r"/api/projects/([A-Za-z0-9_-]{1,64})(/(?:tasks|sections|reorder)(?:/.*)?)", path)
        if m:
            pid, sub = m.group(1), m.group(2)
            if not os.path.isfile(project_file(pid)):
                return self._send_error_json(404, "project not found")
            return self._tasks_route(method, pid, sub, body)

        # 旧版单项目路径兼容：作用于 index 中第一个（最老）项目
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
        """项目作用域内的任务/分组/排序路由。
        sub 形如 /tasks、/tasks/<id>、/sections、/sections/<name>、/reorder。"""
        if sub == "/tasks":
            if method == "GET":
                with LOCK:
                    self._send_json(load_db(pid))
                return
            if method == "POST":
                return self._create_task(pid, body)
        elif sub == "/sections" and method == "POST":
            return self._create_section(pid, body)
        elif sub == "/reorder" and method == "POST":
            return self._reorder(pid, body)
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
    def _create_task(self, pid, body):
        name = (body.get("name") or "").strip()
        if not name:
            return self._send_error_json(400, "name required")
        with LOCK:
            db = load_db(pid)
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
            db["tasks"].append(task)
            save_db(pid, db)
        self._send_json(task, 201)

    def _update_task(self, pid, task_id, body):
        with LOCK:
            db = load_db(pid)
            task = find_task(db, task_id)
            if not task:
                return self._send_error_json(404, "task not found")
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
            save_db(pid, db)
        self._send_json(task)

    def _delete_task(self, pid, task_id):
        with LOCK:
            db = load_db(pid)
            task = find_task(db, task_id)
            if not task:
                return self._send_error_json(404, "task not found")
            db["tasks"] = [t for t in db["tasks"] if t["id"] != task_id]
            for t in db["tasks"]:  # 清理依赖引用
                if task_id in t.get("dependencies", []):
                    t["dependencies"] = [d for d in t["dependencies"] if d != task_id]
            save_db(pid, db)
        self._send_json({"ok": True})

    # ---------- section ops ----------
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
    def _serve_static(self, path):
        if path == "/":
            path = "/index.html"
        # 防目录穿越
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
        # index.html 经 ?token= 认证后分发时，把静态资源链接也带上 token，
        # 使浏览器导航请求（无法携带 Authorization 头）也能通过校验
        if AUTH_ENABLED and clean == "index.html":
            qs = parse_qs(urlparse(self.path).query)
            qt = (qs.get("token") or [None])[0]
            if qt and AUTH_TOKEN and hmac.compare_digest(qt.strip(), AUTH_TOKEN):
                suffix = ("?token=" + qt.strip()).encode("utf-8")
                data = data.replace(b'src="/app.js"', b'src="/app.js' + suffix + b'"')
                data = data.replace(b'href="/style.css"', b'href="/style.css' + suffix + b'"')
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

    # 多项目数据布局：必要时自动迁移旧版 data/tasks.json 或创建默认项目
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
