// ---- UI ----
const BOXES = [
  { id:'speech',   name:'Muffled speech',    what:'Through-wall voice: pitch and rhythm, no highs', c:'#ff7ab6' },
  { id:'voice',    name:'Voice in the room', what:'Clear voice or TV, highs intact',             c:'#7ab8ff' },
  { id:'near',     name:'Nearby sound',      what:'Handling, rustle or movement close to the mic', c:'#b7c0c9' },
  { id:'rhythm',   name:'Speech rhythm',     what:'Loudness pulsing at syllable rate, 2–8 Hz',  c:'#f5a3c7' },
  { id:'pitch',    name:'Voice pitch',       what:'Moving harmonic pitch, 75–300 Hz',           c:'#e0b3ff' },
  { id:'alarm',    name:'Alarm-type tone',   what:'Strong tone or beeping, 1.5–5 kHz',          c:'#ff5d5d' },
  { id:'whine',    name:'High whine',        what:'Steady 16.86 kHz electronic tone',           c:'#c58bff' },
  { id:'other',    name:'Other steady tone', what:'Any other constant pitch, 150 Hz–20 kHz',    c:'#ff8ad1' },
  { id:'rumble',   name:'Low rumble',        what:'10-second swell, e.g. a vehicle passing',    c:'#ffb347' },
  { id:'click',    name:'Click or knock',    what:'Sharp, short sound',                          c:'#ffe066' },
  { id:'hum100',   name:'Mains hum',         what:'100 Hz electrical hum',                       c:'#5fd0a5' },
  { id:'hum50',    name:'Low hum',           what:'49–50 Hz motor or mains',                     c:'#4fc3d9' },
  { id:'plant346', name:'Plant tone',        what:'346 Hz tone seen at 02:40',                   c:'#6fa8ff' },
  { id:'buzz501',  name:'Electrical buzz',   what:'501 Hz mains-locked buzz',                    c:'#9aa7ff' },
  { id:'fan',      name:'Laptop fan',        what:'Fan tones near 262, 525, 1050 Hz',            c:'#8b96a1' },
];
const PHONE = /Android|iPhone|iPad/i.test(navigator.userAgent);
if (PHONE) BOXES.splice(BOXES.findIndex(b => b.id === 'fan'), 1);
const META = { manual: { name: 'Saved by hand', c: '#ffffff' } }; for (const b of BOXES) META[b.id] = b;
const CLIP_IDS = new Set(['speech', 'voice', 'alarm', 'rumble']);
const VERSION = 'v4.1';
const LABELS = ['Real: voice through a wall', 'Real: voice or TV in my room', 'Real: alarm', 'Real: vehicle', 'Real: plant or machine', 'Real: something else', 'Not real: me or the device', 'Not real: nothing there'];
let MODEL = __MODEL__;
const $ = id => document.getElementById(id);
const els = {}, live = {};
for (const b of BOXES) {
  const d = document.createElement('div'); d.className = 'box'; d.style.setProperty('--c', b.c);
  d.innerHTML = `<span class="dot"></span><h2>${b.name}</h2><div class="what">${b.what}</div><div class="now"></div><div class="last">Not heard yet</div>`;
  $('grid').appendChild(d); els[b.id] = d; live[b.id] = { on: false, count: 0, row: null };
}
const clock = ms => new Date(ms).toLocaleTimeString('en-GB');
const fmtDur = s => s < 60 ? s.toFixed(1) + ' s' : s < 3600 ? (s / 60).toFixed(1) + ' min' : (s / 3600).toFixed(1) + ' h';
const fmtGap = s => s < 90 ? Math.round(s) + ' s' : Math.floor(s / 60) + ' min ' + Math.round(s % 60) + ' s';
const fmtHz = f => f < 1000 ? f.toFixed(0) + ' Hz' : (f / 1000).toFixed(2) + ' kHz';

let ctx, stream, node, sp, running = false, paused = false, startedAt = 0, statusBase = '', wake = null;
let micInfo = null, micChecks = [], check = null, hearing = null;
let rows = [], dirty = false, clips = [], pending = [];
let ring = null, ringN = 0, rw = 0, tot = 0, lastSeq = 0, lastSec = -1;
const KEY = 'soundspotter.log.v3';

// ---------- log ----------
function addRowDom(r) {
  const m = META[r.id] || { name: r.id, c: '#888' }, tr = document.createElement('tr');
  tr.innerHTML = `<td>${clock(r.s)}</td><td>${r.e ? fmtDur((r.e - r.s) / 1000) : '…'}</td><td><i class="sw" style="background:${m.c}"></i>${m.name}</td><td class="d"></td><td class="c"></td>`;
  tr.children[3].textContent = r.d || ''; r.tr = tr; $('log').prepend(tr);
  while ($('log').children.length > 300) { const last = $('log').lastChild; last.remove(); }
}
function save() { if (!dirty) return; dirty = false; try { localStorage.setItem(KEY, JSON.stringify(rows.slice(-2000).map(r => ({ s: r.s, e: r.e, id: r.id, d: r.d, label: r.label, f: r.f })))); } catch (e) {} }
try { for (const r of JSON.parse(localStorage.getItem(KEY) || '[]')) { if (!r.e) r.e = r.s; rows.push(r); } rows.slice(-300).forEach(addRowDom); } catch (e) {}

