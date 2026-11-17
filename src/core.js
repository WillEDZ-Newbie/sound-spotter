// ---- Sound Spotter core (pure DSP, no browser APIs) ----
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = -2 * Math.PI / len;
    for (let k = 0; k < half; k++) {
      const cr = Math.cos(step * k), ci = Math.sin(step * k);
      for (let i = k; i < n; i += len) {
        const b = i + half;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[i] - xr; im[b] = im[i] - xi; re[i] += xr; im[i] += xi;
      }
    }
  }
}
function median(a) { const b = Float64Array.from(a).sort(); return b.length ? b[b.length >> 1] : 0; }
function pct(a, p) { const b = Float64Array.from(a).sort(); return b.length ? b[Math.min(b.length - 1, Math.floor(p * b.length))] : 0; }
const dB = x => 10 * Math.log10(x + 1e-30);

const TONES = [
  { id: 'whine', f1: 16857, f2: 16863 },
  { id: 'hum100', f1: 98.8, f2: 101.7 },
  { id: 'hum50', f1: 48.4, f2: 50.7 },
  { id: 'plant346', f1: 344.3, f2: 347.3 },
  { id: 'buzz501', f1: 499.3, f2: 502.7 },
];
const FAN = [[255, 270], [515, 531], [1040, 1060]];

class Spotter {
  constructor(sr) {
    this.sr = sr; this.NL = 65536; this.NS = 4096; this.hop = Math.round(sr * 0.1);
    this.L = new Float32Array(this.NL); this.R = new Float32Array(this.NL); this.w = 0; this.n = 0;
    this.sinceS = 0; this.sinceL = 0; this.t = 0;
    this.winL = new Float64Array(this.NL); for (let i = 0; i < this.NL; i++) this.winL[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / this.NL);
    this.winS = new Float64Array(this.NS); for (let i = 0; i < this.NS; i++) this.winS[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / this.NS);
    const h = this.NL / 2;
    this.PLL = new Float64Array(h); this.PRR = new Float64Array(h); this.CRe = new Float64Array(h); this.CIm = new Float64Array(h);
    this.powDb = new Float32Array(h); this.cohDb = new Float32Array(h); this.longCount = 0;
    this.stereo = null; this.diffAcc = 0; this.sumAcc = 0;
    this.st = {}; // detector states: {on, text}
    for (const id of ['speech', 'voice', 'near', 'rhythm', 'pitch', 'whine', 'hum100', 'hum50', 'plant346', 'buzz501', 'fan', 'other', 'rumble', 'click', 'alarm']) this.st[id] = { on: false, text: '', streak: 0, miss: 0 };
    this.b1 = []; this.b2 = []; this.rumRun = 0; this.rumOff = 0;
    this.sub = []; this.prevX = 0; this.hpY = 0; this.lpZ = 0; this.hpA = 1 / (1 + 2 * Math.PI * 300 / sr); this.lpB = 1 - Math.exp(-2 * Math.PI * 4000 / sr); this.clickHold = 0;
    this.alF = -1; this.alRun = 0; this.alHold = 0;
    this.hopV = Math.round(sr * 0.05); this.sinceV = 0; this.vBase = null; this.vInit = 0; this.envHist = []; this.f0Hist = []; this.clkHist = [];
    this.rhythm = 0; this.voicedN = 0; this.f0Med = 0; this.f0Iqr = 0; this.rhyRun = 0; this.spHold = 0; this.vDbg = null;
    this.bestHist = []; this.pHist = []; this.learnRun = 0; this.pVoice = null; this.fv = null; this.hiHist = []; this.loHist = []; this.hiRatio = 0; this.silero = 0; this.sileroOn = false; this.sileroAt = -9; this.sileroRun = 0; this.voHold = 0; this.nearHold = 0; this.nearRun = 0; this.bursts = []; this.HI_MUFFLED = 0.06; this.logit = null;
    this.otherF = -1; this.lastEvent = -100; this.shortSeq = 0; this.toneTrack = new Map(); this.steadyTones = []; this.setSensitivity(1); this.shortDb = new Float32Array(this.NS / 2); this.level = -120;
  }
  push(l, r) {
    const N = l.length, NL = this.NL;
    for (let i = 0; i < N; i++) {
      const a = l[i], b = r ? r[i] : a;
      this.L[this.w] = a; this.R[this.w] = b; this.w = (this.w + 1) % NL;
      if (this.stereo === null || this.n < this.sr * 3) { const d = a - b; this.diffAcc += d * d; this.sumAcc += a * a + b * b; }
    }
    this.n += N; this.sinceS += N; this.sinceL += N; this.sinceV += N; this.t = this.n / this.sr;
    if (this.n >= this.sr * 1 && this.sumAcc > 0) this.stereo = this.diffAcc / this.sumAcc > 1e-4;
    while (this.sinceS >= this.hop) { this.sinceS -= this.hop; if (this.n >= this.NS) this.shortFrame(this.sinceS); }
    while (this.sinceV >= this.hopV) { this.sinceV -= this.hopV; if (this.n >= this.NS) this.voiceFrame(this.sinceV); }
    if (this.sinceL >= this.sr) { this.sinceL = 0; if (this.n >= NL) this.longFrame(); }
  }
  latest(buf, N, back) { // last N samples ending `back` samples before the write head
    const out = new Float64Array(N), NL = this.NL; let s = (this.w - N - (back || 0) + 2 * NL) % NL;
    for (let i = 0; i < N; i++) { out[i] = buf[s]; s++; if (s === NL) s = 0; }
    return out;
  }
  bin(f, N) { return Math.max(1, Math.min(N / 2 - 1, Math.round(f * N / this.sr))); }

