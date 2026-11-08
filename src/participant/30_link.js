
/* =========================================================================
   v5 · LINK TO THE ADMIN DEVICE AND GOOGLE DRIVE
   -------------------------------------------------------------------------
   The instrument never needs the network to collect data. Every file is
   written to this laptop's IndexedDB first (the OUTBOX), and a pump uploads
   from there to the study's Google Drive through a small Apps Script web app
   the research team owns. If the school Wi-Fi drops, uploads wait and resume;
   if the laptop is offline all day, the outbox survives a reboot and uploads
   the next time this page is opened with a connection.

   The same backend carries the admin link: the admin device creates a
   session and gets a join code; this device joins with the code, receives the
   session's codes and consent flags, and sends a heartbeat every few seconds
   so the admin can see progress and send Stop / Withdraw.

   Configured once per laptop, from the admin console's "Set up a participant
   laptop" link (?api=...&k=...). The device key can upload into session
   folders and nothing else; it cannot list, read or delete study data.
   ========================================================================= */
const LINK = (function () {
  const KEY = "glide_link";
  let cfg = { api:null, device_key:null };
  try { cfg = Object.assign(cfg, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch (e) {}
  // One-time configuration from the admin console's setup link.
  try {
    const q = new URLSearchParams(location.search);
    if (q.get("api") && q.get("k")) {
      cfg.api = q.get("api"); cfg.device_key = q.get("k");
      localStorage.setItem(KEY, JSON.stringify(cfg));
      history.replaceState(null, "", location.pathname);
    }
  } catch (e) {}
  let online = null, lastErr = null, session = null, hbTimer = null, handlers = {}, lastHb = null;
  async function call(op, body, timeoutMs) {
    if (!cfg.api) throw new Error("not_configured");
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const to = ctl ? setTimeout(() => ctl.abort(), timeoutMs || 30000) : null;
    try {
      // text/plain keeps this a "simple" request: no CORS preflight, which
      // Apps Script web apps do not answer.
      const r = await fetch(cfg.api, { method:"POST", redirect:"follow",
        headers:{ "Content-Type":"text/plain;charset=utf-8" },
        body: JSON.stringify(Object.assign({ op, key: cfg.device_key, v: SCHEMA_VERSION }, body || {})),
        signal: ctl ? ctl.signal : undefined });
      const j = await r.json();
      online = true; lastErr = null;
      if (!j.ok) throw Object.assign(new Error(j.error || "server_error"), { server:true });
      return j;
    } catch (e) {
      if (!e.server) { online = false; lastErr = String(e && e.message || e); }
      throw e;
    } finally { if (to) clearTimeout(to); }
  }
  return {
    configured() { return !!(cfg.api && cfg.device_key); },
    config() { return { api: cfg.api, has_key: !!cfg.device_key }; },
    setConfig(api, k) { cfg.api = (api || "").trim() || null; cfg.device_key = (k || "").trim() || null;
      try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) {} },
    online() { return online; },
    lastError() { return lastErr; },
    call,
    ping() { return call("ping", {}, 12000); },
    async join(code) {
      let pair = null; try { pair = REMOTE.pairCode(); } catch (e) {}
      // v5.2: the laptop's pairing code goes with the join, so a portal opened from the admin console finds this laptop.
      const j = await call("join", { join_code: String(code || "").trim().toUpperCase(), pair_code: pair }, 20000);
      session = j.session;
      return session;
    },
    session() { return session; },
    setSession(s) { session = s; },
    on(type, fn) { handlers[type] = fn; },
    lastHeartbeat() { return lastHb; },
    /* Heartbeat: status out, commands in. Commands are acknowledged only after
       they have been acted on and logged, so a lost response re-delivers. */
    startHeartbeat(statusFn) {
      if (hbTimer || !session) return;
      const beat = async () => {
        if (!session) return;
        try {
          const j = await call("heartbeat", { session_id: session.session_id, status: statusFn() }, 15000);
          lastHb = Date.now();
          for (const c of (j.commands || [])) {
            if (handlers[c.type]) { try { await handlers[c.type](c); } catch (e) {} }
            EV.log("admin_command", { id:c.id, type:c.type, args:c.args || null });
            try { await call("ack", { session_id: session.session_id, command_id: c.id }, 15000); } catch (e) {}
          }
        } catch (e) {}
      };
      beat(); hbTimer = setInterval(beat, 5000);
    },
    stopHeartbeat() { clearInterval(hbTimer); hbTimer = null; }
  };
})();

/* ---------------------------------------------------------------- hashing */
async function sha256Hex(blob) {
  try {
    if (!crypto || !crypto.subtle) return null;
    const buf = await blob.arrayBuffer();
    const h = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, "0")).join("");
  } catch (e) { return null; }
}
function blobToB64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => { const s = String(fr.result); res(s.slice(s.indexOf(",") + 1)); };
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });
}

/* ------------------------------------------------------------------ outbox */
/* Keyed by session + path, so re-saving a file (session.json is rewritten at
   the end) replaces the queued copy rather than uploading two. */
