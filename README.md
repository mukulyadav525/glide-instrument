# glide-instrument

Glide Phase 1 research instrument, **v5.1.0** (schema 4.1.0). GitHub Pages serves it from the root of `main`.

Three pages, usually on three devices:

| Page | Address | Who uses it, where |
|---|---|---|
| **Participant screen** | https://mukulyadav525.github.io/glide-instrument/ | The student, at the participant laptop. With the educator portal connected it shows **only** what the child looks at: the two things to compare, the stories, the dots. |
| **Educator portal** | https://mukulyadav525.github.io/glide-instrument/educator.html | The special educator, on a phone, tablet or second laptop beside the student. It shows the live camera with the framing oval, every question and button, and calibration feedback. |
| **Admin console** | https://mukulyadav525.github.io/glide-instrument/admin.html | The researcher (or the educator), on any device. Creates sessions, shows join codes and portal links, watches progress, sends Stop / Withdraw. |

The educator portal is optional. Without it, the participant laptop works exactly as in v5.0, with the educator panel on the right.

**v5 records face video and uploads to Google Drive.** Both must be in the approved protocol and on the guardian form before use with a student. See [docs/PROTOCOL_CHANGES_v5.md](docs/PROTOCOL_CHANGES_v5.md), which also covers what v5.1 adds: a live view on the educator's device and an optional camera preview on the child's screen.

## Documentation

| Read | For |
|---|---|
| [docs/DEPLOY.md](docs/DEPLOY.md) | Running sessions: the operator guide |
| [docs/EDUCATOR_PORTAL.md](docs/EDUCATOR_PORTAL.md) | The educator portal, the camera preview and the new calibration |
| [docs/SETUP_GOOGLE_DRIVE.md](docs/SETUP_GOOGLE_DRIVE.md) | One-time Google Drive backend setup, and how to update it |
| [docs/PROTOCOL_CHANGES_v5.md](docs/PROTOCOL_CHANGES_v5.md) | What to change in the IRB protocol and guardian form |
| [docs/IMPROVEMENTS.md](docs/IMPROVEMENTS.md) | Suggested next improvements, in priority order |
| [docs/BUILD_CHECKLIST_v5.md](docs/BUILD_CHECKLIST_v5.md) | The v5 build checklist and what is verified |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each version |
| [DATA_DICTIONARY.csv](DATA_DICTIONARY.csv) | Every column of every exported file |

## Repository layout

```
index.html  educator.html  admin.html  DATA_DICTIONARY.csv     the live site: BUILT, never edit by hand
mediapipe/face_mesh/          WebGazer's face model; must stay beside index.html

src/
  participant/                the participant screen: shell.html (markup, styles) and modules in load order
    00_header.js              versions
    10_clock_store.js         shared clock, IndexedDB, streams, events
    20_camera.js              camera, recorder, frame clock, face quality, sync flash, protocol thresholds
    30_link.js                admin link, upload outbox, SHA-256, zip
    40_streams_support.js     AOIs, luminance, stimulus snapshots, pointer, hover, focus
    50_instrument.js          the screens, calibration, router
    52_preview.js             camera preview on the child's screen
    55_remote.js              link to the educator portal (WebRTC: panel mirror and live video)
    60_export.js              session lifecycle, export, manifest, withdrawal
  educator/educator.html      the educator portal
  admin/admin.html            the admin console
  shared/face_overlay.js      oval, face box and advice, drawn the same way on the portal and on the laptop
  vendor/webgazer.bundle.js   WebGazer 3.5.3, verbatim
  data_dictionary.json        single source for DATA_DICTIONARY.csv and the copy inside every session folder

backend/
  apps_script/                Google Drive backend (Code.gs, appsscript.json)
  local_server/               the same API on a local folder (testing, or no internet)
tests/                        headless end-to-end driver (run.js) and session-folder verifier (verify.py)
tools/build.py                builds the site
docs/                         guides (above)
.github/workflows/ci.yml      checks that the built pages match the source, and that everything parses
```

## Changing the instrument

Edit files under `src/`, then rebuild the site in the repository root:

```bash
python3 tools/build.py
```

Commit the source **and** the rebuilt `index.html`, `educator.html` and `admin.html`. CI fails if they differ (`python3 tools/build.py --check`).

## Testing locally

Start the local backend with a scratch data folder (never inside the repository):

```bash
python3 backend/local_server/glide_local_server.py --data /tmp/glide_test
```

It prints the admin key and the laptop and portal setup links. Then run the headless driver. It needs Chrome and `npm install` in `tests/`. The scenarios are `full`, `remote`, `withdraw`, `crash`, `educator` and `nocam`:

```bash
cd tests && KEYS=/tmp/glide_test/keys.json OUT=/tmp/glide_out PROFILE=/tmp/glide_prof node run.js remote
```

Check a session folder against its manifest:

```bash
python3 tests/verify.py /tmp/glide_test <session_id>
```

The headless tests use a fake camera with no face and synthetic gaze. They prove the **plumbing**: timing, files, uploads, recovery, withdrawal and the portal link. They do not prove gaze accuracy or face detection; those need the real laptop and a real person.

No study data, keys or test outputs belong in this repository; it is public.
