#!/usr/bin/env python3
"""Score a Sound Spotter export with Jev (TypeSafe System One).

    export TYPESAFE_API_KEY=...
    python tools/jev_score.py sound-spotter-export_2026-11-17.zip            # real run
    python tools/jev_score.py export.zip --dry-run                           # build requests and images, call nothing
    python tools/jev_score.py export.zip --mock                              # fake answers, to test the pipeline

For every clip in the export it sends Jev two separate requests, so the two opinions stay independent:
  A  "facts":  the detector's measurements turned into plain categorical statements (Jev cannot do arithmetic, F-0160)
  B  "image":  a spectrogram picture of the clip (experimental image input, header TypeSafe-Danger-Zone-Images)
Audio is never sent. A spectrogram is a coarse picture of the sound; treat it as less private than the numbers.

Outputs in --out (default: <zip name>_jev/): scores.csv, scores.json, one PNG per clip, and requests/*.json.
Needs numpy, scipy, matplotlib. Uses only urllib for the API (no SDK), pinned to a model version on purpose.
"""
import argparse, base64, csv, io, json, os, re, sys, time, urllib.request, urllib.error, wave, zipfile
import numpy as np
from scipy import signal

API = "https://api.typesafe.ai/v1/systemone"
KINDS = {  # option -> description; mutually exclusive, with an explicit "none" (F-0063)
    "voice through a wall": "Speech heard through a wall, floor or ceiling: pitch and syllable rhythm, almost nothing above 800 Hz",
    "voice or TV in the room": "A clear voice, radio or TV in the same room as the microphone, with high frequencies present",
    "alarm or beeper": "An electronic tone that holds one pitch, or repeats the same pitch in beeps",
    "vehicle passing": "A low rumble that rises and falls smoothly over several seconds",
    "plant or machine": "A steady hum or tone from machinery that does not change over the clip",
    "handling or movement near the microphone": "Knocks, rustling, taps, or the recording device itself being touched or moved",
    "nothing distinct": "Only steady background noise; no event stands out",
    "something else": "A real sound that fits none of the other options",
}
NOULS = {
    "held_tone": ("Is there a tone that stays at one pitch for at least half a second?", "A flat horizontal line at one frequency lasting 0.5 s or more", "No sustained single-pitch tone"),
    "repeating_beep": ("Does the same pitch occur as separate beeps more than once?", "Two or more short bursts at the same frequency", "No repeated bursts at one frequency"),
    "broadband_burst": ("Is there a sudden burst that covers low and high frequencies together?", "A vertical streak or block spanning most of the frequency range", "Energy stays in a limited frequency range"),
    "voice_like": ("Is there a pitched sound whose pitch and loudness move like speech?", "Stacked harmonic stripes that wobble and pulse a few times per second", "No moving harmonic stripes"),
    "highs_present": ("Does the event contain clear energy above 1 kHz?", "Visible energy above 1 kHz during the event", "The event is confined below about 800 Hz"),
    "smooth_swell": ("Does low-frequency energy rise and fall smoothly over several seconds?", "A gradual swell and fade below 1 kHz", "No gradual swell"),
}
SCORE = ("How strong is the evidence that a real sound from outside the recording device happened in this clip?",
         ["Nothing but steady background", "A faint or ambiguous trace", "A clear event, source uncertain", "A clear event with an identifiable source"])


def read_wav(buf):
    with wave.open(io.BytesIO(buf)) as w:
        sr, n, ch = w.getframerate(), w.getnframes(), w.getnchannels()
        x = np.frombuffer(w.readframes(n), dtype="<i2").astype(np.float64) / 32767
    return sr, x.reshape(-1, ch).mean(1) if ch > 1 else x


def undo_gain(x, name):
    m = re.search(r"gain-(plus|minus)(\d+)dB", name)
    g = 10 ** ((int(m.group(2)) * (1 if m.group(1) == "plus" else -1)) / 20) if m else 1.0
    return np.arctanh(np.clip(x / 0.95, -0.999999, 0.999999)) / g


