# OpenLive on ZoidbergsMint — the configuration that WORKS
**2026-09-24. Branch `fix/webgpu-adapter-probe`, commit `111e356`.**

Voice → Whisper → Claude Code → Kokoro → speakers **closes end to end.**
Claude Code answered out loud: *"Yeah, I'm here. What's up?"*

## Run it
```bash
cd ~/src/openlive
ELECTRON_ENABLE_LOGGING=1 npx -y pnpm@11.5.2 desktop:dev     # CDP on :9333, UI on :47824
```
NO Chromium flags. (`--enable-features=Vulkan` / `--use-angle=vulkan` made things
WORSE — they broke EGL and pegged the GPU process. `--ignore-gpu-blocklist` is
unnecessary: Electron 43's Chromium 150 grants a WebGPU adapter here unaided.)

## Microphone — THE critical system setting
Chromium AGC had driven the analog chain to **+30 dB capture + +30 dB boost**,
clipping the mic into a square wave (40.5% of samples at ±32768). PipeWire maps
its *source volume* onto those hardware controls, so:

```bash
pactl set-source-volume alsa_input.pci-0000_00_09.2.analog-stereo 25%
```
→ analog lands at **+23.25 dB, boost 0 dB**, noise floor **0.0101**, 0% clipping.

Sweep that produced it (noise floor, quiet room):

| pulse | analog | noise RMS | clipping | resulting gate |
|---|---|---|---|---|
| 15% | +10.5 dB | 0.2438 | 4.2% | 0.0300 |
| **25%** | **+23.25 dB** | **0.0101** | **0%** | **0.0161** |
| 35% | +30 dB | 0.0312 | 0% | 0.0300 (pinned) |
| 50% | +30 +10 dB | 0.0826 | 0% | 0.0300 (pinned) |

Restore the ORIGINAL (clipping) settings: `~/src/openlive/mic-restore-original.sh`
⚠ Set the gain with **nothing holding the mic** — a running call's AGC overwrites it.

## Browser state (localStorage, origin http://localhost:47824)
```
openlive-force-device  = "wasm"      # our escape hatch; WebGPU "works" but is far slower here
openlive-ptt-enabled   = ""          # push-to-talk OFF
openlive-pipeline-v1   = {"stt":{"whisperSize":"tiny"},
                          "tts":{"engine":"kokoro","voice":"af_heart","speed":1},
                          "turn":{"engine":"silence","threshold":0.5,"holdMs":4000},
                          "vad":{"speechThreshold":0.5,"redemptionMs":700}}
```
`turn.engine:"silence"` skips Smart-Turn. **This is a workaround, not the goal** —
Smart-Turn is the semantic end-of-turn model that gives the natural-conversation feel
Lucas actually wants. It cost 1383 ms/utterance here and scored a trailing sentence as
"not finished" (arguably correctly), which made the engine hold the turn forever.
Revisit by lowering its threshold once STT is fast.

## Measured performance (the honest numbers)
```
[live:perf] turn 1: stt+endpoint 38544ms · model 19722ms · tts 28087ms
                    voice-to-voice 86353ms
```
* STT **7–9 s** with the machine idle → **17–40 s inside a live call**. TTS and the VAD
  eat the other core. `ort.env.wasm.numThreads = 1` means ONE core is used.
* Transcription accuracy is fine on clean audio:
  `"And this is just a test. Claude, can you hear me properly?"` — verbatim.
* Known failure mode remaining: **backlog spiral.** While a 40 s STT runs, further
  speech defers and MERGES into ever-longer buffers; one hit 8.7 s of audio and blew
  even the new 60 s cap. Not a bug — throughput.

## Remaining levers
1. **COOP/COEP + `numThreads = navigator.hardwareConcurrency`** — ~30 min.
   `crossOriginIsolated` is currently `false`, `SharedArrayBuffer` undefined. Use
   `Cross-Origin-Embedder-Policy: credentialless` so Hugging Face downloads survive.
   Expect only ~1.5–1.8× (40 s → ~25 s).
2. **★ Native STT via `onnxruntime-node`** — the real fix. It is ALREADY in
   node_modules (transitive via `@huggingface/transformers@4.2.0`). Run the same
   pipeline in the Electron main process instead of the renderer. Native CTranslate2
   benchmarked **3.17× realtime** on this exact CPU, i.e. ~1.5 s instead of 40 s.
   The facade is only three functions — `stt` / `tts` / `turnComplete` — so this is a
   contained change, not a rewrite.

## ⚠ TEMP DEBUG SCAFFOLDING — remove before any upstream PR
* `[dbg]` console lines in `voiceEngine.ts` (onSpeechEnd entry, post-STT, the catch)
* `window.__ol` bridge in `models.ts` (lets CDP call stt/tts/loadModels directly —
  invaluable: it is how we proved STT worked at all, independent of mic and VAD)

## How to drive/observe it without touching the GUI
`--remote-debugging-port=9333` is passed by `desktop:dev`. Scripts used tonight live in
the session scratchpad; the pattern is: list targets at `http://127.0.0.1:9333/json/list`,
open the page's `webSocketDebuggerUrl`, `Runtime.enable`, then `Runtime.evaluate`.
⚠ `Runtime.evaluate` runs on the renderer MAIN THREAD — when it stalls for 80–110 s
that is itself a finding (the UI thread is starved), not a broken script.
