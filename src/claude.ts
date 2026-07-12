import type { Env } from './types';
import { extractJson } from './util';

// Cheap + fast + vision-capable: right fit for moderation and prompt work.
const MODEL = 'claude-haiku-4-5';
const API = 'https://api.anthropic.com/v1/messages';

type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

async function callClaude(
  env: Env,
  opts: { system: string; content: string | Block[]; maxTokens?: number }
): Promise<string> {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: opts.maxTokens ?? 512,
      system: opts.system,
      messages: [{ role: 'user', content: opts.content }],
    }),
  });
  if (!res.ok) {
    throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  return (data.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
}

export interface ModerationResult {
  allowed: boolean;
  reason: string;
}

/** Safety-check a visitor's free-text prompt before it drives image generation. */
export async function moderateText(env: Env, prompt: string): Promise<ModerationResult> {
  const text = await callClaude(env, {
    system:
      'You are a content-safety filter for a public art installation open to all ages. ' +
      'Reject prompts that request sexual/explicit content, hate or harassment, graphic ' +
      'violence or gore, self-harm, illegal acts, or that target/identify a real private ' +
      'individual, or that contain personal data (PII). Playful, weird, surreal, political, ' +
      'or critical ideas are fine. Respond with ONLY a JSON object: ' +
      '{"allowed": boolean, "reason": string}. Keep reason short.',
    content: prompt,
    maxTokens: 200,
  });
  const parsed = extractJson<ModerationResult>(text);
  // Fail closed if the model reply is unparseable.
  if (!parsed || typeof parsed.allowed !== 'boolean') {
    return { allowed: false, reason: 'moderation unavailable' };
  }
  return { allowed: parsed.allowed, reason: parsed.reason ?? '' };
}

/** Turn a raw audience prompt into a strong, safe image-EDIT instruction. */
export async function craftEditInstruction(
  env: Env,
  args: { prompt: string; description: string | null; styleNotes: string | null }
): Promise<string> {
  const instruction = await callClaude(env, {
    system:
      'You write concise image-editing instructions for an AI image editor. The editor ' +
      'receives the ORIGINAL painting plus your instruction, and must transform it while ' +
      "keeping the painting's identity and medium recognizable. Given a description of the " +
      "original painting, its style, and an audience member's idea, output ONE vivid, " +
      'concrete edit instruction (1-3 sentences). Preserve the original composition and ' +
      'painterly style unless the idea explicitly asks to change them. Do not add text, ' +
      'watermarks, or unsafe content. Output only the instruction, no preamble.',
    content:
      `ORIGINAL PAINTING: ${args.description ?? '(no description)'}\n` +
      `STYLE: ${args.styleNotes ?? '(unknown)'}\n` +
      `AUDIENCE IDEA: ${args.prompt}`,
    maxTokens: 300,
  });
  return instruction || args.prompt;
}

export interface PaintingProfile {
  description: string;
  styleNotes: string;
}

/** One-time vision pass at setup: describe a painting so later prompts can be seeded. */
export async function describePainting(
  env: Env,
  args: { imageBase64: string; mediaType: string; title: string }
): Promise<PaintingProfile> {
  const text = await callClaude(env, {
    system:
      'You are an art curator. Given a painting image and its title, respond with ONLY a ' +
      'JSON object: {"description": string, "styleNotes": string}. "description" is 2-3 ' +
      'sentences capturing subject, setting, mood, and notable elements. "styleNotes" is a ' +
      'short phrase for medium/technique/palette (e.g. "loose impressionist oil, warm ' +
      'ochre palette").',
    content: [
      { type: 'image', source: { type: 'base64', media_type: args.mediaType, data: args.imageBase64 } },
      { type: 'text', text: `Title: ${args.title}` },
    ],
    maxTokens: 400,
  });
  const parsed = extractJson<PaintingProfile>(text);
  return {
    description: parsed?.description ?? '',
    styleNotes: parsed?.styleNotes ?? '',
  };
}

/** Safety-check a generated derivative image before it can reach the wall. */
export async function moderateImage(
  env: Env,
  args: { imageBase64: string; mediaType: string }
): Promise<ModerationResult> {
  const text = await callClaude(env, {
    system:
      'You are a content-safety filter for a public all-ages art wall. Given an image, ' +
      'reject it if it contains sexual/explicit content, hate symbols, graphic violence or ' +
      'gore, or a realistic depiction of a real identifiable private person in a ' +
      'compromising way. Artistic, surreal, and abstract imagery is fine. Respond with ' +
      'ONLY JSON: {"allowed": boolean, "reason": string}.',
    content: [
      { type: 'image', source: { type: 'base64', media_type: args.mediaType, data: args.imageBase64 } },
      { type: 'text', text: 'Is this safe to display on a public art wall?' },
    ],
    maxTokens: 200,
  });
  const parsed = extractJson<ModerationResult>(text);
  if (!parsed || typeof parsed.allowed !== 'boolean') {
    return { allowed: false, reason: 'image moderation unavailable' };
  }
  return { allowed: parsed.allowed, reason: parsed.reason ?? '' };
}
