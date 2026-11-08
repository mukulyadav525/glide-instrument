
/* =========================================================================
   v5 · CAMERA, RECORDING, FRAME CLOCK, FACE QUALITY
   -------------------------------------------------------------------------
   One camera, opened once, after consent is logged. Three consumers share it:

     REC     MediaRecorder writing the face video (only with video consent)
     FRAMES  requestVideoFrameCallback logging every presented frame on the
             shared clock: this is what lets any later analysis put a frame
             index next to any stimulus onset, response or calibration target
     WebGazer, which is handed a clone of the same stream (see GAZE.init) so
             the camera is never opened twice at two different resolutions

   What was ASKED for and what was GOT are logged separately. School laptops
   routinely offer 640x480 at 15 fps when asked for 720p30, and the analysis
   has to know which it received.
   ========================================================================= */
const PROTOCOL = {
  /* Pre-declared acceptance thresholds. These are written into the data of
     every session, so exclusions are decided by rules fixed before collection,
     not chosen after looking at results. Change them ONLY before the first
     real session, and record the change in the protocol. */
  version: "glide-p1-thresholds-1",
  validation_max_deg: 5.0,          // accuracy
  validation_max_loss: 0.30,        // share of expected samples missing
  max_recalibrations: 2,            // then gaze is skipped; video continues
  drift_max_deg: 2.5,               // one-point drift check before each gaze block
  face_min_share: 0.70,             // share of frames with a detected face
  usable_pose_max_yaw_deg: 20,
  usable_pose_max_pitch_deg: 20,
  dropped_frames_max_share: 0.10,
  ear_closed: 0.18                  // eye aspect ratio below which an eye counts as closed
};

const VIDEO_CFG = {
  ladder: [
    { name:"720p30", c:{ width:{ min:1280, ideal:1280 }, height:{ min:720, ideal:720 }, frameRate:{ ideal:30 } } },
    { name:"480p30", c:{ width:{ min:640,  ideal:640  }, height:{ min:480, ideal:480 }, frameRate:{ ideal:30 } } },
    { name:"any",    c:true }
  ],
  mimes: ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"],
  bitrate: 500000,          // ~3.7 MB/min: enough for offline face/eye models, small enough for a school laptop
  timeslice_ms: 5000,       // a crash loses at most this much
  segment_max_ms: 120000,   // each part file is self-contained and playable
  segment_min_ms: 15000     // do not cut a new file on every screen
};

const CAM = (function () {
  let stream = null, track = null, info = null, lost = false;
  const vid = () => document.getElementById("camview");
  return {
    get stream() { return stream; },
    live() { return !!(track && track.readyState === "live"); },
    lost() { return lost; },
    info() { return info; },
    async open() {
      if (this.live()) return true;
      const md = navigator.mediaDevices;
      if (!md || !md.getUserMedia) { info = { ok:false, reason:"getUserMedia_unavailable" }; EV.log("camera_open_failed", info); return false; }
      const attempts = [];
      for (const step of VIDEO_CFG.ladder) {
        try {
          const s = await md.getUserMedia({ video: step.c === true ? true : Object.assign({ facingMode:"user" }, step.c), audio:false });
          stream = s; track = s.getVideoTracks()[0];
          attempts.push({ step:step.name, ok:true });
          break;
        } catch (e) {
          attempts.push({ step:step.name, ok:false, error:(e && e.name) || String(e) });
          // Permission refusal will not improve further down the ladder.
          if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) break;
        }
      }
      if (!track) { info = { ok:false, reason:"no_stream", attempts }; EV.log("camera_open_failed", info); return false; }
      let caps = null; try { caps = track.getCapabilities ? track.getCapabilities() : null; } catch (e) {}
      info = { ok:true, attempts, requested: VIDEO_CFG.ladder.map(l => l.name),
        label: track.label || null,
        settings: track.getSettings ? track.getSettings() : null,   // what we GOT
        capabilities: caps, opened_t_perf: CLOCK.t() };
      track.addEventListener("ended", () => { lost = true; EV.log("camera_track_ended", {}); REC.onCameraLost(); IND.paint(); });
      track.addEventListener("mute",   () => EV.log("camera_track_muted", {}));
      track.addEventListener("unmute", () => EV.log("camera_track_unmuted", {}));
      const v = vid(); v.srcObject = stream;
      try { await v.play(); } catch (e) {}
      FRAMES.start();
      EV.log("camera_opened", { label: info.label, settings: info.settings, attempts });
      return true;
    },
    // Settings can change after open (the browser may renegotiate); re-read at export.
    settingsNow() { try { return track ? track.getSettings() : null; } catch (e) { return null; } },
    close() {
      FRAMES.stop();
      try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch (e) {}
      EV.log("camera_closed", {});
      stream = null; track = null;
    }
  };
})();

