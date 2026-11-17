# Sound Spotter

A single-page, in-browser sound detector. It listens through the microphone, lights a box for each kind of sound it
recognises, keeps short clips of the interesting ones, and lets you label them so the detector can be retrained.

- Everything runs in the browser. No audio leaves the device unless you export it yourself.
- Needs HTTPS for microphone access, which is why it is served with GitHub Pages.
- Voice detection has three votes: hand rules (pitch + syllable rhythm), a learned score (`model.json`), and the
  Silero VAD model (`vad/`). "Muffled" versus "in the room" is decided by the through-wall signature from voicehunter:
  almost nothing above 800 Hz.
- `model.json` holds thresholds and learned weights. Replacing it changes the detector without a code change.
- `src/` is the source (`build.sh` assembles `index.html`); `harness/` measures every change.

Do not commit recordings or labelled clips to this repository: it is public, and clips may contain people who do not
know they were recorded.
