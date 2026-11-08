# Suggested improvements

After reading the whole code base, these are the changes most likely to make Phases 1–3 smoother and the dataset more useful later. They are grouped by when they matter, and ordered by value within each group. None is built yet; each says roughly what it involves.

## A. Before the first real session

| # | What | Why | Effort |
|---|---|---|---|
| A1 | **Pilot on the actual school laptop, with the portal connected** | v5.1 adds a second video encoder (the portal stream) on top of the recorder and the face model. On a low-end laptop that may lower fps. Measure fps, dropped frames, CPU heat and battery over 45 minutes. If it struggles, turn *Hide video here* on in the portal (it stops the stream), or lower the portal stream to 320×240. | Half a day |
| A2 | **Re-decide the gaze thresholds with pilot data, then freeze them** | ≤ 5° is strict for webcam tracking of children; published webcam accuracy is around 4° for cooperative adults. With the mouse-training fault fixed, real accuracy is unknown. Run 3–5 pilots, look at the distribution, and pre-register the rule in the protocol before data collection. | A meeting |
| A3 | **Protocol and guardian-form wording** for video, Drive, and the live view on the educator's device | Required before use. See [PROTOCOL_CHANGES_v5.md](PROTOCOL_CHANGES_v5.md). | Paperwork |
| A4 | **A TURN server** for networks that block direct connections | Without one, the portal cannot connect on some institutional Wi-Fi. The laptop still works, but with its own panel. The institute IT team can host `coturn`, or a hosted TURN service can be used. It is one list of servers in `55_remote.js` and `educator.html`, best served from the backend so it can change without a rebuild. | 2 hours plus IT |
| A5 | **A QR code for the portal link** on the admin console | Typing or messaging a long link to a phone is the slowest part of starting a session. Scanning a QR code from the admin screen takes a second. Needs a small embedded QR encoder (no external service). | 2 hours |

## B. Making the dataset re-usable without the same participants

| # | What | Why | Effort |
|---|---|---|---|
| B1 | **Offline gaze re-estimation pipeline** (`_analysis/`, Python) | This is what makes the face video worth its cost. `calibration.csv` stores every dot's position and timing; `frames.csv` maps it to video frames. A script can re-fit a better gaze model per participant from the video (MediaPipe iris landmarks with ridge regression, or an appearance model such as L2CS-Net), then re-score every gaze block. Phases 2–3 then get better gaze data from Phase 1 without new sessions. | 1–2 weeks |
| B2 | **Sync verification script** | Detects the two white flashes in the video and reports the offset against `sync_flash_on` in `events.csv`. It turns the pilot's manual re-sync check (checklist step 12) into one command, and can run on every session. | 1 day |
| B3 | **Dataset health report** | One script over the whole Drive folder: every registry row has a folder; every folder passes `verify.py` (SHA-256, rows); consent form version present; retention dates near expiry; sessions whose educator half is missing. Run weekly during collection. | 2 days |
| B4 | **Retention enforcement** | `retention_until` is recorded but nothing acts on it. A time-driven Apps Script trigger could list (or, if the protocol says so, delete) videos past their date and write a note into the folder, as withdrawal does now. | 1 day |
| B5 | **Merged participant table** | Each child has two sessions (child and educator) under one code. A script that joins them into one row per child, with the fitted Bradley-Terry preferences, the reader context and quality flags, is the table every later analysis starts from. Version it in `_analysis/` with the instrument version it was built from. | 2–3 days |
| B6 | **A JSON Schema for `profile.json`** | The browser extension (Semester 2) reads it. A schema file in this repository, checked in CI against a sample session, stops the two drifting apart. | Half a day |

## C. Running sessions more smoothly

| # | What | Why | Effort |
|---|---|---|---|
| C1 | **Participant tracker in the admin console** | The registry already holds every session. A view grouped by child code (child session done? educator session done? video kept? withdrawn?) makes "who is left" obvious during a school visit. | 1 day |
| C2 | **Show a small copy of the child's screen on the portal** | The educator currently glances at the laptop to see which item is on screen. A low-resolution mirror of the stage (or just its title and the two labels) would let them watch the child's face on the portal instead. | 1 day |
| C3 | **Code format check** | Child codes are free text. A pattern (for example `C-` and 2–3 digits), checked on the admin console, prevents `C7`, `C-07` and `c-7` becoming three children. | 1 hour |
| C4 | **Instructions in Hindi (and other languages) for the spoken prompts** | The stimuli are English by design, but the spoken instructions and the assent could be given in the child's first language where a voice exists in the browser. Record which language was used. | 2–3 days, plus translation review |
| C5 | **Laptop health log** | Battery level and charging, long tasks and memory use every minute. A session on an overheating laptop then flags itself rather than showing up later as unexplained frame drops. | Half a day |
| C6 | **Educator session on the portal device** | The educator questionnaire does not need the camera or the laptop. Today it is done by opening `index.html` on any device; a button on the portal's finish screen ("start the educator questionnaire here") would make it the natural next step. | Half a day |

## D. Engineering

| # | What | Why | Effort |
|---|---|---|---|
| D1 | **Run the headless scenarios in CI** | CI now checks that the pages are built from the source and that everything parses. Running `tests/run.js` (all six scenarios) on GitHub Actions with Chrome would catch behavioural regressions on every change. | Half a day |
| D2 | **Split `50_instrument.js`** (4,200 lines) into blocks (consent, physical, pairs, gaze, reading, distractors, educator, finish, router) | Easier review and safer changes; the build already concatenates in file order, so it is a pure move. | 1 day |
| D3 | **Encrypt the laptop copy** | If the protocol requires it: encrypt video chunks in IndexedDB with a per-session key held only until upload. | 1–2 days |