/* ------------------------------------------------------------ frame clock */
const FRAMES = (function () {
  let on = false, idx = 0, lastPF = null, dropped = 0, gaps = [], handle = null;
  function cb(now, md) {
    if (!on) return;
    const t = CLOCK.t();
    idx++;
    let gap = 0;
    if (lastPF !== null && md.presentedFrames > lastPF + 1) { gap = md.presentedFrames - lastPF - 1; dropped += gap; gaps.push(gap); }
    lastPF = md.presentedFrames;
    STREAMS.push("frames", {
      frame_index: idx, t_perf: t,
      media_time_s: md.mediaTime !== undefined ? +md.mediaTime.toFixed(4) : null,
      capture_time_perf: md.captureTime !== undefined ? CLOCK.fromPerf(md.captureTime) : null,
      expected_display_time_perf: md.expectedDisplayTime !== undefined ? CLOCK.fromPerf(md.expectedDisplayTime) : null,
      presented_frames: md.presentedFrames, dropped_before: gap,
      segment: REC.segmentNo(), width: md.width, height: md.height });
    handle = vid().requestVideoFrameCallback(cb);
  }
  const vid = () => document.getElementById("camview");
  return {
    supported() { return !!(HTMLVideoElement.prototype.requestVideoFrameCallback); },
    start() {
      if (on) return; if (!this.supported()) { EV.log("frame_callback_unsupported", {}); return; }
      on = true; handle = vid().requestVideoFrameCallback(cb);
    },
    stop() { on = false; try { if (handle !== null) vid().cancelVideoFrameCallback(handle); } catch (e) {} },
    current() { return idx; },
    /* After a reload, frame numbering continues where it stopped, so
       frame_index stays unique for the whole session. */
    setBase(n) { if (n > idx) { idx = n; lastPF = null; } },
    summary() {
      const rows = STREAMS.rows("frames");
      if (rows.length < 2) return { frames: rows.length, supported: this.supported() };
      const dur = (rows[rows.length - 1].t_perf - rows[0].t_perf) / 1000;
      const pfSpan = rows[rows.length - 1].presented_frames - rows[0].presented_frames + 1;
      const totalDropped = rows.reduce((a, r) => a + (r.dropped_before || 0), 0);
      let longestGapMs = 0;
      for (let i = 1; i < rows.length; i++) longestGapMs = Math.max(longestGapMs, rows[i].t_perf - rows[i - 1].t_perf);
      return { frames: rows.length, duration_s: +dur.toFixed(1), achieved_fps: +(rows.length / dur).toFixed(2),
        presented_frames_span: pfSpan, dropped_frames: totalDropped,
        dropped_share: pfSpan ? +(totalDropped / pfSpan).toFixed(4) : null,
        longest_gap_ms: Math.round(longestGapMs), supported: this.supported() };
    }
  };
})();

