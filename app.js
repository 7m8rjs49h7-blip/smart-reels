/* Lumen — informative short-video feed. All state is local to this device. */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const KEY = 'lumen.v1';
const MEDIA_CACHE = 'lumen-media';
const RECENT_MAX = 20;
const SET_SIZE = 36;
const APP_VERSION = '1.5.0';
const REFILL_AT = 5;      // append the next batch when this close to the end
const NO_REPEAT = 30;     // don't repeat any of the last ~30 items
const HYDRATE_NEAR = 6, DRY_FAR = 12;
const POOL_N = 3;         // shared <video> elements, reused slide to slide (one tap unlocks them all on strict iOS) // keep DOM bounded: only slides near the viewer hold real content // items per finite "set" — no infinite scroll

const defaults = { topics: [], likes: {}, saves: {}, seen: {}, recent: [], media: {}, packs: {},
  settings: { limit: 30, recap: 5, cap: 500, autoRecent: true, wifiOnly: false },
  time: { date: '', secs: 0, snoozeUntil: 0, done: false }, setIndex: 0, muted: true };
let S = load();
let CAT = { topics: [], items: [] };
let byId = new Map();
let feedItems = [];
let activeEl = null;
let forceOfflineReason = false;

function load() {
  try { const s = JSON.parse(localStorage.getItem(KEY)); return s ? { ...defaults, ...s, settings: { ...defaults.settings, ...(s.settings || {}) }, time: { ...defaults.time, ...(s.time || {}) } } : structuredClone(defaults); }
  catch (_) { return structuredClone(defaults); }
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (_) {} }
function toast(msg, ms = 2200) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms); }
const online = () => navigator.onLine && !forceOfflineReason;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mb = (b) => (b / 1048576).toFixed(b > 104857600 ? 0 : 1) + ' MB';
const topicOf = (id) => CAT.topics.find((t) => t.id === id) || { label: id, emoji: '•' };
const today = () => new Date().toISOString().slice(0, 10);

// ---------- source selection ----------
const probe = document.createElement('video');
// iPhone/iPad (every iOS browser, Brave included, is WebKit) decode MPEG-4 in hardware; VP9 WebM is spotty there.
const APPLE = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
  (/Apple/.test(navigator.vendor || '') && !/Chrome|CriOS|FxiOS|Android/.test(navigator.userAgent));
function pickSource(item) {
  if (item.kind !== 'file') return null;
  const ok = item.sources.filter((s) => {
    if (s.type === 'video/webm') return probe.canPlayType('video/webm; codecs="vp9, opus"') || probe.canPlayType('video/webm; codecs="vp9"');
    return probe.canPlayType('video/mp4') || probe.canPlayType('video/quicktime');
  });
  const have = ok.find((s) => S.media[s.url]); if (have) return have; // keep using what's already saved offline
  if (APPLE) { const m = ok.find((s) => s.type === 'video/mp4'); if (m) return m; }
  return ok[0] || null;
}
function playableSources(item) {
  const first = pickSource(item);
  return first ? [first, ...item.sources.filter((s) => s !== first)] : item.sources;
}

// ---------- offline media store ----------
async function isCached(url) { try { const c = await caches.open(MEDIA_CACHE); return !!(await c.match(url)); } catch (_) { return false; } }
function usedBytes() { return Object.values(S.media).reduce((a, m) => a + (m.bytes || 0), 0); }
function capBytes() { return S.settings.cap * 1048576; }
function addReason(url, id, reason, bytes) {
  const m = S.media[url] || { id, bytes, reasons: [], ts: Date.now() };
  if (!m.reasons.includes(reason)) m.reasons.push(reason);
  m.ts = Date.now(); if (bytes) m.bytes = bytes;
  S.media[url] = m; save();
}
async function dropReason(url, reason) {
  const m = S.media[url]; if (!m) return;
  m.reasons = m.reasons.filter((r) => r !== reason);
  if (!m.reasons.length) { delete S.media[url]; try { (await caches.open(MEDIA_CACHE)).delete(url); } catch (_) {} }
  save();
}
async function makeRoom(need) {
  // Evict oldest "recent-only" clips first, then oldest pack clips. Saved clips are never auto-evicted.
  const order = Object.entries(S.media).filter(([, m]) => !m.reasons.includes('saved'))
    .sort((a, b) => (a[1].reasons.includes('recent') && a[1].reasons.length === 1 ? 0 : 1) - (b[1].reasons.includes('recent') && b[1].reasons.length === 1 ? 0 : 1) || a[1].ts - b[1].ts);
  for (const [url] of order) {
    if (usedBytes() + need <= capBytes()) break;
    delete S.media[url]; try { (await caches.open(MEDIA_CACHE)).delete(url); } catch (_) {}
  }
  save();
  return usedBytes() + need <= capBytes();
}
let dlChain = Promise.resolve();
function metered() { const c = navigator.connection; return !!(c && (c.saveData || c.type === 'cellular')); }
function download(item, reason, { quiet = true } = {}) {
  const src = pickSource(item); if (!src) return Promise.resolve(false);
  dlChain = dlChain.then(async () => {
    if (S.media[src.url] && await isCached(src.url)) { addReason(src.url, item.id, reason); return true; }
    if (!online()) { if (!quiet) toast('You are offline'); return false; }
    if (!(await makeRoom(src.bytes || 0))) { toast('Offline storage cap reached — raise it in Settings or delete downloads'); return false; }
    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      const res = await fetch(src.url, { mode: 'cors', credentials: 'omit' });
      if (!res.ok || res.status !== 200) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const c = await caches.open(MEDIA_CACHE);
      await c.put(src.url, new Response(blob, { headers: { 'Content-Type': res.headers.get('Content-Type') || src.type, 'Content-Length': String(blob.size) } }));
      addReason(src.url, item.id, reason, blob.size);
      markDownloaded(item.id);
      return true;
    } catch (err) { if (!quiet) toast('Download failed: ' + err.message); return false; }
  });
  return dlChain;
}
function markDownloaded(id) { $$(`[data-id="${CSS.escape(id)}"] .dl`).forEach((b) => (b.hidden = false)); }

async function trackRecent(item) {
  S.recent = [item.id, ...S.recent.filter((x) => x !== item.id)];
  const dropped = S.recent.slice(RECENT_MAX); S.recent = S.recent.slice(0, RECENT_MAX); save();
  for (const id of dropped) { const it = byId.get(id); const src = it && pickSource(it); if (src) await dropReason(src.url, 'recent'); }
  if (S.settings.autoRecent && !(S.settings.wifiOnly && metered())) download(item, 'recent');
}

