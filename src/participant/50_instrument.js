
/* =========================================================================
   WHAT THIS TRACKER CAN AND CANNOT MEASURE
   -------------------------------------------------------------------------
   WebGazer's own evaluation reports ~4.17 degrees of visual angle, about 169
   pixels, against a commercial reference. Independent validation finds it can
   discriminate screen quadrants and explicitly warns it is unsuited to
   eye-tracking-while-reading.

   Three consequences are built into the code below rather than left as
   caveats in a paper:

   1. REGIONS ARE COARSE. A paragraph band is ~39px tall; the error is larger
      than the whole passage. So areas of interest here are whole blocks
      (the text card, a distractor element, everything else), never lines or
      paragraphs, and each screen records the actual centre-to-centre
      separation of its zones so an analyst can see which contrasts the
      geometry could support.

   2. NO FIXATION OR REGRESSION MEASURES. A dispersion threshold smaller than
      the tracker's own noise segments noise, not fixations. Rayner-style
      regressions are an order of magnitude below this noise floor. Those
      fields are therefore not computed at all.

   3. DIFFERENCES, NOT POSITIONS. A constant per-participant offset cancels in
      a within-participant before/after contrast even though it ruins absolute
      localisation. That is the one thing this tracker is genuinely good for
      here, so the design protects it: validation before each read measures
      drift, and the two reads use different passages to keep a practice
      effect out of the contrast.
   ========================================================================= */
const GAZE = (function () {
  let wg = null, active = false, buf = [], started = 0, zones = [],
      health = null, probeTimer = null, initPromise = null;
  function lib() { return (typeof window !== "undefined" && window.webgazer) ? window.webgazer : null; }

  return {
    available() { return !!lib() && health !== "dead"; },
    calibrated: false,
    consent: null,          // "granted" | "declined" | null
    method: "webcam_webgazer_3.5.3",
    health() { return health; },
    healthReason: null,
    // Per-participant accuracy, filled in by the validation screen. Until it
    // exists, nothing downstream should claim a spatial resolution at all.
    validation: null,

    /* --------------------------------------------------------------- init
       Idempotent. begin() injects the WASM loader script; calling it twice
       injects it twice and the second run aborts the whole module, which
       presents as a dead camera for reasons unrelated to the camera. */
    init() {
      if (initPromise) return initPromise;
      wg = lib();
      if (!wg) { health = "dead"; this.healthReason = "library_absent"; return Promise.resolve(false); }
      try {
        wg.setRegression("ridge");
        // Smooths the prediction stream. The jitter term is what makes this
        // tracker unusable for fine measures, so any reduction in it is worth
        // taking; it costs nothing and is part of the library.
        if (wg.applyKalmanFilter) wg.applyKalmanFilter(true);
        if (wg.showVideoPreview) wg.showVideoPreview(false);
        if (wg.showPredictionPoints) wg.showPredictionPoints(false);
        if (wg.saveDataAcrossSessions) wg.saveDataAcrossSessions(false);  // no model carry-over between students
        /* v5: one camera. If the study camera is already open (video consent),
           WebGazer is handed a clone of that stream instead of opening the
           device a second time, downscaled on the clone to the 640x480 its
           model was tuned for. Ending WebGazer stops only the clone. */
        const md = navigator.mediaDevices, orig = md && md.getUserMedia ? md.getUserMedia.bind(md) : null;
        const share = async (c) => {
          if (!CAM.live()) { const ok = await CAM.open(); if (!ok) return orig(c); }
          const s = CAM.stream.clone();
          try { await s.getVideoTracks()[0].applyConstraints({ width:{ ideal:640 }, height:{ ideal:480 }, resizeMode:"crop-and-scale" }); } catch (e) {}
          EV.log("webgazer_stream_shared", { settings: s.getVideoTracks()[0].getSettings ? s.getVideoTracks()[0].getSettings() : null });
          return s;
        };
        if (orig) md.getUserMedia = share;
        const restore = () => { if (orig) md.getUserMedia = orig; };
        initPromise = Promise.resolve(wg.begin())
          .then(r => {
            restore(); FACEQ.hook();
            /* v5.1: WebGazer's begin() trains the model on EVERY click and
               mouse movement on the page by default. On this instrument the
               clicks are the educator's (the "they are looking" button, the
               answers), so each one taught the model that the child was
               looking at the button. That alone ruins a calibration. Only the
               explicit calibration samples below may train it. */
            try { if (wg.removeMouseEventListeners) wg.removeMouseEventListeners(); EV.log("webgazer_mouse_training_off", {}); } catch (e) {}
            return r;
          }, e => { restore(); throw e; })
          .then(() => this.probe())
          .catch(e => { restore(); health = "dead"; this.healthReason = "begin_failed:" + (e && e.message ? e.message : e); return false; });
        return initPromise;
      } catch (e) { health = "dead"; this.healthReason = "init_threw"; return Promise.resolve(false); }
    },

    /* -------------------------------------------------------------- probe
       isReady() goes true as soon as the camera opens, which is not the same
       as the face model having loaded. Only a real prediction proves that. */
    probe(ms) {
      wg = lib(); if (!wg) { health = "dead"; return Promise.resolve(false); }
      ms = ms || 8000;
      health = "probing";
      const self = this;
      return new Promise(resolve => {
        let got = 0, done = false;
        const finish = ok => {
          if (done) return; done = true;
          clearTimeout(probeTimer);
          try { wg.clearGazeListener && wg.clearGazeListener(); } catch (e) {}
          health = ok ? "live" : "dead";
          if (!ok && !self.healthReason) self.healthReason = "no_predictions_in_" + ms + "ms";
          resolve(ok);
        };
        try {
          wg.setGazeListener(d => { if (d && isFinite(d.x) && isFinite(d.y) && ++got >= 3) finish(true); });
        } catch (e) { return finish(false); }
        probeTimer = setTimeout(() => finish(false), ms);
      });
    },

    // One calibration target. WebGazer only derives eye features while its
    // loop runs, so it must not be paused when a point is recorded.
    calibratePoint(x, y) {
      wg = lib(); if (!wg) return;
      try { if (wg.resume) wg.resume(); } catch (e) {}
      try { if (wg.recordScreenPosition) wg.recordScreenPosition(x, y, "click"); } catch (e) {}
    },

    /* ---------------------------------------------------------- sampling */
    // Zones for the screen about to be shown: [{id, x, y, w, h}] in viewport
    // coordinates, the same frame WebGazer predicts in.
    setZones(z) { zones = (z || []).map(r => ({ id:r.id, x:r.x, y:r.y, w:r.w, h:r.h })); },

    /* v5: every prediction callback becomes a row in gaze.csv on the shared
       clock, INCLUDING the ones with no estimate (valid = false). Data loss is
       then a count, not a guess. Only ever called with gaze consent. */
    start(phase) {
      wg = lib(); if (!wg || health !== "live") return;
      buf = []; started = performance.now(); active = true; this.phase = phase || CUR_SCREEN.id;
      this.lost = 0; this.lostT = [];
      const self = this;
      EV.log("gaze_sampling_start", { phase: this.phase });
      try {
        if (wg.resume) wg.resume();
        wg.setGazeListener(d => {
          if (!active) return;
          const t = CLOCK.t();
          if (!d || !isFinite(d.x) || !isFinite(d.y)) {
            self.lost++; self.lostT.push(t);
            STREAMS.push("gaze", { t_perf:t, x:null, y:null, valid:false, screen_id:CUR_SCREEN.id, phase:self.phase });
            return;
          }
          const x = Math.round(d.x), y = Math.round(d.y);
          self.last = { x, y, t_perf: t };
          buf.push({ x, y, t: Math.round(performance.now() - started), t_perf: t });
          STREAMS.push("gaze", { t_perf:t, x, y, valid:true, screen_id:CUR_SCREEN.id, phase:self.phase });
        });
      } catch (e) {}
    },
    sampling() { return active; },
    lastPred() { return active ? this.last || null : null; },

    // Collect raw samples without zone analysis (used by validation).
    peek() { return buf.slice(); },
    lostCount(since) { return since === undefined ? (this.lost || 0) : (this.lostT || []).filter(t => t >= since).length; },
    /* Calibration training samples. WebGazer learns from each call. */
    train(x, y) {
      wg = lib(); if (!wg) return;
      try { if (wg.recordScreenPosition) wg.recordScreenPosition(x, y, "click"); } catch (e) {}
    },
    /* A recalibration starts the regression from scratch, so a failed first
       attempt cannot leak bad training points into the second. */
    resetModel() {
      wg = lib(); if (!wg) return;
      try { if (wg.clearData) wg.clearData(); } catch (e) {}
      this.calibrated = false; this.validation = null;
    },

    stop() {
      wg = lib();
      active = false;
      /* v5: the tracker is no longer paused between gaze screens. Its face mesh
         is what produces face_quality.csv, and a pause would leave holes in
         exactly the per-frame record the video depends on. */
      try { if (wg) { wg.clearGazeListener && wg.clearGazeListener(); } } catch (e) {}
      EV.log("gaze_sampling_stop", { phase: this.phase, samples: buf.length, lost: this.lost || 0 });
      const out = summarise(buf, zones, this.validation);
      out.samples_lost = this.lost || 0;
      out.data_loss_share = (buf.length + (this.lost || 0)) ? +((this.lost || 0) / (buf.length + (this.lost || 0))).toFixed(4) : null;
      out.samples_raw = buf.map(p => ({ x:p.x, y:p.y, t:p.t }));   // also in gaze.csv on the shared clock
      out.t_perf_start = buf.length ? buf[0].t_perf : null;
      zones = [];
      return out;
    },

    end() {
      wg = lib(); active = false;
      clearTimeout(probeTimer);
      try { if (wg) wg.clearGazeListener && wg.clearGazeListener(); } catch (e) {}
      // The render loop can fire once more against a torn-down video element
      // and throw an uncaught drawImage error; pausing first avoids it.
      try { if (wg && wg.pause) wg.pause(); } catch (e) {}
      setTimeout(() => { try { if (wg && wg.end) wg.end(); } catch (e) {} }, 60);
    }
  };

  /* ----------------------------------------------------------- summarise
     Deliberately short. Everything here is a proportion or a count over whole
     zones; nothing claims a resolution finer than the measured error. */
  function summarise(samples, z, val) {
    const n = samples.length;
    const out = {
      gaze_samples: n,
      gaze_usable: false,
      duration_ms: n ? Math.round(samples[n - 1].t) : 0,
      sampling_hz: (n > 1 && samples[n - 1].t > 0) ? +(n / (samples[n - 1].t / 1000)).toFixed(1) : null,
      // Carried onto every screen so no row can be read without its accuracy.
      validation_error_px: val ? val.mean_error_px : null,
      validation_error_deg: val ? val.mean_error_deg : null,
      zones: []
    };
    if (n < 10) return out;
    out.gaze_usable = true;

    const inside = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
    let assigned = 0;
    (z || []).forEach(r => {
      const own = [];
      samples.forEach((p, i) => { if (inside(p, r)) own.push(i); });
      assigned += own.length;
      // Visits: how many separate times gaze entered this zone. With this
      // error magnitude a "visit" is a coarse excursion, not a fixation.
      let visits = 0;
      for (let k = 0; k < own.length; k++) if (k === 0 || own[k] !== own[k - 1] + 1) visits++;
      out.zones.push({
        zone_id: r.id,
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h),
        samples: own.length,
        share: +(own.length / n).toFixed(4),
        dwell_ms: Math.round(own.length / n * out.duration_ms),
        visits: visits,
        first_entry_ms: own.length ? samples[own[0]].t : null
      });
    });
    out.outside_share = +(1 - assigned / n).toFixed(4);

    /* Centre-to-centre separation of the two largest zones, against this
       participant's measured error. If the zones are closer together than the
       tracker can resolve, the comparison between them is not interpretable,
       and saying so here is cheaper than discovering it in analysis. */
    if (z && z.length >= 2) {
      const c = z.map(r => ({ x:r.x + r.w / 2, y:r.y + r.h / 2 }));
      let sep = Infinity;
      for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++)
        sep = Math.min(sep, Math.hypot(c[i].x - c[j].x, c[i].y - c[j].y));
      out.zone_separation_px = Math.round(sep);
      out.separation_exceeds_error = (val && val.mean_error_px) ? sep > val.mean_error_px : null;
    }
    return out;
  }
})();

const $ = s => document.querySelector(s);
function announce(t) { try { const l = $("#live"); if (l) l.textContent = t; } catch (e) {} }

/* =========================================================================
   MOTION
   -------------------------------------------------------------------------
   Two of the six distractors ARE motion. An unconditional
   prefers-reduced-motion override would turn them into static elements and
   void their data without anyone noticing, so the preference is detected,
   acted on deliberately, surfaced to the educator and recorded.
   ========================================================================= */
const MOTION = (function () {
  let reduced = false;
  try { reduced = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) {}
  return {
    reduced() { return reduced; },
    apply() { document.body.classList.toggle("rm", reduced); },
    // Which distractors stop being what they claim to be.
    affected() { return reduced ? ["X2", "X5"] : []; }
  };
})();

/* ---------------------------------------------------------------- helpers */
const el = (t, a = {}, k = []) => {
  const n = document.createElement(t);
  for (const p in a) {
    if (p === "class") n.className = a[p];
    else if (p === "html") n.innerHTML = a[p];
    else if (p === "text") n.textContent = a[p];
    else if (p.startsWith("on")) n.addEventListener(p.slice(2), a[p]);
    else n.setAttribute(p, a[p]);
  }
  (Array.isArray(k) ? k : [k]).forEach(c => c && n.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
  return n;
};
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
let RNG = mulberry32(1);
const shuffle = a => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(RNG() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const uid = () => "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function hash(o){const s=JSON.stringify(o);let h=5381;for(let i=0;i<s.length;i++)h=((h<<5)+h+s.charCodeAt(i))|0;return"h"+(h>>>0).toString(16)}

/* -------------------------------------------------- speech (instructions) */
let VOICE_ON = true;
function say(text) {
  if (!VOICE_ON || !window.speechSynthesis) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.92; u.pitch = 1.0;
    speechSynthesis.speak(u);
  } catch (e) {}
}
function stopSpeak(){ try { speechSynthesis.cancel(); } catch(e){} }

/* ---------------------------------------------------------------- stimuli */
// Child passages, ~40 words, roughly grade 1-2, original text.
const KID_A = `The cat sat on the wall and watched the birds.
She did not move at all. Her tail went swish, swish.
One bird came close. The cat jumped up. The bird flew away fast.
The cat went back to the wall to wait.`;

const KID_B = `Sam found a box under his bed. It was full of old toys.
There was a red car with one wheel. There was a bear with no eyes.
Sam put them all back where he found them.
He liked knowing they were still there.`;

/* The two reading passages. They are matched on length, sentence count and
   vocabulary band so either can serve as baseline or adapted, and which one
   goes first is counterbalanced per participant. Reusing one passage for both
   reads would mean the second read is faster because it has been read before,
   in exactly the direction the hypothesis predicts. */
const READ_1 = `The old clock in the hall still works.
It ticks all day and rings each hour.
At night the house is quiet and you can hear it.
Nobody knows how old the clock really is.`;

const READ_2 = `The small boat is tied up by the bridge.
It rocks a little when the wind blows.
In the morning the man rows out to check his nets.
Nobody knows how far that boat has been.`;

const FONTS = [
  { id:"F1", css:'Arial, Helvetica, sans-serif',              adj:0.519, name:"Arial",     axis:"Control, the default nearly all pages use" },
  { id:"F2", css:'Verdana, Geneva, sans-serif',               adj:0.545, name:"Verdana",   axis:"Wide, generously spaced" },
  { id:"F3", css:'"Atkinson Hyperlegible", Arial, sans-serif',adj:0.529, name:"Atkinson",  axis:"Letterforms designed to be hard to confuse" },
  { id:"F4", css:'"Lexend", Arial, sans-serif',               adj:0.520, name:"Lexend",    axis:"Designed for reading fluency" }
];
const COLOURS = [
  { id:"C1", fg:"#000000", bg:"#FFFFFF", note:"Black on white (21:1)" },
  { id:"C2", fg:"#1A1A1A", bg:"#FAF8F4", note:"Warm off-white (16.4:1)" },
  { id:"C3", fg:"#E8E6E3", bg:"#121212", note:"Dark mode (14.9:1)" },
  { id:"C4", fg:"#12171C", bg:"#D6EAF5", note:"Blue background (18.1:1)" }
];
const SIZES = [16, 20, 24];
const LEADINGS = [1.0, 1.4, 1.8];
const SPACING = [0, 0.16];

const DISTRACTORS = [
  { id:"X1", name:"Still advert",              cfg:{ topAd:true },     zone:".ad" },
  { id:"X2", name:"Flashing advert",           cfg:{ animAd:true },    zone:".ad", motion:true },
  { id:"X3", name:"Pop-up box",                cfg:{ modal:true },     zone:".modal>div" },
  { id:"X4", name:"Bar stuck at the bottom",   cfg:{ bottomBar:true }, zone:".bottom" },
  { id:"X5", name:"Moving picture box",        cfg:{ carousel:true },  zone:".side", motion:true },
  { id:"X6", name:"Chat bubble in the corner", cfg:{ chat:true },      zone:".chat" }
];

const ADAPTATIONS = ["Change the letters","Make text bigger","More space between lines","More space between letters","Narrower column","Change the colours","Dark background","Remove adverts","Stop pop-ups","Stop things moving","Remove the side column","One column only","A line that follows where you read","Dim everything except this paragraph","Read it out loud","Use simpler words","Describe the pictures","A short summary first"];

/* =========================================================================
   ASCERTAINMENT
   -------------------------------------------------------------------------
   How we know a participant is neurodivergent, and on whose authority.

   This study administers NO diagnostic or screening instrument. Screening
   scales do not produce diagnoses, several are licensed rather than free, and
   administering them would turn a preference study into one that generates
   clinical claims about minors: different approval, different expertise.
   Determining a subtype or severity is a clinician's job.

   What is recorded instead is provenance. Everything below is TRANSCRIBED
   from existing documentation, never judged in the session, so every detail
   field defaults to "not specified" and leaving it there is the correct
   answer whenever the paperwork is silent.
   ========================================================================= */
const CONDITIONS = [
  { id:"adhd",   label:"ADHD",
    detailLabel:"Presentation recorded in the documentation",
    detail:["Predominantly inattentive","Predominantly hyperactive-impulsive","Combined","Not specified in the records"] },
  { id:"dyslex", label:"Dyslexia / reading difficulty",
    detailLabel:"Severity recorded in the documentation",
    detail:["Mild","Moderate","Severe","Not specified in the records"] },
  { id:"autism", label:"Autism spectrum",
    detailLabel:"Support level recorded in the documentation",
    detail:["Level 1","Level 2","Level 3","Not specified in the records"] },
  { id:"dyscal", label:"Dyscalculia", detail:null },
  { id:"dyspra", label:"Dyspraxia / DCD", detail:null },
  { id:"splang", label:"Speech and language", detail:null },
  { id:"intdis", label:"Intellectual disability", detail:null },
  { id:"other",  label:"Something else", detail:null },
  { id:"none",   label:"Not formally identified", detail:null },
  { id:"nosay",  label:"Prefer not to say", detail:null }
];

const DX_SOURCES = [
  { id:"clinical", label:"Formal diagnostic report",
    sub:"From a clinical psychologist, psychiatrist or paediatrician" },
  { id:"cert",     label:"Disability certificate or UDID card",
    sub:"Under the RPwD Act 2016. Specific learning disabilities and autism are certifiable; ADHD is not separately listed, so many students with ADHD will have no certificate" },
  { id:"school",   label:"School or district assessment record",
    sub:"An IEP, remedial-education record or equivalent held by the school" },
  { id:"medical",  label:"Medical records held by the school", sub:"" },
  { id:"parent",   label:"Parent or guardian report", sub:"Reported to the school, not independently documented" },
  { id:"educator", label:"Educator judgement only", sub:"No documentation of any kind" },
  { id:"selfid",   label:"The student identifies this way", sub:"" }
];
const DX_SEEN = ["Yes, I have it to hand","Yes, previously","No, it was reported to me","There is none"];
const DX_RECENCY = ["Within 12 months","1-3 years ago","More than 3 years ago","Unknown","Never assessed"];

/* Viewing distance, needed to express gaze error in degrees. Nobody can know
   it exactly, so it is asked as a band and the assumption travels with the
   number rather than being buried. */
const DISTANCE_BANDS = [
  { label:"About 40 cm (close)", cm:40 },
  { label:"About 60 cm (typical)", cm:60 },
  { label:"About 80 cm (far back)", cm:80 }
];

/* ------------------------------------------------------------------ state */
const S = {
  schema_version: SCHEMA_VERSION, instrument_version: INSTRUMENT_VERSION,
  mode: null, child_id: "", educator_id: "", session_id: uid(), seed: 0,
  started_at: new Date().toISOString(), completed_at: null,
  ended_early: false, end_reason: null, withdrawn: false, withdraw_reason: null,
  environment: {}, responses: [], derived: {},
  /* v5 */
  link: { joined:false, join_code:null, admin_session:null },   // set when started from the admin device
  consent: { form_version:null, guardian_main:null, guardian_gaze:null, guardian_video:null, guardian_audio:false,
             child_video:null, child_gaze:null, retention_until:null, logged_t_perf:{} },
  video: { consented:false, deleted:false, delete_reason:null, camera:null, storage_before:null },
  physical: { px_per_mm:null, card_match:null, blind_spot:null, distance_cm:null, distance_method:null,
              room_lighting:null, screen_brightness_confirmed:null },
  framing: [], drift: [], calibration_attempts: 0, breaks: []
};
const P = { fontId:"F1", fontCss:FONTS[0].css, fontAdj:FONTS[0].adj, sizePx:19, lineHeight:1.6, cpl:52, tracking:0, fg:"#1A1A1A", bg:"#FFFFFF" };
let ORDER = {}, answers = {}, idx = 0, screenEnter = 0;

function log(block, item, value, extra) {
  const t = CLOCK.t();
  S.responses.push(Object.assign({
    mode: S.mode, block, item,
    value: (value && typeof value === "object") ? JSON.parse(JSON.stringify(value)) : value,
    latency_ms: Math.round(performance.now() - screenEnter),
    session_elapsed_ms: Math.round(performance.now() - SESSION_T0),
    ts: new Date().toISOString(),
    // v5: the join key to frames, gaze, events and video.
    t_perf: t, frame_index: FRAMES.current() || null, screen_id: CUR_SCREEN.id,
    stimulus_params: Object.assign({}, P), stimulus_hash: hash(P)
  }, extra || {}));
  EV.log("response", { block, item }, t);
}
let SESSION_T0 = performance.now();
function mq(q){ try { return window.matchMedia ? matchMedia(q).matches : null; } catch(e){ return null; } }
function readEnv() {
  S.environment = { viewport_w:innerWidth, viewport_h:innerHeight, dpr:devicePixelRatio,
    zoom_estimate:+(outerWidth/innerWidth).toFixed(3), ua:navigator.userAgent,
    reduced_motion:mq("(prefers-reduced-motion: reduce)"), touch:navigator.maxTouchPoints>0,
    speech_available: !!window.speechSynthesis,
    fonts: FONTHEALTH.report(),
    // v5
    screen_w: screen.width, screen_h: screen.height, avail_w: screen.availWidth, avail_h: screen.availHeight,
    color_depth: screen.colorDepth, outer_w: outerWidth, outer_h: outerHeight,
    platform: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || null,
    mobile: navigator.userAgentData ? !!navigator.userAgentData.mobile : null,
    browser_brands: navigator.userAgentData ? navigator.userAgentData.brands : null,
    hardware_concurrency: navigator.hardwareConcurrency || null, device_memory_gb: navigator.deviceMemory || null,
    language: navigator.language, timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return null; } })(),
    tz_offset_min: new Date().getTimezoneOffset(),
    max_touch_points: navigator.maxTouchPoints || 0,
    prefers_dark: mq("(prefers-color-scheme: dark)"), forced_colors: mq("(forced-colors: active)"),
    secure_context: !!window.isSecureContext, origin: location.origin,
    media_recorder: typeof MediaRecorder !== "undefined", video_frame_callback: FRAMES.supported(),
    indexeddb: IDB.ok };
}

/* =========================================================================
   FONT HEALTH
   -------------------------------------------------------------------------
   The letters block only means anything if each of the four typefaces is a
   DIFFERENT typeface on screen. Two ways that breaks: an embedded webfont
   fails, or a system face named in the stack (Arial, Verdana) is not
   installed on the machine. Rather than detect each cause, this measures the
   thing that actually matters, whether any two of the four render identically,
   because that is the condition under which a comparison becomes two copies
   of the same specimen and the data becomes noise that looks valid.
   ========================================================================= */
