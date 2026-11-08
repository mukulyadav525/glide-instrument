
/* =========================================================================
   v5 · ONE CLOCK
   -------------------------------------------------------------------------
   Video is only re-usable later if every frame can be placed on the same clock
   as every stimulus, response, calibration target and gaze sample. Everything
   in v5 is therefore stamped with performance.now() (monotonic, sub-ms, never
   jumps when the wall clock is corrected), and performance.timeOrigin is
   recorded once so any t_perf converts to absolute UTC:

       utc_ms = time_origin_ms + t_perf

   Wall-clock ISO strings are still written beside it for human reading, but
   they are never the join key.
   ========================================================================= */
/* A reload (crash, closed tab) starts a new performance.now() epoch. So that
   video parts and rows from before and after a reload stay on ONE axis, t_perf
   is defined as milliseconds since the SESSION's time origin: on the first
   page load the offset is zero; after a resume it is the gap between the two
   page origins, and every epoch is listed in the export. */
const CLOCK = {
  pageOrigin: (typeof performance !== "undefined" && performance.timeOrigin) ? performance.timeOrigin : Date.now() - performance.now(),
  origin: null, offset: 0, epochs: [],
  init(sessionOrigin) {
    this.origin = sessionOrigin || this.pageOrigin;
    this.offset = this.pageOrigin - this.origin;
    this.epochs.push({ epoch: this.epochs.length, page_time_origin_ms: this.pageOrigin,
      page_time_origin_iso: new Date(this.pageOrigin).toISOString(), offset_ms: +this.offset.toFixed(3) });
  },
  /* After a reload: keep the session's origin and its earlier epochs. */
  resume(sessionOrigin, epochs) {
    this.origin = sessionOrigin; this.offset = this.pageOrigin - sessionOrigin;
    this.epochs = (epochs || []).slice();
    this.epochs.push({ epoch: this.epochs.length, page_time_origin_ms: this.pageOrigin,
      page_time_origin_iso: new Date(this.pageOrigin).toISOString(), offset_ms: +this.offset.toFixed(3), resumed: true });
  },
  t() { return +(performance.now() + this.offset).toFixed(3); },
  fromPerf(x) { return (x === undefined || x === null) ? null : +(x + this.offset).toFixed(3); },
  iso(t) { return new Date(this.origin + (t === undefined ? this.t() : t)).toISOString(); },
  describe() {
    return { session_time_origin_ms: this.origin, session_time_origin_iso: new Date(this.origin).toISOString(),
      clock: "t_perf = performance.now() + epoch offset, in ms since session_time_origin; utc_ms = session_time_origin_ms + t_perf",
      epochs: this.epochs, recorded_at_t_perf: this.t() };
  }
};
CLOCK.init();

/* =========================================================================
   v5 · ON-DEVICE STORE (IndexedDB)
   -------------------------------------------------------------------------
   localStorage holds ~5 MB and blocks the page; a 45-minute session now
   produces 100+ MB of video and ~100k timing rows. All of it goes to
   IndexedDB as it is produced, so a crash, a closed lid or a dead battery
   loses at most the last few seconds, and nothing depends on the network
   being up at the time.
     rows    stream rows, flushed in batches        {sid, stream, batch, rows}
     chunks  MediaRecorder chunks, ~5 s each        {sid, seg, n, t0, t1, blob}
     outbox  files waiting for upload to Drive      {sid, path, mime, blob, sha256, size, state}
     meta    one record per session on this device  {sid, ...}
   ========================================================================= */
const IDB = (function () {
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      let r;
      try { r = indexedDB.open("glide_v5", 1); } catch (e) { return rej(e); }
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains("rows"))   d.createObjectStore("rows",   { keyPath:"k" }).createIndex("sid", "sid");
        if (!d.objectStoreNames.contains("chunks")) d.createObjectStore("chunks", { keyPath:"k" }).createIndex("sid", "sid");
        if (!d.objectStoreNames.contains("outbox")) d.createObjectStore("outbox", { keyPath:"k" }).createIndex("sid", "sid");
        if (!d.objectStoreNames.contains("meta"))   d.createObjectStore("meta",   { keyPath:"sid" });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  const tx = (store, mode, fn) => open().then(d => new Promise((res, rej) => {
    const t = d.transaction(store, mode), s = t.objectStore(store);
    let out; try { out = fn(s); } catch (e) { return rej(e); }
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
    t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error("abort"));
  }));
  return {
    ok: typeof indexedDB !== "undefined",
    put(store, v) { return tx(store, "readwrite", s => s.put(v)); },
    get(store, k) { return tx(store, "readonly", s => s.get(k)); },
    del(store, k) { return tx(store, "readwrite", s => s.delete(k)); },
    bySid(store, sid) { return tx(store, "readonly", s => s.index("sid").getAll(sid)); },
    all(store) { return tx(store, "readonly", s => s.getAll()); },
    delSid(store, sid) {
      return open().then(d => new Promise((res, rej) => {
        const t = d.transaction(store, "readwrite"), ix = t.objectStore(store).index("sid");
        const c = ix.openCursor(IDBKeyRange.only(sid));
        c.onsuccess = () => { const cur = c.result; if (cur) { cur.delete(); cur.continue(); } };
        t.oncomplete = () => res(); t.onerror = () => rej(t.error);
      }));
    }
  };
})();

