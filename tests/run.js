// GLIDE v5 headless end-to-end driver.
// node run.js <scenario>   scenarios: full | withdraw | crash | educator | nocam | remote | pair
//   pair: an OFFLINE session (no admin device); the portal connects with the
//   5-character code on the laptop's first screen and runs everything, setup included.
//   remote: a second tab opens the educator portal; once it connects, the
//   whole session is driven from the portal and the laptop shows the child view only.
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const BASE = "http://localhost:8765";
const KEYS = JSON.parse(fs.readFileSync(process.env.KEYS, "utf8"));
const scenario = process.argv[2] || "full";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log("[" + scenario + "]", ...a);

async function api(op, body) {
  const r = await fetch(BASE + "/api", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(Object.assign({ op, key: KEYS.ADMIN_KEY }, body || {})) });
  const j = await r.json(); if (!j.ok) throw new Error(op + ": " + j.error); return j;
}

/* Synthetic gaze: replaces WebGazer's public listener API so calibration,
   validation, drift and gaze screens can be exercised with a fake camera
   (which has no face). Predictions = centre of the current target + noise,
   or screen centre. 10% of callbacks return null (data loss). */
const GAZE_STUB = () => {
  const install = () => {
    const wg = window.webgazer; if (!wg || wg.__stubbed) return !!wg;
    wg.__stubbed = true; let fn = null;
    wg.setGazeListener = f => { fn = f; return wg; };
    wg.clearGazeListener = () => { fn = null; return wg; };
    setInterval(() => {
      if (!fn) return;
      if (Math.random() < 0.1) { fn(null, 0); return; }
      const t = document.querySelector("#stage .ctarget, #stage .valdot:not(.done):not([style*='opacity'])") || null;
      let x = innerWidth / 2, y = innerHeight / 2;
      if (t) { const r = t.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + r.height / 2; }
      fn({ x: x + (Math.random() - 0.5) * 60, y: y + (Math.random() - 0.5) * 60 }, 0);
    }, 33);
    return true;
  };
  const iv = setInterval(() => { if (install()) clearInterval(iv); }, 20);
};