const FONTHEALTH = (function () {
  let state = null, collide = [];
  function widthOf(css) {
    try {
      const c = document.createElement("canvas").getContext("2d");
      if (!c) return null;
      c.font = '72px ' + css;
      return c.measureText("Illegible 1lI0O gjpqy handwriting").width;
    } catch (e) { return null; }
  }
  return {
    check() {
      const out = {}, w = {}, pending = [];
      FONTS.forEach(f => { w[f.id] = widthOf(f.css); });
      const generic = widthOf("monospace");
      collide = [];
      FONTS.forEach((f, i) => {
        const named = (f.css.match(/^"([^"]+)"|^([A-Za-z][\w ]*)/) || []);
        const fam = (named[1] || named[2] || "").trim();
        let ok = true, why = null;
        if (/^"/.test(f.css)) {
          let loaded = null;
          try { loaded = document.fonts ? document.fonts.check('16px "' + fam + '"') : null; } catch (e) {}
          if (loaded === false) { ok = false; why = "webfont_not_loaded"; }
        }
        FONTS.forEach((g, j) => {
          if (j <= i || w[f.id] === null || w[g.id] === null) return;
          if (Math.abs(w[f.id] - w[g.id]) < 0.5) {
            collide.push([f.id, g.id]);
            ok = false; why = why || ("renders_identically_to_" + g.id);
            if (out[g.id]) { out[g.id].ok = false; out[g.id].why = out[g.id].why || ("renders_identically_to_" + f.id); }
            else pending.push([g.id, f.id]);
          }
        });
        out[f.id] = { family: fam || f.name, css: f.css, probe_width: w[f.id] === null ? null : +w[f.id].toFixed(2), ok, why };
      });
      pending.forEach(([id, other]) => { if (out[id] && out[id].ok) { out[id].ok = false; out[id].why = "renders_identically_to_" + other; } });
      if (generic !== null && FONTS.every(f => w[f.id] !== null && Math.abs(w[f.id] - generic) < 0.5))
        FONTS.forEach(f => { out[f.id].ok = false; out[f.id].why = "all_fonts_fell_back"; });
      state = out;
      return out;
    },
    /* document.fonts.ready resolves when nothing is PENDING, and an embedded
       face no element has used yet was never requested, so waiting on it alone
       measures the fallback and reports a false failure. Ask for each face. */
    ready() {
      if (!document.fonts || !document.fonts.load) return Promise.resolve();
      const want = [];
      FONTS.forEach(f => { const m = f.css.match(/^"([^"]+)"/); if (m) { want.push('400 16px "' + m[1] + '"'); want.push('700 16px "' + m[1] + '"'); } });
      return Promise.all(want.map(spec => document.fonts.load(spec).catch(() => null)))
        .then(() => document.fonts.ready).catch(() => null);
    },
    report() { return state || this.check(); },
    collisions() { this.report(); return collide; },
    failed() { const r = this.report(); return Object.keys(r).filter(k => !r[k].ok); },
    ok() { return this.failed().length === 0; }
  };
})();

/* --------------------------------------------------------- text rendering */
const _cv = document.createElement("canvas");
function cplToPx(cpl, css, size, adj) {
  const eff = size * (0.519 / adj);
  let avg = eff * 0.5;
  try { const c = _cv.getContext("2d"); if (c) { c.font = `${eff}px ${css}`; const s = "abcdefghijklmnopqrstuvwxyz aeiounst "; const m = c.measureText(s).width / s.length; if (m > 0) avg = m; } } catch (e) {}
  return Math.round(cpl * avg);
}
function effSize(size, adj) {
  if (typeof size !== "number" || typeof adj !== "number" || !adj) return P.sizePx || 19;
  return +(size * (0.519 / adj)).toFixed(1);
}
function textStyle(o) {
  const p = Object.assign({}, P, o || {});
  return { fontFamily:p.fontCss, fontSize:effSize(p.sizePx, p.fontAdj) + "px", lineHeight:p.lineHeight,
    letterSpacing:p.tracking + "em", color:p.fg, textAlign:"left",
    width: cplToPx(p.cpl, p.fontCss, p.sizePx, p.fontAdj) + "px", maxWidth:"100%" };
}
function specimen(o, text) {
  const b = el("div", { class:"spec" });
  Object.assign(b.style, textStyle(o));
  (text || KID_A).split("\n").forEach(line => line.trim() && b.appendChild(el("p", { text:line.trim() })));
  return b;
}
function card(inner, tag, o) {
  const p = Object.assign({}, P, o || {});
  const c = el("div", { class:"card" });
  c.style.background = p.bg;
  if (tag) c.appendChild(el("div", { class:"tag", text:tag }));
  c.appendChild(inner);
  return c;
}
function stage(nodes, note) {
  const s = $("#stage"); s.innerHTML = "";
  if (note) s.appendChild(el("div", { class:"note", text:note }));
  (Array.isArray(nodes) ? nodes : [nodes]).forEach(n => n && s.appendChild(n));
}

/* Zones for gaze, measured after layout. Whole blocks only: the error is
   larger than any line or paragraph, so finer zones would be fiction. */
function zonesFrom(spec) {
  requestAnimationFrame(() => {
    const out = [];
    (spec || []).forEach(z => {
      const n = document.querySelector(z.sel);
      if (!n) return;
      const r = n.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push({ id:z.id, x:r.left, y:r.top, w:r.width, h:r.height });
    });
    GAZE.setZones(out);
  });
}

function setBar(mode) {
  const b = $("#bar"); b.innerHTML = "";
  const mins = Math.floor((performance.now() - SESSION_T0) / 60000);
  // The protocol budgets 30-45 minutes per session and fatigue is a real
  // data-quality threat in this population, so elapsed time is always on
  // screen rather than something the educator has to track separately.
  const late = mins >= 45;
  if (mode === "off") {
    const t = (S.mode === "child" ? "child session" : S.mode === "training" ? "educator training" : "educator session") + (S.mode ? "  \u00b7  " + mins + " min" : "");
    const sp = el("span", { class:"sp", text:t });
    if (late) sp.style.color = "#F2C476";
    b.appendChild(sp);
    if (late && S.mode === "child") b.appendChild(el("span", { class:"v", text:"over 45 min, consider stopping" }));
    // v5: link and upload state, small, for the educator.
    if (S._started && S.mode !== "training") {
      const ob = OUTBOX.stats(), hb = LINK.lastHeartbeat();
      const linked = S.link.joined ? (hb && Date.now() - hb < 20000 ? "admin linked" : "admin link lost") : "offline session";
      b.appendChild(el("span", { class:"linkpill" + (S.link.joined && !(hb && Date.now() - hb < 20000) ? " bad" : ""),
        text: linked + " · " + ob.pending + " file" + (ob.pending === 1 ? "" : "s") + " to upload" }));
    }
    return;
  }
  const f = FONTS.find(x => x.id === P.fontId);
  const num = (v,d) => (typeof v === "number" && isFinite(v)) ? v.toFixed(d) : "-";
  [["face", f?f.name:"-"], ["size", effSize(P.sizePx,P.fontAdj)+"px"], ["leading", num(P.lineHeight,2)],
   ["spacing", P.tracking+"em"], ["ink", P.fg], ["ground", P.bg]]
    .forEach(([k,v]) => b.appendChild(el("span", {}, [el("span", { style:"opacity:.6", text:k+" " }), el("span", { class:"v", text:v })])));
  b.appendChild(el("span", { class:"sp", text:mins + " min \u00b7 live parameters" }));
}

/* ------------------------------------------------------------- mock pages */
function mock(cfg) {
  cfg = cfg || {};
  const w = el("div", { class:"mockwrap" });
  const m = el("div", { class:"mock" });
  if (cfg.nav) m.appendChild(el("div", { class:"nav" }, ["Home","Games","Videos","Help"].map(t => el("span", { text:t }))));
  const body = el("div", { class:"body" });
  const main = el("div", { class:"main" });
  main.appendChild(el("h3", { text:"How do bees find their way home?" }));
  if (cfg.topAd) main.appendChild(el("div", { class:"ad", text:"ADVERT" }));
  if (cfg.animAd) main.appendChild(el("div", { class:"ad an-gif", text:"★ ADVERT ★ PLAY NOW ★" }));
  const paras = [
    "A bee can fly a long way from its hive. It may go more than three miles to find flowers. Then it has to get home again.",
    "Bees use the sun like a map. They remember where the sun was when they left. They also remember trees, walls and other big things they passed.",
    "When a bee finds good flowers, it goes home and dances. The dance tells the other bees which way to fly and how far to go."
  ];
  paras.forEach((t, i) => {
    if (cfg.subheads && i === 1) main.appendChild(el("div", { style:"font-weight:700;margin:12px 0 5px", text:"Using the sun" }));
    main.appendChild(el("p", { text:t }));
    if (cfg.midAd && i === 0) main.appendChild(el("div", { class:"ad", text:"ADVERT" }));
  });
  body.appendChild(main);
  if (cfg.side || cfg.carousel) {
    const s = el("div", { class:"side" });
    if (cfg.side) { s.appendChild(el("div", { class:"ad", text:"ADVERT" })); s.appendChild(el("div", { class:"wid" }, [el("strong", { text:"Top stories" }), el("div", { text:"Why is the sky blue?" }), el("div", { text:"Ten facts about ants" })])); }
    if (cfg.carousel) s.appendChild(el("div", { class:"wid an-car" }, [el("strong", { text:"Pictures ▸" })]));
    body.appendChild(s);
  }
  m.appendChild(body);
  if (cfg.bottomBar) m.appendChild(el("div", { class:"bottom", text:"Sign up for our newsletter  ✕" }));
  w.appendChild(m);
  if (cfg.modal) w.appendChild(el("div", { class:"modal" }, [el("div", {}, [el("strong", { text:"Wait!" }), el("p", { text:"Join our club to keep reading." })])]));
  if (cfg.chat) w.appendChild(el("div", { class:"chat", text:"Chat" }));
  return w;
}

/* =========================================================================
   STIMULUS FEATURES
   -------------------------------------------------------------------------
   Every stimulus a student rates on the three-face scale is also MEASURED
   here, at the moment it is on screen, and the measurements are stored with
   the rating.

   Why this is not optional. The secondary aim fits the four CLS weights to
   preference data. That fit needs, for each rated stimulus, both a rating and
   the stimulus's feature values. Without the features stored, an analyst a
   year from now has a column of ratings against stimuli they can only
   reconstruct by reading this source and hand-coding what each mock page
   contained, inconsistently and unverifiably. Measuring at render time makes
   the calibration set self-contained and reproducible.

   The features are deliberately the same KIND the extension will compute from
   a real page's DOM, so this doubles as a first test of the page analyser on
   known stimuli. They are proxies, named as such, not the finished metric.
   ========================================================================= */
function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return null;
  const v = [0, 2, 4].map(i => {
    const c = parseInt(m[1].substr(i, 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function contrastRatio(fg, bg) {
  const a = luminance(fg), b = luminance(bg);
  if (a === null || b === null) return null;
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
}
/* Walk up for the first non-transparent background: the text element itself
   usually has none, and contrast measured against "transparent" is nonsense. */
function effectiveBg(node) {
  let n = node;
  while (n && n !== document.documentElement) {
    const c = getComputedStyle(n).backgroundColor;
    if (c && !/rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(c)) return c;
    n = n.parentElement;
  }
  return "rgb(255,255,255)";
}
function rgbToHex(c) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c || "");
  if (!m) return null;
  return "#" + [1, 2, 3].map(i => (+m[i]).toString(16).padStart(2, "0")).join("");
}
function pageFeatures(node) {
  if (!node) return null;
  const txt = (node.innerText || "").trim();
  const words = txt ? txt.split(/\s+/).filter(Boolean) : [];
  const sentences = txt ? txt.split(/[.!?]+/).map(x => x.trim()).filter(Boolean) : [];
  const rect = node.getBoundingClientRect();
  const area = Math.max(1, rect.width * rect.height);
  const all = node.querySelectorAll("*");

  // Elements whose job on the page is to compete for attention.
  const animated = node.querySelectorAll(".an-gif, .an-car, .an-bad");
  const ads      = node.querySelectorAll(".ad");
  const overlay  = node.querySelectorAll(".modal, .chat");
  const sticky   = node.querySelectorAll(".bottom, .nav");
  const side     = node.querySelectorAll(".side");
  const sumArea = list => { let a = 0; list.forEach(n => { const r = n.getBoundingClientRect(); a += r.width * r.height; }); return a; };
  const distractArea = sumArea(animated) + sumArea(ads) + sumArea(overlay) + sumArea(sticky);

  /* W is measured from what was actually RENDERED, not from the session's
     current parameters. The mock pages are drawn at their own fixed size and
     colours regardless of the student's chosen settings, so reading W off the
     session state would report the child's typography for a stimulus that
     never used it, and make W appear to vary between stimuli when the
     variation is really between children. */
  const textEl = node.querySelector(".spec, .main, p") || node;
  const cs = getComputedStyle(textEl);
  const fg = rgbToHex(cs.color), bg = rgbToHex(effectiveBg(textEl));
  const fontPx = parseFloat(cs.fontSize) || null;
  let lh = parseFloat(cs.lineHeight);
  if (!isFinite(lh)) lh = null; else if (fontPx) lh = +(lh / fontPx).toFixed(2);
  let ls = parseFloat(cs.letterSpacing);
  if (!isFinite(ls)) ls = 0; else if (fontPx) ls = +(ls / fontPx).toFixed(3);
  const tw = textEl.getBoundingClientRect().width;

  return {
    // T, text complexity proxies
    t_word_count: words.length,
    t_sentence_count: sentences.length,
    t_mean_words_per_sentence: sentences.length ? +(words.length / sentences.length).toFixed(2) : null,
    t_mean_word_length: words.length ? +(words.reduce((a, w) => a + w.length, 0) / words.length).toFixed(2) : null,
    t_long_word_share: words.length ? +(words.filter(w => w.replace(/[^A-Za-z]/g, "").length >= 8).length / words.length).toFixed(3) : null,
    // V, visual density proxies
    v_element_count: all.length,
    v_elements_per_10k_px2: +((all.length / area) * 10000).toFixed(3),
    v_block_count: node.querySelectorAll("p, h1, h2, h3, div.wid, div.ad").length,
    v_text_density: +((txt.length / area) * 10000).toFixed(3),
    v_has_sidebar: side.length > 0,
    // W, presentation, read off the rendered element
    w_font_size_px: fontPx === null ? null : +fontPx.toFixed(1),
    w_line_height: lh,
    w_letter_spacing_em: ls,
    w_contrast_ratio: contrastRatio(fg, bg),
    w_font_family: (cs.fontFamily || "").split(",")[0].replace(/["']/g, "").trim(),
    w_text_block_width_px: Math.round(tw),
    w_est_chars_per_line: (fontPx && tw) ? Math.round(tw / (fontPx * 0.5)) : null,
    // D, distraction proxies
    d_animated_count: animated.length,
    d_ad_count: ads.length,
    d_overlay_count: overlay.length,
    d_sticky_count: sticky.length,
    d_distractor_count: animated.length + ads.length + overlay.length + sticky.length,
    d_distractor_area_share: +(distractArea / area).toFixed(4),
    // provenance
    measured_px: { w: Math.round(rect.width), h: Math.round(rect.height) },
    note: "Measured from the rendered DOM at rating time. Proxies of the same kind the extension computes, not the finished metric."
  };
}

/* ------------------------------------------------------------------ faces */
function face(kind, size) {
  const s = size || 52;
  const mouth = { good:"M18 34 Q26 42 34 34", ok:"M18 36 H34", bad:"M18 40 Q26 32 34 40" }[kind];
  const svg = `<svg viewBox="0 0 52 52" width="${s}" height="${s}" aria-hidden="true">
    <circle cx="26" cy="26" r="23" fill="none" stroke="#1D5C7A" stroke-width="2.5"/>
    <circle cx="18" cy="21" r="2.6" fill="#1D5C7A"/><circle cx="34" cy="21" r="2.6" fill="#1D5C7A"/>
    <path d="${mouth}" fill="none" stroke="#1D5C7A" stroke-width="2.8" stroke-linecap="round"/></svg>`;
  const d = el("div"); d.innerHTML = svg; return d.firstChild;
}
function faceRow(key, labels, onPick) {
  const w = el("div", { class:"faces" });
  [["good", labels[0]], ["ok", labels[1]], ["bad", labels[2]]].forEach(([k, lab], i) => {
    w.appendChild(el("button", { class: answers[key] === i ? "on" : "", onclick:() => { answers[key] = i; if (onPick) onPick(i); paint(); } },
      [face(k), el("span", { text:lab })]));
  });
  return w;
}

/* --------------------------------------------------------- small controls */
function pick(key, items) {
  const w = el("div");
  items.forEach(it => w.appendChild(el("button", { class:"opt" + (answers[key] === it.value ? " on" : ""),
    onclick:() => { answers[key] = it.value; if (it.apply) it.apply(); paint(); } },
    [el("span", { text:it.label }), it.sub ? el("span", { class:"sub", text:it.sub }) : null])));
  return w;
}
function scale(key, n, lo, hi, start) {
  start = start === undefined ? 1 : start;
  const w = el("div"), r = el("div", { class:"scale" });
  for (let i = start; i < start + n; i++) r.appendChild(el("button", { class: answers[key] === i ? "on" : "", text:String(i), onclick:() => { answers[key] = i; paint(); } }));
  w.appendChild(r); w.appendChild(el("div", { class:"ends" }, [el("span", { text:lo }), el("span", { text:hi })]));
  return w;
}
function opts(key, list) {
  const r = el("div", { class:"scale" });
  list.forEach((o, i) => r.appendChild(el("button", { class: answers[key] === i ? "on" : "", text:o, onclick:() => { answers[key] = i; paint(); } })));
  return r;
}
function textArea(key, ph) {
  const t = el("textarea", { placeholder:ph || "", oninput:e => { answers[key] = e.target.value; } });
  t.value = answers[key] || ""; return t;
}
function allPairs(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) out.push([ids[i], ids[j]]);
  return shuffle(out).map(p => RNG() < 0.5 ? p : [p[1], p[0]]);
}


/* ============================================================================
   INFO REGISTRY, the "why" behind every screen.
   Each entry: why (why we ask), cite (evidence base), assume (why we do not
   assume the answer and measure it instead). Shown via the (i) button.
   ========================================================================== */
const INFO = {
  /* ---- v5 ---- */
  card_match: {
    title: "Why measure the screen with a card?",
    why: "A browser does not know how big its pixels are. Without that, text size cannot be reported in millimetres and gaze error cannot be converted into degrees of visual angle, which is the unit every eye-tracking comparison uses. A bank card is the same size everywhere (ID-1, 85.60 mm wide), so matching it on screen measures the pixel size of this particular laptop in about thirty seconds.",
    cite: "Card-matching is the standard browser method for physical screen calibration in remote psychophysics (Li, Joo, Yeatman & Reinecke, 2020, Scientific Reports, the 'virtual chinrest').",
    assume: "We do not assume a 96 dpi screen. If no card is available the step can be skipped, and the data then says that 96 dpi was assumed."
  },
  video_consent: {
    title: "Why record video, and why ask separately?",
    why: "Webcam eye tracking in the browser is coarse today, but gaze models improve every year. A face video recorded on the same clock as every stimulus and every calibration dot can be re-analysed later with a better model, without asking the same students to sit again. That is what makes this collection re-usable in Phase 2 and 3.",
    cite: "Re-processing archived webcam video with improved appearance-based gaze models is an established practice in gaze-estimation research; it depends on stored calibration targets with timestamps, which this instrument saves.",
    assume: "We do not assume that agreeing to the study, or to eye tracking, means agreeing to video. It is a separate guardian item and a separate question to the student, and a 'no' changes nothing else."
  },
  cam_setup: {
    title: "Why check the camera and the space first?",
    why: "School laptops often deliver less than they are asked for: 640x480 at 15 frames per second instead of 720p at 30. What the camera actually delivered is recorded, because it limits every later analysis. Free storage is checked because a 45-minute video needs around 200 MB on this laptop until it is uploaded.",
    cite: "Holmqvist et al.'s reporting guidance treats the recording setup (resolution, sampling rate, data loss) as part of the data.",
    assume: "We do not assume the requested resolution or frame rate was granted; we log what we got."
  },
  framing: {
    title: "Why check the framing, and then hide the picture?",
    why: "A face that is half out of frame, backlit by a window, or tilted far to one side makes the video useless for later analysis, and nobody can tell afterwards. Six quick checks catch that while it is still easy to fix. The preview is then hidden, because a child watching their own face on screen is itself a distractor in a study about distraction.",
    cite: "Framing, lighting and head pose are the main determinants of appearance-based gaze accuracy.",
    assume: "We do not assume a good setup. If it cannot be made green, the educator can continue and the reason is recorded."
  },
  distance: {
    title: "Why the disappearing dot?",
    why: "Every eye has a blind spot about 13.5 degrees to the side of where it is looking. The point on the screen where a moving dot vanishes therefore tells us how far the eye is from the screen, to within a few centimetres. That distance turns the camera's error in pixels into degrees.",
    cite: "Li, Joo, Yeatman & Reinecke (2020), 'Controlling for participants' viewing distance in large-scale, psychophysical online experiments using a virtual chinrest', Scientific Reports 10, 904.",
    assume: "We do not assume every student can do it. It is optional, and the educator's distance estimate is used instead."
  },
  drift: {
    title: "Why look at one dot again before each block?",
    why: "A webcam gaze model drifts as the student moves in the chair. One centre dot measures how far it has drifted since calibration, so each gaze block carries its own accuracy, and a large drift can be fixed with a quick recalibration before it spoils the block.",
    cite: "Drift checks before each trial block are standard practice for screen-based eye tracking.",
    assume: "We do not assume calibration stays accurate for the whole session."
  },
  mode: {
    title: "Why two separate sessions, and why forced choices rather than ratings?",
    why: "A student aged 14+ can reliably tell us which of two things looks better to them, a direct perceptual judgement. They cannot reliably self-report abstract things like how much adverts disrupt them, or which adaptations matter most day to day. Those need an adult who knows the student. Splitting the child and educator sessions means each person is only asked what they can actually answer well. Within the child session, every comparison is a forced choice between two options, not a rating scale, because this format has been specifically validated as more reliable than Likert-style ratings for young or support-need populations.",
    cite: "Routing each construct to the respondent who measures it best follows established practice in accessibility research with populations for whom introspective self-report is less reliable (Spiel, Frauenberger, Keyes & Fitzpatrick, 2019, ACM TOCHI). The forced two-way choice format follows the 'This or That' method validated in Child-Computer Interaction research (building on Read, MacFarlane & Casey, 2002); a direct comparison of methods with preschool and primary-age children found This-or-That produced more reliable and valid preference data than 5-point pictorial rating scales, which tend to be over-used at the extreme positive end by younger or less confident respondents.",
    assume: "We do not assume a student either can or cannot self-report; capacity is judged per student by the educator, and the tasks a student is given never exceed simple two-way choices, the format best evidenced for this kind of population."
  },
  capacity: {
    title: "Why judge capacity to assent?",
    why: "IIIT-Delhi IRB rules make guardian permission mandatory for every participant, and treat direct assent as depending on whether the individual can understand the study and decide, not on age or diagnosis. So we ask the educator to judge, per student, whether that student can understand a simple explanation and communicate a decision.",
    cite: "IIIT-Delhi IRB consent guidance: guardian/LAR permission is required where a participant cannot consent for themselves due to age (under 14) or diminished capacity (any age); assent is calibrated to what the individual can understand.",
    assume: "We do not assume all students in a special-education setting lack capacity, nor that all have it. Assuming either would either strip agency from capable students or over-burden those who cannot decide. It is measured individually."
  },
  ascertain: {
    title: "Why record this, and why not test for it?",
    why: "Any claim the study makes about neurodivergent readers depends on knowing who the participants actually were and how that was established. Reporting that precisely is a basic expectation at accessibility venues, and it cannot be reconstructed after the fact.",
    cite: "Screening scales such as SNAP-IV, Conners, the AQ and the SCQ are screening instruments, not diagnostic ones; a positive screen is not a diagnosis, several are licensed rather than freely usable, and administering them to minors is a materially different research activity from asking which of two fonts looks better. Under the RPwD Act 2016 in India, specific learning disabilities and autism are certifiable conditions while ADHD is not separately listed, so documentation availability differs sharply by condition and the source question has to allow for that.",
    assume: "We do not assume a label is correct, current, or formally established. Sources, recency, and whether anyone has actually seen the paperwork are recorded separately so documented and undocumented cases can be separated in analysis rather than silently pooled. We also do not assume a subtype or severity exists: every such field defaults to 'not specified in the records' and is only ever transcribed, never judged in the session."
  },
  assent: {
    title: "Why ask the student, and why the reading-level question?",
    why: "Assent is the student's own agreement, sought separately from the guardian's. For a student judged capable, willingness is required to proceed. The reading-level question sets how much text is shown so a weaker reader is not overwhelmed; it changes stimulus dosage only, not what is being compared.",
    cite: "Rayner (1998): reading difficulty produces measurable processing cost. Matching text length to reading ability keeps the comparison task about preference, not decoding effort.",
    assume: "We do not assume a signed guardian form means the student wants to take part today. Willingness (or its absence) is asked directly, and any sign of unwillingness or distress stops the session regardless of capacity group."
  },
  gaze_consent: {
    title: "Why an eye-tracking step, and why is it optional?",
    why: "This optional step measures roughly where the eyes are while reading, which gives a behavioural signal that does not depend on the student saying anything. It only proceeds where the guardian and student have separately agreed to it on the consent forms. It can always be declined or skipped without affecting the rest of the study.",
    cite: "Webcam gaze estimation (WebGazer, Papoutsaki et al., 2016) runs entirely in the browser: the video never leaves the machine and no frame is stored, only coordinates. Its published accuracy is about 4.17 degrees of visual angle, roughly 169 pixels, which supports coarse region contrasts and nothing finer.",
    assume: "We do not assume a stated preference equals easier reading, and we do not assume gaze can be collected from every student. Consent is checked here, the camera is checked next, calibration may still fail, and at every one of those points the session continues on preference data alone."
  },
  gaze_check: {
    title: "Why check the camera before calibrating?",
    why: "A webcam tracker can start, turn the camera light on and report itself ready while its face model has silently failed to load. Everything downstream then looks normal: the dots calibrate, the student reads the passage, and not one usable reading is recorded. This screen waits for real predictions and refuses to continue on a tracker that is not producing them, so a dead camera costs a few seconds rather than the whole gaze component of a session that cannot be repeated.",
    cite: "Holmqvist et al. minimal reporting guidance treats data loss and tracker quality as things to be measured and reported, not assumed; a pre-session check and a recorded failure reason are the minimum version of that.",
    assume: "We do not assume the tracker works because it started. Failing here is expected, harmless, and logged with a reason."
  },
  calibrate: {
    title: "Why calibrate first?",
    why: "Before any gaze number means anything, the software has to learn how this particular student's eyes map to positions on this particular screen. The student looks at each dot while the educator clicks it. If calibration will not settle, or the student is uncomfortable, the whole eye-tracking part is skipped and the study continues normally.",
    cite: "Per-participant calibration is standard for any gaze method. Nine points is the conventional minimum for a screen-based tracker, and the points are spread to the corners and centre so the fit is not extrapolating anywhere the student will actually be asked to look.",
    assume: "We do not assume the camera is positioned or lit well enough to track this student; calibration is the attempt, validation on the next screen is the check, and a failed check is a normal outcome that simply skips this component."
  },
  validate: {
    title: "Why measure the error instead of citing one?",
    why: "Calibration tells you the software has fitted a model. It does not tell you how good that model is for this student, in this room, at this seating distance. This screen shows five fresh targets the model has never been trained on and measures how far its predictions actually fall from them. That number then travels with every gaze row in the exported data, so nobody downstream has to assume an accuracy figure from a paper. It is also the gate: if the error is larger than the gap between the things we want to tell apart on a page, those contrasts are not interpretable and the data says so.",
    cite: "Holmqvist et al.'s minimal reporting guideline treats calibration, validation, accuracy in degrees, precision, and data loss as the minimum any eye-tracking report must state. WebGazer's own published figure is about 4.17 degrees (around 169 pixels), measured against a commercial tracker without head restraint; a per-participant validation is the only way to know what was actually achieved here.",
    assume: "We do not assume calibration succeeded, and we do not assume the published accuracy transfers to this room, this laptop and this student. Accuracy is measured, recorded, and allowed to disqualify comparisons it cannot support."
  },
  gaze_read: {
    title: "Why read a passage twice, and why two different stories?",
    why: "This is the before half of a before-and-after. The student reads one short passage in plain default settings, and later reads a matched passage in the settings they chose themselves. Comparing a student against themselves is the one thing a webcam tracker is genuinely suited to, because a constant error in where it thinks the eyes are cancels out when you subtract one reading from the other. The two passages are different, and which comes first is varied between students, because reading the same text twice is faster the second time simply from familiarity, and that speed-up would point in exactly the direction the study hopes to find.",
    cite: "Rayner (1998): sustained reading of continuous text, rather than glance-and-choose comparison, is what produces interpretable reading measures. Counterbalancing passage against condition is the standard control for practice effects in a repeated-measures design.",
    assume: "We do not assume chosen settings help just because they are preferred, and we do not assume a faster second read means easier reading rather than a remembered story. The felt-load rating is collected whether or not the camera works, so this contrast exists in every session."
  },
  comprehension: {
    title: "Why a practice comparison first?",
    why: "Before the real comparisons, we show one easy practice pair (clearly big text versus clearly tiny text) to confirm the student understands the task: look at both, pick the one you prefer. It anchors data quality by giving one item where a genuine engager has an obvious choice.",
    cite: "Attention/comprehension anchors are a standard safeguard against non-engagement in forced-choice studies; here it complements the indirect quality flags (side bias, response speed).",
    assume: "We do not assume the student understood the instructions. We check it directly with one low-stakes item rather than inferring it only after the fact."
  },
  font: {
    title: "Why compare these four typefaces, and not others?",
    why: "Typeface is one of the strongest, most direct levers the transformation tool can pull. We compare four, each a distinct, named hypothesis: Arial (the control, the most common on-screen default), Verdana (wide, generously spaced, the typeface Rello & Baeza-Yates' dyslexic participants read fastest in alongside Arial and Helvetica), Atkinson Hyperlegible (letterforms engineered to avoid confusable characters), and Lexend (proportions tuned for reading fluency rather than disambiguation).",
    cite: "Rello & Baeza-Yates (2013), Good Fonts for Dyslexia, ASSETS: eye-tracking study, 48 dyslexic readers, 12 fonts; sans-serif, monospaced and roman styles significantly outperformed serif, proportional and italic ones, with Arial, Verdana and Helvetica among the best performers. We deliberately exclude OpenDyslexic, the best-known purpose-built dyslexia font: the same study found it gave no significant advantage, a finding replicated in elementary-age students by Wery & Diliberto (2017), Annals of Dyslexia, who additionally found no student preferred it once given a real choice, and again in Otermans et al. (2025), Educational Media International, a self-report survey of 204 UK adults with ADHD, autism, or dyslexia/dyscalculia/dyspraxia, where Arial was preferred by 79-85% of every group and OpenDyslexic was so unpopular it had to be dropped from analysis in the dyslexia group for low statistical power. Atkinson Hyperlegible and Lexend are recent, popular accessibility-oriented typefaces without equivalent peer-reviewed validation for dyslexic or ADHD readers specifically, which is exactly why they are tested here rather than assumed to help.",
    assume: "We do not assume any font is best, and we do not include OpenDyslexic on the assumption that a font marketed for dyslexia must help; the evidence says otherwise. Each of the four included fonts is a defensible, distinct hypothesis, so whichever wins for a given student, the result is interpretable. Sizes are normalised across fonts so a font comparison is never secretly a size comparison, and the instrument refuses to run any pair whose two typefaces are measuring identically on this machine."
  },
  size: {
    title: "Why these three sizes specifically?",
    why: "Text size is a primary, direct tool setting, and it is the single variable with the clearest evidence of all the typography dimensions tested here. We compare 16px (a common on-screen default), 20px, and 24px, chosen to bracket the size research has found most effective, rather than arbitrary steps.",
    cite: "Rello, Pielot, Marcos & Carlini (2013), Size Matters (Spacing Not): 18 Points for a Dyslexic-Friendly Wikipedia, W4A: 28 dyslexic readers, eye-tracking, sizes from 10 to 26 points tested on real Wikipedia pages; font size had a significant effect on reading speed and comprehension, and the authors recommend 18-point text (approximately 24px on screen) for dyslexic readers. Our three sizes are chosen to test whether that effect holds for this specific population, not to assume it does.",
    assume: "We do not assume larger is always preferred, nor do we assume the 18-point recommendation transfers unchanged from Wikipedia article text to this instrument's shorter passages and this population. The comfortable size is measured per student."
  },
  colour: {
    title: "Why compare colour and contrast, given how contested this is?",
    why: "Background and text colour are among the most actively disputed accessibility interventions in the literature, which is precisely the argument for measuring preference individually rather than prescribing a scheme. The four options span a deliberate range: black on white (maximum contrast, the conventional default), warm off-white (softer contrast), dark mode (inverted polarity), and a light blue background.",
    cite: "The evidence is genuinely split at the population level, and where a large recent study did find an effect, it found the opposite of a single universal answer. Otermans et al. (2025), Educational Media International, surveyed 204 UK adults with ADHD, autism, or dyslexia/dyscalculia/dyspraxia on background colour preference and found a statistically significant difference in which colour each group preferred: ADHD participants ranked blue highest, autistic participants ranked white highest (blue a close second), and the dyslexia-family group ranked yellow highest, though blue scored best on a separate easy-to-read rating across all three groups. Separately, Wilkins and colleagues (e.g. Wilkins & Evans, 2016) report that individually colorimeter-matched tints help a subset of readers with visual stress, while a rigorous double-masked randomised trial (Ritchie, Della Sala & McIntosh, 2011, Pediatrics) found coloured overlays gave no reliable general benefit, and systematic reviews (Griffiths et al., 2016; Evans & Allen, 2016) do not support overlays as a general dyslexia intervention.",
    assume: "We do not assume any colour scheme helps, and critically, we do not assume one colour works for everyone even within a single diagnosis: the strongest recent evidence found genuinely different group-level preferences rather than one winner. Prescribing a scheme would be indefensible given this; measuring each student's own preference is what the evidence actually supports."
  },
  lead: {
    title: "Why test three line spacings, when the evidence says spacing may not matter much?",
    why: "This is a dimension where the evidence is genuinely mixed, not confirmatory. Rello, Pielot, Marcos & Carlini (2013) tested spacings of 1.4 and 1.8 (kept here) and found no significant reading-speed or comprehension effect for dyslexic readers. A larger, more recent self-report study found the opposite pattern at the ranking level: single spacing was preferred over 1.5x and 2x spacing by ADHD, autistic, and dyslexia-family adults alike. Given this direct disagreement, we added a tighter option (1.0) to see which pattern, if either, holds for this student.",
    cite: "Rello, Pielot, Marcos & Carlini (2013), W4A: tested line spacings of 0.8, 1.0, 1.4, and 1.8 alongside font size; font size showed a significant effect, line spacing did not. Otermans et al. (2025), Educational Media International: 204 UK adults with ADHD, autism, or dyslexia/dyscalculia/dyspraxia ranked single spacing above 1.5x and 2x across all three groups, though the difference was not statistically significant by chi-square test.",
    assume: "We do not assume line spacing helps just because it is commonly recommended, and we do not assume the direction of any effect, since the two best available studies point in different directions. This comparison exists to test what actually holds for this student."
  },
  track: {
    title: "Why compare letter spacing, and why this much extra space?",
    why: "This is the most strongly evidenced typography manipulation tested here. A large randomised study found that extra-large letter spacing (roughly 2.5 times normal) improved reading speed by over 20 percent and halved errors in dyslexic children, with no comparable benefit for typical readers, on the spot, with no training. The spacing tested here approximates that magnitude rather than a token increase.",
    cite: "Zorzi et al. (2012), Extra-large letter spacing improves reading in dyslexia, PNAS: 54 Italian and 40 French dyslexic children; effect attributed to reduced visual crowding between letters, and significantly larger in dyslexic readers than in matched controls. A separate study (Korinth, Gerstenberger & Fiebach, 2020, Frontiers in Psychology) found wider spacing can slow down already-fast readers even while easing word recognition, an individual trade-off, not a universal benefit.",
    assume: "We do not assume extra letter spacing helps this specific student, even though the population-level dyslexia evidence is strong; the same manipulation can slow down a fluent reader. It is measured directly rather than applied as a blanket rule."
  },
  apply: {
    title: "Why show the combined settings and offer a break?",
    why: "The left panel now shows the student's own winning choices applied together, validating their choices back to them, and marks a deliberate rest point. Fatigue degrades data quality in this population, so a no-time-limit break is built in. The second reading passage also happens here, in the student's own settings.",
    cite: "Session fatigue is a recognised threat to data quality with neurodivergent participants; scheduled breaks and quality gates are recommended safeguards.",
    assume: "We do not assume the student can or wants to continue without pause; the break is offered explicitly rather than assumed unnecessary."
  },
  dis: {
    title: "Why these six distractor types, and why one at a time?",
    why: "We show a realistic page with a single distractor at a time (still advert, flashing advert, pop-up, sticky bar, moving carousel, chat bubble) so any disruption is attributable to that specific element, and record the student's felt response, the educator's observed behaviour, and where available a coarse gaze measure of whether attention actually left the text.",
    cite: "Holmberg, Sandberg & Holmqvist (2014), Frontiers in Psychology: visually salient online adverts measurably captured children's gaze during task-oriented internet use, even when task accuracy was preserved. Pop-ups are consistently reported as especially disruptive because they appear directly in the reader's focal area rather than the visual periphery. ADHD-specific research reports adverts, notifications, autoplay motion and continuous scrolling as recurring, self-identified risks to reading engagement. The six types span static clutter, motion, interruption, persistent space occupation, and a persistent attention magnet. The three-face response scale is a reduced version of the Smileyometer (Read, MacFarlane & Casey, 2002), narrowed from five points to three because evaluations of the full scale with younger or less confident children found a tendency to over-select the most positive option.",
    assume: "We do not assume which distractors matter most, or that the student's feeling equals actual disruption. A student may say a page feels fine yet visibly lose their place, so the quantitative weight comes from the educator's observed behaviour. This is also the one place the webcam tracker is asked a question it can answer: the distractor and the text sit far enough apart on screen for a coarse tracker to tell them apart, which a line of text and the line below it do not."
  },
  layout: {
    title: "Why the busy-versus-calm page, and why rate both?",
    why: "This is the holistic layout judgement: does the student prefer a cluttered multi-element page or a clean single-column one? It tests the core premise of the whole tool. Both pages are then rated on the same three faces used for the distractor screens, which is what makes clutter and distraction numerically comparable rather than two separate scales that cannot be set against each other.",
    cite: "Michailidou, Eraslan, Yesilada & Harper (2021): webpage visual complexity relates to user difficulty. Eraslan, Yaneva, Yesilada & Harper (2019), Behaviour & Information Technology: an eye-tracking study of 18 autistic and 18 neurotypical adults found autistic participants looked at more page elements, made more transitions between them, and were less successful completing web tasks.",
    assume: "We do not assume simpler is always preferred; some readers use page furniture to orient. We also do not assume distraction is a separate thing from general busyness. Putting both on one scale is what lets that be tested rather than argued."
  },
  textlevel: {
    title: "Why compare two ways of writing the same thing?",
    why: "Text complexity is one of the four signals the Cognitive Load Score is built from, but every other question in the child session is about how text looks, not how it is written. Without this comparison the weight given to language difficulty would rest entirely on the educator's judgement, with nothing from the student to check it against. It also directly pilots the plain-language rewriting the tool is meant to do: if students cannot tell the two apart, that feature is not worth building.",
    cite: "Flesch-Kincaid style readability and the W3C COGA plain-language patterns (one idea per sentence, common words, no subordinate clauses) define the contrast being tested; only wording differs between the two panels, everything visual is held identical.",
    assume: "We do not assume simpler wording is preferred or easier for this student. A 'they feel the same to me' option is offered precisely so a null result can be recorded rather than forced into a preference."
  },
  retest: {
    title: "Why repeat a comparison?",
    why: "This repeats an earlier font comparison on a different story. If the student picks the same font again, that is evidence their preferences are stable and real, not random or position-driven. It feeds a data-quality flag, not the preference estimate itself.",
    cite: "Test-retest consistency is a standard reliability check (Standards for Educational and Psychological Testing, AERA/APA/NCME, 2014).",
    assume: "We do not assume a single choice reflects a stable preference; we verify it with a repeat on new text so we are not building on noise."
  },
  ed1: {
    title: "Why collect the child profile?",
    why: "These items require knowledge only the educator has, and they are the variables against which preferences are later interpreted: reading age relative to chronological age, reading stamina, and any supports that already work for this student. What is identified, and on what authority, was recorded at setup.",
    cite: "Precise reporting of participant characteristics is expected in accessibility research (SIGACCESS guidance); per-profile analysis is what makes personalised weighting possible.",
    assume: "We do not assume a diagnosis or infer needs from behaviour. Existing supports are captured rather than guessed, because what already works is direct evidence for what the tool should do."
  },
  ed_w: {
    title: "Why the 100-point allocation?",
    why: "This is the most direct way to elicit the Cognitive Load Score weighting for this specific student. The four categories are the CLS signals in plain language: hard words (T), busy page (V), hard-to-see text (W), and competing attention (D). Forcing a total of 100 makes the educator express relative importance, which is what a weighting is.",
    cite: "Sweller (1988) cognitive load; the CLS combines T/V/W/D signals whose weighting, per the project design, is grounded in real judgement rather than set by intuition, and is later re-estimated against measured data.",
    assume: "We do not assume the four sources matter equally, and we do not assume a single universal weighting fits every child. The constant-sum design forbids the everything-matters-equally non-answer, and the instruction insists the answer is about this child specifically."
  },
  ed_obs: {
    title: "Why rate the session and ask what you know?",
    why: "The first items are the educator's assessment of how much to trust this session (understanding, whether choices were genuine, prompting needed, day-to-day variance); they become quality weights on the data. The open questions capture holistic knowledge no fixed item can, and the stigma question guards against building a tool that marks a student as different.",
    cite: "Consequences and response-process validity are recognised evidence sources (Standards, 2014). Bennett & Rosner (2019) and Spiel et al. (2019, 2022) warn against deficit-framed assistive tech; the stigma item operationalises that caution.",
    assume: "We do not assume every session is equally trustworthy, nor that a helpful adaptation is automatically acceptable socially. Both are asked so the tool is neither over-trusting of shaky data nor blind to stigma."
  },
  context: {
    title: "Why language, vision and today?",
    why: "Each of these changes what a result means, and none can be recovered after the session. The passages are in English: for a student reading in a second or third language a difficulty judgement may be about vocabulary rather than letterforms. A student who needs glasses and is not wearing them will prefer larger text for reasons unrelated to this study, and pooling them with corrected readers biases every size and spacing result. Tiredness, illness, routine changes and medication move attention and reading tolerance within a single sitting, and this session measures exactly those things.",
    cite: "Reading research is strongly language-dependent, so first language and language of instruction are standard reporting variables rather than optional extras. Uncorrected refractive error is a direct confound for any typography or text-size measure. Time of day and state-on-the-day are the usual covariates for a single-sitting attention measure.",
    assume: "We do not assume every student is reading in their first language, that everyone who needs correction is wearing it, or that any given day is typical. Each is recorded so it can be modelled or excluded rather than silently averaged in."
  },
  recall: {
    title: "Why ask about the story afterwards?",
    why: "Every other question in this session measures what a student PREFERS. Preference is not performance, and a study with no performance measure can only ever say students liked their settings, never that the settings helped them read. Two easy questions after each passage give a crude but real performance signal, on matched passages, so the before-and-after can be compared on something other than opinion.",
    cite: "Meaning preservation is the standard check on any readability manipulation: a change that speeds reading while losing comprehension is not an improvement. Keeping the items short and concrete, with the passage hidden and the options read aloud, keeps this a check that the passage was taken in rather than a test of reading or memory.",
    assume: "We do not assume a preferred setting is an easier one. We also do not assume a student can read at all: this is skipped for pre-readers, along with the passage itself."
  },
  showcase: {
    title: "Why ask about the combined result?",
    why: "Every other child item isolates one dimension so the answer is attributable. That is right for measurement and it means no single screen ever asks the question the tool actually lives or dies on: with everything applied together, is this better than a normal page? This screen is the only place the student sees their own choices combined, so it is the only place that question can be asked.",
    cite: "A set of individually preferred settings does not necessarily combine into a preferred whole; interactions between typography, spacing and colour are real. Acceptability of the combined result, and the educator's judgement of whether the student would actually use it, are what separate a tool that is used from one that is abandoned.",
    assume: "We do not assume that winning each comparison separately means the combination is wanted. It is asked directly, with a same-to-me option, and the educator is asked separately about day-to-day use."
  },
  ed_w2: {
    title: "Why ask the hundred points twice?",
    why: "That allocation is the per-child weight vector, the single most important quantity this study derives. Asked once, there is no way to distinguish a considered judgement from a number picked quickly, and its reliability stays unknown. Asking again at the end, without showing the first answer back, turns that from an assumption into a measurement: a close repeat means the weighting can be used for this student individually, a loose one means it should be pooled.",
    cite: "Test-retest consistency is the standard reliability evidence for any derived score (Standards for Educational and Psychological Testing, AERA/APA/NCME, 2014). For a formative index, where internal-consistency statistics do not apply, stability of the weights is one of the few reliability checks available.",
    assume: "We do not assume one allocation from one person is stable. The two answers are not required to match, and a difference is a finding rather than an error."
  },
  ed_pri: {
    title: "Why rate each adaptation Must/Should/Could/No?",
    why: "This directly produces the prioritised adaptation backlog for the transformation tool, per student. Rating each candidate adaptation into action tiers turns the educator's knowledge into a build list, which is the primary aim's core deliverable.",
    cite: "MoSCoW prioritisation is a standard requirements method; here it grounds the backlog in per-child evidence rather than designer assumption.",
    assume: "We do not assume which adaptations are worth building. Each is rated by someone who knows the student, so the backlog reflects real need, not a designer's guess."
  }
};

function showInfo(key) {
  const d = INFO[key]; if (!d) return;
  const b = $("#imodal-body"); b.innerHTML = "";
  const onPortal = () => { try { return REMOTE.modal(b.innerHTML); } catch (e) { return false; } };
  b.appendChild(el("h3", { text: d.title }));
  b.appendChild(el("div", { class:"sub", text:"Why we ask this, and why we do not assume the answer" }));
  b.appendChild(el("h4", { text:"Why we ask" }));
  b.appendChild(el("p", { text:d.why }));
  b.appendChild(el("h4", { text:"Why we do not assume it" }));
  b.appendChild(el("p", { text:d.assume }));
  b.appendChild(el("h4", { text:"Evidence base" }));
  b.appendChild(el("p", { class:"cite", text:d.cite }));
  if (onPortal()) return;   // v5.1: never on the child's screen while the portal has the controls
  b.appendChild(el("button", { class:"close", text:"Close", onclick:() => $("#imodal").classList.remove("on") }));
  $("#imodal").classList.add("on");
}
function infoBar(key) {
  if (!INFO[key]) return null;
  const bar = el("div", { class:"infobar" });
  bar.appendChild(el("button", { class:"infobtn", title:"Why are we asking this?", "aria-label":"Why are we asking this?", text:"i", onclick:() => showInfo(key) }));
  return bar;
}


/* =========================================================================
   SCREENS
   ========================================================================= */
const SCREENS = [];
const add = s => SCREENS.push(s);
const isChild = () => S.mode === "child";

/* ============================ v5: CONNECT =================================
   The first screen on the participant laptop. Either the admin device has
   created this session (join with its code: the codes and consent flags come
   from there and cannot be mistyped here), or the session runs stand-alone
   and uploads whenever a connection exists. */
function applyJoined(cfg) {
  S.link = { joined:true, join_code: cfg.join_code, admin_session: cfg };
  S.session_id = cfg.session_id;
  S.child_id = cfg.child_id || ""; S.educator_id = cfg.educator_id || "";
  answers.mode = cfg.mode;
  if (cfg.capacity) answers.capacity = cfg.capacity;
  answers.consent_parent = cfg.guardian_main ? 0 : 1;
  S.consent.form_version = cfg.consent_form_version || null;
  S.consent.guardian_main = !!cfg.guardian_main;
  S.consent.guardian_gaze = !!cfg.guardian_gaze;
  S.consent.guardian_video = !!cfg.guardian_video;
  S.consent.retention_until = cfg.retention_until || null;
  if (cfg.sync_flash === false) SYNC.enabled = false;
  EV.log("joined_admin_session", { join_code: cfg.join_code, session_id: cfg.session_id });
  try { REMOTE.start(); } catch (e) {}   // v5.1: wait for the educator portal
}
add({ id:"connect", block:"admin", bar:"off",
  enter: () => { if (LINK.configured() && LINK.online() === null) LINK.ping().then(() => paint(), () => paint()); OUTBOX.refresh().then(() => paint()); },
  stageFn: () => stage(card(el("div", {}, [
    el("div", { class:"eyebrow", text:"Glide · participant laptop" }),
    el("h1", { text:"Reading comfort study" }),
    el("p", { class:"lede", text:"This laptop is the one the student sits at. The session is normally started from the admin device, which gives you a short join code." }),
    el("table", { class:"t", html:
      "<tbody><tr><th>With the admin device</th><td>Type the join code shown on the admin screen. The child code, educator code and consent answers come from there.</td></tr>" +
      "<tr><th>Without it</th><td>Run offline. Everything is saved on this laptop and uploaded to the study Drive the next time this page is open with a connection.</td></tr>" +
      "<tr><th>Training</th><td>Run offline and choose Educator training on the next screen. Nothing is saved.</td></tr></tbody>" })
  ]))),
  panel: () => {
    const w = el("div", { class:"wrap" });
    w.appendChild(el("div", { class:"eyebrow", text:"Start" }));
    w.appendChild(el("h1", { text:"Join a session" }));
    if (S.link.joined) {
      const c = S.link.admin_session;
      w.appendChild(el("div", { class:"notice ok", html:"<strong>Joined.</strong> " + c.mode + " session for child <strong>" + (c.child_id || "-") + "</strong>, educator " + (c.educator_id || "-") + ". Press Next." }));
      let portal = false; try { portal = REMOTE.isOpen(); } catch (e) {}
      w.appendChild(el("div", { class: "notice" + (portal ? " ok" : ""), html: portal
        ? "<strong>Educator portal connected.</strong> From now on this laptop shows only what the child sees; the questions and buttons are on the portal."
        : "<strong>Educator portal (optional):</strong> open the portal link from the admin console on the educator's phone, tablet or laptop and enter join code <strong>" + c.join_code + "</strong>. It connects by itself. Without it, the controls stay on this laptop." }));
      return w;
    }
    if (!LINK.configured()) {
      w.appendChild(el("div", { class:"notice", text:"This laptop is not linked to the study backend yet. Open the setup link from the admin console once on this laptop, or enter the details under “Set up this laptop” below. You can still run offline." }));
    } else {
      const st = LINK.online();
      w.appendChild(el("p", { class:"hint", text: st === null ? "Checking the connection…" : st ? "Connected to the study backend." : "No connection to the study backend right now (" + (LINK.lastError() || "offline") + "). You can run offline; uploads will wait." }));
      const inp = el("input", { type:"text", class:"codein", maxlength:"6", placeholder:"CODE", value: answers.join_code || "",
        oninput:e => { answers.join_code = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); e.target.value = answers.join_code; } });
      w.appendChild(el("label", { class:"fld" }, [el("span", { text:"Join code from the admin device" }), inp]));
      w.appendChild(el("button", { class:"btn", style:"width:100%", text: S._joining ? "Joining…" : "Join session", onclick: async () => {
        if (S._joining) return; S._joining = true; S._joinErr = null; paint();
        try { const cfg = await LINK.join(answers.join_code); applyJoined(cfg); }
        catch (e) { S._joinErr = String(e && e.message || e); }
        S._joining = false; paint();
      } }));
      if (S._joinErr) w.appendChild(el("div", { class:"notice bad", text:"Could not join: " + S._joinErr + ". Check the code on the admin screen." }));
    }
    w.appendChild(el("h2", { text:"Or" }));
    w.appendChild(el("button", { class:"opt" + (answers.offline ? " on" : ""), onclick:() => { answers.offline = true; paint(); } },
      [el("span", { text:"Run offline on this laptop" }), el("span", { class:"sub", text:"Codes and consent are entered on the next screen. Uploads happen later." })]));
    const ob = OUTBOX.stats();
    if (ob.other_sessions_pending) w.appendChild(el("div", { class:"notice", html:"<strong>" + ob.other_sessions_pending + " file(s) from earlier sessions</strong> are still waiting to upload from this laptop. They upload automatically while this page is open and connected." }));
    const det = el("details", { style:"margin-top:16px" }, [el("summary", { text:"Set up this laptop" })]);
    const api = el("input", { type:"text", placeholder:"https://script.google.com/macros/s/…/exec", value: LINK.config().api || "" });
    const key = el("input", { type:"text", placeholder:"device key" });
    det.appendChild(el("label", { class:"fld" }, [el("span", { text:"Backend URL" }), api]));
    det.appendChild(el("label", { class:"fld" }, [el("span", { text:"Device key" + (LINK.config().has_key ? " (one is saved; leave empty to keep it)" : "") }), key]));
    det.appendChild(el("button", { class:"speak", text:"Save and test", onclick: async () => {
      LINK.setConfig(api.value, key.value || (LINK.configured() ? JSON.parse(localStorage.getItem("glide_link") || "{}").device_key : ""));
      try { await LINK.ping(); alert("Connected."); } catch (e) { alert("Could not connect: " + (e && e.message || e)); }
      paint(); } }));
    w.appendChild(det);
    return w;
  },
  valid: () => S.link.joined || !!answers.offline
});

/* ------------------------------------------------------------ mode select */
add({ id:"mode", block:"admin", bar:"off",
  stageFn: () => stage(card(el("div", {}, [
    el("div", { class:"eyebrow", text:"Glide" }),
    el("h1", { text:"Reading comfort study" }),
    el("p", { class:"lede", text:"This study runs as two short sessions with different people answering." }),
    el("table", { class:"t", html:
      "<tbody><tr><th>Child session</th><td>About 15 minutes. The child chooses between two things at a time. No reading is required to answer.</td></tr>" +
      "<tr><th>Educator session</th><td>About 15 minutes. Completed by the special educator, separately, after the child session.</td></tr></tbody>" }),
    el("div", { class:"notice bad", html:"<strong>Before any child session:</strong> written parental or guardian consent must be on file for every student. Whether the student's own assent is also required is set by the capacity question on this screen. Stop here if guardian consent is missing." })
  ]))),
  panel: () => {
    const w = el("div", { class:"wrap" });
    w.appendChild(el("div", { class:"eyebrow", text:"Setup" }));
    w.appendChild(el("h1", { text:"Which session is this?" }));

    if (!FONTHEALTH.ok()) {
      const bad = FONTHEALTH.failed().map(id => (FONTS.find(f => f.id === id) || {}).name).join(", ");
      w.appendChild(el("div", { class:"notice bad", html:
        "<strong>Typeface problem, the letters block will be reduced.</strong> These are not rendering as distinct typefaces on this machine: " +
        bad + ". Any comparison involving them would show two identical specimens, so those pairs are skipped. Reload first; if it persists, report it before collecting data." }));
    }
    if (MOTION.reduced()) {
      w.appendChild(el("div", { class:"notice bad", html:
        "<strong>This machine has reduced motion turned on.</strong> Two of the six distractor pages are motion (the flashing advert and the moving picture box). With this setting they would be shown as still images and would not be measuring what they claim to. Turn reduced motion off in the operating system's accessibility settings before running a child session, or accept that those two conditions are recorded as degraded." }));
    }

    if (S.link.joined) {
      /* Started from the admin device: who, which session and what the
         guardian agreed to were set there and are shown, not re-asked. */
      const c = S.link.admin_session;
      const yn = v => v ? "Yes" : "No";
      w.appendChild(el("table", { class:"t", html: "<tbody>" +
        "<tr><th>Session</th><td>" + c.mode + " · " + S.session_id + "</td></tr>" +
        "<tr><th>Child code</th><td>" + (S.child_id || "-") + "</td></tr>" +
        "<tr><th>Educator code</th><td>" + (S.educator_id || "-") + "</td></tr>" +
        (c.mode === "child" ? "<tr><th>Guardian consent: study</th><td>" + yn(c.guardian_main) + "</td></tr>" +
          "<tr><th>Guardian consent: eye tracking</th><td>" + yn(c.guardian_gaze) + "</td></tr>" +
          "<tr><th>Guardian consent: video</th><td>" + yn(c.guardian_video) + "</td></tr>" +
          "<tr><th>Consent form version</th><td>" + (c.consent_form_version || "-") + "</td></tr>" +
          "<tr><th>Keep data until</th><td>" + (c.retention_until || "-") + "</td></tr>" : "") +
        "</tbody>" }));
      if (!c.guardian_main) w.appendChild(el("div", { class:"notice bad", text:"The admin device recorded that guardian consent is NOT on file. Do not continue." }));
      if (c.mode === "child" && !answers.capacity) {
        w.appendChild(el("h2", { text:"Capacity to assent" }));
        w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"Can this student understand a simple explanation of the study and communicate a decision?" }),
          pick("capacity", [
            { value:"capable", label:"Yes, can understand and decide", sub:"Guardian consent + the student's own assent both apply" },
            { value:"diminished", label:"No, has diminished capacity to decide", sub:"Guardian consent alone governs; assent is attempted but not required" }])]));
      }
      return w;
    }
    w.appendChild(pick("mode", [
      { value:"child", label:"Child session", sub:"The child is here now, with their educator" },
      { value:"educator", label:"Educator session", sub:"Completed by the special educator alone, after the child session" },
      { value:"training", label:"Educator training", sub:"A practice walkthrough for the educator; no student, no real data" }]));
    if (answers.mode === "training") {
      w.appendChild(el("label", { class:"fld" }, [el("span", { text:"Educator code (for training records only)" }),
        el("input", { type:"text", value:S.educator_id, placeholder:"e.g. E-02", oninput:e => { S.educator_id = e.target.value.trim(); validate(); } })]));
      w.appendChild(el("div", { class:"notice", text:"Training mode: no student is involved, no consent is needed, and nothing recorded here becomes part of the real dataset. Use this the first time you administer the study, and any time you want to refresh yourself." }));
      return w;
    }
    w.appendChild(el("label", { class:"fld" }, [el("span", { text:"Child code (never the child's name)" }),
      el("input", { type:"text", value:S.child_id, placeholder:"e.g. C-07", oninput:e => { S.child_id = e.target.value.trim(); checkDuplicate(); validate(); } })]));
    // Catching a re-used code at setup is far cheaper than finding two
    // different students under one code at analysis, when neither can be
    // re-identified to fix it.
    if (S._dupe) w.appendChild(el("div", { class:"notice bad", text:
      "This child code has already been used for a " + S._dupe.mode + " session on this machine (" + S._dupe.when + "). If this is the same student continuing, that is fine. If it is a different student, change the code now: once two students share a code they cannot be separated afterwards." }));
    w.appendChild(el("label", { class:"fld" }, [el("span", { text:"Educator code" }),
      el("input", { type:"text", value:S.educator_id, placeholder:"e.g. E-02", oninput:e => { S.educator_id = e.target.value.trim(); validate(); } })]));
    w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"Parental/guardian consent form signed and on file?" }), opts("consent_parent", ["Yes","No"])]));
    if (answers.consent_parent === 1) w.appendChild(el("div", { class:"notice bad", text:"Do not continue. No data may be collected without consent on file." }));

    if (answers.mode === "child") {
      w.appendChild(el("h2", { text:"Capacity to assent" }));
      w.appendChild(el("p", { class:"hint", text:"Educator judgement, per student, not a formal test, and not inferred from age or diagnosis. Guardian permission is required either way. Guardian permission alone governs where a student is under 12, or has diminished capacity at any age; a student aged 12 or above who can understand and decide gives their own assent as well." }));
      w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"Can this student understand a simple explanation of the study and communicate a decision?" }),
        pick("capacity", [
          { value:"capable", label:"Yes, can understand and decide", sub:"Guardian consent + the student's own assent both apply" },
          { value:"diminished", label:"No, has diminished capacity to decide", sub:"Guardian consent alone governs; assent is attempted but not required" }])]));
      /* v5: the camera components are separately consented on the guardian
         form, and every video must trace to the form version it was
         collected under. */
      w.appendChild(el("h2", { text:"Guardian form" }));
      w.appendChild(el("label", { class:"fld" }, [el("span", { text:"Consent form version on file (as printed on the form)" }),
        el("input", { type:"text", value:answers.form_version || "", placeholder:"e.g. GLIDE-GPF-v3 (2026-10)", oninput:e => { answers.form_version = e.target.value.trim(); validate(); } })]));
      w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"Did the guardian agree to eye tracking?" }), opts("g_gaze", ["Yes","No"])]));
      w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"Did the guardian agree to video recording of the face?" }), opts("g_video", ["Yes","No"])]));
      w.appendChild(el("label", { class:"fld" }, [el("span", { text:"Keep this session's data until (retention / destruction date from the protocol)" }),
        el("input", { type:"date", value:answers.retention || "", oninput:e => { answers.retention = e.target.value; validate(); } })]));
    }
    return w;
  },
  info: "capacity",
  onLeave: () => { S.mode = answers.mode; S.capacity = answers.capacity;
    document.body.classList.toggle("child", S.mode === "child");
    MOTION.apply();
    SESSION_T0 = performance.now();
    log("admin","mode",S.mode);
    log("admin","font_health", FONTHEALTH.ok() ? "ok" : "degraded", { fonts: FONTHEALTH.report(), failed: FONTHEALTH.failed() });
    log("admin","reduced_motion", MOTION.reduced(), { degraded_distractors: MOTION.affected() });
    if (S.mode !== "training") {
      log("admin","parental_consent_on_file", answers.consent_parent === 0);
      log("admin","capacity", answers.capacity);
      rememberCode();
      if (!S.link.joined && S.mode === "child") {
        S.consent.form_version = answers.form_version || null;
        S.consent.guardian_main = answers.consent_parent === 0;
        S.consent.guardian_gaze = answers.g_gaze === 0;
        S.consent.guardian_video = answers.g_video === 0;
        S.consent.retention_until = answers.retention || null;
      }
      S.consent.logged_t_perf.guardian = CLOCK.t();
      log("admin","consent_form_version", S.consent.form_version);
      log("admin","guardian_consent_components", { main:S.consent.guardian_main, gaze:S.consent.guardian_gaze,
        video:S.consent.guardian_video, audio:false }, { retention_until: S.consent.retention_until, source: S.link.joined ? "admin_device" : "entered_on_participant_laptop" });
      sessionStarted();
    } },
  valid: () => {
    if (S.link.joined) return answers.consent_parent === 0 && (answers.mode !== "child" || !!answers.capacity);
    if (answers.mode === "training") return !!S.educator_id;
    const base = answers.mode && S.child_id && S.educator_id && answers.consent_parent === 0 && (answers.mode === "educator" || answers.capacity);
    if (!base) return false;
    return answers.mode === "educator" || (!!answers.form_version && answers.g_gaze !== undefined && answers.g_video !== undefined && !!answers.retention);
  }
});

