
/* =========================================================================
   v5 · STIMULUS ONSET, AREAS OF INTEREST, PASSIVE BEHAVIOUR
   -------------------------------------------------------------------------
   Without the boxes of what was on screen, a gaze coordinate or a video
   frame cannot be interpreted later. At every stimulus onset (stamped in
   requestAnimationFrame, i.e. the frame the browser commits) v5 logs:
     - the bounding box of every labelled region (aoi.csv), again on resize
       and scroll
     - the mean relative luminance of the stimulus area and of the whole
       viewport (needed if pupil size is ever used)
     - an exact snapshot of the stimulus DOM, de-duplicated by hash, so any
       saliency or clutter metric can be computed later on exactly what was
       shown (stimuli.json)
   Passive streams, camera-free and cheap: pointer position (a coarse gaze
   proxy on touch screens), hover dwell per option, focus loss, resizes.
   ========================================================================= */
const AOI_SELECTORS = [
  ["stage", "#stage"], ["panel", "#panel"], ["bar", "#bar"],
  ["card", "#stage .card"], ["mock", "#stage .mockwrap"], ["main_text", "#stage .mock .main"],
  ["sidebar", "#stage .mock .side"], ["ad", "#stage .ad"], ["bottom_bar", "#stage .bottom"],
  ["chat", "#stage .chat"], ["popup", "#stage .modal>div"], ["nav", "#stage .nav"],
  ["cal_target", "#stage .ctarget"], ["val_target", "#stage .valdot"], ["bs_fix", "#stage .bs .fix"], ["bs_ball", "#stage .bs .ball"],
  ["opt_pair", "#panel .pair button"], ["opt_face", "#panel .faces button"], ["opt", "#panel .opt"],
  ["tagged", "[data-aoi]"]
];
let LAST_AOI_SIG = null;
function captureAOI(reason) {
  const t = CLOCK.t(), out = [];
  const sx = Math.round(($("#stage") || {}).scrollTop || 0), sy = Math.round(($("#panel") || {}).scrollTop || 0);
  AOI_SELECTORS.forEach(([id, sel]) => {
    document.querySelectorAll(sel).forEach((n, i) => {
      const r = n.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      out.push({ t_perf:t, screen_id:CUR_SCREEN.id, reason,
        aoi_id: (n.getAttribute && n.getAttribute("data-aoi")) || (id + (i ? "_" + i : "")), selector: sel,
        x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
        scroll_x: sx, scroll_y: sy, viewport_w: innerWidth, viewport_h: innerHeight });
    });
  });
  const sig = JSON.stringify(out.map(o => [o.aoi_id, o.x, o.y, o.w, o.h]));
  if (reason !== "onset" && sig === LAST_AOI_SIG) return;     // nothing moved
  LAST_AOI_SIG = sig;
  out.forEach(o => STREAMS.push("aoi", o));
}

/* Mean relative luminance by sampling the painted background on a grid. Text
   ink is ignored (it is a few percent of the area); what matters for the
   pupil is the large-area light level. */
function meanLuminance(rect) {
  if (!rect || rect.width <= 0) return null;
  const cols = 24, rows = 16; let s = 0, n = 0;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x = rect.left + (i + 0.5) * rect.width / cols, y = rect.top + (j + 0.5) * rect.height / rows;
    const node = document.elementFromPoint(x, y);
    if (!node) continue;
    const L = luminance(rgbToHex(effectiveBg(node)));
    if (L !== null) { s += L; n++; }
  }
  return n ? +(s / n).toFixed(4) : null;
}

const STIMULI = {};          // hash -> { first_screen, html, first_t_perf }
function snapshotStimulus() {
  const st = $("#stage"); if (!st) return null;
  const html = st.innerHTML.length > 250000 ? st.innerHTML.slice(0, 250000) + "<!-- truncated -->" : st.innerHTML;
  const h = hash(html);
  if (!STIMULI[h]) STIMULI[h] = { hash:h, first_screen: CUR_SCREEN.id, first_t_perf: CLOCK.t(), html };
  return h;
}

