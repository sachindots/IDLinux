#!/usr/bin/python3
"""Forward one browser-native message to the desktop app's per-user Unix socket."""
import http.client
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
from select import select
import sys

LIMIT = 256 * 1024
ROUTES = {"ping": "GET", "add": "POST", "confirm": "POST"}


def forward(stream):
    header = stream.read(4)
    if len(header) != 4:
        raise ValueError("Missing message header")
    length, = struct.unpack("=I", header)
    if not 0 < length <= LIMIT:
        raise ValueError("Invalid message length")
    raw = stream.read(length)
    if len(raw) != length:
        raise ValueError("Incomplete message")
    message = json.loads(raw)
    if not isinstance(message, dict) or message.get("op") not in (*ROUTES, "video"):
        raise ValueError("Unknown request")
    op = message["op"]
    if op == "video":
        child = subprocess.Popen([sys.executable, str(Path(__file__).with_name("video.py")), "--offer"],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 start_new_session=True)
        child.stdin.write(json.dumps(message.get("body")).encode())
        child.stdin.close()
        if select([child.stdout], [], [], 8)[0] and child.stdout.readline() == b"ready\n":
            return {"status": 200}
        child.terminate()
        return {"status": 503}
    base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(12)
        sock.connect(str(base / "idlinux" / "native" / "browser.sock"))
        connection = http.client.HTTPConnection("localhost")
        connection.sock = sock
        body = json.dumps(message.get("body"), ensure_ascii=False).encode() if op != "ping" else None
        connection.request(ROUTES[op], "/" + op, body, {"Content-Type": "application/json"})
        response = connection.getresponse()
        data = response.read(LIMIT + 1)
        if len(data) > LIMIT:
            raise ValueError("Reply too large")
        return {"status": response.status, "body": json.loads(data) if data else None}


if __name__ == "__main__":
    try:
        reply = forward(sys.stdin.buffer)
    except (OSError, http.client.HTTPException, ValueError, TypeError, RecursionError):
        reply = {"status": 503}
    data = json.dumps(reply).encode()
    sys.stdout.buffer.write(struct.pack("=I", len(data)) + data)