def bucket(v, edges, names):
    for e, n in zip(edges, names):
        if v < e:
            return n
    return names[-1]


def facts(sr, x, ev):
    """Plain statements computed in code, so Jev never has to compare numbers."""
    f, t, S = signal.spectrogram(x, sr, nperseg=2048, noverlap=1536)
    Sd = 10 * np.log10(S + 1e-20)
    med = np.median(Sd, axis=1, keepdims=True)
    ex = Sd - med                                                   # dB above each frequency's own median
    dt = t[1] - t[0]
    band = lambda lo, hi: (f >= lo) & (f < hi)
    P = lambda lo, hi: S[band(lo, hi)].sum(0)
    lo, hi = P(100, 800), P(800, 4000)
    loud = lo > np.percentile(lo, 75)
    lo_ex = max(lo[loud].mean() - np.median(lo), 1e-20); hi_ex = max(hi[loud].mean() - np.median(hi), 0.0)
    ratio = hi_ex / lo_ex
    # tonal content 1.2-6 kHz: longest run at one pitch, and number of separate bursts at the commonest pitch
    kb = band(1200, 6000); pk = ex[kb].max(0); fk = f[kb][ex[kb].argmax(0)]; on = pk >= 18
    runs, cur = [], None
    for i in range(len(on)):
        if on[i] and cur and abs(fk[i] - cur[2]) < 60: cur[1] = i
        else:
            if cur: runs.append(cur)
            cur = [i, i, fk[i]] if on[i] else None
    if cur: runs.append(cur)
    runs = [r for r in runs if (r[1] - r[0] + 1) * dt >= 0.08]
    longest = max(((r[1] - r[0] + 1) * dt for r in runs), default=0.0)
    same = max((sum(1 for q in runs if abs(q[2] - r[2]) < 60) for r in runs), default=0)
    pitches = len({round(r[2] / 120) for r in runs})
    # broadband bursts: frames where most of 300 Hz-8 kHz jumps together
    wide = (ex[band(300, 8000)] > 10).mean(0); bursts = int(((wide > 0.5) & ~np.r_[False, (wide > 0.5)[:-1]]).sum())
    # slow swell of the lows
    env = 10 * np.log10(signal.medfilt(P(100, 1000), 31) + 1e-20); swell = env.max() - np.percentile(env, 10)
    fe = ev.get("features") or {}
    out = {
        "clip_length": bucket(len(x) / sr, [3, 8, 15], ["under 3 seconds", "3 to 8 seconds", "8 to 15 seconds", "over 15 seconds"]),
        "high_frequencies_during_event": bucket(ratio, [0.06, 0.25], ["almost none above 800 Hz", "some above 800 Hz", "strong above 800 Hz"]),
        "longest_single_pitch_tone": bucket(longest, [0.08, 0.5, 1.5], ["none", "a brief blip under half a second", "held for about a second", "held for more than 1.5 seconds"]),
        "bursts_at_the_same_pitch": bucket(same, [2, 3], ["no repeats", "two", "three or more"]),
        "different_pitches_among_the_blips": bucket(pitches, [1, 2, 4], ["none", "one pitch only", "two or three pitches", "many scattered pitches"]),
        "sudden_broadband_bursts": bucket(bursts, [1, 3, 8], ["none", "one or two", "several", "many"]),
        "low_frequency_swell": bucket(swell, [4, 8], ["none", "a slight rise and fall", "a clear smooth rise and fall"]),
        "loudness_change_within_clip": bucket(float(np.ptp(10 * np.log10(signal.medfilt(S.sum(0), 9) + 1e-20))), [6, 15], ["steady", "moderate change", "large change"]),
    }
    if fe:
        out["detector_saw_speech_rhythm"] = bucket(fe.get("rhythmPk", fe.get("rhythm", 0)), [1.4, 2.5], ["no", "weak", "strong"])
        out["detector_saw_moving_voice_pitch"] = "yes, around %d Hz" % round(fe["f0"]) if fe.get("f0") and fe.get("voicedN", 0) >= 7 else "no"
        if fe.get("silero") is not None: out["voice_model_heard_a_voice"] = "yes" if fe["silero"] >= 0.5 else "no"
        out["nearby_sound_box_was_lit"] = "yes" if fe.get("near") else "no"
    return out