/* --------------------------------------------------------------- recorder */
const REC = (function () {
  let rec = null, mime = null, seg = 0, segStart = null, chunkN = 0, segReason = null, segBlobs = [],
      segTimer = null, wanted = false, failures = 0, sid = null, stopping = null, deleted = false;
  const segments = [];
  const ext = () => (mime || "").indexOf("mp4") >= 0 ? "mp4" : "webm";
  function chooseMime() {
    if (typeof MediaRecorder === "undefined") return null;
    for (const m of VIDEO_CFG.mimes) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) {} }
    return "";
  }
  function startSegment(reason) {
    if (!CAM.live() || deleted) return false;
    seg++; chunkN = 0; segBlobs = []; segReason = reason;
    try {
      rec = new MediaRecorder(CAM.stream, mime ? { mimeType:mime, videoBitsPerSecond:VIDEO_CFG.bitrate } : { videoBitsPerSecond:VIDEO_CFG.bitrate });
    } catch (e) { failures++; EV.log("recorder_create_failed", { error:String(e && e.message || e) }); return false; }
    const mySeg = seg, myRec = rec;
    let myN = 0;      // per-recorder: parts overlap, so a shared counter would interleave
    const meta = { segment: mySeg, file: "video/part_" + String(mySeg).padStart(3, "0") + "." + ext(),
      reason_start: reason, start_t_perf: null, stop_t_perf: null, first_chunk_t_perf: null,
      chunks: 0, bytes: 0, reason_stop: null, screen_at_start: CUR_SCREEN.id, block: CUR_SCREEN.block, mime: myRec.mimeType || mime };
    segments.push(meta);
    myRec.onstart = () => { meta.start_t_perf = CLOCK.t(); meta.first_frame_index_at_start = FRAMES.current(); EV.log("recording_segment_start", { segment: mySeg, reason }); IND.paint();
      // Persist segment metadata at once: a crash before the next screen change must not lose its start time.
      try { saveBackup(); } catch (e) {} };
    myRec.ondataavailable = ev => {
      if (!ev.data || !ev.data.size) return;
      const t = CLOCK.t(), n = ++myN; chunkN = myN;
      if (meta.first_chunk_t_perf === null) meta.first_chunk_t_perf = t;
      meta.chunks = n; meta.bytes += ev.data.size;
      if (mySeg === seg) segBlobs.push(ev.data);
      IDB.put("chunks", { k: sid + "|" + String(mySeg).padStart(3, "0") + "|" + String(n).padStart(5, "0"),
        sid, seg: mySeg, n, t_perf: t, size: ev.data.size, mime: myRec.mimeType || mime, blob: ev.data })
        .catch(e => EV.log("chunk_store_failed", { segment: mySeg, n, error: String(e && e.message || e) }));
    };
    myRec.onerror = ev => {
      failures++;
      EV.log("recorder_error", { segment: mySeg, error: String(ev && ev.error && ev.error.name || "unknown") });
      // One automatic restart per failure, after a beat; a failed chunk must not end recording for the session.
      if (wanted && failures <= 5) setTimeout(() => { if (wanted && (!rec || rec.state === "inactive")) startSegment("restart_after_error"); }, 1000);
    };
    myRec.onstop = () => finalize(meta, myRec);
    try { myRec.start(VIDEO_CFG.timeslice_ms); }
    catch (e) { failures++; EV.log("recorder_start_failed", { error:String(e && e.message || e) }); return false; }
    clearTimeout(segTimer);
    segTimer = setTimeout(() => rotate("max_length"), VIDEO_CFG.segment_max_ms);
    return true;
  }
  async function finalize(meta, r) {
    meta.stop_t_perf = CLOCK.t();
    EV.log("recording_segment_stop", { segment: meta.segment, reason: meta.reason_stop, chunks: meta.chunks, bytes: meta.bytes });
    if (deleted) return;
    // Read back from IndexedDB rather than trusting memory: after a reload the
    // in-memory list is empty but the chunks are all still there.
    let blobs = (meta.segment === seg) ? segBlobs.slice() : [];
    try {
      const all = await IDB.bySid("chunks", sid);
      const mine = all.filter(c => c.seg === meta.segment).sort((a, b) => a.n - b.n);
      if (mine.length >= blobs.length) blobs = mine.map(c => c.blob);
    } catch (e) {}
    if (!blobs.length) return;
    const blob = new Blob(blobs, { type: (meta.mime || "video/webm").split(";")[0] });
    meta.bytes = blob.size;
    await OUTBOX.add(meta.file, blob, (meta.mime || "video/webm").split(";")[0], { kind:"video", segment: meta.segment });
    // The outbox now owns the bytes; the chunks can go.
    try { const all = await IDB.bySid("chunks", sid); for (const c of all) if (c.seg === meta.segment) await IDB.del("chunks", c.k); } catch (e) {}
  }
  function stopCurrent(reason) {
    clearTimeout(segTimer);
    return stopRec(rec, segments[segments.length - 1], reason);
  }
  function stopRec(r, meta, reason) {
    if (!r || r.state === "inactive") return Promise.resolve();
    if (meta) meta.reason_stop = reason;
    return new Promise(res => {
      const prev = r.onstop;
      r.onstop = ev => { Promise.resolve(prev && prev(ev)).then(res, res); };
      try { r.requestData(); } catch (e) {}
      try { r.stop(); } catch (e) { res(); }
    });
  }
  /* The next part starts BEFORE the previous one stops, so consecutive parts
     overlap by a few frames instead of leaving a gap with no video. */
  function rotate(reason) {
    if (!wanted || !rec) return;
    const old = rec, oldMeta = segments[segments.length - 1];
    if (!startSegment(reason)) { stopRec(old, oldMeta, reason); return; }
    stopRec(old, oldMeta, reason);
  }
  return {
    segments,
    mime() { return mime; },
    segmentNo() { return rec && rec.state === "recording" ? seg : null; },
    recording() { return !!(rec && rec.state === "recording"); },
    wanted() { return wanted; },
    deleted() { return deleted; },
    failures() { return failures; },
    supported() { return typeof MediaRecorder !== "undefined"; },
    async start(sessionId, reason) {
      if (wanted) return true;
      sid = sessionId; mime = chooseMime();
      if (mime === null) { EV.log("recorder_unsupported", {}); return false; }
      wanted = true;
      EV.log("recording_requested", { mime, bitrate: VIDEO_CFG.bitrate, timeslice_ms: VIDEO_CFG.timeslice_ms });
      const ok = startSegment(reason || "consent");
      IND.paint();
      return ok;
    },
    /* Called by the router on every screen change. A new part file at a block
       boundary means a later analysis can fetch "the distractor block" without
       decoding the whole session. */
    onScreen(block) {
      if (!wanted || !rec || rec.state !== "recording") return;
      const meta = segments[segments.length - 1];
      if (!meta) return;
      if (meta.block !== block && meta.start_t_perf !== null && CLOCK.t() - meta.start_t_perf >= VIDEO_CFG.segment_min_ms) rotate("block_change:" + block);
      else if (meta.block !== block) meta.blocks_spanned = (meta.blocks_spanned || [meta.block]).concat(block).filter((v, i, a) => a.indexOf(v) === i);
    },
    async stop(reason) {
      wanted = false;
      await stopCurrent(reason || "session_end");
      IND.paint();
    },
    onCameraLost() {
      if (!wanted) return;
      const meta = segments[segments.length - 1];
      if (meta) meta.reason_stop = "camera_lost";
      IND.paint();
    },
    /* Withdrawal with "delete video": stop at once, drop every chunk and every
       queued part file for this session, and remember that it happened. */
    async deleteAll() {
      deleted = true; wanted = false;
      clearTimeout(segTimer);
      try { if (rec && rec.state !== "inactive") rec.stop(); } catch (e) {}
      try { await IDB.delSid("chunks", sid); } catch (e) {}
      await OUTBOX.dropVideo(sid);
      segBlobs = [];
      EV.log("video_deleted_locally", { segments: segments.length });
      IND.paint();
    },
    /* After a crash: chunks of an interrupted segment are still in IndexedDB.
       Assemble them into a (truncated but playable) part file and queue it. */
    async salvage(sessionId, metaSegments) {
      sid = sessionId;
      const all = await IDB.bySid("chunks", sid).catch(() => []);
      const segs = {};
      all.forEach(c => { (segs[c.seg] = segs[c.seg] || []).push(c); });
      const ids = Object.keys(segs).map(Number).sort((a, b) => a - b);
      for (const s of ids) {
        const cs = segs[s].sort((a, b) => a.n - b.n);
        const m = (cs[0].mime || "video/webm").split(";")[0];
        const blob = new Blob(cs.map(c => c.blob), { type:m });
        const file = "video/part_" + String(s).padStart(3, "0") + (m.indexOf("mp4") >= 0 ? ".mp4" : ".webm");
        await OUTBOX.add(file, blob, m, { kind:"video", segment:s, salvaged:true });
        for (const c of cs) await IDB.del("chunks", c.k);
        const known = (metaSegments || []).find(x => x.segment === s);
        if (known) { known.reason_stop = known.reason_stop || "crash_salvaged"; known.bytes = blob.size; known.chunks = cs.length; }
        else (metaSegments || []).push({ segment:s, file, reason_start:"unknown_before_crash", reason_stop:"crash_salvaged",
          start_t_perf:null, stop_t_perf:cs[cs.length - 1].t_perf, first_chunk_t_perf:cs[0].t_perf, chunks:cs.length, bytes:blob.size, mime:m,
          note:"t_perf values before a reload are on the previous page's clock; see clock_epochs" });
      }
      seg = Math.max(seg, ids.length ? ids[ids.length - 1] : 0, ...(metaSegments || []).map(x => x.segment || 0));
      if (metaSegments) metaSegments.forEach(m => { if (!segments.find(x => x.segment === m.segment)) segments.push(m); });
      segments.sort((a, b) => a.segment - b.segment);
      return ids.length;
    }
  };
})();

