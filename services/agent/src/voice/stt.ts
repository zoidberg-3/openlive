import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { DATA_DIR } from "@openlive/db";
import { log } from "../log.js";

// Speech-to-text on the agent service's CPU: Whisper tiny.en through the
// sherpa-onnx Node addon — the same native runtime the ZipVoice cloning engine
// already uses, so this adds no dependency.
//
// Why it lives here and not in the renderer: onnxruntime-WEB has no threads
// without cross-origin isolation, and measured 17–40 s per utterance in-call on
// a 2-core CPU, which silently blew the pipeline's deadline. Measured on this
// stack 2026-09-25, 4 s clip, same machine and load:
//   sherpa-onnx whisper tiny.en fp32   2.0–2.2 s  (~1.9× realtime)  ← this
//   sherpa-onnx whisper tiny.en int8   1.5–1.8 s  but drops words
//   onnxruntime-node via transformers  3.4–4.0 s
//   onnxruntime-web (WASM, renderer)  17–40 s
// fp32 is chosen over int8: +0.4 s buys back the words int8 mangles.
// decodeAsync runs on the native thread pool, so the agent's event loop — which
// is also driving the coding agent — never blocks.

export const STT_MODEL_DIR = resolve(DATA_DIR, "models", "whisper");
export const FAST_STT_DIR = resolve(DATA_DIR, "models", "moonshine");

const MODEL_FILES = ["tiny.en-encoder.onnx", "tiny.en-decoder.onnx", "tiny.en-tokens.txt"];
const FAST_FILES = ["preprocess.onnx", "encode.int8.onnx", "uncached_decode.int8.onnx", "cached_decode.int8.onnx", "tokens.txt"];

/** Is the fast (Moonshine) model installed? */
export function fastSttInstalled(): boolean {
  return FAST_FILES.every((f) => existsSync(join(FAST_STT_DIR, f)));
}

// Moonshine is ~2.9x faster than Whisper for the same words (2.1s vs 6.2s on an
// 8s utterance here), so it runs first and Whisper catches what it drops.
// A hit saves ~3.5s; a miss costs ~1s and the words still arrive.
//
// Its failure mode is to return an EMPTY transcript rather than an error, which
// is why this is detected rather than trusted. The trigger was investigated and
// is NOT any of the obvious candidates — all measured, all ruled out:
//   speaker/voice  same words decode fine in 2s windows of the SAME clip
//   volume         correct at 8x quieter (peak 0.064)
//   pitch          shifted +-30%, no change
//   clipping       normalising to 0.92 peak changed nothing
//   clip length    8s clips both succeed and fail
// What DOES decide it is the first ~1s: dropping it flips a failing clip to
// correct, every time. But it is not simply a loud lead-in — prepending a
// full-volume tone to a working clip keeps it working, while the SAME tone at
// 40% makes it fail. Trimming the lead-in was tried as a fix and does not work.
// So the behaviour is deterministic per input and unpredictable across inputs:
// detect the empty result, fall back, move on.
const isEmpty = (t: string) => t.replace(/[\s.,!?-]/g, "").length === 0;
const IDLE_UNLOAD_MS = 30 * 60_000; // ~200 MB resident; a reload mid-call costs ~7 s,
// which is worse than holding it -- a voice call can easily pause 5 min mid-thought.

export function sttInstalled(): boolean {
  return MODEL_FILES.every((f) => existsSync(join(STT_MODEL_DIR, f)));
}

type Recognizer = {
  createStream(): { acceptWaveform(o: { sampleRate: number; samples: Float32Array }): void };
  decodeAsync(stream: unknown): Promise<{ text?: string }>;
};
type Sherpa = { OfflineRecognizer: new (cfg: unknown) => Recognizer };

let sherpa: Sherpa | null = null;
let recognizer: Recognizer | null = null;
let fastRecognizer: Recognizer | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
// Own queue, deliberately NOT the TTS one in engine.ts: sharing it would make
// every transcription wait behind synthesis and rebuild the backlog it fixes.
let queue: Promise<unknown> = Promise.resolve();

function loadFast(): Recognizer | null {
  if (fastRecognizer) return fastRecognizer;
  if (!fastSttInstalled()) return null;
  sherpa ??= createRequire(import.meta.url)("sherpa-onnx-node") as Sherpa;
  const t = Date.now();
  fastRecognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      moonshine: {
        preprocessor: join(FAST_STT_DIR, "preprocess.onnx"),
        encoder: join(FAST_STT_DIR, "encode.int8.onnx"),
        uncachedDecoder: join(FAST_STT_DIR, "uncached_decode.int8.onnx"),
        cachedDecoder: join(FAST_STT_DIR, "cached_decode.int8.onnx"),
      },
      tokens: join(FAST_STT_DIR, "tokens.txt"),
      numThreads: 1, debug: 0, provider: "cpu",
    },
  });
  log.debug("voice", `fast stt engine loaded in ${Date.now() - t}ms`);
  return fastRecognizer;
}

function loadRecognizer(): Recognizer {
  if (recognizer) return recognizer;
  if (!sttInstalled()) throw new Error("stt model not installed");
  sherpa ??= createRequire(import.meta.url)("sherpa-onnx-node") as Sherpa;
  const t = Date.now();
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      whisper: {
        encoder: join(STT_MODEL_DIR, "tiny.en-encoder.onnx"),
        decoder: join(STT_MODEL_DIR, "tiny.en-decoder.onnx"),
        tailPaddings: -1,
      },
      tokens: join(STT_MODEL_DIR, "tiny.en-tokens.txt"),
      numThreads: 1, // STT and TTS share this process AND the CPU with the coding
      // agent: 2 threads each oversubscribed a 2-core box and made both slower.
      debug: 0,
      provider: "cpu",
    },
    decodingMethod: "greedy_search",
  });
  log.debug("voice", `stt engine loaded in ${Date.now() - t}ms`);
  return recognizer;
}

function touchIdle(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { recognizer = null; log.debug("voice", "stt engine unloaded (idle)"); }, IDLE_UNLOAD_MS);
  idleTimer.unref?.();
}

/** Transcribe mono PCM. Serialized on one recognizer handle. */
export function transcribe(samples: Float32Array, sampleRate: number): Promise<string> {
  const run = queue.then(async () => {
    const pcm = samples;
    const decode = async (rec: Recognizer) => {
      const stream = rec.createStream();
      stream.acceptWaveform({ sampleRate, samples: pcm });
      return ((await rec.decodeAsync(stream)).text ?? "").trim();
    };
    const fast = loadFast();
    if (fast) {
      const t = Date.now();
      const text = await decode(fast);
      if (!isEmpty(text)) {
        log.debug("voice", `stt fast: ${Date.now() - t}ms`);
        touchIdle();
        return text;
      }
      log.debug("voice", `stt fast returned empty in ${Date.now() - t}ms — falling back`);
    }
    const text = await decode(loadRecognizer());
    touchIdle();
    return text;
  });
  queue = run.catch(() => { /* a failed turn must not wedge the queue */ });
  return run;
}
