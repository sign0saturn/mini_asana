#!/usr/bin/env python3
"""mini-asana write-guard connection-hygiene checks (11 raw-socket tests).

Covers: 403/415 rejections close the keep-alive connection (an unread request
body must not poison the next request on the same socket), Content-Length text
validation before any int() conversion (garbage or 5000-digit values -> 400 +
close, no traceback leaked), and the two allowed-write regressions (normal JSON
write, bodyless write without Content-Type).

Usage:
    python3 test_security_raw_socket.py <port> <token>

Easiest: tests/run_local.sh spins up a throwaway instance and runs everything.
"""
import json
import socket
import sys
import urllib.error
import urllib.request

PORT, TOKEN = int(sys.argv[1]), sys.argv[2]
fails = []


def check(name, cond, detail=""):
    if not cond:
        fails.append(name)
    print(f"{'PASS' if cond else 'FAIL'}  {name} {detail}")


def raw_exchange(payload):
    """Send raw bytes, read until EOF or timeout. Returns (bytes, closed: bool)."""
    s = socket.create_connection(("127.0.0.1", PORT), timeout=5)
    s.sendall(payload)
    data = b""
    closed = False
    try:
        while True:
            chunk = s.recv(65536)
            if not chunk:
                closed = True
                break
            data += chunk
    except socket.timeout:
        pass
    s.close()
    return data, closed


H = f"Host: 127.0.0.1:{PORT}\r\nAuthorization: Bearer {TOKEN}\r\n"

# 1) cross-origin 403 with an UNREAD body, then a pipelined GET on the same connection.
# If the server did not close, the leftover body would corrupt the pipelined GET.
body = b'{"name":"csrf"}'
req1 = (f"POST /api/projects HTTP/1.1\r\n{H}Content-Type: application/json\r\n"
        f"Origin: https://evil.example.com\r\nContent-Length: {len(body)}\r\n\r\n").encode() + body
req2 = f"GET /api/projects HTTP/1.1\r\n{H}\r\n".encode()
data, closed = raw_exchange(req1 + req2)
check("403 response received", b" 403 " in data.split(b"\r\n")[0], data.split(b"\r\n")[0])
check("connection closed after 403 (no pollution)", closed)

# 2) text/plain 415 with unread body + pipelined GET
req1 = (f"POST /api/projects HTTP/1.1\r\n{H}Content-Type: text/plain\r\n"
        f"Content-Length: {len(body)}\r\n\r\n").encode() + body
data, closed = raw_exchange(req1 + req2)
check("415 response received", b" 415 " in data.split(b"\r\n")[0], data.split(b"\r\n")[0])
check("connection closed after 415 (no pollution)", closed)

# 3) 5000-digit Content-Length -> 400, no traceback, closed
big_cl = "9" * 5000
req1 = f"POST /api/projects HTTP/1.1\r\n{H}Content-Type: application/json\r\nContent-Length: {big_cl}\r\n\r\n".encode()
data, closed = raw_exchange(req1)
first = data.split(b"\r\n")[0]
check("5000-digit Content-Length -> 400", b" 400 " in first, first)
check("no traceback leaked to client", b"Traceback" not in data)
check("connection closed after 400", closed)

# 4) non-numeric Content-Length -> 400 + closed
req1 = f"POST /api/projects HTTP/1.1\r\n{H}Content-Type: application/json\r\nContent-Length: abc\r\n\r\n".encode()
data, closed = raw_exchange(req1)
check("non-numeric Content-Length -> 400", b" 400 " in data.split(b"\r\n")[0], data.split(b"\r\n")[0])
check("connection closed after bad CL", closed)

# 5) normal write still works (regression); temp project is deleted afterwards
r = urllib.request.Request(f"http://127.0.0.1:{PORT}/api/projects", data=json.dumps({"name": "raw-socket-tmp"}).encode(),
                           method="POST", headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
try:
    with urllib.request.urlopen(r) as resp:
        s = resp.status
        pid = json.loads(resp.read())["id"]
except urllib.error.HTTPError as e:
    s, pid = e.code, None
check("normal write -> 201", s == 201, f"got {s}")
if pid:
    r = urllib.request.Request(f"http://127.0.0.1:{PORT}/api/projects/{pid}", method="DELETE",
                               headers={"Authorization": f"Bearer {TOKEN}"})
    urllib.request.urlopen(r)
    print("     (temp project cleaned up)")

# 6) bodyless write without Content-Type stays allowed (e.g. archive_completed)
with urllib.request.urlopen(urllib.request.Request(
        f"http://127.0.0.1:{PORT}/api/projects",
        headers={"Authorization": f"Bearer {TOKEN}"})) as resp:
    pid0 = json.loads(resp.read())["projects"][0]["id"]
req = urllib.request.Request(f"http://127.0.0.1:{PORT}/api/projects/{pid0}/archive_completed",
                             method="POST", headers={"Authorization": f"Bearer {TOKEN}"})
try:
    with urllib.request.urlopen(req) as resp:
        s = resp.status
except urllib.error.HTTPError as e:
    s = e.code
check("bodyless write without Content-Type -> 200", s == 200, f"got {s}")

print()
if fails:
    print(f"{len(fails)} FAILED: {fails}")
    sys.exit(1)
print("ALL PASS")