function transitions(now) {
  for (const b of BOXES) {
    const s = sp.st[b.id], l = live[b.id], el = els[b.id];
    if (s.on && !l.on) {
      l.on = true; l.count++; const r = { s: now, e: null, id: b.id, d: s.text }; l.row = r; rows.push(r); if (rows.length > 6000) rows.splice(0, 1000); addRowDom(r); dirty = true;
      if (CLIP_IDS.has(b.id)) pending.push({ r, from: tot - 4 * sp.sr, to: null, max: tot + 16 * sp.sr });
      el.classList.add('on'); el.querySelector('.last').textContent = `Since ${clock(now)}`;
    } else if (!s.on && l.on) {
      l.on = false; const r = l.row; r.e = now; if (r.tr) r.tr.children[1].textContent = fmtDur((now - r.s) / 1000); dirty = true;
      for (const p of pending) if (p.r === r && p.to === null) p.to = tot + 1.5 * sp.sr;
      el.classList.remove('on'); el.classList.add('recent');
      el.querySelector('.last').textContent = `Last heard ${clock(now)} · ${l.count} time${l.count > 1 ? 's' : ''}`;
    }
    const nowEl = el.querySelector('.now');
    if (s.on && l.row && (!l.row.f || sp.rhythm >= (l.row.f.rhythm || 0))) l.row.f = Object.assign(sp.snapshot(), sp.fv ? { fv: Object.assign({}, sp.fv) } : {}, sp.pVoice !== null ? { learned: Math.round(sp.pVoice * 1000) / 1000 } : {});
    if (s.on) { if (nowEl.textContent !== s.text) { nowEl.textContent = s.text; l.row.d = s.text; if (l.row.tr) l.row.tr.children[3].textContent = s.text; } }
    else if (nowEl.textContent) nowEl.textContent = '';
  }
}

// ---------- clips ----------
function cut(from, to) {
  from = Math.max(from, tot - ringN + 1, 0); const n = Math.floor(to - from); if (n < sp.sr * 0.5) return null;
  const out = new Float32Array(n); let idx = ((rw - (tot - from)) % ringN + ringN) % ringN;
  for (let i = 0; i < n; i++) { out[i] = ring[idx]; if (++idx === ringN) idx = 0; }
  return out;
}
function makeClip(x, r) {
  let ss = 0; for (let i = 0; i < x.length; i++) ss += x[i] * x[i];
  const rms = Math.sqrt(ss / x.length) || 1e-9, g = Math.min(1000, 0.1 / rms), gdb = Math.round(20 * Math.log10(g));
  const buf = new ArrayBuffer(44 + x.length * 2), v = new DataView(buf), w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + x.length * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sp.sr, true); v.setUint32(28, sp.sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) v.setInt16(44 + i * 2, Math.tanh(x[i] * g) * 0.95 * 32767, true);
  const d = new Date(r.s), p = n => String(n).padStart(2, '0');
  const name = `sound-spotter_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}_${(META[r.id] || { name: r.id }).name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}_gain-${gdb < 0 ? 'minus' : 'plus'}${Math.abs(gdb)}dB.wav`;
  const clip = { url: URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })), name, r }; r.clip = clip; clips.push(clip);
  if (r.tr) {
    const c = r.tr.children[4], play = document.createElement('button'), a = document.createElement('a');
    play.textContent = '▶ Play'; play.onclick = () => playClip(clip, play); a.textContent = 'Save'; a.href = clip.url; a.download = name;
    const sel = document.createElement('select'); sel.className = 'lab'; sel.setAttribute('aria-label', 'What was this?');
    sel.innerHTML = '<option value="">What was it?</option>' + LABELS.map(l => `<option>${l}</option>`).join('');
    sel.value = r.label || ''; sel.onchange = () => { r.label = sel.value || undefined; sel.classList.toggle('set', !!r.label); dirty = true; save(); countLabels(); };
    c.append(play, a, sel);
  }
  countLabels();
  while (clips.length > 40) { const old = clips.shift(); URL.revokeObjectURL(old.url); old.r.clip = null; if (old.r.tr) old.r.tr.children[4].textContent = 'expired'; }
}
const player = $('player'); let playingBtn = null;
function playClip(clip, btn) {
  if (playingBtn === btn && !player.paused) { player.pause(); return; }
  if (playingBtn) playingBtn.textContent = '▶ Play';
  playingBtn = btn; btn.textContent = '■ Stop'; paused = true; player.src = clip.url; player.play().catch(() => {});
}
player.onpause = player.onended = () => { if (playingBtn) playingBtn.textContent = '▶ Play'; setTimeout(() => { if (player.paused) paused = false; }, 500); };
function countLabels() { const m = clips.length, n = rows.filter(r => r.label).length; $('zip').textContent = m ? `Export ${m} clip${m > 1 ? 's' : ''} and the log for analysis (.zip)` + (n ? ` · ${n} labelled` : '') : 'Export clips and log for analysis (.zip)'; $('zip').disabled = !m; }
// minimal ZIP writer (stored, no compression) so the labelled set leaves the page as one file
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zip(files) {
  const enc = new TextEncoder(), parts = [], cen = []; let off = 0;
  for (const f of files) { const nm = enc.encode(f.name), crc = crc32(f.data), h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint32(14, crc, true); h.setUint32(18, f.data.length, true); h.setUint32(22, f.data.length, true); h.setUint16(26, nm.length, true);
    parts.push(new Uint8Array(h.buffer), nm, f.data);
    const c = new DataView(new ArrayBuffer(46)); c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint32(16, crc, true); c.setUint32(20, f.data.length, true); c.setUint32(24, f.data.length, true); c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
    cen.push(new Uint8Array(c.buffer), nm); off += 30 + nm.length + f.data.length; }
  let cs = 0; for (const p of cen) cs += p.length; const e = new DataView(new ArrayBuffer(22)); e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cs, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...cen, new Uint8Array(e.buffer)], { type: 'application/zip' });
}
$('zip').onclick = async () => {
  const lab = rows.filter(r => r.s >= startedAt - 1000 || r.label || r.clip), files = [];   // everything from this session: no labelling needed
  for (const r of lab) if (r.clip) files.push({ name: r.clip.name, data: new Uint8Array(await (await fetch(r.clip.url)).arrayBuffer()) });
  const meta = { app: 'Sound Spotter ' + VERSION, model: MODEL.version, exported: new Date().toISOString(), device: navigator.userAgent, mic: statusBase.replace(/<[^>]+>/g, ''), micInfo, micChecks, steadyTones: sp ? sp.steadyTones.map(t => ({ hz: +t.f.toFixed(1), faint: !!t.faint, name: toneName(t.f) })) : [], stereo: sp ? sp.stereo : null,
    events: lab.map(r => ({ start: new Date(r.s).toISOString(), end: r.e ? new Date(r.e).toISOString() : null, detector: r.id, detail: r.d, label: r.label, clip: r.clip ? r.clip.name : null, features: r.f || null })) };
  files.push({ name: 'labels.json', data: new TextEncoder().encode(JSON.stringify(meta, null, 1)) });
  const a = document.createElement('a'); a.href = URL.createObjectURL(zip(files)); a.download = 'sound-spotter-export_' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.zip'; a.click();
};
$('snap').onclick = () => { if (!running) return; const x = cut(tot - 30 * sp.sr, tot); if (!x) return; const now = Date.now(), r = { s: now - x.length / sp.sr * 1000, e: now, id: 'manual', d: 'the last ' + Math.round(x.length / sp.sr) + ' seconds' }; rows.push(r); addRowDom(r); makeClip(x, r); dirty = true; };