/* ================= ASCERTAINMENT (CHILD AND EDUCATOR SESSIONS) =========== */
/* Placed immediately after setup, before anything is measured, so eligibility
   is established BEFORE a student sits through a session rather than
   discovered afterwards. It runs in both sessions: the educator is present at
   both, it costs about a minute, and answering it twice gives a free
   consistency check between the two files. */
add({ id:"ascertain", block:"ED_ascertain", bar:"off", skipIf: () => S.mode === "training" || !S.mode,
  enter: () => { answers.dx = answers.dx || []; answers.dx_detail = answers.dx_detail || {}; answers.dx_src = answers.dx_src || []; },
  stageFn: () => stage(card(el("div", {}, [
    el("div", { class:"eyebrow", text:"Setup" }),
    el("h1", { text:"How do we know?" }),
    el("p", { class:"lede", text:"The study reports how each participant's neurodivergence was established, and on whose authority. That reporting is only as good as this screen." }),
    el("table", { class:"t", html:
      "<tbody>" +
      "<tr><th>Copy, do not judge</th><td>Every answer here is transcribed from what is already recorded about this student. Nothing on this screen asks you to assess or decide anything yourself.</td></tr>" +
      "<tr><th>“Not specified” is a real answer</th><td>Most records do not state a subtype or a severity. Leaving it as not specified is accurate and useful. Guessing is neither.</td></tr>" +
      "<tr><th>No test is being given</th><td>This study does not administer any diagnostic or screening questionnaire. It records what was established elsewhere, by people qualified to establish it.</td></tr>" +
      "</tbody>" })
  ]))),
  panel: () => {
    const w = el("div", { class:"wrap" });
    w.appendChild(el("div", { class:"eyebrow", text:"Ascertainment" }));
    w.appendChild(el("h1", { text:"What is identified for this student?" }));
    w.appendChild(el("p", { class:"hint", text:"Choose everything that applies. Co-occurrence is common, and forcing one label would misrepresent many students." }));

    const chips = el("div");
    CONDITIONS.forEach(c => chips.appendChild(el("button", {
      class:"chip" + (answers.dx.includes(c.id) ? " on" : ""), text:c.label,
      onclick:() => {
        const i = answers.dx.indexOf(c.id);
        if (i < 0) {
          if (c.id === "none" || c.id === "nosay") answers.dx = [c.id];
          else answers.dx = answers.dx.filter(x => x !== "none" && x !== "nosay").concat(c.id);
        } else answers.dx.splice(i, 1);
        paint();
      } })));
    w.appendChild(chips);

    if (answers.dx.includes("other"))
      w.appendChild(el("label", { class:"fld" }, [el("span", { text:"What else is identified? Write it as the records describe it." }),
        el("input", { type:"text", value:answers.dx_other || "", placeholder:"e.g. Developmental language disorder",
          oninput:e => { answers.dx_other = e.target.value; validate(); } })]));

    const detailed = CONDITIONS.filter(c => c.detail && answers.dx.includes(c.id));
    if (detailed.length) {
      w.appendChild(el("h2", { text:"Only if the paperwork says so" }));
      w.appendChild(el("div", { class:"notice", text:"Do not infer any of these from how the student presents. If the documentation does not state it, the answer is 'Not specified in the records'." }));
      detailed.forEach(c => {
        const row = el("div", { class:"q" });
        row.appendChild(el("div", { class:"q-t", text:c.label + " · " + c.detailLabel }));
        const sc = el("div", { class:"scale" });
        c.detail.forEach(d => sc.appendChild(el("button", { class: answers.dx_detail[c.id] === d ? "on" : "", text:d,
          onclick:() => { answers.dx_detail[c.id] = d; paint(); } })));
        row.appendChild(sc);
        w.appendChild(row);
      });
    }

    if (!answers.dx.includes("nosay")) {
      w.appendChild(el("h2", { text:"How was this established?" }));
      w.appendChild(el("p", { class:"hint", text:"Choose every source that applies. If you have not personally seen the document, say so in the next question rather than leaving it out here." }));
      DX_SOURCES.forEach(src => {
        const on = answers.dx_src.includes(src.id);
        w.appendChild(el("button", { class:"opt" + (on ? " on" : ""),
          onclick:() => { const i = answers.dx_src.indexOf(src.id); i < 0 ? answers.dx_src.push(src.id) : answers.dx_src.splice(i, 1); paint(); } },
          [el("span", { text:src.label }), src.sub ? el("span", { class:"sub", text:src.sub }) : null]));
      });
      w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"Have you seen the documentation yourself?" }), opts("dx_seen", DX_SEEN)]));
      w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"When was the most recent formal assessment?" }), opts("dx_recency", DX_RECENCY)]));
    }

    w.appendChild(el("label", { class:"fld" }, [el("span", { text:"Anything else about how this was established (optional)" }),
      el("input", { type:"text", value:answers.dx_note || "", placeholder:"Assessed abroad, assessment in progress, records incomplete…",
        oninput:e => { answers.dx_note = e.target.value; } })]));

    const weak = answers.dx_src.length === 0 || answers.dx_src.every(x => x === "educator" || x === "selfid");
    const identified = answers.dx.length && !answers.dx.includes("none") && !answers.dx.includes("nosay");
    if (answers.dx.includes("none"))
      w.appendChild(el("div", { class:"notice bad", text:"Nothing is formally identified for this student. They may still take part if your recruitment criteria allow it, but this session is flagged in the data and will not count toward the neurodivergent sample without a separate justification." }));
    else if (identified && weak)
      w.appendChild(el("div", { class:"notice", text:"This identification rests on judgement or self-identification rather than documentation. That is recorded honestly and is not a problem in itself; it does mean this session is separable in analysis from documented cases, which is exactly why the question is asked." }));
    else if (identified)
      w.appendChild(el("div", { class:"notice ok", text:"Documented identification recorded. This session counts toward the documented neurodivergent sample." }));
    return w;
  },
  info: "ascertain",
  onLeave: () => {
    const named = answers.dx.map(id => (CONDITIONS.find(c => c.id === id) || {}).label);
    log("ED_ascertain","conditions", answers.dx, { labels:named, other: answers.dx_other || null });
    log("ED_ascertain","condition_detail", answers.dx_detail);
    log("ED_ascertain","sources", answers.dx_src);
    log("ED_ascertain","documentation_seen", answers.dx_seen ?? null, { label: DX_SEEN[answers.dx_seen] ?? null });
    log("ED_ascertain","assessment_recency", answers.dx_recency ?? null, { label: DX_RECENCY[answers.dx_recency] ?? null });
    if (answers.dx_note) log("ED_ascertain","note", answers.dx_note);
  },
  valid: () => {
    if (!answers.dx || !answers.dx.length) return false;
    if (answers.dx.includes("other") && !(answers.dx_other || "").trim()) return false;
    if (answers.dx.includes("nosay")) return true;
    // "Not specified" is a click, so an absent subtype is a recorded answer
    // rather than an unanswered question.
    if (CONDITIONS.some(c => c.detail && answers.dx.includes(c.id) && !answers.dx_detail[c.id])) return false;
    return answers.dx_seen !== undefined && answers.dx_recency !== undefined;
  }
});

/* ============================ EDUCATOR TRAINING =========================== */
add({ id:"training_intro", block:"training", bar:"off", skipIf: () => S.mode !== "training",
  stageFn: () => stage(card(el("div", {}, [
    el("div", { class:"eyebrow", text:"Educator training" }),
    el("h1", { text:"Before your first real session" }),
    el("p", { class:"lede", text:"This walkthrough covers the same ground as the written briefing (Annexure 7), but lets you see and click through real examples first. Nothing in this mode is recorded as study data." }),
    el("table", { class:"t", html:
      "<tbody><tr><th>Purpose</th><td>Get comfortable with the two sessions, the capacity decision, and what each screen actually looks like before a real student sits down.</td></tr>" +
      "<tr><th>Length</th><td>About 10 minutes. You can return to this mode any time to refresh yourself.</td></tr></tbody>" })
  ]))),
  panel: () => el("div", { class:"wrap" }, [
    el("div", { class:"eyebrow", text:"Training" }),
    el("h1", { text:"Welcome" }),
    el("p", { class:"lede", text:"There are two real sessions in this study: a child session, where the student makes simple two-way choices, and an educator session, where you answer questions about that same student afterwards. This training walks through both, plus the capacity decision that links them." })
  ]),
  valid: () => true
});

add({ id:"training_capacity", block:"training", bar:"off", skipIf: () => S.mode !== "training",
  stageFn: () => stage(card(el("div", {}, [
    el("h1", { style:"font-size:22px", text:"The capacity decision" }),
    el("p", { text:"This is the one judgement call the whole session structure depends on, so it comes first." })
  ]))),
  panel: () => el("div", { class:"wrap" }, [
    el("div", { class:"eyebrow", text:"Training · Capacity to assent" }),
    el("h1", { text:"How to decide" }),
    el("p", { class:"lede", text:"Guardian permission is required for every student, no exceptions. What changes is whether the student's own assent is also needed, and that depends on whether they can understand a simple explanation and communicate a decision, not on their age or diagnosis." }),
    el("div", { class:"notice", text:"If capable: seek both guardian permission and the student's own assent. If diminished capacity: guardian permission alone governs, but you should still explain the activity simply and invite agreement as good practice." }),
    el("div", { class:"notice bad", text:"In every case, regardless of capacity group: any sign of unwillingness or distress, spoken or not, means stop immediately. This overrides everything else." })
  ]),
  valid: () => true
});

add({ id:"training_ascertain", block:"training", bar:"off", skipIf: () => S.mode !== "training",
  stageFn: () => stage(card(el("div", {}, [
    el("h1", { style:"font-size:22px", text:"Recording what is identified" }),
    el("p", { text:"The second setup screen asks what is identified for the student and how it was established." })
  ]))),
  panel: () => el("div", { class:"wrap" }, [
    el("div", { class:"eyebrow", text:"Training · Ascertainment" }),
    el("h1", { text:"Copy it, do not judge it" }),
    el("p", { class:"lede", text:"You are asked what is on record, not for your own assessment. Subtype and severity are only ever transcribed from documentation, and every one of those questions has a 'Not specified in the records' option that is the correct answer whenever the paperwork is silent, which is most of the time." }),
    el("div", { class:"notice", text:"You are never asked to administer a test or to decide whether a student has a condition. If you have not seen the document yourself, say so: that answer is recorded and is genuinely useful, not a failure." })
  ]),
  valid: () => true
});

add({ id:"training_font_example", block:"training", bar:"off", skipIf: () => S.mode !== "training",
  stageFn: () => stage([
      card(specimen({ fontCss:FONTS[0].css, fontAdj:FONTS[0].adj }, KID_A), "1", { fontCss:FONTS[0].css, fontAdj:FONTS[0].adj }),
      card(specimen({ fontCss:FONTS[2].css, fontAdj:FONTS[2].adj }, KID_A), "2", { fontCss:FONTS[2].css, fontAdj:FONTS[2].adj })],
    "Example only, this is what a real Letters comparison looks like"),
  panel: () => el("div", { class:"wrap" }, [
    el("div", { class:"eyebrow", text:"Training · Example screen" }),
    el("h1", { text:"This is a real comparison screen" }),
    el("p", { class:"lede", text:"A real student would see two versions of the same short passage and pick which they prefer, or say they look the same. Every dimension (letters, size, colours, spacing) works this way: one thing changes at a time, side and order are randomised, and there is always a same-to-me option." }),
    el("div", { class:"notice", text:"Your job during a real session: read the question aloud if needed, let the child point, and do not suggest an answer. If they cannot choose, record the same option rather than guessing for them." })
  ]),
  valid: () => true
});

add({ id:"training_dis_example", block:"training", bar:"off", skipIf: () => S.mode !== "training",
  stageFn: () => stage(mock({ animAd:true }), "Example only, one distractor type of six"),
  panel: () => el("div", { class:"wrap" }, [
    el("div", { class:"eyebrow", text:"Training · Example screen" }),
    el("h1", { text:"This is a real distraction screen" }),
    el("p", { class:"lede", text:"A real student sees a page like this, with one distracting element, and rates how it feels on a three-face scale. You are separately asked what you actually observed, whether they kept reading, looked away and came back, could not get back, or became distressed. Your observation is what feeds the distraction weighting, not the child's rating alone, since behaviour is a more reliable signal than self-report for this age group." })
  ]),
  valid: () => true
});

add({ id:"training_voluntary", block:"training", bar:"off", skipIf: () => S.mode !== "training",
  stageFn: () => stage(card(el("div", {}, [
    el("h1", { style:"font-size:22px", text:"Keeping it voluntary" }),
    el("p", { text:"A familiar adult administering the study is a real, documented risk of implicit pressure. This is how it is managed." })
  ]))),
  panel: () => el("div", { class:"wrap" }, [
    el("div", { class:"eyebrow", text:"Training · Voluntariness" }),
    el("h1", { text:"What to say and do" }),
    el("p", { class:"lede", text:"Make clear participation has nothing to do with grades or your opinion of the student, and can be stopped at any time for any reason. Never record or display who chose not to participate in any way visible to peers or staff." }),
    el("p", { class:"lede", text:"If the optional eye-tracking component applies: explain the camera briefly, run the short calibration and check, and if it does not succeed or the student seems unwilling, skip it entirely and continue as normal. This is never treated as a failure." }),
    el("div", { class:"notice", text:"If a student or guardian asks to withdraw after the session, the Stop now button offers a Withdraw option that marks the whole session as not to be used. Use it rather than deleting files by hand, so the withdrawal is recorded." })
  ]),
  valid: () => true
});

add({ id:"training_complete", block:"training", bar:"off", skipIf: () => S.mode !== "training",
  stageFn: () => stage(card(el("div", {}, [
    el("h1", { style:"font-size:26px", text:"Training complete" }),
    el("p", { text:"You are ready to run real sessions. Come back to this mode any time." })
  ]))),
  panel: () => el("div", { class:"wrap" }, [
    el("div", { class:"eyebrow", text:"Training" }),
    el("h1", { text:"Summary checklist" }),
    el("ul", { html:
      "<li>Guardian permission on file for every student, no exceptions</li>" +
      "<li>Capacity judged per student, not assumed from age or diagnosis</li>" +
      "<li>Assent sought where capable; explained simply either way</li>" +
      "<li>Any unwillingness or distress stops the session, in every group</li>" +
      "<li>Ascertainment copied from records, never judged in the session</li>" +
      "<li>Let the child point; never suggest an answer</li>" +
      "<li>Record what you observe, not just what the child says</li>" +
      "<li>Save all the files at the end before closing the page</li>" }),
    el("p", { class:"hint", text:"Nothing on this screen or in this session is saved as study data. Reload the page to start a real session." })
  ]),
  last: true,
  valid: () => true
});

/* ===================== v5: PHYSICAL SCREEN CALIBRATION ====================
   A browser cannot know how big a CSS pixel is on this screen. Every degree
   of visual angle, every "text was 4.2 mm tall", depends on it. The educator
   holds any ID-1 card (bank card, Aadhaar PVC card, library card: all
   85.60 x 53.98 mm) against the screen and drags until the outline matches.
   Done once per session, before the student sits down. */
