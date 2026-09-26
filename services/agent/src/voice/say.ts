import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { DATA_DIR } from "@openlive/db";
import { log } from "../log.js";

// Fast local speech synthesis: KittenTTS nano through the sherpa-onnx Node
// addon — the same native runtime as STT and the ZipVoice cloning engine, so
// again no new dependency.
//
// Why a small model: measured on a 2-core CPU, time to the FIRST spoken
// sentence (which is what a caller actually waits through, since the pipeline
// already synthesizes sentence by sentence):
//   KittenTTS nano fp32, native   ~3-5 s   <- this
//   Kokoro 82M, in-browser WASM   ~12.5 s  (the current default)
//   Kokoro 82M, native int8        67 s    tried, far worse, rejected
//   ZipVoice cloning, native      110 s    upstream's own note claims 0.22x
//                                          realtime; on this machine it is
//                                          ~0.06x, so cloning is not viable here
// Nano's voices are noticeably rougher than Kokoro's. It is offered as a
// choice, not a replacement — the engine stays user-selectable in Settings.

const MODELS_DIR = resolve(DATA_DIR, "models");
const IDLE_UNLOAD_MS = 30 * 60_000; // a reload mid-call costs ~7 s; holding is cheaper

// Voice id -> model directory under data/models. Piper/VITS voices are one
// single-speaker model each; KittenTTS is one model with 8 speaker rows.
// Measured on this machine, "Yeah, I'm here.": piper-medium ~2.1-2.9s,
// kitten ~2.2-3.3s, and piper-HIGH ~42s — the high tier is unusable here,
// so only `medium` voices are offered.
const VOICES: Record<string, { dir: string; kind: "vits" | "kitten"; sid?: number }> = {
  // "-low" is piper's small tier: the SAME voice and accent, a smaller model.
  // It is the difference between synthesis that keeps up with speech and
  // synthesis that cannot. Measured here on the same sentence:
  //   medium  first audio 3.9s, 0.51x realtime  -> the queue grows forever
  //   low     first audio 0.9s, 1.74x realtime  -> the queue can never grow
  // Below 1x every reply adds to a backlog; above it, gaps between sentences
  // stop happening at all. Not every voice has a low tier.
  "alan_low": { dir: "piper-en_GB-alan-low", kind: "vits" },
  "southern_english_female_low": { dir: "piper-en_GB-southern_english_female-low", kind: "vits" },
  "northern_english_male": { dir: "piper-en_GB-northern_english_male-medium", kind: "vits" },
  "southern_english_female": { dir: "piper-en_GB-southern_english_female-medium", kind: "vits" },
  "alan": { dir: "piper-en_GB-alan-medium", kind: "vits" },
  "alba": { dir: "piper-en_GB-alba-medium", kind: "vits" },
  "lessac": { dir: "piper-en_US-lessac-medium", kind: "vits" },
  "jenny": { dir: "piper-en_GB-jenny_dioco-medium", kind: "vits" },
  "ryan": { dir: "piper-en_US-ryan-medium", kind: "vits" },
  "glados": { dir: "piper-glados", kind: "vits" },
  "kitten": { dir: "kitten", kind: "kitten", sid: 0 },
};
export const SAY_VOICE_IDS = Object.keys(VOICES);
const DEFAULT_VOICE = "alan_low";

function dirOf(voice: string): { path: string; kind: "vits" | "kitten"; sid: number } | null {
  const v = VOICES[voice] ?? VOICES[DEFAULT_VOICE];
  if (!v) return null;
  return { path: join(MODELS_DIR, v.dir), kind: v.kind, sid: v.sid ?? 0 };
}

function onnxIn(dir: string): string | null {
  try { return readdirSync(dir).find((f) => f.endsWith(".onnx")) ?? null; } catch { return null; }
}

/** Any installed voice at all? */
export function sayInstalled(): boolean {
  return SAY_VOICE_IDS.some((v) => voiceInstalled(v));
}

export function voiceInstalled(voice: string): boolean {
  const d = dirOf(voice);
  if (!d) return false;
  return !!onnxIn(d.path) && existsSync(join(d.path, "tokens.txt")) && existsSync(join(d.path, "espeak-ng-data"));
}

/** Installed voice ids, for the client's voice picker. */
export function installedVoices(): string[] {
  return SAY_VOICE_IDS.filter(voiceInstalled);
}

type Tts = {
  generateAsync(req: unknown): Promise<{ samples: Float32Array; sampleRate: number }>;
  sampleRate: number;
  numSpeakers: number;
};
type Sherpa = { OfflineTts: new (cfg: unknown) => Tts };

let sherpa: Sherpa | null = null;
// One loaded engine at a time: holding several voices resident would cost more
// RAM than a 2-core machine should spend. Switching voices reloads (~7s once).
export type Tuning = { noiseScale?: number; noiseScaleW?: number; silenceScale?: number; maxNumSentences?: number };
const tuneKey = (t?: Tuning) => `${t?.noiseScale ?? ""}|${t?.noiseScaleW ?? ""}|${t?.silenceScale ?? ""}|${t?.maxNumSentences ?? ""}`;
// Tuning is CONSTRUCTOR config, not per-call, so a change has to rebuild the
// engine — hence it keys the cache alongside the voice.
let engine: { voice: string; key: string; tts: Tts } | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let queue: Promise<unknown> = Promise.resolve(); // own queue — never shared with STT or cloning