// ---------- live spectrogram ----------
const water = $('water'), wctx = water.getContext('2d', { willReadFrequently: false }); let wf = null;
const LUT = (() => { const st = [[0, 11, 14, 18], [0.25, 43, 27, 90], [0.5, 139, 47, 119], [0.75, 240, 128, 60], [1, 255, 243, 176]], out = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) { const t = i / 255; let j = 0; while (j < st.length - 2 && t > st[j + 1][0]) j++; const a = st[j], b = st[j + 1], u = (t - a[0]) / (b[0] - a[0]); for (let c = 0; c < 3; c++) out[i * 3 + c] = a[c + 1] + (b[c + 1] - a[c + 1]) * u; } return out; })();
function initWater() {
  const W = Math.max(200, Math.floor(water.clientWidth)), H = Math.floor(water.clientHeight); water.width = W; water.height = H;
  wctx.fillStyle = '#0b0e12'; wctx.fillRect(0, 0, W, H);
  const fmax = Math.min(20000, sp.sr / 2 * 0.98), fmin = 50, hzb = sp.sr / sp.NS, k1 = new Int32Array(H), k2 = new Int32Array(H), fy = y => fmax * Math.pow(fmin / fmax, y / H);
  for (let y = 0; y < H; y++) { k1[y] = Math.max(1, Math.round(fy(y + 1) / hzb)); k2[y] = Math.max(k1[y], Math.round(fy(y) / hzb) - 1); }
  wf = { W, H, k1, k2, col: wctx.createImageData(1, H), acc: new Float32Array(H).fill(-1e9), n: 0, every: W < 600 ? 2 : 1, lo: null, cnt: 0 };
  $('wfax').innerHTML = ''; for (const f of [100, 300, 1000, 3000, 10000]) { const s = document.createElement('span'); s.textContent = fmtHz(f).replace('.00', ''); s.style.top = (Math.log(f / fmax) / Math.log(fmin / fmax) * 100) + '%'; $('wfax').appendChild(s); }
}
function waterColumn() {
  if (!wf) return; const d = sp.shortDb, { H, k1, k2, acc } = wf;
  for (let y = 0; y < H; y++) { let m = -1e9; for (let k = k1[y]; k <= k2[y]; k++) if (d[k] > m) m = d[k]; if (m > acc[y]) acc[y] = m; }
  if (++wf.n < wf.every) return; wf.n = 0;
  if (wf.cnt++ % 10 === 0) { const s = Float32Array.from(acc).sort(), q = s[Math.floor(H * 0.15)] - 2; wf.lo = wf.lo === null ? q : wf.lo + 0.2 * (q - wf.lo); }
  const px = wf.col.data;
  for (let y = 0; y < H; y++) { const i = Math.max(0, Math.min(255, Math.round(Math.pow(Math.max(0, Math.min(1, (acc[y] - wf.lo) / 34)), 0.75) * 255))) * 3; px[y * 4] = LUT[i]; px[y * 4 + 1] = LUT[i + 1]; px[y * 4 + 2] = LUT[i + 2]; px[y * 4 + 3] = 255; acc[y] = -1e9; }
  wctx.drawImage(water, -1, 0); wctx.putImageData(wf.col, wf.W - 1, 0);
}

