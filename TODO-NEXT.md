# OpenLive — next session TODO
**Written 2026-09-24 23:2x, before a compact. Branch `fix/webgpu-adapter-probe` @ `685feac`.**
Read `WORKING-CONFIG.md` first — launch command, mic setting, localStorage, perf baselines.

**Agreed order (Lucas's call, and it's the right one): prove the big lever FIRST, then tidy.**
Rationale: native STT may change what we PR — fix #4's 60 s timeout may need different
numbers or become moot, and fix #1 (fp32 vs q8) may not matter at all if the native path
loads different weights. Don't polish what we're about to rewrite.

---

## PHASE 1 — Native STT spike (the big lever). Target: 40 s → ~1.5 s
- [ ] **1. Scout: can `onnxruntime-node` load in the Electron MAIN process?**
      It's a native `.node` binding, so it CANNOT load in the renderer sandbox — that is
      precisely why inference has to move. Already in node_modules (transitive via
      `@huggingface/transformers@4.2.0`). Confirm it `require()`s under Electron's node.
- [ ] **2. Map the audio path renderer → main.** What already exists: `agent.mjs`,
      the Hono backend, any ipcMain/ipcRenderer or preload bridge. We need Float32Array
      (16 kHz mono) one way and a string back. Prefer an existing channel over a new one.
- [ ] **3. Minimal main-process `stt()`** using `@huggingface/transformers` with the
      node backend (NOT onnxruntime-web). Load `whisper-tiny.en` (or `base` — native can
      afford more). Prove it transcribes `~/…/scratchpad/sp4.wav` offline first.
- [ ] **4. Wire it up:** swap the renderer's `stt()` facade to call main via IPC instead
      of the worker. The facade is only 3 functions (`stt` / `tts` / `turnComplete`) —
      keep the signature identical so `voiceEngine.ts` is untouched.
- [ ] **5. MEASURE against the baselines below.** In-call, not idle — that was my mistake
      tonight. Report stt ms, voice-to-voice ms.
- [ ] **6. Verdict:** keep, or abandon and stay on WASM.
- [ ] (stretch) same treatment for TTS — Kokoro is 28 s in-renderer; kittentts/piper
      native is on this machine already and fast.

## PHASE 2 — Tidy + upstream (ONLY after Phase 1's verdict)
- [ ] **7. Strip ALL temp debug scaffolding:**
      `[dbg]` console lines in `voiceEngine.ts` (onSpeechEnd entry, post-STT, the catch)
      and the `window.__ol` bridge in `models.ts`.
      ⚠ KEEP the catch's error logging — a bare `catch {}` was root cause #2. Log it
      properly (via their `log.warn`), just don't ship `[dbg]`.
- [ ] **8. Re-decide which of the five fixes still apply** after Phase 1.
- [ ] **9. Split into clean, separately-reviewable commits**, one defect each.
- [ ] **10. Verify:** `pnpm typecheck` clean + one full end-to-end voice run.
- [ ] **11. PR #1 — the bug fixes only.** Small, obviously correct, helps every CPU-only
      user. Include the measured evidence.
- [ ] **12. Separate ISSUE (not PR) for native STT**, with our numbers: native
      CTranslate2 3.17× realtime vs 40 s WASM on the same 2-core CPU. Moving inference
      out of the renderer is THEIR architectural call — evidence persuades, a large
      unsolicited diff doesn't. (Same play as the claude-mem #2795 fix Lucas got merged.)

---

## Baselines to beat / regression checks
| Metric | Current (WASM, in-call) | Idle bench | Target |
|---|---|---|---|
| STT, ~2 s utterance | **17–40 s** | 7–9 s | **~1.5 s** |
| TTS (Kokoro) | 28 s | — | faster |
| model (Claude Code) | 19.7 s | — | unchanged |
| **voice-to-voice** | **86 s** | — | **< 10 s** |
| transcription quality | good on clean audio — *"And this is just a test. Claude, can you hear me properly?"* verbatim | | no worse |

Residual known bug: **backlog spiral** — while a long STT runs, further speech defers and
MERGES into ever-longer buffers until one blows even the 60 s cap. Native speed should
dissolve it; if not, cap the merged buffer length.

