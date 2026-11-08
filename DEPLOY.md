# Glide instrument `glide-p1-child-v5.0.0` · deployment and operation

v5 adds face video on the same clock as everything else, physical screen calibration, a stricter gaze calibration with pre-declared acceptance rules, passive behavioural streams, an **admin console on a second device**, and **upload to Google Drive**. Everything in v4.2 is still there and still works the same way.

## Bundle

```
index.html            the instrument (participant laptop). WebGazer 3.5.3 and both webfonts are embedded.
admin.html            the admin console (any device: laptop, tablet, phone)
mediapipe/face_mesh/  WebGazer's face model. Must sit beside index.html, or gaze AND face quality collect nothing.
DATA_DICTIONARY.csv   one line per column of every exported file (also shipped inside every session folder)
```

Storage backend: `source/backend/apps_script/` (Google Drive; see `SETUP_GOOGLE_DRIVE.md` there) or `source/backend/glide_local_server.py` (no internet).

## Deploying

The camera only works on **https** or **localhost**. Choose one:

| Option | How |
|---|---|
| **Hosted (recommended)** | Publish this folder to any static https host (GitHub Pages, Netlify, the institute web server) so `index.html`, `admin.html` and `mediapipe/` are siblings. Then open `https://<site>/mediapipe/face_mesh/face_mesh.binarypb`: it must return 200. |
| **On the laptop** | `python3 -m http.server 8000` in this folder, then open `http://localhost:8000/index.html`. Never open `index.html` as a `file://`: the face model will not load. |
| **No internet at the school** | `python3 source/backend/glide_local_server.py` on the participant laptop. It serves this folder and stores data in `source/backend/local_drive/GLIDE_Study_Data/`, in the same layout as Drive. The admin device opens `http://<laptop LAN IP>:8765/admin.html`. Copy the folder into the study Drive afterwards. |

Use **Chrome or Edge** (current version). Safari and Firefox cannot time individual video frames (`requestVideoFrameCallback`). The instrument tells you so on the camera screen.

## Two devices

| | Admin device | Participant laptop |
|---|---|---|
| Opens | `admin.html` | `index.html` |
| Who uses it | Researcher or special educator | The student, with the special educator beside them |
| Does | Creates the session (codes, guardian consent per component, consent form version, retention date), shows the join code, watches progress live, sends Message / Stop / Withdraw / Delete video | Runs the study. The right-hand panel is still the educator's, exactly as in v4. |

1. **Admin:** *New session*. Fill in the child code, educator code, consent form version, which components the guardian form agrees to (study, eye tracking, video) and the retention date. Click **Create**. A 6-letter code appears.
2. **Laptop:** type the code on the first screen and click **Join**. Codes and consent come from the admin device, so they cannot be mistyped here.
3. The admin card shows the screen, minutes elapsed, recording state and fps, face visibility, gaze accuracy, and uploads.

The special educator can be the admin too: create the session on a phone, then sit with the student.

**Without the admin device:** choose *Run offline* on the first screen. Codes and consent are then entered on the laptop. Everything else is identical.

## Session order (child)

`connect → setup → ascertainment → card match → assent → video consent → camera setup (blink) → framing check → reader context → practice → typography / size / colour / spacing pairs → eye-tracking consent → camera check → framing check → blind-spot distance → calibration → validation → drift check → story 1 → recall → drift check → break + story 2 → recall → combined settings → drift check → 6 distractor pages → busy vs calm → dense vs plain → retest → finish (blink, upload)`

Each screen skips itself when its consent or condition is absent. With no video and no eye tracking, the session is the v4 session plus the card match.

## What the operator should know

**Before the first real session**, run *Educator training* once, then one full test session with a test code (see the setup guide).

**The two blinks.** When the video starts and when it ends, the screen flashes white once for a quarter of a second. Tell the student beforehand. This is the sync marker that proves the video lines up with the data. It can be turned off per session in the admin console.

**Recording indicator.** A red *Recording video* badge stays in the top-right corner whenever the camera is recording. If it turns grey (*Camera lost*), the camera was unplugged or taken by another app. The session carries on and the gap is recorded.

**Framing check.** Six dots: face found, centred, distance, both eyes visible, lighting, head level. Aim for green; amber is acceptable. A window **behind** the student is the most common failure: close the blind or turn the table. If it cannot be fixed, type the reason in *Continue anyway* (recorded). The live preview disappears when you leave the screen, on purpose.

