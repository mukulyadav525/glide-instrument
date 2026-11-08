#!/usr/bin/env python3
"""Verify one uploaded session folder against its manifest."""
import csv, hashlib, json, pathlib, subprocess, sys

root = pathlib.Path(sys.argv[1])
sid = sys.argv[2]
folders = [p for p in root.glob("GLIDE_Study_Data/participants/*/*/*_" + sid)]
assert len(folders) == 1, folders
f = folders[0]
print("folder:", f.relative_to(root))
m = json.loads((f / "manifest.json").read_text())
bad = 0
for e in m["files"]:
    p = f / e["path"]
    if not p.exists():
        print("  MISSING", e["path"]); bad += 1; continue
    h = hashlib.sha256(p.read_bytes()).hexdigest()
    ok = h == e["sha256"] and p.stat().st_size == e["bytes"]
    rows = None
    if p.suffix == ".csv":
        with open(p) as fh: rows = sum(1 for _ in csv.reader(fh)) - 1
    vid = ""
    if p.suffix in (".webm", ".mp4"):
        r = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
                            "stream=codec_name,width,height,nb_read_frames", "-of", "csv=p=0", str(p)], capture_output=True, text=True)
        vid = "ffprobe: " + (r.stdout.strip() or r.stderr.strip()[:120])
    flag = "ok " if ok else "BAD"
    if not ok: bad += 1
    rowtxt = "" if rows is None else f" rows={rows}" + ("" if e["rows"] in (None, rows) else f" (manifest {e['rows']})")
    print(f"  {flag} {e['path']:<24} {e['bytes']:>9} B{rowtxt} {vid}")
extra = sorted(str(p.relative_to(f)) for p in f.rglob("*") if p.is_file())
listed = {e["path"] for e in m["files"]} | {"manifest.json"}
print("  not in manifest:", [x for x in extra if x not in listed])
print("dictionary_missing:", m["dictionary_missing"])
print("consent:", m["consent"])
print("video:", {k: m["video"][k] for k in ["consented","deleted","codec","segments","camera_label"]})
print("clock epochs:", len(m["clock"]["epochs"]))
ev = list(csv.DictReader(open(f / "events.csv")))
fl = [(e["type"], e["t_perf"]) for e in ev if e["type"].startswith("sync_flash")]
print("sync flashes:", fl)
fr = list(csv.DictReader(open(f / "frames.csv")))
# Each flash should fall inside the frame-time range, i.e. be mappable to a frame index
for t, tp in fl:
    tp = float(tp)
    near = min(fr, key=lambda r: abs(float(r["t_perf"]) - tp))
    print(f"  {t} at {tp:.1f} -> nearest frame {near['frame_index']} (dt {float(near['t_perf'])-tp:+.1f} ms, segment {near['segment']})")
resp = list(csv.DictReader(open(f / "responses.csv")))
withf = [r for r in resp if r["frame_index"]]
print(f"responses: {len(resp)}, with frame_index: {len(withf)}")
on = [e for e in ev if e["type"] == "stimulus_onset"]
print("stimulus onsets:", len(on), " example detail:", on[5]["detail"][:200] if len(on) > 5 else None)
print("RESULT:", "PASS" if bad == 0 else f"FAIL ({bad})")