const CARD_MM = { w: 85.60, h: 53.98 };
add({ id:"card_match", block:"physical", bar:"off", skipIf: () => !isChild(),
  enter: () => { if (!answers.card_px) answers.card_px = 324; },
  stageFn: () => {
    const w = answers.card_px, h = Math.round(w * CARD_MM.h / CARD_MM.w);
    const box = el("div", { class:"ccard", style:`width:${w}px;height:${h}px`, "data-aoi":"card_outline" });
    stage(card(el("div", {}, [
      el("div", { class:"eyebrow", text:"Setup · screen size" }),
      el("h1", { style:"font-size:20px", text:"Hold a bank card against the screen" }),
      el("p", { class:"lede", text:"Any card the size of a bank card works. Press it flat against the screen over the striped box, then drag the slider until the box is exactly the size of the card." }),
      box
    ])), "Educator only. The child does not need to watch this.");
  },
  panel: () => {
    const w = el("div", { class:"wrap" });
    w.appendChild(el("div", { class:"eyebrow", text:"Setup · physical calibration" }));
    w.appendChild(el("h1", { text:"Match the card" }));
    const r = el("input", { type:"range", min:150, max:700, step:1, value:answers.card_px, style:"width:100%",
      "aria-label":"Card width on screen", oninput:e => { answers.card_px = +e.target.value; answers.card_ok = false; stageOnly(); lab.textContent = answers.card_px + " px wide"; } });
    const lab = el("div", { class:"hint", text: answers.card_px + " px wide" });
    w.appendChild(r); w.appendChild(lab);
    const fine = el("div", { class:"scale" });
    [["−5",-5],["−1",-1],["+1",1],["+5",5]].forEach(([t, d]) => fine.appendChild(el("button", { text:t, onclick:() => { answers.card_px += d; answers.card_ok = false; paint(); } })));
    w.appendChild(fine);
    w.appendChild(el("button", { class:"opt" + (answers.card_ok ? " on" : ""), onclick:() => { answers.card_ok = true; paint(); } },
      [el("span", { text:"The box matches the card exactly" })]));
    if (answers.card_ok) w.appendChild(el("div", { class:"notice ok", text:"1 mm on this screen = " + (answers.card_px / CARD_MM.w).toFixed(3) + " CSS pixels. Do not change the browser zoom for the rest of the session." }));
    w.appendChild(el("p", { class:"hint", text:"No card to hand? Use Skip. Angles will then assume a standard 96 dpi screen, and the data will say so." }));
    return w;
  },
  info: "card_match",
  onLeave: () => {
    if (answers.card_ok) {
      S.physical.px_per_mm = +(answers.card_px / CARD_MM.w).toFixed(4);
      S.physical.card_match = { card_px_w: answers.card_px, card_mm_w: CARD_MM.w, dpr: devicePixelRatio,
        zoom_estimate: +(outerWidth / innerWidth).toFixed(3), t_perf: CLOCK.t() };
    }
    log("physical", "card_match", answers.card_ok ? S.physical.px_per_mm : null, { card_match: S.physical.card_match });
  },
  valid: () => !!answers.card_ok
});
/* Re-render only the left side (the slider must not lose focus mid-drag). */
function stageOnly() { const s = visible()[idx]; if (s && s.stageFn) s.stageFn(); }

/* ======================= CHILD: ASSENT & READING LEVEL =================== */
add({ id:"assent", block:"child_assent", bar:"off", skipIf: () => !isChild(),
  enter: () => say("We are going to look at some words on the screen. Each time, you pick the one you like better. There are no wrong answers. You can stop whenever you want."),
  stageFn: () => stage(card(el("div", {}, [
    el("h1", { style:"font-size:30px", text:"Hello!" }),
    el("div", { style:"font-size:22px;line-height:1.55" }, [
      el("p", { text:"We want to make websites easier to read." }),
      el("p", { text:"We will show you words on the screen." }),
      el("p", { text:"Each time you pick the one you like better." }),
      el("p", { text:"There are no wrong answers." }),
      el("p", { text:"You can stop whenever you want. Just say so." })
    ])
  ]))),
  panel: () => {
    const w = el("div", { class:"wrap" });
    w.appendChild(el("button", { class:"speak", text:"🔊 Read this out again", onclick:() => say("We are going to look at some words on the screen. Each time, you pick the one you like better. There are no wrong answers. You can stop whenever you want.") }));
    const dimin = S.capacity === "diminished";
    w.appendChild(el("div", { class:"eyebrow", text:"Assent, read aloud to the child" }));
    w.appendChild(el("h1", { text:"Is the child happy to start?" }));
    if (dimin) w.appendChild(el("div", { class:"notice", text:"This student was marked as having diminished capacity to assent. Explain the activity in the simplest terms and invite agreement as good practice. Formal assent is not required to proceed, but any sign of unwillingness or distress means stop." }));
    w.appendChild(el("p", { class:"lede", text:"Ask them. If they say no, or seem unsure or distressed, stop here." }));
    w.appendChild(pick("assent", dimin ? [
      { value:"yes", label:"Willing, they are happy to start" },
      { value:"no", label:"Unwilling or distressed, stop the session" }] : [
      { value:"yes", label:"Yes, they want to do it" },
      { value:"no", label:"No, or unsure, stop the session" }]));
    if (answers.assent === "no") w.appendChild(el("div", { class:"notice bad", text:"Stop the session. A student's unwillingness or distress overrides guardian consent for taking part today, in every capacity group." }));
    w.appendChild(el("h2", { text:"Reading level" }));
    w.appendChild(el("p", { class:"hint", text:"Educator: this sets how much text the child is shown. It does not change what is measured." }));
    w.appendChild(pick("reading_level", [
      { value:"pre", label:"Pre-reader", sub:"Recognises few or no words independently" },
      { value:"emerging", label:"Emerging reader", sub:"Reads short simple sentences with effort" },
      { value:"fluent", label:"Reads fairly fluently", sub:"Can read a short paragraph unaided" }]));
    return w;
  },
  info: "assent",
  onLeave: () => { log("child_assent","capacity",S.capacity); log("child_assent","assent",answers.assent); log("child_assent","reading_level",answers.reading_level);
    if (answers.reading_level === "pre") P.cpl = 34; else if (answers.reading_level === "emerging") P.cpl = 44; },
  valid: () => answers.assent === "yes" && answers.reading_level
});


/* ========================== v5: VIDEO CONSENT ============================
   Separate from the study and from eye tracking: a child can take part with
   neither, either, or both. Asked only when the guardian form agrees to video;
   the child's own answer is then required as well, in every capacity group,
   because a camera on the face is the most intrusive thing in the session. */
const VIDEO_SAY = "One more thing. The computer's camera can make a video of your face while you do this. Only the research team will ever watch it, and it is kept safe. It helps us check where your eyes looked. You can say no, and everything else stays the same. You can also ask us to stop it at any time.";
add({ id:"video_consent", block:"consent", bar:"off",
  skipIf: () => !isChild() || !S.consent.guardian_video || !REC.supported(),
  enter: () => say(VIDEO_SAY),
  stageFn: () => stage(card(el("div", {}, [
    el("h1", { style:"font-size:26px", text:"The camera" }),
    el("div", { style:"font-size:21px;line-height:1.55" }, [
      el("p", { text:"The camera can make a video of your face while you do this." }),
      el("p", { text:"Only the research team will watch it. It is kept safe." }),
      el("p", { text:"A small red sign shows on the screen while it is recording." }),
      el("p", { text:"You can say no. Everything else stays the same." }),
      el("p", { text:"You can ask us to stop it at any time." })
    ])
  ]))),
  panel: () => {
    const w = el("div", { class:"wrap" });
    w.appendChild(el("button", { class:"speak", text:"🔊 Read this out again", onclick:() => say(VIDEO_SAY) }));
    w.appendChild(el("div", { class:"eyebrow", text:"Video, read aloud to the child" }));
    w.appendChild(el("h1", { text:"Is the video okay?" }));
    w.appendChild(el("div", { class:"notice", text:"The guardian form agrees to video (form version " + (S.consent.form_version || "not recorded") + "). The student must agree too. If they hesitate, choose No: the session is exactly the same without it." }));
    w.appendChild(el("div", { class:"notice ok", text:"What is recorded: video of the face only, no sound. It is saved on this laptop in 5-second pieces and uploaded to the study's private Drive folder under the child code, never a name. It is kept until " + (S.consent.retention_until || "the date set in the protocol") + "." }));
    w.appendChild(pick("video_ok", [
      { value:"yes", label:"Yes, the student is happy with the video" },
      { value:"no", label:"No video", sub:"The student said no, is unsure, or you would rather not" }]));
    return w;
  },
  info: "video_consent",
  onLeave: () => {
    S.consent.child_video = answers.video_ok === "yes";
    S.video.consented = !!(S.consent.guardian_video && S.consent.child_video);
    S.consent.logged_t_perf.video = CLOCK.t();
    // Logged BEFORE the camera opens on the next screen.
    log("consent", "video_consent", S.video.consented ? "granted" : "declined",
      { guardian: S.consent.guardian_video, child: S.consent.child_video, form_version: S.consent.form_version, audio: false });
  },
  valid: () => !!answers.video_ok
});

/* ----------------------------------------------------- camera + recording */
/* Keyed off the answer, not S.video.consented, for the same router reason as
   gaze_check below. */
const videoWanted = () => isChild() && !!S.consent.guardian_video && answers.video_ok === "yes" && REC.supported();
add({ id:"cam_setup", block:"camera", bar:"off",
  skipIf: () => !videoWanted(),
  enter: () => {
    if (S._camSetup) return;
    S._camSetup = "opening";
    (async () => {
      S.video.storage_before = await storageEstimate();
      const ok = await CAM.open();
      S.video.camera = CAM.info();
      if (ok) {
        const started = await REC.start(S.session_id);
        if (started) await SYNC.flash("recording_start");
        S.video.recording_started_t_perf = started ? CLOCK.t() : null;
        // The face model runs from here so framing and face quality work even
        // if eye tracking is later declined. No gaze is stored without gaze consent.
        try { GAZE.init().then(() => paint()); } catch (e) {}
      }
      S._camSetup = ok ? "open" : "failed";
      paint();
    })();
  },
  stageFn: () => stage(card(el("div", {}, [
    el("h1", { style:"font-size:24px", text:"Getting the camera ready" }),
    el("p", { class:"lede", text:"The screen will blink white once when the video starts. That is normal." })
  ]))),
  panel: () => {
    const w = el("div", { class:"wrap" });
    w.appendChild(el("div", { class:"eyebrow", text:"Camera · setup" }));
    const st = S._camSetup, inf = S.video.camera || {}, s = inf.settings || {};
    if (st === "opening" || !st) {
      w.appendChild(el("h1", { text:"Opening the camera…" }));
      w.appendChild(el("div", { class:"notice", text:"If the browser asks for camera permission, allow it." }));
      return w;
    }
    if (st === "failed") {
      w.appendChild(el("h1", { text:"No camera" }));
      w.appendChild(el("div", { class:"notice bad", html:"<strong>Video will not be recorded.</strong> The camera could not be opened (" +
        ((inf.attempts || []).map(a => a.step + ": " + (a.error || "ok")).join(", ") || inf.reason || "unknown") + "). The rest of the session is unaffected." }));
      return w;
    }
    w.appendChild(el("h1", { text: REC.recording() ? "Camera on, recording" : "Camera on" }));
    const sto = S.video.storage_before || {};
    const needMB = Math.round(45 * VIDEO_CFG.bitrate / 8 * 60 / 1e6 * 1.2);
    const freeMB = sto.free_bytes ? Math.round(sto.free_bytes / 1e6) : null;
    w.appendChild(el("table", { class:"t", html:"<tbody>" +
      "<tr><th>Camera</th><td>" + (inf.label || "unnamed") + "</td></tr>" +
      "<tr><th>Got</th><td>" + (s.width || "?") + " × " + (s.height || "?") + " at " + (s.frameRate ? Math.round(s.frameRate) : "?") + " fps</td></tr>" +
      "<tr><th>Recording</th><td>" + (REC.recording() ? REC.mime() + ", " + Math.round(VIDEO_CFG.bitrate / 1000) + " kbit/s" : "not recording") + "</td></tr>" +
      "<tr><th>Space needed (45 min)</th><td>about " + needMB + " MB</td></tr>" +
      "<tr><th>Space free for this page</th><td>" + (freeMB === null ? "unknown" : freeMB + " MB") + "</td></tr></tbody>" }));
    if (freeMB !== null && freeMB < needMB) w.appendChild(el("div", { class:"notice bad", text:"There may not be enough space on this laptop for the whole video. Free some disk space, or continue and keep the session short. Video pieces already uploaded are removed from the queue as space is needed only after you clear them at the end." }));
    if ((s.width || 0) < 1280) w.appendChild(el("div", { class:"notice", text:"This camera gave less than 720p. That is recorded and is fine; it only limits how precisely the video can be re-analysed later." }));
    if (!FRAMES.supported()) w.appendChild(el("div", { class:"notice bad", text:"This browser cannot time individual video frames. The video will record, but it cannot be aligned frame by frame. Use a current version of Chrome or Edge." }));
    return w;
  },
  info: "cam_setup",
  onLeave: () => log("camera", "camera_setup", S._camSetup || "unknown",
    { camera: S.video.camera, storage: S.video.storage_before, recording: REC.recording(), mime: REC.mime(), frame_callback: FRAMES.supported() }),
  valid: () => S._camSetup === "open" || S._camSetup === "failed"
});

/* ------------------------------------------------------------ framing check
   A badly framed face makes the video useless for every later analysis, and
   nothing about a bad frame is visible once the session is over. Six automatic
   checks, each green / amber / red, read from the face model in real time.
   The live preview is HIDDEN again the moment this screen is left: a child
   watching their own face is a distractor, in a study about distraction. */
const FRAMING = (function () {
  let timer = null, oval = null;
  function place() {
    const box = document.querySelector("#stage .framebox"), v = $("#camview");
    if (!box || !v) return;
    const r = box.getBoundingClientRect();
    Object.assign(v.style, { position:"fixed", left:r.left + "px", top:r.top + "px", width:r.width + "px", height:r.height + "px",
      opacity:"1", transform:"scaleX(-1)", objectFit:"cover", zIndex:"5" });
    if (!oval) { oval = el("div", { class:"oval" }); oval.style.position = "fixed"; oval.style.zIndex = "6"; document.body.appendChild(oval); }
    Object.assign(oval.style, { left:(r.left + r.width / 2) + "px", top:(r.top + r.height * 0.48) + "px", width:(r.width * 0.34) + "px", height:(r.height * 0.62) + "px",
      transform:"translate(-50%,-50%)", border:"4px dashed #fff", borderRadius:"50%", pointerEvents:"none" });
  }
  function grade(v, g, a) { return v === null || v === undefined ? "n" : (v <= g ? "g" : v <= a ? "a" : "r"); }
  function evaluate() {
    const f = FACEQ.latest();
    const fresh = f && (CLOCK.t() - f.t_perf) < 1500;
    const c = {};
    if (!fresh) {
      const model = GAZE.health() === "dead" ? "the face model is not running" : "waiting for the face model";
      ["face","centred","distance","eyes","lighting","level"].forEach(k => c[k] = { g:"n", why:model });
      return { checks:c, pass:false, raw:null };
    }
    c.face = f.face_detected ? { g:"g", why:"found" } : { g:"r", why:"no face in view" };
    if (!f.face_detected) { ["centred","distance","eyes","lighting","level"].forEach(k => c[k] = { g:"n", why:"no face" }); return { checks:c, pass:false, raw:f }; }
    const cx = (f.box_x + f.box_w / 2) / f.img_w, cy = (f.box_y + f.box_h / 2) / f.img_h;
    const off = Math.max(Math.abs(cx - 0.5) / 0.6, Math.abs(cy - 0.5) / 0.75);
    c.centred = { g: grade(off, 0.2, 0.33), why: "offset " + Math.round(off * 100) + "%" };
    const r = f.interocular_px / f.img_w;
    const dg = r >= 0.075 && r <= 0.13 ? "g" : (r >= 0.06 && r <= 0.16 ? "a" : "r");
    c.distance = { g:dg, why: r < 0.075 ? "too far back" : r > 0.13 ? "too close" : "about right", ratio:+r.toFixed(3) };
    const eyesOpen = Math.min(f.ear_left, f.ear_right);
    c.eyes = { g: Math.abs(f.yaw_deg) > 30 ? "r" : (eyesOpen > 0.15 && Math.abs(f.yaw_deg) < 20 ? "g" : "a"),
      why: Math.abs(f.yaw_deg) > 20 ? "head turned (" + Math.round(f.yaw_deg) + "°)" : eyesOpen > 0.15 ? "both visible" : "eyes look closed or hidden" };
    if (f.face_brightness === null) c.lighting = { g:"n", why:"measuring" };
    else {
      const back = (f.bg_brightness || 0) - f.face_brightness;
      let g = f.face_brightness >= 70 && f.face_brightness <= 210 ? "g" : (f.face_brightness >= 45 && f.face_brightness <= 230 ? "a" : "r");
      if (back > 70) g = "r"; else if (back > 40 && g === "g") g = "a";
      c.lighting = { g, why: back > 40 ? "bright behind the child (backlit)" : f.face_brightness < 70 ? "face is dark" : f.face_brightness > 210 ? "face is very bright" : "fine",
        face: f.face_brightness, background: f.bg_brightness };
    }
    c.level = { g: grade(Math.abs(f.roll_deg), 8, 15), why: "tilt " + Math.round(f.roll_deg) + "°" };
    const vals = Object.values(c).map(x => x.g);
    return { checks:c, pass: c.face.g === "g" && !vals.includes("r") && !vals.includes("n"), raw:f };
  }
  return {
    start(onTick) { stop(); requestAnimationFrame(place); timer = setInterval(() => { place(); onTick(evaluate()); }, 300); addEventListener("resize", place); },
    stop, evaluate
  };
  function stop() {
    clearInterval(timer); timer = null; removeEventListener("resize", place);
    const v = $("#camview"); if (v) v.removeAttribute("style");
    if (oval) { oval.remove(); oval = null; }
  }
})();
const LIGHTING = ["Window behind the child", "Window beside the child", "Window in front of the child", "Overhead lights only", "Mixed or other"];
const CHECK_NAMES = { face:"Face found", centred:"Face centred", distance:"Distance from screen", eyes:"Both eyes visible", lighting:"Lighting", level:"Head level" };
function framingScreen(id, skipIf, label) {
  add({ id, block:"camera", bar:"off", skipIf,
    enter: () => { say("Sit comfortably and look at the screen. Move a little until your face is inside the oval."); },
    stageFn: () => {
      const box = el("div", { class:"framebox", style:"aspect-ratio:4/3" });
      stage(card(el("div", {}, [el("h1", { style:"font-size:22px", text:"Find your face in the oval" }), box])),
        "Live camera preview, shown only on this screen");
    },
    panel: () => {
      const w = el("div", { class:"wrap" });
      w.appendChild(el("div", { class:"eyebrow", text:"Camera · " + label }));
      w.appendChild(el("h1", { text:"Is the face well framed?" }));
      const grid = el("div", { class:"checks" });
      w.appendChild(grid);
      const status = el("div", { class:"notice", text:"Checking…" });
      w.appendChild(status);
      FRAMING.start(res => {
        S._frame = res;
        grid.innerHTML = "";
        Object.keys(CHECK_NAMES).forEach(k => { const x = res.checks[k] || { g:"n", why:"" };
          grid.appendChild(el("span", { class:"chk " + x.g })); grid.appendChild(el("span", { text: CHECK_NAMES[k] + " · " + x.why })); });
        status.className = "notice " + (res.pass ? "ok" : "");
        status.textContent = res.pass ? "All checks pass. Press Next: the preview will disappear." : "Adjust the laptop screen angle, the chair, or the lights until every dot is green (amber is acceptable).";
        const o = document.querySelector("body > .oval"); if (o) o.style.borderStyle = res.pass ? "solid" : "dashed";
        if (!!res.pass !== !!S._framePassShown) { S._framePassShown = !!res.pass; validate(); }
      });
      if (!S.physical.room_lighting) {
        w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"Educator: where is the main light coming from?" }),
          pick("room_light", LIGHTING.map(l => ({ value:l, label:l })))]));
        w.appendChild(el("button", { class:"opt" + (answers.bright_ok ? " on" : ""), onclick:() => { answers.bright_ok = !answers.bright_ok; paint(); } },
          [el("span", { text:"Screen brightness is set to about half" }), el("span", { class:"sub", text:"Same setting for every session, so screen light on the face is comparable." })]));
      }
      w.appendChild(el("h2", { text:"Cannot get it green?" }));
      w.appendChild(el("label", { class:"fld" }, [el("span", { text:"Continue anyway, and say why (recorded)" }),
        el("input", { type:"text", value: answers[id + "_override"] || "", placeholder:"e.g. no blinds on the window; child needs to sit to the side",
          oninput:e => { answers[id + "_override"] = e.target.value; validate(); } })]));
      return w;
    },
    info: "framing",
    onLeave: () => {
      const res = S._frame || FRAMING.evaluate();
      FRAMING.stop();
      if (answers.room_light && !S.physical.room_lighting) S.physical.room_lighting = answers.room_light;
      if (answers.bright_ok) S.physical.screen_brightness_confirmed = true;
      const ov = (answers[id + "_override"] || "").trim();
      const rec = { screen:id, t_perf:CLOCK.t(), pass:!!res.pass, override: !res.pass ? (ov || null) : null,
        checks: res.checks, face: res.raw ? { iod:res.raw.interocular_px, img_w:res.raw.img_w, brightness:res.raw.face_brightness, bg:res.raw.bg_brightness, yaw:res.raw.yaw_deg, roll:res.raw.roll_deg } : null };
      S.framing.push(rec);
      log("camera", "framing_check", res.pass ? "pass" : (ov ? "override" : "fail"), rec);
      log("camera", "room_lighting", S.physical.room_lighting, { screen_brightness_half_confirmed: !!S.physical.screen_brightness_confirmed,
        face_brightness: res.raw ? res.raw.face_brightness : null, bg_brightness: res.raw ? res.raw.bg_brightness : null });
    },
    valid: () => {
      const lightOk = !!S.physical.room_lighting || (!!answers.room_light && !!answers.bright_ok);
      const ok = (S._frame && S._frame.pass) || (answers[id + "_override"] || "").trim().length >= 4;
      return lightOk && ok;
    }
  });
}
framingScreen("framing", () => !videoWanted() || S._camSetup !== "open", "framing");

/* =========================================================================
   READER CONTEXT
   -------------------------------------------------------------------------
   Everything on this screen is a variable that changes what a typography
   result MEANS, and none of it can be recovered after the session.

   Language. This study runs in India and its stimuli are in English. Whether
   English is a student's first language or their third changes what a font or
   a text-complexity preference is measuring: for an L2 reader a "harder to
   read" judgement may be about vocabulary rather than letterforms. Without
   this field every language-related result is uninterpretable and there is no
   way to add it later.

   Vision. A typography study that does not record whether the reader can see
   properly is measuring the wrong thing. A student who needs glasses and is
   not wearing them will prefer larger text for a reason that has nothing to do
   with neurodivergence, and pooling them with corrected readers quietly biases
   the size and spacing results.

   Today. Attention and reading tolerance move with tiredness, illness, routine
   changes and whether usual medication was taken. These are the standard
   covariates for a single-sitting attention measure, and asking costs seconds.
   ========================================================================= */
const LANGS = ["English", "Hindi", "Bengali", "Marathi", "Tamil", "Telugu", "Gujarati",
               "Kannada", "Malayalam", "Punjabi", "Urdu", "Odia", "Assamese", "Other"];

add({ id:"context", block:"ED_context", bar:"off",
  skipIf: () => !isChild(),
  enter: () => { answers.ctx_today = answers.ctx_today || []; },
  stageFn: () => stage(card(el("div", {}, [
    el("div", { class:"eyebrow", text:"Setup" }),
    el("h1", { text:"Reading this student's answers correctly" }),
    el("p", { class:"lede", text:"Four things change what this session's results mean. None of them can be worked out afterwards from the data, so they are asked now." }),
    el("table", { class:"t", html:
      "<tbody>" +
      "<tr><th>Language</th><td>The passages are in English. For a student reading in a second or third language, a judgement about difficulty may be about the words rather than the letters.</td></tr>" +
      "<tr><th>Vision</th><td>A student who needs glasses and is not wearing them will prefer bigger text for a reason unrelated to this study.</td></tr>" +
      "<tr><th>Today</th><td>Tiredness, illness or a change in routine move attention and reading tolerance within a single sitting.</td></tr>" +
      "<tr><th>When</th><td>Where in the school day this falls, for the same reason.</td></tr>" +
      "</tbody>" })
  ]))),
  panel: () => {
    const w = el("div", { class:"wrap" });
    w.appendChild(el("div", { class:"eyebrow", text:"Reader context" }));

    w.appendChild(el("h2", { text:"Language" }));
    w.appendChild(el("label", { class:"fld" }, [el("span", { text:"Student's first language, the one spoken at home" }),
      (() => { const s = el("select", { onchange:e => { answers.ctx_l1 = e.target.value; validate(); } });
        s.appendChild(el("option", { value:"", text:"Choose…" }));
        LANGS.forEach(l => s.appendChild(el("option", { value:l, text:l })));
        if (answers.ctx_l1) s.value = answers.ctx_l1;
        return s; })()]));
    if (answers.ctx_l1 === "Other")
      w.appendChild(el("label", { class:"fld" }, [el("span", { text:"Which language?" }),
        el("input", { type:"text", value:answers.ctx_l1_other || "", oninput:e => { answers.ctx_l1_other = e.target.value; validate(); } })]));
    w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"Main language of teaching at this school" }),
      opts("ctx_medium", ["English","Hindi","Both equally","Another language"])]));
    w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"How comfortable is this student reading English specifically?" }),
      opts("ctx_eng", ["Not really reading English yet","Reads English with help","Fairly comfortable","As comfortable as their first language"])]));

    w.appendChild(el("h2", { text:"Vision" }));
    w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"Does this student use glasses or contact lenses for reading?" }),
      pick("ctx_glasses", [
        { value:"no",       label:"No" },
        { value:"yes_on",   label:"Yes, and they are wearing them now", sub:"Preferences are measured with their usual correction" },
        { value:"yes_off",  label:"Yes, but they are not wearing them now", sub:"Flagged: size and spacing results for this student are not comparable with corrected readers" },
        { value:"unknown",  label:"Not known" }])]));
    if (answers.ctx_glasses === "yes_off")
      w.appendChild(el("div", { class:"notice bad", text:"If the glasses are available, fetch them before starting. If not, the session can still run, but this is recorded and the typography results for this student will be analysed separately." }));
    w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"When was this student's vision last checked?" }),
      opts("ctx_eyetest", ["Within the last year","1-3 years ago","Longer ago","Never, as far as you know","Not known"])]));

    w.appendChild(el("h2", { text:"Today" }));
    w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"Where does this session fall in the school day?" }),
      opts("ctx_when", ["Start of the day","Mid-morning","Just after lunch","End of the day"])]));
    w.appendChild(el("div", { class:"q" }, [
      el("div", { class:"q-t", text:"Anything different about this student today? (choose any that apply)" }),
      (() => { const c = el("div");
        [["nothing","Nothing unusual"],["tired","Seems tired"],["unwell","Unwell"],
         ["upset","Upset or unsettled"],["routine","Change in routine"],
         ["meds","Usual medication not taken as normal"]].forEach(([v, t]) =>
          c.appendChild(el("button", { class:"chip" + (answers.ctx_today.includes(v) ? " on" : ""), text:t,
            onclick:() => {
              const i = answers.ctx_today.indexOf(v);
              if (i < 0) { answers.ctx_today = v === "nothing" ? ["nothing"] : answers.ctx_today.filter(x => x !== "nothing").concat(v); }
              else answers.ctx_today.splice(i, 1);
              paint();
            } })));
        return c; })()]));
    w.appendChild(el("p", { class:"hint", text:"The medication item is asked only because attention and distraction tolerance are what this session measures. Leave it unselected if it does not apply or you would rather not say." }));
    return w;
  },
  info: "context",
  onLeave: () => {
    log("ED_context","first_language", answers.ctx_l1 === "Other" ? (answers.ctx_l1_other || "Other") : answers.ctx_l1);
    log("ED_context","medium_of_instruction", answers.ctx_medium ?? null);
    log("ED_context","english_reading_comfort", answers.ctx_eng ?? null);
    log("ED_context","vision_correction", answers.ctx_glasses ?? null,
      { corrected_now: answers.ctx_glasses === "yes_on" || answers.ctx_glasses === "no",
        uncorrected_flag: answers.ctx_glasses === "yes_off" });
    log("ED_context","vision_last_checked", answers.ctx_eyetest ?? null);
    log("ED_context","time_of_day", answers.ctx_when ?? null);
    log("ED_context","today", answers.ctx_today);
  },
  valid: () => !!answers.ctx_l1
    && (answers.ctx_l1 !== "Other" || (answers.ctx_l1_other || "").trim())
    && answers.ctx_medium !== undefined && answers.ctx_eng !== undefined
    && !!answers.ctx_glasses && answers.ctx_eyetest !== undefined
    && answers.ctx_when !== undefined && answers.ctx_today.length > 0
});


/* ============================ CHILD: PAIRWISE ============================ */
function pairBlock(cfg) {
  cfg.pairs.forEach((_, n) => {
    add({ id:cfg.id + "_" + n, block:cfg.block,
      skipIf: () => !isChild() || (cfg.pairOk && !cfg.pairOk(cfg.pairs[n])),
      enter: () => { if (!ORDER[cfg.id]) ORDER[cfg.id] = cfg.pairs; say(cfg.prompt); },
      stageFn: () => {
        const [a, b] = ORDER[cfg.id][n];
        stage([card(specimen(cfg.over(a), cfg.text ? cfg.text(0) : KID_A), "1", cfg.over(a)),
               card(specimen(cfg.over(b), cfg.text ? cfg.text(1) : KID_A), "2", cfg.over(b))],
              `${cfg.label}, pair ${n + 1} of ${ORDER[cfg.id].length}`);
      },
      panel: () => {
        const [a, b] = ORDER[cfg.id][n];
        const key = cfg.id + "_" + n;
        const w = el("div", { class:"wrap" });
        w.appendChild(el("button", { class:"speak", text:"🔊 Say it again", onclick:() => say(cfg.prompt) }));
        w.appendChild(el("div", { class:"eyebrow", text:`${cfg.label} · ${n + 1} of ${ORDER[cfg.id].length}` }));
        w.appendChild(el("h1", { text:cfg.question }));
        const row = el("div", { class:"pair" });
        [["Top one", a], ["Bottom one", b]].forEach(([lab, v], i) => {
          row.appendChild(el("button", { class: answers[key] === v ? "on" : "", onclick:() => { answers[key] = v; paint(); } },
            [el("span", { class:"which", text:i === 0 ? "1" : "2" }), el("span", { text:lab }), el("span", { class:"kbd", text:String(i + 1) })]));
        });
        w.appendChild(row);
        w.appendChild(el("button", { class:"opt" + (answers[key] === "same" ? " on" : ""),
          onclick:() => { answers[key] = "same"; paint(); } },
          [el("span", { text:"They look the same to me" }), el("span", { class:"kbd", text:"3" })]));
        w.appendChild(el("p", { class:"hint", text:"Educator: let the child point. Do not suggest an answer, and record “the same” if they cannot choose. Keys 1, 2 and 3 work too." }));
        // Keyboard is for the educator's hands, not the child's: in practice
        // the child points and the adult records, often while also steadying a
        // page or a student, and reaching for a mouse each time is friction
        // that shows up as latency noise in the data.
        KEYS.set({ "1": () => { answers[key] = a; paint(); },
                   "2": () => { answers[key] = b; paint(); },
                   "3": () => { answers[key] = "same"; paint(); } });
        return w;
      },
      onLeave: () => {
        const [a, b] = ORDER[cfg.id][n], key = cfg.id + "_" + n, v = answers[key];
        // Each side is hashed as rendered. Hashing the session's current
        // settings would give every pair in a block the same stimulus hash and
        // record nothing about what was actually on screen.
        const pa = Object.assign({}, P, cfg.over(a)), pb = Object.assign({}, P, cfg.over(b));
        log(cfg.block, "pairwise", v, { comparison:cfg.id, shown_top:a, shown_bottom:b,
          winner: v === "same" ? null : v, loser: v === "same" ? null : (v === a ? b : a),
          tie: v === "same", pair_index:n,
          stimulus_top: pa, stimulus_bottom: pb,
          stimulus_hash_top: hash(pa), stimulus_hash_bottom: hash(pb),
          hover: HOVER.snapshot() });
      },
      valid: () => answers[cfg.id + "_" + n] !== undefined
    });
  });
}

/* ===================== CHILD: PRACTICE / COMPREHENSION ==================== */
add({ id:"comprehension", block:"C_practice", skipIf: () => !isChild(),
  enter: () => say("Let us practise. Here are two. One is big and easy to see. One is very small. Point to the one that is easier to see."),
  stageFn: () => stage([
      card(specimen({ sizePx:34 }, "The dog ran."), "1", { sizePx:34 }),
      card(specimen({ sizePx:11 }, "The dog ran."), "2", { sizePx:11 })],
    "Practice, this one has an easy answer"),
  panel: () => {
    const w = el("div", { class:"wrap" });
    w.appendChild(el("button", { class:"speak", text:"🔊 Say it again", onclick:() => say("Point to the one that is easier to see.") }));
    w.appendChild(el("div", { class:"eyebrow", text:"Practice" }));
    w.appendChild(el("h1", { text:"Which one is easier to see?" }));
    const row = el("div", { class:"pair" });
    [["Top one","big"],["Bottom one","small"]].forEach(([lab,v],i) => {
      row.appendChild(el("button", { class: answers.comprehension === v ? "on" : "", onclick:() => { answers.comprehension = v; paint(); } },
        [el("span", { class:"which", text:i===0?"1":"2" }), el("span", { text:lab }), el("span", { class:"kbd", text:String(i+1) })]));
    });
    w.appendChild(row);
    KEYS.set({ "1": () => { answers.comprehension = "big"; paint(); },
               "2": () => { answers.comprehension = "small"; paint(); } });
    w.appendChild(el("p", { class:"hint", text:"Educator: this is a practice item with an obvious answer. It checks the child understood the task. Let them point; do not steer. It is fine to continue whatever they pick." }));
    if (answers.comprehension === "small") w.appendChild(el("div", { class:"notice", text:"The bigger one is the easier one to see. Re-explain the task simply, then carry on. This is recorded as a task-understanding check, not a test the child can fail." }));
    return w;
  },
  info: "comprehension",
  onLeave: () => log("C_practice","comprehension_check", answers.comprehension, { expected:"big", passed: answers.comprehension === "big" }),
  valid: () => answers.comprehension !== undefined
});

