import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import QRCode from 'qrcode';

import type { Env } from './types';
import * as db from './db';
import { describeDrawing } from './claude';
import { processSubmission } from './pipeline';
import { bufferToBase64 } from './util';
import { submitPage, confirmationPage, showPage, curatePage } from './views';

const app = new Hono<{ Bindings: Env }>();

// Surface backend failures instead of an opaque 500. Everything under
// /api/curate/* is behind basic auth (curator-only), so it's safe to return the
// real error text there — this is what turns a silent "Approve anyway" failure
// (e.g. a DB missing a migration) into a diagnosable message. The error is also
// logged so it shows up in Workers observability.
app.onError((err, c) => {
  console.error(`${c.req.method} ${c.req.path} failed:`, err);
  const message = err instanceof Error ? err.message : String(err);
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: message }, 500);
  }
  return c.text('Internal Server Error', 500);
});

/**
 * Claim a submission and run the generation pipeline. Used both by the submit
 * request's fast-path (ctx.waitUntil) and by the cron backstop. The atomic claim
 * ensures only one of them processes a given row. On a thrown error we mark it
 * `rejected` (visible on /curate with a Retry button); jobs whose worker is
 * evicted mid-run stay `generating` and are recovered by the cron reaper.
 */
async function runGeneration(env: Env, submissionId: string): Promise<void> {
  if (!(await db.claimSubmission(env, submissionId))) return; // already claimed elsewhere
  try {
    await processSubmission(env, submissionId);
  } catch (e) {
    console.error('generation failed for', submissionId, e);
    await db.setSubmissionStatus(env, submissionId, 'rejected', 'generation failed');
  }
}

/** Cron backstop: recover stuck jobs, then process a few queued submissions. */
async function processBatch(env: Env): Promise<void> {
  await db.reapStuck(env);
  const ids = await db.listQueuedIds(env, 2);
  for (const id of ids) {
    await runGeneration(env, id);
  }
}

// ---- Auth on curator surfaces ----
const gate = basicAuth({
  verifyUser: (_user, pass, c) => pass === (c.env as Env).CURATE_PASSWORD,
});
app.use('/curate', gate);
app.use('/api/curate/*', gate);

// ---- Root ----
app.get('/', (c) => c.redirect('/curate'));

// ---- Image serving from R2 ----
app.get('/img/*', async (c) => {
  const key = c.req.path.slice('/img/'.length);
  const obj = await c.env.BUCKET.get(key);
  if (!obj) return c.notFound();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  return new Response(obj.body, { headers });
});

// ---- Submit surface ----
app.get('/p/:id', async (c) => {
  const drawing = await db.getDrawing(c.env, c.req.param('id'));
  if (!drawing) return c.notFound();
  return c.html(submitPage(drawing));
});

app.post('/p/:id', async (c) => {
  const drawing = await db.getDrawing(c.env, c.req.param('id'));
  if (!drawing) return c.notFound();
  const body = await c.req.parseBody();
  const prompt = String(body.prompt ?? '').trim().slice(0, 400);
  const name = String(body.name ?? '').trim().slice(0, 40) || null;
  if (!prompt) return c.redirect(`/p/${drawing.id}`);

  const id = crypto.randomUUID();
  await db.insertSubmission(c.env, {
    id,
    drawing_id: drawing.id,
    prompt_text: prompt,
    contributor_name: name,
  });
  // Generate in the background; the wall picks it up on its next /api/feed poll.
  c.executionCtx.waitUntil(runGeneration(c.env, id));
  return c.html(confirmationPage(drawing));
});

// Visitor-edited upload: the visitor downloads the drawing, edits it in their own
// tools, and uploads their version. No AI transform — we store their image as the
// derivative directly and let the pipeline moderate it before it reaches the wall.
app.post('/p/:id/upload', async (c) => {
  const drawing = await db.getDrawing(c.env, c.req.param('id'));
  if (!drawing) return c.notFound();

  const body = await c.req.parseBody();
  const file = body.image;
  if (!(file instanceof File) || !/^image\/(png|jpe?g)$/.test(file.type)) {
    return c.html(submitPage(drawing, 'Please choose a PNG or JPEG image.'));
  }

  const isJpeg = /jpe?g$/.test(file.type);
  const mediaType = isJpeg ? 'image/jpeg' : 'image/png';
  const ext = isJpeg ? 'jpg' : 'png';
  const bytes = await file.arrayBuffer();
  const name = String(body.name ?? '').trim().slice(0, 40) || null;
  const caption = String(body.caption ?? '').trim().slice(0, 400) || 'Edited by hand';

  // Store the visitor's image as the derivative up front, then attach a submission
  // so the standard claim/moderation/gate machinery (and the cron backstop) applies.
  const submissionId = crypto.randomUUID();
  const derivativeId = crypto.randomUUID();
  const key = `derivatives/${derivativeId}.${ext}`;
  await c.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mediaType } });

  await db.insertSubmission(c.env, {
    id: submissionId,
    drawing_id: drawing.id,
    prompt_text: caption,
    contributor_name: name,
    kind: 'upload',
  });
  await db.insertDerivative(c.env, {
    id: derivativeId,
    submission_id: submissionId,
    drawing_id: drawing.id,
    r2_key: key,
    media_type: mediaType,
    crafted_prompt: null,
  });

  c.executionCtx.waitUntil(runGeneration(c.env, submissionId));
  return c.html(confirmationPage(drawing, 'upload'));
});

