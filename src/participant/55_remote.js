/* =========================================================================
   v5.1 · EDUCATOR PORTAL LINK (participant side)
   -------------------------------------------------------------------------
   With the educator portal (educator.html) open on a second device, the
   participant laptop shows ONLY what the child should see: the two things
   to compare, the reading passages, the dots. Every educator control (the
   question, "top one / bottom one / the same", Next, Back, Stop, the
   framing checks) appears on the portal instead, next to a live view of the
   camera with the framing oval drawn on it.

   How it works. The instrument keeps running here, exactly as before: every
   screen still renders its educator panel, only now that panel is hidden on
   the laptop and mirrored to the portal. A click or keystroke on the portal
   comes back as an action on the same element here, so every existing
   screen works remotely without being rewritten, and every response is still
   logged on this laptop's clock.

   Transport. A direct WebRTC connection between the two devices: one data
   channel for the panel and actions (tens of milliseconds, not the seconds a
   round trip through Apps Script takes), and one video track, a 640x480
   15 fps copy of the camera, the same frame the face model sees. Nothing is
   recorded on the portal. The study backend only passes the two connection
   offers between the devices (op "signal"); no video goes through it.

   If the portal disconnects, the laptop keeps the child view and shows a
   small banner; Ctrl+Shift+E brings the controls back onto the laptop at
   any time. Without a portal, nothing changes: the laptop works as before.
   ========================================================================= */
