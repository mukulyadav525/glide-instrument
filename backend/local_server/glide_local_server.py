#!/usr/bin/env python3
"""GLIDE local backend: the same API as the Apps Script, writing to a local folder.

Two uses:
  1. Testing the whole admin <-> laptop <-> storage flow without Google.
  2. A no-internet fallback. Run it ON THE PARTICIPANT LAPTOP (the camera needs
     localhost or https), open http://localhost:8765/ there, and open
     http://<that laptop's LAN IP>:8765/admin.html on the admin device.
     (The educator portal needs a secure page for its camera-free view too:
     open it at http://localhost on the same laptop, or serve over https.)
     Data lands in ./local_drive/GLIDE_Study_Data/ in exactly the Drive layout;
     copy that folder into the study Drive afterwards.

    python3 backend/local_server/glide_local_server.py [--port 8765] [--data ./local_drive]

Keys are created on first run and printed; they live in <data>/keys.json.
Standard library only.
"""
import argparse, base64, csv, hashlib, json, os, pathlib, random, re, secrets, string, threading, time
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

HERE = pathlib.Path(__file__).resolve().parent
# The site to serve: the repository root (backend/local_server/ -> ../..), which holds the built pages.
DIST = HERE.parent.parent
JOIN_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
REG_HEADERS = ["session_id","created_at","source","mode","child_id","educator_id","join_code","capacity",
  "consent_form_version","guardian_main","guardian_gaze","guardian_video","retention_until",
  "status","last_seen","screen","progress","recording","files_uploaded","bytes_uploaded","last_upload",
  "video_deleted","withdrawn","ended_early","completed","folder_url","notes"]
LOCK = threading.Lock()

def now(): return datetime.now(timezone.utc).isoformat()
def clean(s): return re.sub(r"[^A-Za-z0-9_\-]", "", str(s or "").strip())[:24]

