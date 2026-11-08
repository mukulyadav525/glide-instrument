# What v5 changes for the protocol and consent documents

v4.2 was built against Annexure 2 and **collected less** than it was consented for: coordinates only, nothing transmitted. v5 collects **more** than v4.2 in two ways. Both must be covered by the approved protocol and the guardian form **before** v5 is used with a student.

## 1. Face video is now recorded (when consented)

| | v4.2 | v5 |
|---|---|---|
| What the camera produces | Gaze coordinates only | Gaze coordinates **and** face video (no audio), plus per-frame face measures |
| Consent | Eye tracking item | A **separate** guardian item for video, and a separate question to the student. Study, eye tracking and video can each be agreed or refused independently. |
| What is said aloud to the student | "It does not save a picture or video of you" | That sentence is kept only when video was **not** agreed. With video, the student is told a video is being made, who sees it, that a red sign shows while recording, and that they can say no or ask to stop. |
| Withdrawal | Session marked withdrawn | Also offers **keep answers, delete video**. Recording stops immediately. |
| Traceability | — | Every session records the guardian form version (`consent_form_version`) and the retention / destruction date. |

**Wording to check on the guardian form.** It needs a separate yes/no for video recording of the face, without sound. It should say what the video is for (checking and re-analysing where the eyes looked, now and in later phases of this project), who can see it (the named research team), where it is stored (see section 2), how long it is kept, and that it can be withdrawn separately from the answers.

## 2. Data now leaves the laptop: Google Drive

| | v4.2 | v5 |
|---|---|---|
| Storage | Files saved on the machine and handed to the researcher | Uploaded automatically to a Google Drive folder owned by the study account. Also kept on the laptop until cleared; a zip fallback is available. |
| Identifiers | Codes only | Codes only. Folder and file names carry codes, never names. The video itself is identifiable (a face). |
| Access | Researcher | Whoever has access to the Drive folder. Keep it unshared beyond the named team. The participant laptop's key cannot read anything back. |
| Encryption | — | Google encrypts Drive data at rest and in transit. Laptop copies sit in the browser's storage until *Clear this session* is pressed. |

**To confirm with the IRB / data-management plan:**

- that a Google account (preferably the institute's Workspace) is an approved storage location for identifiable video of minors
- the retention period
- who holds the Drive account

If Drive is not approved, use the local server (`backend/glide_local_server.py`) and the institute's approved storage instead. The folder layout is identical.

## 3. Pre-declared exclusion rules (write into the protocol before collection)

These are fixed in the instrument (`PROTOCOL` in `src/app/20_camera.js`) and written into every session's `manifest.json`:

| Rule | Value |
|---|---|
| Gaze validation accuracy | ≤ 5.0° |
| Gaze validation data loss | ≤ 30% |
| Recalibrations | At most 2; then gaze is switched off for that session |
| Drift before each gaze block | ≤ 2.5°, otherwise recalibrate or flag |
| Face visible | ≥ 70% of frames, for video-based analysis |
| Usable head pose | \|yaw\| < 20°, \|pitch\| < 20° |
| Dropped frames | ≤ 10% |

If any value changes, change it **before** the first real session, rebuild, and record the change.

## 4. Other additions (no new consent needed, but worth listing)

- Card match (screen pixel size) and an optional blind-spot task (viewing distance), both done by the educator or the student in under a minute.
- Pointer and touch positions, hover time over answer options, window focus loss, page resizes and scrolls.
- One white flash at the start and end of recording (sync marker). It can be turned off per session.
- A new educator item: how much the student moved during the camera parts.
- Session length is unchanged in practice: about 3 extra minutes with video and eye tracking (card, framing, distance, drift dots).