  // ---------- long frame: steady tones ----------
  longFrame() {
    const NL = this.NL, h = NL / 2, w = this.winL;
    const lr = this.latest(this.L, NL), li = new Float64Array(NL), rr = this.latest(this.R, NL), ri = new Float64Array(NL);
    for (let i = 0; i < NL; i++) { lr[i] *= w[i]; rr[i] *= w[i]; }
    fft(lr, li); fft(rr, ri);
    this.longCount++; const a = 1 / Math.min(this.longCount, 20);
    for (let k = 0; k < h; k++) {
      const pl = lr[k] * lr[k] + li[k] * li[k], pr = rr[k] * rr[k] + ri[k] * ri[k];
      const cre = lr[k] * rr[k] + li[k] * ri[k], cim = li[k] * rr[k] - lr[k] * ri[k];
      this.PLL[k] += a * (pl - this.PLL[k]); this.PRR[k] += a * (pr - this.PRR[k]);
      this.CRe[k] += a * (cre - this.CRe[k]); this.CIm[k] += a * (cim - this.CIm[k]);
      const norm = (NL * NL) / 4 * 0.375 / 0.25; // rough dBFS scaling
      this.powDb[k] = dB((this.PLL[k] + this.PRR[k]) / 2 / norm);
      this.cohDb[k] = dB(Math.hypot(this.CRe[k], this.CIm[k]) / norm);
    }
    if (this.longCount < 6) return;
    const hz = this.sr / NL;
    const prom = (arr, f1, f2) => {
      const k1 = this.bin(f1, NL), k2 = this.bin(f2, NL); let pk = -1e9, kp = k1;
      for (let k = k1; k <= k2; k++) if (arr[k] > pk) { pk = arr[k]; kp = k; }
      const W = 110, G = 4, ref = [];
      for (let k = Math.max(1, k1 - W); k < k1 - G; k++) ref.push(arr[k]);
      for (let k = k2 + G + 1; k <= Math.min(h - 1, k2 + W); k++) ref.push(arr[k]);
      return { prom: pk - median(ref), f: kp * hz, k: kp, level: pk };
    };
    const coh = k => { const c = this.CRe[k] * this.CRe[k] + this.CIm[k] * this.CIm[k]; return c / (this.PLL[k] * this.PRR[k] + 1e-60); };
    const judge = (f1, f2) => {
      const p = prom(this.powDb, f1, f2);
      if (p.prom >= this.K.tonePow) return { ok: true, f: p.f, prom: p.prom, level: p.level };
      if (this.stereo && this.longCount >= 12) { const c = prom(this.cohDb, f1, f2); if (c.prom >= this.K.toneCoh && coh(c.k) >= 0.25) return { ok: true, f: c.f, prom: c.prom, level: this.powDb[c.k], faint: true }; }
      return { ok: false, prom: p.prom };
    };
    const busy = this.t - this.lastEvent < 25; // swells and knocks smear into the averaged spectrum
    const upd = (id, ok, text) => { if (busy && id !== 'whine' && id !== 'hum100' && id !== 'hum50') { ok = false; } const s = this.st[id]; if (ok) { s.streak++; s.miss = 0; if (s.streak >= 3) { s.on = true; s.text = text; } } else { s.miss++; s.streak = 0; if (s.miss >= 5) s.on = false; } };
    for (const T of TONES) { const j = judge(T.f1, T.f2); upd(T.id, j.ok, j.ok ? `${j.f.toFixed(1)} Hz · ${j.prom.toFixed(0)} dB above background${j.faint ? ' · faint (two-mic)' : ''}` : ''); }
    let fanHits = 0, ft = [];
    for (const [a, b] of FAN) { const p = prom(this.powDb, a, b); if (p.prom >= 7) { fanHits++; ft.push(p.f.toFixed(0)); } }
    upd('fan', fanHits >= 2, `tones at ${ft.join(', ')} Hz`);
    // other steady tone: block-median floor, strongest outlier 150 Hz – 20 kHz
    const BL = 48, k0 = this.bin(150, NL), kE = this.bin(Math.min(20000, this.sr / 2 - 500), NL);
    const known = k => { const f = k * hz; for (const T of TONES) if (f > T.f1 - 3 && f < T.f2 + 3) return true; for (const [a, b] of FAN) if (this.st.fan.on && f > a - 5 && f < b + 5) return true; return false; };
    const scan = (arr, thr, needCoh) => {
      let best = null; const nb = Math.floor((kE - k0) / BL), med = new Float64Array(nb);
      for (let b = 0; b < nb; b++) med[b] = median(arr.subarray(k0 + b * BL, k0 + (b + 1) * BL));
      for (let b = 1; b < nb - 1; b++) for (let i = 0; i < BL; i++) {
        const k = k0 + b * BL + i, x = (i + 0.5) / BL, fl = x < 0.5 ? med[b - 1] * (0.5 - x) + med[b] * (0.5 + x) : med[b] * (1.5 - x) + med[b + 1] * (x - 0.5);
        const p = arr[k] - fl;
        if (p >= thr && (!best || p > best.prom) && !known(k) && (!needCoh || coh(k) >= 0.3)) best = { prom: p, f: k * hz, k };
      }
      return best;
    };
    if (!busy) this.trackTones(k0, kE, BL, hz, coh);
    let o = busy ? null : scan(this.powDb, 9, false);
    if (!o && !busy && this.stereo && this.longCount >= 15) { o = scan(this.cohDb, 13, true); if (o) o.faint = true; }
    const s = this.st.other;
    if (o && Math.abs(o.f - this.otherF) < 2.5) { s.streak++; s.miss = 0; } else if (o) { s.streak = 1; this.otherF = o.f; } else { s.streak = 0; s.miss++; }
    if (o) this.otherF = o.f;
    if (s.streak >= 5) { s.on = true; s.text = `${o.f.toFixed(0)} Hz · ${o.prom.toFixed(0)} dB above background${o.faint ? ' · faint (two-mic)' : ''}`; s.miss = 0; }
    else if (s.miss >= 5 || (s.on && s.streak > 0 && s.streak < 5 && Math.abs(o.f - parseFloat(s.text)) > 3 && ++s.miss >= 5)) s.on = false;
  }

