import type { Painting } from './types';
import { escapeHtml } from './util';

function layout(title: string, body: string, head = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0d0c10; color: #ece9e4;
    -webkit-font-smoothing: antialiased;
  }
  a { color: #e8b06a; }
  button { font: inherit; cursor: pointer; }
</style>
${head}
</head>
<body>${body}</body>
</html>`;
}

const HINTS = [
  'add something',
  'remove something',
  'what lies beyond the edge?',
  'change the season or time of day',
  'who else lives in this world?',
  'turn it into a dream',
];

export function submitPage(painting: Painting): string {
  const imgUrl = `/img/${painting.r2_key}`;
  const chips = HINTS.map(
    (h) => `<button type="button" class="chip" data-hint="${escapeHtml(h)}">${escapeHtml(h)}</button>`
  ).join('');
  const body = `
<main class="wrap">
  <figure>
    <img src="${imgUrl}" alt="${escapeHtml(painting.title)}">
    <figcaption>${escapeHtml(painting.title)}</figcaption>
  </figure>
  <h1>Reshape this painting</h1>
  <p class="lede">Leave your idea &mdash; add, remove, or reimagine. The artwork will be
     transformed from your words and projected in this room.</p>
  <form method="post" action="/p/${painting.id}" id="f">
    <div class="chips">${chips}</div>
    <textarea name="prompt" id="prompt" rows="3" maxlength="400" required
      placeholder="e.g. add a flock of paper birds rising into the sky"></textarea>
    <input name="name" maxlength="40" placeholder="your name (optional)">
    <button type="submit" class="go">Send my idea</button>
  </form>
</main>
<style>
  .wrap { max-width: 560px; margin: 0 auto; padding: 20px 18px 48px; }
  figure { margin: 0 0 20px; }
  figure img { width: 100%; border-radius: 14px; display: block; box-shadow: 0 12px 40px rgba(0,0,0,.5); }
  figcaption { margin-top: 10px; color: #a8a29a; font-size: 14px; letter-spacing: .02em; }
  h1 { font-size: 26px; margin: 8px 0 6px; }
  .lede { color: #b7b2aa; margin: 0 0 18px; line-height: 1.5; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .chip {
    background: #1c1a22; color: #d9d4cc; border: 1px solid #2f2c38;
    padding: 8px 12px; border-radius: 999px; font-size: 13px;
  }
  .chip:active { background: #2a2733; }
  textarea, input {
    width: 100%; background: #131218; color: #ece9e4; border: 1px solid #2f2c38;
    border-radius: 12px; padding: 14px; font-size: 16px; margin-bottom: 12px; resize: vertical;
  }
  textarea:focus, input:focus { outline: none; border-color: #e8b06a; }
  .go {
    width: 100%; background: #e8b06a; color: #1a1206; border: 0; border-radius: 12px;
    padding: 15px; font-size: 17px; font-weight: 600;
  }
</style>
<script>
  const p = document.getElementById('prompt');
  document.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => {
    const h = c.dataset.hint;
    p.value = p.value.trim() ? p.value.trim() + ', ' + h : h;
    p.focus();
  }));
</script>`;
  return layout(`Reshape &mdash; ${painting.title}`, body);
}

export function confirmationPage(painting: Painting): string {
  const body = `
<main class="wrap">
  <div class="card">
    <div class="spark">&#10022;</div>
    <h1>Your idea is being painted&hellip;</h1>
    <p>Watch the wall &mdash; your transformation of <em>${escapeHtml(painting.title)}</em>
       will appear there shortly, once it clears a quick safety check.</p>
    <a class="again" href="/p/${painting.id}">Leave another idea</a>
  </div>
</main>
<style>
  .wrap { max-width: 520px; margin: 0 auto; padding: 64px 20px; text-align: center; }
  .card { background: #131218; border: 1px solid #2f2c38; border-radius: 18px; padding: 40px 28px; }
  .spark { font-size: 48px; color: #e8b06a; }
  h1 { font-size: 24px; margin: 12px 0; }
  p { color: #b7b2aa; line-height: 1.6; }
  .again { display: inline-block; margin-top: 20px; color: #e8b06a; text-decoration: none; font-weight: 600; }
</style>`;
  return layout('Sent', body);
}

export function showPage(): string {
  const body = `
<div id="stage"></div>
<div id="caption"></div>
<div id="empty">Waiting for the first transformation&hellip;</div>
<style>
  html, body { height: 100%; background: #000; overflow: hidden; }
  #stage { position: fixed; inset: 0; }
  .slide {
    position: absolute; inset: 0; opacity: 0; transition: opacity 1.4s ease;
    background-size: contain; background-position: center; background-repeat: no-repeat;
  }
  .slide.on { opacity: 1; }
  #caption {
    position: fixed; left: 0; right: 0; bottom: 0; padding: 26px 40px;
    background: linear-gradient(transparent, rgba(0,0,0,.82));
    opacity: 0; transition: opacity 1.4s ease; pointer-events: none;
  }
  #caption.on { opacity: 1; }
  #caption .q { font-size: 30px; line-height: 1.3; margin: 0; color: #fff;
    text-shadow: 0 2px 12px rgba(0,0,0,.7); font-family: Georgia, serif; font-style: italic; }
  #caption .who { margin-top: 10px; font-size: 16px; color: #e8b06a; letter-spacing: .04em; }
  #empty { position: fixed; inset: 0; display: grid; place-items: center;
    color: #555; font-size: 20px; font-family: Georgia, serif; }
</style>
<script>
(function () {
  const stage = document.getElementById('stage');
  const cap = document.getElementById('caption');
  const empty = document.getElementById('empty');
  const HOLD = 8000, POLL = 5000;
  // One projector, all approved derivatives together: pool holds every item;
  // queue is a shuffled play order that reshuffles each time it's exhausted.
  let pool = [], queue = [], current = null;

  function idsOf(items) { return items.map((x) => x.id).sort().join(','); }

  function shuffle(items) {
    const a = items.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  async function refresh() {
    try {
      const items = await (await fetch('/api/feed')).json();
      // Only rebuild when the set of images actually changes, so a poll doesn't
      // interrupt the current shuffled run mid-cycle.
      if (idsOf(items) !== idsOf(pool)) {
        pool = items;
        queue = []; // reshuffle from the fresh pool on the next tick
      }
    } catch (e) { /* keep showing what we have */ }
  }

  function show(item) {
    empty.style.display = 'none';
    const slide = document.createElement('div');
    slide.className = 'slide';
    slide.style.backgroundImage = 'url("/img/' + item.derivative_key + '")';
    stage.appendChild(slide);
    requestAnimationFrame(() => requestAnimationFrame(() => slide.classList.add('on')));
    cap.innerHTML = '<p class="q">&ldquo;' + escapeHtml(item.prompt_text) + '&rdquo;</p>' +
      (item.contributor_name ? '<div class="who">&mdash; ' + escapeHtml(item.contributor_name) + '</div>' : '');
    cap.classList.add('on');
    const prev = current;
    current = slide;
    if (prev) setTimeout(() => prev.remove(), 1500);
  }

  function tick() {
    if (pool.length === 0) {
      empty.style.display = 'grid';
      cap.classList.remove('on');
      return;
    }
    if (queue.length === 0) queue = shuffle(pool);
    show(queue.shift());
  }

  function escapeHtml(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  refresh().then(tick);
  setInterval(tick, HOLD);
  setInterval(refresh, POLL);
})();
</script>`;
  return layout('Projection Wall', body);
}

export function curatePage(): string {
  const body = `
<header>
  <h1>Curator</h1>
  <div class="links"><a href="/show" target="_blank">open wall &#8599;</a></div>
</header>

<section class="panel">
  <h2>Add a painting</h2>
  <form id="upload">
    <input name="title" placeholder="Painting title" required>
    <input type="file" name="image" accept="image/png,image/jpeg" required>
    <button type="submit">Upload &amp; analyze</button>
    <span id="upstatus"></span>
  </form>
  <div id="paintings" class="grid"></div>
</section>

<section class="panel">
  <h2>Needs attention</h2>
  <div id="attention" class="grid"></div>
</section>

<section class="panel">
  <h2>Derivatives</h2>
  <div id="derivatives" class="grid"></div>
</section>

<style>
  header { display: flex; align-items: baseline; justify-content: space-between;
    padding: 20px 24px; border-bottom: 1px solid #26232e; }
  header h1 { margin: 0; font-size: 22px; }
  .links a { text-decoration: none; }
  .panel { padding: 22px 24px; border-bottom: 1px solid #1b1922; }
  .panel h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .08em; color: #8a857c; margin: 0 0 14px; }
  form#upload { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 18px; }
  input, button { background: #17151d; color: #ece9e4; border: 1px solid #2f2c38; border-radius: 10px; padding: 10px 12px; font-size: 14px; }
  button { background: #e8b06a; color: #1a1206; border: 0; font-weight: 600; }
  #upstatus { color: #8a857c; font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; }
  .card { background: #131218; border: 1px solid #26232e; border-radius: 12px; overflow: hidden; }
  .card img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; background: #000; }
  .card .meta { padding: 10px 12px; }
  .card .q { font-size: 13px; color: #d9d4cc; line-height: 1.4; }
  .card .sub { font-size: 12px; color: #7d786f; margin-top: 6px; }
  .badge { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px; margin-top: 8px; }
  .b-approved { background: #16351f; color: #7bd08c; }
  .b-pending_review { background: #35300f; color: #e8c86a; }
  .b-rejected { background: #3a1717; color: #e88a8a; }
  .b-generating, .b-queued { background: #23202b; color: #a8a29a; }
  .b-hidden { background: #23202b; color: #7d786f; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; padding: 0 12px 12px; }
  .actions button { font-size: 12px; padding: 6px 10px; background: #23202b; color: #d9d4cc; border: 1px solid #34313d; }
  .actions button.on { background: #e8b06a; color: #1a1206; border: 0; }
  .qr { padding: 10px 12px; border-top: 1px solid #26232e; }
  .qr svg { width: 96px; height: 96px; background: #fff; border-radius: 6px; }
  .qr a { font-size: 12px; display: block; margin-top: 6px; word-break: break-all; }
  .card.att .badge { margin-top: 0; margin-bottom: 8px; }
  .card.att .q { margin-top: 4px; }
</style>

<script>
async function j(url, opts) { const r = await fetch(url, opts); if (!r.ok) throw new Error(await r.text()); return r.json(); }

const upForm = document.getElementById('upload');
upForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = document.getElementById('upstatus');
  status.textContent = 'uploading & analyzing…';
  try {
    const fd = new FormData(upForm);
    await j('/api/curate/upload', { method: 'POST', body: fd });
    upForm.reset();
    status.textContent = 'done';
    load();
  } catch (err) { status.textContent = 'error: ' + err.message; }
});

function esc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function fmtTime(ts){ if(!ts) return ''; try { return new Date(ts).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }); } catch(e){ return ''; } }

async function load() {
  const state = await j('/api/curate/state');
  document.getElementById('paintings').innerHTML = state.paintings.map(p => \`
    <div class="card">
      <img src="/img/\${p.r2_key}" alt="">
      <div class="meta"><div class="q">\${esc(p.title)}</div>
        <div class="sub">\${esc(p.description || 'no description')}</div></div>
      <div class="qr">\${p.qr}<a href="\${esc(p.submit_url)}" target="_blank">\${esc(p.submit_url)}</a></div>
    </div>\`).join('') || '<p class="sub">No paintings yet.</p>';

  document.getElementById('attention').innerHTML = (state.needs_attention || []).map(s => \`
    <div class="card att">
      \${s.derivative_key ? \`<img src="/img/\${s.derivative_key}" alt="">\` : ''}
      <div class="meta">
        <span class="badge b-\${s.status}">\${s.status}</span>
        <div class="q">&ldquo;\${esc(s.prompt_text)}&rdquo;</div>
        <div class="sub">\${esc(s.contributor_name || 'anonymous')}\${s.moderation_reason ? ' · ' + esc(s.moderation_reason) : ''}</div>
      </div>
      <div class="actions">
        \${s.status === 'rejected'
          ? \`<button class="on" onclick="act('\${s.id}','override')">Approve anyway</button>
             <button onclick="act('\${s.id}','retry')">Retry</button>\`
          : '<span class="sub">processing&hellip;</span>'}
      </div>
    </div>\`).join('') || '<p class="sub">Nothing needs attention.</p>';

  document.getElementById('derivatives').innerHTML = state.derivatives.map(d => {
    const isApproved = d.status === 'approved';
    return \`
    <div class="card">
      <img src="/img/\${d.derivative_key}" alt="">
      <div class="meta">
        <div class="q">&ldquo;\${esc(d.prompt_text)}&rdquo;</div>
        <div class="sub">\${esc(d.contributor_name || 'anonymous')} · \${esc(d.painting_title)}</div>
        \${d.created_at ? \`<div class="sub">generated \${esc(fmtTime(d.created_at))}</div>\` : ''}
        <span class="badge b-\${d.status}">\${d.status}</span>
        \${d.featured ? '<span class="badge b-approved">featured</span>' : ''}
      </div>
      <div class="actions">
        \${isApproved
          ? \`<button onclick="act('\${d.submission_id}','hide')">Hide</button>\`
          : \`<button onclick="act('\${d.submission_id}','approve')">Approve</button>\`}
        <button class="\${d.featured ? 'on' : ''}" onclick="feature('\${d.id}', \${d.featured ? 0 : 1})">
          \${d.featured ? 'Unfeature' : 'Feature'}</button>
      </div>
    </div>\`;
  }).join('') || '<p class="sub">No derivatives yet.</p>';
}

window.act = async (submissionId, action) => { await j('/api/curate/submission/' + submissionId + '/' + action, { method: 'POST' }); load(); };
window.feature = async (derivativeId, on) => { await j('/api/curate/derivative/' + derivativeId + '/feature', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ featured: !!on }) }); load(); };

load();
setInterval(load, 6000);
</script>`;
  return layout('Curator', body);
}
