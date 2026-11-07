import { HttpError } from './http.ts';

/**
 * Workers AI calls. They run on the account owner's free daily neurons, need no API key, and the
 * model ids default to what the hub registry advertises; callers may pass another `@cf/` model.
 */
export const MODELS = {
  image: '@cf/black-forest-labs/flux-1-schnell',
  stt: '@cf/openai/whisper-large-v3-turbo',
  tts: '@cf/myshell-ai/melotts',
  summary: '@cf/meta/llama-3.1-8b-instruct-fast',
} as const;

/** Restricts the model a caller can pick to Workers AI ids, so the token can't drive arbitrary bindings. */
function pick(requested: unknown, fallback: string): string {
  if (requested === undefined || requested === null || requested === '') return fallback;
  if (typeof requested !== 'string' || !/^@cf\/[\w.-]+\/[\w.-]+$/.test(requested)) throw new HttpError(400, 'model must be a @cf/ id');
  return requested;
}

type Run = (model: string, input: Record<string, unknown>) => Promise<unknown>;

export async function image(run: Run, input: { prompt?: unknown; model?: unknown }): Promise<{ image: string }> {
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw new HttpError(400, 'prompt required');
  const out = (await run(pick(input.model, MODELS.image), { prompt: input.prompt.slice(0, 2048), steps: 4 })) as { image: string };
  return { image: out.image };
}

export async function stt(
  run: Run,
  input: { audio?: unknown; model?: unknown; language?: unknown; segments?: unknown },
): Promise<{ text: string; segments?: { start: number; end: number; text: string }[] }> {
  if (typeof input.audio !== 'string' || !input.audio) throw new HttpError(400, 'audio (base64) required');
  const out = (await run(pick(input.model, MODELS.stt), {
    audio: input.audio,
    ...(typeof input.language === 'string' && input.language && { language: input.language }),
  })) as { text: string; segments?: { start: number; end: number; text: string }[] };
  if (input.segments !== true) return { text: out.text };
  return { text: out.text, segments: (out.segments ?? []).map((x) => ({ start: x.start, end: x.end, text: x.text.trim() })) };
}

/** MeloTTS takes its own codes for Japanese and Korean, not ISO 639-1. */
const MELO_LANG: Record<string, string> = { ja: 'jp', ko: 'kr' };

export async function tts(run: Run, input: { text?: unknown; model?: unknown; language?: unknown }): Promise<{ audio: string; type: string }> {
  if (typeof input.text !== 'string' || !input.text.trim()) throw new HttpError(400, 'text required');
  const lang = typeof input.language === 'string' && input.language ? input.language : 'en';
  const out = (await run(pick(input.model, MODELS.tts), { prompt: input.text.slice(0, 4000), lang: MELO_LANG[lang] ?? lang })) as { audio: string };
  // MeloTTS returns WAV; other models may return MP3. "UklGR" is base64 for "RIFF".
  return { audio: out.audio, type: out.audio.startsWith('UklGR') ? 'audio/wav' : 'audio/mpeg' };
}
