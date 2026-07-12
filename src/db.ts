import type { Env, Drawing, Submission, SubmissionStatus, Derivative } from './types';

// ---- Drawings ----

export async function insertDrawing(
  env: Env,
  p: Pick<Drawing, 'id' | 'title' | 'r2_key' | 'media_type' | 'description' | 'style_notes'>
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO drawings (id, title, r2_key, media_type, description, style_notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(p.id, p.title, p.r2_key, p.media_type, p.description, p.style_notes, Date.now())
    .run();
}

export async function getDrawing(env: Env, id: string): Promise<Drawing | null> {
  return env.DB.prepare(`SELECT * FROM drawings WHERE id = ?`).bind(id).first<Drawing>();
}

export async function listDrawings(env: Env): Promise<Drawing[]> {
  const r = await env.DB.prepare(`SELECT * FROM drawings ORDER BY created_at ASC`).all<Drawing>();
  return r.results ?? [];
}

// ---- Submissions ----

export async function insertSubmission(
  env: Env,
  s: Pick<Submission, 'id' | 'drawing_id' | 'prompt_text' | 'contributor_name'>
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO submissions (id, drawing_id, prompt_text, contributor_name, status, created_at)
     VALUES (?, ?, ?, ?, 'queued', ?)`
  )
    .bind(s.id, s.drawing_id, s.prompt_text, s.contributor_name, Date.now())
    .run();
}

export async function getSubmission(env: Env, id: string): Promise<Submission | null> {
  return env.DB.prepare(`SELECT * FROM submissions WHERE id = ?`).bind(id).first<Submission>();
}

export async function setSubmissionStatus(
  env: Env,
  id: string,
  status: SubmissionStatus,
  reason?: string
): Promise<void> {
  await env.DB.prepare(`UPDATE submissions SET status = ?, moderation_reason = ? WHERE id = ?`)
    .bind(status, reason ?? null, id)
    .run();
}

/**
 * Atomically claim a queued submission for processing. Flips it to `generating`,
 * stamps `claimed_at`, and bumps `attempts` — but only if it's still `queued`, so
 * the waitUntil fast-path and the cron backstop can never process the same row.
 * Returns true if this caller won the claim.
 */
export async function claimSubmission(env: Env, id: string): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE submissions
        SET status = 'generating', claimed_at = ?, attempts = attempts + 1
      WHERE id = ? AND status = 'queued'`
  )
    .bind(Date.now(), id)
    .run();
  return (r.meta.changes ?? 0) === 1;
}

const STUCK_MS = 180_000; // a claim older than this with no result is considered dead
const MAX_ATTEMPTS = 3;

/**
 * Recover jobs whose worker was evicted mid-pipeline (stuck in `generating`).
 * Exhausted ones (>= MAX_ATTEMPTS) are marked rejected; the rest are re-queued.
 */
export async function reapStuck(env: Env): Promise<void> {
  const cutoff = Date.now() - STUCK_MS;
  // A fresh claim always stamps claimed_at atomically, so a `generating` row with
  // NULL claimed_at is a legacy/orphaned job — treat it as stuck too.
  await env.DB.prepare(
    `UPDATE submissions
        SET status = 'rejected', moderation_reason = 'generation failed after retries'
      WHERE status = 'generating' AND (claimed_at IS NULL OR claimed_at < ?) AND attempts >= ?`
  )
    .bind(cutoff, MAX_ATTEMPTS)
    .run();
  await env.DB.prepare(
    `UPDATE submissions
        SET status = 'queued', claimed_at = NULL
      WHERE status = 'generating' AND (claimed_at IS NULL OR claimed_at < ?) AND attempts < ?`
  )
    .bind(cutoff, MAX_ATTEMPTS)
    .run();
}

/** IDs of submissions waiting to be processed, oldest first. */
export async function listQueuedIds(env: Env, limit: number): Promise<string[]> {
  const r = await env.DB.prepare(
    `SELECT id FROM submissions WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?`
  )
    .bind(limit)
    .all<{ id: string }>();
  return (r.results ?? []).map((row) => row.id);
}