// ---------- timeline ----------
const tl = $('tl'); const laneH = PHONE ? 13 : 15, gut = PHONE ? 96 : 124;
tl.style.height = (BOXES.length * laneH + 20) + 'px';
function drawTimeline(now) {
  const W = tl.clientWidth, H = tl.clientHeight; if (tl.width !== W * 2) { tl.width = W * 2; tl.height = H * 2; }
  const g = tl.getContext('2d'); g.setTransform(2, 0, 0, 2, 0, 0); g.clearRect(0, 0, W, H);
  const span = +$('span').value * 1000, t0 = now - span, x = t => gut + (t - t0) / span * (W - gut - 4);
  g.font = (PHONE ? 10 : 11) + 'px Segoe UI, Roboto, sans-serif'; g.textBaseline = 'middle';
  const step = span <= 600000 ? 120000 : span <= 3600000 ? 600000 : 3600000; g.strokeStyle = '#2a3139'; g.fillStyle = '#8b96a1';
  for (let t = Math.ceil(t0 / step) * step; t <= now; t += step) { g.beginPath(); g.moveTo(x(t), 0); g.lineTo(x(t), H - 16); g.stroke(); g.fillText(clock(t).slice(0, 5), x(t) + 3, H - 8); }
  BOXES.forEach((b, i) => { const y = i * laneH; g.fillStyle = live[b.id].on ? '#e6e9ec' : '#8b96a1'; g.fillText(b.name, 4, y + laneH / 2); });
  const lane = {}; BOXES.forEach((b, i) => lane[b.id] = i);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i], e = r.e || now; if (r.s < t0 - span && e < t0) break; if (e < t0 || lane[r.id] === undefined) continue;
    const x1 = Math.max(gut, x(r.s)), x2 = x(e); g.fillStyle = META[r.id].c; g.fillRect(x1, lane[r.id] * laneH + 2, Math.max(1.5, x2 - x1), laneH - 4);
  }
}
$('span').onchange = () => { drawTimeline(Date.now()); if (running) summary(Date.now()); };

// ---------- plain-language summary and tone list ----------
function summary(now) {
  const on = BOXES.filter(b => live[b.id].on).map(b => b.name);
  const span = +$('span').value * 1000, label = $('span').selectedOptions[0].textContent.toLowerCase(), since = Math.max(now - span, startedAt);
  const inWin = id => rows.filter(r => r.id === id && (r.e || now) >= since && r.s >= startedAt - 1000);
  const every = rs => { if (rs.length < 3) return ''; const st = rs.map(r => r.s).sort((a, b) => a - b), d = st.slice(1).map((v, i) => (v - st[i]) / 1000), m = d.slice().sort((a, b) => a - b)[d.length >> 1];
    const ok = d.filter(v => Math.abs(v - m) <= 0.2 * m).length; return m > 5 && ok >= d.length - (d.length >= 4 ? 1 : 0) ? `, about every ${fmtGap(m)}` : ''; };
  const total = rs => fmtDur(rs.reduce((a, r) => a + ((r.e || now) - Math.max(r.s, since)) / 1000, 0));
  const parts = [], sp_ = inWin('speech'), al = inWin('alarm'), ru = inWin('rumble'), ck = inWin('click'), ot = inWin('other');
  parts.push(sp_.length ? `<b>muffled speech ${sp_.length}× (${total(sp_)})</b>` : 'no muffled speech');
  const vo = inWin('voice'); if (vo.length) parts.push(`voice in the room ${vo.length}× (${total(vo)})`);
  parts.push(al.length ? `<b>alarm-type tone ${al.length}× (${total(al)})</b>` : 'no alarm-type tones');
  if (ru.length) parts.push(`<b>low rumble ${ru.length}×</b>${every(ru)}`);
  if (ck.length) parts.push(`${ck.length} click${ck.length > 1 ? 's' : ''} or knock${ck.length > 1 ? 's' : ''}${every(ck)}`);
  if (ot.length) parts.push(`other steady tone ${ot.length}×`);
  $('summary').innerHTML = `<div class="now">Hearing now: ${on.length ? on.join(', ') : sp.longCount < 6 ? 'still warming up' : 'nothing it recognises'}.</div><div class="past">In the ${label} of this session: ${parts.join(' · ')}.</div>`;
  const tones = [];
  for (const id of ['hum50', 'hum100', 'plant346', 'buzz501', 'whine']) if (sp.st[id].on) tones.push({ f: parseFloat(sp.st[id].text), faint: /faint/.test(sp.st[id].text) });
  for (const t of sp.steadyTones) if (!tones.some(q => Math.abs(q.f - t.f) < Math.max(3, t.f * 0.004))) tones.push(t);
  tones.sort((a, b) => a.f - b.f);
  $('tones').innerHTML = tones.length ? tones.map(t => { const nm = toneName(t.f); return `<i class="${t.faint ? 'f' : ''}" data-f="${t.f.toFixed(1)}">${fmtHz(t.f)}${t.faint ? ' · faint' : ''}${nm ? ' · ' + nm : ''}</i>`; }).join('') : '<i class="f">none yet</i>';
}