// ---- Projection wall ----
app.get('/show', (c) => c.html(showPage()));

app.get('/api/feed', async (c) => {
  const items = await db.listApproved(c.env);
  return c.json(items);
});

// ---- Curator surface ----
app.get('/curate', (c) => c.html(curatePage()));

app.get('/api/curate/state', async (c) => {
  const base = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
  const drawings = await db.listDrawings(c.env);
  const withQr = await Promise.all(
    drawings.map(async (p) => {
      const submitUrl = `${base}/p/${p.id}`;
      const qr = await QRCode.toString(submitUrl, { type: 'svg', margin: 1, width: 96 });
      return { ...p, submit_url: submitUrl, qr };
    })
  );
  const derivatives = await db.listAllDerivatives(c.env);
  const needsAttention = await db.listNeedsAttention(c.env);
  return c.json({ drawings: withQr, derivatives, needs_attention: needsAttention });
});

// Add a drawing. Handles one image per request; the curator dashboard fans a
// multi-file selection out into one call per image (each runs its own Claude
// describe, so batching them server-side would blow the Worker's CPU/subrequest
// budget). The title defaults to the client-supplied filename-derived name.
app.post('/api/curate/upload', async (c) => {
  const body = await c.req.parseBody();
  const title = String(body.title ?? '').trim().slice(0, 120) || 'Untitled';
  const file = body.image;
  if (!(file instanceof File)) return c.json({ error: 'no image' }, 400);
  if (!/^image\/(png|jpe?g)$/.test(file.type)) {
    return c.json({ error: 'unsupported image type (use PNG or JPEG)' }, 400);
  }

  const mediaType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const ext = mediaType === 'image/jpeg' ? 'jpg' : 'png';
  const id = crypto.randomUUID();
  const key = `drawings/${id}.${ext}`;
  const bytes = await file.arrayBuffer();

  await c.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mediaType } });

  let profile = { description: '', styleNotes: '' };
  try {
    profile = await describeDrawing(c.env, {
      imageBase64: bufferToBase64(bytes),
      mediaType,
      title,
    });
  } catch (e) {
    // Non-fatal: drawing still works without an auto-description.
    console.error('describeDrawing failed', e);
  }

  await db.insertDrawing(c.env, {
    id,
    title,
    r2_key: key,
    media_type: mediaType,
    description: profile.description || null,
    style_notes: profile.styleNotes || null,
  });
  return c.json({ ok: true, id });
});

// Edit a painting's auto-generated profile. The description + style seed every
// future edit instruction, so this is how a curator corrects an off description;
// new submissions pick it up immediately (existing derivatives via Retry).
app.post('/api/curate/painting/:id', async (c) => {
  const id = c.req.param('id');
  const drawing = await db.getDrawing(c.env, id);
  if (!drawing) return c.json({ error: 'not found' }, 404);
  const { description, style_notes } = await c.req.json<{
    description?: string;
    style_notes?: string;
  }>();
  await db.updatePaintingProfile(
    c.env,
    id,
    String(description ?? '').trim().slice(0, 2000),
    String(style_notes ?? '').trim().slice(0, 400)
  );
  return c.json({ ok: true });
});

// Approve / hide / retry a submission.
app.post('/api/curate/submission/:id/:action', async (c) => {
  const id = c.req.param('id');
  const action = c.req.param('action');
  if (action === 'approve') await db.setSubmissionStatus(c.env, id, 'approved');
  else if (action === 'hide') await db.setSubmissionStatus(c.env, id, 'hidden');
  else if (action === 'retry') await db.retrySubmission(c.env, id);
  else if (action === 'override') await db.approveAnyway(c.env, id);
  else return c.json({ error: 'unknown action' }, 400);
  return c.json({ ok: true });
});

// Feature / unfeature a derivative (bumps it to the front of the rotation).
app.post('/api/curate/derivative/:id/feature', async (c) => {
  const id = c.req.param('id');
  const { featured } = await c.req.json<{ featured: boolean }>();
  await db.setFeatured(c.env, id, !!featured);
  return c.json({ ok: true });
});

export default {
  fetch: app.fetch,

  // Cron trigger (every minute): durable backstop for the generation pipeline.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(processBatch(env));
  },
};
