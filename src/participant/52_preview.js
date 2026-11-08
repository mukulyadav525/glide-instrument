/* =========================================================================
   v5.1 · CAMERA PREVIEW ON THE PARTICIPANT SCREEN
   -------------------------------------------------------------------------
   A small mirrored picture of the camera, with the framing oval and the face
   box drawn on it, in the bottom-left corner of the laptop screen. Three
   modes, chosen by the educator (portal or laptop footer):

     off    never shown (the framing screens still show their large preview)
     auto   shown only while the face is out of frame or lost, for long
            enough to matter (1.5 s), and hidden again 1.5 s after the face is
            back. The child sees themselves only when they have already left
            the frame, which is when seeing it helps them come back.
     on     always shown while the camera is on

   A child watching their own face is a distractor in a study about
   distraction, so every show and hide is an event on the shared clock
   (preview_shown / preview_hidden, with the reason) and the total time shown
   per screen is in session.json. Analysis can drop or flag those stretches.
   ========================================================================= */
const PREVIEW = (function () {
  const KEY = "glide_preview_mode";
  let mode = "auto";
  try { const m = localStorage.getItem(KEY); if (m === "off" || m === "auto" || m === "on") mode = m; } catch (e) {}
  let box = null, vid = null, cv = null, shown = false, shownAt = 0, badSince = null, goodSince = null, timer = null;
  const SUPPRESS = /^(framing|framing2|done)$/;          // framing screens have their own large preview
  function build() {
    if (box) return;
    box = document.createElement("div"); box.id = "pip"; box.setAttribute("aria-hidden", "true");
    vid = document.createElement("video"); vid.muted = true; vid.playsInline = true; vid.autoplay = true;
    cv = document.createElement("canvas");
    box.appendChild(vid); box.appendChild(cv); document.body.appendChild(box);
  }
  function bad(f, fr) {
    if (!f || CLOCK.t() - f.t_perf > 1500 || !f.face_detected) return "face_lost";
    const c = fr && fr.checks ? fr.checks : {};
    if (c.centred && c.centred.g === "r") return "face_off_centre";
    if (c.distance && c.distance.g === "r") return "distance";
    return null;
  }
  function show(reason) {
    if (shown) return; build();
    if (vid.srcObject !== CAM.stream) { vid.srcObject = CAM.stream; try { vid.play(); } catch (e) {} }
    box.classList.add("on"); shown = true; shownAt = CLOCK.t();
    EV.log("preview_shown", { mode, reason, screen: CUR_SCREEN.id });
  }
  function hide(reason) {
    if (!shown) return;
    box.classList.remove("on"); shown = false;
    const ms = Math.round(CLOCK.t() - shownAt);
    S.preview = S.preview || { mode_changes: [], shown_ms_by_screen: {} };
    S.preview.shown_ms_by_screen[CUR_SCREEN.id] = (S.preview.shown_ms_by_screen[CUR_SCREEN.id] || 0) + ms;
    EV.log("preview_hidden", { mode, reason, shown_ms: ms, screen: CUR_SCREEN.id });
  }
  function tick() {
    const live = CAM.live() && !CAM.lost();
    const f = FACEQ.latest();
    if (!live || !f || SUPPRESS.test(CUR_SCREEN.id || "") || S.mode === "training") { hide(!live ? "camera_off" : "screen"); return; }
    let fr = null; try { fr = FRAMING.evaluate(); } catch (e) {}
    if (mode === "off") { hide("mode_off"); }
    else if (mode === "on") { show("mode_on"); }
    else {
      const now = performance.now(), why = bad(f, fr);
      if (why) { goodSince = null; badSince = badSince || now; if (now - badSince > 1500) show(why); }
      else { badSince = null; goodSince = goodSince || now; if (now - goodSince > 1500) hide("face_back"); }
    }
    if (shown) drawFaceOverlay(cv, f, { pass: fr && fr.pass, pts: FACEQ.points(), age_ms: CLOCK.t() - f.t_perf });
  }
  return {
    mode: () => mode,
    shown: () => shown,
    setMode(m, source) {
      if (!/^(off|auto|on)$/.test(m) || m === mode) return;
      mode = m; try { localStorage.setItem(KEY, m); } catch (e) {}
      S.preview = S.preview || { mode_changes: [], shown_ms_by_screen: {} };
      S.preview.mode_changes.push({ mode: m, source: source || "laptop", t_perf: CLOCK.t(), screen: CUR_SCREEN.id });
      EV.log("preview_mode", { mode: m, source: source || "laptop" });
      tick(); PREVIEW.paintButton();
    },
    start() { if (!timer) timer = setInterval(() => { try { tick(); } catch (e) {} }, 250); },
    paintButton() {
      const b = document.getElementById("pvbtn"); if (!b) return;
      b.classList.toggle("hide", !CAM.live() || S.mode === "training");
      b.textContent = "Camera preview: " + ({ off: "off", auto: "auto", on: "on" })[mode];
    }
  };
})();
PREVIEW.start();
document.getElementById("pvbtn").addEventListener("click", () => {
  PREVIEW.setMode({ off: "auto", auto: "on", on: "off" }[PREVIEW.mode()], "laptop");
});
setInterval(() => { try { PREVIEW.paintButton(); } catch (e) {} }, 1000);
