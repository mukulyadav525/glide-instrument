# glide-instrument

Glide Phase 1 research instrument, **v5.0.0** (schema 4.0.0), served by GitHub Pages from the root of `main`.

| Page | Address | Used on |
|---|---|---|
| Instrument | https://mukulyadav525.github.io/glide-instrument/ | The participant laptop |
| Admin console | https://mukulyadav525.github.io/glide-instrument/admin.html | Any device (laptop, tablet, phone) |

Read `DEPLOY.md` before running sessions. Google Drive storage is set up once with `source/backend/apps_script/SETUP_GOOGLE_DRIVE.md`.

**v5 records face video and uploads to Google Drive.** Both must be in the approved protocol and on the guardian form before it is used with a student: see `source/docs/PROTOCOL_CHANGES_v5.md`.

## Layout

```
index.html  admin.html  DATA_DICTIONARY.csv  DEPLOY.md   the live site (built; do not edit by hand)
mediapipe/face_mesh/                              WebGazer's face model, must stay beside index.html
source/
  src/          instrument and admin console source
  backend/      apps_script/ (Google Drive) and glide_local_server.py (same API, local folder)
  tests/        headless end-to-end driver and folder verifier
  docs/         protocol changes for v5
  build.py      builds the site
  README.md     full documentation and build-checklist status
```

## Changing the instrument

Edit files under `source/src/`, then rebuild the site in the repository root:

```bash
python3 source/build.py --out .
```

Commit both the source and the rebuilt `index.html` / `admin.html`.

No study data, keys or test outputs belong in this repository; it is public.
