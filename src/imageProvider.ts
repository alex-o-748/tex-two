import type { Env } from './types';
import { base64ToBuffer } from './util';

export interface EditRequest {
  imageBytes: ArrayBuffer;
  mediaType: string;
  instruction: string;
}

export interface EditResult {
  bytes: ArrayBuffer;
  mediaType: string;
}

export interface ImageProvider {
  /** Transform the given base image according to the instruction. */
  edit(env: Env, req: EditRequest): Promise<EditResult>;
}

/**
 * Default provider: OpenAI `gpt-image-1` edits endpoint. It takes the original
 * drawing as the base image and returns an edited version, which is exactly the
 * "transform the original" flow this installation uses.
 *
 * Swap this out (Gemini image edit, Replicate img2img, ...) by implementing the
 * same `ImageProvider` interface and exporting it as `imageProvider`.
 */
export const openaiProvider: ImageProvider = {
  async edit(env, req): Promise<EditResult> {
    const ext = req.mediaType === 'image/jpeg' ? 'jpg' : 'png';
    const form = new FormData();
    form.append('model', 'gpt-image-1');
    form.append('prompt', req.instruction);
    // 'auto' matches the source aspect ratio (drawings are usually landscape) so the
    // edit extends the scene instead of cropping it into a square and distorting it.
    form.append('size', 'auto');
    // Preserve the original drawing's style, palette, and structure.
    form.append('input_fidelity', 'high');
    // Higher render tier — sharper, less muddy output.
    form.append('quality', 'high');
    form.append(
      'image',
      new Blob([req.imageBytes], { type: req.mediaType }),
      `original.${ext}`
    );

    const res = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.IMAGE_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      throw new Error(`image provider ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { data?: Array<{ b64_json?: string }> };
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) throw new Error('image provider returned no image');
    return { bytes: base64ToBuffer(b64), mediaType: 'image/png' };
  },
};

export const imageProvider = openaiProvider;
