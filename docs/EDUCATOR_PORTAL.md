# Educator portal, camera preview and calibration (v5.1)

## The idea

The child's screen should show only what the child is asked about. In v5.0 the right third of the participant laptop was the educator's panel: the question text, the answer buttons, Next, the framing checks. A child reads all of that, and looks at it.

In v5.1 the special educator can open the **educator portal** on their own phone, tablet or laptop. Once it connects:

| Participant laptop (the child) | Educator portal (the educator) |
|---|---|
| Full screen: the two things to compare, the stories, the pages, the dots | The question, *Top one / Bottom one / The same*, Next, Back, Stop now |
| The spoken prompts, as before | **Live camera** with the framing oval, the face box and the eyes drawn on it, plus what to adjust in words ("move to their left", "come a little closer") |
| The red *Recording video* sign | The six framing checks, live, all session |
| Optionally, a small camera picture (see below) | During calibration: a map of the laptop screen with the dot and the camera's current guess, and whether the eyes are clear enough to record |

Every answer is still recorded on the laptop, on the laptop's clock, exactly as if it had been pressed there. The portal stores nothing. The live picture is never recorded on the portal.

## Using it

1. **Admin console:** fill in *Set up a participant laptop* once (instrument address and device key). After that, every new session shows an **Educator portal** link, and each session card has a **Portal link** button that copies it.
2. **Participant laptop:** join the session with the code, as usual. The connect screen tells you whether the portal is connected.
3. **Educator's device:** open the portal link. It already contains the join code. It connects to the laptop by itself within about 10–15 seconds. The header turns to *connected*, and the laptop switches to the child-only view.

You can also open `educator.html` directly and type the join code; the backend URL and device key are remembered once one portal link has been opened on that device.

**Keyboard on the portal:** `1`, `2`, `3` answer the comparison, the space bar records a calibration dot, and `→` / `←` move Next / Back, all as on the laptop.

**If the connection drops:** the laptop keeps the child view and shows a small grey banner while the portal reconnects by itself. To use the laptop's own controls at any time, press **Ctrl + Shift + E** on the laptop; press it again to hand them back. The portal button *Also show controls on the laptop* does the same from the portal.

**Network.** The video and the controls go directly between the two devices (WebRTC), not through Google. Both devices on the same Wi-Fi works best. On most networks, including a phone on mobile data, it also connects across networks through Google's public STUN servers. A few strict networks (some institutional firewalls) block direct connections. Then the portal stays at *connecting…* and the laptop's own panel keeps working. See *TURN server* in [IMPROVEMENTS.md](IMPROVEMENTS.md).

**Phone screens:** the portal stacks the video above the questions and starts with a smaller video. *Bigger video* expands it. The portal keeps the phone screen awake while connected.

## Camera preview on the child's screen

A small mirrored picture of the camera with the same oval, in the bottom-left corner of the laptop. The educator chooses one of three settings on the portal (or on the laptop's footer button, without a portal):

| Setting | Behaviour |
|---|---|
| **Off** | Never shown. The two framing screens still show their large preview. |
| **Only when out of frame** (default) | Appears when the face has been out of the oval, too far or too close, or lost, for 1.5 s, and disappears 1.5 s after the face is back. The child sees themselves only when that helps them come back. |
| **Always** | Shown whenever the camera is on. |

Seeing one's own face is itself a distraction, and distraction is what this study measures. So every appearance is logged (`preview_shown` / `preview_hidden` in `events.csv`, with the reason), and `session.json` holds the time shown per screen. Analysis can drop those stretches. **Recommended:** *Only when out of frame* during setup and calibration. Consider *Off* for the distractor pages if the protocol prefers no on-screen face at all.

## Calibration: what changed and why

The v5.0 calibration had a serious fault that explains most failed validations. **WebGazer trains its gaze model on every mouse click and mouse movement on the page by default.** On this instrument, the clicks are the educator's: "They are looking at the dot", the answer buttons, Next. So each press taught the model that the child was looking at the button on the right-hand panel, while the child was looking at a dot on the left. v5.1 switches mouse training off (`webgazer_mouse_training_off` in `events.csv`), so only the deliberate calibration samples train the model.

Other changes:

| v5.0 | v5.1 |
|---|---|
| Dots inside the left 62% of the screen, beside the educator panel | Dots on the **whole screen**. With the portal, the laptop is the child's screen anyway. Without it, the panel hides while dots remain, and a quiet line at the bottom says *press SPACE when the child is looking*. **Esc** shows the controls. |
| 5 training samples per dot, taken blindly, including mid-blink | Up to 8 samples per dot, each taken only when the face model sees the face, **both eyes open** and the head roughly straight. A dot with fewer than 4 clean samples does not count: the educator is told why ("eyes closed or blinking", "head turned away"), and the dot appears again. |
| All 9 dots required | At least 7 of 9. A dot that will not work can be skipped. |
| Educator presses for every dot | Optional **Automatic** mode: each dot records itself once the child has looked for about a second and the eyes are clear. The educator watches the portal map and can still press sooner. |
| Validation measured the first 1.2 s after the button, including the eyes landing and the tracker catching up | The first 350 ms are dropped (lag, not inaccuracy), then 1.5 s is measured. The same applies to drift checks. |
| A failed validation reset the model | **Add more calibration dots** keeps what was learned and adds nine more: usually better. **Start from scratch** is for when the setup changed (seat, screen angle, lights). Either counts as one of the two allowed recalibrations. |
| Educator could not see whether the child was looking | The portal shows the live face with the eyes marked, and a map of the laptop screen with the dot (blue) and the camera's current guess (orange). |

All of this is recorded. `calibration.csv` rows carry how many clean samples trained each dot and why the others were refused (`samples_json`). `calibration_retry` rows mark dots that had to be repeated. The pre-declared thresholds (≤ 5°, ≤ 30% loss, at most two recalibrations) are unchanged.

## Privacy and protocol

- The live picture on the portal is a view, like the educator looking at the child. It is not recorded or stored on the portal device. It is shown only once the camera is on, which happens only after consent.
- The connection between the devices is encrypted (WebRTC uses DTLS-SRTP). The study backend sees only the connection offer and answer, which contain the devices' network addresses, kept for 10 minutes.
- Add one sentence to the protocol: *"During the session the special educator may view the live camera image on a second study device to help the student stay in frame; this live view is not recorded."* See [PROTOCOL_CHANGES_v5.md](PROTOCOL_CHANGES_v5.md).