/* Called by the router once per screen entry. */
function onStimulusOnset(screen) {
  requestAnimationFrame(rt => {
    const t = CLOCK.fromPerf(rt);
    const stageRect = ($("#left") || document.body).getBoundingClientRect();
    const lum = { stimulus_area: meanLuminance(stageRect),
                  viewport: meanLuminance({ left:0, top:0, width:innerWidth, height:innerHeight }) };
    const h = snapshotStimulus();
    EV.log("stimulus_onset", { screen: screen.id, block: screen.block, stimulus_dom_hash: h,
      mean_rel_luminance: lum, frame_index: FRAMES.current(), params: Object.assign({}, P) }, t);
    captureAOI("onset");
  });
}

/* --------------------------------------------------------------- hover */
const HOVER = (function () {
  let cur = {}, over = null, since = 0;
  const label = n => (n.getAttribute("data-opt") || n.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
  function close() { if (over) { const k = label(over); cur[k] = cur[k] || { ms:0, entries:0 }; cur[k].ms += performance.now() - since; over = null; } }
  document.addEventListener("pointerover", e => {
    const b = e.target.closest && e.target.closest("#panel button, #stage button");
    if (b === over) return;
    close();
    if (b) { over = b; since = performance.now(); const k = label(b); cur[k] = cur[k] || { ms:0, entries:0 }; cur[k].entries++; }
  }, true);
  return {
    snapshot() { close(); if (over) since = performance.now();
      const o = {}; Object.keys(cur).forEach(k => o[k] = { ms: Math.round(cur[k].ms), entries: cur[k].entries }); return o; },
    reset() { close(); cur = {}; }
  };
})();

/* ---------------------------------------------------- passive listeners */
(function () {
  let lastMove = 0;
  const target = e => { const n = e.target; if (!n || !n.closest) return null;
    const b = n.closest("button, input, select, textarea, .card, .mockwrap, #stage, #panel");
    return b ? (b.id ? "#" + b.id : b.tagName.toLowerCase() + (b.className ? "." + String(b.className).split(" ")[0] : "")) : null; };
  const push = (type, e) => STREAMS.push("pointer", { t_perf: CLOCK.fromPerf(e.timeStamp) || CLOCK.t(), type,
    x: Math.round(e.clientX), y: Math.round(e.clientY), buttons: e.buttons, pointer_type: e.pointerType || null,
    target: target(e), screen_id: CUR_SCREEN.id });
  addEventListener("pointermove", e => { if (e.timeStamp - lastMove < 50) return; lastMove = e.timeStamp; push("move", e); }, { passive:true });
  addEventListener("pointerdown", e => push("down", e), { passive:true });
  addEventListener("pointerup",   e => push("up", e),   { passive:true });
  document.addEventListener("visibilitychange", () => EV.log("visibility", { state: document.visibilityState }));
  addEventListener("blur",  () => EV.log("window_blur", {}));
  addEventListener("focus", () => EV.log("window_focus", {}));
  let rz = null;
  addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => {
    EV.log("resize", { viewport_w: innerWidth, viewport_h: innerHeight, dpr: devicePixelRatio,
      zoom_estimate: +(outerWidth / innerWidth).toFixed(3) });
    captureAOI("resize"); }, 150); });
  const sc = {};
  ["stage", "panel"].forEach(id => {
    const n = document.getElementById(id); if (!n) return;
    n.addEventListener("scroll", () => { clearTimeout(sc[id]); sc[id] = setTimeout(() => {
      EV.log("scroll", { target: id, scroll_top: Math.round(n.scrollTop), scroll_left: Math.round(n.scrollLeft) });
      captureAOI("scroll"); }, 120); }, { passive:true });
  });
})();