const OUTBOX = (function () {
  const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;   // Apps Script request ceiling is ~50 MB after base64
  let sid = null, busy = false, timer = null, stats = { pending:0, uploaded:0, failed:0, bytes_pending:0, bytes_uploaded:0, local_only:0 };
  const listeners = [];
  async function refresh() {
    const all = await IDB.all("outbox").catch(() => []);
    const mine = sid ? all.filter(x => x.sid === sid) : all;
    stats = { pending:0, uploaded:0, failed:0, bytes_pending:0, bytes_uploaded:0, local_only:0,
      other_sessions_pending: all.filter(x => x.sid !== sid && x.state !== "uploaded").length };
    mine.forEach(x => {
      if (x.state === "uploaded") { stats.uploaded++; stats.bytes_uploaded += x.size; }
      else if (x.state === "too_large") { stats.local_only++; }
      else { stats.pending++; stats.bytes_pending += x.size; if (x.tries > 3) stats.failed++; }
    });
    listeners.forEach(f => { try { f(stats); } catch (e) {} });
    return stats;
  }
  async function pump() {
    if (busy || !LINK.configured()) return;
    busy = true;
    try {
      const all = (await IDB.all("outbox").catch(() => [])).filter(x => x.state === "pending" || x.state === "retry");
      // This session first, small files before video, oldest first.
      all.sort((a, b) => (a.sid === sid ? 0 : 1) - (b.sid === sid ? 0 : 1) || (a.kind === "video") - (b.kind === "video") || a.added - b.added);
      for (const item of all) {
        if (item.size > MAX_UPLOAD_BYTES) { item.state = "too_large"; await IDB.put("outbox", item); continue; }
        const meta = await IDB.get("meta", item.sid).catch(() => null);
        if (!meta) continue;
        // A withdrawal may delete the video while this loop is running.
        if (item.kind === "video" && item.sid === sid && REC.deleted()) { await IDB.del("outbox", item.k); continue; }
        const still = await IDB.get("outbox", item.k).catch(() => null);
        if (!still) continue;
        try {
          const b64 = await blobToB64(item.blob);
          const r = await LINK.call("upload", { session: meta.server, path: item.path, mime: item.mime,
            size: item.size, sha256: item.sha256, data_b64: b64 }, 180000);
          item.state = "uploaded"; item.uploaded_at = new Date().toISOString(); item.file_id = r.file_id || null;
          item.server_sha256 = r.sha256 || null;
          if (item.kind === "video" && item.sid === sid && REC.deleted()) {
            // Landed after the delete: delete again, and do not keep it queued.
            try { await LINK.call("delete_video", { session: meta.server, reason: "late_upload_after_withdrawal" }); } catch (e) {}
            await IDB.del("outbox", item.k);
            continue;
          }
          await IDB.put("outbox", item);
          if (item.sid === sid) EV.log("upload_ok", { path:item.path, size:item.size });
        } catch (e) {
          item.tries = (item.tries || 0) + 1; item.state = "retry"; item.last_error = String(e && e.message || e);
          await IDB.put("outbox", item);
          if (item.sid === sid) EV.log("upload_failed", { path:item.path, tries:item.tries, error:item.last_error });
          if (!e.server) break;      // network down: stop and wait for the next tick
        }
        await refresh();
      }
    } finally { busy = false; await refresh(); }
  }
  return {
    bind(s) { sid = s; if (!timer) timer = setInterval(pump, 8000); refresh(); },
    async add(path, blob, mime, extra) {
      const item = Object.assign({ k: sid + "|" + path, sid, path, mime, blob, size: blob.size,
        sha256: await sha256Hex(blob), state:"pending", tries:0, added: Date.now(),
        kind: extra && extra.kind || "data" }, { extra: extra || null });
      try { await IDB.put("outbox", item); }
      catch (e) { EV.log("outbox_store_failed", { path, size: blob.size, error: String(e && e.message || e) }); throw e; }
      refresh(); setTimeout(pump, 200);
      return item;
    },
    async list(s) { return (await IDB.bySid("outbox", s || sid).catch(() => [])); },
    async dropVideo(s) {
      const items = await this.list(s);
      for (const it of items) if (it.kind === "video") await IDB.del("outbox", it.k);
      refresh();
    },
    pump, refresh,
    stats() { return stats; },
    onChange(f) { listeners.push(f); },
    async clearUploaded(s) {
      const items = await this.list(s);
      if (items.some(i => i.state !== "uploaded")) return false;
      for (const it of items) await IDB.del("outbox", it.k);
      await IDB.delSid("rows", s).catch(() => {}); await IDB.delSid("chunks", s).catch(() => {});
      await IDB.del("meta", s).catch(() => {});
      return true;
    }
  };
})();

/* --------------------------------------------------------------------- zip */
/* Store-only (no compression) ZIP writer. Video is already compressed and the
   CSVs are small; what matters is that a session can leave this laptop as ONE
   file with the same folder layout as Drive when there is no network at all. */
const ZIP = (function () {
  const T = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
  const crc = u8 => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  return {
    async make(files) {           // files: [{path, blob}]
      const enc = new TextEncoder(), parts = [], central = [];
      let off = 0;
      const d = new Date(), dt = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF,
            dd = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
      for (const f of files) {
        const name = enc.encode(f.path), data = new Uint8Array(await f.blob.arrayBuffer()), c = crc(data);
        const h = new DataView(new ArrayBuffer(30));
        h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
        h.setUint16(10, dt, true); h.setUint16(12, dd, true); h.setUint32(14, c, true);
        h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
        parts.push(h.buffer, name, data);
        const cd = new DataView(new ArrayBuffer(46));
        cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
        cd.setUint16(10, 0, true); cd.setUint16(12, dt, true); cd.setUint16(14, dd, true); cd.setUint32(16, c, true);
        cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true); cd.setUint16(28, name.length, true);
        cd.setUint32(42, off, true);
        central.push(cd.buffer, name);
        off += 30 + name.length + data.length;
      }
      const cdSize = central.reduce((a, b) => a + (b.byteLength || b.length), 0);
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
      end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
      return new Blob(parts.concat(central, [end.buffer]), { type:"application/zip" });
    }
  };
})();