// ---------- which microphone, and can it be trusted (ideas from freqmon's mic-integrity work) ----------
function processedMic(label) {
  const fams = [[/insta360/i, 'an Insta360 webcam'], [/krisp|nvidia broadcast|voicemod|sonar|nahimic/i, 'a noise-removal device'], [/airpods|buds|bluetooth|hands-?free|headset/i, 'a headset or Bluetooth microphone'], [/webcam|\bcam\b|camera/i, 'a webcam']];
  if (/realtek|conexant|synaptics|surface/i.test(label)) return null;
  for (const [re, name] of fams) if (re.test(label)) return name;
  return null;
}
function micBanner() {
  const el = $('micnote'), why = [];
  if (micInfo) {
    const on = ['echoCancellation', 'noiseSuppression', 'autoGainControl'].filter(k => micInfo[k] === true), unk = ['echoCancellation', 'noiseSuppression', 'autoGainControl'].filter(k => micInfo[k] === null);
    if (micInfo.processedFamily) why.push(`This looks like ${micInfo.processedFamily}, which usually cleans up the sound inside the device.`);
    if (on.length) why.push(`The browser left its own processing on (${on.join(', ')}).`);
    else if (unk.length === 3) why.push('The browser does not say whether its sound processing is off.');
    const last = micChecks[micChecks.length - 1];
    if (last && last.outcome === 'processed') why.push(`Mic check: ${last.summary}`);
  }
  el.style.display = why.length ? '' : 'none';
  el.textContent = why.length ? why.join(' ') + ' Faint tones and through-wall voices may be removed, and short beeps or pumping may be added, so treat detections with care.' + (micChecks.length ? '' : ' Run Mic check to test it.') : '';
}
// Mic check: plays a 1 kHz tone at two levels and holds it, to see whether the microphone follows a 10 dB step (automatic gain) and keeps a steady tone (noise cancelling).
const CHECK = [['baseline', 2, 0], ['loud', 5, 0.25], ['quiet', 5, 0.25 / Math.sqrt(10)], ['hold', 20, 0.25]];
function toneLevel(f, secs) {   // Goertzel on the newest audio
  const n = Math.min(Math.round(sp.sr * secs), tot, ringN), w = 2 * Math.cos(2 * Math.PI * f / sp.sr); let a = 0, b = 0, i = (rw - n + ringN) % ringN;
  for (let k = 0; k < n; k++) { const h = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / n), c = ring[i] * h + w * a - b; b = a; a = c; if (++i === ringN) i = 0; }
  return 10 * Math.log10((a * a + b * b - w * a * b) / (n * n / 16) + 1e-20);
}
function startCheck() {
  if (!running || check) return;
  const osc = ctx.createOscillator(), g = ctx.createGain(); osc.frequency.value = 1000; g.gain.value = 0; osc.connect(g); g.connect(ctx.destination); osc.start();
  check = { osc, g, phase: 0, t0: Date.now(), last: 0, v: [[], [], [], []], early: [] }; $('micbtn').textContent = 'Stop mic check';
}
function checkStep() {
  const c = check, now = Date.now(); let ph = c.phase, el = (now - c.t0) / 1000;
  if (el >= CHECK[ph][1]) { ph = ++c.phase; c.t0 = now; el = 0; if (ph >= CHECK.length) return endCheck('done'); c.g.gain.setTargetAtTime(CHECK[ph][2], ctx.currentTime, 0.02); }
  if (now - c.last >= 250) { c.last = now; const lv = toneLevel(1000, 0.2), dur = CHECK[ph][1];
    if (ph === 3) { if (el >= 1.5 && el < 5) c.early.push(lv); if (el >= dur - 4) c.v[3].push(lv); } else if (el >= (ph ? 2 : 0.5)) c.v[ph].push(lv);
    $('miccheck').textContent = `Mic check: ${['measuring the room', 'loud tone', 'quiet tone', 'holding the tone'][ph]}… ${Math.max(0, Math.ceil(dur - el))} s. Turn the volume up so you can hear it clearly.`; }
}
function endCheck(how) {
  const c = check; check = null; try { c.osc.stop(); } catch (e) {} $('micbtn').textContent = 'Mic check';
  const med = a => a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : NaN, r = { at: new Date().toISOString(), outcome: how === 'done' ? 'ok' : 'cancelled' };
  if (how === 'done') {
    const base = med(c.v[0]), L1 = med(c.v[1]), L2 = med(c.v[2]), early = med(c.early), late = med(c.v[3]);
    Object.assign(r, { floorDb: +base.toFixed(1), loudDb: +L1.toFixed(1), quietDb: +L2.toFixed(1), stepDb: +(L1 - L2).toFixed(1), fadeDb: +(Math.max(L1, early) - late).toFixed(1) });
    if (!(L1 >= base + 10)) { r.outcome = 'inconclusive'; r.summary = 'the microphone did not pick up the test tone. Turn the volume up and run it again; if you could hear it clearly, the microphone may be removing it.'; }
    else { const agc = r.stepDb < 5, over = r.stepDb > 15, nc = r.fadeDb > 6; r.agc = agc; r.noiseCancel = nc; r.overshoot = over;
      r.outcome = agc || over || nc ? 'processed' : 'ok';
      r.summary = r.outcome === 'ok' ? `the microphone followed a 10 dB step as ${r.stepDb} dB and kept a steady tone (faded ${Math.max(0, r.fadeDb)} dB). No sign of automatic gain or noise cancelling.`
        : [agc ? `a 10 dB quieter tone only read ${r.stepDb} dB quieter, so something is levelling the sound (automatic gain)` : '', over ? `a 10 dB step read as ${r.stepDb} dB, so something is expanding or gating the sound` : '', nc ? `a steady tone faded by ${r.fadeDb} dB while it played, so something is cancelling steady sounds` : ''].filter(Boolean).join('; ') + '.'; }
  } else r.summary = 'stopped before it finished.';
  micChecks.push(r); $('miccheck').textContent = 'Mic check: ' + r.summary; $('miccheck').className = r.outcome === 'processed' || r.outcome === 'inconclusive' ? 'cap warn' : 'cap';
  const now = Date.now(), row = { s: now, e: now, id: 'manual', d: 'Mic check (' + r.outcome + '): ' + r.summary }; rows.push(row); addRowDom(row); dirty = true; micBanner();
}
$('micbtn').onclick = () => check ? endCheck('cancelled') : startCheck();
// Names for steady tones, from the freqmon fingerprint rules. These say what a tone at that pitch is commonly from, never what it certainly is.
function toneName(f) {
  const m = Math.round(f / 50);
  if (f < 1250 && m >= 1 && Math.abs(f - m * 50) <= Math.max(0.6, f * 0.004)) return m === 1 ? 'mains hum' : m === 2 ? 'mains hum (rectifier ripple)' : `mains harmonic (${m} × 50 Hz)`;
  if (Math.abs(f - 15625) <= 40 || Math.abs(f - 15734) <= 40) return 'old TV or CRT line whistle';
  if (Math.abs(f - 17400) <= 120) return '"Mosquito" youth-deterrent pitch';
  if (f >= 15000 && f <= 17000) return 'bird or pest deterrent range, or a power-supply whine';
  if (f > 17000 && f <= 22000) return 'pest-repeller or power-supply range';
  if (Math.abs(f - 8000) <= 100) return 'deterrent at 8 kHz, or power-supply ringing';
  return '';
}
// "Can I hear this?": tap a steady tone to play that pitch for two seconds. Detection waits while it plays.
$('tones').onclick = e => {
  const el = e.target.closest('i[data-f]'); if (!el || !running || check || hearing) return;
  const f = +el.dataset.f, osc = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime; osc.frequency.value = f; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.2, t + 0.05); g.gain.setValueAtTime(0.2, t + 1.9); g.gain.linearRampToValueAtTime(0, t + 2);
  osc.connect(g); g.connect(ctx.destination); osc.start(); osc.stop(t + 2.05); hearing = Date.now() + 3500;
  $('hearnote').textContent = `Playing ${fmtHz(f)} for two seconds. If you cannot hear it with the volume up, a real tone at this pitch is probably above your hearing${f > 14000 ? ' (and small speakers are weak up here, so try headphones too)' : ''}.`;
};