function loadEngine(voice: string, tune?: Tuning): Tts {
  const key = tuneKey(tune);
  if (engine?.voice === voice && engine.key === key) return engine.tts;
  const d = dirOf(voice);
  const onnx = d && onnxIn(d.path);
  if (!d || !onnx) throw new Error(`voice "${voice}" not installed`);
  sherpa ??= createRequire(import.meta.url)("sherpa-onnx-node") as Sherpa;
  const t = Date.now();
  // 1 thread, not 2: STT and TTS live in the same process and share the CPU
  // with the coding agent -- asking for 2 each oversubscribed a 2-core box.
  const common = { numThreads: 1, debug: 0, provider: "cpu" };
  // noiseScale / noiseScaleW are VITS sampling controls, not speed: VITS samples
  // a delivery rather than producing one fixed reading. noiseScale varies pitch
  // and emphasis (low = flat and repeatable, high = livelier but wobblier);
  // noiseScaleW varies phoneme DURATIONS (low = metronomic, high = looser). A
  // nudge up can put some life back into the smaller low-tier models.
  const vitsTune = {
    ...(tune?.noiseScale !== undefined ? { noiseScale: tune.noiseScale } : {}),
    ...(tune?.noiseScaleW !== undefined ? { noiseScaleW: tune.noiseScaleW } : {}),
  };
  const model = d.kind === "kitten"
    ? { kitten: { model: join(d.path, onnx), voices: join(d.path, "voices.bin"), tokens: join(d.path, "tokens.txt"), dataDir: join(d.path, "espeak-ng-data") }, ...common }
    : { vits: { model: join(d.path, onnx), tokens: join(d.path, "tokens.txt"), dataDir: join(d.path, "espeak-ng-data"), ...vitsTune }, ...common };
  const tts = new sherpa.OfflineTts({
    model,
    // 1 by default: the caller already chunks by sentence, which keeps latency
    // per piece low. silenceScale only trims the gaps sherpa itself inserts
    // BETWEEN sentences, so it does nothing at 1 — raise this to hear it.
    maxNumSentences: tune?.maxNumSentences ?? 1,
    ...(tune?.silenceScale !== undefined ? { silenceScale: tune.silenceScale } : {}),
  });
  engine = { voice, key, tts };
  log.debug("voice", `say engine "${voice}" loaded in ${Date.now() - t}ms`);
  return tts;
}

function touchIdle(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { engine = null; log.debug("voice", "say engine unloaded (idle)"); }, IDLE_UNLOAD_MS);
  idleTimer.unref?.();
}

/** The output rate of a voice's engine. The streaming response must declare the
 *  rate in a header before the first chunk exists, so ASK THE ENGINE rather than
 *  assume: piper ships the same voice at several sizes and they do NOT share a
 *  rate — the medium tier is 22.05 kHz but the low tier is 16 kHz. Guessing
 *  22.05 for both played low-tier audio 1.38x too fast and pitched up.
 *  Loading is idempotent and cached, and synthesis is about to load it anyway. */
export function sayRate(voice = DEFAULT_VOICE, tune?: Tuning): number {
  try { return loadEngine(voice, tune).sampleRate; } catch { return 22050; }
}

/** Synthesize `text` with voice `voice`. Serialized on one engine handle.
 *  `onChunk` receives audio AS IT IS GENERATED, so a reply can start playing
 *  while the rest is still being made — measured here, first audio at 1.3s
 *  against 7.6s for the finished result, and the gap grows with length.
 *  NOTE: requires sherpa-onnx-node >= 1.13.5. On 1.13.4 this callback aborted
 *  the process with a fatal OOM in napi_create_arraybuffer on ~50% of runs
 *  (k2-fsa/sherpa-onnx#3989); 1.13.8 measured 16/16 clean. */
export function say(
  text: string,
  voice = DEFAULT_VOICE,
  speed = 1,
  onChunk?: (samples: Float32Array, sampleRate: number) => void,
  tune?: Tuning,
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const run = queue.then(async () => {
    const tts = loadEngine(voice, tune);
    const sid = dirOf(voice)?.sid ?? 0;
    const rate = tts.sampleRate;
    // The lexicon drops OOV punctuation with a warning — same clean-up the
    // cloning engine does.
    const clean = text.replace(/[—–]/g, ", ").trim();
    const audio = await tts.generateAsync({
      text: clean, sid, speed,
      ...(onChunk ? { onProgress: (info: { samples: Float32Array }) => {
        // Copy: the addon's buffer is not ours to keep past the callback.
        try { onChunk(Float32Array.from(info.samples), rate); } catch { /* consumer gone */ }
        return 1; // returning 0 would cancel synthesis
      } } : {}),
    });
    touchIdle();
    return audio;
  });
  queue = run.catch(() => { /* a failed line must not wedge the queue */ });
  return run;
}