// ---------- feed construction ----------
function seeded(seed) { let x = seed >>> 0 || 1; return () => ((x ^= x << 13, x ^= x >>> 17, x ^= x << 5) >>> 0) / 4294967296; }
function shuffle(arr, rnd) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function interleaveTopics(list, rnd) {
  const groups = {}; for (const it of list) (groups[it.topic] ||= []).push(it);
  const keys = shuffle(Object.keys(groups), rnd); const out = [];
  let more = true; while (more) { more = false; for (const k of keys) { const g = groups[k]; if (g.length) { out.push(g.shift()); more = true; } } }
  return out;
}
async function availableOffline() {
  const set = new Set();
  for (const it of CAT.items) { if (it.kind !== 'file') continue; const s = pickSource(it); if (s && S.media[s.url] && await isCached(s.url)) set.add(it.id); }
  return set;
}
async function feedPool() {
  const sel = new Set(S.topics.length ? S.topics : CAT.topics.map((t) => t.id));
  let pool = CAT.items.filter((it) => sel.has(it.topic));
  const off = !online();
  if (off) { const cached = await availableOffline(); pool = pool.filter((it) => it.kind === 'tip' || cached.has(it.id)); }
  else pool = pool.filter((it) => (it.kind !== 'file' || pickSource(it)) && !(it.kind === 'youtube' && S.badYT && S.badYT[it.id]));
  return { pool, off };
}
// One batch: unseen first (shuffled, categories interleaved), then the least-recently-seen in a fresh order; formats mixed.
function nextBatch(pool, off, rnd, exclude) {
  const avail = pool.filter((x) => !exclude.has(x.id));
  const unseen = (l) => l.filter((x) => !S.seen[x.id]);
  const oldest = (l) => { const s2 = l.filter((x) => S.seen[x.id]).sort((a, b) => S.seen[a.id] - S.seen[b.id]); return shuffle(s2.slice(0, Math.max(SET_SIZE * 2, Math.ceil(s2.length / 2))), rnd).concat(s2.slice(Math.max(SET_SIZE * 2, Math.ceil(s2.length / 2)))); };
  const order = (l) => [...interleaveTopics(shuffle(unseen(l), rnd), rnd), ...interleaveTopics(oldest(l), rnd)];
  // Native video first (it truly autoplays everywhere); YouTube woven in less often, even less when the device blocks autoplay.
  const weave = (l) => { const f = l.filter((x) => x.kind === 'file'), y = l.filter((x) => x.kind !== 'file'); const out = []; const run = autoplayStrict ? 4 : 2;
    while (f.length || y.length) { for (let k = 0; k < run && f.length; k++) out.push(f.shift()); if (y.length) out.push(y.shift()); } return out; };
  const liked = new Set(Object.keys(S.likes).map((id) => byId.get(id)?.topic).filter(Boolean));
  const boost = (l) => l.sort((a, b) => (liked.has(b.topic) && !S.seen[b.id]) - (liked.has(a.topic) && !S.seen[a.id]));
  const V = weave(boost(order(avail.filter((i) => i.kind !== 'tip')))), T = order(avail.filter((i) => i.kind === 'tip'));
  const merged = []; let vi = 0, ti = 0;
  while (merged.length < SET_SIZE && (vi < V.length || ti < T.length)) {
    if (vi < V.length) merged.push(V[vi++]); if (merged.length >= SET_SIZE) break;
    if (vi < V.length && !off) merged.push(V[vi++]); if (merged.length >= SET_SIZE) break;
    if (ti < T.length) merged.push(T[ti++]);
  }
  return merged;
}
let recapSince = []; let learnSeq = 0;
function withRecaps(list) {
  const out = []; const n = +S.settings.recap;
  for (const it of list) {
    out.push(it); recapSince.push(it);
    if (n && recapSince.length >= n) { out.push({ kind: 'learn', id: 'learn-' + (++learnSeq), from: recapSince.map((x) => x.id) }); recapSince = []; }
  }
  return out;
}
async function buildFeed(startId) {
  const { pool, off } = await feedPool();
  const rnd = seeded([...today()].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) + S.setIndex * 977);
  const merged = nextBatch(pool, off, rnd, new Set());
  if (startId) { const it = byId.get(startId); if (it) { const i = merged.findIndex((x) => x.id === startId); if (i >= 0) merged.splice(i, 1); merged.unshift(it); } }
  recapSince = [];
  feedItems = withRecaps(merged);
  renderFeed(off);
}
// Endless feed: append the next rotated batch near the end without touching the slides already on screen.
let appending = null;
function appendBatch() {
  if (appending) return appending;
  appending = (async () => {
    const { pool, off } = await feedPool();
    const media = feedItems.filter((x) => x.kind !== 'learn' && x.kind !== 'end');
    if (!media.length || !pool.length) return 0;
    const cur = activeEl ? +activeEl.dataset.idx : 0;
    // Never repeat anything still queued after the viewer, or any of the last ~30 shown.
    const queued = feedItems.slice(cur + 1).filter((x) => x.kind !== 'learn').map((x) => x.id);
    const recentN = Math.min(NO_REPEAT, Math.max(0, pool.length - queued.length - 4));
    const recent = media.slice(-Math.max(recentN + queued.length, 1)).map((x) => x.id);
    let batch = nextBatch(pool, off, Math.random, new Set([...queued, ...recent]));
    if (!batch.length) batch = nextBatch(pool, off, Math.random, new Set(queued)); // tiny pools: relax, but still no back-to-back repeats
    if (!batch.length) return 0;
    const items = withRecaps(batch); const start = feedItems.length;
    feedItems.push(...items);
    const f = $('#feed'); f.insertAdjacentHTML('beforeend', items.map((it, k) => itemHTML(it, start + k)).join(''));
    $$('.item', f).slice(start).forEach((el) => { el.classList.add('dry'); el.innerHTML = ''; io.observe(el); });
    return items.length;
  })().finally(() => { appending = null; });
  return appending;
}
function dehydrate(x) {
  if (x.classList.contains('dry')) return;
  unmountYT(x); unloadVideo(x); x.innerHTML = ''; x.classList.add('dry');
}
function hydrate(x, i) {
  if (!x.classList.contains('dry')) return;
  const it = feedItems[i]; if (!it) return;
  const t = document.createElement('template'); t.innerHTML = itemHTML(it, i).trim(); const n = t.content.firstElementChild;
  x.className = n.className; x.innerHTML = n.innerHTML;
  if (it.kind === 'file') { const s2 = pickSource(it); if (s2 && S.media[s2.url]) markDownloaded(it.id); }
}

// ---------- rendering ----------
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting && e.intersectionRatio >= 0.6) activate(e.target);
}, { threshold: [0.6] });

function railHTML(it) {
  return `<div class="rail">
    <button class="rbtn like ${S.likes[it.id] ? 'liked' : ''}" aria-label="Like">${S.likes[it.id] ? '♥' : '♡'}</button>
    <button class="rbtn save ${S.saves[it.id] ? 'on' : ''}" aria-label="Save">${S.saves[it.id] ? '★' : '☆'}</button>
    <button class="rbtn share" aria-label="Share">↗</button>
  </div>`;
}
function metaHTML(it) {
  const t = topicOf(it.topic);
  const lic = it.licenseUrl ? `<a href="${esc(it.licenseUrl)}" target="_blank" rel="noopener">${esc(it.license)}</a>` : esc(it.license || '');
  return `<div class="meta">
    <span class="topic">${t.emoji} ${esc(t.label)}${it.fresh && !S.seen[it.id] ? ' <span class="newb">New</span>' : ''}</span>
    <h2>${esc(it.title)}</h2>
    ${it.takeaway ? `<p class="take">${esc(it.takeaway)}</p>` : ''}
    <div class="credit">${it.kind === 'youtube'
      ? `<a href="${esc(it.sourceUrl)}" target="_blank" rel="noopener">${esc(it.sourceName || 'YouTube')}</a>`
      : `${esc(it.credit || '')} · <a href="${esc(it.sourceUrl)}" target="_blank" rel="noopener">${esc(it.sourceName)}</a> · ${lic}`}</div>
  </div>`;
}
function itemHTML(it, idx) {
  if (it.kind === 'file') {
    return `<article class="item vid" data-id="${esc(it.id)}" data-idx="${idx}">
      <div class="poster" style="background-image:url('${esc(it.poster || '')}')"></div><div class="skel"></div>
      <span class="dl" hidden>⬇ Offline</span>
      <span class="tapicon" aria-hidden="true"></span>
      <button class="playbig" hidden aria-label="Play">▶</button>
      <div class="shade"></div>${metaHTML(it)}${railHTML(it)}<div class="progress"><i></i></div></article>`;
  }
  if (it.kind === 'youtube') {
    return `<article class="item yt" data-id="${esc(it.id)}" data-idx="${idx}">
      <div class="poster" style="background-image:url('${esc(it.poster)}')"></div>
      <div class="ytbox"><div class="ythost"></div><div class="ytcover" style="background-image:url('${esc(it.poster)}')"></div><div class="skel"></div></div>
      <div class="tapzone"></div>
      <span class="tapicon" aria-hidden="true"></span>
      <button class="playbig" hidden aria-label="Play">▶</button>
      <div class="shade"></div>${metaHTML(it)}${railHTML(it)}<div class="progress"><i></i></div></article>`;
  }
  if (it.kind === 'tip' && it.format === 'fact') {
    const t = topicOf(it.topic);
    return `<article class="item tipitem" data-id="${esc(it.id)}" data-idx="${idx}">
      <div class="tipcard fact"><div class="kicker">${t.emoji} ${esc(t.label)} · Did you know?${it.fresh && !S.seen[it.id] ? ' <span class="newb">New</span>' : ''}</div>
      <h2>${esc(it.title)}</h2>${it.steps.map((s) => `<p>${esc(s)}</p>`).join('')}
      <div class="fine">From <a href="${esc(it.sourceUrl)}" target="_blank" rel="noopener">Wikipedia</a> (${esc(it.credit)}) · <a href="${esc(it.licenseUrl)}" target="_blank" rel="noopener">${esc(it.license)}</a> · saved for offline</div></div>
      ${railHTML(it)}</article>`;
  }
  if (it.kind === 'tip') {
    const t = topicOf(it.topic);
    return `<article class="item tipitem" data-id="${esc(it.id)}" data-idx="${idx}">
      <div class="tipcard"><div class="kicker">${t.emoji} ${esc(t.label)} · Tip card</div>
      <h2>${esc(it.title)}</h2><ol>${it.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      ${it.note ? `<div class="note">⚠️ ${esc(it.note)}</div>` : ''}
      <div class="fine">Written summary of common guidance — works offline. Not professional advice.</div></div>
      ${railHTML(it)}</article>`;
  }
  if (it.kind === 'learn') return `<article class="item learnitem" data-id="${it.id}" data-idx="${idx}"><div class="tipcard quiz">${learnHTML(it)}</div></article>`;
  return `<article class="item enditem" data-id="end" data-idx="${idx}"><div class="tipcard" style="text-align:center">
    <div class="big">✅</div><h2>That's today's set</h2>
    <p class="muted">You've reached the end on purpose — Lumen doesn't scroll forever. Take what you learned with you.</p>
    <button class="btn primary wide" id="nextSet">Start another set</button>
    <button class="btn ghost wide" id="goLib">Review saved items</button></div></article>`;
}
function learnHTML(card) {
  const src = card.from.map((id) => byId.get(id)).filter(Boolean);
  const q = src.filter((x) => x.quiz);
  if (q.length) {
    const it = q[Math.floor(Math.random() * q.length)];
    const order = shuffle(it.quiz.options.map((o, i) => ({ o, i })), Math.random);
    return `<div class="kicker">🧠 Quick recap</div><h2>${esc(it.quiz.q)}</h2>
      <div data-answer="${it.quiz.answer}" data-take="${esc(it.takeaway || '')}">${order.map((x) => `<button class="opt" data-i="${x.i}">${esc(x.o)}</button>`).join('')}</div>
      <div class="fb muted"></div>
      <div class="fine">From: ${esc(it.title)}</div>`;
  }
  return `<div class="kicker">🧠 Key takeaways</div><h2>What you just covered</h2><ol>${src.map((x) => `<li><b>${esc(x.title)}</b>${x.steps ? '<br><span class="muted">' + esc(x.steps[0]) + '</span>' : x.takeaway ? '<br><span class="muted">' + esc(x.takeaway) + '</span>' : ''}</li>`).join('')}</ol>
    <div class="fine">Try saying one of these out loud — recalling it helps it stick.</div>`;
}
function renderFeed(off) {
  const f = $('#feed'); io.disconnect(); for (const [el] of [...ytPlayers]) unmountYT(el); vpool.forEach(releaseVideo); activeEl = null;
  if (!feedItems.filter((x) => x.kind !== 'learn' && x.kind !== 'end').length) {
    f.innerHTML = `<div class="item enditem"><div class="tipcard" style="text-align:center"><div class="big">📭</div><h2>${off ? 'Nothing saved for offline yet' : 'No items'}</h2><p class="muted">${off ? 'Next time you’re online, open Library → Offline and download a topic pack. Clips you watch are also kept automatically.' : 'Pick some topics in Settings.'}</p>${off ? '<button class="btn ghost wide" id="goLib">Open Library</button>' : ''}</div></div>`;
    return;
  }
  f.innerHTML = feedItems.map(itemHTML).join('');
  f.scrollTop = 0;
  $$('.item', f).forEach((el) => io.observe(el));
  // Mark downloaded clips
  feedItems.forEach((it) => { if (it.kind === 'file') { const s = pickSource(it); if (s && S.media[s.url]) markDownloaded(it.id); } });
}