pairBlock({ id:"font", block:"C_typeface", label:"Letters", pairs:allPairs(FONTS.map(f => f.id)),
  prompt:"Look at both. Which one do you want to read?", question:"Which one do you want to read?",
  // A pair is only meaningful if both typefaces actually rendered as themselves.
  pairOk: p => { const bad = FONTHEALTH.failed(); return !bad.includes(p[0]) && !bad.includes(p[1]); },
  over:id => { const f = FONTS.find(x => x.id === id); return { fontCss:f.css, fontAdj:f.adj }; } });

pairBlock({ id:"size", block:"C_size", label:"Size", pairs:allPairs(SIZES.map(String)),
  prompt:"Which one is easier for your eyes?", question:"Which is easier for your eyes?",
  over:v => ({ sizePx:+v }) });

pairBlock({ id:"colour", block:"D_colour", label:"Colours", pairs:allPairs(COLOURS.map(c => c.id)),
  prompt:"Which one is nicer to look at for a long time?", question:"Which is nicer to look at for a long time?",
  over:id => { const c = COLOURS.find(x => x.id === id); return { fg:c.fg, bg:c.bg }; } });

pairBlock({ id:"lead", block:"C_spacing", label:"Line spacing", pairs:allPairs(LEADINGS.map(String)),
  prompt:"Which one is easier to follow?", question:"Which is easier to follow?",
  over:v => ({ lineHeight:+v }) });

pairBlock({ id:"track", block:"C_spacing", label:"Letter spacing", pairs:allPairs(SPACING.map(String)),
  prompt:"Which one is easier to read?", question:"Which is easier to read?",
  over:v => ({ tracking:+v }) });



/* ===================== CHILD: OPTIONAL GAZE COMPONENT ==================== */
/* The gaze arm exists to support ONE contrast: this student reading in plain
   settings versus the same student reading in their own chosen settings. A
   webcam tracker is poor at saying where someone looked and much less poor at
   saying whether the same person looked at the text more in one condition than
   the other, because a constant per-participant offset subtracts out. Every
   decision below protects that contrast and claims nothing beyond it. */
const gazeOn = () => isChild() && GAZE.available() && GAZE.consent === "granted" && !S.gaze_off && GAZE.health() === "live";

/* v5: what is said aloud must match what is recorded. With video consented
   the camera is already recording, so the old line "it does not save a
   picture or video of you" would now be false; without video it stays true. */
const gazeSay = () => S.video.consented
  ? "There is one more optional part. The camera that is already making the video can also work out where on the screen your eyes look while you read. You can say no, and it is still fine."
  : "There is one more optional part. The computer's camera can watch where your eyes look while you read. It does not keep any picture of you, only where you looked. You can say no, and it is still fine.";
add({ id:"gaze_consent", block:"gaze", bar:"off",
  skipIf: () => !(isChild() && GAZE.available() && S.consent.guardian_gaze !== false),
  enter: () => say(gazeSay()),
  stageFn: () => stage(card(el("div", {}, [
    el("h1", { style:"font-size:24px", text:"An optional eye part" }),
    el("div", { style:"font-size:20px;line-height:1.55" }, S.video.consented ? [
      el("p", { text:"The camera is already making the video, like we said." }),
      el("p", { text:"Now it can also work out where your eyes look on the screen." }),
      el("p", { text:"You will look at some dots first." }),
      el("p", { text:"You can say no. That is completely fine." })
    ] : [
      el("p", { text:"The camera can see where your eyes go while you read." }),
      el("p", { text:"It does not save a picture or video of you." }),
      el("p", { text:"It only writes down where on the screen you looked." }),
      el("p", { text:"You can say no. That is completely fine." })
    ])
  ]))),
  panel: () => {
    const w = el("div", { class:"wrap" });
    w.appendChild(el("button", { class:"speak", text:"🔊 Read this out again", onclick:() => say(gazeSay()) }));
    w.appendChild(el("div", { class:"eyebrow", text:"Optional, read aloud to the child" }));
    w.appendChild(el("h1", { text:"Is this eye part okay?" }));
    w.appendChild(el("div", { class:"notice", text:"Educator: proceed here only if the guardian agreed to eye tracking on the consent form (recorded at setup) and the student agrees now. If the student is unsure, choose Skip. This never affects the rest of the study." }));
    w.appendChild(el("div", { class:"notice ok", text: S.video.consented
      ? "What this adds: screen coordinates of where the eyes are estimated to look, saved alongside the video the student has already agreed to. The calibration dots are also saved with their exact times, so the video can be re-analysed later with a better model."
      : "What this build collects here: the camera image is processed inside the browser to estimate where the eyes are pointing, and only the resulting screen coordinates are saved. No video frame is stored, because video was not agreed for this session." }));
    w.appendChild(pick("gaze_ok", [
      { value:"yes", label:"Yes, that is okay", sub:"Guardian and student both agreed" },
      { value:"no", label:"Skip this part", sub:"Not agreed, or the student would rather not" }]));
    if (answers.gaze_ok === "yes") {
      w.appendChild(el("div", { class:"q" }, [
        el("div", { class:"q-t", text:"Roughly how far is the student's face from the screen?" }),
        opts("dist_band", DISTANCE_BANDS.map(d => d.label))]));
      w.appendChild(el("p", { class:"hint", text:"An estimate is fine. It is used only if the blind-spot distance measurement (coming up) is skipped, and the band is recorded so the assumption is visible." }));
    }
    return w;
  },
  info: "gaze_consent",
  onLeave: () => {
    GAZE.consent = answers.gaze_ok === "yes" ? "granted" : "declined";
    S.consent.child_gaze = answers.gaze_ok === "yes";
    S.consent.logged_t_perf.gaze = CLOCK.t();
    log("gaze","gaze_consent", GAZE.consent, { method: GAZE.method, guardian: S.consent.guardian_gaze, child: S.consent.child_gaze,
      distance_band: DISTANCE_BANDS[answers.dist_band] ? DISTANCE_BANDS[answers.dist_band].cm : null });
    // The camera is only ever started AFTER consent is recorded here.
    if (GAZE.consent === "granted") { try { GAZE.init().then(() => paint()); } catch (e) {} }
  },
  valid: () => answers.gaze_ok === "no" || (answers.gaze_ok === "yes" && answers.dist_band !== undefined)
});

/* --------------------------------------------------------- camera check */
/* Keyed off the answer, not GAZE.consent, on purpose: GAZE.consent is set in
   the previous screen's onLeave, and the router picks the next index from the
   list as it stood BEFORE that ran. A screen that only becomes visible during
   onLeave is inserted behind the cursor and silently stepped over. */
add({ id:"gaze_check", block:"gaze", bar:"off",
  skipIf: () => !(isChild() && answers.gaze_ok === "yes" && !S.gaze_off),
  enter: () => { if (GAZE.health() === null) { try { GAZE.init().then(() => paint()); } catch (e) {} } },
  stageFn: () => stage(card(el("div", {}, [
    el("h1", { style:"font-size:26px", text:"Getting the camera ready" }),
    el("p", { class:"lede", text:"This takes a few seconds. Nothing is being recorded yet." })
  ]))),
  panel: () => {
    const w = el("div", { class:"wrap" });
    w.appendChild(el("div", { class:"eyebrow", text:"Eye tracking · Check" }));
    const h = GAZE.health();
    if (h === "live") {
      w.appendChild(el("h1", { text:"Camera is working" }));
      w.appendChild(el("div", { class:"notice ok", text:"The tracker is producing readings. Press Next to calibrate." }));
    } else if (h === "dead") {
      w.appendChild(el("h1", { text:"Camera is not usable" }));
      w.appendChild(el("div", { class:"notice bad", html:
        "<strong>The eye-tracking part will be skipped.</strong> The tracker started but never produced a reading, so calibration and the reading measurement would collect nothing. This is a normal, expected outcome and the rest of the session is completely unaffected. Reason recorded: <code>" +
        (GAZE.healthReason || "unknown") + "</code>." }));
      w.appendChild(el("div", { class:"notice", text:"If this happens on every session, the tracker's face-model files are most likely not being served alongside this page. See the deployment note at the top of this file." }));
    } else {
      w.appendChild(el("h1", { text:"Checking…" }));
      w.appendChild(el("div", { class:"notice", text:"Waiting for the camera to produce a reading. If the browser is asking for camera permission, allow it." }));
    }
    return w;
  },
  info: "gaze_check",
  onLeave: () => {
    const h = GAZE.health();
    if (h !== "live") { S.gaze_off = true; try { GAZE.end(); } catch (e) {} }
    if (!S.video.camera) S.video.camera = CAM.info();
    log("gaze","camera_check", h || "unknown", { reason: GAZE.healthReason, camera: CAM.info() });
  },
  valid: () => GAZE.health() === "live" || GAZE.health() === "dead"
});

/* --------------------------------------------- v5: framing, then distance */
framingScreen("framing2", () => !(isChild() && answers.gaze_ok === "yes" && !S.gaze_off && GAZE.health() === "live"), "before calibration");

/* Viewing distance by the blind spot ("virtual chinrest", Li, Joo, Yeatman &
   Reinecke 2020, about 3 cm error). The optic disc sits ~13.5 degrees from
   fixation, so the on-screen distance at which a moving dot vanishes, in mm
   (from the card match), gives the eye-to-screen distance. Optional: some
   students will not manage it, and the educator's band is then used. */
const BS_DEG = 13.5, BS_SPEED = 50;   // css px per second; slow, because the educator's reaction time adds to the distance
add({ id:"distance", block:"physical", bar:"off",
  skipIf: () => !(isChild() && answers.gaze_ok === "yes" && !S.gaze_off && GAZE.health() === "live" && S.physical.px_per_mm),
  enter: () => { if (!S._bs) S._bs = { trials:[], run:null }; say("Cover your right eye with your hand. Keep looking at the black square. Say gone when the red dot disappears."); },
  stageFn: () => {
    const host = el("div", { class:"bs", "data-aoi":"blind_spot_area" });
    host.appendChild(el("div", { class:"fix", style:"right:40px" }));
    host.appendChild(el("div", { class:"ball", style:"display:none" }));
    stage(card(el("div", {}, [el("h1", { style:"font-size:20px", text:"Cover your right eye. Look at the black square." }), host])),
      "Distance check, keep looking at the square, not at the dot");
  },
  panel: () => {
    const w = el("div", { class:"wrap" });
    const b = S._bs;
    w.appendChild(el("div", { class:"eyebrow", text:"Setup · viewing distance" }));
    w.appendChild(el("h1", { text:"How far away is the student?" }));
    w.appendChild(el("p", { class:"lede", text:"The student covers their RIGHT eye and keeps looking at the black square with the left. Press Start; a red dot moves slowly left. Press “Gone” (or the space bar) the moment the student says it has disappeared. Three goes." }));
    const valid = b.trials.filter(t => t.valid);
    w.appendChild(el("div", { class:"notice", text: b.trials.length + " of 3 done" + (valid.length ? " · estimates: " + valid.map(t => t.distance_cm + " cm").join(", ") : "") }));
    if (b.trials.length < 3) {
      if (!b.run) w.appendChild(el("button", { class:"btn", style:"width:100%", text:"Start", onclick:() => bsStart() }));
      else w.appendChild(el("button", { class:"btn", style:"width:100%", text:"Gone", onclick:() => bsStop(true) }));
      KEYS.set({ " ": () => b.run ? bsStop(true) : bsStart() });
    } else {
      const med = bsMedian();
      w.appendChild(el("div", { class: med ? "notice ok" : "notice bad", text: med ? "Viewing distance about " + med + " cm. This replaces the band for converting gaze error into degrees." : "The estimates were not plausible, so the band chosen earlier will be used." }));
      w.appendChild(el("button", { class:"speak", text:"Do it again", onclick:() => { S._bs = { trials:[], run:null }; paint(); } }));
    }
    return w;
  },
  info: "distance",
  onLeave: () => {
    bsStop(false);
    const med = bsMedian();
    S.physical.blind_spot = { trials: S._bs.trials, median_cm: med, degrees_assumed: BS_DEG, speed_px_s: BS_SPEED, px_per_mm: S.physical.px_per_mm };
    if (med) { S.physical.distance_cm = med; S.physical.distance_method = "blind_spot"; }
    log("physical", "viewing_distance", med, { blind_spot: S.physical.blind_spot, band_cm: DISTANCE_BANDS[answers.dist_band] ? DISTANCE_BANDS[answers.dist_band].cm : null });
    if (FACEQ.latest() && FACEQ.latest().interocular_px) FACEQ.setBaseline(viewingDistanceCm().cm);
  },
  valid: () => S._bs && S._bs.trials.length >= 3
});
function bsStart() {
  const host = document.querySelector("#stage .bs"); if (!host || S._bs.run) return;
  const fix = host.querySelector(".fix"), ball = host.querySelector(".ball");
  const hr = host.getBoundingClientRect(), fr = fix.getBoundingClientRect();
  const fx = fr.left + fr.width / 2 - hr.left, x0 = fx - 60;
  ball.style.display = "block"; ball.style.left = x0 + "px";
  const run = { t0: null, x0, fx, raf: null, onset_t_perf: CLOCK.t() };
  S._bs.run = run;
  const step = ts => {
    if (S._bs.run !== run) return;
    if (run.t0 === null) run.t0 = ts;
    const x = x0 - (ts - run.t0) / 1000 * BS_SPEED;
    run.x = x; ball.style.left = x + "px";
    if (x < 14) { bsStop(true, true); return; }
    run.raf = requestAnimationFrame(step);
  };
  run.raf = requestAnimationFrame(step);
  EV.log("blind_spot_trial_start", { trial: S._bs.trials.length + 1 });
  paint();
}
function bsStop(record, ranOut) {
  const run = S._bs && S._bs.run; if (!run) return;
  cancelAnimationFrame(run.raf); S._bs.run = null;
  if (!record) return;
  const dpx = run.fx - (run.x === undefined ? run.x0 : run.x);
  const dmm = dpx / S.physical.px_per_mm;
  const cm = +(dmm / Math.tan(BS_DEG * Math.PI / 180) / 10).toFixed(1);
  const valid = !ranOut && cm >= 25 && cm <= 120;
  S._bs.trials.push({ trial: S._bs.trials.length + 1, ball_to_fix_px: Math.round(dpx), ball_to_fix_mm: +dmm.toFixed(1), distance_cm: cm, valid, ran_out: !!ranOut,
    onset_t_perf: run.onset_t_perf, response_t_perf: CLOCK.t() });
  EV.log("blind_spot_trial_end", S._bs.trials[S._bs.trials.length - 1]);
  paint();
}
function bsMedian() {
  const v = (S._bs ? S._bs.trials : []).filter(t => t.valid).map(t => t.distance_cm).sort((a, b) => a - b);
  if (v.length < 2) return null;
  return v[Math.floor(v.length / 2)];
}

/* ---------------------------------------------------------- calibration */
/* v5: ONE target at a time, in a randomised order, each counted once. The
   target shrinks once and stops (no looping motion: motion is itself a
   stimulus in this study). For each point the instrument stores the target's
   position, onset time, the educator's "looking now" time, the raw gaze
   predictions during the dwell, and the times of the training samples. With
   the video saved, that table is what allows the whole session to be
   re-calibrated offline with a better gaze model later: it is the single most
   valuable thing v5 adds. */
const CAL_PTS = [[12,12],[50,12],[88,12],[12,50],[50,50],[88,50],[12,88],[50,88],[88,88]];
/* v5.1: each dot is taught with up to 8 samples over at most 3 s, and a
   sample is only taken when the face model sees the face, both eyes open and
   the head roughly straight (FACEQ.usableNow). A dot with fewer than 4 clean
   samples is not counted: the child is asked to look again. At least 7 of the
   9 dots must be taught; the educator may skip a dot that will not work. */
const CAL_TRAIN_N = 8, CAL_TRAIN_GAP_MS = 90, CAL_MAX_MS = 3000, CAL_MIN_GOOD = 4, CAL_MIN_POINTS = 7, CAL_AUTO_DWELL_MS = 1200;
function calNew(keepModel) {
  S.calibration_attempts++;
  S._calib = { attempt: S.calibration_attempts, order: shuffle(CAL_PTS.map((_, i) => i)), i: 0, done: 0, hit: {}, clicks: 0, busy: false, onsetFor: -1,
    retries: {}, skipped: [], keep_model: !!keepModel, msg: null };
  EV.log("calibration_attempt_start", { attempt: S.calibration_attempts, order: S._calib.order, keep_model: !!keepModel });
}
const calComplete = c => !!(c && c.i >= CAL_PTS.length && c.done >= CAL_MIN_POINTS);
/* Automatic mode: the dot records itself once the child has looked at it for
   CAL_AUTO_DWELL_MS and the face is usable. The educator still watches (on
   the portal's video, or beside the child) and can press the button sooner. */
let CAL_AUTO_T = null;
function autoArm(fn, key) {
  clearTimeout(CAL_AUTO_T);
  if (!S._calAuto) return;
  const t0 = performance.now();
  const tryIt = () => {
    if (!S._calAuto || CUR_SCREEN.id !== key.screen || key.still() === false) return;
    if (FACEQ.usableNow().ok) { fn("auto"); return; }
    if (performance.now() - t0 < 8000) CAL_AUTO_T = setTimeout(tryIt, 250);
  };
  CAL_AUTO_T = setTimeout(tryIt, CAL_AUTO_DWELL_MS);
}
const GATE_WORDS = { no_face: "no face in view", eyes_closed: "eyes closed or blinking", head_turned: "head turned away", no_recent_frame: "camera not updating" };
/* A small live line on the educator panel: can the camera see the eyes right now? */
function liveFaceLine() {
  const n = el("div", { class: "notice", "data-livefa": "1", text: "Checking the face…" });
  return n;
}
setInterval(() => {
  const n = document.querySelector("#panel [data-livefa]"); if (!n) return;
  const u = FACEQ.usableNow();
  const t = !u.gated ? "Face check not available on this laptop; samples are not filtered." : u.ok ? "Camera sees the face and both eyes. Good." : "Not usable right now: " + (GATE_WORDS[u.why] || u.why) + ".";
  if (n.textContent !== t) { n.textContent = t; n.className = "notice " + (u.ok ? "ok" : "bad"); }
}, 300);
function autoToggle() {
  return el("button", { class: "opt" + (S._calAuto ? " on" : ""), onclick: () => { S._calAuto = !S._calAuto; log("gaze", "calibration_auto_mode", S._calAuto); paint(); } },
    [el("span", { text: "Automatic: record each dot by itself" }), el("span", { class: "sub", text: "After the child has looked at it for about a second and the camera sees both eyes. You still watch, and can press the button sooner." })]);
}
add({ id:"calibrate", block:"gaze", bar:"off", skipIf: () => !gazeOn(),
  focus: () => !!(S._calib && S._calib.i < CAL_PTS.length),
  enter: () => { if (!S._calib || S._calib.attempt === undefined) { calNew(S._calKeep); S._calKeep = false; } say("Look at each dot when it appears, and keep looking until it goes away."); },
  stageFn: () => {
    const host = el("div", { class: "dothost" });
    const c = S._calib;
    if (c && c.i < CAL_PTS.length) {
      const pi = c.order[c.i], p = CAL_PTS[pi];
      const dot = el("button", { class:"ctarget", style:`left:${p[0]}%;top:${p[1]}%`, "aria-label":"Calibration point " + (c.i + 1) + " of 9",
        onclick:() => calRecord("dot_click") });
      host.appendChild(dot);
      if (c.onsetFor !== c.i) {
        c.onsetFor = c.i;
        requestAnimationFrame(rt => {
          c.onset_t_perf = CLOCK.fromPerf(rt);
          const r = dot.getBoundingClientRect();
          c.target = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          EV.log("calibration_target_onset", { attempt:c.attempt, point:pi, order:c.i, x:Math.round(c.target.x), y:Math.round(c.target.y), retry: c.retries[pi] || 0 }, c.onset_t_perf);
          if (GAZE.sampling()) GAZE.stop();
          GAZE.start("calibration");
          requestAnimationFrame(() => dot.classList.add("shrunk"));
          const order = c.i;
          c.armedFor = S._calAuto ? order : null;
          autoArm(calRecord, { screen: "calibrate", still: () => S._calib === c && c.i === order && !c.busy });
        });
      } else {
        dot.classList.add("shrunk");
        // automatic mode switched on while this dot was already showing
        if (S._calAuto && c.armedFor !== c.i && !c.busy) { const order = c.i; c.armedFor = order;
          autoArm(calRecord, { screen: "calibrate", still: () => S._calib === c && c.i === order && !c.busy }); }
      }
    }
    stage(host, "Calibration, the child looks at each dot as it appears");
  },
  panel: () => {
    const w = el("div", { class:"wrap" });
    const c = S._calib || { i:0, attempt:1, done:0, retries:{}, skipped:[] };
    w.appendChild(el("div", { class:"eyebrow", text:"Calibration · attempt " + c.attempt + " of " + (1 + PROTOCOL.max_recalibrations) + (c.keep_model ? " · adding to the earlier one" : "") }));
    w.appendChild(el("h1", { text:"Teach the camera" }));
    w.appendChild(el("p", { class:"lede", text:"One dot at a time. When the child is looking straight at it, press the button (or the space bar). Ask them to keep looking until it moves: it takes about a second." }));
    if (c.i < CAL_PTS.length) {
      w.appendChild(el("button", { class:"btn", style:"width:100%", text: c.busy ? "Recording… keep looking" : "They are looking at the dot", onclick:() => calRecord("educator") }));
      KEYS.set({ " ": () => calRecord("educator") });
      w.appendChild(liveFaceLine());
      if (c.msg) {
        w.appendChild(el("div", { class:"notice bad", text:c.msg }));
        w.appendChild(el("button", { class:"speak", text:"Skip this dot", onclick:() => calSkipPoint() }));
      }
    }
    const retried = Object.values(c.retries || {}).reduce((a, b) => a + b, 0);
    w.appendChild(el("div", { class:"notice", text: c.done + " of 9 taught" + (retried ? " · " + retried + " looked at again" : "") + ((c.skipped || []).length ? " · " + c.skipped.length + " skipped" : "") +
      ". At least " + CAL_MIN_POINTS + " are needed. If the child will not look, or seems uncomfortable, press Skip eye tracking below; the rest of the study (and the video) is unaffected." }));
    if (c.i >= CAL_PTS.length && c.done < CAL_MIN_POINTS) {
      w.appendChild(el("div", { class:"notice bad", text:"Too few dots were taught for a usable model." }));
      if (attemptsLeft() > 0) w.appendChild(el("button", { class:"btn", style:"width:100%", text:"Start the dots again", onclick:() => { GAZE.resetModel(); calNew(false); paint(); } }));
    }
    w.appendChild(autoToggle());
    w.appendChild(el("button", { class:"speak", text:"Skip eye tracking", onclick:() => {
      GAZE.consent = "declined"; S.gaze_off = true; log("gaze","calibration","skipped", { attempt: c.attempt });
      try { GAZE.stop(); } catch (e) {}
      jumpTo("gaze_read");
    } }));
    return w;
  },
  info: "calibrate",
  onLeave: () => { clearTimeout(CAL_AUTO_T); GAZE.calibrated = calComplete(S._calib);
    if (GAZE.sampling()) GAZE.stop();
    if (GAZE.calibrated) FACEQ.setBaseline(viewingDistanceCm().cm);
    log("gaze","calibration", GAZE.calibrated ? "complete" : "partial",
      { attempt: S._calib ? S._calib.attempt : null, points_done: S._calib ? S._calib.done : 0, points_total: 9,
        points_skipped: S._calib ? S._calib.skipped : null, retries: S._calib ? S._calib.retries : null, keep_model: S._calib ? S._calib.keep_model : null,
        auto_mode: !!S._calAuto, order: S._calib ? S._calib.order : null, health: GAZE.health(), interocular_baseline: FACEQ.baseline() }); },
  valid: () => calComplete(S._calib)
});
function calSkipPoint() {
  const c = S._calib; if (!c || c.busy || c.i >= CAL_PTS.length) return;
  const pi = c.order[c.i];
  c.skipped.push(pi); c.i++; c.msg = null; c.target = null;
  EV.log("calibration_target_skipped", { attempt: c.attempt, point: pi });
  if (GAZE.sampling()) GAZE.stop();
  paint();
}
function calRecord(source) {
  const c = S._calib; if (!c || c.busy || c.i >= CAL_PTS.length || !c.target) return;
  clearTimeout(CAL_AUTO_T);
  c.busy = true; c.msg = null; paint();
  const pi = c.order[c.i], target = c.target, click = CLOCK.t(), t0 = performance.now();
  EV.log("calibration_target_click", { attempt:c.attempt, point:pi, order:c.i, source: source || "educator" }, click);
  const trainT = [], rejected = {};
  let good = 0, gated = true;
  const tick = () => {
    if (S._calib !== c) return;                  // left the screen or restarted mid-dot
    const u = FACEQ.usableNow();
    gated = gated && u.gated;
    if (u.ok) { GAZE.train(target.x, target.y); trainT.push(CLOCK.t()); good++; }
    else rejected[u.why] = (rejected[u.why] || 0) + 1;
    if (good < CAL_TRAIN_N && performance.now() - t0 < CAL_MAX_MS) { setTimeout(tick, CAL_TRAIN_GAP_MS); return; }
    const off = CLOCK.t();
    const samples = GAZE.peek();
    GAZE.stop();
    const med = a => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
    const mx = med(samples.map(q => q.x)), my = med(samples.map(q => q.y));
    const accepted = good >= CAL_MIN_GOOD;
    STREAMS.push("calibration", { attempt:c.attempt, kind: accepted ? "calibration" : "calibration_retry", point_index:pi, order:c.i,
      target_x:Math.round(target.x), target_y:Math.round(target.y), onset_t_perf:c.onset_t_perf, click_t_perf:click, offset_t_perf:off,
      n_samples:samples.length, median_x:mx, median_y:my,
      error_px: mx === null ? null : Math.round(Math.hypot(mx - target.x, my - target.y)), error_deg:null,
      samples_json: JSON.stringify({ predictions: samples.map(q => [q.x, q.y, q.t_perf]), training_t_perf: trainT, trained: good,
        gated, rejected_ticks: rejected, source: source || "educator", keep_model: c.keep_model }) });
    EV.log("calibration_target_offset", { attempt:c.attempt, point:pi, order:c.i, training_samples: good, accepted, rejected_ticks: rejected }, off);
    if (accepted) { c.hit[pi] = true; c.done++; c.i++; c.target = null; }
    else {
      c.retries[pi] = (c.retries[pi] || 0) + 1;
      const top = Object.keys(rejected).sort((a, b) => rejected[b] - rejected[a])[0];
      c.msg = "That dot did not count: the camera could not see the eyes clearly enough (" + (GATE_WORDS[top] || top || "unknown") +
        "). Ask the child to look at the dot again, eyes open, head still, and press the button again.";
      c.onsetFor = -1;                               // the dot re-appears large, which also re-catches attention
    }
    c.clicks++; c.busy = false;
    paint();
  };
  tick();
}

/* The dot the child should be looking at right now, for the portal's map. */
function currentGazeTarget() {
  const id = CUR_SCREEN.id || "";
  let n = null, kind = null, busy = false;
  if (id === "calibrate" && S._calib) { n = document.querySelector("#stage .ctarget"); kind = "calibration"; busy = !!S._calib.busy; }
  else if (id === "validate" && S._val) { n = document.querySelectorAll("#stage .valdot")[S._val.i]; kind = "validation"; busy = !!S._val.busy; }
  else if (/^drift_/.test(id) && S._drift) { n = document.querySelector("#stage .valdot"); kind = "drift"; busy = !!S._drift.busy; }
  if (!n) return null;
  const r = n.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), kind, busy };
}
/* ---------------------------------------------------------- validation */
/* Calibration says a model was fitted. Validation says how good it is, for
   this student, in this room. Five targets the model was never trained on;
   for each, the median prediction while the student looks at it. Mean offset
   is accuracy, within-target spread is precision. Both are standard minimum
   reporting, and both then travel with every gaze row in the export so no
   downstream reader has to assume a number from a paper. */
const VAL_PTS = [[20,20],[80,20],[50,50],[20,80],[80,80]];
/* v5: both inputs are now MEASURED where possible. Pixel pitch comes from the
   credit-card match (css px per mm on this screen); viewing distance from the
   blind-spot estimate, else the educator's band. Whatever was used is named in
   the output, so no degree value travels without its assumptions. */
function viewingDistanceCm() {
  if (S.physical.distance_cm) return { cm: S.physical.distance_cm, method: S.physical.distance_method };
  const b = DISTANCE_BANDS[answers.dist_band];
  return b ? { cm: b.cm, method: "educator_band" } : { cm: 60, method: "default_60cm" };
}
function cssPxPerCm() { return S.physical.px_per_mm ? { v: S.physical.px_per_mm * 10, method:"card_match" } : { v: 96 / 2.54, method:"assumed_96dpi" }; }
function pxPerDegree() {
  return Math.tan(Math.PI / 180) * viewingDistanceCm().cm * cssPxPerCm().v;
}
const attemptsLeft = () => (1 + PROTOCOL.max_recalibrations) - S.calibration_attempts;
/* Recalibration: a fresh model, a fresh validation, then back to where it was
   asked for (the validation screen itself, or a drift check later on). */
function recalibrate(returnTo, fresh) {
  if (attemptsLeft() <= 0) return;
  log("gaze", "recalibration_requested", S.calibration_attempts, { from: CUR_SCREEN.id, return_to: returnTo || null, fresh: !!fresh });
  /* v5.1: by default the earlier clean samples are kept and nine more are
     added (more data helps this regression; a reset throws good samples away).
     "From scratch" is for when the setup changed: the child moved seats, the
     screen was tilted, the lights changed. */
  if (fresh) GAZE.resetModel(); else { GAZE.calibrated = false; GAZE.validation = null; }
  S._calKeep = !fresh;
  S._calib = null; S._val = { i:0, pts:[] }; S._returnTo = returnTo || null;
  if (returnTo && S._drift) S._drift[returnTo] = null;
  jumpTo("calibrate");
}
/* Skipping gaze no longer ends the tracker: with video on, its face model is
   still producing face_quality.csv. */
function skipGaze(where) {
  GAZE.consent = "declined"; S.gaze_off = true; log("gaze", where, "skipped");
  try { if (GAZE.sampling()) GAZE.stop(); } catch (e) {}
  if (!S.video.consented) { try { GAZE.end(); } catch (e) {} }
  jumpTo("gaze_read");
}
add({ id:"validate", block:"gaze", bar:"off", skipIf: () => !(gazeOn() && GAZE.calibrated),
  focus: () => !!(S._val && S._val.i < VAL_PTS.length),
  enter: () => { if (!S._val) S._val = { i: 0, pts: [] }; say("A few more dots. Look at each one until it turns green."); },
  stageFn: () => {
    const host = el("div", { class:"dothost" });
    VAL_PTS.forEach((p, i) => {
      const done = i < S._val.i;
      host.appendChild(el("div", { class:"valdot" + (done ? " done" : ""),
        style:`left:${p[0]}%;top:${p[1]}%;` + (i === S._val.i ? "" : "opacity:.25"),
        "aria-hidden":"true" }));
    });
    if (S._val.i < VAL_PTS.length && S._val.onsetFor !== S._val.i) {
      S._val.onsetFor = S._val.i;
      requestAnimationFrame(rt => { S._val.onset = CLOCK.fromPerf(rt);
        EV.log("validation_target_onset", { attempt: S.calibration_attempts, index: S._val.i }, S._val.onset);
        const v = S._val, i = v.i; v.armedFor = S._calAuto ? i : null;
        autoArm(measureValPoint, { screen: "validate", still: () => S._val === v && v.i === i && !v.busy }); });
    } else if (S._val.i < VAL_PTS.length && S._calAuto && S._val.armedFor !== S._val.i && !S._val.busy) {
      const v = S._val, i = v.i; v.armedFor = i;
      autoArm(measureValPoint, { screen: "validate", still: () => S._val === v && v.i === i && !v.busy });
    }
    stage(host, "Checking how accurate the camera is for this student");
  },
  panel: () => {
    const w = el("div", { class:"wrap" });
    w.appendChild(el("div", { class:"eyebrow", text:"Eye tracking · Accuracy check · attempt " + S.calibration_attempts }));
    w.appendChild(el("h1", { text:"How good is it, really?" }));
    const n = S._val.i;
    if (n < VAL_PTS.length) {
      w.appendChild(el("p", { class:"lede", text:"Ask the child to look at the red dot. When they are looking at it, press the button below and keep them looking for a moment." }));
      w.appendChild(el("div", { class:"notice", text:"Dot " + (n + 1) + " of " + VAL_PTS.length + ". Unlike calibration, these dots do not teach the camera anything; they test what it already learned." }));
      w.appendChild(el("button", { class:"btn", style:"width:100%",
        text: S._val.busy ? "Measuring… keep looking" : "They are looking at the dot",
        onclick: () => measureValPoint("educator") }));
      KEYS.set({ " ": () => measureValPoint("educator") });
      w.appendChild(liveFaceLine());
      w.appendChild(autoToggle());
    } else {
      const v = GAZE.validation;
      const pass = v && v.meets_protocol;
      w.appendChild(el("div", { class: pass ? "notice ok" : "notice bad", html:
        "<strong>Accuracy: " + (v ? v.mean_error_px + " px (" + v.mean_error_deg + "°)" : "–") + "</strong> · data loss " + (v ? Math.round(v.data_loss_share * 100) + "%" : "–") + "<br>" +
        "Precision: RMS sample-to-sample " + (v ? v.precision_rms_s2s_px + " px" : "–") + ", SD " + (v ? v.precision_sd_px + " px" : "–") + "<br>" +
        "Rule fixed before data collection: accuracy at most " + PROTOCOL.validation_max_deg + "° and data loss at most " + Math.round(PROTOCOL.validation_max_loss * 100) + "%. " +
        (pass ? "<strong>Meets the rule.</strong> Good enough for regions that sit far apart on a page (text against an advert), not for lines or words."
              : "<strong>Does not meet the rule.</strong>") }));
      if (!pass) {
        if (attemptsLeft() > 0) {
          w.appendChild(el("button", { class:"btn", style:"width:100%;margin-bottom:8px", text:"Add more calibration dots (" + attemptsLeft() + " attempt" + (attemptsLeft() > 1 ? "s" : "") + " left)", onclick:() => recalibrate(null, false) }));
          w.appendChild(el("button", { class:"speak", text:"Start calibration again from scratch", onclick:() => recalibrate(null, true) }));
          w.appendChild(el("p", { class:"hint", text:"Add more dots keeps what the camera has learned and teaches nine more: usually best. Start from scratch if the child changed seat or the screen or lights were moved. Before either: check the face is inside the oval on the portal video, not backlit, and ask the child to keep their head still." }));
          if (v && v.per_point_error_px) {
            const worst = v.per_point_error_px.indexOf(Math.max.apply(null, v.per_point_error_px));
            w.appendChild(el("p", { class:"hint", text:"Per-dot error (px): " + v.per_point_error_px.join(", ") + ". Worst: dot " + (worst + 1) + "." }));
          }
        } else {
          w.appendChild(el("div", { class:"notice", text:"The recalibration limit is reached. Press Next: eye tracking is switched off for the rest of this session, as the protocol says. The video keeps recording, so the session can still be re-analysed later." }));
        }
      }
      w.appendChild(el("p", { class:"hint", text:"These numbers are attached to every gaze row in the saved files." }));
    }
    w.appendChild(el("button", { class:"speak", text:"Skip eye tracking", onclick:() => skipGaze("validation") }));
    return w;
  },
  info: "validate",
  onLeave: () => {
    const v = GAZE.validation;
    log("gaze","validation", v ? (v.meets_protocol ? "meets_protocol" : v.usable ? "usable_fails_protocol" : "too_coarse") : "none",
      Object.assign({ attempt: S.calibration_attempts }, v || {}));
    if (v && !v.meets_protocol && attemptsLeft() <= 0) {
      S.gaze_off = true;
      log("gaze", "gaze_disabled_by_protocol", true, { attempts: S.calibration_attempts, thresholds: v.protocol_thresholds });
      try { if (!S.video.consented) GAZE.end(); } catch (e) {}
    }
  },
  next: () => { const r = S._returnTo; S._returnTo = null; return r; },
  valid: () => S._val.i >= VAL_PTS.length && !!GAZE.validation && (GAZE.validation.meets_protocol || attemptsLeft() <= 0)
});

