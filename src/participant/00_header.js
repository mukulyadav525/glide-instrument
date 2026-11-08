"use strict";
/* ===========================================================================
   GLIDE, preference-elicitation instrument for students aged 12 and above
   Two paired sessions: CHILD (perceptual choices) + EDUCATOR (everything else)
   Instrument glide-p1-child-v5.1.0 · Schema 4.1.0
   ========================================================================= */
const INSTRUMENT_VERSION = "glide-p1-child-v5.1.0";
const SCHEMA_VERSION = "4.1.0";

/* =========================================================================
   WEBGAZER  -  READ THIS BEFORE DEPLOYING
   -------------------------------------------------------------------------
   WebGazer 3.5.3 is bundled below and both webfonts are embedded in <head>,
   so the questionnaire runs with no network at all.

   Gaze is the one exception, and that is a property of WebGazer rather than
   of this file. Its face-mesh backend loads a WebAssembly model at runtime
   from a path RELATIVE to this page:

       mediapipe/face_mesh/face_mesh.binarypb
       mediapipe/face_mesh/face_mesh_solution_simd_wasm_bin.js   (+ .wasm)
       mediapipe/face_mesh/face_mesh_solution_packed_assets_loader.js
       mediapipe/face_mesh/face_mesh_solution_packed_assets.data

   WASM cannot be inlined into an HTML document. Serve that directory beside
   this file, taking it from webgazer/dist/mediapipe/face_mesh (the matched
   pair). The standalone @mediapipe/face_mesh npm package is NOT version
   matched and aborts at startup with "Module.arguments has been replaced
   with plain arguments_".

   If the directory is missing, WebGazer still starts and the camera light
   still comes on while every reading screen records nothing. That is why the
   camera-check screen probes for real predictions and refuses to continue
   without them, and why calibration is followed by a validation step that
   measures this participant's actual error rather than citing a number from
   a paper.

   TO DEPLOY WITHOUT GAZE: change nothing. The check reports the tracker
   unusable, the gaze screens skip themselves, the reason is recorded, and the
   study runs on preference data alone.
   ========================================================================= */
