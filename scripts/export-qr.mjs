#!/usr/bin/env node
// Export a printable QR placard per drawing into a folder.
//
// Each drawing's submit URL (PUBLIC_BASE_URL/p/:id) — the same one the /curate
// dashboard encodes — is rendered as its own image file with the drawing's title
// printed underneath, so you can print the folder and tell the codes apart. The
// label sits below the code on a separate band; trim it off after printing.
//
// Usage:
//   node scripts/export-qr.mjs                 # pull drawings from remote D1
//   node scripts/export-qr.mjs --local         # pull from the local D1 (dev)
//   node scripts/export-qr.mjs --base https://tex-two.example.workers.dev
//   node scripts/export-qr.mjs --input drawings.json   # skip wrangler; read a file
//   node scripts/export-qr.mjs --out placards          # output folder (default: qr-codes)
//
// --input accepts either a plain [{ "id", "title" }] array or the raw JSON that
// `wrangler d1 execute ... --json` prints.
//
// Output: SVG files (crisp at any print size, no extra dependencies) plus a
// print.html contact sheet that lays every placard out for one-shot printing.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- args ----
const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i !== -1 ? (args[i + 1] ?? '') : undefined;
}
const useLocal = args.includes('--local');
const inputPath = flag('--input');
const outDir = join(root, flag('--out') ?? 'qr-codes');
let base = flag('--base') ?? process.env.PUBLIC_BASE_URL ?? readBaseFromConfig();

if (!base) {
  console.error(
    'No base URL. Set PUBLIC_BASE_URL in wrangler.jsonc, pass --base <url>,\n' +
      'or export PUBLIC_BASE_URL. This is the origin your QR codes point at,\n' +
      'e.g. https://tex-two.<subdomain>.workers.dev'
  );
  process.exit(1);
}
base = base.replace(/\/+$/, '');

// ---- collect drawings ----
const drawings = loadDrawings();
if (drawings.length === 0) {
  console.error('No drawings found.');
  process.exit(1);
}

// ---- render ----
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const usedNames = new Map();
const cards = [];
for (const d of drawings) {
  const url = `${base}/p/${d.id}`;
  const svg = await placardSvg(url, d.title);
  const file = `${uniqueName(d.title, d.id)}.svg`;
  writeFileSync(join(outDir, file), svg);
  cards.push({ title: d.title, file, svg });
}

writeFileSync(join(outDir, 'print.html'), contactSheet(cards));

console.log(`Wrote ${cards.length} QR placard${cards.length === 1 ? '' : 's'} to ${outDir}/`);
console.log(`Base URL: ${base}`);
console.log(`Print all at once: open ${join(outDir, 'print.html')}`);

// ---------------------------------------------------------------------------

function readBaseFromConfig() {
  try {
    const txt = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
    const m = txt.match(/"PUBLIC_BASE_URL"\s*:\s*"([^"]*)"/);
    return m && m[1] ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

function loadDrawings() {
  let rows;
  if (inputPath) {
    rows = normalizeRows(JSON.parse(readFileSync(inputPath, 'utf8')));
  } else {
    const out = execFileSync(
      'npx',
      [
        'wrangler',
        'd1',
        'execute',
        'tex-two-db',
        useLocal ? '--local' : '--remote',
        '--json',
        '--command',
        'SELECT id, title FROM drawings ORDER BY created_at',
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
    );
    rows = normalizeRows(JSON.parse(out));
  }
  return rows
    .filter((r) => r && r.id)
    .map((r) => ({ id: String(r.id), title: String(r.title ?? '').trim() || 'Untitled' }));
}

// Accept a plain array of rows, wrangler's [{ results: [...] }] envelope, or a
// single { results: [...] } object.
function normalizeRows(parsed) {
  if (Array.isArray(parsed)) {
    if (parsed.length && parsed[0] && Array.isArray(parsed[0].results)) {
      return parsed.flatMap((r) => r.results ?? []);
    }
    return parsed;
  }
  if (parsed && Array.isArray(parsed.results)) return parsed.results;
  return [];
}

function slug(s) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled'
  );
}

// Filename from the title, with a short id suffix so same-named drawings never
// collide and overwrite each other.
function uniqueName(title, id) {
  const shortId = id.replace(/-/g, '').slice(0, 6);
  let name = `${slug(title)}-${shortId}`;
  let n = usedNames.get(name) ?? 0;
  usedNames.set(name, n + 1);
  return n === 0 ? name : `${name}-${n + 1}`;
}

function escapeXml(s) {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}

// Wrap the title to a handful of centered lines so long titles stay readable.
function wrapTitle(title, maxChars = 24, maxLines = 3) {
  const words = title.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = w;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.{1}$/, '…');
  }
  return lines;
}

// One self-contained SVG: quiet-zone-padded QR on top, title band underneath.
async function placardSvg(url, title) {
  const size = 640; // QR box (px)
  const pad = 40; // white quiet zone / page margin
  const lineH = 40;
  const lines = wrapTitle(title);
  // Dashed cut-line sits a full `pad` below the QR — the same white band it has
  // above — so once the title is trimmed off the code is vertically centered.
  const cutY = pad + size + pad;
  const labelTop = cutY + 4; // title band, below the cut-line, gets trimmed away
  const w = size + pad * 2;
  const h = labelTop + lines.length * lineH + pad;

  const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const count = qr.modules.size;
  const data = qr.modules.data;
  const cell = size / count;

  let rects = '';
  for (let r = 0; r < count; r++) {
    for (let col = 0; col < count; col++) {
      if (data[r * count + col]) {
        const x = pad + col * cell;
        const y = pad + r * cell;
        // Overlap by a hair to avoid hairline seams between modules when printed.
        rects += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(cell + 0.5).toFixed(2)}" height="${(cell + 0.5).toFixed(2)}"/>`;
      }
    }
  }

  const text = lines
    .map(
      (ln, i) =>
        `<text x="${w / 2}" y="${labelTop + (i + 1) * lineH - 10}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="30" fill="#111">${escapeXml(ln)}</text>`
    )
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="#fff"/>
<g fill="#000">${rects}</g>
<line x1="${pad}" y1="${cutY}" x2="${w - pad}" y2="${cutY}" stroke="#ccc" stroke-width="1" stroke-dasharray="6 6"/>
${text}
</svg>`;
}

// A grid of every placard on one page for printing the whole set at once.
function contactSheet(cards) {
  const cells = cards
    .map((c) => `<figure>${c.svg}</figure>`)
    .join('\n');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>QR placards — tex-two</title>
<style>
  body { margin: 24px; font-family: Helvetica, Arial, sans-serif; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 24px; }
  figure { margin: 0; break-inside: avoid; }
  figure svg { width: 100%; height: auto; border: 1px solid #eee; }
  @media print { body { margin: 0; } figure svg { border: none; } }
</style>
</head>
<body>
<div class="grid">
${cells}
</div>
</body>
</html>`;
}