class Store:
    def __init__(self, data):
        self.data = pathlib.Path(data).resolve()
        self.root = self.data / "GLIDE_Study_Data"
        for d in ["participants", "_registry", "_analysis", "_docs"]: (self.root / d).mkdir(parents=True, exist_ok=True)
        kf = self.data / "keys.json"
        if not kf.exists(): kf.write_text(json.dumps({"ADMIN_KEY": secrets.token_urlsafe(24), "DEVICE_KEY": secrets.token_urlsafe(24)}, indent=2))
        self.keys = json.loads(kf.read_text())
        self.state_f = self.data / "state.json"
        self.state = json.loads(self.state_f.read_text()) if self.state_f.exists() else {"sessions": {}, "join": {}, "cmds": {}, "status": {}, "registry": {}}
    def save(self): self.state_f.write_text(json.dumps(self.state, indent=1))
    def role(self, k):
        if k and k == self.keys["ADMIN_KEY"]: return "admin"
        if k and k == self.keys["DEVICE_KEY"]: return "device"
        return None
    def folder(self, m):
        sid = str(m.get("session_id") or "")
        if not re.match(r"^s[a-z0-9]{6,30}$", sid): raise ValueError("bad_session_id")
        mode = m.get("mode") if m.get("mode") in ("child", "educator") else "other"
        date = m.get("date") if re.match(r"^\d{4}-\d{2}-\d{2}$", str(m.get("date"))) else datetime.now().strftime("%Y-%m-%d")
        p = self.root / "participants" / (clean(m.get("child_id")) or "anon") / mode / f"{date}_{sid}"
        p.mkdir(parents=True, exist_ok=True)
        return p
    def reg(self, sid, **f):
        r = self.state["registry"].setdefault(sid, {h: "" for h in REG_HEADERS}); r["session_id"] = sid
        r.update({k: v for k, v in f.items() if k in REG_HEADERS})
        with open(self.root / "_registry" / "GLIDE_Registry.csv", "w", newline="") as fh:
            w = csv.DictWriter(fh, REG_HEADERS); w.writeheader()
            for row in self.state["registry"].values(): w.writerow(row)

    # ---- ops (same names and shapes as Code.gs)
    def op_ping(self, r, role): return {"role": role, "version": "glide-local-5.1.0"}
    # ---- v5.1: educator portal (same shapes as Code.gs)
    def op_edu_join(self, r, role):
        code = re.sub(r"[^A-Z0-9]", "", str(r.get("join_code") or "").upper())
        sid = self.state["join"].get(code)
        if not sid: raise ValueError("unknown_join_code")
        s = self.state["sessions"][sid]
        keys = ["session_id","join_code","mode","child_id","educator_id","guardian_gaze","guardian_video","date","created_at","joined_at"]
        return {"session": {k: s.get(k) for k in keys}, "status": self.state["status"].get(sid)}
    def op_signal(self, r, role):
        sid = str(r.get("session_id") or "")
        if not re.match(r"^s[a-z0-9]{6,30}$", sid): raise ValueError("bad_session_id")
        if sid not in self.state["sessions"]: raise ValueError("unknown_session")
        box = self.__dict__.setdefault("signals", {})
        if r.get("put"):
            if r.get("role") not in ("laptop", "educator"): raise ValueError("bad_role")
            m = r["put"]; msg = {"type": str(m.get("type") or ""), "id": str(m.get("id") or "")[:40], "sdp": m.get("sdp"), "at": now(), "_t": time.time()}
            if len(json.dumps(msg)) > 90000: raise ValueError("signal_too_large")
            box[(sid, r["role"])] = msg; return {}
        if r.get("get") not in ("laptop", "educator"): raise ValueError("bad_role")
        m = box.get((sid, r["get"]))
        if m and time.time() - m["_t"] > 600: m = None
        return {"msg": {k: v for k, v in m.items() if k != "_t"} if m else None}
    def op_create_session(self, r, role):
        c = r.get("config") or {}
        mode = "educator" if c.get("mode") == "educator" else "child"
        child = clean(c.get("child_id"))
        if not child: raise ValueError("child_id_required")
        if not c.get("guardian_main"): raise ValueError("guardian_consent_required")
        sid = "s" + format(int(time.time() * 1000), "x")[-9:] + secrets.token_hex(3)[:5]
        while True:
            code = "".join(random.choice(JOIN_ALPHABET) for _ in range(6))
            if code not in self.state["join"]: break
        date = datetime.now().strftime("%Y-%m-%d")
        folder = self.folder({"session_id": sid, "mode": mode, "child_id": child, "date": date})
        s = {"session_id": sid, "join_code": code, "mode": mode, "child_id": child, "educator_id": clean(c.get("educator_id")),
             "capacity": c.get("capacity") if c.get("capacity") in ("capable", "diminished") else None,
             "guardian_main": bool(c.get("guardian_main")), "guardian_gaze": bool(c.get("guardian_gaze")), "guardian_video": bool(c.get("guardian_video")),
             "consent_form_version": (c.get("consent_form_version") or "")[:80] or None, "retention_until": (c.get("retention_until") or "")[:10] or None,
             "sync_flash": c.get("sync_flash") is not False, "notes": (c.get("notes") or "")[:300], "created_at": now(), "date": date,
             "folder_url": folder.as_uri()}
        self.state["sessions"][sid] = s; self.state["join"][code] = sid
        self.reg(sid, created_at=s["created_at"], source="admin_device", mode=mode, child_id=child, educator_id=s["educator_id"], join_code=code,
                 capacity=s["capacity"] or "", consent_form_version=s["consent_form_version"] or "", guardian_main=s["guardian_main"],
                 guardian_gaze=s["guardian_gaze"], guardian_video=s["guardian_video"], retention_until=s["retention_until"] or "",
                 status="created", folder_url=s["folder_url"], notes=s["notes"])
        return {"session": s}
    def op_join(self, r, role):
        code = re.sub(r"[^A-Z0-9]", "", str(r.get("join_code") or "").upper())
        sid = self.state["join"].get(code)
        if not sid: raise ValueError("unknown_join_code")
        s = self.state["sessions"][sid]; s.setdefault("joined_at", now())
        self.reg(sid, status="joined", last_seen=now())
        keys = ["session_id","join_code","mode","child_id","educator_id","capacity","guardian_main","guardian_gaze","guardian_video",
                "consent_form_version","retention_until","sync_flash","date","created_at"]
        return {"session": {k: s.get(k) for k in keys}}
    def op_heartbeat(self, r, role):
        sid = str(r.get("session_id")); st = r.get("status") or {}
        if not re.match(r"^s[a-z0-9]{6,30}$", sid): raise ValueError("bad_session_id")
        st["server_seen"] = now(); self.state["status"][sid] = st
        self.reg(sid, status="withdrawn" if st.get("withdrawn") else "complete" if st.get("completed") else "ended_early" if st.get("ended_early") else "running",
                 last_seen=st["server_seen"], screen=st.get("screen_id") or "", progress=f'{st.get("index","")}/{st.get("total","")}',
                 recording="yes" if st.get("recording") else ("no" if st.get("video_consented") else "n/a"),
                 withdrawn=bool(st.get("withdrawn")), ended_early=bool(st.get("ended_early")), completed=bool(st.get("completed")),
                 video_deleted=bool(st.get("video_deleted")))
        return {"commands": [c for c in self.state["cmds"].get(sid, []) if not c["acked"]]}
    def op_ack(self, r, role):
        for c in self.state["cmds"].get(str(r.get("session_id")), []):
            if c["id"] == r.get("command_id"): c["acked"] = True; c["acked_at"] = now()
        return {}
    def op_status(self, r, role):
        sid = str(r.get("session_id")); return {"status": self.state["status"].get(sid), "commands": self.state["cmds"].get(sid, [])}
    def op_command(self, r, role):
        if r.get("type") not in ("stop", "withdraw", "message", "delete_video"): raise ValueError("bad_command")
        c = {"id": "c" + secrets.token_hex(4), "type": r["type"], "args": r.get("args") or {}, "at": now(), "acked": False}
        self.state["cmds"].setdefault(str(r.get("session_id")), []).append(c); return {"command": c}
    def op_list_sessions(self, r, role):
        rows = []
        for sid, row in reversed(list(self.state["registry"].items())):
            o = dict(row); o["live"] = self.state["status"].get(sid); rows.append(o)
        return {"sessions": rows[: int(r.get("limit") or 200)], "root_url": self.root.as_uri()}
    def op_folder_url(self, r, role): return {"url": self.root.as_uri()}
    def op_upload(self, r, role):
        m = r.get("session") or {}; path = str(r.get("path") or "")
        if not re.match(r"^[A-Za-z0-9_.\-]+(/[A-Za-z0-9_.\-]+)?$", path) or ".." in path: raise ValueError("bad_path")
        data = base64.b64decode(r.get("data_b64") or "")
        if r.get("size") is not None and len(data) != r["size"]: raise ValueError("size_mismatch")
        dig = hashlib.sha256(data).hexdigest()
        if r.get("sha256") and r["sha256"] != dig: raise ValueError("sha256_mismatch")
        dest = self.folder(m) / path; dest.parent.mkdir(parents=True, exist_ok=True); dest.write_bytes(data)
        sid = m["session_id"]
        if sid not in self.state["registry"]:
            self.reg(sid, created_at=now(), source="participant_offline", mode=m.get("mode"), child_id=clean(m.get("child_id")),
                     educator_id=clean(m.get("educator_id")), consent_form_version=m.get("consent_form_version") or "",
                     retention_until=m.get("retention_until") or "", status="uploading", folder_url=self.folder(m).as_uri())
        cur = self.state["registry"][sid]
        self.reg(sid, files_uploaded=int(cur.get("files_uploaded") or 0) + 1, bytes_uploaded=int(cur.get("bytes_uploaded") or 0) + len(data),
                 last_upload=now() + " " + path)
        return {"file_id": str(dest.relative_to(self.root)), "sha256": dig, "bytes": len(data)}
    def op_delete_video(self, r, role):
        m = r.get("session") or {}; v = self.folder(m) / "video"; n = 0
        if v.exists():
            for f in v.iterdir(): f.unlink(); n += 1
        (self.folder(m) / "VIDEO_DELETED.txt").write_text(f"Video deleted {now()} ({n} part files, permanently). Reason: {r.get('reason') or 'not given'}. Requested by: {role}.")
        self.reg(m.get("session_id"), video_deleted=True)
        return {"deleted_files": n, "permanent": True}