## Guardrails
- **Never touch `~/.hermes`** (node/npm live there; npm's global prefix is inside it —
  use `npx`, never `npm i -g`).
- **Set mic gain with NOTHING holding the mic** — a live call's AGC overwrites it.
- **Two separate PRs.** Don't let the architectural change sink the small fixes.
- Revert points: `mic-restore-original.sh`, `rm ~/.local/bin/claude`, `git checkout main`.
- Launch with NO Chromium flags. `--enable-features=Vulkan` / `--use-angle=vulkan` made
  it worse (broke EGL, pegged the GPU process).

## Method reminders (earned the hard way tonight)
- **Build the CDP bridge EARLY.** `window.__ol` + `--remote-debugging-port=9333` is what
  proved STT worked while the app was silent, killing three wrong theories at once.
- **Test hypotheses under REAL conditions.** I retracted the correct timeout theory
  because I benchmarked it on an idle machine.
- **A bare `catch {}` is a bug.** Two nights of "nothing happens" was one swallowed error.

---

## PHASE 1 RESULTS (measured 2026-09-25 ~00:0x, machine loadavg ~9 on 2 cores)

**Step 1 ✅ `onnxruntime-node` loads in the Electron MAIN process.** Real main process
(`process.type = browser`), Electron 43.1.1 / node 24.18.0 / **ABI 148** — the prebuilt
binding is N-API (`bin/napi-v*/linux/x64/onnxruntime_binding.node`) so the Node-22-vs-24
ABI gap is a non-issue. `require()` took 43 ms. Backends: cpu + webgpu bundled.
`@huggingface/transformers@4.2.0` ships `dist/transformers.node.mjs` and imports clean in
main; `env.backends = ["onnx"]`. **It is already a dependency — nothing new to add.**

**Step 3 ✅ It transcribes.** `onnx-community/whisper-tiny.en`, 4.0 s clip:

| runtime (same 4 s clip, same load) | model load | warm run | xRT |
|---|---|---|---|
| **ORT-node q8, Electron main** | 14.3 s | **3.6–4.1 s** | **~1.0x** |
| ORT-node fp32, Electron main | 40.3 s | 4.7–5.5 s | ~0.78x |
| faster-whisper / CTranslate2 int8 (python) | 22.1 s | 4.3 s | ~0.93x |
| onnxruntime-**web** WASM (current, in-call) | — | **17–40 s** | ~0.1x |

**⚠ The 3.17x faster-whisper figure was an IDLE-machine number.** Re-measured under real
load it is 0.93x — i.e. **CTranslate2 has no speed advantage over ORT-node here.** Same
mistake the method note at the bottom of this file warns about; caught it this time by
benchmarking both under identical load.

