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
