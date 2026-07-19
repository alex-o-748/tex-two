# tex-two — Interactive Art Installation 

Audience members reshape hung drawings from their phones; the AI-transformed
derivatives are projected back into the room as a live slideshow.

- **Submit** (`/p/:id`) — a QR placard by each drawing opens a phone form. Every
  idea transforms the **original drawing**; hint chips suggest what to ask.
- **Wall** (`/show`) — full-screen crossfade slideshow of approved derivatives,
  captioned with the prompt + contributor. Stays live by polling `/api/feed`.
- **Curator** (`/curate`, password-protected) — upload drawings one or many at a time
  (each auto-described by Claude, titled from its filename, QR placard rendered), and
  approve / hide / feature derivatives.

> The auto-generated **description** and **style** seed every edit instruction
> (`craftEditInstruction`), so they shape *all* derivatives of a painting. If they're
> wrong, correct them inline on the painting card in `/curate` — new submissions use the
> corrected text immediately; regenerate existing derivatives with **Retry**.

## How a prompt becomes an image

Claude does **not** generate images. The pipeline runs in the background after the
visitor's request returns (via `ctx.waitUntil` — no Queues needed):

1. Claude (`claude-haiku-4-5`) moderates the audience text.
2. Claude crafts a strong image-**edit** instruction, seeded by the drawing's
   auto-generated description + style.
3. An external image-edit model (`ImageProvider`, default OpenAI `gpt-image-1`)
   transforms the **original** drawing per the instruction.
4. Claude vision moderates the output image.
5. It's stored and — with `AUTO_APPROVE=true` — shown on the wall (artist can veto).

Moderation is a **light-touch adult-gallery** filter (`src/claude.ts`): dark, macabre,
surreal, and provocative art passes; only a narrow hard floor is auto-blocked (explicit
sexual content, sexual content involving minors, hate symbols, or harmful depictions of a
real identifiable person). A flagged derivative is still generated and stored, and the
curator can **Approve anyway** from the "Needs attention" panel — which publishes it to the
wall (setting an `override` flag that also bypasses the filter on regeneration). Tune the
policy in the two moderation prompts in `src/claude.ts`.

Generation runs on the submit request via `ctx.waitUntil` (fast path), with a
**Cron Trigger** (every minute) as a durable backstop: it recovers jobs whose worker
was evicted mid-run and retries transient failures (up to 3×). Blocked or failed
submissions surface in a **Needs attention** section on `/curate` with a **Retry**
button, so nothing fails silently.

## Stack

Cloudflare Workers (Hono) · D1 (SQLite) · R2 (images) · Wrangler. Runs on the
Workers **free** plan — the generation pipeline runs in-request via `ctx.waitUntil`,
so no Queues (and no paid plan) are required.

## Setup

```sh
npm install

# One-time Cloudflare resources (R2 must be enabled once in the dashboard)
wrangler d1 create tex-two-db          # paste database_id into wrangler.jsonc
wrangler r2 bucket create tex-two-images

# Schema (applies all migrations in ./migrations)
npm run db:migrate                     # (or db:migrate:local for local dev)

# Secrets
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put IMAGE_API_KEY      # OpenAI key for gpt-image-1
wrangler secret put CURATE_PASSWORD
```

For local dev, copy `.dev.vars.example` to `.dev.vars` and fill it in.

## Run / deploy

```sh
npm run dev        # wrangler dev --remote (Queues/D1/R2 bindings are live)
npm run typecheck
npm run deploy     # then set PUBLIC_BASE_URL in wrangler.jsonc to the deployed origin
```

After deploy, set `PUBLIC_BASE_URL` to the Worker's public origin (e.g.
`https://tex-two.<subdomain>.workers.dev`) so the QR placards on `/curate` point
at the right place. Flip `AUTO_APPROVE` to `"false"` if you want every derivative
to wait for artist approval before it reaches the wall.

## Printing the QR placards

The `/curate` dashboard shows a live QR per painting, but to print them all at
once export them to a folder:

```sh
# Set PUBLIC_BASE_URL in wrangler.jsonc first (the origin the codes point at).
npm run export-qr                 # pulls drawings from the remote D1
```

This writes one image per drawing to `qr-codes/` — each an SVG with the QR code
above a dashed cut-line and the drawing's **title** printed below, so you can
tell the codes apart while placing them, then trim the label off. It also writes
`qr-codes/print.html`, a contact sheet that lays every placard out for printing
the whole set in one go. Uses the `qrcode` dependency already in the project —
no extra installs — and encodes the same `PUBLIC_BASE_URL/p/:id` URL as `/curate`.

Options:

```sh
node scripts/export-qr.mjs --local                 # pull from the local dev D1
node scripts/export-qr.mjs --base https://…        # override the base URL
node scripts/export-qr.mjs --out placards          # output folder (default qr-codes)
node scripts/export-qr.mjs --input drawings.json   # skip wrangler; read a JSON file
```

## Config

| Var / secret | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude (moderation, prompt-crafting, drawing description) |
| `IMAGE_API_KEY` | image-edit provider (OpenAI `gpt-image-1` by default) |
| `CURATE_PASSWORD` | password for `/curate` (username ignored) |
| `AUTO_APPROVE` | `"true"` auto-shows AI-passed derivatives; `"false"` requires approval |
| `PUBLIC_BASE_URL` | origin the QR codes encode |

Swap the image model by implementing `ImageProvider` in `src/imageProvider.ts`.
