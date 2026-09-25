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
