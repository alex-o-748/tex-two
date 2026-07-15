import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import QRCode from 'qrcode';

import type { Env } from './types';
import * as db from './db';
import { describePainting } from './claude';
import { processSubmission } from './pipeline';
import { bufferToBase64 } from './util';
import { submitPage, confirmationPage, showPage, curatePage } from './views';

const app = new Hono<{ Bindings: Env }>();

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
  const painting = await db.getPainting(c.env, c.req.param('id'));
  if (!painting) return c.notFound();
  return c.html(submitPage(painting));
});

app.post('/p/:id', async (c) => {
  const painting = await db.getPainting(c.env, c.req.param('id'));
  if (!painting) return c.notFound();
  const body = await c.req.parseBody();
  const prompt = String(body.prompt ?? '').trim().slice(0, 400);
  const name = String(body.name ?? '').trim().slice(0, 40) || null;
  if (!prompt) return c.redirect(`/p/${painting.id}`);

  const id = crypto.randomUUID();
  await db.insertSubmission(c.env, {
    id,
    painting_id: painting.id,
    prompt_text: prompt,
    contributor_name: name,
  });
  // Generate in the background; the wall picks it up on its next /api/feed poll.
  c.executionCtx.waitUntil(runGeneration(c.env, id));
  return c.html(confirmationPage(painting));
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
  const paintings = await db.listPaintings(c.env);
  const withQr = await Promise.all(
    paintings.map(async (p) => {
      const submitUrl = `${base}/p/${p.id}`;
      const qr = await QRCode.toString(submitUrl, { type: 'svg', margin: 1, width: 96 });
      return { ...p, submit_url: submitUrl, qr };
    })
  );
  const derivatives = await db.listAllDerivatives(c.env);
  const needsAttention = await db.listNeedsAttention(c.env);
  return c.json({ paintings: withQr, derivatives, needs_attention: needsAttention });
});

app.post('/api/curate/upload', async (c) => {
  const body = await c.req.parseBody();
  const title = String(body.title ?? '').trim().slice(0, 120) || 'Untitled';
  const file = body.image;
  if (!(file instanceof File)) return c.json({ error: 'no image' }, 400);

  const mediaType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const ext = mediaType === 'image/jpeg' ? 'jpg' : 'png';
  const id = crypto.randomUUID();
  const key = `paintings/${id}.${ext}`;
  const bytes = await file.arrayBuffer();

  await c.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mediaType } });

  let profile = { description: '', styleNotes: '' };
  try {
    profile = await describePainting(c.env, {
      imageBase64: bufferToBase64(bytes),
      mediaType,
      title,
    });
  } catch (e) {
    // Non-fatal: painting still works without an auto-description.
    console.error('describePainting failed', e);
  }

  await db.insertPainting(c.env, {
    id,
    title,
    r2_key: key,
    media_type: mediaType,
    description: profile.description || null,
    style_notes: profile.styleNotes || null,
  });
  return c.json({ ok: true, id });
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