ADMIN_ONLY = {"create_session", "list_sessions", "status", "command", "folder_url"}

def make_handler(store):
    class H(SimpleHTTPRequestHandler):
        def __init__(self, *a, **k): super().__init__(*a, directory=str(DIST), **k)
        # Only the site itself is served. The data folder and keys.json sit
        # under the same repository, and must never be reachable over the LAN.
        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/": path = "/index.html"
            if path in ("/index.html", "/educator.html", "/admin.html", "/DATA_DICTIONARY.csv") or (path.startswith("/mediapipe/") and ".." not in path):
                return super().do_GET()
            self.send_error(404)
        def do_HEAD(self): self.send_error(405)
        def log_message(self, fmt, *a):
            if "/api" in (self.path or ""): return
            super().log_message(fmt, *a)
        def end_headers(self):
            self.send_header("Access-Control-Allow-Origin", "*"); self.send_header("Cache-Control", "no-store"); super().end_headers()
        def do_OPTIONS(self):
            self.send_response(204); self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type"); self.end_headers()
        def do_POST(self):
            if not self.path.startswith("/api"): self.send_error(404); return
            n = int(self.headers.get("Content-Length") or 0)
            try: req = json.loads(self.rfile.read(n) or b"{}")
            except Exception: return self.reply({"ok": False, "error": "bad_json"})
            role = store.role(req.get("key"))
            if not role: return self.reply({"ok": False, "error": "bad_key"})
            op = req.get("op")
            if op in ADMIN_ONLY and role != "admin": return self.reply({"ok": False, "error": "admin_key_required"})
            fn = getattr(store, "op_" + str(op), None)
            if not fn: return self.reply({"ok": False, "error": "unknown_op"})
            try:
                with LOCK:
                    out = fn(req, role); out["ok"] = True; store.save()
            except Exception as e:
                out = {"ok": False, "error": str(e)}
            self.reply(out)
        def reply(self, o):
            b = json.dumps(o).encode(); self.send_response(200)
            self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    return H

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--port", type=int, default=8765); ap.add_argument("--data", default=str(HERE / "local_drive"))
    a = ap.parse_args()
    store = Store(a.data)
    api = f"http://localhost:{a.port}/api"
    print(f"GLIDE local backend on http://localhost:{a.port}/  (data: {store.root})")
    print(f"  admin console:  http://localhost:{a.port}/admin.html   admin key: {store.keys['ADMIN_KEY']}")
    print(f"  laptop setup:   http://localhost:{a.port}/index.html?api={api}&k={store.keys['DEVICE_KEY']}")
    print(f"  educator portal: http://localhost:{a.port}/educator.html?api={api}&k={store.keys['DEVICE_KEY']}")
    ThreadingHTTPServer(("0.0.0.0", a.port), make_handler(store)).serve_forever()

if __name__ == "__main__":
    main()