// ---------- shared video pool ----------
// A few <video> elements are reused from slide to slide. On iOS a play() made inside any tap "unlocks" an element for
// good, so after the first touch every later clip can start (with sound) on its own, even in Low Power Mode.
const vpool = []; const vlog = [];
let autoplayStrict = false; // the device refused muted inline autoplay (iOS Low Power Mode, some data savers)
let userPaused = false;
function makeVideo() {
  const v = document.createElement('video');
  v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', ''); v.setAttribute('disablepictureinpicture', ''); v.setAttribute('x-webkit-airplay', 'deny');
  v.muted = true; v.defaultMuted = true; v.loop = true; v.preload = 'none';
  v.addEventListener('error', () => {
    if (!v.getAttribute('src') || !v._srcs) return; // released / emptied element: not a real failure
    vlog.push({ it: v._it, k: v._k, code: v.error && v.error.code, t: Date.now() }); if (vlog.length > 40) vlog.shift();
    if (v._k < v._srcs.length) v.src = v._srcs[v._k++].url;
    else if (!v._retried) { v._retried = true; v._k = 0; const it = v._it; setTimeout(() => { if (v._it === it) v.src = v._srcs[v._k++].url; if (v._el === activeEl && !userPaused) v.play().catch(() => {}); }, 1500); return; }
    else return;
    if (v._el && v._el === activeEl && !userPaused) v.play().catch(() => {});
  });
  v.addEventListener('timeupdate', () => {
    const el = v._el; if (!el) return; const bar = $('.progress i', el); if (bar && v.duration) bar.style.width = (100 * v.currentTime / v.duration) + '%';
    if (!v._counted && v.currentTime > 3 && el === activeEl) { v._counted = true; const it = byId.get(v._it); if (it) trackRecent(it); }
  });
  v.addEventListener('playing', () => { const el = v._el; if (!el) return; el.classList.add('live'); const pb = $('.playbig', el); if (pb) pb.hidden = true; hideHint(el); });
  vpool.push(v); return v;
}
function releaseVideo(v) {
  if (!v) return; v.pause(); if (v._el) v._el.classList.remove('live');
  v._el = null; v._it = null; v.remove(); v.removeAttribute('src'); try { v.load(); } catch (_) {} delete v.dataset.loaded;
}
function setVideoSrc(el, it, preload = 'metadata') {
  let v = $('video', el);
  if (v && v._it === it.id) { if (preload === 'auto' && v.preload !== 'auto') v.preload = 'auto'; return v; }
  if (v) releaseVideo(v);
  v = vpool.find((x) => !x._el) || (vpool.length < POOL_N ? makeVideo() : null);
  if (!v) { // pool busy: reuse the one farthest from the viewer
    const cur = activeEl ? +activeEl.dataset.idx : 0;
    v = vpool.filter((x) => x._el !== activeEl).sort((a, b) => Math.abs(+b._el.dataset.idx - cur) - Math.abs(+a._el.dataset.idx - cur))[0];
    if (!v) return null; releaseVideo(v);
  }
  v._el = el; v._it = it.id; v._srcs = playableSources(it); v._k = 0; v._counted = false; v._retried = false;
  v.poster = it.poster || ''; v.preload = preload; v.muted = !soundOn;
  const anchor = $('.poster', el); if (anchor) anchor.after(v); else el.prepend(v);
  if (v._srcs.length) v.src = v._srcs[v._k++].url;
  v.dataset.loaded = '1'; const bar = $('.progress i', el); if (bar) bar.style.width = '0';
  return v;
}
function unloadVideo(el) { const v = $('video', el); if (v) releaseVideo(v); }
const gestureNow = () => { const ua = navigator.userActivation; return !ua || ua.isActive; };
// Must run synchronously inside a user gesture (tap, swipe end, key). Cheap after the first time.
function unlockMedia() {
  if (!gestureNow()) return;
  while (vpool.length < POOL_N) makeVideo();
  for (const v of vpool) {
    if (v._unlocked) continue; v._unlocked = true;
    const keep = () => v._el && v._el === activeEl && !userPaused;
    if (keep() && !v.paused) continue;
    v.muted = true;
    try { const p = v.play(); if (p) p.then(() => { if (!keep()) v.pause(); v.muted = !soundOn; }).catch(() => { v.muted = !soundOn; }); } catch (_) {}
  }
}
['touchend', 'pointerup', 'click', 'keydown'].forEach((t) => document.addEventListener(t, unlockMedia, { capture: true, passive: true }));
function showHint(el, txt) {
  if (!el || $('.hint', el)) return;
  const h = document.createElement('div'); h.className = 'hint'; h.textContent = txt || 'Tap anywhere to start';
  el.appendChild(h);
}
function hideHint(el) { const h = el && $('.hint', el); if (h) h.remove(); }

// ---------- sound (session-wide, starts muted so autoplay works on iOS) ----------
let soundOn = false;
function setSound(on, { fromGesture = false } = {}) {
  soundOn = on;
  if (fromGesture) unlockMedia();
  for (const v of vpool) v.muted = !on;
  for (const [, y] of ytPlayers) if (y.ready) { try { on ? y.p.unMute() : y.p.mute(); } catch (_) {} }
  const b = $('#soundBtn'); if (b) { b.textContent = on ? '🔊' : '🔇'; b.setAttribute('aria-label', on ? 'Mute' : 'Unmute'); }
}
// Haptic-like feedback: a springy pop + burst ring (and a tiny vibration where the browser supports it).
function pop(b, on) { b.classList.remove('pop', 'burst'); void b.offsetWidth; b.classList.add('pop'); if (on) b.classList.add('burst'); try { navigator.vibrate && navigator.vibrate(on ? 12 : 6); } catch (_) {} }
function flashIcon(el, txt) { const t = $('.tapicon', el); if (!t) return; t.textContent = txt; t.classList.remove('show'); void t.offsetWidth; t.classList.add('show'); }

