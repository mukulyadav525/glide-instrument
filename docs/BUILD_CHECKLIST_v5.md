# Glide instrument v5.0.0 (schema 4.0.0)

> **Historical record of the v5.0 build.** The repository layout has since changed (see the README): sources are in `src/participant/`, `src/admin/` and `src/educator/`, the site is built into the repository root with `python3 tools/build.py`, and the backend is in `backend/apps_script/` and `backend/local_server/`. v5.1 changes are in `CHANGELOG.md` and `docs/EDUCATOR_PORTAL.md`.

The Phase 1 data-collection instrument, rebuilt so that everything collected now can be re-used in Phases 2 and 3 **without asking the same participants again**. Face video, gaze, calibration targets, stimuli and every response share one clock, and everything lands in one structured Google Drive folder per session.

## Build

```bash
python3 tools/build.py
```

`--release` also freezes a copy in `releases/glide-p1-child-v5.0.0.html`. Edit `src/`, never the built pages.

## Test

Start the local backend (with a scratch data folder):

```bash
python3 backend/local_server/glide_local_server.py --data /tmp/glide_test
```

Then run the driver (needs `npm install puppeteer-core` in `tests/`). The scenarios are `full`, `withdraw`, `crash`, `educator` and `nocam`:

```bash
cd tests && KEYS=/tmp/glide_test/keys.json OUT=/tmp/glide_out PROFILE=/tmp/glide_prof node run.js full
```

Check a session folder against its manifest:

```bash
python3 tests/verify.py /tmp/glide_test <session_id>
```

Headless Chrome uses a fake camera with no face in it, and the driver replaces WebGazer's predictions with synthetic ones. So these tests prove the **plumbing** (timing, files, uploads, recovery, withdrawal), not gaze accuracy or face detection. Those need the real laptop and a real person (checklist step 12).

## Build checklist v5: status

✓ done and tested headlessly · ◐ done, needs the real laptop or a person to confirm · ✗ not done (reason given)

**0. Consent and gates**

- ✓ Separate video consent (guardian item on the admin device or setup screen, plus the student's own answer), independent of gaze and the study
- ✓ Assent wording now matches what is recorded (the "does not save a video" line is said only when video was not agreed)
- ✓ `consent_form_version` and retention date recorded per session and in the manifest
- ✓ Recording indicator always on while recording (grey when the camera is lost)
- ✓ Camera opens only after the consent answer is logged
- ✓ Withdrawal stops recording at once and offers *keep answers, delete video* (laptop and Drive)
- ✓ Guardian gate and capacity → assent logic unchanged

**1. Setup and environment**

- ✓ Codes and duplicate-code warning
- ✓ Environment capture (now also screen, platform, cores, memory, timezone, secure context)
- ✓ Camera: label plus `getSettings()`, i.e. what was got rather than what was asked for, plus capabilities
- ✓ Font health, offline bundle, 45-minute timer
- ✓ Crash recovery: resumes by screen id, salvages saved video chunks, restarts recording, keeps the clock and frame numbering continuous
- ✓ One clock: `t_perf` on every row, session time origin and every reload epoch recorded

**2. Physical calibration**

- ✓ Card match → px/mm
- ✓ Viewing distance: educator band, plus an optional blind-spot task (virtual chinrest)
- ✓ Interocular px at calibration; `distance_ratio` per frame
- ✓ Room lighting note, face and background brightness at framing; screen brightness confirmation
- ✓ Mean relative luminance of every stimulus (and of the whole viewport) at onset

**3. Video and frames**

- ✓ 720p30 → 480p30 → any ladder, `audio:false`, result logged
- ✓ MediaRecorder codec chosen by `isTypeSupported` (VP9 → VP8 → WebM → MP4), codec and bitrate logged
- ✓ Records from consent to the end, independent of gaze calibration
- ✓ `requestVideoFrameCallback` log per frame; dropped-frame detection; achieved fps overall and per block
- ✓ Screen changes, stimulus onsets (rAF), responses, calibration targets and gaze all on `t_perf` and mappable to a frame
- ✓ Sync flash at recording start and end (and on resume)
- ✓ 5 s chunks to IndexedDB; parts at block boundaries (max 2 minutes), overlapping so there is no gap
- ✓ File names carry codes only
- ✓ Storage estimate and free space shown before recording
- ◐ Encryption at rest: Google Drive encrypts at rest; the laptop copy sits in browser storage until cleared. No extra file encryption was added. Ask if the protocol requires it.
- ✓ Retention date in the manifest
- ◐ Per-frame face quality from WebGazer's own face mesh: face found, box, yaw/pitch/roll (approximate), eye openness, interocular px, brightness. Up to 15 Hz. Landmark confidence is not exposed by this runtime (column kept, always empty). Needs a real face to confirm the values.
- ✓ Session summaries: % frames with face, % usable pose, blink rate, longest face loss

**4. Framing check**

- ◐ Live preview with oval and six automatic green/amber/red checks, educator override with reason, preview hidden afterwards. The thresholds (especially distance) should be checked on the real webcam.

**5. Gaze**

- ✓ One-target-at-a-time 3×3 calibration, randomised, shrinking dot, 5 training samples per point
- ✓ Every calibration, validation and drift target stored with onset, click and offset times and raw predictions (`calibration.csv`)
- ✓ Validation: accuracy (px and °), precision as RMS-S2S and SD, data loss; rule ≤ 5° and ≤ 30% loss; at most 2 recalibrations, then gaze off and video continues
- ✓ Drift check before each read and before the distractors, with optional quick recalibration

**6. Stimuli and AOIs**

- ✓ Bounding boxes of every labelled region at onset, resize and scroll; scroll stream
- ✓ The exact stimulus DOM saved instead of an `html2canvas` screenshot: exact rather than a re-rendering, with no extra library and no CPU cost during the session

**7–8. Child and educator blocks**

- ✓ All unchanged v4.2 blocks
- ✓ Break start/end logging
- ✓ New educator item on movement and restlessness during the camera parts

**9. Passive streams**

- ✓ Pointer and touch, hover dwell per option, visibility and focus loss, resizes

**10. Quality flags**

- ✓ All v4 flags, plus face %, dropped frames, fps, drift, framing overrides, longest face loss, recorder errors, storage errors, calibration attempts

**11. Export**

- ✓ One folder per session, the same on Drive and in the offline zip. The full file list is in `dist/DEPLOY.md`.
- ✓ Manifest with SHA-256 per file; the server re-checks every upload's SHA-256
- ✓ Data dictionary shipped inside every session folder, and every exported column checked against it

**12. Before the first real session** (yours to do; the instrument cannot do these)

- ✗ Run on the actual school laptop: real fps, dropped frames, MB per minute, battery over 45 minutes, CPU heat
- ◐ Scenarios re-run: full child, educator, no consent for camera, admin withdrawal with video deletion, crash mid-recording, all passing headlessly. Not yet run: camera denied or unplugged mid-session, storage full, recorder chunk failure (the code handles these; they need a real machine). The 14 scenarios from the v4.1 build record were not available here.
- ✗ Pilot with 2–3 people, then the re-sync test: 10 random stimulus onsets against video frames
- ✗ Write the thresholds into the protocol (`docs/PROTOCOL_CHANGES_v5.md` lists them)
- ✓ Version bumped to v5.0.0, schema 4.0.0; v4.2.0 kept in `releases/`
