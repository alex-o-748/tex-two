import type { Env } from './types';
import * as db from './db';
import { moderateText, craftEditInstruction, moderateImage } from './claude';
import { imageProvider } from './imageProvider';
import { bufferToBase64 } from './util';

/**
 * Run the full per-submission pipeline for an already-CLAIMED submission
 * (status `generating`, set atomically by db.claimSubmission):
 *   moderate text -> craft edit instruction -> edit the original ->
 *   moderate the output image -> store derivative -> set status.
 *
 * Throws on transient/infrastructure failure so the caller can mark it failed /
 * let the cron backstop retry. "Content rejected" is a normal terminal outcome.
 */
export async function processSubmission(env: Env, submissionId: string): Promise<void> {
  const sub = await db.getSubmission(env, submissionId);
  if (!sub) return;

  // 1. Moderate the audience text.
  const textCheck = await moderateText(env, sub.prompt_text);
  if (!textCheck.allowed) {
    await db.setSubmissionStatus(env, sub.id, 'rejected', textCheck.reason || 'prompt blocked');
    return;
  }

  const painting = await db.getPainting(env, sub.painting_id);
  if (!painting) {
    await db.setSubmissionStatus(env, sub.id, 'rejected', 'painting missing');
    return;
  }

  // 2. Craft a strong edit instruction seeded by the painting profile.
  const instruction = await craftEditInstruction(env, {
    prompt: sub.prompt_text,
    description: painting.description,
    styleNotes: painting.style_notes,
  });

  // 3. Fetch the original from R2 and edit it.
  const original = await env.BUCKET.get(painting.r2_key);
  if (!original) {
    await db.setSubmissionStatus(env, sub.id, 'rejected', 'original image missing');
    return;
  }
  const originalBytes = await original.arrayBuffer();
  const edited = await imageProvider.edit(env, {
    imageBytes: originalBytes,
    mediaType: painting.media_type,
    instruction,
  });

  // 4. Moderate the generated image.
  const imgCheck = await moderateImage(env, {
    imageBase64: bufferToBase64(edited.bytes),
    mediaType: edited.mediaType,
  });
  if (!imgCheck.allowed) {
    await db.setSubmissionStatus(env, sub.id, 'rejected', imgCheck.reason || 'image blocked');
    return;
  }

  // 5. Store the derivative and record it.
  const derivativeId = crypto.randomUUID();
  const key = `derivatives/${derivativeId}.png`;
  await env.BUCKET.put(key, edited.bytes, {
    httpMetadata: { contentType: edited.mediaType },
  });
  await db.insertDerivative(env, {
    id: derivativeId,
    submission_id: sub.id,
    painting_id: sub.painting_id,
    r2_key: key,
    media_type: edited.mediaType,
    crafted_prompt: instruction,
  });

  // 6. Hybrid gate.
  const autoApprove = env.AUTO_APPROVE !== 'false';
  await db.setSubmissionStatus(env, sub.id, autoApprove ? 'approved' : 'pending_review');
}