async function main() {
  const browser = await puppeteer.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: "new",
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required",
           "--disable-features=WebRtcHideLocalIpsWithMdns,CalculateNativeWinOcclusion",
           "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
           "--window-size=1440,900", "--no-first-run", "--no-default-browser-check", "--mute-audio"],
    defaultViewport: { width: 1440, height: 900 },
    userDataDir: process.env.PROFILE,
    protocolTimeout: 60000
  });
  const page = await browser.newPage();
  const errors = [];
  let drv = page;                       // the page whose #panel and #next are driven (the portal, in "remote")
  const onDialog = pg => pg.on("dialog", async d => {
    const msg = d.message();
    if (d.type() === "confirm") { await d.accept(); return; }
    if (d.type() === "prompt") {
      if (/WITHDRAWING/.test(msg)) await d.accept(page.__withdraw ? "withdraw" : "tired");
      else await d.accept("test reason");
      return;
    }
    await d.accept();
  });
  onDialog(page);
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
  if (scenario !== "nocam") await page.evaluateOnNewDocument(GAZE_STUB);
  /* The fake camera has no face, so the v5.1 face gate would refuse every
     calibration sample. Replace it with one that refuses 15% of moments
     (as blinks would), which also exercises the retry path. */
  if (scenario !== "nocam") await page.evaluateOnNewDocument(() => {
    const iv = setInterval(() => { try { if (typeof FACEQ !== "undefined") { FACEQ.usableNow = () => Math.random() < 0.15 ? { ok: false, gated: true, why: "eyes_closed" } : { ok: true, gated: true, why: "ok" }; clearInterval(iv); } } catch (e) {} }, 20);
  });

  // admin creates the session
  const mode = scenario === "educator" ? "educator" : "child";
  const created = await api("create_session", { config: { mode, child_id: "T-" + scenario.toUpperCase().slice(0, 4), educator_id: "E-01",
    guardian_main: true, guardian_gaze: scenario !== "nocam", guardian_video: scenario !== "nocam", consent_form_version: "GPF-v3-test",
    retention_until: "2031-12-31", sync_flash: true } });
  const sess = created.session; log("created", sess.session_id, sess.join_code);

  await page.goto(BASE + "/index.html?api=" + encodeURIComponent(BASE + "/api") + "&k=" + encodeURIComponent(KEYS.DEVICE_KEY), { waitUntil: "load" });
  await sleep(3500);

  const cur = () => page.evaluate(() => { const s = visible()[idx]; return s ? s.id : null; });
  const nextEnabled = () => drv.evaluate(() => !document.querySelector("#next").disabled && !document.querySelector("#next").classList.contains("hide"));
  const next = async () => { await drv.click("#next"); await sleep(drv === page ? 250 : 600); };
  const clickText = async (txt, scope = "#panel", nth = 0) => {
    const ok = await drv.evaluate((txt, scope, nth) => {
      const els = [...document.querySelectorAll(scope + " button")].filter(b => b.textContent.replace(/\s+/g, " ").includes(txt));
      if (!els[nth]) return false; els[nth].click(); return true;
    }, txt, scope, nth);
    await sleep(drv === page ? 120 : 350); return ok;
  };
  const key = async k => { await drv.keyboard.press(k); await sleep(drv === page ? 120 : 350); };
  const pev = (fn, ...a) => drv.evaluate(fn, ...a);
  const setLastText = v => pev(v => { const i = [...document.querySelectorAll("#panel input[type=text]")].pop(); i.value = v; i.dispatchEvent(new Event("input", { bubbles: true })); }, v);
  const waitValid = async (ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await nextEnabled()) return true; await sleep(250); } return false; };

  let portal = null, remoteChecks = {};
  async function openPortal(code) {
    // A second window (own browser context), so both pages stay visible: a
    // background tab is throttled and frozen, which a real second device is not.
    const ctx = browser.createBrowserContext ? await browser.createBrowserContext() : await browser.createIncognitoBrowserContext();
    portal = await ctx.newPage();
    await portal.setViewport({ width: 1100, height: 820 });
    onDialog(portal);
    portal.on("pageerror", e => errors.push("portal pageerror: " + e.message));
    portal.on("console", m => { if (m.type() === "error") errors.push("portal console: " + m.text()); });
    await portal.goto(BASE + "/educator.html?api=" + encodeURIComponent(BASE + "/api") + "&k=" + encodeURIComponent(KEYS.DEVICE_KEY) + "&code=" + code, { waitUntil: "load" });
    const t0 = Date.now();
    while (Date.now() - t0 < 40000) {
      const ok = await portal.evaluate(() => document.querySelector("#conn").textContent === "connected").catch(() => false);
      if (ok) break; await sleep(500);
    }
    await sleep(1500);
    remoteChecks.connect_ms = Date.now() - t0;
    remoteChecks.laptop_child_view = await page.evaluate(() => document.body.classList.contains("remote") && getComputedStyle(document.querySelector("#right")).display === "none");
    remoteChecks.portal_has_panel = await portal.evaluate(() => !!document.querySelector("#panel [data-rid]"));
    log("portal", JSON.stringify(remoteChecks));
    if (remoteChecks.laptop_child_view && remoteChecks.portal_has_panel) drv = portal;
    else log("PORTAL DID NOT TAKE OVER");
  }

  let steps = 0, seen = [];
  const H = {
    connect: async () => {
      if (scenario === "pair") {
        await openPortal(await page.evaluate(() => REMOTE.pairCode()));
        await clickText("Run offline on this laptop"); return;
      }
      await page.type("input.codein", sess.join_code); await clickText("Join session"); await sleep(1500);
      if (scenario === "remote") await openPortal(sess.join_code); },
    mode: async () => {
      if (scenario === "pair") {   // offline: everything typed on the portal
        await clickText("Child session"); await sleep(400);
        const type = (ph, v) => pev((ph, v) => { const i = [...document.querySelectorAll("#panel input")].find(x => (x.placeholder || "").startsWith(ph)); i.value = v; i.dispatchEvent(new Event("input", { bubbles: true })); }, ph, v);
        await type("e.g. C-07", "T-PAIR"); await sleep(300); await type("e.g. E-02", "E-01"); await sleep(300);
        await clickText("Yes", "#panel .q", 0); await sleep(300);
        await clickText("Yes, can understand and decide"); await sleep(300);
        await type("e.g. GLIDE-GPF", "GPF-v3-test"); await sleep(300);
        await pev(() => document.querySelectorAll("#panel .q").forEach(q => { if (/eye tracking|video recording/.test(q.textContent)) q.querySelector("button").click(); })); await sleep(600);
        await pev(() => { const i = document.querySelector("#panel input[type=date]"); i.value = "2031-12-31"; i.dispatchEvent(new Event("input", { bubbles: true })); }); await sleep(500);
        return;
      }
      await clickText("Yes, can understand and decide"); },
    ascertain: async () => { await clickText("ADHD"); await clickText("Combined"); await clickText("Formal diagnostic report"); await clickText("Yes, I have it to hand"); await clickText("Within 12 months"); },
    card_match: async () => { await clickText("The box matches the card exactly"); },
    assent: async () => { await clickText("Yes, they want to do it"); await clickText("Reads fairly fluently"); },
    video_consent: async () => { await clickText("Yes, the student is happy with the video"); },
    cam_setup: async () => { await waitValid(20000); await sleep(1500); },
    framing: async () => { await sleep(1200); await clickText("Overhead lights only"); await clickText("Screen brightness is set to about half");
      await setLastText("test: fake camera has no face"); },
    framing2: async () => { await sleep(800); await setLastText("test: fake camera"); },
    context: async () => { await drv.select("#panel select", "Hindi"); await clickText("English"); await clickText("Fairly comfortable"); await clickText("Yes, and they are wearing them now");
      await clickText("Within the last year"); await clickText("Mid-morning"); await clickText("Nothing unusual"); },
    comprehension: async () => { await key("1"); },
    gaze_consent: async () => { await clickText("Yes, that is okay"); await clickText("About 60 cm"); },
    gaze_check: async () => { await waitValid(20000); },
    distance: async () => { for (let i = 0; i < 3; i++) { await clickText("Start"); await sleep(2600); await clickText("Gone"); await sleep(300); } },
    calibrate: async () => {
      if (portal) { await waitValid(60000); return; }   // automatic is the default: the dots record themselves
      for (let i = 0; i < 20 && !(await nextEnabled()); i++) { await sleep(500); await clickText("They are looking at the dot"); await sleep(1300); } },
    validate: async () => { if (portal) { await waitValid(30000); return; }
      for (let i = 0; i < 5; i++) { await clickText("They are looking at the dot"); await sleep(2000); } },
    gaze_read: async () => { await sleep(1500); await clickText("They have finished reading"); await clickText("Fine"); },
    apply: async () => { await clickText("The child is taking a break now"); await sleep(800); await clickText("Break over"); await sleep(1200);
      await clickText("They have finished reading"); await clickText("Fine"); },
    showcase: async () => { await clickText("The one with my settings"); await clickText("Yes, readily"); },
    layout: async () => { await key("1"); await clickText("Fine", "#panel", 0); await clickText("A bit much", "#panel", 1); await clickText("Chose immediately"); },
    textlevel: async () => { await key("2"); await clickText("Fine", "#panel", 0); await clickText("Too much", "#panel", 1); },
    retest: async () => { await key("1"); },
    ed1: async () => { await clickText("14-15"); await clickText("At age level"); await clickText("5-15 min"); },
    ed_w: async () => {}, ed_w2: async () => {},
    ed_obs: async () => { await clickText("4"); await clickText("4", "#panel", 1); await clickText("Once or twice"); await clickText("Possibly"); await clickText("Some of the time"); await clickText("2", "#panel", 2); },
    ed_pri: async () => { await pev(() => { document.querySelectorAll("#panel .q").forEach((q, i) => { const b = q.querySelectorAll("button")[i % 4]; if (b) b.click(); }); }); await sleep(200); }
  };
  while (steps++ < 140) {
    const id = await cur(); seen.push(id);
    if (process.env.DEBUG) log("step", id);
    // SHOTS=1: screenshots of the child's screen and the portal at a few moments
    if (process.env.SHOTS && portal && /^(font_0|framing2|calibrate|gaze_read|dis_X2)$/.test(id) && !seen.slice(0, -1).includes(id)) {
      if (id === "calibrate") await sleep(4200);
      else await sleep(1500);
      await page.screenshot({ path: process.env.OUT + "/shot_" + id + "_laptop.png" });
      await portal.screenshot({ path: process.env.OUT + "/shot_" + id + "_portal.png" });
    }
    if (id === "done") break;
    if (scenario === "withdraw" && id === "dis_" + "X1" ) {}
    if (scenario === "withdraw" && seen.filter(x => /^dis_/.test(x)).length === 1 && /^dis_/.test(id) && !page.__sent) {
      page.__sent = true;
      await api("command", { session_id: sess.session_id, type: "withdraw", args: { reason: "guardian asked", delete_video: true } });
      log("withdraw command sent at", id);
      await sleep(9000);
      continue;
    }
    if (scenario === "crash" && id === "lead_0" && !page.__crashed) {
      page.__crashed = true; log("reloading at", id);
      await sleep(6000);
      await page.reload({ waitUntil: "load" }); await sleep(5000);
      continue;
    }
    if (/^dis_/.test(id)) { await clickText("Fine"); await clickText("Kept reading the words"); }
    else if (/^recall_/.test(id)) { await pev(() => document.querySelectorAll("#panel .q").forEach(q => { const b = q.querySelector(".scale button"); if (b) b.click(); })); await sleep(150); }
    else if (/^drift_/.test(id)) { if (portal) await waitValid(8000); else { await clickText("They are looking at the dot"); await sleep(1900); } }
    else if (/^(font|size|colour|lead|track)_\d+$/.test(id)) { await key(Math.random() < 0.15 ? "3" : (Math.random() < 0.5 ? "1" : "2")); }
    else if (H[id]) await H[id]();
    if (process.env.STOP_AT === id) {
      await sleep(3000);
      log("DUMP", JSON.stringify(await page.evaluate(() => ({ answers, valid: visible()[idx].valid(), frame: S._frame && S._frame.pass, phys: S.physical,
        acts: STREAMS.rows("events").filter(e => e.type === "educator_portal_action").slice(-8).map(e => e.detail) }))));
      log("PORTAL", await drv.evaluate(() => document.querySelector("#panel").innerHTML.slice(0, 3000)));
      break;
    }
    if (!(await waitValid(id === "cam_setup" || id === "gaze_check" ? 25000 : 4000))) {
      const sk = await clickText("Skip this question");
      log("no handler made it valid, skipped:", id, sk);
      if (!sk) {
        log("STUCK at", id, JSON.stringify(await page.evaluate(() => ({ next_disabled: document.querySelector("#next").disabled, valid: !!(visible()[idx].valid ? visible()[idx].valid() : true),
          cam: S._camSetup || null, remote: (() => { try { return REMOTE.summary(); } catch (e) { return String(e); } })() }))),
          drv !== page ? JSON.stringify(await drv.evaluate(() => ({ next_disabled: document.querySelector("#next").disabled, conn: document.querySelector("#conn").textContent, h1: (document.querySelector("#panel h1") || {}).textContent }))) : "");
        break; }
      continue;
    }
    await next();
  }
  log("screens:", seen.join(" > "));
  if (portal) {
    await portal.evaluate(() => document.querySelector("#pvseg button[data-m=on]").click()); await sleep(1500);
    remoteChecks.preview_mode_on = await page.evaluate(() => PREVIEW.mode() === "on");
    remoteChecks.video_track = await portal.evaluate(() => { const v = document.querySelector("#rv"); return !!(v.srcObject && v.srcObject.getVideoTracks().length) && v.videoWidth; });
    remoteChecks.portal_actions = await page.evaluate(() => STREAMS.rows("events").filter(e => e.type === "educator_portal_action").length);
    remoteChecks.laptop_child_view_at_end = await page.evaluate(() => document.body.classList.contains("remote"));
    await portal.screenshot({ path: process.env.OUT + "/remote_portal.png", fullPage: false });
    log("portal checks", JSON.stringify(remoteChecks));
  }
  // finishing: wait for uploads
  const t0 = Date.now(); let st;
  while (Date.now() - t0 < 90000) {
    st = await page.evaluate(() => ({ ob: OUTBOX.stats(), manifest: !!S._manifest }));
    if (st.manifest && st.ob.pending === 0 && st.ob.uploaded > 0) break;
    await sleep(1500);
  }
  log("outbox", JSON.stringify(st));
  const summary = await page.evaluate(() => {
    const q = S.derived && S.derived.quality ? S.derived.quality.v5 : null;
    return { session_id: S.session_id, withdrawn: S.withdrawn, video_deleted: S.video.deleted, epochs: CLOCK.epochs.length,
      streams: streamCounts(), segments: REC.segments.map(s => [s.segment, s.reason_start, s.reason_stop, s.bytes]),
      validation: GAZE.validation ? { deg: GAZE.validation.mean_error_deg, loss: GAZE.validation.data_loss_share, meets: GAZE.validation.meets_protocol, s2s: GAZE.validation.precision_rms_s2s_px } : null,
      physical: S.physical, flags: q ? q.flags : null, frames: q ? q.frames : null, missing: S._manifest ? S._manifest.dictionary_missing : null };
  });
  log("summary", JSON.stringify(summary, null, 1));
  await page.screenshot({ path: process.env.OUT + "/" + scenario + "_done.png" });
  log("errors", errors.length ? errors.slice(0, 15).join("\n") : "none");
  fs.writeFileSync(process.env.OUT + "/" + scenario + "_result.json", JSON.stringify({ sess, summary, errors, seen, remoteChecks }, null, 1));
  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