/* ------------------------------------------------------ recording indicator */
const IND = {
  paint() {
    const n = document.getElementById("recind"); if (!n) return;
    const rec = REC.recording(), lost = CAM.lost() && REC.wanted();
    n.classList.toggle("on", rec || lost);
    n.classList.toggle("lost", lost);
    n.querySelector("span").textContent = lost ? "Camera lost, not recording" : "Recording video";
  }
};

/* -------------------------------------------------------------- sync flash */
/* A single white frame, onset and offset stamped inside requestAnimationFrame
   (the moment the browser commits the frame), so the brightness step it puts
   on the child's face in the video can be matched to t_perf afterwards. */
const SYNC = {
  enabled: true,
  flash(label) {
    if (!this.enabled) { EV.log("sync_flash_skipped", { label }); return Promise.resolve(); }
    const n = document.getElementById("syncflash");
    return new Promise(res => {
      requestAnimationFrame(t0 => {
        n.classList.add("on");
        requestAnimationFrame(t1 => {
          EV.log("sync_flash_on", { label, frame_index: FRAMES.current() }, CLOCK.fromPerf(t1));
          setTimeout(() => requestAnimationFrame(t2 => {
            n.classList.remove("on");
            EV.log("sync_flash_off", { label, frame_index: FRAMES.current() }, CLOCK.fromPerf(t2));
            res();
          }), 250);
        });
      });
    });
  }
};