  // ---------- short frame: events ----------
  shortFrame(back) {
    const NS = this.NS, re = this.latest(this.L, NS, back), r2 = this.latest(this.R, NS, back), im = new Float64Array(NS);
    // clicks: differenced signal, 10 ms sub-frames over the newest hop
    const subN = Math.round(this.sr * 0.01), hl = this.latest(this.L, this.hop, back), hr = this.latest(this.R, this.hop, back); let clicked = false, ss = 0, sq = 0;
    for (let i = 0; i < this.hop; i++) {
      const x = (hl[i] + hr[i]) / 2; this.hpY = this.hpA * (this.hpY + x - this.prevX); this.prevX = x; this.lpZ += this.lpB * (this.hpY - this.lpZ); const d = this.lpZ; ss += d * d; sq += x * x;
      if ((i + 1) % subN === 0) {
        const v = dB(ss / subN); ss = 0;
        if (this.sub.length > 100 && v - median(this.sub) >= this.K.click) clicked = true;
        this.sub.push(v); if (this.sub.length > 300) this.sub.shift();
      }
    }
    this.level = dB(sq / this.hop);
    for (let i = 0; i < NS; i++) re[i] = (re[i] + r2[i]) / 2 * this.winS[i];
    fft(re, im);
    const P = new Float64Array(NS / 2), norm = NS * NS / 4 * 0.375 / 0.25;
    for (let k = 0; k < NS / 2; k++) { P[k] = (re[k] * re[k] + im[k] * im[k]) / norm; this.shortDb[k] = dB(P[k]); }
    const band = (f1, f2) => { let s = 0; for (let k = this.bin(f1, NS); k <= this.bin(f2, NS); k++) s += P[k]; return dB(s); };
    // click box
    const c = this.st.click; if (clicked) { this.clickHold = 6; c.text = 'sharp transient'; } if (clicked) this.lastClick = this.t; c.on = this.clickHold > 0; if (clicked || this.st.rumble.on) this.lastEvent = this.t; if (this.clickHold > 0) this.clickHold--;
    // rumble / vehicle swell
    const v1 = band(200, 1000), v2 = band(2500, 8000), ru = this.st.rumble;
    const base1 = this.b1.length > 50 ? pct(this.b1, 0.3) : v1, base2 = this.b2.length > 50 ? pct(this.b2, 0.3) : v2;
    const up = v1 - base1, hi = v2 - base2; this.lastUp = up; this.lastHi = hi;
    if (up >= this.K.rumble && hi < 4 && this.b1.length > 50 && (ru.on || this.rhythm < 2.0) && !this.st.speech.on && !this.st.voice.on && !this.st.near.on) { this.rumRun++; this.rumOff = 0; } else { this.rumOff++; if (this.rumOff > 3) this.rumRun = 0; }
    if (this.rumRun >= 12) { if (!ru.on) this.rumPk = 0; ru.on = true; this.rumPk = Math.max(this.rumPk, up); ru.text = `low-frequency swell · peak +${this.rumPk.toFixed(0)} dB`; }
    if (ru.on && this.rumOff >= 15) ru.on = false;
    if (!ru.on || this.b1.length < 100) { this.b1.push(v1); this.b2.push(v2); if (this.b1.length > 900) { this.b1.shift(); this.b2.shift(); } }
    // alarm-type tone 1.5–5 kHz
    const k1 = this.bin(1500, NS), k2 = this.bin(5000, NS); let pk = -1e9, kp = k1;
    for (let k = k1; k <= k2; k++) if (this.shortDb[k] > pk) { pk = this.shortDb[k]; kp = k; }
    const pr = pk - median(this.shortDb.subarray(k1, k2 + 1)), al = this.st.alarm, ne = this.st.near; this.lastPr = pr;
    // something close to the microphone: a broadband jump in the highs that is not a tone (handling, rustle, a cough, typing)
    const tonal = pr >= this.K.alarm;
    if (hi >= 10 && !tonal && this.b1.length > 50) this.nearRun++; else this.nearRun = Math.max(0, this.nearRun - 1);
    if (this.nearRun >= 2) { this.nearHold = 20; ne.text = `broadband sound close to the microphone · highs +${hi.toFixed(0)} dB`; this.nearRun = 2; }
    ne.on = this.nearHold > 0; if (this.nearHold > 0) this.nearHold--;
    // an alarm holds one pitch (0.6 s or more) or repeats the same pitch; a blip at a new pitch each time is not one
    const same = tonal && !clicked && Math.abs(kp - this.alF) <= 3;
    if (same) this.alRun++;
    else { if (this.alRun >= 2) { this.bursts.push({ t: this.t, k: this.alF }); if (this.bursts.length > 30) this.bursts.shift(); } this.alRun = tonal && !clicked ? 1 : 0; }
    this.alF = kp;
    const rep = this.bursts.filter(b => this.t - b.t < 12 && Math.abs(b.k - kp) <= 3).length;
    if ((this.alRun >= 6 || (this.alRun >= 2 && rep >= 2)) && !ne.on) { this.alHold = 20; al.text = `${(kp * this.sr / NS).toFixed(0)} Hz tone · ${pr.toFixed(0)} dB above background · ${this.alRun >= 6 ? 'held' : 'repeating'}`; }
    al.on = this.alHold > 0; if (this.alHold > 0) this.alHold--;
    this.shortSeq++;
  }
}