**Conclusions:**
- Use **ORT-node q8 in the Electron main process**. No Python sidecar, no new dependency.
- q8 beats fp32 on native (opposite of the WASM tier, where q8 won't load at all).
- Expected win: STT **17–40 s → ~2 s** for a typical 2 s utterance (~10–20x).
- The wall is **2 cores at loadavg ~9**, not the inference runtime. Note the idle Electron
  **gpu-process burning ~34% CPU for nothing** — worth killing, it is free headroom.
- After this, **TTS (Kokoro, 28 s) becomes the biggest term.** Promote the stretch goal.

---

## PHASE 1 COMPLETE — 2026-09-25 ~01:30. Both halves now native.

**Committed:** `2346af3` native STT · `88defce` per-turn fallback fix · `2eb3f5b` native TTS.

### Where the time goes now (measured, in-app, 2-core CPU)
| stage | session start | now |
|---|---|---|
| stt+endpoint | 38–40 s | **~2 s** |
| model (Claude Code) | 20 s | ~6.5 s |
| tts (time to FIRST sentence) | 28 s | **~2.5 s** |
| **voice-to-voice** | **86 s** | **~11 s** |

### STT: sherpa-onnx whisper tiny.en fp32, in the agent service
Chose the agent service over the Electron main process for three reasons that all
held up: the renderer→`/api/voice/*` seam already existed (cloned-voice TTS uses
it), `sherpa-onnx-node` was already a declared dep of `services/agent` (so no
`pnpm install` — and a fresh install is what floated `onnxruntime-web` to 1.27 and
caused defect #1), and `decodeAsync` runs off the event loop that also drives the
coding agent. `@huggingface/transformers` is NOT resolvable from `services/agent`.

### TTS: the measurement that killed three plausible options
Time to the first spoken sentence — the pipeline already chunks by sentence, and
`perf.firstAudio()` already measures exactly this, so the reported `tts` number
was never total synthesis:
| engine | first sentence | verdict |
|---|---|---|
| Piper medium, native | **2.1–2.9 s** | chosen |
| KittenTTS nano, native | 2.2–3.3 s | works, voices rough |
| Kokoro 82M, browser WASM | 12.4 s | previous default |
| Supertonic, browser WASM | **21.8 s** | labelled "fastest" — it is NOT here |
| Piper **high** tier, native | **42 s** | high tier unusable; offer `medium` only |
| Kokoro 82M, native int8 | 67 s | worse than the browser |
| ZipVoice cloning, native | 110 s | upstream's comment claims 0.22x realtime |

**Voice cloning is not viable on this class of machine** — ZipVoice measured
~0.06x realtime against upstream's noted 0.22x. Game-character voices have to
arrive as pre-trained Piper models, not clones. GLaDOS + HAL 9000 exist as Piper;
Mass Effect / Halo do not (they get made as RVC, which needs a GPU).

### Also corrected tonight
- **The 3.17x faster-whisper figure was an idle-machine number.** Re-measured
  under identical load: 0.93x, i.e. no advantage over ORT-node. Benchmark
  competing options back-to-back under the SAME load or don't quote the number.
- **Supertonic crashed the renderer once** (400 MB in-browser; 8 GB RAM free, no
  OOM kill logged). Second attempt survived but was slow. Not worth chasing.
- A single native-STT failure used to demote the whole session to the 20x slower
  WASM path — a silent regression the user can't see. Now 3 strikes, per turn.

### Security note (Lucas asked, 01:20)
Everything downloaded came from `k2-fsa/sherpa-onnx` releases or
`huggingface.co/csukuangfj` (the sherpa maintainer) — same trust level as the
`sherpa-onnx-node` dep the app already had. `.onnx` is protobuf **data**;
`.pt`/`.pkl`/`.bin`/`.ckpt` are pickles that **execute on load** — never take a
"voice model" in those formats. Archive path-traversal was *verified* refused by
GNU tar 1.35 on this machine (`Member name contains '..'`), not assumed.

## PHASE 2 — tidy + upstream (NOW the next job)
- [ ] Strip `[dbg]` lines + the `window.__ol` bridge (KEEP real error logging —
      a bare `catch {}` was root cause #2).
- [ ] Model downloads still land by hand into `data/models/*`. For a PR they need
      the `/voice/model/download` treatment (progress stream, .part files, no
      partial installs) and a Settings entry.
- [ ] `apps/web` still declares `onnxruntime-web "^1.22.0"` — pin it exactly, or
      defect #1 returns on the next fresh install.
- [ ] Split into per-defect commits; PR #1 = the five original bug fixes only.
- [ ] Native STT/TTS = a separate ISSUE with these numbers, not a surprise diff.

---

## ▶ RESUME HERE — 2026-09-25 ~02:20, Lucas going to bed, will test on waking.

**State: everything committed and typechecking clean. Nothing half-finished.**
Last code commit `da24172` (docs `c2e22df`).

### ⚠ THE DEV STACK IS DOWN — start it first thing
It exited on suspend (`SIGTERM` to the `web` child -> `concurrently -k
--kill-others` tore down electron + agent with it). It does NOT survive suspend,
and it will not survive the Claude Code session ending either, since it was
launched from a session-owned shell. Expect to start it by hand every time.

### Start the app
```
cd ~/src/openlive && npx -y pnpm@11.5.2 desktop:dev
```
Then: New -> pick a folder -> talk. Config is already set to the native fast path
(`localStorage openlive-pipeline-v1` -> `tts.engine="fast"`,
`voice="northern_english_male"`). Watch a live call over CDP on
`--remote-debugging-port=9333` (scratchpad has `cdp-watch-long.mjs`).

### The one honest number to beat
**Real in-call, NOT a bench:** turn 1 **77.7s** (a 15s deadline of mine fired and
dumped the turn onto the WASM path), turn 2 **31.6s** — against 86s all-WASM.
After `da24172`'s tuning, EXPECT ~20-25s on turn 1 and **~15-20s** settled.
**Do not quote the ~11s figure — it was an idle-machine measurement.**

### The lesson relearned the hard way, twice in one night
Idle benchmarks lie by 3-4x on this machine. In-call, native STT decode is
**~0.5x realtime**, not the ~2x an idle bench shows (7.5-10.1s for 3-5s of audio).
I quoted the bench number as a promise, then shipped a 15s deadline based on it,
which made the first turn of every call WORSE than doing nothing. Any latency
figure not taken during a live call is a guess.

### Next, in order
1. **Lucas tests on waking** — collect turn 1/2/3 numbers, confirm tuning helped.
2. If TTS is still the biggest term: 18.3s in-call vs 2.5s on the bench. Check
   whether STT and TTS overlap and starve each other (same process, now 1 thread
   each) and whether the first `say` of a call still pays an engine load.
3. THEN Phase 2 (strip `[dbg]` + `window.__ol`, per-defect commits, two PRs).

### Voices (all installed; `GET /voice/say/voices`)
`northern_english_male` (Lucas's default — the one he asked me to choose for
myself), `southern_english_female` (for Hermes, who asked for British female),
`alan`, `alba`, `jenny`, `lessac`, `ryan`, **`glados`**, `kitten`.
Piper **high** tier is unusable here (42s) — `medium` only. Cloning is dead on
this hardware (ZipVoice ~0.06x realtime, vs upstream's noted 0.22x).

---

## ⚠ THE DEV SERVER SERVES THE CHECKED-OUT BRANCH
Burned 2026-09-25: built the PR on a clean branch (`fix/cpu-only-voice-pipeline`,
five bug fixes only) and left the working tree there. The running app silently
became the PR build — no native speech, a 460 MB browser-model re-download, and
a HARD FAILURE because the saved config's `tts.engine: "fast"` does not exist on
that branch (`engineOf()` asserts non-null), so the pre-call screen died with no
start button. Lucas spent three attempts and five minutes debugging my
housekeeping while I theorised about ACP auth.

**Before asking him to test anything: `git branch --show-current` must be
`fix/webgpu-adapter-probe`, and restart the stack after any checkout.**
The tell in the screenshot was "Downloading on-device AI… 460 MB" — impossible
when the native path is live. Read the evidence in front of you first.

Also: settings written by the feature branch are not valid on the PR branch.
Switching branches needs the stored `tts.engine` reset too, or the UI breaks.

---

## ▶ RESUME HERE — 2026-09-25 ~15:20, Lucas back after IRL jobs.
Agreed order: **small jobs first, then the large one.**

### 1. Model picker for agents using the standard ACP shape (~40 lines)
`applyConfig()` only reads a `configOptions` select with `category:"model"` (the
newer shape Claude Code uses). Hermes returns the STANDARD shape on `session/new`:
`result.models = { availableModels, currentModelId }`, and implements
`session/set_model`. Verified live against `hermes acp`:
  currentModelId : custom:~x-ai/grok-latest   (his daily driver is GROK, not 405B)
  availableModels: **1021**
  session/set_model -> nousresearch/hermes-4-405b : **OK**
Fix = read that shape too and route `setModel()` to `session/set_model` when the
config-option id is absent. Not Hermes-specific: any agent on the standard shape
is invisible to the picker today. → upstream PR #2.

### 2. Session transition — resume ANY session in the folder (~similar size)
OpenLive's Resume list is built from its own DB (`listChats()`), so CLI-made
sessions never appear. But BOTH agents advertise `sessionCapabilities.list`, and
Claude Code's `session/list` returned all 8 of his voice-test sessions with
titles + timestamps. So the protocol already supports it; the UI just doesn't ask.
**Don't hack a UUID into `acpSession:<chatId>` — that was my first plan and it is
strictly worse than the real feature.** → upstream PR #3.

### 3. Transcribe-while-talking (the big one)
Design work, unknowns, second-order effects on turn-taking. Use
`superpowers:brainstorming` FIRST, then TDD for the merge logic (it is pure:
segments in, text out — testable without a microphone, which matters because
every feedback loop so far has been "Lucas talks and reports vibes").
NOT parallel agents / worktrees: one app, one mic, so verification cannot be
parallel and untested branches are exactly where our bugs came from.

### Hermes by voice — DONE, needed no code
`hermes acp` on the patched 0.21.4 works: handshake OK, `loadSession`, `fork`,
`list`, `resume`, and `image:true` (so camera/screen-share works with her too).
Folder `/home/lc/hermes-voice` (a PERMISSION BOUNDARY — see its README).
Measured 5 turns: voice-to-voice p50 **24.5s**, model p50 5.0s (Grok).
⚠ She takes ~19s to return `session/new` (Claude Code ~2s) — that pause is normal.
⚠ Daily profile → Mnemosyne ingests voice sessions, transcription errors included.
⚠ NEVER press Install/Update/Uninstall on OpenLive's Hermes card.
⚠ 405B via the GUI dropdown would be the DAILY profile — no lab_405b patches, so
not a valid data point for the research programme.

### Shipped today
PR  https://github.com/katipally/openlive/pull/17  — the five silent defects
Issue https://github.com/katipally/openlive/issues/18 — native speech measurements

---

## ▶ RESUME — 2026-09-26 ~14:30. Session ended after the re-transcribe test.

**Lucas's verdict: reuseHeldTranscript ON is better — no duplicated sentences.**
He also raised mic sensitivity in the GUI because his voice was barely being
picked up, which may have been feeding the accuracy problem all along.

### ⚠ First thing next session: speechThreshold 0.1 has NO hysteresis
`negativeSpeechThreshold: Math.max(0.1, speechThreshold - 0.15)`, so at 0.1 the
start and stop thresholds are both 0.1 — a frame just above starts speech, the
next just below ends it. That chatter produces MORE, SHORTER segments, which is
precisely the fragmentation that wrecked accuracy on 09-25.
**Ask him to try 0.25** (still far more sensitive than the 0.5 default, but
restores the full 0.15 gap) and compare. Do not just set it — he changed it for
a real reason (he could not be heard).

### Measured, so nobody re-litigates it
- **Speaking speed is comfort, not latency.** synth is ~flat with speed; only
  playback shrinks. 1.0 → 9.5s total, 1.5 → 7.8s, and time-to-FIRST-word is
  unchanged. `tts.speed` (0.5–2) already exists, no code needed.
- **TTS threads: no finding.** 2 threads measured 18% faster than 1, but the
  same 1-thread test gave 5.5s and 8.1s on different runs — the spread is bigger
  than the effect. Left at 1 (STT and TTS share the process and can overlap).
- Session of 6 turns after the change: voice-to-voice p50 **26.7s**.

### Diagnostics are back, properly
`log.debug("voice", ...)` in onSpeechEnd reports utterance length, whether the
prefix was reused, and the text — gated on `localStorage["openlive-debug"]`,
which is now SET on his machine. I had deleted the temp `[dbg]` probes with the
scaffolding and immediately lost the ability to answer "did that help?".

### Next candidates (his steer: "speech generation or speech speed")
1. Speaking speed — one setting, let him pick by ear. Low value, zero cost.
2. The real remaining cost is synthesis at ~1.4x realtime per sentence. No cheap
   lever found: Kokoro native 67s, ZipVoice 110s, Supertonic 21.8s, Piper high
   42s — Piper medium is already the best on this hardware.
3. Untested idea: shorter replies. The cap in his customInstructions was never
   evaluated (he said "don't worry about the system prompt").

### Upstream status — planted, not expected to move
PR #17 (five defects) · PR #19 (ACP model-state picker) · Issue #18 (native
speech measurements) · Issue #20 (stale agent_session_id hides a session).
Nobody has looked. Context: every merged PR in that repo is the maintainer's
own, and the one outside PR (#7) has been open since 11 July. Real work happens
on the `flow` branch, 213 commits ahead of main, where all five defects still
exist. Test-rebase onto `flow` = 4 conflict hunks; deliberately deferred until
`flow` lands on main. **Local-first from here** — decided with Lucas.

---

## STREAMING TTS — built, reverted, blocked upstream (2026-09-26)
**Do not re-attempt until k2-fsa/sherpa-onnx#3989 is fixed.**

The win is real: sherpa's `generateAsync({ onProgress })` hands back audio per
sentence, so playback can start at **1.3s instead of 7.6s** (~6x), and the gap
grows with reply length — the 215-char reply that took 37s before a word came
out is the case it would fix.

**Why it is off:** the progress callback aborts the process with
`FATAL ERROR: v8::ArrayBuffer::New Allocation failed` inside
`napi_create_arraybuffer`, **~50% of runs** (4/8, then 3/6). It kills the agent
service — i.e. the process driving the conversation. Reverted in full; the
non-streaming path is untouched.

What the evidence says: callbacks DO fire first with sane sizes (~150k samples,
~600KB), RSS stays flat at ~280MB, 5.9GB free. Same text and engine never fails
WITHOUT `onProgress`. `numThreads` 1 vs 2 makes no difference. So: a race in the
callback/queue path, not a sizing bug or a leak.

**Two mistakes of mine worth remembering:**
- I reported it as deterministic off TWO runs. It is a coin flip. Repeat a
  non-deterministic-looking failure enough times to have a rate before claiming
  one, especially in someone else's tracker.
- I claimed "dies before the first callback" because no callback output
  appeared — but `console.log` is BUFFERED and a fatal abort discards it. Use
  `fs.writeSync(2, ...)` when instrumenting anything that might abort.
Both corrected publicly in the issue.

**If revisited:** process isolation (synthesise in a child that may safely die,
fall back to non-streaming on abort) is the only workaround shape left, and at a
50% abort rate it loses the synthesis half the time — poor value for the
complexity while the root cause is unknown.

### Still untested, and now the only remaining lever for speaking speed
**Shorter replies.** Synthesis time is proportional to words; the cap in his
customInstructions has never been evaluated. Needs a live call, costs nothing.

---

## ⏭ RETEST MOONSHINE WHEN sherpa-onnx-node 1.13.9 LANDS (2026-09-26)
Moonshine decodes ~2.9x faster than Whisper for the same words (2.1s vs 6.2s on
an 8s utterance) and is live as the fast path with a Whisper fallback. The
fallback exists because it sometimes returns an EMPTY transcript, trigger
unknown — see the comment block in `services/agent/src/voice/stt.ts` for the
five causes that were measured and ruled out.

**Three things line up on the next release:**
- We are testing **v1** (`sherpa-onnx-moonshine-tiny-en-int8`, dated
  **2024-10-26**). A **v2** exists (`...-quantized-2026-02-27`).
- v2 **cannot load on 1.13.8**: its config only accepts the v1 four-file layout
  (preprocessor/encoder/uncachedDecoder/cachedDecoder) and v2 ships two files
  (`encoder_model.ort` + `decoder_model_merged.ort`). All three config
  permutations tried and failed — "Please check your config!".
- Upstream fixes for v2 decoding merged **2026-09-22**, AFTER 1.13.8 shipped
  **2026-09-10**: k2-fsa/sherpa-onnx#3975 and #3976 ("feed the decoder
  encoder_attention_mask at raw audio length") plus #3805 (v2
  `decoder_model_merged.ort` fails above a length). An attention-mask bug that
  depends on audio length is the right shape for what we see.

**On 1.13.9:** bump, download `sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27`,
point `FAST_STT_DIR` at it, and re-measure. If v2 is reliable, the Whisper
fallback can go and STT drops to ~1/3 of its current cost.

Rejected on measurement, do not retry blind: level normalisation (both engines
are already level-robust — correct at 8x quieter), and trimming the lead-in
(implemented, measured, did not fix the empties).

---

## 🐛 OPEN BUG: renderer grows to ~4.7GB in about an hour of calls (2026-09-26)
Lucas reported the app frozen. It was not frozen — the machine was out of RAM:
`electron --type=renderer` had reached **4,751 MB** (43% of 10.9 GB) after ~1
hour, RAM available down to 2.1 GB, loadavg 9.7. Closing the app returned
6.2 GB; a fresh renderer starts at **153 MB**.

**Key measurement: the JS heap was only 28 MB used / 32 MB total.** So this is
NOT JavaScript objects — it is native allocation outside the JS heap:
WebAudio buffers and/or WASM heaps.

**Prime suspect is mine.** Streaming TTS calls `player.play()` once per CHUNK
instead of once per sentence, and every call does `ctx.createBuffer()` — an
AudioBuffer lives in native memory. `AudioPlayer` releases via
`src.onended = () => this.sources.delete(src)`, so any source whose `onended`
never fires (barge-in, `flush()`, a suspended context) leaks its buffer.
Streaming multiplied the number of buffers, so a pre-existing slow leak would
now show up fast.

NOT yet proven — the WASM worker (Kokoro/Whisper via onnxruntime-web) also
allocates outside the JS heap and may still be loaded even though synthesis is
native now. Both need ruling in or out.

**How to investigate:** run a call, then sample
`ps -o rss= -p <renderer pid>` every 30s alongside `performance.memory` over
CDP. If RSS climbs while the JS heap stays flat, it is native. Then check
whether `sources`/`timers` in `audioPlayback.ts` keep growing, and whether the
WASM worker is loaded at all now that STT and TTS are both native — if it is
not needed, not loading it would remove the other suspect entirely.

**Workaround meanwhile:** restart the app every hour or so of heavy use.

---

## ▶ RESUME — 2026-09-26 ~22:50. Stopped on usage limit (resets midnight).

### Tomorrow's job, agreed: SESSION INTEROP
Make sessions visible across all three surfaces. What is already true:
| direction | state |
|---|---|
| OpenLive → `claude --resume` | ✅ works — they are real Claude Code sessions, stamped `claude-vscode` so /resume does not hide them |
| Claude Code CLI → OpenLive | ✅ works, BUT only with History's filter on **"All"** — default hides them, which is why Lucas could not see his |
| **Hermes ↔ OpenLive** | ❓ **untested both ways** — the registry has a `hermes-sqlite` disk parser, never verified |
So the real work is (a) Hermes, both directions, and (b) making the Claude Code
direction discoverable rather than hidden behind a filter nobody knows about.
Do NOT rebuild `session/list` — external sessions already ship (see the revert
in commit 1b7b25f for why).

### Current live settings (all set via localStorage, not code defaults)
`tts.engine=fast voice=southern_english_female_low speed=1`
`stt.whisperSize=tiny reuseHeldTranscript=true` (Moonshine fast path + Whisper fallback)
`turn.engine=smart-turn threshold=0.65 holdMs=3000` ← threshold raised tonight, UNTESTED
`vad.speechThreshold=0.1 redemptionMs=1400`

### Where the numbers landed
voice-to-voice **p50 16.4s**, best turn **11.7s** — from 86s on Wednesday.
Fast path lands ~82-86% of turns; the Whisper fallbacks are the slow ones.

### Open, honest state
- **threshold 0.65 is untested.** It should stop sentences splitting into two
  prompts. If it now waits too long before replying, drop toward 0.55.
- **Lucas's own finding beat all my model work: speaking slower and more
  steadily improved accuracy.** Worth remembering before swapping models again.
- **The "4.7GB renderer leak" is NOT confirmed.** A 12-minute sample showed RSS
  rise 1118→1377MB then FALL to 1224MB with the JS heap flat at ~25MB. That is
  churn, not a runaway. The one 4.7GB observation stands unexplained; watch it
  over a long session before believing me. `scratchpad/mem-watch.sh` samples
  RSS + JS heap together.
- Accuracy vs speed: every engine faster than Whisper is less accurate
  (Moonshine, Zipformer 3.4x but ALL CAPS and no punctuation — which would also
  break `endsMidThought`, SenseVoice slower AND worse, Moonshine base worse and
  slower). Whisper tiny.en fp32 remains the accuracy benchmark.
- `check-voice-updates` (in ~/bin, plus a Monday 9am cron) watches for the
  sherpa release that unblocks Moonshine v2.

### Tooling note for next time
`scratchpad/watch-live.mjs` is a SELF-RECONNECTING console watcher. Use it, not
the old one-shot watchers — three separate times today a watcher silently
stopped collecting (expired loop, filter that did not match a new log tag, and
a CDP target lost on app restart) and a session's data was lost each time.

---

## ▶ RESUME — 2026-09-27 ~11:35. Session interop investigated; compacting.

### Shipped this morning
`a80bb49` **Hermes + OpenCode sessions NEVER appeared in History** — both parsers
used `require("node:sqlite")`, which Turbopack cannot bundle ("Cannot find module
'node:sqlite': Unsupported external type Url for commonjs reference"), and each
parser's bare `catch { return []; }` swallowed it. Fixed with
`process.getBuiltinModule("node:sqlite")`; History went 0 → 57 Hermes sessions.
Catches now warn once instead of vanishing. Same bug class as the original
silent onSpeechEnd catch.

### Interop, measured
| | Claude Code | Hermes |
|---|---|---|
| OpenLive sessions visible in CLI | ✅ | ✅ (`hermes sessions list`) |
| CLI sessions visible in OpenLive | ✅ | ✅ since a80bb49 |
| resume OpenLive session from terminal | ✅ `claude --resume` | ✅ `hermes -r <id>` |
| resume CLI session inside OpenLive | ✅ PINEAPPLE-42 remembered | ❌ **Hermes refuses, then reports success** |

**The Hermes gap is in ~/.hermes, read-only diagnosis, NOTHING MODIFIED:**
- `acp_adapter/session.py:428` — `_restore()` does
  `if row is None or row.get("source") != "acp": return None`. The ACP adapter
  deliberately restores ONLY sessions whose source is `acp`; CLI (`cli`),
  one-shot (`oneshot`), tui etc. are rejected by design. Likely because they lack
  ACP metadata (`model_config` with `cwd`) the restore path expects.
- `acp_adapter/server.py:622` — `load_session` turns that into `return None`,
  which goes over the wire as a SUCCESSFUL empty reply. Stderr says
  `load_session: session <id> not found`; the client is told OK. That is a real
  bug and it is what made the failure silent.
- Control: an OpenLive-created (acp) session loads with full history replay;
  the CLI-created one returns OK with 0 replay.
**Decision pending with Lucas** — my recommendation: (3) make OpenLive mark
non-acp Hermes sessions view-only now; (2) report the success-on-failure bug to
Nous (public post, needs approval); hold (1) patching Hermes until Nous says
whether the source restriction is deliberate.

### ⚠ Claude Code transcripts — Lucas is (rightly) upset
- `cleanupPeriodDays` default **30** (docs: settings-reference + data-usage).
  Transcripts under ~/.claude/projects older than that are deleted by a sweep
  after each session start. Not set in his settings.
- His last session before this run was **2026-08-23**, then a month off, so the
  sweep took everything before 2026-08-28. That is the "months" he is missing.
- **What survives:** `~/.claude/history.jsonl` — 2,100 entries, EVERYTHING HE
  TYPED back to **2026-04-03** (display, project, sessionId). claude-mem:
  1,205 summaries back to **2026-06-04**. Nothing earlier than April locally.
- **No further loss until 2026-10-22** (oldest surviving transcript is 09-22).
- To stop it: raise `cleanupPeriodDays` (e.g. 3650). Tradeoff to state:
  transcripts are PLAINTEXT on disk. Privacy setting — ask, do not just set.
  A backup of ~/.claude/projects is the belt-and-braces option.

### Housekeeping
- Session scratchpad (/tmp) was WIPED when the session closed — lost every
  probe AND the voice test clips (fresh3.wav, sp4.wav) that the Moonshine v2
  retest instructions reference. Dev tools now live in **`.dev/`** (listed in
  `.git/info/exclude`). `.dev/watch-live.mjs` = self-reconnecting watcher.
- Test sessions for interop: `~/interop-test` (PINEAPPLE-42 Claude, MANGO-17
  Hermes). The Claude one does NOT show in `claude --resume` only because I made
  it with `claude -p`, which stamps `sdk-cli` and the picker hides SDK sessions —
  a test-setup artifact, not a real gap.
- claude-mem's prune hook is SAFE (scoped to its plugin cache, exits if it
  cannot cd there) — but it likely pruned 13.25.3 out from under the long-running
  session on 09-26: every OpenLive voice session is a real CC session and fires
  SessionStart hooks.