/** Put a failed/blocked submission back in line, from the dashboard. */
export async function retrySubmission(env: Env, id: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE submissions
        SET status = 'queued', attempts = 0, claimed_at = NULL, moderation_reason = NULL
      WHERE id = ?`
  )
    .bind(id)
    .run();
}

/**
 * Curator override: publish a filter-rejected submission anyway.
 * - If a derivative already exists (image-stage rejection), just approve it — the
 *   image is already generated, no need to re-run the pipeline.
 * - Otherwise (text-stage rejection, no image yet) re-queue with override=1 so the
 *   pipeline regenerates while skipping both moderation steps.
 */
export async function approveAnyway(env: Env, id: string): Promise<void> {
  const existing = await env.DB.prepare(
    `SELECT id FROM derivatives WHERE submission_id = ? LIMIT 1`
  )
    .bind(id)
    .first<{ id: string }>();
  if (existing) {
    await env.DB.prepare(
      `UPDATE submissions SET status = 'approved', override = 1 WHERE id = ?`
    )
      .bind(id)
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE submissions
          SET status = 'queued', override = 1, attempts = 0, claimed_at = NULL, moderation_reason = NULL
        WHERE id = ?`
    )
      .bind(id)
      .run();
  }
}

/** Remove any derivative(s) for a submission (R2 objects + rows) before regenerating. */
export async function deleteDerivativesForSubmission(env: Env, submissionId: string): Promise<void> {
  const r = await env.DB.prepare(`SELECT r2_key FROM derivatives WHERE submission_id = ?`)
    .bind(submissionId)
    .all<{ r2_key: string }>();
  for (const row of r.results ?? []) {
    try {
      await env.BUCKET.delete(row.r2_key);
    } catch {
      /* best-effort */
    }
  }
  await env.DB.prepare(`DELETE FROM derivatives WHERE submission_id = ?`)
    .bind(submissionId)
    .run();
}

export interface AttentionItem extends Submission {
  derivative_key: string | null; // the flagged/generated image, if one exists
}

/** Submissions the curator may need to act on: failed, blocked, or in-flight. */
export async function listNeedsAttention(env: Env): Promise<AttentionItem[]> {
  const r = await env.DB.prepare(
    `SELECT s.*, d.r2_key AS derivative_key
       FROM submissions s
       LEFT JOIN derivatives d ON d.submission_id = s.id
      WHERE s.status IN ('rejected', 'queued', 'generating')
      ORDER BY s.created_at DESC LIMIT 100`
  ).all<AttentionItem>();
  return r.results ?? [];
}

// ---- Derivatives ----

export async function insertDerivative(
  env: Env,
  d: Pick<Derivative, 'id' | 'submission_id' | 'drawing_id' | 'r2_key' | 'media_type' | 'crafted_prompt'>
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO derivatives
       (id, submission_id, drawing_id, r2_key, media_type, crafted_prompt, featured, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`
  )
    .bind(d.id, d.submission_id, d.drawing_id, d.r2_key, d.media_type, d.crafted_prompt, Date.now())
    .run();
}

/** A derivative joined with its submission + drawing, for the wall and dashboard. */
export interface FeedItem {
  id: string;
  submission_id: string;
  drawing_id: string;
  drawing_title: string;
  original_key: string;
  derivative_key: string;
  prompt_text: string;
  contributor_name: string | null;
  status: SubmissionStatus;
  featured: number;
  sort_order: number;
  created_at: number;
}

const FEED_SELECT = `
  SELECT d.id, d.submission_id, d.drawing_id,
         p.title AS drawing_title, p.r2_key AS original_key,
         d.r2_key AS derivative_key,
         s.prompt_text, s.contributor_name, s.status,
         d.featured, d.sort_order, d.created_at
  FROM derivatives d
  JOIN submissions s ON s.id = d.submission_id
  JOIN drawings    p ON p.id = d.drawing_id`;

/** Approved, visible derivatives for the projection wall. */
export async function listApproved(env: Env): Promise<FeedItem[]> {
  const r = await env.DB.prepare(
    `${FEED_SELECT}
     WHERE s.status = 'approved'
     ORDER BY d.featured DESC, d.sort_order ASC, d.created_at DESC
     LIMIT 300`
  ).all<FeedItem>();
  return r.results ?? [];
}

/** Everything with a generated image, for the curator dashboard. */
export async function listAllDerivatives(env: Env): Promise<FeedItem[]> {
  const r = await env.DB.prepare(
    `${FEED_SELECT} ORDER BY d.created_at DESC LIMIT 500`
  ).all<FeedItem>();
  return r.results ?? [];
}

export async function setFeatured(env: Env, derivativeId: string, featured: boolean): Promise<void> {
  await env.DB.prepare(`UPDATE derivatives SET featured = ? WHERE id = ?`)
    .bind(featured ? 1 : 0, derivativeId)
    .run();
}

export async function setSortOrder(env: Env, derivativeId: string, order: number): Promise<void> {
  await env.DB.prepare(`UPDATE derivatives SET sort_order = ? WHERE id = ?`)
    .bind(order, derivativeId)
    .run();
}