// ---------- voice frame (every 50 ms): muffled speech cues ----------
Spotter.prototype.voiceFrame = function (back) {
  const NS = this.NS, re = this.latest(this.L, NS, back), r2 = this.latest(this.R, NS, back), im = new Float64Array(NS);
  for (let i = 0; i < NS; i++) re[i] = (re[i] + r2[i]) / 2 * this.winS[i];
  fft(re, im);
  const kLo = this.bin(70, NS), kHi = this.bin(4000, NS), n = kHi - kLo + 1, P = new Float64Array(n);
  for (let i = 0; i < n; i++) { let a = 0; for (let j = -1; j <= 1; j++) { const k = kLo + i + j; a += re[k] * re[k] + im[k] * im[k]; } P[i] = a / 3; }
  if (!this.vBase) { this.vBase = Float64Array.from(P); this.vInit = 1; return; }
  const B = this.vBase;
  if (this.vInit < 40) { this.vInit++; for (let i = 0; i < n; i++) B[i] += (P[i] - B[i]) / this.vInit; return; }
  // speech-band level over background (150–1000 Hz), in dB
  const i1 = this.bin(150, NS) - kLo, i2 = this.bin(1000, NS) - kLo; let sp = 0, sb = 0;
  for (let i = i1; i <= i2; i++) { sp += P[i]; sb += B[i]; }
  const env = dB(sp / sb), quiet = env < 1.0;
  const al = quiet ? 0.02 : 0.0005; for (let i = 0; i < n; i++) B[i] += al * (P[i] - B[i]);
  // the wall signature (voicehunter, F-0590): what a wall lets through is everything under ~800 Hz and nothing above
  const j1 = this.bin(100, NS) - kLo, j2 = this.bin(800, NS) - kLo; let exLo = 0, exHi = 0;
  for (let i = j1; i < j2; i++) exLo += Math.max(0, P[i] - 2 * B[i]);
  for (let i = j2; i < n; i++) exHi += Math.max(0, P[i] - 2 * B[i]);
  this.loHist.push(exLo); this.hiHist.push(exHi); if (this.loHist.length > 60) { this.loHist.shift(); this.hiHist.shift(); }
  { let a = 0, b = 0; for (let i = 0; i < this.loHist.length; i++) { a += this.loHist[i]; b += this.hiHist[i]; } this.hiRatio = a > 0 ? b / a : 0; }
  // harmonic comb on the excess spectrum
  const E = new Float64Array(n); for (let i = 0; i < n; i++) E[i] = Math.max(0, Math.min(20, dB(P[i] / B[i])));
  const hzb = this.sr / NS, nC = this.bin(1300, NS) - kLo, at = f => { const x = f / hzb - kLo; if (x < 0 || x >= nC - 1) return 0; const i = Math.floor(x), fr = x - i; return E[i] * (1 - fr) + E[i + 1] * fr; };
  let best = 0, bf = 0, bh = 0;
  for (let f0 = 75; f0 <= 300; f0 += 1) {
    const H = Math.min(8, Math.floor(1250 / f0)); let on = 0, off = 0, strong = 0;
    let e1 = 0, e2 = 0;
    for (let h = 1; h <= H; h++) { const e = at(h * f0); on += e; if (e >= 6) strong++; off += at((h - 0.5) * f0); if (h === 1) e1 = e; if (h === 2) e2 = e; }
    const sc = (on - off) / H, okH = strong >= 3 || (f0 > 150 && e1 >= 8 && e2 >= 8 && off / H < 1.5 && sc >= 6);
    if (sc > best && okH) { best = sc; bf = f0; bh = strong; }
  }
  const clickNow = this.t - (this.lastClick || -9) < 0.3;
  const voiced = best >= this.K.voiced && !clickNow;
  this.envHist.push(env); this.f0Hist.push(voiced ? bf : 0); this.bestHist.push(best);
  if (this.envHist.length > 80) { this.envHist.shift(); this.f0Hist.shift(); this.bestHist.shift(); }
  if (this.envHist.length < 80) return;
  // syllable rhythm: rms of the 2–8 Hz part of the level envelope (dB), 4 s window at 20 Hz
  const N = 80, x = this.envHist; let mx = 0; for (let i = 0; i < N; i++) mx += x[i]; mx /= N;
  const band = (b1, b2) => { let p = 0; for (let b = b1; b <= b2; b++) { let cr = 0, ci = 0; for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N), a = 2 * Math.PI * b * i / N; cr += (x[i] - mx) * w * Math.cos(a); ci -= (x[i] - mx) * w * Math.sin(a); } p += cr * cr + ci * ci; } return Math.sqrt(2 * p / (N * N * 0.375)); };
  this.rhythm = band(8, 32);            // 2–8 Hz
  const slow = band(1, 3);              // 0.25–0.75 Hz
  const all = this.f0Hist.filter(v => v > 0).sort((a, b) => a - b), med0 = all.length ? all[all.length >> 1] : 0;
  const f0s = all.filter(v => Math.abs(v - med0) <= 0.25 * med0);   // drop octave slips and strays
  this.voicedAll = all.length; this.voicedN = f0s.length; this.f0Med = f0s.length ? f0s[f0s.length >> 1] : 0;
  this.f0Iqr = f0s.length > 4 ? f0s[Math.floor(f0s.length * 0.9)] - f0s[Math.floor(f0s.length * 0.1)] : 0;
  this.vDbg = { env, best, bf, rhythm: this.rhythm, slow, voicedN: this.voicedN, iqr: this.f0Iqr };
  const R = this.st.rhythm, Pi = this.st.pitch, S = this.st.speech;
  const calm = true;
  const rOk = calm && this.rhythm >= this.RHY_ON, pOk = calm && this.voicedN >= 7 && this.voicedN >= 0.6 * this.voicedAll && this.voicedAll <= 64 && this.f0Iqr >= 4;
  if (rOk) this.rhyRun = Math.min(40, this.rhyRun + 1); else this.rhyRun = Math.max(0, this.rhyRun - 2);
  R.on = this.rhyRun >= 30 || (R.on && calm && this.rhythm >= this.RHY_ON * 0.85); if (R.on) { this.rhyPk = Math.max(this.rhyPk || 0, this.rhythm); R.text = `syllable-rate pulsing · up to ${this.rhyPk.toFixed(1)} dB swing at 2–8 Hz`; } else this.rhyPk = 0;
  Pi.on = (pOk || (Pi.on && calm && this.voicedN >= 4)) && !(this.st.rumble.on && !R.on); /* an engine's harmonics are not a voice */ if (Pi.on) Pi.text = `${this.f0Med < 155 ? 'lower' : 'higher'}-pitched voice · about ${this.f0Med.toFixed(0)} Hz, moving`;
  this.bothRun = R.on && Pi.on ? (this.bothRun || 0) + 1 : 0;
  // feature vector for the learned voice-presence score (trained offline on the harness; weights arrive in model.json)
  { const e2 = x.slice(40), srt = Float64Array.from(x).sort(), bs = Float64Array.from(this.bestHist).sort(); let em = 0; for (const v of e2) em += v; em /= e2.length; let bm = 0; for (const v of bs) bm += v; bm /= bs.length;
    this.fv = { rhythm: this.rhythm, slow, voiced: this.voicedN / 80, voicedAll: this.voicedAll / 80, f0Spread: Math.min(60, this.f0Iqr) / 60, envMean: em, envRange: srt[72] - srt[8], combMean: bm, combP90: bs[72], logHi: Math.log10(Math.min(1, this.hiRatio) + 0.01) };
    const p = this.learned('voicePresent', this.fv);
    if (p !== null) { this.pHist.push(p); if (this.pHist.length > 20) this.pHist.shift(); let a = 0; for (const v of this.pHist) a += v; this.pVoice = a / this.pHist.length;
      const thr = this.logit.voicePresent.thr[this.sens];
      if (this.pVoice >= thr && !this.st.rumble.on) this.learnRun = Math.min(60, this.learnRun + 1); else this.learnRun = Math.max(0, this.learnRun - 2); } }
  const V = this.st.voice, sil = this.t - this.sileroAt < 1.0 ? this.silero : 0, nearNow = this.st.near.on;
  if (sil >= 0.5) this.sileroRun = Math.min(40, this.sileroRun + 1); else this.sileroRun = Math.max(0, this.sileroRun - 1);
  // three independent votes that a voice is present: the hand rules, the learned score, and the Silero voice model
  const evid = this.bothRun >= 40 || this.learnRun >= 30 || this.sileroRun >= 10, heard = this.sileroRun >= 6;
  // muffled or clear is decided by the highs alone (the wall signature). Once an event reads as through-wall it takes clearly more highs to change its mind.
  const clear = evid && this.hiRatio >= (this.spHold > 0 ? 2 : 1) * this.HI_MUFFLED;
  if (evid && !clear && !nearNow) this.spHold = 60; else if (this.spHold > 0) this.spHold--;
  // a clear voice is the voice model's home ground (12/12 on the harness): if it is running and hears nothing, this is not a voice
  if (evid && clear && (heard || !this.sileroOn)) this.voHold = 60; else if (this.voHold > 0) this.voHold--;
  if (evid && clear && this.sileroOn && !heard && this.voHold === 0) { this.nearHold = Math.max(this.nearHold, 10); this.st.near.text = 'voice-like sound with highs, but the voice model hears no voice'; }
  if (this.voHold > 0 && this.spHold > 0 && clear) this.spHold = 0;         // it turned out to be a clear voice
  S.on = this.spHold > 0;
  if (S.on && evid) S.text = `through-wall signature · pitch about ${this.f0Med.toFixed(0)} Hz, speech rhythm, almost nothing above 800 Hz (${(this.hiRatio * 100).toFixed(0)}%)` + (this.pVoice !== null ? ` · learned score ${(this.pVoice * 100).toFixed(0)}%` : '') + (this.sileroOn ? ` · voice model ${heard ? 'agrees' : 'silent'}` : '');
  V.on = this.voHold > 0;
  if (V.on && evid && clear) V.text = `clear voice or TV in the room · highs ${(this.hiRatio * 100).toFixed(0)}% of lows` + (this.sileroOn ? ' · voice model agrees' : '') + (this.f0Med ? ` · pitch about ${this.f0Med.toFixed(0)} Hz` : '');
};
// what the detector was measuring: kept with every logged event so labelled events can train the model
Spotter.prototype.snapshot = function () {
  const r = v => Math.round(v * 1000) / 1000;
  return { level: r(this.level), hiRatio: r(this.hiRatio), rhythm: r(this.rhythm), rhythmPk: r(this.rhyPk || 0), voicedN: this.voicedN, voicedAll: this.voicedAll || 0, f0: this.f0Med, f0Spread: this.f0Iqr,
    silero: r(this.t - this.sileroAt < 1.0 ? this.silero : 0), rumbleUp: r(this.lastUp || 0), hiUp: r(this.lastHi || 0), tonePr: r(this.lastPr || 0), near: this.st.near.on ? 1 : 0, stereo: this.stereo ? 1 : 0 };
};
// model.json: thresholds (and later, learned weights) that change the detector without a code change
Spotter.prototype.applyModel = function (m) {
  if (!m) return; this.model = m;
  if (m.K && m.K[this.sens]) Object.assign(this.K, m.K[this.sens]);
  if (m.RHY_ON) this.RHY_ON = m.RHY_ON[this.sens]; if (m.HI_MUFFLED) this.HI_MUFFLED = m.HI_MUFFLED;
  this.logit = m.logit || null;
};
Spotter.prototype.learned = function (kind, snap) {   // -> probability the event is real, or null if nothing has been learned for it
  const L = this.logit && this.logit[kind]; if (!L) return null;
  let z = L.b; for (const k in L.w) z += L.w[k] * (((snap[k] || 0) - (L.mean[k] || 0)) / (L.sd[k] || 1));
  return 1 / (1 + Math.exp(-z));
};
Spotter.prototype.RHY_ON = 1.6;