/* Free space, checked before a session with video starts. */
async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      let persisted = null;
      try { persisted = navigator.storage.persist ? await navigator.storage.persist() : null; } catch (x) {}
      return { quota_bytes: e.quota || null, usage_bytes: e.usage || null,
        free_bytes: (e.quota && e.usage !== undefined) ? e.quota - e.usage : null, persisted };
    }
  } catch (e) {}
  return { quota_bytes:null, usage_bytes:null, free_bytes:null, persisted:null };
}

/* =========================================================================
   v5 · STREAMS
   -------------------------------------------------------------------------
   Every time-series the session produces is a named stream of flat rows with
   a fixed column list. The column list IS the export schema (and the data
   dictionary is checked against it), so a CSV can never silently gain or lose
   a column between sessions.
   ========================================================================= */
const STREAM_COLS = {
  events:       ["t_perf","type","screen_id","block","detail"],
  frames:       ["frame_index","t_perf","media_time_s","capture_time_perf","expected_display_time_perf",
                 "presented_frames","dropped_before","segment","width","height"],
  face_quality: ["t_perf","frame_index","face_detected","box_x","box_y","box_w","box_h","img_w","img_h",
                 "landmark_confidence","yaw_deg","pitch_deg","roll_deg","ear_left","ear_right","eyes_closed",
                 "interocular_px","distance_ratio","face_brightness","bg_brightness","screen_id"],
  gaze:         ["t_perf","x","y","valid","screen_id","phase"],
  calibration:  ["attempt","kind","point_index","order","target_x","target_y","onset_t_perf","click_t_perf",
                 "offset_t_perf","n_samples","median_x","median_y","error_px","error_deg","samples_json"],
  aoi:          ["t_perf","screen_id","reason","aoi_id","selector","x","y","w","h","scroll_x","scroll_y","viewport_w","viewport_h"],
  pointer:      ["t_perf","type","x","y","buttons","pointer_type","target","screen_id"]
};

const STREAMS = (function () {
  const mem = {}, pend = {};
  Object.keys(STREAM_COLS).forEach(k => { mem[k] = []; pend[k] = []; });
  let batch = 0, sid = null, timer = null, failed = false;
  function flush() {
    if (!sid || !IDB.ok) return Promise.resolve();
    const jobs = [];
    Object.keys(pend).forEach(k => {
      if (!pend[k].length) return;
      const rows = pend[k]; pend[k] = [];
      const b = ++batch;
      jobs.push(IDB.put("rows", { k: sid + "|" + k + "|" + String(b).padStart(7, "0"), sid, stream:k, batch:b, rows })
        .catch(e => { failed = true; try { EV.log("storage_write_failed", { stream:k, error:String(e && e.message || e) }); } catch (x) {} }));
    });
    return Promise.all(jobs);
  }
  return {
    bind(s) { sid = s; if (!timer) timer = setInterval(flush, 4000); },
    push(k, row) { if (!mem[k]) return; mem[k].push(row); pend[k].push(row); },
    rows(k) { return mem[k] || []; },
    count(k) { return (mem[k] || []).length; },
    flush,
    writeFailed() { return failed; },
    /* After a crash: everything already flushed comes back, in order. */
    async restore(s) {
      sid = s;
      const got = await IDB.bySid("rows", s).catch(() => []);
      got.sort((a, b) => a.batch - b.batch);
      Object.keys(mem).forEach(k => { mem[k] = []; pend[k] = []; });
      got.forEach(b => { if (mem[b.stream]) mem[b.stream].push.apply(mem[b.stream], b.rows); batch = Math.max(batch, b.batch); });
      if (!timer) timer = setInterval(flush, 4000);
      return got.length;
    }
  };
})();

/* Events: screen changes, stimulus onsets, responses, breaks, flashes, focus
   loss, resizes, recorder state. One table, typed, so a video can be cut and
   labelled from it without reading the source. */
let CUR_SCREEN = { id:null, block:null };
const EV = {
  log(type, detail, t) {
    STREAMS.push("events", { t_perf: t === undefined ? CLOCK.t() : t, type,
      screen_id: CUR_SCREEN.id, block: CUR_SCREEN.block,
      detail: detail === undefined ? null : detail });
  }
};