// ---------- YouTube IFrame API (youtube-nocookie) ----------
const ytPlayers = new Map(); // article element -> { p, ready, want }
let ytApi = null;
let ytApiFailed = false; // e.g. Brave Shields / content blockers block youtube.com/iframe_api or www-widgetapi
const YT_API_TIMEOUT = 4000;
function loadYT() {
  if (ytApiFailed) return Promise.resolve(null);
  if (ytApi) return ytApi;
  ytApi = new Promise((res) => {
    if (window.YT && window.YT.Player) return res(window.YT);
    const done = (v) => { clearTimeout(to); if (!v) { ytApiFailed = true; } res(v); };
    const to = setTimeout(() => done(null), YT_API_TIMEOUT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) try { prev(); } catch (_) {} done(window.YT); };
    const sc = document.createElement('script'); sc.src = 'https://www.youtube.com/iframe_api'; sc.async = true;
    sc.onerror = () => done(null); document.head.appendChild(sc);
  });
  return ytApi;
}
// ---- API-free fallback: plain youtube-nocookie iframe driven by postMessage commands ----
const YT_ORIGIN = 'https://www.youtube-nocookie.com';
const ytLog = []; // commands sent (for tests / debugging)
function rawSrc(id) {
  const q = new URLSearchParams({ autoplay: '1', mute: '1', playsinline: '1', controls: '0', rel: '0', modestbranding: '1', loop: '1', playlist: id,
    enablejsapi: '1', iv_load_policy: '3', fs: '0', disablekb: '1', hl: 'en', origin: location.origin });
  return `${YT_ORIGIN}/embed/${encodeURIComponent(id)}?${q}`;
}
function rawPlayer(el, it, rec, onState) {
  const host = $('.ythost', el); const f = document.createElement('iframe');
  f.className = 'ytraw'; f.src = rawSrc(it.youtubeId); f.title = it.title;
  f.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture'); f.setAttribute('playsinline', '');
  f.setAttribute('frameborder', '0');
  if (host) host.replaceWith(f); else $('.ytbox', el).prepend(f);
  const st = { ps: -1, t: 0, d: 0 };
  const send = (func, args = []) => { ytLog.push({ id: it.id, func, t: Date.now() }); try { f.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args, id: it.id, channel: 'widget' }), YT_ORIGIN); } catch (_) {} };
  const p = {
    raw: true, getIframe: () => f,
    playVideo: () => send('playVideo'), pauseVideo: () => send('pauseVideo'), mute: () => send('mute'), unMute: () => send('unMute'),
    seekTo: (s) => send('seekTo', [s, true]), getPlayerState: () => st.ps, getCurrentTime: () => st.t, getDuration: () => st.d,
    destroy: () => f.remove(),
    _msg: (d) => {
      if (d.event === 'onReady') { rec.ready = true; afterReady(); }
      if (d.event === 'onError') { rec.err = true; ytUnavailable(el, it, d.info); return; }
      const info = d.info; if (info == null) return;
      if (d.event === 'onStateChange' && typeof info === 'number') { st.ps = info; onState(info); }
      if (typeof info === 'object') {
        if (typeof info.playerState === 'number' && info.playerState !== st.ps) { st.ps = info.playerState; onState(st.ps); }
        if (typeof info.currentTime === 'number') st.t = info.currentTime; if (typeof info.duration === 'number') st.d = info.duration;
      }
    },
  };
  const afterReady = () => { if (rec._readyDone) return; rec._readyDone = true; rec.ready = true; soundOn ? p.unMute() : p.mute(); if (rec.want) p.playVideo(); else p.pauseVideo(); };
  f.addEventListener('load', () => {
    const hello = () => { try { f.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: it.id, channel: 'widget' }), YT_ORIGIN); } catch (_) {} };
    hello(); setTimeout(hello, 400); setTimeout(hello, 1200);
    // Even if the player never answers (no messages), treat it as ready so commands are still sent.
    setTimeout(afterReady, 1500);
  });
  return p;
}
window.addEventListener('message', (e) => {
  if (!/^https:\/\/www\.youtube(-nocookie)?\.com$/.test(e.origin)) return;
  let d = e.data; if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { return; } }
  if (!d || typeof d !== 'object') return;
  for (const [, rec] of ytPlayers) if (rec.p && rec.p.raw && rec.p.getIframe().contentWindow === e.source) { rec.p._msg(d); break; }
});
function ytStateHandler(el, rec) {
  return (state) => {
    const cover = $('.ytcover', el);
    if (state === 1) { if (cover) cover.classList.add('gone'); el.classList.add('live'); $('.playbig', el).hidden = true; el.classList.remove('ytpass'); hideHint(el); if (!rec.want) rec.p.pauseVideo(); }
    if (state === 0 && !rec.p.raw) { rec.p.seekTo(0, true); rec.p.playVideo(); } // loop (raw iframe loops via playlist=ID)
  };
}
function mountRaw(el, it) {
  const old = ytPlayers.get(el); if (old && old.p) { try { old.p.destroy(); } catch (_) {} }
  const rec = { p: null, ready: false, want: el === activeEl, raw: true }; ytPlayers.set(el, rec);
  rec.p = rawPlayer(el, it, rec, ytStateHandler(el, rec));
  if (rec.want) watchYT(el, rec);
  return rec;
}
const YT_VARS = (id) => ({ autoplay: 0, playsinline: 1, mute: 1, controls: 0, rel: 0, modestbranding: 1, iv_load_policy: 3, fs: 0, disablekb: 1, loop: 1, playlist: id, cc_load_policy: 0, hl: 'en', enablejsapi: 1, origin: location.origin });
async function mountYT(el, it, { active = false } = {}) {
  if (!online()) return;
  if (ytPlayers.has(el)) return;
  // Without the API, only the active slide gets an (autoplaying) iframe.
  if (ytApiFailed) { if (active) mountRaw(el, it); return; }
  const rec = { p: null, ready: false, want: false }; ytPlayers.set(el, rec);
  const YT = await loadYT(); if (ytPlayers.get(el) !== rec) return;
  if (!YT) { ytPlayers.delete(el); if (el === activeEl) mountRaw(el, it); return; }
  const host = $('.ythost', el); if (!host) return;
  const onState = ytStateHandler(el, rec);
  rec.p = new YT.Player(host, {
    host: YT_ORIGIN, videoId: it.youtubeId, width: '100%', height: '100%', playerVars: YT_VARS(it.youtubeId),
    events: {
      onReady: () => { rec.ready = true; const f = rec.p.getIframe && rec.p.getIframe(); if (f) { f.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture'); f.title = it.title; }
        if (soundOn) rec.p.unMute(); else rec.p.mute(); if (rec.want) ytPlay(el); },
      onStateChange: (e) => onState(e.data),
      onError: (e) => { rec.err = true; ytUnavailable(el, it, e && e.data); },
    },
  });
  // If the API loaded but the player never became ready (partly blocked), switch to the plain iframe.
  setTimeout(() => { if (ytPlayers.get(el) === rec && !rec.ready) { try { rec.p.destroy(); } catch (_) {} ytPlayers.delete(el); const box = $('.ytbox', el); if (box && !$('.ythost', box)) { const h = document.createElement('div'); h.className = 'ythost'; box.prepend(h); } if (el === activeEl) mountRaw(el, it); } }, 6000);
}
// A YouTube clip that won't play here (removed, private, embedding off: codes 100/101/150) is skipped from now on.
function ytUnavailable(el, it, code) {
  S.badYT = S.badYT || {}; S.badYT[it.id] = code || 1; save();
  el.classList.remove('ytpass'); hideHint(el);
  showHint(el, 'This clip isn’t available · swipe for the next one');
}
function unmountYT(el) {
  const rec = ytPlayers.get(el); if (!rec) return; ytPlayers.delete(el);
  try { rec.p && rec.p.destroy(); } catch (_) {}
  const box = $('.ytbox', el); if (box && !$('.ythost', box)) { const h = document.createElement('div'); h.className = 'ythost'; box.prepend(h); }
  const c = $('.ytcover', el); if (c) c.classList.remove('gone');
}
function watchYT(el, rec) {
  clearTimeout(rec.t); rec.t = setTimeout(() => {
    if (!rec.want || activeEl !== el) return; let st = -1; try { st = rec.p.getPlayerState(); } catch (_) {}
    if (st === 1 || st === 3) return;
    try { rec.p.mute(); rec.p.playVideo(); } catch (_) {}
    setTimeout(() => {
      if (!rec.want || activeEl !== el) return; let s2 = -1; try { s2 = rec.p.getPlayerState(); } catch (_) {}
      // Still not playing: the browser wants a tap. The whole slide becomes the tap target (taps on the video reach
      // YouTube's own player; taps elsewhere send play+unmute inside the gesture). Our poster stays; no extra button.
      if (s2 !== 1 && s2 !== 3 && !rec.err) { el.classList.add('ytpass'); showHint(el, 'Tap to play'); }
    }, 2500);
  }, 2500);
}
function ytPlay(el) {
  const rec = ytPlayers.get(el); if (!rec) return; rec.want = true; if (!rec.ready) return;
  try { if (soundOn) rec.p.unMute(); else rec.p.mute(); rec.p.playVideo(); } catch (_) {}
  watchYT(el, rec);
}
function ytPause(el) { const rec = ytPlayers.get(el); if (!rec) return; rec.want = false; clearTimeout(rec.t); if (rec.ready) try { rec.p.pauseVideo(); } catch (_) {} }

// ---------- playback control ----------
let stallT = null;
function playFile(el, it) {
  const v = setVideoSrc(el, it, 'auto'); if (!v) return;
  v.muted = !soundOn; userPaused = false;
  // Stall watchdog: if a clip that is "playing" hasn't advanced after a few seconds (slow or stuck connection),
  // retry it once, then fall back to its other source, without asking for a tap.
  clearTimeout(stallT); let tries = 0;
  const watch = () => { stallT = setTimeout(() => {
    if (v._el !== el || el !== activeEl || userPaused || v.paused || v.currentTime > 0.2) return;
    tries++;
    if (tries === 1 || !(v._srcs && v._k < v._srcs.length)) v.load(); else v.src = v._srcs[v._k++].url;
    v.play().catch(() => {});
    if (tries < 3) watch(); else showHint(el, 'Slow connection · swipe for the next clip');
  }, 6000); };
  watch();
  const p = v.play();
  if (p) p.catch((err) => {
    // Only NotAllowedError means the browser refused autoplay; Abort/NotSupported are load races handled elsewhere.
    if (v._el !== activeEl || userPaused || (err && err.name !== 'NotAllowedError')) return;
    if (!v.muted) { v.muted = true; v.play().catch((e2) => { if (!e2 || e2.name === 'NotAllowedError') autoplayBlocked(el); }); toast('Tap anywhere for sound'); }
    else autoplayBlocked(el);
  });
}
// Muted inline autoplay refused (iOS Low Power Mode etc.): one tap anywhere starts it and unlocks every later clip.
function autoplayBlocked(el) {
  if (!autoplayStrict) { autoplayStrict = true; toast('Autoplay is paused on this phone (Low Power Mode?). Tap once and the rest play on their own.', 4200); }
  showHint(el);
}
function pauseItem(el) { if (!el) return; const v = $('video', el); if (v) v.pause(); ytPause(el); }
function pauseAll() { vpool.forEach((v) => v.pause()); for (const [el] of ytPlayers) ytPause(el); }
function playActive() { if (!activeEl) return; const it = feedItems[+activeEl.dataset.idx]; if (!it) return;
  if (it.kind === 'file') playFile(activeEl, it); else if (it.kind === 'youtube') ytPlay(activeEl); }
let ytTick = null;
function trackYTProgress(el) {
  clearInterval(ytTick);
  ytTick = setInterval(() => { if (activeEl !== el) return clearInterval(ytTick); const rec = ytPlayers.get(el); if (!rec || !rec.ready) return;
    try { const d = rec.p.getDuration(), t = rec.p.getCurrentTime(); if (d) $('.progress i', el).style.width = (100 * t / d) + '%'; } catch (_) {} }, 400);
}

function activate(el) {
  if (activeEl === el) return;
  if (activeEl) pauseItem(activeEl);
  activeEl = el;
  const idx = +el.dataset.idx; const it = feedItems[idx];
  // Keep previous/current/next warm, unmount far items to save memory. The video pool serves current, next, previous.
  const wantV = [idx, idx + 1, idx - 1].filter((i) => feedItems[i] && feedItems[i].kind === 'file');
  for (const v of vpool) if (v._el && !wantV.includes(+v._el.dataset.idx)) releaseVideo(v);
  $$('#feed .item').forEach((x) => {
    const i = +x.dataset.idx; const d = i - idx; const xi = feedItems[i]; if (!xi) return;
    if (Math.abs(d) > DRY_FAR) { dehydrate(x); return; }
    if (Math.abs(d) <= HYDRATE_NEAR) hydrate(x, i);
    if (xi.kind === 'file' && (d === 1 || d === -1)) setVideoSrc(x, xi, d === 1 ? 'auto' : 'metadata');
    if (xi.kind === 'youtube') { if (Math.abs(d) <= 1) mountYT(x, xi, { active: d === 0 }); else unmountYT(x); }
  });
  if (idx >= feedItems.length - REFILL_AT) {
    appendBatch();
    if (online()) refreshContent({ minGap: 2 * 60 * 1000 }); // background fresh fetch; results join later batches
  }
  if (!it) return;
  if (it.kind !== 'learn' && it.kind !== 'end') { S.seen[it.id] = Date.now(); save(); seenPut(it.id, S.seen[it.id]); }
  if (it.kind === 'file') playFile(el, it);
  if (it.kind === 'youtube') { if (!online()) return; mountYT(el, it, { active: true }); ytPlay(el); trackYTProgress(el); }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) pauseAll(); else if (!$('#view-feed').hidden && $('#nudge').hidden) playActive(); });