// ---------- list of every steady tone (150 Hz – 20 kHz) ----------
Spotter.prototype.trackTones = function (k0, kE, BL, hz, coh) {
  const found = [];
  const collect = (arr, thr, needCoh, faint) => {
    const nb = Math.floor((kE - k0) / BL), med = new Float64Array(nb);
    for (let b = 0; b < nb; b++) med[b] = median(arr.subarray(k0 + b * BL, k0 + (b + 1) * BL));
    for (let b = 1; b < nb - 1; b++) for (let i = 0; i < BL; i++) {
      const k = k0 + b * BL + i, x = (i + 0.5) / BL, fl = x < 0.5 ? med[b - 1] * (0.5 - x) + med[b] * (0.5 + x) : med[b] * (1.5 - x) + med[b + 1] * (x - 0.5);
      const p = arr[k] - fl;
      if (p >= thr && arr[k] >= arr[k - 1] && arr[k] >= arr[k + 1] && (!needCoh || coh(k) >= 0.3)) found.push({ f: k * hz, prom: p, faint });
    }
  };
  collect(this.powDb, 9, false, false);
  if (this.stereo && this.longCount >= 15) collect(this.cohDb, 13, true, true);
  found.sort((a, b) => (a.faint - b.faint) || (b.prom - a.prom));
  const acc = [];
  for (const p of found) { if (acc.length >= 40) break; if (!acc.some(q => Math.abs(q.f - p.f) < Math.max(3, p.f * 0.004))) acc.push(p); }
  const seen = new Set();
  for (const p of acc) {
    const key = Math.round(p.f / 3); let t = this.toneTrack.get(key) || this.toneTrack.get(key - 1) || this.toneTrack.get(key + 1);
    if (!t) { t = { streak: 0, miss: 0 }; this.toneTrack.set(key, t); }
    if (seen.has(t)) continue;
    t.f = p.f; t.prom = p.prom; t.faint = p.faint; t.streak++; t.miss = 0; seen.add(t);
  }
  for (const [k, t] of this.toneTrack) if (!seen.has(t)) { t.miss++; if (t.miss >= 5) this.toneTrack.delete(k); }
  this.steadyTones = [...this.toneTrack.values()].filter(t => t.streak >= 5).sort((a, b) => a.f - b.f);
};
Spotter.prototype.setSensitivity = function (l) {
  this.sens = l;
  this.K = { tonePow: [7, 6, 5][l], toneCoh: [9, 8, 7][l], rumble: [6, 5, 4][l], click: [14, 12, 10][l], alarm: [18, 15, 12][l], voiced: [5.5, 4.5, 4][l] };
  this.RHY_ON = [1.9, 1.6, 1.4][l];
  if (this.model) this.applyModel(this.model);
};
if (typeof module !== 'undefined') module.exports = { Spotter, fft };
