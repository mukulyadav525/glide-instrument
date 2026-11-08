/* =========================================================================
   SHARED · FACE OVERLAY
   -------------------------------------------------------------------------
   Built into BOTH the participant laptop (its optional camera preview) and
   the educator portal (the live video). One drawing, so the educator and the
   laptop always show the same oval and the same judgement.

   Input is a face-quality row as FACEQ produces it (box and eye centres in
   the pixel frame WebGazer analysed, img_w x img_h) plus the six framing
   checks. The video is shown mirrored, like a mirror, with object-fit:cover,
   so the box is mapped through the same crop and flip.
   ========================================================================= */
const FACE_OVAL = { cx: 0.5, cy: 0.48, rx: 0.17, ry: 0.31 };   // same oval as the framing screen (34% x 62% of the frame)

function faceMapper(f, bw, bh) {
  const iw = (f && f.img_w) || 640, ih = (f && f.img_h) || 480;
  const s = Math.max(bw / iw, bh / ih), ox = (bw - iw * s) / 2, oy = (bh - ih * s) / 2;
  return (x, y) => [bw - (x * s + ox), y * s + oy];
}

/* What the educator should do, in words, from the checks. Child's own
   left/right: the picture is mirrored, so "move left" is the child's left. */
function faceAdvice(f, checks) {
  if (!f) return "Waiting for the camera";
  if (!f.face_detected) return "No face in view: bring the child back in front of the screen";
  const out = [];
  const iw = f.img_w || 640, ih = f.img_h || 480;
  const cx = (f.box_x + f.box_w / 2) / iw, cy = (f.box_y + f.box_h / 2) / ih;
  if (cx < 0.38) out.push("move to their left");
  else if (cx > 0.62) out.push("move to their right");
  if (cy < 0.32) out.push("sit lower or tilt the screen up");
  else if (cy > 0.66) out.push("sit up or tilt the screen down");
  if (checks && checks.distance && checks.distance.g !== "g" && checks.distance.why) out.push(checks.distance.why === "too far back" ? "come a little closer" : checks.distance.why === "too close" ? "sit a little further back" : "");
  if (checks && checks.eyes && checks.eyes.g === "r") out.push("face the screen");
  if (checks && checks.lighting && checks.lighting.g === "r") out.push(checks.lighting.why);
  const s = out.filter(Boolean);
  return s.length ? s.join(" · ") : "Good";
}

function drawFaceOverlay(cv, f, o) {
  o = o || {};
  const W = cv.clientWidth || cv.width, H = cv.clientHeight || cv.height, dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const c = cv.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  const fresh = f && (o.age_ms === undefined || o.age_ms < 1500);
  const face = fresh && f.face_detected && f.box_w;
  const good = !!o.pass, col = good ? "#3FB37F" : face ? "#E0A526" : "#E0533D";
  // the oval the face should sit in
  c.lineWidth = Math.max(2, W / 160);
  c.setLineDash(good ? [] : [W / 40, W / 60]);
  c.strokeStyle = good ? col : "rgba(255,255,255,.92)";
  c.beginPath(); c.ellipse(W * FACE_OVAL.cx, H * FACE_OVAL.cy, W * FACE_OVAL.rx, H * FACE_OVAL.ry, 0, 0, Math.PI * 2); c.stroke();
  c.setLineDash([]);
  if (face) {
    const m = faceMapper(f, W, H);
    const a = m(f.box_x, f.box_y), b = m(f.box_x + f.box_w, f.box_y + f.box_h);
    const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]), x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
    c.strokeStyle = col; c.lineWidth = Math.max(2, W / 200);
    c.strokeRect(x0, y0, x1 - x0, y1 - y0);
    // eye centres: green open, amber closed or hidden
    const eyesOpen = f.ear_left !== null && Math.min(f.ear_left, f.ear_right) > 0.15;
    (o.pts ? [o.pts.le, o.pts.re] : []).forEach(p => {
      if (!p) return; const q = m(p[0], p[1]);
      c.fillStyle = eyesOpen ? "#3FB37F" : "#E0A526";
      c.beginPath(); c.arc(q[0], q[1], Math.max(3, W / 90), 0, Math.PI * 2); c.fill();
      c.strokeStyle = "#fff"; c.lineWidth = 1.5; c.stroke();
    });
    // arrow from the face centre to the oval centre when it is well off
    const fx = (x0 + x1) / 2, fy = (y0 + y1) / 2, tx = W * FACE_OVAL.cx, ty = H * FACE_OVAL.cy;
    const d = Math.hypot(tx - fx, ty - fy);
    if (!good && d > W * 0.09) {
      const ux = (tx - fx) / d, uy = (ty - fy) / d, L = Math.min(d * 0.7, W * 0.22);
      const ex = fx + ux * L, ey = fy + uy * L, hs = Math.max(8, W / 28);
      c.strokeStyle = "#fff"; c.fillStyle = "#fff"; c.lineWidth = Math.max(3, W / 110);
      c.beginPath(); c.moveTo(fx, fy); c.lineTo(ex, ey); c.stroke();
      c.beginPath(); c.moveTo(ex, ey);
      c.lineTo(ex - ux * hs - uy * hs * 0.6, ey - uy * hs + ux * hs * 0.6);
      c.lineTo(ex - ux * hs + uy * hs * 0.6, ey - uy * hs - ux * hs * 0.6); c.closePath(); c.fill();
    }
  }
  if (o.label !== false) {
    const txt = !fresh ? "camera starting" : !f.face_detected ? "no face" : good ? "in frame" : "adjust";
    const fs = Math.max(11, W / 22);
    c.font = "600 " + fs + "px -apple-system,Segoe UI,Roboto,Arial,sans-serif";
    const tw = c.measureText(txt).width + fs;
    c.fillStyle = col; c.fillRect(6, 6, tw, fs * 1.6);
    c.fillStyle = "#fff"; c.textBaseline = "middle"; c.fillText(txt, 6 + fs / 2, 6 + fs * 0.8);
  }
}
