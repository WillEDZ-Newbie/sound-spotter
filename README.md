# Sound Spotter

A single-page, in-browser sound detector. It listens through the microphone and lights a box for each kind of sound it can pick out: muffled speech (voice pitch plus syllable rhythm), alarm-type tones, steady tones (including a 16.86 kHz whine), low rumbles, clicks, and mains hum.

- Everything runs in the browser. No audio leaves the device and nothing is recorded.
- Needs HTTPS for microphone access, which is why it is served with GitHub Pages.
- `index.html` is the whole app: no build step, no dependencies.

Open the Pages URL, press **Start listening**, and allow the microphone.