**Card match.** Hold any bank-card-sized card flat on the screen and drag until the striped box matches it. Do not change the browser zoom afterwards.

**Calibration.** One dot at a time, in random order. When the student is looking at it, press the button or the space bar. **Validation** then checks accuracy against the rule fixed before collection (≤ 5° accuracy, ≤ 30% data loss). If the rule is not met you get **at most two recalibrations**; after that eye tracking switches off and the video keeps recording.

**Drift checks.** One centre dot before each gaze block. If the drift is over 2.5°, recalibrate quickly or carry on; either choice is recorded.

**Breaks.** On the halfway screen, press *The child is taking a break now*, then *Break over*. The video can then be cut around the break.

**Skipping.** Every measurement screen still offers *Skip this question*, recorded as a skip.

**Stopping and withdrawing.** *Stop now* on the laptop, or *Stop* / *Withdraw* on the admin card. On a withdrawal you are asked whether to **also delete the video**. Recording stops at once either way. "Keep answers, delete video" deletes every part from the laptop and from Drive, and leaves a `VIDEO_DELETED.txt` note in the session folder.

**Crash or closed lid.** Reopen the page and accept *carry on*. It resumes on the same screen. Video already recorded is kept (at most the last 5 seconds are lost), recording restarts with a blink, and the clock stays continuous. Eye tracking does not survive a reload (the gaze model is never stored), so it switches off and is recorded as such.

**Saving.** Nothing to click. At the end, every file is queued and uploaded; the finish screen shows progress. With no connection, use *Download everything as one .zip* (same folder layout as Drive), or leave the laptop: the queue survives a reboot and uploads the next time the page is open online. Only use *Clear this session from this laptop* once the finish screen says everything is on Drive.

## What comes out

One folder per session: `GLIDE_Study_Data/participants/<child>/<child|educator>/<YYYY-MM-DD>_<session>/`

| File | Contents |
|---|---|
| `manifest.json` | **Read first.** Every file with SHA-256, bytes and rows; versions; consent form version and components; retention date; camera and codec; clock; protocol thresholds |
| `session.json` | Complete record, including derived summaries and quality flags |
| `responses.csv` | Every logged response (now with `t_perf`, `frame_index`, `screen_id`) |
| `pairs.csv` | One row per comparison, Bradley-Terry / Plackett-Luce ready |
| `events.csv` | Screen changes, stimulus onsets (with luminance), sync flashes, breaks, focus loss, resizes, scrolls, recorder events, hover dwell |
| `frames.csv` | Every presented camera frame on the shared clock, with dropped-frame gaps |
| `face_quality.csv` | Face found, box, head pose, eye openness, interocular distance, brightness (up to 15 Hz) |
| `gaze.csv` | Every gaze callback, including invalid ones, with the accuracy in effect |
| `gaze_zones.csv` | Gaze by screen region (unchanged from v4) |
| `calibration.csv` | Every calibration, validation and drift target with onset, click and offset times and the raw predictions |
| `aoi.csv` | Bounding box of every labelled region at each onset, resize and scroll |
| `pointer.csv` | Pointer and touch positions (20 Hz) |
| `video_segments.csv` | Each video part's start and stop on the shared clock and its frame range |
| `video/part_NNN.webm` | Face video, no audio, one playable file per block or per 2 minutes |
| `stimuli.json` | The exact DOM of every distinct stimulus shown |
| `profile.json` | The settings object the extension loads |
| `data_dictionary.csv` | One line per column above |

**Aligning video with data:** every row has `t_perf`, milliseconds since the session's time origin. `frames.csv` maps `t_perf` to `frame_index` and `segment`; `video_segments.csv` gives each part's start time. The two `sync_flash_on` events in `events.csv` should appear as a brightness step on the face in the first and last part. Check that on the pilot (step 12 of the build checklist).

A complete profile still needs **both** sessions for a child; merge on `child_id` (see `covers` / `missing` in each `profile.json`).

### Reading the gaze output

Unchanged from v4.2: every gaze row carries this participant's measured accuracy, and `interpretable` says whether a zone contrast is resolvable. v5 adds precision both ways (RMS sample-to-sample and SD), data loss, whether the pre-declared rule was met, and drift before each block. There are still deliberately no fixation or regression measures.

## Protocol conformance

See `source/docs/PROTOCOL_CHANGES_v5.md`. **v5 records face video and uploads to Google Drive, which v4.2 did not.** Both need to be in the approved protocol and on the guardian form before v5 is used with a student.