/* ----------------------------------------------------------- drift checks
   One centre dot before each gaze block. A webcam model drifts as the child
   shifts in the chair; this measures by how much, on the shared clock, and
   offers a quick recalibration when it exceeds the pre-declared limit. */
function driftScreen(id, before) {
  add({ id, block:"gaze", bar:"off", skipIf: () => !(gazeOn() && GAZE.calibrated),
    enter: () => { S._drift = S._drift || {}; say("Look at the dot in the middle."); },
    focus: () => !(S._drift && S._drift[id]),
    stageFn: () => {
      const host = el("div", { class:"dothost" });
      host.appendChild(el("div", { class:"valdot", style:"left:50%;top:50%", "aria-hidden":"true" }));
      stage(host, "Quick check before " + before);
      if (!S._drift[id + "_onset"]) requestAnimationFrame(rt => { S._drift[id + "_onset"] = CLOCK.fromPerf(rt); EV.log("drift_target_onset", { check:id }, S._drift[id + "_onset"]); });
    },
    panel: () => {
      const w = el("div", { class:"wrap" });
      const d = S._drift[id];
      w.appendChild(el("div", { class:"eyebrow", text:"Eye tracking · drift check" }));
      w.appendChild(el("h1", { text:"Still accurate?" }));
      if (!d) {
        w.appendChild(el("p", { class:"lede", text:"Ask the child to look at the dot in the middle, then press the button and keep them looking for a second." }));
        w.appendChild(el("button", { class:"btn", style:"width:100%", text: S._drift.busy ? "Measuring… keep looking" : "They are looking at the dot", onclick:() => measureDrift(id) }));
        KEYS.set({ " ": () => measureDrift(id) });
        w.appendChild(liveFaceLine());
      } else {
        const over = d.offset_deg === null || d.offset_deg > PROTOCOL.drift_max_deg;
        w.appendChild(el("div", { class: over ? "notice bad" : "notice ok", text: d.offset_deg === null ? "No gaze estimate arrived." :
          "Drift " + d.offset_px + " px (" + d.offset_deg + "°). Limit " + PROTOCOL.drift_max_deg + "°. " + (over ? "Above the limit." : "Fine, carry on.") }));
        if (over && attemptsLeft() > 0) w.appendChild(el("button", { class:"btn", style:"width:100%;margin-bottom:8px", text:"Quick recalibration (adds nine dots)", onclick:() => { d.action = "recalibrate"; S.drift.push(Object.assign({}, d)); recalibrate(id, false); } }));
        if (over) w.appendChild(el("p", { class:"hint", text:"Or press Next to continue as is. Either way it is recorded, and the drift travels with every gaze row of the next block." }));
        w.appendChild(el("button", { class:"speak", text:"Measure again", onclick:() => { S._drift[id] = null; paint(); } }));
      }
      return w;
    },
    info: "drift",
    onLeave: () => {
      const d = S._drift[id];
      if (d && !d.action) { d.action = (d.offset_deg !== null && d.offset_deg > PROTOCOL.drift_max_deg) ? "continued_over_limit" : "ok"; S.drift.push(Object.assign({}, d)); }
      log("gaze", "drift_check", d ? d.offset_deg : null, Object.assign({ check:id, before }, d || {}));
      if (GAZE.validation && d) GAZE.validation.last_drift_deg = d.offset_deg;
    },
    valid: () => !!(S._drift && S._drift[id])
  });
}
function measureDrift(id) {
  if (S._drift.busy) return;
  const node = document.querySelector("#stage .valdot"); if (!node) return;
  const r = node.getBoundingClientRect(), target = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  const click = CLOCK.t();
  S._drift.busy = true; paint();
  GAZE.start("drift");
  setTimeout(() => {
    // v5.1: the first 350 ms after the button are the eyes landing and the
    // tracker's smoothing catching up; they measure lag, not drift.
    const sm = GAZE.peek().filter(q => q.t_perf >= click + VAL_SETTLE_MS), lost = GAZE.lostCount(click + VAL_SETTLE_MS); GAZE.stop();
    const med = a => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
    const mx = med(sm.map(q => q.x)), my = med(sm.map(q => q.y));
    const px = mx === null ? null : Math.round(Math.hypot(mx - target.x, my - target.y));
    const ppd = pxPerDegree();
    S._drift[id] = { check:id, attempt:S.calibration_attempts, t_perf:click, n_samples:sm.length, lost,
      offset_px:px, offset_dx:mx === null ? null : Math.round(mx - target.x), offset_dy:my === null ? null : Math.round(my - target.y),
      offset_deg: px === null ? null : +(px / ppd).toFixed(2), threshold_deg: PROTOCOL.drift_max_deg };
    STREAMS.push("calibration", { attempt:S.calibration_attempts, kind:"drift", point_index:0, order:S.drift.length,
      target_x:Math.round(target.x), target_y:Math.round(target.y), onset_t_perf:S._drift[id + "_onset"] || null, click_t_perf:click, offset_t_perf:CLOCK.t(),
      n_samples:sm.length, median_x:mx, median_y:my, error_px:px, error_deg:S._drift[id].offset_deg,
      samples_json: JSON.stringify(sm.map(q => [q.x, q.y, q.t_perf])) });
    S._drift.busy = false; paint();
  }, VAL_SETTLE_MS + 1200);
}

/* Collect predictions against the current target, then advance. v5.1: the
   first VAL_SETTLE_MS after the button are dropped (the eyes landing on the
   dot and the tracker's smoothing catching up are lag, not inaccuracy), then
   1.5 s is measured. Samples with no face count as lost. */
const VAL_SETTLE_MS = 350, VAL_WINDOW_MS = 1500;
function measureValPoint(source) {
  if (S._val.busy) return;
  clearTimeout(CAL_AUTO_T);
  const i = S._val.i;
  const host = $("#stage .valdot");
  const dots = document.querySelectorAll("#stage .valdot");
  const node = dots[i];
  if (!node) return;
  const r = node.getBoundingClientRect();
  const target = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  const clickT = CLOCK.t();
  EV.log("validation_target_measure", { index: i, x: Math.round(target.x), y: Math.round(target.y), source: source || "educator" }, clickT);
  S._val.busy = true; paint();
  GAZE.start("validation");
  setTimeout(() => {
    const samples = GAZE.peek().filter(q => q.t_perf >= clickT + VAL_SETTLE_MS), lost = GAZE.lostCount(clickT + VAL_SETTLE_MS);
    GAZE.stop();
    const med = a => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
    const mx = med(samples.map(s => s.x)), my = med(samples.map(s => s.y));
    S._val.pts.push({ target, n: samples.length, lost, samples: samples.map(s => ({ x:s.x, y:s.y, t_perf:s.t_perf })),
      onset_t_perf: S._val.onset || null, click_t_perf: clickT, offset_t_perf: CLOCK.t(),
      pred: (mx === null) ? null : { x: mx, y: my },
      // Spread of the samples around their own median: precision, separate
      // from accuracy, exactly as the reporting guidance distinguishes them.
      spread: samples.length > 1
        ? Math.round(Math.sqrt(samples.reduce((s, p) => s + Math.pow(p.x - mx, 2) + Math.pow(p.y - my, 2), 0) / samples.length))
        : null });
    S._val.i++; S._val.busy = false;
    if (S._val.i >= VAL_PTS.length) computeValidation();
    paint();
  }, VAL_SETTLE_MS + VAL_WINDOW_MS);
}
function computeValidation() {
  const good = S._val.pts.filter(p => p.pred && p.n >= 5);
  if (!good.length) {
    GAZE.validation = { usable:false, points_used:0, reason:"no_predictions" };
    return;
  }
  const errs = good.map(p => Math.hypot(p.pred.x - p.target.x, p.pred.y - p.target.y));
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  const spreads = good.map(p => p.spread).filter(x => x !== null);
  const ppd = pxPerDegree();
  const dist = viewingDistanceCm(), pitch = cssPxPerCm();
  /* Precision both ways, as the reporting guidance separates them:
     RMS-S2S, root mean square of successive sample-to-sample distances
       (the tracker's own jitter), and SD, the dispersion of samples around
       their centroid (which also absorbs slow wander). */
  const s2s = [], sd = [];
  S._val.pts.forEach(p => {
    const sm = p.samples || [];
    if (sm.length > 2) {
      let acc = 0; for (let i = 1; i < sm.length; i++) acc += Math.pow(sm[i].x - sm[i - 1].x, 2) + Math.pow(sm[i].y - sm[i - 1].y, 2);
      s2s.push(Math.sqrt(acc / (sm.length - 1)));
      const cx = sm.reduce((a, q) => a + q.x, 0) / sm.length, cy = sm.reduce((a, q) => a + q.y, 0) / sm.length;
      sd.push(Math.sqrt(sm.reduce((a, q) => a + Math.pow(q.x - cx, 2) + Math.pow(q.y - cy, 2), 0) / sm.length));
    }
  });
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const got = S._val.pts.reduce((a, p) => a + (p.n || 0), 0), lost = S._val.pts.reduce((a, p) => a + (p.lost || 0), 0);
  const loss = (got + lost) ? lost / (got + lost) : 1;
  const meanDeg = mean / ppd;
  GAZE.validation = {
    usable: mean <= VAL_MAX_PX,
    meets_protocol: meanDeg <= PROTOCOL.validation_max_deg && loss <= PROTOCOL.validation_max_loss,
    protocol_thresholds: { max_deg: PROTOCOL.validation_max_deg, max_loss: PROTOCOL.validation_max_loss, version: PROTOCOL.version },
    attempt: S.calibration_attempts,
    points_used: good.length,
    points_total: VAL_PTS.length,
    mean_error_px: Math.round(mean),
    max_error_px: Math.round(Math.max.apply(null, errs)),
    mean_error_deg: +meanDeg.toFixed(2),
    precision_px: spreads.length ? Math.round(spreads.reduce((a, b) => a + b, 0) / spreads.length) : null,
    precision_rms_s2s_px: avg(s2s) === null ? null : Math.round(avg(s2s)),
    precision_rms_s2s_deg: avg(s2s) === null ? null : +(avg(s2s) / ppd).toFixed(2),
    precision_sd_px: avg(sd) === null ? null : Math.round(avg(sd)),
    precision_sd_deg: avg(sd) === null ? null : +(avg(sd) / ppd).toFixed(2),
    data_loss_share: +loss.toFixed(4),
    samples_valid: got, samples_lost: lost,
    per_point_error_px: errs.map(e => Math.round(e)),
    assumed_distance_cm: dist.cm, distance_method: dist.method,
    css_px_per_cm: +pitch.v.toFixed(3), pixel_pitch_method: pitch.method,
    assumed_px_per_degree: +ppd.toFixed(1),
    threshold_px: VAL_MAX_PX,
    note: "Accuracy measured on this participant and setup, not taken from published figures. Degrees use the pixel pitch and viewing distance named here."
  };
  S.validations = S.validations || [];
  S.validations.push({ t_perf: CLOCK.t(), attempt: S.calibration_attempts, mean_error_deg: GAZE.validation.mean_error_deg,
    mean_error_px: GAZE.validation.mean_error_px, meets_protocol: GAZE.validation.meets_protocol, data_loss_share: GAZE.validation.data_loss_share });
  S._val.pts.forEach((p, i) => STREAMS.push("calibration", { attempt: S.calibration_attempts, kind:"validation", point_index:i, order:i,
    target_x: Math.round(p.target.x), target_y: Math.round(p.target.y), onset_t_perf: p.onset_t_perf || null, click_t_perf: p.click_t_perf || null,
    offset_t_perf: p.offset_t_perf || null, n_samples: p.n, median_x: p.pred ? p.pred.x : null, median_y: p.pred ? p.pred.y : null,
    error_px: p.pred ? Math.round(Math.hypot(p.pred.x - p.target.x, p.pred.y - p.target.y)) : null,
    error_deg: p.pred ? +(Math.hypot(p.pred.x - p.target.x, p.pred.y - p.target.y) / ppd).toFixed(2) : null,
    samples_json: JSON.stringify((p.samples || []).map(q => [q.x, q.y, q.t_perf])) }));
}
/* The widest separation this instrument ever asks a tracker to resolve is a
   block of text against an element beside or below it. Beyond this, no zone
   comparison on any screen here is interpretable, so the threshold is set to
   the smallest separation the design actually uses rather than to a number
   borrowed from the literature. */
const VAL_MAX_PX = 220;

/* ------------------------------------------------------- the two reads */
/* Different passages, counterbalanced, because reading the same text twice is
   faster the second time from familiarity alone, and that speed-up points in
   exactly the direction the study hopes to find. */
function readPassage(which) {
  if (!ORDER.read) ORDER.read = RNG() < 0.5 ? ["R1", "R2"] : ["R2", "R1"];
  const id = ORDER.read[which === "baseline" ? 0 : 1];
  return { id, text: id === "R1" ? READ_1 : READ_2 };
}

const PLAIN = { fontCss:FONTS[0].css, fontAdj:FONTS[0].adj, sizePx:16, lineHeight:1.5, tracking:0, fg:"#000000", bg:"#FFFFFF" };

/* =========================================================================
   RECALL
   -------------------------------------------------------------------------
   Everything else a student does in this session is a PREFERENCE. Preference
   is not performance, and without a single performance measure the study can
   never say that a student's own settings helped them read, only that they
   liked them. With one chance at data collection that distinction cannot be
   repaired later, so each reading passage is followed by two plain recall
   questions.

   Deliberately easy and deliberately short: this is a check that the passage
   was actually taken in, not a comprehension test the student can fail. The
   two passages carry matched items (one concrete object, one simple fact) so
   baseline and adapted scores are comparable. The educator reads the options
   aloud, so answering needs no reading. Pre-readers skip this along with the
   passage itself.
   ========================================================================= */
const RECALL = {
  R1: [{ q:"What is in the hall?",        a:["A clock","A chair","A dog"],            correct:0 },
       { q:"How often does it ring?",     a:["Every hour","Once a week","Never"],     correct:0 }],
  R2: [{ q:"Where is the boat tied up?",  a:["By the bridge","In a shed","On a beach"], correct:0 },
       { q:"What does the man go to check?", a:["His nets","His watch","His boots"],  correct:0 }]
};
const canRecall = () => answers.reading_level !== "pre";

/* One recall screen, shared by both reads. The passage is NOT on screen here:
   with it visible this would measure copying, not reading. */
function recallScreen(which) {
  const key = "recall_" + which;
  add({ id:key, block:"G_recall", bar:"off",
    skipIf: () => !isChild() || !canRecall(),
    enter: () => { if (!ORDER.recall) ORDER.recall = {}; say("Two quick questions about the story you just read."); },
    stageFn: () => stage(card(el("div", {}, [
      el("h1", { style:"font-size:24px", text:"Two quick questions" }),
      el("p", { class:"lede", text:"The story is hidden now. There is no need to remember every word." })
    ])), "The passage is deliberately not shown here"),
    panel: () => {
      const p = readPassage(which === "baseline" ? "baseline" : "adapted");
      const items = RECALL[p.id] || [];
      const w = el("div", { class:"wrap" });
      w.appendChild(el("div", { class:"eyebrow", text:"After reading" }));
      w.appendChild(el("h1", { text:"What do you remember?" }));
      w.appendChild(el("p", { class:"hint", text:"Educator: read the question and all three options aloud. The student only has to point. It is completely fine to get these wrong." }));
      items.forEach((it, i) => {
        const k = key + "_" + i;
        w.appendChild(el("div", { class:"q" }, [
          el("div", { class:"q-t", text:it.q }),
          el("button", { class:"speak", text:"\uD83D\uDD0A Read this out", onclick:() => say(it.q + ". " + it.a.join(". Or. ")) }),
          opts(k, it.a)]));
      });
      return w;
    },
    info: "recall",
    onLeave: () => {
      const p = readPassage(which === "baseline" ? "baseline" : "adapted");
      const items = RECALL[p.id] || [];
      let right = 0, answered = 0;
      items.forEach((it, i) => {
        const v = answers[key + "_" + i];
        if (v !== undefined) { answered++; if (v === it.correct) right++; }
      });
      log("G_recall", which === "baseline" ? "recall_baseline" : "recall_adapted", right,
        { passage:p.id, items: items.length, answered, correct: right,
          score: items.length ? +(right / items.length).toFixed(2) : null,
          settings: which === "baseline" ? "default" : "own_choices" });
    },
    valid: () => {
      const p = readPassage(which === "baseline" ? "baseline" : "adapted");
      const items = RECALL[p.id] || [];
      return items.every((_, i) => answers[key + "_" + i] !== undefined);
    }
  });
}

/* The baseline read runs for EVERY child, not only when the camera works. It
   is the reference the adapted read is compared against, and gating it on the
   camera would leave a failed-camera session with no before-and-after measure
   of any kind. Gaze is recorded on top when available; the felt-load rating is
   collected either way. */
driftScreen("drift_read1", "the first story");

add({ id:"gaze_read", block:"gaze", bar:"off", skipIf: () => !isChild(),
  enter: () => { say("Here is a short story. Just read it in your own time. When you have finished, tell your teacher.");
    if (gazeOn() && GAZE.calibrated) GAZE.start(); },
  stageFn: () => {
    const p = readPassage("baseline");
    stage(card(specimen(PLAIN, p.text), "plain settings", PLAIN), "Baseline reading");
    zonesFrom([{ id:"text", sel:"#stage .card" }]);
  },
  panel: () => {
    const w = el("div", { class:"wrap" });
    w.appendChild(el("div", { class:"eyebrow", text:"Reading" }));
    w.appendChild(el("h1", { text:"Read the short story" }));
    w.appendChild(el("p", { class:"lede", text:"Let the child read the passage on the left at their own pace, in these plain default settings. When they have finished reading, press Next." }));
    if (gazeOn() && GAZE.calibrated) w.appendChild(el("div", { class:"notice", text:"Their eyes are being measured only to compare this plain version with their own chosen settings later. This build computes the gaze position inside the browser and saves coordinates only; no frame is written to disk or transmitted." }));
    // Reading time only means something if it is stamped when the student
    // actually finishes, not when the educator has also finished asking the
    // follow-up questions. Separating the two is the difference between a
    // usable reading-time measure and a measure of how fast the adult works.
    if (!S._readDone || !S._readDone.baseline) {
      w.appendChild(el("div", { class:"notice", text:"Press the button the moment the child says they have finished reading. The questions appear after that, so the reading time is not mixed up with the time spent answering." }));
      w.appendChild(el("button", { class:"btn", style:"width:100%", text:"They have finished reading",
        onclick:() => { S._readDone = S._readDone || {};
          S._readDone.baseline = Math.round(performance.now() - screenEnter); paint(); } }));
      return w;
    }
    w.appendChild(el("div", { class:"notice ok", text:"Reading time recorded: " + (S._readDone.baseline / 1000).toFixed(1) + " seconds." }));
    w.appendChild(el("div", { class:"q" }, [
      el("div", { class:"q-t", text:"Ask the child: how did that feel to read?" }),
      faceRow("read_f_baseline", ["Fine", "A bit much", "Too much"])]));
    return w;
  },
  info: "gaze_read",
  onLeave: () => {
    const p = readPassage("baseline");
    const g = (gazeOn() && GAZE.calibrated) ? GAZE.stop() : null;
    log("gaze_reading","baseline_default", g ? (g.gaze_usable ? "usable" : "unusable") : "no_gaze",
      Object.assign({ passage:p.id, settings:"default", felt_load: answers.read_f_baseline,
        reading_time_ms: (S._readDone || {}).baseline ?? null,
        stimulus_id: "read_baseline",
        // The two reads are the only stimuli where the W features vary, so
        // they carry most of the information about the visibility weight.
        features: pageFeatures(document.querySelector("#stage .card")),
        gaze_health: GAZE.health() }, g || {}));
  },
  valid: () => !!(S._readDone && S._readDone.baseline) && answers.read_f_baseline !== undefined
});

recallScreen("baseline");


/* ------- apply the child's winners, re-validate, second read, break ------- */
driftScreen("drift_read2", "the second story");

add({ id:"apply", block:"admin", bar:"off", skipIf: () => !isChild(),
  enter: () => {
    const tally = pre => { const c = {}; S.responses.filter(r => r.comparison === pre && r.winner).forEach(r => c[r.winner] = (c[r.winner] || 0) + 1); return Object.entries(c).sort((a, b) => b[1] - a[1])[0]; };
    const f = tally("font"); if (f) { const o = FONTS.find(x => x.id === f[0]); if (o) { P.fontId = o.id; P.fontCss = o.css; P.fontAdj = o.adj; } }
    const s = tally("size"); if (s) P.sizePx = +s[0];
    const c = tally("colour"); if (c) { const o = COLOURS.find(x => x.id === c[0]); if (o) { P.fg = o.fg; P.bg = o.bg; } }
    const l = tally("lead"); if (l) P.lineHeight = +l[0];
    const t = tally("track"); if (t) P.tracking = +t[0];
    if (gazeOn() && GAZE.calibrated) GAZE.start();
  },
  stageFn: () => {
    const p = readPassage("adapted");
    stage(card(specimen({}, p.text), "your settings"), "The child's own winning settings, applied.");
    zonesFrom([{ id:"text", sel:"#stage .card" }]);
  },
  panel: () => {
    const w = el("div", { class:"wrap" });
    w.appendChild(el("div", { class:"eyebrow", text:"Halfway" }));
    w.appendChild(el("h1", { text:"Time for a break" }));
    w.appendChild(el("p", { class:"lede", text:"The left panel now shows the child's own choices applied together. Take a break here if they want one, there is no time limit." }));
    /* v5: breaks are logged as start/end so the video can be cut around them. */
    const onBreak = S.breaks.length && !S.breaks[S.breaks.length - 1].end_t_perf;
    w.appendChild(el("button", { class:"speak", text: onBreak ? "Break over, carry on" : "The child is taking a break now",
      onclick:() => {
        if (onBreak) { const b = S.breaks[S.breaks.length - 1]; b.end_t_perf = CLOCK.t(); b.duration_ms = Math.round(b.end_t_perf - b.start_t_perf); EV.log("break_end", b); }
        else { const b = { start_t_perf: CLOCK.t(), end_t_perf:null, screen: CUR_SCREEN.id, frame_index: FRAMES.current() }; S.breaks.push(b); EV.log("break_start", b); }
        paint(); } }));
    if (onBreak) w.appendChild(el("div", { class:"notice", text:"On a break since " + Math.round((CLOCK.t() - S.breaks[S.breaks.length - 1].start_t_perf) / 1000) + " s. Take as long as needed." }));
    if (gazeOn() && GAZE.calibrated) w.appendChild(el("div", { class:"notice", text:"If the child is happy to, let them read the story on the left in their own settings before you press Next; their eyes are being measured here too. It is a different story from the first one on purpose, so a remembered text cannot look like easier reading." }));
    else w.appendChild(el("div", { class:"notice", text:"Let the child read the story on the left in their own chosen settings before pressing Next. It is a different story from the first one on purpose." }));
    if (!S._readDone || !S._readDone.adapted) {
      w.appendChild(el("button", { class:"btn", style:"width:100%", text:"They have finished reading",
        onclick:() => { S._readDone = S._readDone || {};
          S._readDone.adapted = Math.round(performance.now() - screenEnter); paint(); } }));
      return w;
    }
    const b = (S._readDone || {}).baseline, a = S._readDone.adapted;
    w.appendChild(el("div", { class:"notice ok", text:"Reading time recorded: " + (a / 1000).toFixed(1) + " seconds" +
      (b ? "  (plain version was " + (b / 1000).toFixed(1) + " seconds)" : "") + "." }));
    w.appendChild(el("div", { class:"q" }, [
      el("div", { class:"q-t", text:"Ask the child: how did that feel to read this time?" }),
      faceRow("read_f_adapted", ["Fine", "A bit much", "Too much"])]));
    w.appendChild(el("div", { class:"notice", text:"The rest takes about six minutes. It is about things that appear on pages, not about letters." }));
    return w;
  },
  info: "apply",
  onLeave: () => {
    const lastB = S.breaks[S.breaks.length - 1];
    if (lastB && !lastB.end_t_perf) { lastB.end_t_perf = CLOCK.t(); lastB.duration_ms = Math.round(lastB.end_t_perf - lastB.start_t_perf); lastB.closed_by = "leaving_screen"; EV.log("break_end", lastB); }
    const p = readPassage("adapted");
    const g = (gazeOn() && GAZE.calibrated) ? GAZE.stop() : null;
    log("gaze_reading","post_adaptation", g ? (g.gaze_usable ? "usable" : "unusable") : "no_gaze",
      Object.assign({ passage:p.id, settings:"own_choices", felt_load: answers.read_f_adapted,
        reading_time_ms: (S._readDone || {}).adapted ?? null,
        stimulus_id: "read_adapted",
        features: pageFeatures(document.querySelector("#stage .card")),
        gaze_health: GAZE.health() }, g || {}));
  },
  valid: () => !!(S._readDone && S._readDone.adapted) && answers.read_f_adapted !== undefined
});

recallScreen("adapted");

/* ==================== CHILD: INTERACTIVE SHOWCASE ========================= */
const SHOWCASE_TEXT = `Many websites use small text, bright colours, and moving adverts.
This can make reading feel hard or tiring for some people.
Glide learns what is easier for you.
It could change pages like this one to match.`;
const DEFAULT_STYLE = { fontCss:FONTS[0].css, fontAdj:FONTS[0].adj, sizePx:16, lineHeight:1.5, tracking:0, fg:"#000000", bg:"#FFFFFF" };

add({ id:"showcase", block:"admin", bar:"off", skipIf: () => !isChild(),
  stageFn: () => {
    const view = answers.showcase_view || "after";
    const style = view === "after" ? P : DEFAULT_STYLE;
    stage(card(specimen(style, SHOWCASE_TEXT), view === "after" ? "with your settings" : "plain, default settings", style),
      "This is a real webpage passage, shown with your choices applied.");
  },
  panel: () => {
    const w = el("div", { class:"wrap" });
    w.appendChild(el("div", { class:"eyebrow", text:"See it for yourself" }));
    w.appendChild(el("h1", { text:"This is what Glide is for" }));
    w.appendChild(el("p", { class:"lede", text:"Real websites do not usually look like your own settings. This is a small example of what a page could look like if it changed to match what you chose today." }));
    const row = el("div", { class:"pair" });
    [["Plain page","before"], ["With your settings","after"]].forEach(([lab, v]) => {
      row.appendChild(el("button", { class: (answers.showcase_view || "after") === v ? "on" : "",
        onclick:() => { answers.showcase_view = v; paint(); } }, [el("span", { text:lab })]));
    });
    w.appendChild(row);
    w.appendChild(el("p", { class:"hint", text:"Tap between the two to compare, then ask the question below." }));
    // Every other child item judges ONE dimension in isolation. This is the
    // only point where the student sees all their choices working together and
    // says whether the combined result is actually better than a normal page.
    // That is the acceptability question the whole tool rests on, and until now
    // this screen recorded nothing at all.
    w.appendChild(el("div", { class:"q" }, [
      el("div", { class:"q-t", text:"Ask the child: which of these two would you rather read?" }),
      pick("showcase_pref", [
        { value:"after",  label:"The one with my settings" },
        { value:"before", label:"The plain one" },
        { value:"same",   label:"They feel the same to me" }])]));
    w.appendChild(el("div", { class:"q" }, [
      el("div", { class:"q-t", text:"Educator: would this student actually use this, day to day?" }),
      opts("showcase_use", ["Yes, readily","Probably","Unsure","Probably not"])]));
    return w;
  },
  info: "showcase",
  onLeave: () => {
    log("admin","showcase_preference", answers.showcase_pref ?? null,
      { settings: Object.assign({}, P), compares:"own_settings_vs_plain" });
    log("admin","showcase_would_use", answers.showcase_use ?? null);
  },
  valid: () => !!answers.showcase_pref && answers.showcase_use !== undefined
});

/* ========================= CHILD: DISTRACTION ============================ */
driftScreen("drift_dis", "the pages with distractions");

/* This is the one place the webcam tracker is asked a question it can answer.
   A distractor and the body text sit hundreds of pixels apart, which is a
   separation a coarse tracker can resolve, unlike one line of text and the
   next. Each screen records the actual separation so an analyst can tell which
   of the six contrasts the geometry supported. */
DISTRACTORS.forEach((d, n) => {
  add({ id:"dis_" + d.id, block:"F_distraction", bar:"off", skipIf: () => !isChild(),
    enter: () => { if (!ORDER.dis) ORDER.dis = shuffle(DISTRACTORS.map(x => x.id));
      say("Look at this page. How does it make you feel?");
      if (gazeOn() && GAZE.calibrated) GAZE.start(); },
    stageFn: () => {
      const which = ORDER.dis[n];
      const spec = DISTRACTORS.find(x => x.id === which) || {};
      stage(mock(spec.cfg || {}), `Page ${n + 1} of ${DISTRACTORS.length}`);
      zonesFrom([{ id:"text", sel:"#stage .mock .main" }, { id:"distractor", sel:"#stage " + spec.zone }]);
    },
    panel: () => {
      const which = ORDER.dis[n];
      const spec = DISTRACTORS.find(x => x.id === which) || {};
      const w = el("div", { class:"wrap" });
      w.appendChild(el("button", { class:"speak", text:"🔊 Say it again", onclick:() => say("Look at this page. How does it make you feel?") }));
      w.appendChild(el("div", { class:"eyebrow", text:`Pages · ${n + 1} of ${DISTRACTORS.length}` }));
      w.appendChild(el("h1", { text:"How does this page feel?" }));
      if (spec.motion && MOTION.reduced())
        w.appendChild(el("div", { class:"notice bad", text:"This page is supposed to be moving, but this machine has reduced motion turned on, so it is showing as a still image. This condition is recorded as degraded and should not be compared with the others." }));
      w.appendChild(faceRow("dis_f_" + which, ["Fine", "A bit much", "Too much"]));
      w.appendChild(el("div", { class:"q" }, [
        el("div", { class:"q-t", text:"Educator, what did you observe?" }),
        pick("dis_o_" + which, [
          { value:"read", label:"Kept reading the words" },
          { value:"looked", label:"Looked away at the other thing, then came back" },
          { value:"stuck", label:"Could not get back to the words" },
          { value:"upset", label:"Became distressed or wanted to move on" }])]));
      return w;
    },
    info: "dis",
    onLeave: () => {
      const which = ORDER.dis[n], d2 = DISTRACTORS.find(x => x.id === which);
      const g = (gazeOn() && GAZE.calibrated) ? GAZE.stop() : null;
      const meta = { distractor_id:which, distractor_name:d2 ? d2.name : null, position:n + 1,
        motion_degraded: !!(d2 && d2.motion && MOTION.reduced()),
        // Measured while the page is still on screen.
        stimulus_id: "dis_" + which,
        features: pageFeatures(document.querySelector("#stage .mockwrap")) };
      log("F_distraction", "child_feeling", answers["dis_f_" + which], meta);
      log("F_distraction", "educator_observation", answers["dis_o_" + which], meta);
      if (g) log("F_distraction", "gaze", g.gaze_usable ? "usable" : "unusable", Object.assign({}, meta, g));
    },
    valid: () => { const k = ORDER.dis ? ORDER.dis[n] : null; return k && answers["dis_f_" + k] !== undefined && answers["dis_o_" + k]; }
  });
});

