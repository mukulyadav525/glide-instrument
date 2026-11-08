# Changelog

## v5.2.0 · schema 4.1.0

- **Laptop pairing code.** Every participant laptop shows a 5-character code on its first screen. The educator types it into the portal, which then runs the **whole** session from the start: join code or offline setup, codes, consent answers, everything. Offline sessions work with the portal too (they only need the laptop to have been set up once). The admin console's portal link (join code) still works and finds the laptop once it has joined.
- **The child's screen shows the question, never the answer options.** The comparison, practice, page, text and retest screens show the question in large text above the things to compare. The educator answers on the child's behalf, on the portal. Educator-only notes are hidden on the laptop while the portal is connected.
- **Calibration, validation and drift checks are automatic by default.** Each dot records itself once the child has looked for about a second and the eyes are clear. *Manually* is one click away.
- **Backend** `glide-backend-5.2.0`: `signal` accepts a laptop pairing code; `join` records which laptop joined. Redeploy as a new version.

## v5.1.0 · schema 4.1.0

**Educator portal.** A new page, `educator.html`, for the special educator's own phone, tablet or laptop. It connects directly to the participant laptop (WebRTC, set up through the study backend) and shows the live camera with the framing oval and face box, what to adjust in words, the six framing checks, every question and button, and a live map of the calibration dot against the gaze estimate. While it is connected, the participant laptop shows only what the child looks at. Every answer is still logged on the laptop's clock. Ctrl+Shift+E on the laptop brings the controls back there.

**Camera preview on the child's screen.** Optional: off, only when out of frame (default), or always. Every appearance is logged.

**Calibration.**
- WebGazer no longer trains on mouse clicks and movements. Before, the educator's clicks on the panel were teaching the gaze model the wrong positions, the main cause of failed validations.
- Calibration samples are taken only when the face is seen with both eyes open and the head roughly straight. Dots without enough clean samples are repeated, with the reason shown.
- Dots use the whole screen.
- Optional automatic mode.
- At least 7 of 9 dots are needed, and a dot can be skipped.
- Recalibration can keep the earlier model and add dots.
- Validation and drift drop the first 350 ms after the button.

**Robustness.** The sync flash can no longer hang camera setup when the tab is hidden (2 s timeout, logged).

**Backend** (`glide-backend-5.1.0`): adds the operations `edu_join` and `signal`. Redeploy the Apps Script as a new version (docs/SETUP_GOOGLE_DRIVE.md). The local server now serves only the site pages, never its data folder or keys.

**Admin console.** An educator portal link with each new session, and a *Portal link* button on each session card.

**Data.**
- New calibration row kind `calibration_retry`. `samples_json` now records clean-sample counts and the reasons samples were refused.
- New events: `preview_*`, `educator_portal_*`, `webgazer_mouse_training_off`, `calibration_target_skipped`, `sync_flash_timeout`.
- `session.json` adds `preview` and `remote`.
- Existing columns are unchanged.

**Repository.**
- Restructured into `src/participant`, `src/educator`, `src/admin`, `src/shared`, `src/vendor`, `backend/`, `tests/`, `tools/build.py` and `docs/`.
- CI checks that the built pages match the source.
- A new headless scenario, `remote`, drives a whole session from the portal.

## v5.0.0 · schema 4.0.0

- Face video on the shared clock, consent gates, physical calibration (card match and blind spot) and the framing check.
- One-at-a-time gaze calibration with validation and drift checks.
- AOIs, passive streams, quality flags, and the manifest with SHA-256.
- Admin console and Google Drive backend.

## v4.2.0

Original Phase 1 instrument (single laptop, files saved locally).