const REMOTE = (function () {
  const ICE = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];
  let pc = null, dc = null, pending = null, handledHello = null, pollT = null, started = false;
  let open = false, local = false, sendTrack = null, sender = null, obs = null, snapT = null, faceT = null, lastHtml = null;
  let lostAt = null, connects = 0, actions = 0, startedAt = Date.now(), hereAt = 0;
  /* v5.2 · PAIRING CODE. Every laptop shows a 5-character code from its very
     first screen. The educator types it into the portal (or opens the admin
     console's portal link, which finds the laptop once it has joined the
     session), so the portal can run the whole session, setup included, and
     works for offline sessions too. The code stays the same across reloads. */
  const PAIR_KEY = "glide_pair", ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let pair = null;
  try { pair = localStorage.getItem(PAIR_KEY); } catch (e) {}
  if (!/^[A-Z0-9]{5}$/.test(pair || "")) {
    pair = ""; const r = new Uint32Array(5); crypto.getRandomValues(r);
    for (let i = 0; i < 5; i++) pair += ALPHA[r[i] % ALPHA.length];
    try { localStorage.setItem(PAIR_KEY, pair); } catch (e) {}
  }

  const isOpen = () => !!(dc && dc.readyState === "open");
  function controlling() { return open && !local; }
  function applyBody() {
    document.body.classList.toggle("remote", controlling());
    const b = document.getElementById("rbanner");
    if (b) {
      const lost = !open && connects > 0 && !local;
      b.classList.toggle("on", lost);
      b.textContent = lost ? "Educator portal disconnected, reconnecting… (Ctrl+Shift+E shows the controls on this laptop)" : "";
    }
  }
  function send(o) { if (!isOpen()) return false; try { dc.send(JSON.stringify(o)); return true; } catch (e) { return false; } }

  /* ------------------------------------------------------------ signalling */
  async function poll() {
    pollT = null;
    if (!LINK.configured()) return schedule(5000);
    try {
      // Say "this laptop is here" (so the portal can confirm the code), at most every 4 minutes, never over a pending offer.
      if (!isOpen() && !(pending && !pending.answered) && Date.now() - hereAt > 240000) {
        await LINK.call("signal", { pair, role: "laptop", put: { type: "here", id: "" } }, 10000); hereAt = Date.now();
      }
      const j = await LINK.call("signal", { pair, get: "educator" }, 10000);
      const m = j.msg;
      if (m && m.type === "hello" && m.id && m.id !== handledHello) { handledHello = m.id; await offer(m.id); }
      else if (m && m.type === "answer" && pending && m.id === pending.id && !pending.answered) {
        pending.answered = true;
        try { await pc.setRemoteDescription({ type: "answer", sdp: m.sdp }); EV.log("educator_portal_answer", { id: m.id }); }
        catch (e) { EV.log("educator_portal_error", { step: "answer", error: String(e && e.message || e) }); }
      }
    } catch (e) {}
    // Fast while a connection is being made; slower once connected, or when
    // no portal has appeared after two minutes (most sessions may not use one).
    schedule(isOpen() ? 15000 : (pending && !pending.answered) ? 1500 : (Date.now() - startedAt < 120000 || connects > 0) ? 3000 : 8000);
  }
  function schedule(ms) { clearTimeout(pollT); pollT = setTimeout(poll, ms); }

  function closePc() {
    try { if (dc) dc.close(); } catch (e) {}
    try { if (pc) pc.close(); } catch (e) {}
    pc = null; dc = null; sender = null; open = false;
  }
  async function offer(id) {
    closePc();
    pc = new RTCPeerConnection({ iceServers: ICE });
    dc = pc.createDataChannel("glide", { ordered: true });
    wire(dc);
    sender = pc.addTransceiver("video", { direction: "sendonly" }).sender;
    attachCamera(true);
    pc.addEventListener("connectionstatechange", () => {
      const st = pc && pc.connectionState;
      EV.log("educator_portal_state", { state: st });
      if (st === "failed" || st === "closed") { open = false; lostAt = lostAt || Date.now(); applyBody(); }
    });
    pending = { id, answered: false, at: Date.now() };
    const o = await pc.createOffer(); await pc.setLocalDescription(o);
    await new Promise(res => {
      if (pc.iceGatheringState === "complete") return res();
      pc.addEventListener("icegatheringstatechange", () => { if (pc && pc.iceGatheringState === "complete") res(); });
      setTimeout(res, 3000);
    });
    await LINK.call("signal", { pair, role: "laptop", put: { type: "offer", id, sdp: pc.localDescription.sdp } }, 15000);
    EV.log("educator_portal_offer", { id });
  }
  function wire(ch) {
    ch.addEventListener("open", () => {
      open = true; connects++; lostAt = null; pending = null; lastHtml = null;
      EV.log("educator_portal_connected", { connects });
      S.remote = S.remote || { connections: [], actions: 0 };
      S.remote.connections.push({ connected_t_perf: CLOCK.t() });
      applyBody(); sendAll();
      try { paint(); } catch (e) {}
    });
    ch.addEventListener("close", () => {
      if (!open) return;
      open = false; lostAt = Date.now();
      EV.log("educator_portal_disconnected", {});
      const c = S.remote && S.remote.connections[S.remote.connections.length - 1]; if (c) c.disconnected_t_perf = CLOCK.t();
      applyBody(); schedule(1000);
    });
    ch.addEventListener("message", e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } onMsg(m); });
  }

  /* --------------------------------------------------------------- camera */
  function attachCamera(force) {
    if (!sender) return;
    const want = CAM.live() && !CAM.lost() && S.remote_video !== false;
    if (want && (!sendTrack || sendTrack.readyState !== "live")) {
      try {
        sendTrack = CAM.stream.getVideoTracks()[0].clone();
        sendTrack.applyConstraints({ width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 15 }, resizeMode: "crop-and-scale" }).catch(() => {});
        sender.replaceTrack(sendTrack).catch(() => {});
        const p = sender.getParameters(); if (p.encodings && p.encodings[0]) { p.encodings[0].maxBitrate = 600000; sender.setParameters(p).catch(() => {}); }
        EV.log("educator_portal_video", { on: true });
      } catch (e) {}
    } else if (!want && sendTrack) {
      try { sender.replaceTrack(null); sendTrack.stop(); } catch (e) {}
      sendTrack = null; EV.log("educator_portal_video", { on: false });
    } else if (force && sendTrack) { sender.replaceTrack(sendTrack).catch(() => {}); }
  }

  /* --------------------------------------------------------------- mirror */
  function sig(n) { return n.tagName + "|" + (n.textContent || "").replace(/\s+/g, " ").trim().slice(0, 24); }
  function panelHtml() {
    const panel = document.getElementById("panel");
    const clone = panel.cloneNode(true);
    const live = panel.querySelectorAll("*"), cl = clone.querySelectorAll("*");
    for (let i = 0; i < live.length; i++) {
      const n = live[i], c = cl[i];
      c.setAttribute("data-rid", i);
      if (n.tagName === "INPUT") {
        if (n.type === "checkbox" || n.type === "radio") { if (n.checked) c.setAttribute("checked", ""); else c.removeAttribute("checked"); }
        else c.setAttribute("value", n.value);
      } else if (n.tagName === "TEXTAREA") c.textContent = n.value;
      else if (n.tagName === "SELECT") Array.from(c.options).forEach((o, k) => { if (n.options[k] && n.options[k].selected) o.setAttribute("selected", ""); else o.removeAttribute("selected"); });
      else if (n.tagName === "DETAILS") { if (n.open) c.setAttribute("open", ""); else c.removeAttribute("open"); }
      if (n.disabled) c.setAttribute("disabled", "");
    }
    return clone.innerHTML;
  }
  function footState() {
    const q = id => document.getElementById(id);
    return { back: { disabled: q("back").disabled }, next: { disabled: q("next").disabled, hidden: q("next").classList.contains("hide") },
      stop: { hidden: q("stop").classList.contains("hide") }, ptxt: q("ptxt").textContent, pct: q("pbar").style.width };
  }
  function screenInfo() {
    let list = [], s = {};
    try { list = visible(); s = list[idx] || {}; } catch (e) {}
    return { id: s.id || null, block: s.block || null, index: idx + 1, total: list.length, mode: S.mode,
      child_id: S.child_id, educator_id: S.educator_id, session_id: S.session_id, bar: (document.getElementById("bar") || {}).textContent || "",
      recording: REC.recording(), camera: CAM.live(), video_consented: S.video.consented, preview: PREVIEW.mode(),
      laptop_vw: innerWidth, laptop_vh: innerHeight, version: INSTRUMENT_VERSION };
  }
  function sendPanel(force) {
    if (!isOpen()) return;
    const html = panelHtml();
    const msg = { t: "panel", html, foot: footState(), screen: screenInfo() };
    const key = html + JSON.stringify(msg.foot) + msg.screen.id;
    if (!force && key === lastHtml) return;
    lastHtml = key;
    if (html.length > 240000) msg.html = "<div class='notice bad'>This screen is too large to mirror. Press Ctrl+Shift+E on the laptop to use it there.</div>";
    send(msg);
  }
  function queueSnap() { clearTimeout(snapT); snapT = setTimeout(() => sendPanel(false), 60); }
  function sendAll() { sendPanel(true); sendFace(); }

  /* Face, framing, gaze target and estimate, ~8 times a second. */
  function sendFace() {
    if (!isOpen()) return;
    attachCamera(false);
    const f = FACEQ.latest();
    let fr = null; try { fr = f ? FRAMING.evaluate() : null; } catch (e) {}
    let tgt = null; try { tgt = currentGazeTarget(); } catch (e) {}
    const g = GAZE.lastPred ? GAZE.lastPred() : null;
    send({ t: "face", f: f ? { face_detected: f.face_detected, box_x: f.box_x, box_y: f.box_y, box_w: f.box_w, box_h: f.box_h, img_w: f.img_w, img_h: f.img_h,
        yaw_deg: f.yaw_deg, pitch_deg: f.pitch_deg, roll_deg: f.roll_deg, ear_left: f.ear_left, ear_right: f.ear_right, eyes_closed: f.eyes_closed,
        interocular_px: f.interocular_px, distance_ratio: f.distance_ratio, face_brightness: f.face_brightness } : null,
      age_ms: f ? Math.round(CLOCK.t() - f.t_perf) : null, pts: FACEQ.points(), checks: fr ? fr.checks : null, pass: fr ? !!fr.pass : false,
      usable: FACEQ.usableNow ? FACEQ.usableNow() : null,
      target: tgt, gaze: g && CLOCK.t() - g.t_perf < 600 ? { x: g.x, y: g.y } : null,
      vw: innerWidth, vh: innerHeight, recording: REC.recording(), camera: CAM.live(), preview: PREVIEW.mode(), preview_shown: PREVIEW.shown(),
      on_break: !!(S.breaks.length && !S.breaks[S.breaks.length - 1].end_t_perf) });
  }

  /* -------------------------------------------------------------- actions */
  /* The portal names an element by its position in the panel plus a short
     signature (tag and text). If the panel changed in between (a list filled
     in, a notice appeared), the position may have shifted: the element with
     the same signature nearest that position is the one meant. */
  function byRid(rid, s) {
    const all = document.getElementById("panel").querySelectorAll("*");
    const n = all[rid];
    if (n && (!s || sig(n) === s)) return n;
    let best = null, bd = Infinity;
    if (s) for (let i = 0; i < all.length; i++) if (sig(all[i]) === s && Math.abs(i - rid) < bd) { best = all[i]; bd = Math.abs(i - rid); }
    if (best) { EV.log("educator_portal_rid_shift", { rid, shift: bd }); return best; }
    EV.log("educator_portal_action_dropped", { rid, sig: s }); sendPanel(true); return null;
  }
  function onMsg(m) {
    actions++; if (S.remote) S.remote.actions = actions;
    if (m.t !== "resync") EV.log("educator_portal_action", { t: m.t, rid: m.rid === undefined ? null : m.rid, key: m.key || null, d: m.d || null, screen: CUR_SCREEN.id });
    switch (m.t) {
      case "click": { const n = byRid(m.rid, m.sig); if (n) n.click(); break; }
      case "input": {
        const n = byRid(m.rid, m.sig); if (!n) break;
        if (n.type === "checkbox" || n.type === "radio") n.checked = !!m.checked; else n.value = m.value;
        n.dispatchEvent(new Event("input", { bubbles: true }));
        n.dispatchEvent(new Event("change", { bubbles: true }));
        break;
      }
      case "toggle": { const n = byRid(m.rid, m.sig); if (n && n.tagName === "DETAILS") n.open = !!m.open; break; }
      case "key": KEYS.press(m.key); break;
      case "nav": {
        const nx = document.getElementById("next"), bk = document.getElementById("back");
        if (m.d > 0 && !nx.disabled && !nx.classList.contains("hide")) go(1);
        else if (m.d < 0 && !bk.disabled) go(-1);
        else sendPanel(true);
        break;
      }
      case "stop":
        if (m.withdraw) withdrawSession(m.reason || "not given", !!m.delete_video, "educator_portal");
        else endEarly(m.reason || "not given", "educator_portal");
        break;
      case "preview": PREVIEW.setMode(m.mode, "educator_portal"); sendFace(); break;
      case "video": S.remote_video = !!m.on; attachCamera(false); break;
      case "local": local = !!m.on; EV.log("educator_controls_on_laptop", { on: local, source: "educator_portal" }); applyBody(); break;
      case "resync": sendAll(); break;
    }
  }

  /* A blocking alert() on the child's screen would freeze the laptop (and
     this link) until someone walks over to press OK: with the portal in
     control, the message goes to the portal instead. confirm() and prompt()
     stay on the laptop on purpose: they guard local, deliberate acts such as
     clearing the laptop's copy at the very end. */
  const nativeAlert = window.alert.bind(window);
  window.alert = msg => { if (controlling() && send({ t: "toast", text: String(msg) })) return; nativeAlert(msg); };

  /* Ctrl+Shift+E on the laptop: controls back here (or away again). */
  addEventListener("keydown", e => {
    if (e.ctrlKey && e.shiftKey && (e.key === "E" || e.key === "e")) {
      e.preventDefault(); e.stopImmediatePropagation();
      local = !local; EV.log("educator_controls_on_laptop", { on: local, source: "laptop_shortcut" });
      applyBody(); send({ t: "toast", text: local ? "Controls are now also shown on the laptop." : "Controls are back on the portal only." });
    }
  }, true);

  return {
    start() {
      if (started || !LINK.configured() || typeof RTCPeerConnection === "undefined") return;
      started = true; startedAt = Date.now();
      const panel = document.getElementById("panel"), foot = document.getElementById("foot");
      obs = new MutationObserver(queueSnap);
      obs.observe(panel, { subtree: true, childList: true, attributes: true, characterData: true });
      obs.observe(foot, { subtree: true, childList: true, attributes: true, characterData: true });
      faceT = setInterval(() => { try { sendFace(); } catch (e) {} }, 125);
      schedule(200);
      EV.log("educator_portal_listening", { pair });
    },
    controlling, isOpen, send,
    pairCode: () => pair,
    afterPaint() { if (isOpen()) queueSnap(); applyBody(); },
    /* The "why we ask this" panel opens on the portal, not on the child's screen. */
    modal(html) { return controlling() && send({ t: "modal", html }); },
    toast(text) { return send({ t: "toast", text }); },
    summary() { return { connects, actions, connected_now: open, controls_on_laptop: local }; }
  };
})();
REMOTE.start();   // v5.2: listen for the educator portal from the first screen