/* ======================= CHILD: BUSY vs CALM PAGE ======================== */
add({ id:"layout", block:"E_layout", bar:"off", skipIf: () => !isChild(),
  enter: () => { if (!ORDER.lay) ORDER.lay = RNG() < 0.5 ? ["busy","calm"] : ["calm","busy"]; say("Here are two pages. Which one would you rather read?"); },
  stageFn: () => {
    const cfgs = { busy:{ nav:true, topAd:true, midAd:true, side:true, bottomBar:true }, calm:{ subheads:true } };
    stage(ORDER.lay.map((k, i) => { const box = el("div"); box.appendChild(el("div", { class:"note", text:(i === 0 ? "1" : "2") })); box.appendChild(mock(cfgs[k])); return box; }));
  },
  panel: () => {
    const w = el("div", { class:"wrap" });
    w.appendChild(el("button", { class:"speak", text:"🔊 Say it again", onclick:() => say("Here are two pages. Which one would you rather read?") }));
    w.appendChild(el("div", { class:"eyebrow", text:"Pages" }));
    w.appendChild(el("h1", { text:"Which page would you rather read?" }));
    const row = el("div", { class:"pair" });
    ORDER.lay.forEach((k, i) => row.appendChild(el("button", { class:answers.layout === k ? "on" : "",
      onclick:() => { answers.layout = k; paint(); } },
      [el("span", { class:"which", text:i === 0 ? "1" : "2" }), el("span", { text:i === 0 ? "Top one" : "Bottom one" }), el("span", { class:"kbd", text:String(i+1) })])));
    w.appendChild(row);
    KEYS.set({ "1": () => { answers.layout = ORDER.lay[0]; paint(); },
               "2": () => { answers.layout = ORDER.lay[1]; paint(); } });
    // The same three faces the six distractor screens use, applied to both
    // whole pages. Without this, clutter and distraction are measured on
    // different scales and cannot be compared, so the question reviewers will
    // certainly ask, whether distraction is separable from general busyness or
    // collapses into it, could not be answered from this data at all.
    w.appendChild(el("h2", { text:"How does each page feel?" }));
    w.appendChild(el("p", { class:"hint", text:"Ask about each page separately, in the order shown. Same three faces as before." }));
    ORDER.lay.forEach((k, i) => {
      w.appendChild(el("div", { class:"q" }, [
        el("div", { class:"q-t", text:(i === 0 ? "Top page (1)" : "Bottom page (2)") }),
        faceRow("lay_f_" + k, ["Fine", "A bit much", "Too much"])]));
    });
    w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"Educator, did the child hesitate?" }), opts("layout_hes", ["Chose immediately","Took a moment","Needed prompting"])]));
    return w;
  },
  info: "layout",
  onLeave: () => {
    log("E_layout","preferred", answers.layout, { shown_order:ORDER.lay });
    log("E_layout","hesitation", answers.layout_hes);
    const mocks = document.querySelectorAll("#stage .mockwrap");
    ["busy","calm"].forEach(k => {
      const pos = ORDER.lay.indexOf(k);
      log("E_layout","page_feeling", answers["lay_f_" + k],
        { page:k, scale:"three_face_0_2", shown_position: pos,
          stimulus_id: "layout_" + k, features: pageFeatures(mocks[pos]) });
    });
  },
  valid: () => answers.layout && answers.layout_hes !== undefined
    && answers.lay_f_busy !== undefined && answers.lay_f_calm !== undefined
});

/* ---------------------------------------------------------------- TEXT (T)
   The same facts written two ways. Only the wording differs: sentence length,
   clause depth and word frequency change, while content, typeface, size,
   colours and line count are held identical, so a preference here is
   attributable to language difficulty and nothing else. */
const TXT_DENSE = `Although the library had been closed for repairs since winter, the notice on the door, which nobody had bothered to replace, still advertised the reading club that met on Thursdays.
Residents who arrived expecting to borrow books consequently departed disappointed, having been given no indication that the closure would continue.`;

const TXT_PLAIN = `The library shut in winter so it could be repaired.
A notice on the door still said the reading club met on Thursdays.
Nobody had taken the old notice down.
So people came to borrow books and found it shut.
Nothing told them how long it would stay shut.`;

/* The companion rationale argued against any language block on the grounds
   that it measures decoding rather than load. That holds for a pre-reader and
   this screen is skipped for them. It does not hold for a reader who can take
   in both panels, and the study needs it: the secondary aim weights the four
   CLS signals from preference data, and without a text item there is no
   child-side signal for the text-complexity weight at all, leaving it resting
   entirely on one educator's allocation with nothing to check it against. */
add({ id:"textlevel", block:"F_text",
  skipIf: () => !isChild() || answers.reading_level === "pre",
  enter: () => { if (!ORDER.txt) ORDER.txt = RNG() < 0.5 ? ["dense","plain"] : ["plain","dense"];
    say("Here are two pieces of writing. They say the same thing. Which one is easier to understand?"); },
  stageFn: () => stage(ORDER.txt.map((k, i) =>
      card(specimen({}, k === "dense" ? TXT_DENSE : TXT_PLAIN), i === 0 ? "1" : "2")),
    "Same information, written two ways. Everything else is identical."),
  panel: () => {
    const w = el("div", { class:"wrap" });
    w.appendChild(el("button", { class:"speak", text:"🔊 Say it again",
      onclick:() => say("Here are two pieces of writing. They say the same thing. Which one is easier to understand?") }));
    w.appendChild(el("div", { class:"eyebrow", text:"Words" }));
    w.appendChild(el("h1", { text:"Which one is easier to understand?" }));
    const row = el("div", { class:"pair" });
    ORDER.txt.forEach((k, i) => row.appendChild(el("button", { class:answers.textlevel === k ? "on" : "",
      onclick:() => { answers.textlevel = k; paint(); } },
      [el("span", { class:"which", text:i === 0 ? "1" : "2" }), el("span", { text:i === 0 ? "Top one" : "Bottom one" }), el("span", { class:"kbd", text:String(i+1) })])));
    row.appendChild(el("button", { class:answers.textlevel === "same" ? "on" : "",
      onclick:() => { answers.textlevel = "same"; paint(); } },
      [el("span", { class:"which", text:"=" }), el("span", { text:"They feel the same to me" }), el("span", { class:"kbd", text:"3" })]));
    w.appendChild(row);
    KEYS.set({ "1": () => { answers.textlevel = ORDER.txt[0]; paint(); },
               "2": () => { answers.textlevel = ORDER.txt[1]; paint(); },
               "3": () => { answers.textlevel = "same"; paint(); } });
    w.appendChild(el("div", { class:"q" }, [
      el("div", { class:"q-t", text:"Ask the child: how did the top one feel to read?" }),
      faceRow("txt_f_" + ORDER.txt[0], ["Fine", "A bit much", "Too much"])]));
    w.appendChild(el("div", { class:"q" }, [
      el("div", { class:"q-t", text:"And the bottom one?" }),
      faceRow("txt_f_" + ORDER.txt[1], ["Fine", "A bit much", "Too much"])]));
    return w;
  },
  info: "textlevel",
  onLeave: () => {
    const win = answers.textlevel;
    // shown_bottom matters: on a tie, winner and loser are null, so without it
    // the second item of the pair cannot be recovered and the row is useless
    // to a Bradley-Terry fit.
    log("F_text","pairwise", win === "same" ? "tie" : win, {
      comparison:"textlevel", winner: win === "same" ? null : win,
      loser: win === "same" ? null : (win === "dense" ? "plain" : "dense"),
      tie: win === "same", shown_top: ORDER.txt[0], shown_bottom: ORDER.txt[1],
      shown_order: ORDER.txt });
    const cards = document.querySelectorAll("#stage .card");
    ["dense","plain"].forEach(k => {
      const pos = ORDER.txt.indexOf(k);
      log("F_text","text_feeling", answers["txt_f_" + k],
        { variant:k, scale:"three_face_0_2", shown_position: pos,
          stimulus_id: "text_" + k, features: pageFeatures(cards[pos]) });
    });
  },
  valid: () => !!answers.textlevel && answers.txt_f_dense !== undefined && answers.txt_f_plain !== undefined
});

/* ============================ CHILD: RETEST ============================== */
add({ id:"retest", block:"M_reliability", skipIf: () => !isChild(),
  enter: () => { if (!ORDER.re) { const f = P.fontId, other = FONTS.filter(x => x.id !== f && !FONTHEALTH.failed().includes(x.id));
      ORDER.re = shuffle([f, (other[Math.floor(RNG() * other.length)] || FONTS[0]).id]); }
    say("Last one. Which of these two do you want to read?"); },
  stageFn: () => stage(ORDER.re.map((id, i) => { const f = FONTS.find(x => x.id === id); const o = { fontCss:f.css, fontAdj:f.adj }; return card(specimen(o, KID_B), i === 0 ? "1" : "2", o); }),
    "A different story this time."),
  panel: () => {
    const w = el("div", { class:"wrap" });
    w.appendChild(el("div", { class:"eyebrow", text:"Last question" }));
    w.appendChild(el("h1", { text:"Which one do you want to read?" }));
    const row = el("div", { class:"pair" });
    ORDER.re.forEach((id, i) => row.appendChild(el("button", { class:answers.retest === id ? "on" : "",
      onclick:() => { answers.retest = id; paint(); } },
      [el("span", { class:"which", text:i === 0 ? "1" : "2" }), el("span", { text:i === 0 ? "Top one" : "Bottom one" }), el("span", { class:"kbd", text:String(i+1) })])));
    w.appendChild(row);
    KEYS.set({ "1": () => { answers.retest = ORDER.re[0]; paint(); },
               "2": () => { answers.retest = ORDER.re[1]; paint(); } });
    return w;
  },
  info: "retest",
  onLeave: () => log("M_reliability","font_retest", answers.retest, { earlier_winner:P.fontId, agrees:answers.retest === P.fontId, shown:ORDER.re }),
  valid: () => !!answers.retest
});


/* ====================== EDUCATOR: CHILD PROFILE ========================== */
add({ id:"ed1", block:"ED_profile", bar:"off", skipIf: () => isChild() || S.mode !== "educator",
  stageFn: () => stage(card(el("div", {}, [
    el("div", { class:"eyebrow", text:"Educator session" }),
    el("h1", { text:"About this child" }),
    el("p", { class:"lede", text:"You know this child far better than any questionnaire can. These answers carry as much weight in the study as the child's own choices." }),
    el("div", { class:"notice", text:"Use the child code, never a name. Skip anything you are not comfortable answering or not permitted to share." })
  ]))),
  panel: () => {
    const w = el("div", { class:"wrap" });
    w.appendChild(el("div", { class:"eyebrow", text:"Profile" }));
    w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"Age band" }), opts("ed_age", ["12-13","14-15","16-17","18+"])]));
    // Identified needs and how they were established are captured once, on the
    // ascertainment screen at the start. Repeating the question here would
    // invite a second, differently-worded answer for the same student in the
    // same file.
    (() => {
      const named = (answers.dx || []).map(id => (CONDITIONS.find(c => c.id === id) || {}).label).filter(Boolean);
      w.appendChild(el("div", { class:"q" }, [
        el("div", { class:"q-t", text:"Identified needs (recorded at setup)" }),
        el("p", { class:"hint", text: named.length ? named.join("  ·  ") : "Nothing recorded. Use Back to return to the setup screen." })]));
    })();
    w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"Reading age relative to chronological age" }), opts("ed_readage", ["2+ years behind","About 1 year behind","At age level","Above age level","Not assessed"])]));
    w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"How long can this child usually read before needing a break?" }), opts("ed_stamina", ["Under 2 min","2-5 min","5-15 min","Over 15 min"])]));
    w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"Does the child use any reading support already?" }), textArea("ed_tools","Coloured overlays, larger print, text-to-speech, reading rulers…")]));
    return w;
  },
  info: "ed1",
  onLeave: () => ["ed_age","ed_readage","ed_stamina","ed_tools"].forEach(k => log("ED_profile", k, answers[k] ?? null)),
  valid: () => answers.ed_age !== undefined && answers.ed_readage !== undefined && answers.ed_stamina !== undefined
});

/* ==================== EDUCATOR: WHAT MAKES IT HARD ======================= */
const ALLOC = [
  { k:"W_T", n:"The words are too hard, long words, unfamiliar words, complicated sentences" },
  { k:"W_V", n:"The page is too busy, cluttered, cramped, too much on screen at once" },
  { k:"W_W", n:"The text itself is hard to see, too small, too faint, badly spaced" },
  { k:"W_D", n:"Things competing for attention, adverts, pop-ups, animation, movement" }
];
add({ id:"ed_w", block:"ED_weights", bar:"off", skipIf: () => isChild() || S.mode !== "educator",
  enter: () => ALLOC.forEach(a => { if (answers[a.k] === undefined) answers[a.k] = 25; }),
  stageFn: () => stage(card(el("div", {}, [
    el("div", { class:"eyebrow", text:"Educator session" }),
    el("h1", { text:"What actually gets in the way?" }),
    el("p", { class:"lede", text:"Four things can make a page hard for a child. They do not matter equally." }),
    el("div", { class:"notice", text:"Answer for this particular child, not for children in general. If adverts derail them twice as much as hard words, give adverts twice the points." })
  ]))),
  panel: () => {
    const w = el("div", { class:"wrap" });
    w.appendChild(el("div", { class:"eyebrow", text:"Weighting" }));
    w.appendChild(el("h1", { text:"Spend 100 points" }));
    ALLOC.forEach(a => w.appendChild(el("div", { class:"alloc" }, [
      el("span", { class:"nm", text:a.n }),
      el("input", { type:"range", min:0, max:100, value:answers[a.k], "aria-label":a.n, oninput:e => { answers[a.k] = +e.target.value; paint(); } }),
      el("span", { class:"v", text:String(answers[a.k]) })])));
    const t = ALLOC.reduce((s, a) => s + answers[a.k], 0);
    w.appendChild(el("div", { class:"tot " + (t === 100 ? "good" : "bad") }, [el("span", { text:"Total" }), el("span", { text:t + " / 100" })]));
    if (t !== 100) w.appendChild(el("p", { class:"hint", text:t > 100 ? `Remove ${t - 100}.` : `${100 - t} left to spend.` }));
    return w;
  },
  info: "ed_w",
  onLeave: () => ALLOC.forEach(a => log("ED_weights", a.k, answers[a.k])),
  valid: () => ALLOC.reduce((s, a) => s + answers[a.k], 0) === 100
});

/* =================== EDUCATOR: OBSERVATION & PRIORITIES ================= */
add({ id:"ed_obs", block:"ED_observation", bar:"off", skipIf: () => isChild() || S.mode !== "educator",
  stageFn: () => stage(card(el("div", {}, [
    el("div", { class:"eyebrow", text:"Educator session" }),
    el("h1", { text:"What you saw, and what you know" }),
    el("p", { class:"lede", text:"The first questions are about the child session you just ran. The rest draw on what you already know about this child." })
  ]))),
  panel: () => {
    const w = el("div", { class:"wrap" });
    w.appendChild(el("div", { class:"eyebrow", text:"Observation" }));
    w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"How well did the child understand what they were being asked?" }), scale("ed_understood", 5, "Not at all", "Completely")]));
    w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"How confident are you that their choices were real preferences rather than guesses or a pattern (always picking the top, for example)?" }), scale("ed_genuine", 5, "Not confident", "Very confident")]));
    w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"Did you have to prompt or explain beyond reading the question aloud?" }), opts("ed_prompt", ["Never","Once or twice","Often","Throughout"])]));
    w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"Would their answers be different on a different day?" }), opts("ed_variance", ["Unlikely","Possibly","Very likely"])]));
    // v5: explains face-loss stretches in the video without anyone re-watching it.
    w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"During the camera parts, how much did the child move, fidget or look away from the screen?" }),
      opts("ed_restless", ["Hardly at all","Some of the time","A lot","Left the seat at times","No camera was used"])]));
    w.appendChild(el("h2", { text:"What you already know" }));
    w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"What single change to a page helps this child most?" }), textArea("ed_best","In your own words")]));
    w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"What derails them fastest?" }), textArea("ed_worst","")]));
    w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"Anything specific we did not show, particular colours, patterns, sounds, movements?" }), textArea("ed_trigger","")]));
    w.appendChild(el("div", { class:"q" }, [el("div", { class:"q-t", text:"If a page were visibly changed for this child in front of classmates, how would that land?" }), scale("ed_stigma", 5, "Completely fine", "They would resist it")]));
    return w;
  },
  info: "ed_obs",
  onLeave: () => ["ed_understood","ed_genuine","ed_prompt","ed_variance","ed_restless","ed_best","ed_worst","ed_trigger","ed_stigma"].forEach(k => log("ED_observation", k, answers[k] ?? null)),
  valid: () => answers.ed_understood && answers.ed_genuine && answers.ed_prompt !== undefined && answers.ed_stigma
});

add({ id:"ed_pri", block:"ED_backlog", bar:"off", skipIf: () => isChild() || S.mode !== "educator",
  enter: () => { if (!answers.pri) { answers.pri = {}; ORDER.ad = shuffle(ADAPTATIONS); } },
  stageFn: () => stage(card(el("div", {}, [
    el("div", { class:"eyebrow", text:"Educator session" }),
    el("h1", { text:"What would actually help?" }),
    el("table", { class:"t", html:"<tbody><tr><th>Must</th><td>Without this the tool is not worth using for this child</td></tr><tr><th>Should</th><td>Would make a real difference</td></tr><tr><th>Could</th><td>Might help a little</td></tr><tr><th>No</th><td>Would not help, or would get in the way</td></tr></tbody>" })
  ]))),
  panel: () => {
    const w = el("div", { class:"wrap" });
    w.appendChild(el("div", { class:"eyebrow", text:`Priorities · ${Object.keys(answers.pri).length} of ${ADAPTATIONS.length}` }));
    ORDER.ad.forEach(a => {
      const row = el("div", { class:"q", style:"padding:10px 12px" });
      row.appendChild(el("div", { class:"q-t", style:"margin-bottom:6px", text:a }));
      const sc = el("div", { class:"scale" });
      ["Must","Should","Could","No"].forEach(b => sc.appendChild(el("button", { class:answers.pri[a] === b ? "on" : "", text:b, onclick:() => { answers.pri[a] = b; paint(); } })));
      row.appendChild(sc); w.appendChild(row);
    });
    return w;
  },
  info: "ed_pri",
  onLeave: () => ADAPTATIONS.forEach(a => log("ED_backlog","priority", answers.pri[a] || null, { adaptation:a })),
  valid: () => Object.keys(answers.pri || {}).length === ADAPTATIONS.length
});

/* =========================================================================
   WEIGHT RELIABILITY
   -------------------------------------------------------------------------
   The 100-point allocation is the single most important number this study
   derives: it IS the per-child CLS weight vector. Until now it was elicited
   once, from one person, with no way to tell a considered judgement from a
   number picked in ten seconds. Its reliability was simply unknown, and with
   one chance at collection it would have stayed unknown forever.

   Repeating it at the end of the session, after the educator has answered
   everything else and without showing the first answer back, gives a
   within-session test-retest for that vector. A tight repeat means the weights
   can be trusted; a wild one means that child's weights should be pooled
   rather than used individually. Either way it becomes a reportable number
   instead of an assumption, for about sixty seconds of session time.
   ========================================================================= */
add({ id:"ed_w2", block:"ED_weights", bar:"off", skipIf: () => isChild() || S.mode !== "educator",
  enter: () => ALLOC.forEach(a => { if (answers[a.k + "_2"] === undefined) answers[a.k + "_2"] = 25; }),
  stageFn: () => stage(card(el("div", {}, [
    el("div", { class:"eyebrow", text:"Last question" }),
    el("h1", { text:"The same hundred points, once more" }),
    el("p", { class:"lede", text:"You answered this near the start. Please answer it again now, from scratch, without trying to recall what you put the first time." }),
    el("div", { class:"notice", text:"This is not a test of memory and the two answers do not have to match. Comparing them tells the researchers how stable this judgement is, which decides whether this student's weighting can be used on its own or should be pooled with others. A different answer is a useful answer." })
  ]))),
  panel: () => {
    const w = el("div", { class:"wrap" });
    w.appendChild(el("div", { class:"eyebrow", text:"Weighting \u00b7 repeat" }));
    w.appendChild(el("h1", { text:"Spend 100 points" }));
    w.appendChild(el("p", { class:"hint", text:"For this same student. Your earlier answer is deliberately not shown." }));
    ALLOC.forEach(a => w.appendChild(el("div", { class:"alloc" }, [
      el("span", { class:"nm", text:a.n }),
      el("input", { type:"range", min:0, max:100, value:answers[a.k + "_2"], "aria-label":a.n,
        oninput:e => { answers[a.k + "_2"] = +e.target.value; paint(); } }),
      el("span", { class:"v", text:String(answers[a.k + "_2"]) })])));
    const t = ALLOC.reduce((s, a) => s + answers[a.k + "_2"], 0);
    w.appendChild(el("div", { class:"tot " + (t === 100 ? "good" : "bad") }, [el("span", { text:"Total" }), el("span", { text:t + " / 100" })]));
    if (t !== 100) w.appendChild(el("p", { class:"hint", text:t > 100 ? `Remove ${t - 100}.` : `${100 - t} left to spend.` }));
    return w;
  },
  info: "ed_w2",
  onLeave: () => ALLOC.forEach(a => log("ED_weights", a.k + "_repeat", answers[a.k + "_2"])),
  valid: () => ALLOC.reduce((s, a) => s + answers[a.k + "_2"], 0) === 100
});

/* ================================ FINISH ================================ */
/* v5: entering this screen stops the video (end sync flash first), builds
   every file, and queues it for Drive. Nothing has to be clicked for the data
   to leave the laptop; the zip is the fallback when there is no network. */
add({ id:"done", block:"admin", bar:"off", last:true,
  enter: () => { finalizeSession(); },
  stageFn: () => {
    if (isChild()) {
      stage(card(el("div", {}, [
        el("h1", { style:"font-size:34px", text:"All finished!" }),
        el("div", { style:"font-size:22px" }, [el("p", { text:"Thank you for helping." }), el("p", { text:"Your answers will help make websites easier for lots of people." })])
      ])));
      if (!S._saidBye) { S._saidBye = true; say("All finished. Thank you for helping."); }
    } else {
      const d = derive();
      stage(card(el("div", {}, [
        el("div", { class:"eyebrow", text:"Complete" }), el("h1", { text:"Educator session recorded" }),
        el("table", { class:"t", html:`<tbody>
          <tr><th>Weights</th><td>T ${d.weights.raw_100.T} · V ${d.weights.raw_100.V} · W ${d.weights.raw_100.W} · D ${d.weights.raw_100.D}</td></tr>
          <tr><th>Responses</th><td>${S.responses.length}</td></tr></tbody>` })
      ])));
    }
  },
  panel: () => {
    const w = el("div", { class:"wrap" });
    const d = derive();
    w.appendChild(el("div", { class:"eyebrow", text:"Finished" }));
    w.appendChild(el("h1", { text:"Saving this session" }));

    if (S.withdrawn) {
      w.appendChild(el("div", { class:"notice bad", html:"<strong>This session is marked withdrawn.</strong> It is still saved, with the withdrawal recorded inside, so the researcher can show it was excluded rather than quietly lost. Reason: " + (S.withdraw_reason || "not given") +
        (S.video.deleted ? "<br><strong>Video deleted</strong> from this laptop" + (S.video.server_deleted ? " and from Drive." : S.video.server_delete_pending ? "; deleting it from Drive failed and must be done by the admin." : "; Drive deletion requested.") : "") }));
    }

    if (isChild()) {
      const f = FONTS.find(x => x.id === P.fontId);
      const t = el("table", { class:"t" });
      t.innerHTML = `<tbody>
        <tr><th>Letters</th><td>${f ? f.name : "-"}</td></tr>
        <tr><th>Size</th><td>${effSize(P.sizePx, P.fontAdj)} px</td></tr>
        <tr><th>Line spacing</th><td>${P.lineHeight}</td></tr>
        <tr><th>Letter spacing</th><td>${P.tracking} em</td></tr>
        <tr><th>Colours</th><td>${P.fg} on ${P.bg}</td></tr>
        <tr><th>Ties recorded</th><td>${d.quality.tie_count}</td></tr>
        <tr><th>Repeat choice matched</th><td>${d.quality.retest_agrees === null ? "-" : d.quality.retest_agrees ? "yes" : "no"}</td></tr>
        <tr><th>Side bias</th><td>${d.quality.top_side_bias === null ? "-" : (d.quality.top_side_bias * 100).toFixed(0) + "% chose the top item"}</td></tr>
        <tr><th>Session length</th><td>${Math.round(d.quality.session_minutes)} min</td></tr>
        <tr><th>Video</th><td>${S.video.consented ? (S.video.deleted ? "deleted" : REC.segments.length + " part(s), " + (d.quality.v5.frames.achieved_fps || "-") + " fps, face in " + (d.quality.v5.face.face_share !== undefined ? Math.round(d.quality.v5.face.face_share * 100) + "%" : "-") + " of frames") : "not recorded"}</td></tr>
        <tr><th>Eye tracking</th><td>${GAZE.validation ? GAZE.validation.mean_error_deg + "° · " + (GAZE.validation.meets_protocol ? "meets rule" : "fails rule") + " · " + S.calibration_attempts + " attempt(s)" : "not used"}</td></tr></tbody>`;
      w.appendChild(t);
      const flags = [];
      if (d.quality.tie_count > 4) flags.push("Many ties, the child may not have discriminated between options");
      if (d.quality.top_side_bias !== null && (d.quality.top_side_bias > 0.8 || d.quality.top_side_bias < 0.2)) flags.push("Strong side bias, may indicate position responding rather than preference");
      if (d.quality.median_latency_ms < 700) flags.push("Very fast responding");
      if (d.quality.retest_agrees === false) flags.push("Repeat choice did not match the earlier winner");
      if (!d.quality.fonts_ok) flags.push("Typefaces did not render distinctly; some letters pairs were skipped");
      if (d.quality.reduced_motion) flags.push("Reduced motion was on; the two motion distractors were shown as still images");
      if (d.quality.gaze_health === "dead") flags.push("Eye tracking was consented to but the camera never produced readings");
      if (d.quality.gaze_validation && !d.quality.gaze_validation.meets_protocol) flags.push("Eye tracking did not meet the pre-declared accuracy / data-loss rule");
      if (d.quality.session_minutes > 30) flags.push("Long session (" + Math.round(d.quality.session_minutes) + " min); fatigue may have affected later answers");
      if (S.ended_early) flags.push("Session ended early: " + (S.end_reason || "no reason given"));
      (d.quality.v5.flags || []).forEach(x => flags.push(x));
      w.appendChild(flags.length ? el("div", { class:"notice", html:"<strong>Notes for the researcher</strong><br>" + flags.join("<br>") })
                                 : el("div", { class:"notice ok", text:"No data-quality flags raised." }));
    }

    /* Upload status */
    const ob = OUTBOX.stats();
    w.appendChild(el("h2", { text:"Upload to the study Drive" }));
    if (!FINISHING || !S._manifest) w.appendChild(el("div", { class:"notice", text:"Preparing the files…" }));
    else if (!LINK.configured()) w.appendChild(el("div", { class:"notice bad", text:"This laptop is not linked to the study Drive. Save the zip below and hand it to the researcher, or link the laptop and reopen this page: the files stay queued on this laptop." }));
    else {
      const all = ob.pending === 0 && ob.local_only === 0 && ob.uploaded > 0;
      w.appendChild(el("div", { class: all ? "notice ok" : "notice", html: all
        ? "<strong>Everything is on Drive</strong> (" + ob.uploaded + " files, " + (ob.bytes_uploaded / 1e6).toFixed(1) + " MB) in <code>" + folderPath() + "</code>."
        : "<strong>Uploading…</strong> " + ob.uploaded + " done, " + ob.pending + " waiting (" + (ob.bytes_pending / 1e6).toFixed(1) + " MB)" +
          (ob.failed ? ", " + ob.failed + " retrying" : "") + (ob.local_only ? ", " + ob.local_only + " too large to upload (use the zip)" : "") +
          (LINK.online() === false ? ". No connection right now: uploads continue when it returns, also after closing and reopening this page." : ".") }));
      if (!all) w.appendChild(el("button", { class:"speak", text:"Try uploading now", onclick:() => OUTBOX.pump() }));
    }
    w.appendChild(el("button", { class:"btn ghost", style:"width:100%;margin:10px 0 8px", text:"Download everything as one .zip", onclick:() => downloadZip() }));
    w.appendChild(el("p", { class:"hint", text:"The zip has the same folder and files as Drive: manifest.json (read first), session.json (complete record), the CSVs, the data dictionary and the video parts." }));
    w.appendChild(el("button", { class:"speak", style:"margin-top:10px", text:"Clear this session from this laptop", onclick: async () => {
      const st = OUTBOX.stats();
      const safe = st.pending === 0 && st.local_only === 0 && st.uploaded > 0;
      if (!safe && !S._zipped) { alert("Not everything is on Drive yet and no zip has been saved. Wait for the upload, or download the zip first."); return; }
      if (!confirm(safe ? "Everything is on Drive. Remove this session's local copy (including video) from this laptop?" : "Not everything is on Drive, but a zip was saved. Remove the local copy anyway?")) return;
      if (safe) await OUTBOX.clearUploaded(S.session_id);
      else { for (const st2 of ["outbox","rows","chunks"]) await IDB.delSid(st2, S.session_id).catch(() => {}); await IDB.del("meta", S.session_id).catch(() => {}); }
      try { localStorage.removeItem("glide_backup"); } catch (e) {}
      log("admin", "local_copy_cleared", true, { all_uploaded: safe });
      alert("Local copy cleared. Reload the page to start the next session.");
    } }));
    return w;
  },
  valid: () => true
});
OUTBOX.onChange(() => { const s = visible()[idx]; if (s && s.id === "done") { const p = $("#panel"); const y = p ? p.scrollTop : 0; paint(); if (p) p.scrollTop = y; } });


/* =========================================================================
   DERIVATION AND EXPORT
   -------------------------------------------------------------------------
   Two things consume this data and they want different shapes, so both are
   emitted rather than leaving either to be reconstructed by hand later:

     1. The Cognitive Load Score. Needs a per-child weight vector over
        T/V/W/D, a preference table a Bradley-Terry model can be fitted to
        directly, and criterion measures recorded against the same stimuli so
        the weights can be checked against something rather than asserted.

     2. The browser extension. Needs one object it can load and apply without
        interpretation: concrete CSS values, a ranked list of what to suppress,
        and the build backlog, each carrying how much to trust the session.

   Nothing here could not be recomputed from S.responses; the raw log remains
   the source of truth and these are conveniences with provenance attached.
   ========================================================================= */

/* Every pairwise judgement as one flat row. This is the shape Bradley-Terry
   and Plackett-Luce fitters expect: two items, an outcome, and the nuisance
   variables (which side each appeared on, how long it took) that let position
   bias and fast responding be modelled rather than assumed away. Per-item win
   counts throw away which opponent an item beat, which is exactly what those
   models are fitted on. */
function pairwiseLong() {
  return S.responses.filter(r => r.item === "pairwise").map(r => ({
    child_id: S.child_id,
    dimension: r.comparison,
    item_a: r.shown_top,
    item_b: r.shown_bottom || ((r.winner === r.shown_top ? r.loser : r.winner) || null),
    winner: r.tie ? null : r.winner,
    loser: r.tie ? null : r.loser,
    tie: !!r.tie,
    winner_position: r.tie ? null : (r.winner === r.shown_top ? "top" : "bottom"),
    latency_ms: r.latency_ms,
    stimulus_hash_a: r.stimulus_hash_top || r.stimulus_hash,
    stimulus_hash_b: r.stimulus_hash_bottom || r.stimulus_hash,
    ts: r.ts, t_perf: r.t_perf
  }));
}

/* One row per zone per gaze screen. Each carries the accuracy measured on this
   participant and whether the zones on that screen were further apart than
   that accuracy, so a row that cannot support a comparison says so itself. */
function gazeZones() {
  const out = [];
  S.responses.filter(r => (r.zones || []).length).forEach(r => {
    r.zones.forEach(z => out.push(Object.assign({
      child_id: S.child_id,
      screen: r.item,
      block: r.block,
      distractor_id: r.distractor_id || null,
      settings: r.settings || null,
      passage: r.passage || null,
      validation_error_px: r.validation_error_px,
      validation_error_deg: r.validation_error_deg,
      zone_separation_px: r.zone_separation_px ?? null,
      separation_exceeds_error: r.separation_exceeds_error ?? null,
      // null means "not applicable": a single-zone screen has no between-zone
      // contrast to interpret, and reading it as a failure would be wrong.
      interpretable: r.separation_exceeds_error === null || r.separation_exceeds_error === undefined
        ? null : r.separation_exceeds_error === true
    }, z)));
  });
  return out;
}