/* ------------------------------------------------------------ face quality */
/* WebGazer already runs a 468-point face mesh on every frame it processes;
   v5 reads its landmarks rather than running a second model. Hooked at the
   tracker's own detection call so a "no face" result is recorded as such
   instead of re-reporting the last good landmarks, which the tracker keeps.
   Head pose from landmark depth is approximate (degrees, +-5 or so); it is
   for flagging unusable stretches, not for analysis of head movement. */
const FACEQ = (function () {
  let hooked = false, last = 0, n = 0, baseIOD = null, baseDistCm = null, latest = null;
  const tiny = document.createElement("canvas"); tiny.width = 64; tiny.height = 36;
  const L = { lOut:33, lIn:133, lTop:159, lBot:145, rIn:362, rOut:263, rTop:386, rBot:374,
              nose:1, cheekL:234, cheekR:454, chin:152, brow:10 };
  const deg = r => +(r * 180 / Math.PI).toFixed(1);
  function measure(ok, pts, canvas) {
    const t = CLOCK.t();
    const row = { t_perf:t, frame_index:FRAMES.current(), face_detected:!!ok,
      box_x:null, box_y:null, box_w:null, box_h:null,
      img_w: canvas ? canvas.width : null, img_h: canvas ? canvas.height : null,
      landmark_confidence:null, yaw_deg:null, pitch_deg:null, roll_deg:null,
      ear_left:null, ear_right:null, eyes_closed:null, interocular_px:null, distance_ratio:null,
      face_brightness:null, bg_brightness:null, screen_id: CUR_SCREEN.id };
    if (ok && pts && pts.length >= 455) {
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
      row.box_x = Math.round(x0); row.box_y = Math.round(y0); row.box_w = Math.round(x1 - x0); row.box_h = Math.round(y1 - y0);
      const P = i => pts[i], d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
      const lc = [(P(L.lOut)[0] + P(L.lIn)[0]) / 2, (P(L.lOut)[1] + P(L.lIn)[1]) / 2];
      const rc = [(P(L.rOut)[0] + P(L.rIn)[0]) / 2, (P(L.rOut)[1] + P(L.rIn)[1]) / 2];
      row.interocular_px = +d(lc, rc).toFixed(1);
      row.roll_deg  = deg(Math.atan2(P(L.rOut)[1] - P(L.lOut)[1], P(L.rOut)[0] - P(L.lOut)[0]));
      row.yaw_deg   = deg(Math.atan2((P(L.cheekR)[2] || 0) - (P(L.cheekL)[2] || 0), P(L.cheekR)[0] - P(L.cheekL)[0]));
      row.pitch_deg = deg(Math.atan2((P(L.chin)[2] || 0) - (P(L.brow)[2] || 0), P(L.chin)[1] - P(L.brow)[1]));
      row.ear_left  = +(d(P(L.lTop), P(L.lBot)) / Math.max(1, d(P(L.lOut), P(L.lIn)))).toFixed(3);
      row.ear_right = +(d(P(L.rTop), P(L.rBot)) / Math.max(1, d(P(L.rOut), P(L.rIn)))).toFixed(3);
      row.eyes_closed = row.ear_left < PROTOCOL.ear_closed && row.ear_right < PROTOCOL.ear_closed;
      if (baseIOD) row.distance_ratio = +(baseIOD / row.interocular_px).toFixed(3);   // >1 = further away than at calibration
      // Brightness, every third row: a 64x36 thumbnail of the frame the tracker just used.
      if (canvas && (n % 3 === 0)) {
        try {
          const c = tiny.getContext("2d", { willReadFrequently:true });
          c.drawImage(canvas, 0, 0, 64, 36);
          const px = c.getImageData(0, 0, 64, 36).data;
          const sx = 64 / canvas.width, sy = 36 / canvas.height;
          const fx0 = Math.floor(x0 * sx), fx1 = Math.ceil(x1 * sx), fy0 = Math.floor(y0 * sy), fy1 = Math.ceil(y1 * sy);
          let fs = 0, fn = 0, bs = 0, bn = 0;
          for (let y = 0; y < 36; y++) for (let x = 0; x < 64; x++) {
            const i = (y * 64 + x) * 4, Y = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
            if (x >= fx0 && x <= fx1 && y >= fy0 && y <= fy1) { fs += Y; fn++; } else { bs += Y; bn++; }
          }
          row.face_brightness = fn ? Math.round(fs / fn) : null;
          row.bg_brightness = bn ? Math.round(bs / bn) : null;
        } catch (e) {}
      }
    }
    latest = row;
    n++;
    // At most ~15 rows/s, but never drop a change of detection state.
    if (t - last >= 66 || (STREAMS.count("face_quality") && STREAMS.rows("face_quality").slice(-1)[0].face_detected !== row.face_detected)) {
      STREAMS.push("face_quality", row); last = t;
    }
  }
  return {
    hook() {
      if (hooked) return true;
      try {
        const wg = window.webgazer, tr = wg && wg.getTracker ? wg.getTracker() : null;
        if (!tr || !tr.getEyePatches) return false;
        const orig = tr.getEyePatches.bind(tr);
        tr.getEyePatches = async function (canvas, a, b, c) {
          const r = await orig(canvas, a, b, c);
          try { measure(!!r, r ? tr.positionsArray : null, canvas); } catch (e) {}
          return r;
        };
        hooked = true; EV.log("face_quality_hooked", {});
        return true;
      } catch (e) { return false; }
    },
    latest() { return latest; },
    setBaseline(distCm) { if (latest && latest.interocular_px) { baseIOD = latest.interocular_px; baseDistCm = distCm || null;
      EV.log("interocular_baseline", { interocular_px: baseIOD, distance_cm: baseDistCm }); } return baseIOD; },
    baseline() { return { interocular_px: baseIOD, distance_cm: baseDistCm }; },
    summary() {
      const rows = STREAMS.rows("face_quality");
      if (!rows.length) return { rows:0 };
      const face = rows.filter(r => r.face_detected);
      const pose = face.filter(r => Math.abs(r.yaw_deg) < PROTOCOL.usable_pose_max_yaw_deg && Math.abs(r.pitch_deg) < PROTOCOL.usable_pose_max_pitch_deg);
      // Blinks: closed-eye runs, counted once per run.
      let blinks = 0, prev = false; face.forEach(r => { if (r.eyes_closed && !prev) blinks++; prev = !!r.eyes_closed; });
      let longest = 0, runStart = null;
      rows.forEach(r => { if (!r.face_detected) { if (runStart === null) runStart = r.t_perf; longest = Math.max(longest, r.t_perf - runStart); } else runStart = null; });
      const durMin = (rows[rows.length - 1].t_perf - rows[0].t_perf) / 60000;
      const iod = face.map(r => r.interocular_px).filter(x => x);
      return { rows: rows.length, face_share: +(face.length / rows.length).toFixed(4),
        usable_pose_share: +(pose.length / rows.length).toFixed(4),
        blinks, blink_rate_per_min: durMin > 0 ? +(blinks / durMin).toFixed(2) : null,
        longest_face_loss_ms: Math.round(longest),
        interocular_px_min: iod.length ? Math.min(...iod) : null, interocular_px_max: iod.length ? Math.max(...iod) : null,
        baseline: this.baseline(),
        note: "Sampled at up to 15 Hz from WebGazer's own face mesh. Pose angles are approximate (landmark depth), for flagging only." };
    }
  };
})();
