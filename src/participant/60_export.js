
/* =========================================================================
   v5 · SESSION LIFECYCLE, EXPORT, MANIFEST
   -------------------------------------------------------------------------
   One folder per session, the same layout on Drive and in the offline zip:

     participants/<child>/<mode>/<YYYY-MM-DD>_<session_id>/
        manifest.json  session.json  responses.csv  pairs.csv  events.csv
        gaze.csv  gaze_zones.csv  calibration.csv  aoi.csv  pointer.csv
        frames.csv  face_quality.csv  video_segments.csv  stimuli.json
        profile.json  data_dictionary.csv  video/part_001.webm ...

   The data dictionary is shipped inside every session folder, generated from
   the same source the instrument is built from, and every exported column is
   checked against it: a column without a definition is listed in the
   manifest rather than slipping through.
   ========================================================================= */
function localDate(iso) { const d = new Date(iso || Date.now()); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function serverMeta() {
  return { session_id: S.session_id, child_id: S.child_id || "anon", educator_id: S.educator_id || null, mode: S.mode,
    date: localDate(S.started_at), instrument_version: INSTRUMENT_VERSION, schema_version: SCHEMA_VERSION,
    consent_form_version: S.consent.form_version, retention_until: S.consent.retention_until,
    join_code: S.link.join_code || null, started_at: S.started_at };
}
function folderPath() { const m = serverMeta(); return "participants/" + m.child_id + "/" + m.mode + "/" + m.date + "_" + m.session_id; }

let PARTIAL_TIMER = null;
async function sessionStarted() {
  if (S.mode === "training" || S._started) return;
  S._started = true;
  S.session_time_origin_ms = CLOCK.origin;
  STREAMS.bind(S.session_id); OUTBOX.bind(S.session_id);
  await IDB.put("meta", { sid: S.session_id, server: serverMeta(), state: "running", started: S.started_at }).catch(() => {});
  EV.log("session_start", { session_id: S.session_id, mode: S.mode, joined: S.link.joined, clock: CLOCK.describe() });
  if (S.link.joined) LINK.startHeartbeat(statusNow);
  clearInterval(PARTIAL_TIMER);
  PARTIAL_TIMER = setInterval(writePartial, 300000);
}
/* Every 5 minutes: the responses so far, to Drive. If the laptop is lost or
   wiped mid-session, the admin still has most of the session. */
async function writePartial() {
  if (!S._started || S.completed_at) return;
  try {
    await OUTBOX.add("session.partial.json", new Blob([JSON.stringify({ partial:true, written_at:new Date().toISOString(),
      t_perf: CLOCK.t(), session: Object.assign({}, S, { derived: null }), streams_counts: streamCounts() })], { type:"application/json" }), "application/json", { kind:"partial" });
  } catch (e) {}
  saveStimuli();
}
function streamCounts() { const o = {}; Object.keys(STREAM_COLS).forEach(k => o[k] = STREAMS.count(k)); return o; }
let STIM_SAVE = null;
function saveStimuli() { clearTimeout(STIM_SAVE); STIM_SAVE = setTimeout(() => IDB.put("meta", { sid: S.session_id + "|stimuli", stimuli: STIMULI }).catch(() => {}), 1500); }

/* What the admin device sees, every 5 s. */
function statusNow() {
  const list = visible(), s = list[idx] || {};
  const fq = STREAMS.rows("face_quality"), recent = fq.filter(r => r.t_perf > CLOCK.t() - 30000);
  const fr = STREAMS.rows("frames"), fr10 = fr.filter(r => r.t_perf > CLOCK.t() - 10000);
  return { screen_id: s.id || null, block: s.block || null, index: idx + 1, total: list.length, mode: S.mode,
    child_id: S.child_id, elapsed_min: +((performance.now() - SESSION_T0) / 60000).toFixed(1),
    recording: REC.recording(), camera_lost: CAM.lost(), video_consented: S.video.consented, video_deleted: S.video.deleted,
    fps_10s: fr10.length > 1 ? +(fr10.length / ((fr10[fr10.length - 1].t_perf - fr10[0].t_perf) / 1000)).toFixed(1) : null,
    face_share_30s: recent.length ? +(recent.filter(r => r.face_detected).length / recent.length).toFixed(2) : null,
    gaze_health: GAZE.health(), gaze_on: gazeOn(), calibrated: GAZE.calibrated, calibration_attempts: S.calibration_attempts,
    validation_deg: GAZE.validation ? GAZE.validation.mean_error_deg : null,
    validation_meets_protocol: GAZE.validation ? !!GAZE.validation.meets_protocol : null,
    outbox: OUTBOX.stats(), storage_write_failed: STREAMS.writeFailed(),
    ended_early: S.ended_early, withdrawn: S.withdrawn, completed: !!S.completed_at, on_break: !!(S.breaks.length && !S.breaks[S.breaks.length - 1].end_t_perf),
    version: INSTRUMENT_VERSION, at: new Date().toISOString() };
}

/* ------------------------------------------------------- end and withdraw */
async function endEarly(reason, source) {
  S.ended_early = true; S.end_reason = reason || "not given";
  log("admin", "ended_early", true, { reason: S.end_reason, at_screen: (visible()[idx] || {}).id, source: source || "participant_laptop" });
  stopSpeak();
  try { leaving(visible()[idx]); } catch (e) {}
  idx = visible().length - 1;
  entering(visible()[idx], "end");
}
async function withdrawSession(reason, deleteVideo, source) {
  S.withdrawn = true; S.withdraw_reason = reason || "not given";
  S.ended_early = true; S.end_reason = "withdrawn";
  log("admin", "withdrawn", true, { reason: S.withdraw_reason, delete_video: !!deleteVideo, at_screen: (visible()[idx] || {}).id, source: source || "participant_laptop" });
  // Recording stops immediately, before anything else.
  if (deleteVideo && (REC.wanted() || REC.segments.length)) {
    S.video.deleted = true; S.video.delete_reason = "withdrawal"; S.video.deleted_at = new Date().toISOString();
    await REC.deleteAll();
    if (LINK.configured()) LINK.call("delete_video", { session: serverMeta(), reason: "withdrawal" }).then(
      () => { S.video.server_deleted = true; log("admin", "video_deleted_on_drive", true); },
      e => { S.video.server_delete_pending = true; log("admin", "video_delete_on_drive_failed", String(e && e.message || e)); });
  } else if (REC.wanted()) {
    await REC.stop("withdrawn");
  }
  stopSpeak();
  try { leaving(visible()[idx]); } catch (e) {}
  idx = visible().length - 1;
  entering(visible()[idx], "end");
}
LINK.on("stop", c => endEarly((c.args && c.args.reason) || "stopped from admin device", "admin_device"));
LINK.on("withdraw", c => withdrawSession((c.args && c.args.reason) || "withdrawn from admin device", !!(c.args && c.args.delete_video), "admin_device"));
LINK.on("message", c => { S._adminMsg = { text: (c.args && c.args.text) || "", at: Date.now() }; paint(); });
LINK.on("delete_video", c => { if (!S.video.deleted) { S.video.deleted = true; S.video.delete_reason = (c.args && c.args.reason) || "admin_request"; REC.deleteAll(); log("admin", "video_deleted_by_admin", true, c.args || {}); } });

/* ------------------------------------------------------------ finishing */
let FINISHING = null;
function finalizeSession() {
  if (FINISHING) return FINISHING;
  FINISHING = (async () => {
    // Sync marker first, then stop: the end flash must be inside the last part.
    if (REC.wanted() && REC.recording()) { await SYNC.flash("recording_end"); await REC.stop("session_end"); }
    try { GAZE.end(); } catch (e) {}
    setTimeout(() => { try { CAM.close(); } catch (e) {} }, 200);
    EV.log("session_end", { ended_early: S.ended_early, withdrawn: S.withdrawn });
    // The heartbeat keeps running until the outbox is empty (see below), so the
    // admin console shows the upload finishing, not a stale "waiting".
    clearInterval(PARTIAL_TIMER);
    await STREAMS.flush();
    if (S.mode === "training") return;
    const files = await buildFiles();
    for (const f of files) { try { await OUTBOX.add(f.path, f.blob, f.mime, { kind: f.kind || "data" }); } catch (e) {} }
    await IDB.put("meta", { sid: S.session_id, server: serverMeta(), state: "complete", started: S.started_at, completed: S.completed_at }).catch(() => {});
    if (S.link.joined) { try { await LINK.call("heartbeat", { session_id: S.session_id, status: statusNow() }); } catch (e) {} }
    OUTBOX.pump();
    S._saved = true;
    paint();
  })();
  return FINISHING;
}

/* ------------------------------------------------------------- the files */
function csvFor(file, cols, rows, missing) {
  const known = new Set(DATA_DICTIONARY.columns.filter(c => c[0] === file).map(c => c[1]));
  cols.forEach(c => { if (!known.has(c)) missing.push(file + ":" + c); });
  return csv(cols, rows);
}
function gazeRowsAnnotated() {
  const vals = (S.validations || []).slice().sort((a, b) => a.t_perf - b.t_perf);
  let j = -1;
  return STREAMS.rows("gaze").map(r => {
    while (j + 1 < vals.length && vals[j + 1].t_perf <= r.t_perf) j++;
    const v = j >= 0 ? vals[j] : null;
    return Object.assign({}, r, { calibration_attempt: v ? v.attempt : null, validation_error_deg: v ? v.mean_error_deg : null,
      validation_meets_protocol: v ? v.meets_protocol : null });
  });
}
function segmentRows() {
  const fr = STREAMS.rows("frames");
  return REC.segments.map(m => {
    const mine = fr.filter(r => r.segment === m.segment);
    return { segment: m.segment, file: m.file, mime: m.mime, reason_start: m.reason_start, reason_stop: m.reason_stop,
      start_t_perf: m.start_t_perf, first_chunk_t_perf: m.first_chunk_t_perf, stop_t_perf: m.stop_t_perf,
      first_frame_index: mine.length ? mine[0].frame_index : null, last_frame_index: mine.length ? mine[mine.length - 1].frame_index : null,
      chunks: m.chunks, bytes: m.bytes, screen_at_start: m.screen_at_start, block: m.block || null };
  });
}
async function buildFiles() {
  const o = out();
  const missing = [], files = [];
  const add = (path, text, mime, rows, kind) => files.push({ path, blob: new Blob([text], { type: mime }), mime, rows: rows === undefined ? null : rows, kind });

  const respCols = ["child_id","educator_id","session_id","mode","instrument_version","block","item","value","labels",
    "winner","loser","tie","comparison","distractor_id","page","variant","adaptation",
    "felt_load","passage","settings","gaze_usable","gaze_samples","duration_ms","outside_share",
    "latency_ms","session_elapsed_ms","ts","stimulus_hash","t_perf","frame_index","screen_id"];
  const resp = S.responses.map(r => Object.assign({}, r, { child_id:S.child_id, educator_id:S.educator_id, session_id:S.session_id, mode:S.mode, instrument_version:INSTRUMENT_VERSION }));
  add("responses.csv", csvFor("responses.csv", respCols, resp, missing), "text/csv", resp.length);

  if (isChild()) {
    const pc = ["child_id","dimension","item_a","item_b","winner","loser","tie","winner_position","latency_ms","stimulus_hash_a","stimulus_hash_b","ts","t_perf"];
    add("pairs.csv", csvFor("pairs.csv", pc, o.derived.pairwise_long, missing), "text/csv", o.derived.pairwise_long.length);
    const zc = ["child_id","screen","block","distractor_id","settings","passage","zone_id","x","y","w","h",
      "samples","share","dwell_ms","visits","first_entry_ms","validation_error_px","validation_error_deg","zone_separation_px","separation_exceeds_error","interpretable"];
    add("gaze_zones.csv", csvFor("gaze_zones.csv", zc, o.derived.gaze_zones, missing), "text/csv", o.derived.gaze_zones.length);
  }
  Object.keys(STREAM_COLS).forEach(k => {
    if (k === "gaze") {
      const cols = STREAM_COLS.gaze.concat(["calibration_attempt","validation_error_deg","validation_meets_protocol"]);
      const rows = gazeRowsAnnotated();
      add("gaze.csv", csvFor("gaze.csv", cols, rows, missing), "text/csv", rows.length);
    } else add(k + ".csv", csvFor(k + ".csv", STREAM_COLS[k], STREAMS.rows(k), missing), "text/csv", STREAMS.count(k));
  });
  const seg = segmentRows();
  add("video_segments.csv", csvFor("video_segments.csv", ["segment","file","mime","reason_start","reason_stop","start_t_perf","first_chunk_t_perf",
    "stop_t_perf","first_frame_index","last_frame_index","chunks","bytes","screen_at_start","block"], seg, missing), "text/csv", seg.length);
  add("stimuli.json", JSON.stringify({ note: "Exact #stage innerHTML at each distinct stimulus onset; styles are those of instrument_version.",
    instrument_version: INSTRUMENT_VERSION, stimuli: STIMULI }), "application/json", Object.keys(STIMULI).length);
  add("profile.json", JSON.stringify(o.derived.glide_profile, null, 2), "application/json");
  add("data_dictionary.csv", csv(["file","column","type","unit","description"],
    DATA_DICTIONARY.columns.map(c => ({ file:c[0], column:c[1], type:c[2], unit:c[3], description:c[4] }))), "text/csv", DATA_DICTIONARY.columns.length);
  add("session.json", JSON.stringify(o, null, 2), "application/json");

  // Manifest last: it describes everything above plus the video parts already queued.
  const entries = [];
  for (const f of files) entries.push({ path: f.path, bytes: f.blob.size, sha256: await sha256Hex(f.blob), rows: f.rows, kind: f.kind || "data" });
  const queued = await OUTBOX.list(S.session_id);
  queued.filter(q => q.kind === "video").sort((a, b) => a.path < b.path ? -1 : 1)
    .forEach(q => entries.push({ path: q.path, bytes: q.size, sha256: q.sha256, rows: null, kind: "video" }));
  const cam = S.video.camera || {};
  const manifest = {
    manifest_version: 1, schema_version: SCHEMA_VERSION, instrument_version: INSTRUMENT_VERSION,
    session_id: S.session_id, child_id: S.child_id, educator_id: S.educator_id, mode: S.mode,
    folder: folderPath(), started_at: S.started_at, completed_at: S.completed_at,
    ended_early: S.ended_early, end_reason: S.end_reason, withdrawn: S.withdrawn, withdraw_reason: S.withdraw_reason,
    consent: { form_version: S.consent.form_version, guardian_main: S.consent.guardian_main, guardian_gaze: S.consent.guardian_gaze,
      guardian_video: S.consent.guardian_video, guardian_audio: false, child_video: S.consent.child_video, child_gaze: S.consent.child_gaze,
      retention_until: S.consent.retention_until, source: S.link.joined ? "admin_device" : "participant_laptop" },
    video: { consented: S.video.consented, deleted: S.video.deleted, delete_reason: S.video.delete_reason, server_deleted: S.video.server_deleted || false,
      codec: REC.mime(), bitrate_bps: VIDEO_CFG.bitrate, timeslice_ms: VIDEO_CFG.timeslice_ms, segments: REC.segments.length,
      camera_label: cam.label || null, camera_settings_at_open: cam.settings || null, camera_settings_at_end: CAM.settingsNow(), audio: false },
    clock: CLOCK.describe(), protocol: PROTOCOL,
    physical: { px_per_mm: S.physical.px_per_mm, distance_cm: viewingDistanceCm().cm, distance_method: viewingDistanceCm().method },
    files: entries, dictionary_missing: missing,
    note: "Verify each file against sha256 before analysis. Video parts are self-contained; align them with frames.csv and video_segments.csv on t_perf."
  };
  files.push({ path: "manifest.json", blob: new Blob([JSON.stringify(manifest, null, 2)], { type:"application/json" }), mime: "application/json", kind: "manifest" });
  S._manifest = manifest;
  return files;
}

OUTBOX.onChange(st => {
  if (!S.completed_at || !S._manifest || !S.link.joined) return;
  if (st.pending === 0 && !S._finalBeat) {
    S._finalBeat = true;
    LINK.call("heartbeat", { session_id: S.session_id, status: statusNow() }).catch(() => {}).then(() => LINK.stopHeartbeat());
  }
});

/* Offline route: the whole session folder as one zip, same layout as Drive. */
async function downloadZip() {
  const items = await OUTBOX.list(S.session_id);
  const prefix = folderPath().split("/").slice(-1)[0] + "/";
  const files = items.filter(i => i.path !== "session.partial.json").map(i => ({ path: prefix + i.path, blob: i.blob }));
  if (!files.length) { alert("Nothing to save yet."); return; }
  const z = await ZIP.make(files);
  saveBlob(z, "application/zip", "glide_" + (S.child_id || "anon") + "_" + S.mode + "_" + localDate(S.started_at) + "_" + S.session_id + ".zip");
  S._zipped = true; log("admin", "zip_downloaded", true, { files: files.length, bytes: z.size }); paint();
}

/* ---------------------------------------------------------- v5 quality */
function v5Quality() {
  const fr = FRAMES.summary(), fq = FACEQ.summary();
  // Achieved fps per block, from screen_enter events.
  const ev = STREAMS.rows("events").filter(e => e.type === "screen_enter");
  const frames = STREAMS.rows("frames"), perBlock = {};
  ev.forEach((e, i) => {
    const t0 = e.t_perf, t1 = i + 1 < ev.length ? ev[i + 1].t_perf : (frames.length ? frames[frames.length - 1].t_perf : t0);
    const n = frames.filter(f => f.t_perf >= t0 && f.t_perf < t1).length;
    const b = perBlock[e.block || "none"] = perBlock[e.block || "none"] || { frames:0, ms:0 };
    b.frames += n; b.ms += Math.max(0, t1 - t0);
  });
  Object.keys(perBlock).forEach(k => { const b = perBlock[k]; b.achieved_fps = b.ms > 0 ? +(b.frames / (b.ms / 1000)).toFixed(2) : null; b.ms = Math.round(b.ms); });
  const drifts = (S.drift || []).map(d => d.offset_deg).filter(x => typeof x === "number");
  const flags = [];
  if (S.video.consented && !S.video.deleted) {
    if (fq.face_share !== undefined && fq.face_share < PROTOCOL.face_min_share) flags.push("Face visible in only " + Math.round(fq.face_share * 100) + "% of frames (rule: " + Math.round(PROTOCOL.face_min_share * 100) + "%)");
    if (fr.dropped_share !== undefined && fr.dropped_share > PROTOCOL.dropped_frames_max_share) flags.push("Dropped frames " + Math.round(fr.dropped_share * 100) + "%");
    if (fr.achieved_fps !== undefined && fr.achieved_fps < 20) flags.push("Camera ran at " + fr.achieved_fps + " fps");
    if (REC.failures()) flags.push("Recorder errors: " + REC.failures());
    if (CAM.lost()) flags.push("Camera was lost during the session");
  }
  if (fq.longest_face_loss_ms > 30000) flags.push("Face lost for " + Math.round(fq.longest_face_loss_ms / 1000) + " s at a stretch");
  if (drifts.length && Math.max(...drifts) > PROTOCOL.drift_max_deg) flags.push("Gaze drift up to " + Math.max(...drifts) + "° (limit " + PROTOCOL.drift_max_deg + "°)");
  const overrides = (S.framing || []).filter(f => !f.pass);
  if (overrides.length) flags.push("Framing check overridden " + overrides.length + "×: " + overrides.map(f => f.override || "no reason").join("; "));
  if (STREAMS.writeFailed()) flags.push("Some rows could not be written to this laptop's storage");
  if (S.calibration_attempts > 1) flags.push("Calibration attempts: " + S.calibration_attempts);
  // v5.1: the child could see their own face on these screens for this long.
  const pv = (S.preview && S.preview.shown_ms_by_screen) || {};
  const pvTotal = Object.values(pv).reduce((a, b) => a + b, 0);
  if (pvTotal > 0) flags.push("Camera preview shown on the child's screen for " + Math.round(pvTotal / 1000) + " s (see preview_shown events)");
  let remote = null; try { remote = REMOTE.summary(); } catch (e) {}
  return {
    preview: { mode_changes: (S.preview && S.preview.mode_changes) || [], shown_ms_by_screen: pv, shown_ms_total: Math.round(pvTotal) },
    educator_portal: Object.assign({ connections: (S.remote && S.remote.connections) || [] }, remote || {}),
    protocol: PROTOCOL, frames: fr, face: fq, per_block_video: perBlock,
    video: { consented: S.video.consented, deleted: S.video.deleted, segments: REC.segments.length, recorder_failures: REC.failures(), camera_lost: CAM.lost(), codec: REC.mime() },
    drift: { checks: S.drift || [], max_deg: drifts.length ? Math.max(...drifts) : null, over_limit: drifts.filter(x => x > PROTOCOL.drift_max_deg).length },
    framing: { checks: (S.framing || []).length, overrides: overrides.length },
    calibration_attempts: S.calibration_attempts,
    gaze_meets_protocol: GAZE.validation ? !!GAZE.validation.meets_protocol : null,
    breaks: S.breaks, flags
  };
}