def spectrogram_png(sr, x, path):
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    f, t, S = signal.spectrogram(x, sr, nperseg=2048, noverlap=1536); Sd = 10 * np.log10(S + 1e-20)
    k = (f >= 50) & (f <= 8000); lo = np.percentile(Sd[k], 20)
    fig, ax = plt.subplots(figsize=(8, 3.6), dpi=100)
    ax.pcolormesh(t, f[k], Sd[k], vmin=lo, vmax=lo + 45, cmap="magma", shading="auto", rasterized=True)
    ax.set_yscale("log"); ax.set_yticks([100, 300, 800, 2000, 5000]); ax.set_yticklabels(["100 Hz", "300 Hz", "800 Hz", "2 kHz", "5 kHz"])
    ax.set_xlabel("seconds"); ax.axhline(800, color="white", lw=0.5, ls=":"); fig.tight_layout(); fig.savefig(path); plt.close(fig)
    return open(path, "rb").read()


def questions(order):
    q = {k: {"type": "noul", "instructions": v[0], "criteria": {"true": v[1], "false": v[2]}} for k, v in NOULS.items()}
    q["kind"] = {"type": "choice", "instructions": "What is the main event in this clip?", "criteria": {k: KINDS[k] for k in order}}
    q["real"] = {"type": "score", "instructions": SCORE[0], "criteria": SCORE[1]}
    return q


def call(body, key, images, tries=4):
    hdr = {"Authorization": "Bearer " + key, "Content-Type": "application/json"}
    if images: hdr["TypeSafe-Danger-Zone-Images"] = "true"
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(API, json.dumps(body).encode(), hdr), timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (429, 529, 500, 502, 503) and i < tries - 1: time.sleep(0.5 * 2 ** i); continue
            raise SystemExit(f"Jev API error {e.code}: {e.read().decode()[:400]}")


def mock(body):
    rng = np.random.default_rng(abs(hash(json.dumps(body, sort_keys=True)[:200])) % 2**32); opts = list(body["questions"]["kind"]["criteria"])
    p = rng.dirichlet(np.ones(len(opts)))
    a = {k: {"noul": float(rng.random())} for k in NOULS}
    a["kind"] = {"choice": opts[int(p.argmax())], "probabilities": dict(zip(opts, map(float, p)))}
    a["real"] = {"score": float(rng.random() * 3), "probabilities": {}}
    return {"model": "mock", "answers": a, "usage": {}}