// ---------- interactions ----------
$('#feed').addEventListener('click', async (e) => {
  const el = e.target.closest('.item'); if (!el) return;
  const it = feedItems[+el.dataset.idx];
  const b = e.target.closest('button');
  if (b?.classList.contains('like')) { S.likes[it.id] ? delete S.likes[it.id] : (S.likes[it.id] = Date.now()); save(); b.classList.toggle('liked', !!S.likes[it.id]); b.textContent = S.likes[it.id] ? '♥' : '♡'; pop(b, !!S.likes[it.id]); return; }
  if (b?.classList.contains('save')) { toggleSave(it); b.classList.toggle('on', !!S.saves[it.id]); b.textContent = S.saves[it.id] ? '★' : '☆'; pop(b, !!S.saves[it.id]); return; }
  if (b?.classList.contains('share')) { share(it); return; }
  if (b?.classList.contains('opt')) { answer(b); return; }
  if (b?.id === 'nextSet') { S.setIndex++; save(); buildFeed(); return; }
  if (b?.id === 'goLib') { show('library'); return; }
  if ((it?.kind === 'youtube' || it?.kind === 'file') && !e.target.closest('.meta a, .rail')) {
    if (it.kind === 'youtube' && !online()) { toast('YouTube clips need internet'); return; }
    // First tap turns sound on (TikTok-style); after that a tap toggles pause/resume.
    const v0 = $('video', el);
    if (!soundOn || b?.classList.contains('playbig') || (v0 && (v0.muted || (v0.paused && !userPaused))) || el.classList.contains('ytpass')) {
      if (!soundOn) { setSound(true, { fromGesture: true }); flashIcon(el, '🔊'); }
      hideHint(el); userPaused = false;
      const v = v0; if (v) { v.muted = false; v.play().catch(() => { v.muted = true; v.play().catch(() => {}); }); }
      else { const rec = ytPlayers.get(el); if (rec && rec.ready) { rec.want = true; rec.p.unMute(); rec.p.playVideo(); } else if (rec) ytPlay(el); else mountYT(el, it, { active: true }); }
      $('.playbig', el).hidden = true; return;
    }
    const v = $('video', el);
    if (v) { if (v.paused) { userPaused = false; v.play().catch(() => {}); flashIcon(el, '▶'); } else { userPaused = true; v.pause(); flashIcon(el, '❚❚'); } return; }
    const rec = ytPlayers.get(el); if (!rec || !rec.ready) return;
    let st = -1; try { st = rec.p.getPlayerState(); } catch (_) {}
    if (st === 1 || st === 3) { ytPause(el); flashIcon(el, '❚❚'); } else { rec.want = true; rec.p.playVideo(); flashIcon(el, '▶'); }
  }
});
$('#soundBtn').addEventListener('click', () => { setSound(!soundOn, { fromGesture: true }); if (soundOn && activeEl) { const v = $('video', activeEl); if (v && v.paused) v.play().catch(() => {}); } });
function answer(btn) {
  const wrap = btn.parentElement; if (wrap.dataset.done) return; wrap.dataset.done = '1';
  const right = +wrap.dataset.answer; const picked = +btn.dataset.i;
  $$('.opt', wrap).forEach((o) => { if (+o.dataset.i === right) o.classList.add('right'); });
  if (picked !== right) btn.classList.add('wrong');
  wrap.nextElementSibling.innerHTML = (picked === right ? '✅ Correct. ' : '❌ Not quite. ') + esc(wrap.dataset.take);
}
function toggleSave(it) {
  if (S.saves[it.id]) {
    delete S.saves[it.id]; const s = pickSource(it); if (s) dropReason(s.url, 'saved'); toast('Removed from Library');
  } else {
    S.saves[it.id] = Date.now();
    if (it.kind === 'file') { download(it, 'saved', { quiet: false }).then((ok) => ok && toast('Saved · available offline')); toast('Saved · downloading for offline…'); }
    else toast(it.kind === 'youtube' ? 'Saved (YouTube clips need internet)' : 'Saved · works offline');
  }
  save();
}
async function share(it) {
  const url = it.sourceUrl || location.href;
  const text = it.takeaway || (it.steps ? it.steps.join(' • ') : '');
  try {
    if (navigator.share) await navigator.share({ title: it.title, text, url });
    else { await navigator.clipboard.writeText(`${it.title}\n${text}\n${url}`); toast('Copied to clipboard'); }
  } catch (_) {}
}

// ---------- views ----------
function show(view) {
  $$('.view').forEach((v) => { const on = v.id === 'view-' + view; v.hidden = !on; v.classList.toggle('active', on); });
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  if (view !== 'feed') pauseAll();
  else playActive();
  if (view === 'library') renderLibrary();
  if (view === 'settings') renderSettings();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => show(t.dataset.view)));
