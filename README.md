# tex-two — Interactive Art Installation

Audience members reshape hung paintings from their phones; the AI-transformed
derivatives are projected back into the room as a live slideshow.

- **Submit** (`/p/:id`) — a QR placard by each painting opens a phone form. Every
  idea transforms the **original painting**; hint chips suggest what to ask.
- **Wall** (`/show`) — full-screen crossfade slideshow of approved derivatives,
  captioned with the prompt + contributor. Stays live by polling `/api/feed`.
- **Curator** (`/curate`, password-protected) — upload paintings (auto-described by
  Claude, QR placard rendered), and approve / hide / feature derivatives.

## How a prompt becomes an image

Claude does **not** generate images. The pipeline runs in the background after the
visitor's request returns (via `ctx.waitUntil` — no Queues needed):

1. Claude (`claude-haiku-4-5`) moderates the audience text.
2. Claude crafts a strong image-**edit** instruction, seeded by the painting's
   auto-generated description + style.
3. An external image-edit model (`ImageProvider`, default OpenAI `gpt-image-1`)
   transforms the **original** painting per the instruction.
4. Claude vision moderates the output image.
5. It's stored and — with `AUTO_APPROVE=true` — shown on the wall (artist can veto).

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

# Schema
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

## Config

| Var / secret | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude (moderation, prompt-crafting, painting description) |
| `IMAGE_API_KEY` | image-edit provider (OpenAI `gpt-image-1` by default) |
| `CURATE_PASSWORD` | password for `/curate` (username ignored) |
| `AUTO_APPROVE` | `"true"` auto-shows AI-passed derivatives; `"false"` requires approval |
| `PUBLIC_BASE_URL` | origin the QR codes encode |

Swap the image model by implementing `ImageProvider` in `src/imageProvider.ts`.
