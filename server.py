#!/usr/bin/env python3
"""mini-asana: 本地单机版简易 Asana。

仅使用 Python 标准库。监听 127.0.0.1:8787。

REST API:
  GET    /api/tasks                 -> {"sections": [...], "tasks": [...]}
  POST   /api/tasks                 创建任务 (JSON body)
  PUT    /api/tasks/<id>            更新任务字段 (部分更新)
  DELETE /api/tasks/<id>            删除任务
  POST   /api/sections              新增 section {"name": str}
  PUT    /api/sections/<name>       重命名 section {"name": new_name}
  DELETE /api/sections/<name>       删除 section (其任务移到第一个剩余 section)
  POST   /api/reorder               {"section": str, "ids": [task_id, ...]} 重排 section 内顺序

所有写操作持久化到 data/tasks.json（原子写入）。
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
import secrets
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(BASE, "data", "tasks.json")
TOKEN_FILE = os.path.join(BASE, "data", "auth_token.txt")
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


def load_db():
    with open(DATA_FILE, encoding="utf-8") as f:
        return json.load(f)


def save_db(db):
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=1)
    os.replace(tmp, DATA_FILE)


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
    def do_GET(self):
        if not self._authorized():
            return self._reject()
        path = urlparse(self.path).path
        if path == "/api/tasks":
            with LOCK:
                self._send_json(load_db())
        elif path.startswith("/api/"):
            self._send_error_json(404, "not found")
        else:
            self._serve_static(path)

    def do_POST(self):
        if not self._authorized():
            return self._reject()
        path = urlparse(self.path).path
        body = self._read_body()
        if body is None:
            return self._send_error_json(400, "invalid JSON")
        if path == "/api/tasks":
            self._create_task(body)
        elif path == "/api/sections":
            self._create_section(body)
        elif path == "/api/reorder":
            self._reorder(body)
        else:
            self._send_error_json(404, "not found")

    def do_PUT(self):
        if not self._authorized():
            return self._reject()
        path = urlparse(self.path).path
        body = self._read_body()
        if body is None:
            return self._send_error_json(400, "invalid JSON")
        if path.startswith("/api/tasks/"):
            self._update_task(unquote(path[len("/api/tasks/"):]), body)
        elif path.startswith("/api/sections/"):
            self._rename_section(unquote(path[len("/api/sections/"):]), body)
        else:
            self._send_error_json(404, "not found")

    def do_DELETE(self):
        if not self._authorized():
            return self._reject()
        path = urlparse(self.path).path
        if path.startswith("/api/tasks/"):
            self._delete_task(unquote(path[len("/api/tasks/"):]))
        elif path.startswith("/api/sections/"):
            self._delete_section(unquote(path[len("/api/sections/"):]))
        else:
            self._send_error_json(404, "not found")

    # ---------- task ops ----------
    def _create_task(self, body):
        name = (body.get("name") or "").strip()
        if not name:
            return self._send_error_json(400, "name required")
        with LOCK:
            db = load_db()
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
            save_db(db)
        self._send_json(task, 201)

    def _update_task(self, task_id, body):
        with LOCK:
            db = load_db()
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
            save_db(db)
        self._send_json(task)

    def _delete_task(self, task_id):
        with LOCK:
            db = load_db()
            task = find_task(db, task_id)
            if not task:
                return self._send_error_json(404, "task not found")
            db["tasks"] = [t for t in db["tasks"] if t["id"] != task_id]
            for t in db["tasks"]:  # 清理依赖引用
                if task_id in t.get("dependencies", []):
                    t["dependencies"] = [d for d in t["dependencies"] if d != task_id]
            save_db(db)
        self._send_json({"ok": True})

    # ---------- section ops ----------
    def _create_section(self, body):
        name = (body.get("name") or "").strip()
        if not name:
            return self._send_error_json(400, "name required")
        with LOCK:
            db = load_db()
            if name in db["sections"]:
                return self._send_error_json(409, "section exists")
            db["sections"].append(name)
            save_db(db)
        self._send_json({"sections": db["sections"]}, 201)

    def _rename_section(self, old, body):
        new = (body.get("name") or "").strip()
        if not new:
            return self._send_error_json(400, "name required")
        with LOCK:
            db = load_db()
            if old not in db["sections"]:
                return self._send_error_json(404, "section not found")
            if new != old and new in db["sections"]:
                return self._send_error_json(409, "section exists")
            db["sections"] = [new if s == old else s for s in db["sections"]]
            for t in db["tasks"]:
                if t["section"] == old:
                    t["section"] = new
            save_db(db)
        self._send_json({"sections": db["sections"]})

    def _delete_section(self, name):
        with LOCK:
            db = load_db()
            if name not in db["sections"]:
                return self._send_error_json(404, "section not found")
            if len(db["sections"]) <= 1:
                return self._send_error_json(400, "cannot delete last section")
            db["sections"] = [s for s in db["sections"] if s != name]
            fallback = db["sections"][0]
            for t in db["tasks"]:
                if t["section"] == name:
                    t["section"] = fallback
            save_db(db)
        self._send_json({"sections": db["sections"], "moved_to": fallback})

    def _reorder(self, body):
        section = body.get("section")
        ids = body.get("ids") or []
        with LOCK:
            db = load_db()
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
            save_db(db)
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

    if not os.path.exists(DATA_FILE):
        raise SystemExit("data/tasks.json 不存在，请先运行 python3 convert.py")

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