function derive() {
  const pw = S.responses.filter(r => r.item === "pairwise");
  const ties = pw.filter(r => r.tie).length;
  const decided = pw.filter(r => !r.tie);
  const topChosen = decided.filter(r => r.winner === r.shown_top).length;
  const wins = {};
  decided.forEach(r => { wins[r.comparison] = wins[r.comparison] || {}; wins[r.comparison][r.winner] = (wins[r.comparison][r.winner] || 0) + 1; });
  const re = S.responses.find(r => r.item === "font_retest");
  const lat = S.responses.map(r => r.latency_ms).filter(x => x > 0).sort((a, b) => a - b);

  const feel = {}, obs = {};
  S.responses.filter(r => r.item === "child_feeling").forEach(r => feel[r.distractor_id] = r.value);
  S.responses.filter(r => r.item === "educator_observation").forEach(r => obs[r.distractor_id] = r.value);
  // D sub-weights come from educator-observed disruption, not the child's
  // feeling. Behaviour observed by someone who knows the child is the more
  // valid index; the feeling is kept because the divergence is informative.
  const disrupt = {}; let tot = 0;
  Object.entries(obs).forEach(([k, v]) => { const d = (v === "looked" || v === "stuck" || v === "upset") ? 1 : 0; disrupt[k] = d; tot += d; });
  const sub = {}; Object.keys(disrupt).forEach(k => sub[k] = tot ? +(disrupt[k] / tot).toFixed(4) : 0);

  /* ----------------------------------------------------------- CLS weights
     Elicited as 100 points because that is what an educator can reason about;
     a score needs weights on the unit simplex. Both are emitted: the raw
     allocation for audit, and a normalised vector in fixed T, V, W, D order so
     it can be dotted with a feature vector without anyone guessing the order. */
  const raw = { T:answers.W_T, V:answers.W_V, W:answers.W_W, D:answers.W_D };
  const sum = ["T","V","W","D"].reduce((a, k) => a + (+raw[k] || 0), 0);
  const norm = {}; ["T","V","W","D"].forEach(k => norm[k] = sum ? +((+raw[k] || 0) / sum).toFixed(4) : null);

  /* ------------------------------------------------------ criterion measures
     The before-and-after the weights get checked against. Same scale, matched
     passages, counterbalanced. felt_load is on the three-face scale (0 fine,
     1 a bit much, 2 too much) and is collected whether or not the camera
     worked, so this contrast exists in every session. */
  const gz = k => S.responses.find(r => r.block === "gaze_reading" && r.item === k) || null;
  const base = gz("baseline_default"), post = gz("post_adaptation");
  const num = (o, k) => (o && typeof o[k] === "number") ? o[k] : null;
  const delta = (a, b) => (a === null || b === null) ? null : +(b - a).toFixed(4);
  const onText = o => { if (!o || !o.zones) return null; const z = o.zones.find(x => x.zone_id === "text"); return z ? z.share : null; };
  // Recall is the only performance measure in the study; without it the
  // reading contrast is preference against preference.
  const rc = k => S.responses.find(r => r.block === "G_recall" && r.item === k) || null;
  const rb = rc("recall_baseline"), ra = rc("recall_adapted");
  const reading = {
    scale: "three_face: 0 fine, 1 a bit much, 2 too much",
    passage_order: ORDER.read || null,
    baseline: base ? { passage: base.passage, felt_load: base.felt_load, gaze_usable: !!base.gaze_usable,
      reading_time_ms: num(base,"reading_time_ms"), duration_ms: num(base,"duration_ms"),
      on_text_share: onText(base), recall_correct: rb ? rb.correct : null, recall_score: rb ? rb.score : null } : null,
    adapted: post ? { passage: post.passage, felt_load: post.felt_load, gaze_usable: !!post.gaze_usable,
      reading_time_ms: num(post,"reading_time_ms"), duration_ms: num(post,"duration_ms"),
      on_text_share: onText(post), recall_correct: ra ? ra.correct : null, recall_score: ra ? ra.score : null } : null,
    // Negative deltas mean the child's own settings eased reading on that
    // measure. Reported, never interpreted here.
    delta_felt_load: (base && post) ? delta(base.felt_load, post.felt_load) : null,
    delta_reading_time_ms: delta(num(base,"reading_time_ms"), num(post,"reading_time_ms")),
    delta_recall_score: (rb && ra) ? delta(rb.score, ra.score) : null,
    delta_on_text_share: delta(onText(base), onText(post)),
    note: "Different passages, counterbalanced, so a practice effect cannot masquerade as easier reading. Gaze measures are coarse by construction; see gaze_accuracy."
  };

  /* --------------------------------------------- V and D on one scale */
  const layFeel = {};
  S.responses.filter(r => r.item === "page_feeling").forEach(r => layFeel[r.page] = r.value);
  const txtFeel = {};
  S.responses.filter(r => r.item === "text_feeling").forEach(r => txtFeel[r.variant] = r.value);
  const txtPair = S.responses.find(r => r.comparison === "textlevel") || null;
  const meanFeel = o => { const v = Object.values(o).filter(x => typeof x === "number"); return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3) : null; };

  /* ----------------------------------------------------- ascertainment */
  const dxIds = answers.dx || [];
  const dxSrc = answers.dx_src || [];
  const dxLabel = id => (CONDITIONS.find(c => c.id === id) || {}).label || id;
  const documented = dxSrc.some(x => x === "clinical" || x === "cert" || x === "school" || x === "medical");
  const reported = dxSrc.includes("parent");
  const identified = dxIds.length > 0 && !dxIds.includes("none") && !dxIds.includes("nosay");
  const ascertainment = {
    conditions: dxIds,
    condition_labels: dxIds.map(dxLabel),
    other_free_text: answers.dx_other || null,
    detail: (() => { const d = {}; Object.entries(answers.dx_detail || {}).forEach(([k, v]) => {
      d[k] = /not specified/i.test(String(v)) ? null : v; }); return d; })(),
    sources: dxSrc,
    source_labels: dxSrc.map(id => (DX_SOURCES.find(x => x.id === id) || {}).label || id),
    documentation_seen: answers.dx_seen ?? null,
    documentation_seen_label: DX_SEEN[answers.dx_seen] ?? null,
    assessment_recency: answers.dx_recency ?? null,
    assessment_recency_label: DX_RECENCY[answers.dx_recency] ?? null,
    note: answers.dx_note || null,
    evidence_grade: !identified ? "none" : documented ? "documented" : reported ? "reported" : "undocumented",
    counts_as_documented_nd: identified && documented,
    method: "records_transcription_only"
  };

  /* -------------------------------------------------- extension profile
     A profile is assembled from BOTH sessions: the child session supplies
     rendering and what disrupts, the educator session supplies weights and
     backlog. Each half says which it carries so merging on child_id is
     mechanical rather than a judgement about which file had real values. */
  const fromChild = isChild();
  const suppress = Object.keys(sub).filter(k => sub[k] > 0).sort((a, b) => sub[b] - sub[a]);
  const pri = answers.pri || {};
  // Stored as the on-screen labels; compared case-insensitively so the backlog
  // does not silently come out empty if those labels are ever reworded.
  const tier = t => Object.keys(pri).filter(k => String(pri[k]).toLowerCase() === t);
  const profile = {
    schema: "glide_profile/2",
    child_id: S.child_id,
    source_session: S.session_id,
    source_mode: S.mode,
    instrument_version: INSTRUMENT_VERSION,
    covers: fromChild ? ["css","suppress_ranked","simplify_text"] : ["cls_weights","backlog"],
    complete: false,
    missing: fromChild ? ["cls_weights","backlog"] : ["css","suppress_ranked","simplify_text"],
    conditions: ascertainment.condition_labels,
    evidence_grade: ascertainment.evidence_grade,
    css: fromChild ? {
      font_family: P.fontCss,
      font_id: P.fontId,
      font_size_px: effSize(P.sizePx, P.fontAdj),
      line_height: P.lineHeight,
      letter_spacing: P.tracking ? P.tracking + "em" : "normal",
      max_chars_per_line: P.cpl,
      color: P.fg,
      background_color: P.bg
    } : null,
    suppress_ranked: fromChild ? suppress : null,
    suppress_weights: fromChild ? sub : null,
    simplify_text: fromChild ? (txtPair ? (txtPair.winner === "plain") : null) : null,
    backlog: fromChild ? null : { must: tier("must"), should: tier("should"), could: tier("could"), no: tier("no") },
    cls_weights: fromChild ? null : norm,
    confidence: {
      withdrawn: S.withdrawn,
      ended_early: S.ended_early,
      retest_agrees: re ? !!re.agrees : null,
      top_side_bias: decided.length ? +(topChosen / decided.length).toFixed(3) : null,
      tie_count: ties,
      educator_confidence: answers.ed_genuine ?? null,
      fonts_ok: FONTHEALTH.ok(),
      reduced_motion: MOTION.reduced(),
      gaze_health: GAZE.health()
    }
  };

  return {
    child_settings: { font_id:P.fontId, font_family:P.fontCss, font_size_px:effSize(P.sizePx, P.fontAdj),
      line_height:P.lineHeight, letter_spacing_em:P.tracking, chars_per_line:P.cpl, text:P.fg, background:P.bg },
    pairwise_wins: wins,
    pairwise_long: pairwiseLong(),
    distraction: { child_feeling:feel, educator_observation:obs, d_subweights:sub, mean_child_feeling: meanFeel(feel) },
    layout: { child_feeling: layFeel, preferred: answers.layout || null,
      clutter_cost: (typeof layFeel.busy === "number" && typeof layFeel.calm === "number") ? layFeel.busy - layFeel.calm : null },
    text: { pairwise: txtPair ? { winner: txtPair.winner, tie: !!txtPair.tie } : null,
      child_feeling: txtFeel,
      language_cost: (typeof txtFeel.dense === "number" && typeof txtFeel.plain === "number") ? txtFeel.dense - txtFeel.plain : null },
    reading: reading,
    ascertainment: ascertainment,
    /* Covariates that change what every typography result means. Recorded
       because none of them can be reconstructed after the session. */
    reader_context: {
      first_language: (S.responses.find(r => r.item === "first_language") || {}).value ?? null,
      medium_of_instruction: answers.ctx_medium ?? null,
      english_reading_comfort: answers.ctx_eng ?? null,
      vision_correction: answers.ctx_glasses ?? null,
      // true only when the student is reading as they normally would
      corrected_as_usual: answers.ctx_glasses === "yes_on" || answers.ctx_glasses === "no",
      uncorrected_flag: answers.ctx_glasses === "yes_off",
      vision_last_checked: answers.ctx_eyetest ?? null,
      time_of_day: answers.ctx_when ?? null,
      today: answers.ctx_today || []
    },
    /* The whole adaptation judged at once, which no other screen asks. */
    acceptability: {
      child_prefers: answers.showcase_pref ?? null,
      educator_would_use: answers.showcase_use ?? null
    },
    weights: (() => {
      const raw2 = { T:answers.W_T_2, V:answers.W_V_2, W:answers.W_W_2, D:answers.W_D_2 };
      const sum2 = ["T","V","W","D"].reduce((a, k) => a + (+raw2[k] || 0), 0);
      const norm2 = {}; ["T","V","W","D"].forEach(k => norm2[k] = sum2 ? +((+raw2[k] || 0) / sum2).toFixed(4) : null);
      const both = sum === 100 && sum2 === 100;
      // Mean absolute difference between the two allocations, in points. Small
      // means the weighting is stable enough to use for this student alone.
      const mad = both ? +(["T","V","W","D"].reduce((a, k) => a + Math.abs((+raw[k] || 0) - (+raw2[k] || 0)), 0) / 4).toFixed(2) : null;
      return { raw_100: raw, normalised: norm,
        vector_TVWD: ["T","V","W","D"].map(k => norm[k]),
        total_allocated: sum,
        repeat_raw_100: raw2, repeat_normalised: norm2, repeat_total: sum2,
        mean_abs_diff_points: mad,
        stable: mad === null ? null : mad <= 10,
        note: "The repeat was collected at the end of the session without showing the first answer back. mean_abs_diff_points is the within-session test-retest for this child's weight vector; treat a large value as a reason to pool rather than personalise." };
    })(),
    /* ------------------------------------------------------ calibration set
       One row per rated stimulus: the rating, and the features of the thing
       that was rated, measured while it was on screen. This is what makes the
       CLS weight-fitting reproducible without anyone hand-coding what each
       mock page contained. Pooled across participants it is a small but real
       training set: rating ~ T + V + W + D + (1|child).

       Honest limitation, carried in the object so it cannot be overlooked:
       the W features barely vary across these stimuli. Every mock page is
       rendered at the same size and contrast, so the only W variation comes
       from the two reading screens (plain settings versus the student's own).
       The visibility weight is therefore the least identifiable of the four
       from this set. */
    calibration_set: (() => {
      const rows = S.responses
        .filter(r => r.features && (r.item === "child_feeling" || r.item === "page_feeling" ||
                                    r.item === "text_feeling"))
        .map(r => ({ child_id:S.child_id, stimulus_id:r.stimulus_id, kind:r.item,
                     rating:r.value, scale:"three_face_0_2", features:r.features }));
      S.responses.filter(r => r.block === "gaze_reading" && r.features).forEach(r =>
        rows.push({ child_id:S.child_id, stimulus_id:r.stimulus_id, kind:"read_felt_load",
                    rating:r.felt_load, scale:"three_face_0_2", features:r.features }));
      // Range of the key feature per dimension, for transparency.
      const span = k => { const v = rows.map(x => x.features && x.features[k])
          .filter(x => typeof x === "number");
        return v.length ? { min:+Math.min.apply(null, v).toFixed(3), max:+Math.max.apply(null, v).toFixed(3),
                            n_levels:new Set(v).size } : null; };

      /* Which dimensions this stimulus set actually MANIPULATES is a fact
         about how the instrument was built, not something to infer from the
         numbers. Inferring it goes wrong: adding the word "ADVERT" to a mock
         page shifts its words-per-sentence slightly, so T appears to take a
         dozen "levels" when the only designed text contrast is the dense and
         plain pair. Declaring the design avoids reading nuisance variation as
         manipulation. */
      const designed = {
        T: ["text_dense", "text_plain"],
        V: ["layout_busy", "layout_calm"].concat(rows.filter(r => /^dis_/.test(r.stimulus_id)).map(r => r.stimulus_id)),
        W: ["read_baseline", "read_adapted"],
        D: ["layout_busy", "layout_calm"].concat(rows.filter(r => /^dis_/.test(r.stimulus_id)).map(r => r.stimulus_id))
      };
      const present = id => rows.some(r => r.stimulus_id === id);
      const designedPresent = {}; Object.keys(designed).forEach(k =>
        designedPresent[k] = designed[k].filter(present));

      return {
        rows: rows,
        n_stimuli: rows.length,
        measured_range: {
          T: span("t_mean_words_per_sentence"),
          V: span("v_elements_per_10k_px2"),
          W: span("w_contrast_ratio"),
          D: span("d_distractor_count")
        },
        designed_contrasts: designedPresent,
        // Fewer than three manipulated stimuli means a direction, not a slope.
        weakly_identified: Object.keys(designedPresent).filter(k => designedPresent[k].length < 3),
        note: "Each row pairs a three-face rating with features measured from the rendered stimulus at rating time. Fit rating ~ T + V + W + D with a per-child random effect. Read designed_contrasts before measured_range: only the listed stimuli manipulate that dimension, and any other spread is incidental (an added advert changes a word count without being a text manipulation). Dimensions in weakly_identified rest on a single two-level contrast, and W is additionally confounded with the student's own chosen settings, so both should be reported as a direction rather than a coefficient."
      };
    })(),
    gaze_zones: gazeZones(),
    gaze_accuracy: GAZE.validation,
    priorities: answers.pri || null,
    glide_profile: profile,
    quality: {
      tie_count: ties,
      top_side_bias: decided.length ? +(topChosen / decided.length).toFixed(3) : null,
      retest_agrees: re ? !!re.agrees : null,
      median_latency_ms: lat.length ? lat[Math.floor(lat.length / 2)] : 0,
      educator_confidence: answers.ed_genuine ?? null,
      prompting_required: answers.ed_prompt ?? null,
      ended_early: S.ended_early,
      withdrawn: S.withdrawn,
      withdraw_reason: S.withdraw_reason,
      total_responses: S.responses.length,
      session_minutes: +((performance.now() - SESSION_T0) / 60000).toFixed(1),
      recovered_from_backup: !!S.recovered,
      items_skipped: Object.keys(skipped),
      uncorrected_vision: answers.ctx_glasses === "yes_off",
      english_is_first_language: ((S.responses.find(r => r.item === "first_language") || {}).value === "English") || null,
      recall_collected: !!(rb && ra),
      items_skipped_count: Object.keys(skipped).length,
      // These silently invalidate whole blocks if they go wrong, so they
      // travel with the data rather than living only in a console nobody read.
      font_health: FONTHEALTH.report(),
      fonts_ok: FONTHEALTH.ok(),
      reduced_motion: MOTION.reduced(),
      motion_degraded_distractors: MOTION.affected(),
      gaze_health: GAZE.health(),
      gaze_health_reason: GAZE.healthReason,
      gaze_calibrated: GAZE.calibrated,
      gaze_points_done: S._calib ? S._calib.done : null,
      gaze_validation: GAZE.validation,
      evidence_grade: ascertainment.evidence_grade,
      counts_as_documented_nd: ascertainment.counts_as_documented_nd,
      weights_total: sum,
      // Weights are an educator-session item; absent in a child session is
      // expected, not invalid.
      weights_valid: isChild() ? null : sum === 100,
      v5: v5Quality()
    },
    physical: Object.assign({}, S.physical, { distance_used: viewingDistanceCm(), pixel_pitch_used: cssPxPerCm() }),
    consent: S.consent
  };
}

function out() {
  if (!S.completed_at) S.completed_at = new Date().toISOString();
  S.derived = derive(); S.final_parameters = Object.assign({}, P); S.orders = ORDER;
  S.clock = CLOCK.describe(); S.video_segments = REC.segments; S.video.camera_at_end = CAM.settingsNow();
  S.streams = streamCounts(); S.protocol = PROTOCOL; S.link_status = { joined: S.link.joined, configured: LINK.configured() };
  return S;
}

function csv(cols, rows) {
  const esc = v => { if (v === null || v === undefined) return ""; const s = typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [cols.join(",")].concat(rows.map(r => cols.map(c => esc(r[c])).join(","))).join("\n");
}
function saveBlob(text, type, name) {
  const blob = new Blob([text], { type });
  const a = el("a", { href:URL.createObjectURL(blob), download:name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  S._saved = true;
}
function dl(kind) {
  const o = out();
  const stamp = `${S.mode || "session"}_${S.child_id || "anon"}_${S.session_id}`;

  if (kind === "json")
    return saveBlob(JSON.stringify(o, null, 2), "application/json", `glide_${stamp}.json`);

  if (kind === "profile")
    return saveBlob(JSON.stringify(o.derived.glide_profile, null, 2), "application/json", `glide_profile_${S.child_id || "anon"}_${S.mode}.json`);

  if (kind === "pairs") {
    const cols = ["child_id","dimension","item_a","item_b","winner","loser","tie","winner_position","latency_ms","stimulus_hash_a","stimulus_hash_b","ts"];
    return saveBlob(csv(cols, o.derived.pairwise_long), "text/csv", `glide_pairs_${stamp}.csv`);
  }

  if (kind === "zones") {
    const cols = ["child_id","screen","block","distractor_id","settings","passage","zone_id","x","y","w","h",
      "samples","share","dwell_ms","visits","first_entry_ms",
      "validation_error_px","validation_error_deg","zone_separation_px","separation_exceeds_error","interpretable"];
    return saveBlob(csv(cols, o.derived.gaze_zones), "text/csv", `glide_zones_${stamp}.csv`);
  }

  const cols = ["child_id","educator_id","session_id","mode","instrument_version","block","item","value","labels",
    "winner","loser","tie","comparison","distractor_id","page","variant","adaptation",
    "felt_load","passage","settings","gaze_usable","gaze_samples","duration_ms","outside_share",
    "latency_ms","session_elapsed_ms","ts","stimulus_hash"];
  const rows = S.responses.map(r => Object.assign({}, r, {
    child_id:S.child_id, educator_id:S.educator_id, session_id:S.session_id,
    mode:S.mode, instrument_version:INSTRUMENT_VERSION
  }));
  saveBlob(csv(cols, rows), "text/csv", `glide_${stamp}.csv`);
}

/* =========================================================================
   KEYBOARD
   -------------------------------------------------------------------------
   An educator usually has one hand on the student's page and is recording a
   choice the student made by pointing. Number keys answer, arrows navigate.
   Bindings are rebuilt per screen and cleared on every paint so a key can
   never fire a stale handler from a screen that is no longer on display.
   ========================================================================= */
const KEYS = (function () {
  let map = {};
  addEventListener("keydown", e => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || "").toUpperCase())) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // v5.1: with the portal in control, the child's keyboard does nothing.
    if (document.body.classList.contains("remote")) { e.preventDefault(); return; }
    if (document.body.classList.contains("focus") && e.key === "Escape") { S._focusOff = true; paint(); e.preventDefault(); return; }
    if ($("#imodal").classList.contains("on")) {
      if (e.key === "Escape") { $("#imodal").classList.remove("on"); e.preventDefault(); }
      return;
    }
    if (map[e.key]) { map[e.key](); e.preventDefault(); return; }
    if (e.key === "ArrowRight" || e.key === "Enter") { if (!$("#next").disabled && !$("#next").classList.contains("hide")) { go(1); e.preventDefault(); } }
    if (e.key === "ArrowLeft") { if (!$("#back").disabled) { go(-1); e.preventDefault(); } }
  });
  function press(k) {
    if (map[k]) { map[k](); return; }
    if (k === "ArrowRight" || k === "Enter") { if (!$("#next").disabled && !$("#next").classList.contains("hide")) go(1); }
    if (k === "ArrowLeft") { if (!$("#back").disabled) go(-1); }
  }
  return { set(m) { map = m || {}; }, clear() { map = {}; }, press };
})();

/* =========================================================================
   LOCAL RECOVERY
   -------------------------------------------------------------------------
   A session with a child cannot simply be re-run: the student has given their
   time, the comparisons are no longer naive, and the educator may not get a
   second slot. A backup was already being written on every screen change in
   earlier versions but nothing ever offered it back, which made it decoration.
   It is now offered on load and can be resumed.
   ========================================================================= */
const BACKUP_KEY = "glide_backup";
const CODES_KEY = "glide_codes_seen";
function saveBackup() {
  if (S.mode === "training") return;
  try {
    localStorage.setItem(BACKUP_KEY, JSON.stringify({
      v: SCHEMA_VERSION, when: new Date().toISOString(),
      // Both the index AND the screen id. The index alone is not safe to
      // restore: visible() is computed from conditions that can differ on the
      // machine doing the reload (a typeface that is present here and missing
      // there, reduced motion, a declined camera), which shortens the list and
      // silently lands the resume on a different question. The id is stable;
      // the pinning map is saved too so the list reconstructs as it was.
      idx, screen_id: (visible()[idx] || {}).id || null, shown: Object.keys(shown),
      skipped: Object.keys(skipped),
      answers, ORDER, P, responses: S.responses,
      child_id: S.child_id, educator_id: S.educator_id, mode: S.mode,
      capacity: S.capacity, session_id: S.session_id, seed: S.seed,
      gaze_off: S.gaze_off, calib: S._calib, val: S._val, validation: GAZE.validation,
      // v5
      v5: { link: S.link, consent: S.consent, video: S.video, physical: S.physical, framing: S.framing, drift: S.drift,
        calibration_attempts: S.calibration_attempts, breaks: S.breaks, validations: S.validations || [],
        preview: S.preview || null, remote: S.remote || null, cal_auto: !!S._calAuto,
        started_at: S.started_at, session_time_origin_ms: CLOCK.origin, clock_epochs: CLOCK.epochs,
        segments: REC.segments, frame_index: FRAMES.current(), cam_setup: S._camSetup || null, started: !!S._started, bs: S._bs || null, drift_state: S._drift || null }
    }));
  } catch (e) {}
}
function readBackup() {
  try {
    const raw = localStorage.getItem(BACKUP_KEY);
    if (!raw) return null;
    const b = JSON.parse(raw);
    if (!b || b.v !== SCHEMA_VERSION || !b.mode) return null;
    if (!b.responses || b.responses.length < 2) return null;   // nothing worth restoring
    return b;
  } catch (e) { return null; }
}
function restoreBackup(b) {
  answers = b.answers || {}; ORDER = b.ORDER || {};
  (b.shown || []).forEach(id => { shown[id] = true; });
  (b.skipped || []).forEach(id => { skipped[id] = true; });
  Object.assign(P, b.P || {});
  S.responses = b.responses || []; S.child_id = b.child_id || ""; S.educator_id = b.educator_id || "";
  S.mode = b.mode; S.capacity = b.capacity; S.session_id = b.session_id || S.session_id;
  S.seed = b.seed || S.seed; S.gaze_off = b.gaze_off; S._calib = b.calib; S._val = b.val || { i:0, pts:[] };
  S.recovered = true; S.recovered_from = b.when;
  GAZE.validation = b.validation || null;
  GAZE.calibrated = !!(b.calib && b.calib.done >= 9);
  const v = b.v5 || {};
  ["link","consent","video","physical","framing","drift","breaks","validations","preview","remote"].forEach(k => { if (v[k] !== undefined && v[k] !== null) S[k] = v[k]; });
  S._calAuto = !!v.cal_auto;
  S.calibration_attempts = v.calibration_attempts || 0;
  if (v.started_at) S.started_at = v.started_at;
  if (v.session_time_origin_ms) CLOCK.resume(v.session_time_origin_ms, v.clock_epochs);
  S._camSetup = v.cam_setup; S._bs = v.bs; S._drift = v.drift_state;
  S._resumeSegments = v.segments || [];

  /* The gaze model does not survive a reload (nothing is carried between
     page loads by design). Gaze is therefore switched off after a resume;
     with video on, the calibration table still allows offline re-analysis. */
  if (GAZE.calibrated || GAZE.consent === "granted" || answers.gaze_ok === "yes") {
    if (!S.gaze_off) { S.gaze_off = true; S.gaze_off_reason = "reload_lost_gaze_model"; }
    GAZE.calibrated = false;
  }
  RNG = mulberry32(S.seed);
  // Resolve the position by id, falling back to the saved index only if that
  // screen no longer exists at all.
  const byId = b.screen_id ? visible().findIndex(s => s.id === b.screen_id) : -1;
  idx = byId >= 0 ? byId : Math.min(b.idx || 0, Math.max(0, visible().length - 1));
  document.body.classList.toggle("child", S.mode === "child");
  MOTION.apply();
  log("admin", "recovered_from_backup", true,
    { saved_at: b.when, resumed_at: b.screen_id, resumed_at_index: idx,
      resolved_by: byId >= 0 ? "screen_id" : "index_fallback", clock_epochs: CLOCK.epochs.length, gaze_off_reason: S.gaze_off_reason || null });
}
/* v5 resume, after the synchronous restore: rows back from IndexedDB, an
   interrupted video part salvaged, the camera and recording restarted. */
async function resumeV5() {
  if (S.mode === "training") return;
  S._started = false;
  const n = await STREAMS.restore(S.session_id);
  // Frame numbering continues after the highest frame already on disk.
  FRAMES.setBase(STREAMS.rows("frames").reduce((m, r) => Math.max(m, r.frame_index || 0), 0));
  try { const st = await IDB.get("meta", S.session_id + "|stimuli"); if (st && st.stimuli) Object.assign(STIMULI, st.stimuli); } catch (e) {}
  await sessionStarted();
  const salvaged = await REC.salvage(S.session_id, S._resumeSegments || []);
  EV.log("session_resumed", { rows_batches_restored: n, video_parts_salvaged: salvaged });
  if (S.link.joined) { try { REMOTE.start(); } catch (e) {} }
  if (S.video.consented && !S.video.deleted && S._camSetup === "open") {
    const ok = await CAM.open();
    if (ok) { await REC.start(S.session_id, "resume_after_reload"); await SYNC.flash("recording_resume"); }
    try { GAZE.init(); } catch (e) {}
    log("camera", "camera_resumed", ok, { camera: CAM.info() });
  }
  paint();
}
/* A child code reused for a different student cannot be untangled afterwards,
   so a re-use is flagged at setup while it is still free to fix. */
function rememberCode() {
  if (!S.child_id) return;
  try {
    const all = JSON.parse(localStorage.getItem(CODES_KEY) || "{}");
    all[S.child_id] = all[S.child_id] || [];
    all[S.child_id].push({ mode: S.mode, when: new Date().toISOString() });
    localStorage.setItem(CODES_KEY, JSON.stringify(all));
  } catch (e) {}
}
function checkDuplicate() {
  S._dupe = null;
  if (!S.child_id) return;
  try {
    const all = JSON.parse(localStorage.getItem(CODES_KEY) || "{}");
    const hits = (all[S.child_id] || []).filter(h => h.mode === answers.mode);
    if (hits.length) {
      const last = hits[hits.length - 1];
      S._dupe = { mode: last.mode, when: new Date(last.when).toLocaleDateString() };
    }
  } catch (e) {}
}

/* -------------------------------------------------------------- routing */
/* Routing is by index into a list that skipIf() can change at any time, and
   several conditions genuinely do change mid-session (consent is recorded, a
   camera turns out unusable, a typeface fails). If a screen the participant
   has already passed drops out of the list, every later index shifts down by
   one and the router silently steps over the next screen. Once shown, a screen
   is therefore pinned: it stays in the list for the rest of the session
   whatever its skipIf now says. Screens ahead of the cursor are still filtered
   normally, which is where skipIf is actually wanted. */
const shown = Object.create(null);
function visible() { return SCREENS.filter(s => shown[s.id] || !(s.skipIf && s.skipIf())); }
function paint() {
  const list = visible(), s = list[idx];
  if (!s) return;
  shown[s.id] = true;
  CUR_SCREEN = { id: s.id, block: s.block || null };
  KEYS.clear();
  try { setBar(s.bar === "off" ? "off" : "on"); } catch (e) {}
  try { if (s.stageFn) s.stageFn(); else stage(null); }
  catch (e) { console.warn(e); stage(el("div", { class:"notice bad", text:"This could not be displayed. Tell the researcher, then press Next." })); }
  const p = $("#panel"); p.innerHTML = "";
  const ikey = s.info || (s.id && INFO[s.id] ? s.id : (s.id ? s.id.split("_")[0] : null));
  const ib = ikey ? infoBar(ikey) : null;
  if (ib) p.appendChild(ib);
  if (S._adminMsg && Date.now() - S._adminMsg.at < 120000)
    p.appendChild(el("div", { class:"notice", html:"<strong>Message from the admin device:</strong> " + String(S._adminMsg.text).replace(/</g, "&lt;") }));
  try { p.appendChild(s.panel()); } catch (e) { console.warn(e); p.appendChild(el("div", { class:"notice bad", text:"This question could not be displayed." })); }
  if (skippable(s)) {
    p.appendChild(el("button", { class:"speak", style:"margin-top:14px",
      text: skipped[s.id] ? "Skipped \u2014 press Next" : "Skip this question",
      title:"Records that this item was skipped and moves on",
      onclick: () => skipScreen() }));
  }
  p.scrollTop = 0;
  $("#ptxt").textContent = `${idx + 1} / ${list.length}`;
  $("#pbar").style.width = ((idx + 1) / list.length * 100) + "%";
  $("#back").disabled = idx === 0;
  $("#next").classList.toggle("hide", !!s.last);
  $("#stop").classList.toggle("hide", !(S.mode === "child" && !s.last && S._started));
  validate();
  // v5.1: dots full screen (no educator panel beside them) while targets remain
  document.body.classList.toggle("focus", !!(s.focus && s.focus() && !S._focusOff));
  try { REMOTE.afterPaint(); } catch (e) {}
  try { PREVIEW.paintButton(); } catch (e) {}
  announce("Screen " + (idx + 1) + " of " + list.length);
}
/* Annexure 2 (2.2) and the educator briefing both tell the student that no
   item is mandatory and anything may be skipped. Enforcing an answer on every
   screen would have made that promise false. Skipping is therefore a real
   action with a real record: the screen is marked, the skip is logged, and the
   missing answer is visible in analysis instead of being indistinguishable
   from a question that was never reached.
   Consent and eligibility gates are deliberately NOT skippable: those are not
   items asked of the student, they are the conditions for collecting anything
   at all. */
const NO_SKIP = /^(connect|mode|ascertain|assent|gaze_consent|video_consent|cam_setup|done|training_)/;
const skipped = Object.create(null);
function skippable(s) { return s && s.id && !NO_SKIP.test(s.id) && !s.last; }
function skipScreen() {
  const s = visible()[idx];
  if (!skippable(s)) return;
  skipped[s.id] = true;
  log(s.block || "admin", "item_skipped", s.id, { skipped: true });
  go(1);
}
function validate() {
  const s = visible()[idx];
  const need = s && s.valid ? !s.valid() : false;
  $("#next").disabled = need && !skipped[s.id];
}
/* v5: every screen change is an event on the shared clock, the stimulus
   onset is stamped in the next animation frame, and the recorder is told the
   block so it can start a new video part at a block boundary. */
function leaving(s) {
  try { FRAMING.stop(); } catch (e) {}
  const hv = HOVER.snapshot();
  if (Object.keys(hv).length) EV.log("hover_dwell", { screen: s.id, items: hv });
  EV.log("screen_leave", { screen: s.id });
}
function entering(n, how) {
  CUR_SCREEN = { id: n.id, block: n.block || null };
  S._focusOff = false;
  HOVER.reset();
  EV.log("screen_enter", { screen: n.id, index: idx + 1, how });
  try { REC.onScreen(n.block || null); } catch (e) {}
  if (n.enter) { try { n.enter(); } catch (e) { console.warn(e); } }
  screenEnter = performance.now();
  paint();
  onStimulusOnset(n);
  saveBackup();
}
function go(d) {
  const list = visible(), s = list[idx];
  if (d > 0 && s.onLeave) { try { s.onLeave(); } catch (e) { console.warn(e); } }
  leaving(s);
  stopSpeak();
  const target = d > 0 && s.next ? s.next() : null;
  if (target) { const j = visible().findIndex(x => x.id === target); if (j >= 0) { idx = j; entering(visible()[idx], "return"); return; } }
  idx = Math.max(0, Math.min(list.length - 1, idx + d));
  entering(visible()[idx], d > 0 ? "next" : "back");
}
$("#next").addEventListener("click", () => go(1));
$("#back").addEventListener("click", () => go(-1));
function jumpTo(id) {
  const list = visible();
  const i = list.findIndex(s => s.id === id);
  if (i < 0) { go(1); return; }
  leaving(list[idx]);
  stopSpeak();
  idx = i;
  entering(list[i], "jump");
}

/* Stopping early and withdrawing are different acts and the data has to be
   able to tell them apart: an early stop is a session that ended, a withdrawal
   is a session that must not be used. Deleting the files by hand would leave
   no record that either happened. */
$("#stop").addEventListener("click", () => {
  const why = prompt("Ending the session early is completely fine.\n\nBriefly, why? (tired / distressed / distracted / out of time / other)\n\nIf the student or guardian is WITHDRAWING from the study, type the word: withdraw");
  if (why === null) return;
  if (/^\s*withdraw\s*$/i.test(why)) {
    const r = prompt("Marking this session as withdrawn. It will still be saved, with the withdrawal recorded inside, so the researcher can show it was excluded rather than lost.\n\nReason (optional):");
    // v5: video is a separate choice. Responses can be kept while the video goes.
    let del = false;
    if (S.video.consented || REC.segments.length)
      del = confirm("Recording stops now.\n\nShould the VIDEO also be deleted?\n\nOK  =  keep the answers, DELETE the video (from this laptop and from Drive)\nCancel  =  keep both, marked as withdrawn");
    withdrawSession(r || "not given", del, "participant_laptop");
  } else {
    endEarly(why || "not given", "participant_laptop");
  }
});

// Closing the page before saving loses the session; the backup survives but
// the files do not exist yet, so warn while there is still something to lose.
addEventListener("beforeunload", e => {
  if (S.mode && S.mode !== "training" && S.responses.length > 2 && !S._saved) { e.preventDefault(); e.returnValue = ""; }
});

/* ------------------------------------------------------------------ boot */
let booted = false;
function boot() {
  if (booted) return; booted = true;
  FONTHEALTH.check();
  MOTION.apply();
  readEnv();
  S.seed = Math.floor(Math.random() * 1e9);
  RNG = mulberry32(S.seed);
  screenEnter = performance.now();
  SESSION_T0 = performance.now();

  const b = readBackup();
  if (b) {
    const when = new Date(b.when);
    const mins = Math.round((Date.now() - when.getTime()) / 60000);
    const msg = "An unfinished " + b.mode + " session for child code “" + (b.child_id || "?") + "” was found on this computer,\n" +
      "last saved " + (mins < 90 ? mins + " minutes" : Math.round(mins / 60) + " hours") + " ago, with " + b.responses.length + " answers already recorded.\n\n" +
      "OK  =  carry on with that session\nCancel  =  discard it and start fresh";
    if (confirm(msg)) {
      restoreBackup(b);
      paint();
      resumeV5();
      return;
    }
    try { localStorage.removeItem(BACKUP_KEY); } catch (e) {}
  }
  paint();
}
// Fonts must be resolved before the first paint, otherwise the health check
// races the loader and reports a false failure on a perfectly good build.
FONTHEALTH.ready().then(boot).catch(boot);
setTimeout(boot, 3000);

