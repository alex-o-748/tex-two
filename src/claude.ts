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
    signal: AbortSignal.timeout(30_000),
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
      'You are a light-touch content filter for an ADULT fine-art gallery. Assume a mature ' +
      'audience. Allow dark, macabre, surreal, grotesque, violent-as-art, sexual-in-an-' +
      'artistic-sense, political, provocative, and critical ideas — this is art, err on the ' +
      'side of allowing. Only reject a narrow hard floor: explicit pornographic/hardcore ' +
      'sexual content, ANY sexual content involving minors, hate symbols or harassment ' +
      'targeting a protected group, or a request to depict a real, identifiable private ' +
      'person in a defamatory or harmful way. When unsure, ALLOW. Respond with ONLY a JSON ' +
      'object: {"allowed": boolean, "reason": string}. Keep reason short.',
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
      'receives the ORIGINAL drawing plus your instruction, and must transform it while ' +
      "keeping the drawing's identity and medium recognizable. Given a description of the " +
      "original drawing, its style, and an audience member's idea, output ONE vivid, " +
      'concrete edit instruction (1-3 sentences). Preserve the original composition and ' +
      'drawing style unless the idea explicitly asks to change them. Do not add text, ' +
      'watermarks, or unsafe content. Output only the instruction, no preamble.',
    content:
      `ORIGINAL DRAWING: ${args.description ?? '(no description)'}\n` +
      `STYLE: ${args.styleNotes ?? '(unknown)'}\n` +
      `AUDIENCE IDEA: ${args.prompt}`,
    maxTokens: 300,
  });
  return instruction || args.prompt;
}

export interface DrawingProfile {
  description: string;
  styleNotes: string;
}

/** One-time vision pass at setup: describe a drawing so later prompts can be seeded. */
export async function describeDrawing(
  env: Env,
  args: { imageBase64: string; mediaType: string; title: string }
): Promise<DrawingProfile> {
  const text = await callClaude(env, {
    system:
      'You are an art curator. Given a drawing image and its title, respond with ONLY a ' +
      'JSON object: {"description": string, "styleNotes": string}. "description" is 2-3 ' +
      'sentences capturing subject, setting, mood, and notable elements. "styleNotes" is a ' +
      'short phrase for medium/technique/palette (e.g. "loose graphite sketch, warm ' +
      'ochre wash").',
    content: [
      { type: 'image', source: { type: 'base64', media_type: args.mediaType, data: args.imageBase64 } },
      { type: 'text', text: `Title: ${args.title}` },
    ],
    maxTokens: 400,
  });
  const parsed = extractJson<DrawingProfile>(text);
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
      'You are a light-touch content filter for an ADULT fine-art gallery wall. Assume a ' +
      'mature audience. Dark, macabre, grotesque, bloody, skeletal, nude (non-explicit), ' +
      'surreal, disturbing, and provocative imagery is all acceptable ART — allow it. Only ' +
      'reject a narrow hard floor: explicit pornographic/hardcore sexual imagery, ANY ' +
      'sexual depiction of a minor, hate symbols, or a realistic depiction of a real ' +
      'identifiable private person in a defamatory/harmful way. When unsure, ALLOW. ' +
      'Respond with ONLY JSON: {"allowed": boolean, "reason": string}.',
    content: [
      { type: 'image', source: { type: 'base64', media_type: args.mediaType, data: args.imageBase64 } },
      { type: 'text', text: 'Is this acceptable for an adult art gallery wall?' },
    ],
    maxTokens: 200,
  });
  const parsed = extractJson<ModerationResult>(text);
  if (!parsed || typeof parsed.allowed !== 'boolean') {
    return { allowed: false, reason: 'image moderation unavailable' };
  }
  return { allowed: parsed.allowed, reason: parsed.reason ?? '' };
}