// ---------- Silero VAD (the small trained voice model; runs only when the page is served over http/https) ----------
const vad = { ok: false, sess: null, state: null, ctx: new Float32Array(64), q: [], busy: false, buf: new Float32Array(512), n: 0, ratio: 3, pos: 0, prev: 0, z: [0, 0, 0, 0], co: null, rms: 1e-4 };
function vadReset(sr) {
  vad.ratio = sr / 16000; vad.pos = 0; vad.n = 0; vad.q = []; vad.prev = 0; vad.z = [0, 0, 0, 0]; vad.rms = 1e-4; vad.ctx.fill(0); if (vad.ok) vad.state = new ort.Tensor('float32', new Float32Array(256), [2, 1, 128]);
  const w0 = 2 * Math.PI * 7000 / sr, mk = Q => { const al = Math.sin(w0) / (2 * Q), c = Math.cos(w0), a0 = 1 + al; return [(1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, -2 * c / a0, (1 - al) / a0]; };
  vad.co = [mk(0.5412), mk(1.3066)]; vad.h = [0, 0];
  { const w = 2 * Math.PI * 150 / 16000, al = Math.sin(w) / (2 * 0.7071), c = Math.cos(w), a0 = 1 + al; vad.hp = [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - al) / a0]; }   // 4th-order Butterworth low-pass at 7 kHz ahead of the 16 kHz resample
}
async function vadInit() {
  if (!/^https?:$/.test(location.protocol)) return;
  try {
    await new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'vad/ort.wasm.min.js'; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
    ort.env.wasm.wasmPaths = new URL('vad/', location.href).href; ort.env.wasm.numThreads = 1;
    vad.sess = await ort.InferenceSession.create('vad/silero_vad_16k.onnx'); vad.srT = new ort.Tensor('int64', BigInt64Array.from([16000n]), []);
    vad.state = new ort.Tensor('float32', new Float32Array(256), [2, 1, 128]); vad.ok = true;
  } catch (e) { vad.ok = false; }
}
async function vadPump() {
  if (vad.busy) return; vad.busy = true;
  try { while (vad.q.length) { const fr = vad.q.shift(), inp = new Float32Array(576); inp.set(vad.ctx); inp.set(fr, 64);
      const out = await vad.sess.run({ input: new ort.Tensor('float32', inp, [1, 576]), state: vad.state, sr: vad.srT });
      vad.state = out.stateN; vad.ctx = fr.slice(448); if (sp) { sp.silero = out.output.data[0]; sp.sileroAt = sp.t; } } }
  catch (e) { vad.ok = false; }
  vad.busy = false;
}
function vadFeed(l, r) {
  if (!vad.ok) return; const n = l.length, z = vad.z, [A, B] = vad.co;
  for (let i = 0; i < n; i++) {
    let x = r ? (l[i] + r[i]) * 0.5 : l[i];
    let y = A[0] * x + z[0]; z[0] = A[1] * x - A[3] * y + z[1]; z[1] = A[2] * x - A[4] * y; x = y;
    y = B[0] * x + z[2]; z[2] = B[1] * x - B[3] * y + z[3]; z[3] = B[2] * x - B[4] * y;
    vad.pos += 1;
    while (vad.pos >= vad.ratio) { vad.pos -= vad.ratio; const fr = 1 - vad.pos, u0 = vad.prev + (y - vad.prev) * Math.min(1, Math.max(0, fr)), H = vad.hp;
      const v = H[0] * u0 + vad.h[0]; vad.h[0] = H[1] * u0 - H[3] * v + vad.h[1]; vad.h[1] = H[2] * u0 - H[4] * v;   // 150 Hz high-pass: without it the room's hum sets the level and the model hears nothing
      vad.rms += 0.00002 * (v * v - vad.rms);                                         // slow level estimate (about 3 s)
      vad.buf[vad.n++] = v * Math.min(100, 0.05 / Math.sqrt(vad.rms + 1e-12));        // level the quiet room up to where the model was trained
      if (vad.n === 512) { if (vad.q.length < 60) vad.q.push(vad.buf.slice()); vad.n = 0; } }
    vad.prev = y;
  }
  vadPump();
}
vadInit();
if (/^https?:$/.test(location.protocol)) fetch('model.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(m => { if (m && m.version) { MODEL = m; if (sp) sp.applyModel(m); } }).catch(() => {});

// ---------- audio ----------
function onChunk(l, r) {
  if (paused || !running) return;
  const n = l.length; for (let i = 0; i < n; i++) { ring[rw] = r ? (l[i] + r[i]) * 0.5 : l[i]; if (++rw === ringN) rw = 0; } tot += n;
  if (check) { checkStep(); return; }   // the page's own test tone must never reach the detectors or the log
  if (hearing) { if (Date.now() > hearing) hearing = null; return; }
  sp.sileroOn = vad.ok; vadFeed(l, r); sp.push(l, r); const now = Date.now(); transitions(now);
  for (let i = pending.length - 1; i >= 0; i--) { const p = pending[i]; if ((p.to !== null && tot >= p.to) || tot >= p.max) { pending.splice(i, 1); const x = cut(p.from, Math.min(tot, p.to === null ? p.max : p.to)); if (x) makeClip(x, p.r); } }
  if (sp.shortSeq !== lastSeq) { lastSeq = sp.shortSeq; waterColumn(); }
  const sec = Math.floor(sp.t); if (sec !== lastSec) { lastSec = sec; summary(now); drawTimeline(now); if (sec % 5 === 0) save(); }
}
async function listMics(keep) {
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput' && d.deviceId !== 'communications');
  const sel = $('mic'); sel.innerHTML = '';
  for (const d of devs) { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || 'Microphone'; sel.appendChild(o); }
  const pick = keep || (devs.find(d => /surface/i.test(d.label) && d.deviceId !== 'default') || {}).deviceId;
  if (pick) sel.value = pick;
}
async function start() {
  try {
    const want = id => ({ audio: { deviceId: id ? { exact: id } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 } } });
    stream = await navigator.mediaDevices.getUserMedia(want($('mic').value));
    const before = $('mic').value; await listMics(before);
    if (!before && $('mic').value && stream.getAudioTracks()[0].getSettings().deviceId !== $('mic').value) { stream.getTracks().forEach(t => t.stop()); stream = await navigator.mediaDevices.getUserMedia(want($('mic').value)); }
    const tr = stream.getAudioTracks()[0], set = tr.getSettings();
    ctx = new AudioContext({ sampleRate: set.sampleRate || 48000, latencyHint: 'playback' }); await ctx.resume();
    sp = new Spotter(ctx.sampleRate); sp.applyModel(MODEL); sp.setSensitivity(+$('sens').value); vadReset(ctx.sampleRate);
    ringN = Math.round(ctx.sampleRate * 45); ring = new Float32Array(ringN); rw = 0; tot = 0; lastSeq = 0; lastSec = -1; pending = [];
    for (const b of BOXES) live[b.id].on = false;
    initWater();
    const src = ctx.createMediaStreamSource(stream); node = ctx.createScriptProcessor(4096, 2, 1);
    const mute = ctx.createGain(); mute.gain.value = 0;
    node.onaudioprocess = e => { const b = e.inputBuffer; onChunk(b.getChannelData(0), b.numberOfChannels > 1 ? b.getChannelData(1) : null); };
    src.connect(node); node.connect(mute); mute.connect(ctx.destination);
    running = true; paused = false; startedAt = Date.now(); $('go').textContent = 'Stop'; $('go').classList.remove('primary'); $('snap').disabled = false;
    const proc = ['echoCancellation', 'noiseSuppression', 'autoGainControl'].filter(k => set[k] === true);
    const tri = k => set[k] === true ? true : set[k] === false ? false : null, fam = processedMic(tr.label);
    micInfo = { label: tr.label, sampleRate: ctx.sampleRate, channelCount: set.channelCount || null, echoCancellation: tri('echoCancellation'), noiseSuppression: tri('noiseSuppression'), autoGainControl: tri('autoGainControl'), processedFamily: fam };
    const st = document.createElement('b'); st.textContent = tr.label;
    statusBase = st.outerHTML + ` · ${ctx.sampleRate} Hz` + (proc.length ? ` · <span class="warn">browser processing still on: ${proc.join(', ')}</span>` : ' · browser processing off');
    micChecks = []; $('micbtn').disabled = false; micBanner();
    try { wake = await navigator.wakeLock.request('screen'); } catch (e) {}
    draw();
  } catch (e) { $('status').innerHTML = `<span class="warn">Could not open the microphone: ${e.message}. Allow microphone access for this page and try again.</span>`; }
}
function stop() {
  running = false; if (node) node.disconnect(); if (stream) stream.getTracks().forEach(t => t.stop()); if (ctx) ctx.close(); if (wake) { try { wake.release(); } catch (e) {} }
  for (const b of BOXES) sp.st[b.id].on = false; transitions(Date.now()); dirty = true; save(); drawTimeline(Date.now());
  if (check) endCheck('cancelled'); hearing = null; $('micbtn').disabled = true;
  $('go').textContent = 'Start listening'; $('go').classList.add('primary'); $('snap').disabled = true; $('status').textContent = 'Stopped.'; $('lvl').style.width = '0'; $('lvltxt').textContent = '';
}
$('go').onclick = () => running ? stop() : start();
$('mic').onchange = () => { if (running) { stop(); start(); } };
$('sens').onchange = () => { if (sp) sp.setSensitivity(+$('sens').value); };
document.addEventListener('visibilitychange', () => { if (running && !document.hidden) { ctx.resume(); if (navigator.wakeLock) navigator.wakeLock.request('screen').then(w => wake = w).catch(() => {}); } });
window.addEventListener('pagehide', () => { dirty = true; save(); });
window.addEventListener('resize', () => { if (running && wf && Math.abs(water.clientWidth - wf.W) > 40) initWater(); drawTimeline(Date.now()); });
$('csv').onclick = () => {
  const q = s => '"' + String(s || '').replace(/"/g, '""') + '"', iso = ms => ms ? new Date(ms).toISOString() : '';
  const csv = 'start,end,seconds,sound,detail,clip_file\n' + rows.map(r => [iso(r.s), iso(r.e), r.e ? ((r.e - r.s) / 1000).toFixed(1) : '', q((META[r.id] || { name: r.id }).name), q(r.d), q(r.clip ? r.clip.name : '')].join(',')).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'sound-spotter-log_' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.csv'; a.click();
};
let clearArmed = 0;
$('clear').onclick = () => {
  if (Date.now() - clearArmed > 4000) { clearArmed = Date.now(); $('clear').textContent = 'Tap again to clear everything'; setTimeout(() => { $('clear').textContent = 'Clear log'; }, 4000); return; }
  clearArmed = 0; $('clear').textContent = 'Clear log'; for (const c of clips) URL.revokeObjectURL(c.url); clips = []; pending = [];
  rows = rows.filter(r => !r.e); $('log').innerHTML = ''; setTimeout(countLabels, 0); rows.forEach(addRowDom); for (const b of BOXES) { live[b.id].count = live[b.id].on ? 1 : 0; if (!live[b.id].on) { els[b.id].classList.remove('recent'); els[b.id].querySelector('.last').textContent = 'Not heard yet'; } }
  try { localStorage.removeItem(KEY); } catch (e) {} drawTimeline(Date.now());
};
function draw() {
  if (!running) return; requestAnimationFrame(draw);
  $('lvl').style.width = Math.max(0, Math.min(100, (sp.level + 90) / 80 * 100)) + '%'; $('lvltxt').textContent = isFinite(sp.level) ? sp.level.toFixed(0) + ' dBFS' : '';
  const secs = Math.round((Date.now() - startedAt) / 1000), hh = Math.floor(secs / 3600), mm = String(Math.floor(secs / 60) % 60).padStart(2, '0'), ss = String(secs % 60).padStart(2, '0');
  $('status').innerHTML = statusBase + (sp.stereo === null ? '' : sp.stereo ? ' · two microphones' : ' · one microphone channel') + ` · listening ${hh ? hh + ':' : ''}${mm}:${ss}` + ` · model ${MODEL.version}${vad.ok ? ' + voice model' : ''}` + (paused ? ' · <span class="warn">paused while a clip plays</span>' : sp.longCount < 6 ? ' · tone boxes warming up' : '');
  const cv = $('spec'); if (cv.width !== cv.clientWidth * 2) { cv.width = cv.clientWidth * 2; cv.height = cv.clientHeight * 2; }
  const g = cv.getContext('2d'), W = cv.width / 2, H = cv.height / 2; g.setTransform(2, 0, 0, 2, 0, 0); g.clearRect(0, 0, W, H);
  const x = f => Math.log(f / 20) / Math.log(1000) * W;
  g.fillStyle = '#8b96a1'; g.font = '11px Segoe UI, Roboto, sans-serif'; g.strokeStyle = '#2a3139'; g.lineWidth = 1;
  for (const [f, t] of (W < 500 ? [[100, '100'], [1000, '1k'], [10000, '10k']] : [[50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k']])) { g.beginPath(); g.moveTo(x(f), 0); g.lineTo(x(f), H - 14); g.stroke(); g.fillText(t, x(f) + 3, H - 3); }
  if (sp.longCount < 1) return;
  const N = sp.NL, hz = sp.sr / N, trace = (arr, col) => {
    const top = new Float32Array(Math.ceil(W)).fill(-1e9);
    for (let k = Math.ceil(20 / hz); k < N / 2 && k * hz < 20000; k++) { const px = Math.floor(x(k * hz)); if (px >= 0 && px < W && arr[k] > top[px]) top[px] = arr[k]; }
    g.strokeStyle = col; g.beginPath(); let last = -150, first = true;
    for (let px = 0; px < W; px++) { const v = top[px] > -1e8 ? (last = top[px]) : last, y = (1 - (v + 150) / 110) * (H - 14); first ? g.moveTo(px, y) : g.lineTo(px, y); first = false; }
    g.stroke();
  };
  if (sp.stereo) trace(sp.cohDb, '#4fc3d9'); trace(sp.powDb, '#ffb347');
}
countLabels(); drawTimeline(Date.now());
if (navigator.mediaDevices) listMics().catch(() => {}); else $('status').innerHTML = '<span class="warn">This browser cannot open the microphone from this page. It needs to be opened over HTTPS.</span>';
