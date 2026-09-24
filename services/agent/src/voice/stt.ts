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

const MODEL_FILES = ["tiny.en-encoder.onnx", "tiny.en-decoder.onnx", "tiny.en-tokens.txt"];
const IDLE_UNLOAD_MS = 5 * 60_000; // the loaded recognizer holds ~200 MB

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
let idleTimer: ReturnType<typeof setTimeout> | undefined;
// Own queue, deliberately NOT the TTS one in engine.ts: sharing it would make
// every transcription wait behind synthesis and rebuild the backlog it fixes.
let queue: Promise<unknown> = Promise.resolve();

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
      numThreads: 2, // measured faster than 1 on 2 cores; decode is off-loop anyway
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
    const rec = loadRecognizer();
    const stream = rec.createStream();
    stream.acceptWaveform({ sampleRate, samples });
    const res = await rec.decodeAsync(stream);
    touchIdle();
    return (res.text ?? "").trim();
  });
  queue = run.catch(() => { /* a failed turn must not wedge the queue */ });
  return run;
}
