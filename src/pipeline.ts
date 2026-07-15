import type { Env, Submission } from './types';
import * as db from './db';
import { moderateText, craftEditInstruction, moderateImage } from './claude';
import { imageProvider } from './imageProvider';
import { bufferToBase64 } from './util';

/**
 * Run the full per-submission pipeline for an already-CLAIMED submission
 * (status `generating`, set atomically by db.claimSubmission):
 *   moderate text -> craft edit instruction -> edit the original ->
 *   store derivative -> moderate the output image -> set status.
 *
 * The derivative is stored BEFORE image moderation, so a flagged image is kept
 * and the curator can preview + override it. If the submission's `override` flag
 * is set, both moderation steps are skipped entirely.
 *
 * Throws on transient/infrastructure failure so the caller can mark it failed /
 * let the cron backstop retry. "Content rejected" is a normal terminal outcome.
 */
export async function processSubmission(env: Env, submissionId: string): Promise<void> {
  const sub = await db.getSubmission(env, submissionId);
  if (!sub) return;
  const skipModeration = sub.override === 1;

  // Visitor-edited uploads take a separate, no-AI path: the image is already
  // stored (at upload time), so we only moderate it and gate it.
  if (sub.kind === 'upload') {
    return processUpload(env, sub, skipModeration);
  }

  // Fresh generation: clear any prior derivative for this submission (retry /
  // override-regenerate) so we never leave a duplicate image behind.
  await db.deleteDerivativesForSubmission(env, sub.id);

  // 1. Moderate the audience text (unless the curator overrode).
  if (!skipModeration) {
    const textCheck = await moderateText(env, sub.prompt_text);
    if (!textCheck.allowed) {
      await db.setSubmissionStatus(env, sub.id, 'rejected', textCheck.reason || 'prompt blocked');
      return;
    }
  }

  const drawing = await db.getDrawing(env, sub.drawing_id);
  if (!drawing) {
    await db.setSubmissionStatus(env, sub.id, 'rejected', 'drawing missing');
    return;
  }

  // 2. Craft a strong edit instruction seeded by the drawing profile.
  const instruction = await craftEditInstruction(env, {
    prompt: sub.prompt_text,
    description: drawing.description,
    styleNotes: drawing.style_notes,
  });

  // 3. Fetch the original from R2 and edit it.
  const original = await env.BUCKET.get(drawing.r2_key);
  if (!original) {
    await db.setSubmissionStatus(env, sub.id, 'rejected', 'original image missing');
    return;
  }
  const originalBytes = await original.arrayBuffer();
  const edited = await imageProvider.edit(env, {
    imageBytes: originalBytes,
    mediaType: drawing.media_type,
    instruction,
  });

  // 4. Store the derivative FIRST — a flagged image stays available for override.
  const derivativeId = crypto.randomUUID();
  const key = `derivatives/${derivativeId}.png`;
  await env.BUCKET.put(key, edited.bytes, {
    httpMetadata: { contentType: edited.mediaType },
  });
  await db.insertDerivative(env, {
    id: derivativeId,
    submission_id: sub.id,
    drawing_id: sub.drawing_id,
    r2_key: key,
    media_type: edited.mediaType,
    crafted_prompt: instruction,
  });

  // 5. Moderate the generated image (unless overridden). The image is kept either way.
  if (!skipModeration) {
    const imgCheck = await moderateImage(env, {
      imageBase64: bufferToBase64(edited.bytes),
      mediaType: edited.mediaType,
    });
    if (!imgCheck.allowed) {
      await db.setSubmissionStatus(env, sub.id, 'rejected', imgCheck.reason || 'image blocked');
      return;
    }
  }

  // 6. Hybrid gate.
  const autoApprove = env.AUTO_APPROVE !== 'false';
  await db.setSubmissionStatus(env, sub.id, autoApprove ? 'approved' : 'pending_review');
}

/**
 * Visitor-edited upload path (no AI): the image the visitor uploaded is already
 * stored as this submission's derivative. There is nothing to generate, so we
 * only moderate the caption + the uploaded image, then apply the same hybrid gate
 * as the AI path. The stored image is never deleted here, so a cron re-run just
 * re-moderates it (we can't re-fetch the visitor's original upload).
 */
async function processUpload(env: Env, sub: Submission, skipModeration: boolean): Promise<void> {
  const deriv = await db.getDerivativeForSubmission(env, sub.id);
  if (!deriv) {
    await db.setSubmissionStatus(env, sub.id, 'rejected', 'uploaded image missing');
    return;
  }

  if (!skipModeration) {
    // The caption is shown on the wall, so it goes through the same text filter.
    const textCheck = await moderateText(env, sub.prompt_text);
    if (!textCheck.allowed) {
      await db.setSubmissionStatus(env, sub.id, 'rejected', textCheck.reason || 'caption blocked');
      return;
    }

    const obj = await env.BUCKET.get(deriv.r2_key);
    if (!obj) {
      await db.setSubmissionStatus(env, sub.id, 'rejected', 'uploaded image missing');
      return;
    }
    const imgCheck = await moderateImage(env, {
      imageBase64: bufferToBase64(await obj.arrayBuffer()),
      mediaType: deriv.media_type,
    });
    if (!imgCheck.allowed) {
      await db.setSubmissionStatus(env, sub.id, 'rejected', imgCheck.reason || 'image blocked');
      return;
    }
  }

  const autoApprove = env.AUTO_APPROVE !== 'false';
  await db.setSubmissionStatus(env, sub.id, autoApprove ? 'approved' : 'pending_review');
}
