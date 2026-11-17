# Harness

Measures the detector the way voicehunter does: known voices, clean or through a wall model, mixed into a real quiet-room
recording at known levels. No audio is kept in this repository; `build.py` reads the fixtures from a voicehunter checkout
and the room recordings from local paths.

    python3 harness/build.py          # 169 clips: 12 voices x (800/500/350 Hz wall, clear) x (+5/0/-5 dB), 12 noise beds
    python3 harness/silero_eval.py    # Silero VAD on every clip (also writes per-clip probabilities for run.js)
    node harness/dump.js              # feature rows for training
    python3 harness/train.py          # trains the voice-presence score, writes model.json
    MODEL=model.json SILERO=1 node harness/run.js src/core.js 1

## Results, 2026-11-17 (voices caught as the right kind, out of 12)

| condition | rules only | + learned score | + Silero voice model |
|---|---|---|---|
| 800 Hz wall, +5 dB | 12 | 12 | 12 |
| 800 Hz wall, 0 dB | 9 | 9 | 11 |
| 500 Hz wall, +5 dB | 11 | 12 | 12 |
| 500 Hz wall, 0 dB | 3 | 5 | 7 |
| 350 Hz wall, +5 dB | 4 | 10 | 10 |
| 350 Hz wall, 0 dB | 0 | 0 | 2 |
| clear voice, +5 dB | 11 | 11 | 11 |
| clear voice, 0 dB | 0 | 0 | 2 |
| any, -5 dB | 0 | 0 | 0 |

Median time to light the box fell from about 5 s to about 1.2 s with the voice model.
False alarms on the 12 beds: rules alone lit "voice" on copier and typing; with the voice model only the two beds that
really contain voices (babble, neighbor) light. A door bed lights the alarm box for 4 s (a held squeak).
Nothing lights on the five real recordings from the night of 17 Nov 2026.

Finding: Silero reads 0 on quiet room audio until the input is high-passed at 150 Hz and levelled; after that it also
hears through-wall voices (800 and 500 Hz walls), which the earlier voicehunter table (0.00 on walls) did not show.

## Traps (v4)

`node harness/traps.js` synthesises the false-alarm cases documented in the freqmon audits (a steady whine with harmonics, noise or rumble pulsing at syllable rate, a loud pure tone, a buzz switching on and off) and fails if any of them lights Muffled speech or Voice in the room. Pulsing noise used to light Voice in the room through both the rules and the learned score; v4 requires a pitch that glides from frame to frame (`f0Cont`, `glide`) before either vote counts.

Cost on the voice clips (caught as expected, of 12), v3.1 -> v4: full system with Silero unchanged except wall350 +5 dB 10 -> 9. Without Silero (page opened from a file): wall350 +5 dB 10 -> 5, wall800 0 dB 9 -> 8; the rest unchanged.

## First phone export (17 Nov 2026, v4.1)

Ten minutes from the Pixel gave 19 "Muffled speech" events, all with the voice model silent and the learned score at 15% or below; the clips show thumps over low rumble, no voiced harmonics. The hand rules now need the learned score to be at least 30% before they count on their own. Replaying the 40 clips: muffled speech 71.7 s (v3.1) -> 12.3 s. Harness recall with Silero is unchanged by this rule.