$$('.seg-btn').forEach((b) => b.addEventListener('click', () => {
  $$('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
  $('#libSaved').hidden = b.dataset.lib !== 'saved'; $('#libOffline').hidden = b.dataset.lib !== 'offline';
  if (b.dataset.lib === 'offline') renderOffline();
}));

function renderLibrary() {
  const saved = Object.entries(S.saves).sort((a, b) => b[1] - a[1]).map(([id]) => byId.get(id)).filter(Boolean);
  $('#libSaved').innerHTML = saved.length ? saved.map((it) => {
    const s = pickSource(it); const off = s && S.media[s.url];
    const th = it.poster ? `style="background-image:url('${esc(it.poster)}')"` : '';
    return `<div class="libitem" data-open="${esc(it.id)}"><div class="th" ${th}>${it.poster ? '' : topicOf(it.topic).emoji}</div>
      <div class="tx"><b>${esc(it.title)}</b><span class="small muted">${topicOf(it.topic).label} · ${it.kind === 'tip' ? 'Tip card · offline' : it.kind === 'youtube' ? 'YouTube · online only' : off ? 'Video · offline ✓' : 'Video'}</span></div>
      <button class="btn sm ghost" data-unsave="${esc(it.id)}">Remove</button></div>`;
  }).join('') : '<div class="empty">Nothing saved yet. Tap ☆ on anything worth keeping.</div>';
  if (!$('#libOffline').hidden) renderOffline();
}
$('#libSaved').addEventListener('click', (e) => {
  const u = e.target.closest('[data-unsave]'); if (u) { toggleSave(byId.get(u.dataset.unsave)); renderLibrary(); return; }
  const o = e.target.closest('[data-open]'); if (o) { show('feed'); buildFeed(o.dataset.open); }
});

async function renderOffline() {
  const used = usedBytes(); $('#storageUsed').textContent = mb(used); $('#capLabel').textContent = mb(capBytes());
  $('#storageBar').style.width = Math.min(100, 100 * used / capBytes()) + '%';
  try { const est = await navigator.storage.estimate(); $('#storageQuota').textContent = `Browser quota: ${mb(est.quota || 0)}`; } catch (_) {}
  const sel = S.topics.length ? S.topics : CAT.topics.map((t) => t.id);
  $('#packs').innerHTML = CAT.topics.filter((t) => sel.includes(t.id)).map((t) => {
    const vids = CAT.items.filter((i) => i.topic === t.id && i.kind === 'file' && pickSource(i));
    const tips = CAT.items.filter((i) => i.topic === t.id && i.kind === 'tip').length;
    const total = vids.reduce((a, i) => a + (pickSource(i).bytes || 0), 0);
    const have = vids.filter((i) => S.media[pickSource(i).url]).length;
    const on = !!S.packs[t.id];
    return `<div class="pack"><div style="font-size:26px">${t.emoji}</div><div class="tx"><b>${esc(t.label)}</b><br>
      <span class="small muted">${vids.length ? `${vids.length} videos · ${mb(total)} · ${have}/${vids.length} offline` : 'No downloadable videos'}${tips ? ` · ${tips} tip cards (always offline)` : ''}</span></div>
      ${vids.length ? (on ? `<button class="btn sm danger" data-unpack="${t.id}">Remove</button>` : `<button class="btn sm primary" data-pack="${t.id}">Download</button>`) : ''}</div>`;
  }).join('');
}
$('#packs').addEventListener('click', async (e) => {
  const p = e.target.closest('[data-pack]'); const u = e.target.closest('[data-unpack]');
  if (p) {
    if (!online()) return toast('Connect to the internet to download packs');
    const id = p.dataset.pack; const vids = CAT.items.filter((i) => i.topic === id && i.kind === 'file' && pickSource(i));
    const need = vids.reduce((a, i) => a + (S.media[pickSource(i).url] ? 0 : pickSource(i).bytes || 0), 0);
    if (usedBytes() + need > capBytes()) { await makeRoom(need); if (usedBytes() + need > capBytes()) return toast(`Pack needs ${mb(need)} — over your ${mb(capBytes())} cap`); }
    S.packs[id] = true; save(); p.disabled = true; let n = 0;
    for (const it of vids) { await download(it, 'pack:' + id); p.textContent = `${++n}/${vids.length}`; }
    toast(`${topicOf(id).label} pack ready offline`); renderOffline();
  }
  if (u) { const id = u.dataset.unpack; delete S.packs[id]; for (const it of CAT.items.filter((i) => i.topic === id && i.kind === 'file')) { const s = pickSource(it); if (s) await dropReason(s.url, 'pack:' + id); } save(); renderOffline(); }
});
$('#clearRecent').addEventListener('click', async () => { for (const url of Object.keys(S.media)) await dropReason(url, 'recent'); S.recent = []; save(); renderOffline(); toast('Cleared recent downloads'); });
$('#clearAll').addEventListener('click', async () => {
  if (!confirm('Delete all downloaded videos from this device? Your saved list stays.')) return;
  await caches.delete(MEDIA_CACHE); S.media = {}; S.packs = {}; save(); renderOffline(); toast('All downloads deleted');
});

function topicChips(container, onChange) {
  container.innerHTML = CAT.topics.map((t) => `<button class="chip ${S.topics.includes(t.id) ? 'on' : ''}" data-t="${t.id}">${t.emoji} ${esc(t.label)}</button>`).join('');
  container.onclick = (e) => { const c = e.target.closest('.chip'); if (!c) return; const id = c.dataset.t;
    S.topics = S.topics.includes(id) ? S.topics.filter((x) => x !== id) : [...S.topics, id]; c.classList.toggle('on'); save(); onChange && onChange(); };
}
function renderSettings() {
  topicChips($('#settingsTopics'), () => (settingsDirty = true));
  $('#limitSel').value = String(S.settings.limit); $('#recapSel').value = String(S.settings.recap); $('#capSel').value = String(S.settings.cap);
  setFreshStatus();
  $('#autoRecent').checked = S.settings.autoRecent; $('#wifiOnly').checked = S.settings.wifiOnly;
}
let settingsDirty = false;
$('#limitSel').onchange = (e) => { S.settings.limit = +e.target.value; save(); updateTimer(); };
$('#recapSel').onchange = (e) => { S.settings.recap = +e.target.value; save(); settingsDirty = true; };
$('#capSel').onchange = async (e) => { S.settings.cap = +e.target.value; save(); await makeRoom(0); };
$('#autoRecent').onchange = (e) => { S.settings.autoRecent = e.target.checked; save(); };
$('#wifiOnly').onchange = (e) => { S.settings.wifiOnly = e.target.checked; save(); };
$('#refreshNow').onclick = () => refreshContent({ manual: true });
$('#resetApp').onclick = async () => { if (!confirm('Reset Lumen on this device? This clears likes, saves, settings and downloads.')) return; localStorage.removeItem(KEY); await caches.delete(MEDIA_CACHE); try { indexedDB.deleteDatabase(FRESH_DB); } catch (_) {} location.reload(); };
document.querySelector('.tab[data-view="feed"]').addEventListener('click', () => { if (settingsDirty) { settingsDirty = false; buildFeed(); } });

// ---------- session timer & gentle stop ----------
function updateTimer() {
  if (S.time.date !== today()) S.time = { date: today(), secs: 0, snoozeUntil: 0, done: false };
  const m = Math.floor(S.time.secs / 60); const lim = S.settings.limit;
  $('#timerPill').textContent = lim ? `${m}/${lim} min` : `${m} min`;
  if (lim && !S.time.done && S.time.secs >= lim * 60 && S.time.secs >= S.time.snoozeUntil && $('#nudge').hidden) {
    pauseAll();
    $('#nudgeText').textContent = `You've spent ${m} minutes learning today — your goal was ${lim}. Stopping here helps it sink in.`;
    $('#nudge').hidden = false;
  }
}
setInterval(() => {
  if (document.visibilityState === 'visible' && !$('#view-feed').hidden && $('#nudge').hidden && $('#onboard').hidden) { S.time.secs += 5; save(); }
  updateTimer();
}, 5000);
$('#nudgeMore').onclick = () => { S.time.snoozeUntil = S.time.secs + 300; save(); $('#nudge').hidden = true; };
$('#nudgeStop').onclick = () => { S.time.done = true; save(); $('#nudge').hidden = true; show('library');
  toast('See you tomorrow. Your saved items are here.', 3500); };

// ---------- connectivity ----------
async function updateOfflineBar() {
  const bar = $('#offlineBar'); if (!bar) return;
  if (online()) { bar.hidden = true; return; }
  const n = (await availableOffline()).size; const tips = CAT.items.filter((i) => i.kind === 'tip').length;
  bar.textContent = `Offline · ${n} saved clip${n === 1 ? '' : 's'} + ${tips} tip cards. New clips download when you’re back online.`;
  bar.hidden = false;
}
function updateOnline(rebuild) {
  $('#offlineBadge').hidden = online(); updateOfflineBar();
  if (rebuild) { activeEl = null; buildFeed(); }
}
window.addEventListener('online', () => { updateOnline(true); toast('Back online · fetching fresh clips'); setTimeout(() => refreshContent(), 1500); });
window.addEventListener('offline', () => { updateOnline(true); toast('Offline · playing your saved clips and tip cards'); });

// ---------- fresh content: pull new items when online, keep them for offline ----------
const FRESH_DB = 'lumen-fresh';
const FRESH_MAX = 400;          // max fresh items kept on device
const FRESH_VIDEOS = 3;         // new video files pre-downloaded per refresh
const FRESH_VIDEO_MAX_BYTES = 30 * 1048576;
const FRESH_MIN_GAP = 10 * 60 * 1000; // auto refresh at most every 10 minutes
const WIKI_CATS = {
  automotive: 'Automotive_technologies|Vehicle_parts|Automotive_safety|Engine_technology',
  home: 'Home_improvement|Plumbing|Building_materials|Heating,_ventilation,_and_air_conditioning',
  cooking: 'Cooking_techniques|Food_preparation|Food_safety',
  money: 'Personal_finance|Investment|Banking_terms',
  fitness: 'Physical_exercise|Nutrition|Sleep',
  firstaid: 'First_aid|Medical_emergencies|Safety',
  tech: 'Computer_security|Computer_networking|Computer_hardware',
  career: 'Employment|Skills|Negotiation',
  outdoors: 'Hiking|Camping|Wilderness_survival',
  tools: 'Hand_tools|Power_tools|Woodworking',
  lifehacks: 'Cleaning|Home_economics|Laundry',
  study: 'Learning_methods|Memory|Cognitive_biases',
  space: 'Planets_of_the_Solar_System|Space_exploration|Astronomical_objects|Stellar_phenomena',
  physics: 'Concepts_in_physics|Classical_mechanics|Thermodynamics',
  math: 'Mathematical_concepts|Probability_theory|Geometry',
  chemistry: 'Chemical_reactions|Chemical_elements|Acid–base_chemistry',
  biology: 'Cell_biology|Human_anatomy|Evolutionary_biology',
  earth: 'Geology|Meteorology|Volcanology|Oceanography',
  history: 'Ancient_history|Inventions|20th-century_conflicts|History_of_science',
};
// Commons video searches only for topics where openly licensed educational video is plentiful.
const COMMONS_Q = {
  space: ['NASA animation', 'NASA Scientific Visualization Studio', 'planet animation'],
  physics: ['physics demonstration', 'experimental demonstration'],
  chemistry: ['chemical reaction', 'chemistry experiment'],
  earth: ['volcano eruption', 'glacier', 'hurricane satellite'],
  biology: ['cell division', 'microscopy'],
  tech: ['computer components', 'how it works animation'],
  automotive: ['engine animation', 'car crash test'],
  tools: ['welding', 'lathe machining'],
  firstaid: ['CPR', 'first aid'],
  history: ['historical footage', 'newsreel'],
  math: ['mathematics visualization', 'geometry animation'],
  fitness: ['exercise technique'],
};
const BAD_WORDS = /\b(nsfw|nude|nudity|naked|porn\w*|sex|sexual|erotic\w*|fetish|gore|beheading|suicide|murder\w*|massacre|celebrity|gossip|meme|prank|tiktok|music video|trailer|short movie|short film|dance|song|gameplay|advert\w*)\b/i;
const NOT_LATIN = /[^\u0000-\u024F\u2000-\u206F\u2190-\u21FF°±×÷–—’“”…]/;
let freshBusy = null;

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(FRESH_DB, 2);
    r.onupgradeneeded = () => { const db = r.result;
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('seen')) db.createObjectStore('seen', { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbAll() {
  try { const db = await idb(); return await new Promise((res) => { const q = db.transaction('items').objectStore('items').getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); }); }
  catch (_) { return []; }
}
async function seenPut(id, ts) { try { const db = await idb(); db.transaction('seen', 'readwrite').objectStore('seen').put({ id, ts }); } catch (_) {} }
async function seenLoad() {
  try { const db = await idb(); const rows = await new Promise((res) => { const q = db.transaction('seen').objectStore('seen').getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); });
    for (const r of rows) if (!S.seen[r.id] || S.seen[r.id] < r.ts) S.seen[r.id] = r.ts;
    // Seed IndexedDB from older installs that only kept seen IDs in localStorage.
    if (!rows.length && Object.keys(S.seen).length) { const tx = db.transaction('seen', 'readwrite'); const st = tx.objectStore('seen'); for (const [id, ts] of Object.entries(S.seen)) st.put({ id, ts }); }
    return rows.length; } catch (_) { return 0; }
}
async function idbPut(items) {
  if (!items.length) return; const db = await idb();
  await new Promise((res, rej) => { const tx = db.transaction('items', 'readwrite'); const st = tx.objectStore('items'); items.forEach((i) => st.put(i)); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
async function idbDelete(ids) {
  if (!ids.length) return; const db = await idb();
  await new Promise((res) => { const tx = db.transaction('items', 'readwrite'); const st = tx.objectStore('items'); ids.forEach((i) => st.delete(i)); tx.oncomplete = res; tx.onerror = res; });
}
function mergeItems(items) {
  let added = 0;
  for (const it of items) { if (!it || !it.id || byId.has(it.id)) continue; CAT.items.push(it); byId.set(it.id, it); added++; }
  return added;
}
async function loadFresh() { const items = await idbAll(); mergeItems(items); return items.length; }

const clean = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s*\([^()]*\)/g, '').replace(/\s+/g, ' ').trim();
const sentences = (s) => (clean(s).match(/[^.!?]+[.!?]+(\s|$)/g) || []).map((x) => x.trim()).filter((x) => x.length > 20);
const pickN = (arr, n) => shuffle(arr, Math.random).slice(0, n);
async function getJSON(url) { const r = await fetch(url, { mode: 'cors', credentials: 'omit' }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }

async function wikiCards(topic) {
  const cats = WIKI_CATS[topic]; if (!cats) return [];
  const base = 'https://en.wikipedia.org/w/api.php?origin=*&format=json&formatversion=2&action=query';
  const offset = Math.floor(Math.random() * 60);
  const q = `${base}&generator=search&gsrnamespace=0&gsrlimit=6&gsroffset=${offset}&gsrsearch=${encodeURIComponent('incategory:' + cats)}` +
    '&prop=extracts|info|pageprops&exintro=1&explaintext=1&exlimit=max&inprop=url&ppprop=disambiguation';
  const d = await getJSON(q);
  const out = [];
  for (const p of (d.query && d.query.pages) || []) {
    if (p.pageprops && 'disambiguation' in p.pageprops) continue;
    const ss = sentences(p.extract).slice(0, 4);
    const text = ss.join(' ');
    if (ss.length < 2 || text.length < 160 || BAD_WORDS.test(p.title + ' ' + text) || /^(List|Index|Outline|Timeline) of/i.test(p.title)) continue;
    out.push({ id: 'w' + p.pageid, kind: 'tip', format: 'fact', fresh: true, added: Date.now(), topic, title: p.title, steps: ss, note: '',
      credit: 'Wikipedia contributors', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      sourceName: 'Wikipedia', sourceUrl: p.fullurl || 'https://en.wikipedia.org/?curid=' + p.pageid, takeaway: ss[0] });
  }
  return out.slice(0, 3);
}

async function commonsVideos(topic) {
  const qs = COMMONS_Q[topic]; if (!qs) return [];
  const term = qs[Math.floor(Math.random() * qs.length)];
  const q = 'https://commons.wikimedia.org/w/api.php?origin=*&format=json&formatversion=2&action=query&generator=search&gsrnamespace=6&gsrlimit=20' +
    `&gsroffset=${Math.floor(Math.random() * 20)}&gsrsearch=${encodeURIComponent('filetype:video ' + term)}` +
    '&prop=videoinfo|imageinfo|globalusage&viprop=url|size|derivatives|extmetadata&iiprop=url&iiurlwidth=540' +
    '&viextmetadatafilter=LicenseShortName|LicenseUrl|Artist|ImageDescription&gunamespace=0&gulimit=50';
  const d = await getJSON(q);
  const out = [];
  for (const p of (d.query && d.query.pages) || []) {
    const vi = (p.videoinfo || [])[0]; if (!vi) continue;
    const md = vi.extmetadata || {}; const lic = clean(md.LicenseShortName && md.LicenseShortName.value);
    const desc = clean(md.ImageDescription && md.ImageDescription.value);
    const title = p.title.replace(/^File:/, '').replace(/\.(webm|ogv|ogg|mpg|mpeg|mp4|mov)$/i, '').replace(/[_-]+/g, ' ').trim();
    const dur = Math.round(vi.duration || 0);
    const usedOnEnwiki = (p.globalusage || []).some((g) => g.wiki === 'en.wikipedia.org');
    if (!usedOnEnwiki || dur < 10 || dur > 300 || desc.length < 40) continue;   // vetted: used in an English Wikipedia article
    if (!/^(cc0|cc[- ]by|public domain|pd)/i.test(lic) || /nc|nd/i.test(lic.replace(/^cc[- ]by/i, ''))) continue;
    if (BAD_WORDS.test(title + ' ' + desc) || NOT_LATIN.test(title)) continue;
    const ders = {}; (vi.derivatives || []).forEach((x) => { if (x.transcodekey) ders[x.transcodekey] = x.src; });
    const sources = [];
    const webm = ders['360p.vp9.webm'] || ders['480p.vp9.webm'] || ders['240p.vp9.webm'];
    const mov = ders['360p.mpeg4.mov'] || ders['480p.mpeg4.mov'];
    const est = dur * 90000; // ~0.7 Mbit/s for 360p
    if (webm) sources.push({ url: webm, type: 'video/webm', bytes: est });
    if (mov) sources.push({ url: mov, type: 'video/mp4', bytes: est * 2 });
    if (!sources.length) continue;
    const take = sentences(desc)[0] || desc.slice(0, 160);
    out.push({ id: 'c' + p.pageid, kind: 'file', fresh: true, added: Date.now(), topic, title: title.slice(0, 80), fileTitle: p.title.slice(5),
      sources, poster: (p.imageinfo && p.imageinfo[0] && p.imageinfo[0].thumburl) || '', duration: dur,
      credit: clean(md.Artist && md.Artist.value).slice(0, 120) || 'Wikimedia Commons contributor', license: lic,
      licenseUrl: (md.LicenseUrl && md.LicenseUrl.value) || '', sourceName: 'Wikimedia Commons', sourceUrl: vi.descriptionurl || ('https://commons.wikimedia.org/wiki/' + encodeURIComponent(p.title)),
      takeaway: take.length > 200 ? take.slice(0, 197) + '…' : take });
  }
  return out;
}

async function remoteCatalog() {
  try { const c = await getJSON('data/catalog.json?fresh=' + Date.now()); return (c.items || []).filter((i) => !byId.has(i.id)); } catch (_) { return []; }
}

async function pruneFresh() {
  const fresh = CAT.items.filter((i) => i.fresh);
  if (fresh.length <= FRESH_MAX) return;
  const keepMedia = new Set(Object.values(S.media).map((m) => m.id));
  const drop = fresh.filter((i) => !S.saves[i.id] && !keepMedia.has(i.id))
    .sort((a, b) => (!!S.seen[b.id] - !!S.seen[a.id]) || a.added - b.added).slice(0, fresh.length - FRESH_MAX).map((i) => i.id);
  const ds = new Set(drop); CAT.items = CAT.items.filter((i) => !ds.has(i.id)); drop.forEach((id) => byId.delete(id));
  await idbDelete(drop);
}
async function roomForFresh(need) {
  // Only evict older auto-downloaded fresh clips; never the user's saved, recent or pack downloads.
  const old = Object.entries(S.media).filter(([, m]) => m.reasons.length === 1 && m.reasons[0] === 'fresh').sort((a, b) => a[1].ts - b[1].ts);
  while (usedBytes() + need > capBytes() && old.length) { const [url] = old.shift(); await dropReason(url, 'fresh'); }
  return usedBytes() + need <= capBytes();
}

function refreshContent({ manual = false, minGap = FRESH_MIN_GAP } = {}) {
  if (freshBusy) return freshBusy;
  freshBusy = (async () => {
    const res = { ok: false, text: 0, videos: 0, catalog: 0, found: 0, skipped: '' };
    if (!online()) { res.skipped = 'offline'; if (manual) toast('You are offline — connect to get new content'); return res; }
    if (!manual && S.fresh && Date.now() - (S.fresh.last || 0) < minGap) { res.skipped = 'recent'; return res; }
    setFreshStatus('Checking for new content…');
    const topics = S.topics.length ? S.topics : CAT.topics.map((t) => t.id);
    const textTopics = pickN(topics, 8);
    const vidTopics = pickN(topics.filter((t) => COMMONS_Q[t]), 3);
    const jobs = [remoteCatalog(), ...textTopics.map((t) => wikiCards(t).catch(() => [])), ...vidTopics.map((t) => commonsVideos(t).catch(() => []))];
    const results = await Promise.all(jobs);
    const cat = results[0]; const text = results.slice(1, 1 + textTopics.length).flat(); const vids = results.slice(1 + textTopics.length).flat();
    const uniq = (l) => [...new Map(l.map((i) => [i.id, i])).values()];
    const newText = uniq(text).filter((i) => !byId.has(i.id)); const newVids = uniq(vids).filter((i) => !byId.has(i.id) && pickSource(i));
    res.found = text.length + vids.length;
    res.catalog = mergeItems(cat);
    mergeItems(newText); mergeItems(newVids);
    try { await idbPut([...newText, ...newVids]); } catch (_) {}
    res.text = newText.length;
    // Pre-download a few new clips for offline (respects Wi-Fi-only + storage cap).
    if (!(S.settings.wifiOnly && metered())) {
      for (const it of newVids.slice(0, FRESH_VIDEOS)) {
        const src = pickSource(it); if (!src || src.bytes > FRESH_VIDEO_MAX_BYTES) continue;
        if (!(await roomForFresh(src.bytes))) break;
        if (await download(it, 'fresh')) res.videos++;
      }
    } else res.skipped = 'metered: videos not downloaded';
    await pruneFresh();
    S.fresh = { last: Date.now(), lastText: res.text, lastVideos: res.videos, lastCatalog: res.catalog }; save();
    res.ok = true;
    const n = res.text + res.videos + res.catalog;
    setFreshStatus();
    if (n) toast(`${n} new item${n === 1 ? '' : 's'} saved for offline`, 3000);
    else if (manual) toast('No new items right now — try again later');
    // Only rebuild the feed if the user is still at the top, so nothing jumps under their finger.
    // Never swap the feed under the viewer; only fill it if it was empty. New items show in the next set / next open.
    const hasMedia = feedItems.some((x) => x.kind !== 'learn' && x.kind !== 'end');
    if (n && !hasMedia) { activeEl = null; await buildFeed(); }
    return res;
  })().catch((e) => { setFreshStatus(); if (manual) toast('Refresh failed: ' + e.message); return { ok: false, error: e.message }; })
    .finally(() => { freshBusy = null; });
  return freshBusy;
}
function setFreshStatus(msg) {
  const el = $('#freshStatus'); if (!el) return;
  if (msg) { el.textContent = msg; return; }
  const f = S.fresh; const cnt = CAT.items.filter((i) => i.fresh).length;
  el.textContent = f && f.last ? `Last updated ${new Date(f.last).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${cnt} fresh items on this device` : 'Not updated yet';
}

// ---------- onboarding ----------
function onboard() {
  return new Promise((resolve) => {
    $('#onboard').hidden = false;
    const go = $('#onboardGo');
    topicChips($('#onboardTopics'), () => (go.disabled = S.topics.length === 0));
    go.onclick = () => { unlockMedia(); $('#onboard').hidden = true; resolve(); };
  });
}

// ---------- boot ----------
// ---------- updates: a waiting service worker shows "Update available, tap to refresh" ----------
const bootAt = Date.now(); let interacted = false; let swReg = null; let waitingSW = null;
['pointerdown', 'touchstart', 'keydown'].forEach((t) => document.addEventListener(t, () => (interacted = true), { once: true, passive: true, capture: true }));
function setVerStatus(txt) { const e = $('#verStatus'); if (e) e.textContent = txt; }
function offerUpdate(w) {
  if (!w) return; waitingSW = w;
  // Right after opening (nothing touched yet) just apply it; mid-session, ask first so nothing gets interrupted.
  if (!interacted && Date.now() - bootAt < 8000) { w.postMessage('SKIP_WAITING'); return; }
  $('#updToast').hidden = false; setVerStatus('Update available — tap the banner or the button below');
  const b = $('#checkUpd'); if (b) b.textContent = 'Update now';
}
function applyUpdate() { if (waitingSW) { $('#updToast').textContent = 'Updating…'; waitingSW.postMessage('SKIP_WAITING'); setTimeout(() => location.reload(), 4000); } else location.reload(); }
async function checkUpdate(manual) {
  if (waitingSW) return applyUpdate();
  if (!swReg) { if (manual) toast('Updates need the installed app to be online'); return; }
  if (manual) setVerStatus('Checking…');
  try { await swReg.update(); } catch (_) {}
  setTimeout(() => { if (!waitingSW && !swReg.installing) setVerStatus(online() ? 'Up to date' : 'Offline — will check when you’re back online'); }, manual ? 2500 : 0);
}
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = swReg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
    const watch = (n) => n && n.addEventListener('statechange', () => { if (n.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(n); });
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    watch(reg.installing); reg.addEventListener('updatefound', () => watch(reg.installing));
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (waitingSW && !reloaded) { reloaded = true; location.reload(); } });
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    setInterval(() => reg.update().catch(() => {}), 20 * 60 * 1000);
    checkUpdate(false);
  } catch (e) { console.warn('SW', e); }
}
$('#updToast').addEventListener('click', applyUpdate);
$('#checkUpd').addEventListener('click', () => checkUpdate(true));

async function boot() {
  const catP = fetch('data/catalog.json').then((r) => r.json()).catch(() => ({ topics: [], items: [] }));
  $$('#appVer, .appVer2').forEach((e) => (e.textContent = 'v' + APP_VERSION));
  registerSW();
  CAT = await catP;
  byId = new Map(CAT.items.map((i) => [i.id, i]));
  await loadFresh();
  await seenLoad();
  // Reconcile media index with the actual cache (e.g. if the browser evicted storage)
  try { const c = await caches.open(MEDIA_CACHE); const keys = new Set((await c.keys()).map((r) => r.url));
    for (const url of Object.keys(S.media)) if (!keys.has(url)) delete S.media[url]; save(); } catch (_) {}
  updateOnline(false); updateTimer();
  if (!S.topics.length) await onboard();
  await buildFeed();
  $('#bootSkel')?.remove();
  window.__lumen = { state: () => S, feed: () => feedItems, buildFeed, download, byId: () => byId, updateTimer, refresh: refreshContent, sound: () => soundOn, yt: () => ytPlayers, ytLog: () => ytLog, ytApiFailed: () => ytApiFailed, version: APP_VERSION, pool: () => vpool, vlog: () => vlog, strict: () => autoplayStrict, applyUpdate, checkUpdate, seenLoad, appendBatch, fresh: () => CAT.items.filter((i) => i.fresh) };
  setTimeout(() => refreshContent(), 2000);
}
boot();
})();