def ask(state, assets, key, args, tag, outdir, name):
    """Asks the choice twice with the options reversed (Choice leans to the first option, F-0160) and averages."""
    opts = list(KINDS); res = []
    for order in (opts, opts[::-1]):
        body = {"model": args.model, "state": state, "questions": questions(order)}
        if assets: body["assets"] = assets
        os.makedirs(f"{outdir}/requests", exist_ok=True)
        slim = dict(body, assets={k: dict(v, data_base64=f"<{len(v['data_base64'])} base64 chars>") for k, v in assets.items()}) if assets else body
        json.dump(slim, open(f"{outdir}/requests/{name}.{tag}.json", "w"), indent=1)
        if args.dry_run: return None
        res.append(mock(body) if args.mock else call(body, key, bool(assets)))
    A = [r["answers"] for r in res]
    probs = {o: float(np.mean([a["kind"].get("probabilities", {}).get(o, 0) for a in A])) for o in opts}
    best = max(probs, key=probs.get)
    return {"model": res[0].get("model"), "kind": best, "p": round(probs[best], 3), "order_flip_agrees": A[0]["kind"]["choice"] == A[1]["kind"]["choice"], "probs": {k: round(v, 3) for k, v in probs.items()},
            "real": round(float(np.mean([a["real"]["score"] for a in A])), 2), **{k: round(float(np.mean([a[k]["noul"] for a in A])), 3) for k in NOULS}}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("zip"); ap.add_argument("--out"); ap.add_argument("--model", default="jev-1.14.0")
    ap.add_argument("--dry-run", action="store_true"); ap.add_argument("--mock", action="store_true"); ap.add_argument("--no-images", action="store_true")
    args = ap.parse_args(); out = args.out or os.path.splitext(args.zip)[0] + "_jev"; os.makedirs(out, exist_ok=True)
    key = os.environ.get("TYPESAFE_API_KEY", "")
    if not (key or args.dry_run or args.mock): raise SystemExit("Set TYPESAFE_API_KEY, or use --dry-run or --mock.")
    z = zipfile.ZipFile(args.zip); meta = json.loads(z.read("labels.json")); rows = []
    evs = [e for e in meta["events"] if e.get("clip") and e["clip"] in z.namelist()]
    print(f"{len(evs)} clips with audio, of {len(meta['events'])} events; model {args.model}; app {meta.get('app')}")
    for i, ev in enumerate(evs):
        name = ev["clip"][:-4]; sr, y = read_wav(z.read(ev["clip"])); x = undo_gain(y, name)
        fx = facts(sr, x, ev)
        png = spectrogram_png(sr, x, f"{out}/{name}.png")
        stA = {"what_this_is": "Measurements of a short sound clip recorded in a quiet flat at night. The detector that saved the clip is named, but it is often wrong.", "detector_that_fired": ev["detector"], "measurements": fx}
        a = ask(stA, None, key, args, "facts", out, name)
        b = None
        if not args.no_images:
            ref = "spectrogram-" + re.sub(r"[^a-z0-9]+", "-", name.lower())[-40:]
            stB = {"what_this_is": "A spectrogram of a short sound clip recorded in a quiet flat at night. Time runs left to right in seconds. Frequency runs bottom to top on a log scale from 50 Hz to 8 kHz; the dotted line is 800 Hz. Brighter is louder.", "spectrogram": ref}
            b = ask(stB, {ref: {"type": "image", "format": "png", "data_base64": base64.b64encode(png).decode()}}, key, args, "image", out, name)
        row = {"clip": ev["clip"], "start": ev["start"], "detector": ev["detector"], "your_label": ev.get("label") or "", "facts": fx, "jev_facts": a, "jev_image": b}
        if a and b: row["two_opinions_agree"] = a["kind"] == b["kind"]
        rows.append(row); print(f"  {i + 1}/{len(evs)} {name[:60]}", "" if args.dry_run else f"-> facts: {a['kind']} ({a['p']})" + (f" | image: {b['kind']} ({b['p']})" if b else ""))
    json.dump({"export": os.path.basename(args.zip), "model": args.model, "rows": rows}, open(f"{out}/scores.json", "w"), indent=1)
    if not args.dry_run:
        with open(f"{out}/scores.csv", "w", newline="") as fh:
            w = csv.writer(fh); w.writerow(["start", "detector", "your_label", "jev_facts", "p", "jev_image", "p", "agree", "real_0to3_facts", "real_0to3_image", "flip_ok_facts", "flip_ok_image", "clip"])
            for r in rows:
                a, b = r["jev_facts"], r["jev_image"] or {}
                w.writerow([r["start"], r["detector"], r["your_label"], a["kind"], a["p"], b.get("kind", ""), b.get("p", ""), r.get("two_opinions_agree", ""), a["real"], b.get("real", ""), a["order_flip_agrees"], b.get("order_flip_agrees", ""), r["clip"]])
        agree = [r["two_opinions_agree"] for r in rows if "two_opinions_agree" in r]
        if agree: print(f"facts and image opinions agree on {sum(agree)}/{len(agree)} clips")
    print("wrote", out)


if __name__ == "__main__":
    main()
