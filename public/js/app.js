import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { renderMeme, mountEditor } from './meme.js';
import { memeImage, shareTo } from './share.js';

const params = new URLSearchParams(location.search);
const useMock = params.has('demo') || !SUPABASE_URL || !SUPABASE_ANON_KEY;
const { api } = await import(useMock ? './api-mock.js' : './api-supabase.js');

const $app = document.getElementById('app');
const SLOTS = ['tl', 'tr', 'bl', 'br'];   // coins de l'écran, dans l'ordre d'arrivée des joueurs
const ERRORS = {
  ROOM_NOT_FOUND: 'Séance introuvable. Vérifie le code.', ROOM_FULL: 'Séance complète (4 joueurs max).',
  NO_TEMPLATES: 'Aucune image en base.', HOST_ONLY: "Seul l'hôte peut faire ça.",
  TOO_LATE: 'Trop tard, le chrono est écoulé !', OWN_MEME: 'Voter pour soi-même ? Même à l\'Assemblée ça passe pas.',
  NO_REROLL: 'Plus de changement d\'image pour cette manche.', TOO_MANY_UPLOADS: "Trop d'images uploadées dans cette séance.",
};
const WIN_LINES = [
  "Ton mème est adopté sans vote. L'opposition dépose une motion de censure. Rejetée.",
  'Le Conseil constitutionnel a validé. Aucune réserve.',
  'Élu·e au premier tour. Avec 49,3 % des voix.',
  'Tu entres au gouvernement. Durée de vie estimée : trois semaines.',
  'Manuel Valls envisage déjà de rejoindre ta liste.',
  'Promulgué au Journal officiel. Tes potes, eux, déposent un recours.',
  "Ovation debout dans l'hémicycle. Même le perchoir a applaudi.",
  'Le Sénat a voté pour. Personne ne l\'a vu venir.',
];

// Grades du profil (points cumulés). Barème : mème présenté +1 · vote reçu +2 · manche gagnée +5 · partie gagnée +10
const GRADES = [[0, 'Militant·e de base'], [20, 'Attaché·e parlementaire'], [60, 'Député·e'], [150, 'Ministre'],
                [300, 'Premier·e ministre'], [600, 'Président·e de la République']];
const grade = (pts) => GRADES.filter(([min]) => pts >= min).pop()[1];
const nextGrade = (pts) => GRADES.find(([min]) => min > pts);

let S = null;            // dernier état serveur
let shareFile = null, shareKey = '';   // image du mème lauréat, préparée à l'avance (le partage doit partir du clic)
let session = load();    // { room, code, name }
let viewKey = '', editor = null, editing = false, offset = 0, lastTick = 0, autosaved = '', unsub = null, cornersHtml = '';

// ---------- utilitaires ----------
function load() { try { return JSON.parse(localStorage.getItem('49meme')) || {}; } catch { return {}; } }
function save() { try { localStorage.setItem('49meme', JSON.stringify(session)); } catch {} }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isHost = () => S.room.host_id === S.me;
const serverNow = () => Date.now() + offset;
const src = (t) => api.mediaUrl(t);
const initials = (n) => n.trim().split(/[\s-]+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const hash = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
async function act(fn) {
  try { return await fn(); }
  catch (e) {
    const code = Object.keys(ERRORS).find((k) => e.message.includes(k));
    toast(code ? ERRORS[code] : e.message);
    console.error(e);
  }
}

// ---------- cycle de vie ----------
async function boot() {
  const desktop = !matchMedia('(pointer: coarse)').matches && innerWidth > 900;
  if (desktop && !params.has('desktop') && !sessionStorage.getItem('desktop-ok')) return renderDesktopGate();

  try { await api.init(); } catch (e) { $app.innerHTML = `<div class="center-msg"><h2>Oups</h2><p>${esc(e.message)}</p></div>`; return; }

  if (session.room && api.mode === 'supabase') {
    try { await enterRoom(session.room); return; } catch { session.room = null; save(); }
  }
  renderHome();
}

async function enterRoom(room) {
  session.room = room; save();
  if (params.has('r') || params.has('go')) { params.delete('r'); params.delete('go'); history.replaceState(null, '', location.pathname + (params.size ? '?' + params : '')); }
  unsub?.();
  let t;
  unsub = api.subscribe(room, () => { clearTimeout(t); t = setTimeout(refresh, 60); });
  await refresh(true);
}

async function refresh(throwOnError = false) {
  if (!session.room) return;
  try {
    S = await api.state(session.room);
    offset = Date.parse(S.now) - Date.now();
    render();
  } catch (e) {
    if (throwOnError) throw e;
    console.warn(e);
  }
}

function leave() {
  if (session.room) api.leaveRoom(session.room).catch(() => {});
  unsub?.(); unsub = null; S = null; session.room = null; save(); viewKey = ''; cornersHtml = '';
  renderHome();
}

// filet de sécurité si le realtime décroche
setInterval(() => { if (session.room && S) refresh(); }, 4000);

// chrono + avancement automatique (n'importe quel joueur fait avancer la partie)
setInterval(paintTimer, 200);
function paintTimer() {
  if (!S || !S.room.phase_ends_at) return;
  const r = S.room, left = Date.parse(r.phase_ends_at) - serverNow();
  const total = (r.phase === 'lobby' ? 30 : r[`${r.phase}_seconds`] || 10) * 1000;
  const secs = Math.max(0, Math.ceil(left / 1000));
  const txt = `${two(Math.floor(secs / 60))}:${two(secs % 60)}`;
  document.querySelectorAll('[data-live=timer]').forEach((el) => { if (el.textContent !== txt) el.textContent = txt; });
  document.querySelectorAll('[data-live=ring]').forEach((el) => {
    el.style.setProperty('--p', Math.max(0, Math.min(1, left / total)));
    el.classList.toggle('urgent', r.phase === 'caption' && secs <= 10);
  });

  const key = `${r.phase}${r.round}.${r.vote_index}`;
  if (r.phase === 'caption' && left < 1500 && autosaved !== key && editor && !S.my_meme?.submitted) {
    autosaved = key;
    api.submit(session.room, editor.texts, false).catch(() => {});
  }
  const grace = r.phase === 'caption' ? -1500 : -300;
  if (left < grace && Date.now() - lastTick > 2500) {
    lastTick = Date.now();
    api.tick(session.room, r.phase, r.vote_index).then(() => refresh()).catch(() => {});
  }
}

// ---------- rendu ----------
function render() {
  const r = S.room;
  const key = [r.phase, r.round, r.vote_index, S.my_meme?.template?.id, S.my_meme?.submitted, editing, S.my_vote,
               S.players.length, S.pending_uploads, r.max_rounds, r.caption_seconds, isHost(), !!r.phase_ends_at].join('|');
  if (key !== viewKey) {
    viewKey = key;
    if (r.phase !== 'caption') { editor = null; editing = false; }
    ({ lobby: renderLobby, caption: renderCaption, showcase: renderShowcase, vote: renderVote,
       results: renderResults, podium: renderPodium })[r.phase]();
  }
  renderCorners();
  paintTimer();
  preloadRound();
  const done = S.players.filter((p) => p.submitted).length;
  document.querySelectorAll('[data-live=progress]').forEach((el) => (el.textContent = `${done}/${S.players.length} ont validé`));
}

// Les 4 ronds aux coins : présence (pulsation), réflexion (•••), validé (✓), +1 du lauréat.
function renderCorners() {
  const el = document.getElementById('corners');
  if (!el) return;
  const r = S.room;
  const winner = r.phase === 'results' ? S.memes?.find((m) => m.won)?.user_id : null;
  const html = SLOTS.map((slot, i) => {
    const p = S.players[i];
    if (!p) return `<div class="seat ${slot} empty"><div class="disc">+</div><span>libre</span></div>`;
    let state = 'present';
    if (r.phase === 'caption') state = p.submitted ? 'done' : 'thinking';
    if (r.phase === 'vote') state = p.voted ? 'done' : 'thinking';
    return `<div class="seat ${slot} c${i} ${state} ${p.user_id === S.me ? 'me' : ''} ${p.user_id === winner ? 'win' : ''}">
      <div class="disc">${esc(initials(p.name))}<b class="pts">${p.score}</b>
        ${state === 'thinking' ? '<i class="dots"><u></u><u></u><u></u></i>' : ''}
        ${state === 'done' ? '<i class="check">✓</i>' : ''}
        ${p.user_id === winner ? '<i class="plus">+1</i>' : ''}</div>
      <span>${esc(p.name)}${p.user_id === r.host_id ? ' 👑' : ''}</span></div>`;
  }).join('');
  if (html !== cornersHtml) { el.innerHTML = html; cornersHtml = html; }
}

// Gabarit commun à tous les écrans de jeu : fond à rayons, coins joueurs, haut / milieu / bas.
function stage(top, mid, bottom = '', cls = '') {
  cornersHtml = '';
  $app.innerHTML = `<div class="stage ${cls}">
    ${cls.includes('burst') ? BURST : '<div class="speed"></div>'}
    <div id="corners"></div>
    <button class="quit-btn" data-action="ask-quit">Quitter</button>
    <div class="top">${top}</div>
    <div class="mid">${mid}</div>
    <div class="bottom">${bottom}</div>
  </div>`;
}

// En-tête façon maquette : « ROUND 02 / 05 » + minuteur rond qui se vide
const two = (n) => String(n).padStart(2, '0');
const roundTitle = () => `ROUND <b>${two(S.room.round)}</b> / ${two(S.room.max_rounds)}`;
const chrono = (title, sub = '') => `<div class="roundbar">
  <div class="rb-title">${title}${sub ? `<small>${sub}</small>` : ''}</div>
  <div class="ring" data-live="ring"><span data-live="timer"></span></div></div>`;
// Fond « fin de partie » : demi-cercle rouge + trois petits traits
const BURST = `<div class="burst-bg" aria-hidden="true"><i class="half"></i><i class="sliver"></i>
  <svg class="strokes" viewBox="0 0 60 60"><path d="M10 30 L22 22 M14 44 L30 40 M30 12 L36 26" /></svg></div>`;

function renderDesktopGate() {
  $app.innerHTML = `<div class="center-msg">
    <div class="logo big">49<span>.MÈME</span></div>
    <p class="tag">Ça se joue sur téléphone.</p>
    <p class="muted">Ouvre <b>${esc(location.host || 'ce lien')}</b> sur ton mobile.</p>
    <button class="ghost" id="force">Continuer quand même (dev)</button></div>`;
  document.getElementById('force').onclick = () => { sessionStorage.setItem('desktop-ok', '1'); boot(); };
}

// ---------- accueil : polaroïds éparpillés ----------
async function renderHome() {
  if (params.get('r')) return renderPlay('join');   // lien d'invitation → directement « rejoindre »
  if (params.has('go')) return renderPlay('quick');  // lien du QR code → directement « jouer direct »
  $app.innerHTML = `<div class="home">
    <div class="pile" aria-hidden="true"></div>
    <div class="home-ui">
      <div class="logo big">49<span>.MÈME</span></div>
      <p class="tag">Le jeu de mèmes de la présidentielle</p>
      <button class="primary cta" data-action="play">JOUER</button>
      <p class="hint">4 joueurs · 1 code · 0 débat</p>
      <button class="profile-chip" data-action="profile" hidden></button>
    </div>
    <div class="sheet profile-sheet" hidden><div class="sheet-card"></div></div>
  </div>`;
  api.myProfile().then(renderProfile).catch(() => {});

  const items = await api.librarySample(14).catch(() => []);
  const pile = $app.querySelector('.pile');
  if (!pile) return;
  items.forEach((t, i) => {
    const card = document.createElement('div');
    card.className = 'polaroid';
    const h = hash(t.id + i);
    // grille 3 colonnes x 5 rangées + jitter : couvre l'écran en se chevauchant
    const col = i % 3, row = Math.floor(i / 3);
    card.style.left = `${col * 33 - 6 + (h % 14)}%`;
    card.style.top = `${row * 19 - 4 + ((h >> 4) % 8)}%`;
    card.style.setProperty('--rot', `${((h >> 8) % 44) - 22}deg`);
    card.style.animationDelay = `${i * 60}ms`;
    card.appendChild(renderMeme(src(t), t, []));
    pile.appendChild(card);
  });
}

// Barre du haut des pages « Play » et « How it works » (maquette)
const pageNav = (active) => `<header class="pp-nav">
  <button class="logo pp-logo" data-action="home">49<span>.MÈME</span></button>
  <nav><button class="${active === 'play' ? 'pill' : 'navlink'}" data-action="play">PLAY</button><span>/</span>
  <button class="${active === 'how' ? 'pill' : 'navlink'}" data-action="how">RÈGLES</button><span>/</span>
  <button class="${active === 'top' ? 'pill' : 'navlink'}" data-action="top">TOP MÈMES</button></nav></header>`;

// Exemples de la maquette pour la vitrine de la page Play
const DEMO_LINES = ['QUAND TU EXPLIQUES POUR LA 10E FOIS LE MÊME TRUC', 'QUAND QUELQU\'UN DIT UNE ÉNORMITÉ EN SOIRÉE'];

// ---------- 2e page : « BUILD A MEME. DROP A BANGER. » ----------
async function renderPlay(sheet = null) {
  const code = (params.get('r') || '').toUpperCase();
  $app.innerHTML = `<div class="play-page">
    ${pageNav('play')}
    <h1 class="pp-title">BUILD A MEME.<br><span>DROP A BANGER.</span></h1>
    <p class="pp-sub">Tes potes. Tes légendes. Zéro dignité.</p>
    <div class="pp-cta">
      <button class="btn-yellow" data-action="ask-quick">⚡ JOUER DIRECT <i>→</i></button>
      <button class="btn-white" data-action="ask-create">🔒 JOUER EN PRIVÉ <i>→</i></button>
      <button class="btn-white" data-action="ask-join">REJOINDRE UN LOBBY <i>→</i></button>
    </div>
    <p class="pp-multi"><b>⚡</b> DIRECT : ÉQUIPE DE 4 AUTO · <b>🔒</b> PRIVÉ : TU PARTAGES TON CODE</p>
    <div class="pp-show">${BURST}<div class="pp-cards"></div></div>
    <div class="sheet entry-sheet" hidden>
      <div class="sheet-card">
        <button class="back" data-action="close-sheet">← Retour</button>
        <h3 class="sheet-title"></h3>
        <label class="field"><span>Ton blaze</span>
          <input id="name" maxlength="20" placeholder="Ex : Jean-Michel Hémicycle" value="${esc(session.name || '')}" autocomplete="nickname"></label>
        <label class="field join-only"><span>Code du lobby</span>
          <input id="code" maxlength="4" placeholder="ABCD" value="${esc(code)}" autocapitalize="characters" autocomplete="off"></label>
        <button class="btn-yellow wide create-only" data-action="create">C'EST PARTI <i>→</i></button>
        <button class="btn-yellow wide quick-only" data-action="quick">TROUVER UNE ÉQUIPE <i>→</i></button>
        <button class="btn-yellow wide join-only" data-action="join">REJOINDRE <i>→</i></button>
        ${api.mode === 'mock' ? '<p class="badge">MODE LOCAL · 3 bots · rien n\'est envoyé</p>' : ''}
      </div>
    </div>
  </div>`;
  if (sheet) openEntry(sheet);
  const items = await api.librarySample(2).catch(() => []);
  const box = $app.querySelector('.pp-cards');
  if (!box) return;
  items.forEach((t, i) => {
    const card = document.createElement('div');
    card.className = `pp-card c${i}`;
    card.appendChild(renderMeme(src(t), t, [{ t: DEMO_LINES[i], x: .5, y: i ? .97 : .03, s: .085 }]));
    box.appendChild(card);
  });
}

// ---------- page « Top mèmes » : les mèmes adoptés à l'unanimité ----------
let topOffset = 0;
function renderTop() {
  topOffset = 0;
  $app.innerHTML = `<div class="play-page top-page">
    ${pageNav('top')}
    <h1 class="pp-title small">TOP<br><span>MÈMES.</span></h1>
    <p class="pp-sub">Adoptés à l'unanimité : 100 % des votes de leur manche.</p>
    <div class="top-list"></div>
    <button class="btn-white wide" data-action="top-more" hidden>VOIR PLUS <i>↓</i></button>
  </div>`;
  loadTop();
}

async function loadTop() {
  const list = $app.querySelector('.top-list');
  if (!list) return;
  const items = await api.topMemes(20, topOffset).catch(() => []);
  if (!topOffset && !items.length) {
    list.innerHTML = `<div class="how-step center"><h2 class="sheet-title">Personne n'a encore fait l'unanimité.</h2>
      <p>Gagne une manche avec toutes les voix (3 joueurs minimum) et ton mème entre ici.</p></div>`;
  }
  items.forEach((m, i) => {
    const card = document.createElement('article');
    card.className = 'top-card';
    const rank = topOffset + i + 1;
    card.innerHTML = `<div class="top-head"><b>#${rank}</b><span>par <strong>${esc(m.author)}</strong></span>
      <em>${m.votes} votes · UNANIME</em></div><div class="top-meme"></div>
      <div class="top-foot"><small>${new Date(m.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}</small>
      <button class="link" data-action="top-report" data-id="${m.id}">🚩 Signaler</button></div>`;
    card.querySelector('.top-meme').appendChild(renderMeme(src(m.template), m.template, m.texts));
    list.appendChild(card);
  });
  topOffset += items.length;
  const more = $app.querySelector('[data-action=top-more]');
  if (more) more.hidden = items.length < 20;
}

// ---------- quitter la partie : confirmation Oui / Non ----------
function askQuit() {
  const d = document.createElement('div');
  d.className = 'modal';
  d.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="mq">
    <h3 id="mq">Quitter la partie ?</h3>
    <p class="muted">Ton coin sera libéré${S && isHost() ? ' et un autre joueur deviendra hôte' : ''}.</p>
    <div class="modal-actions"><button class="btn-white" data-q="no">NON</button><button class="btn-yellow" data-q="yes">OUI, QUITTER</button></div></div>`;
  d.addEventListener('click', (e) => {
    const q = e.target.closest('[data-q]')?.dataset.q;
    if (e.target === d || q === 'no') d.remove();
    if (q === 'yes') { d.remove(); leave(); }
  });
  document.body.appendChild(d);
}

// Feuille « créer » ou « rejoindre » — sans ouvrir le clavier tout seul
function openEntry(mode) {
  const sh = $app.querySelector('.entry-sheet');
  sh.dataset.mode = mode;
  sh.querySelector('.sheet-title').textContent = { join: 'Rejoins un lobby', create: 'Jouer en privé', quick: 'Jouer direct' }[mode];
  sh.hidden = false;
}

// ---------- page « How it works » ----------
function renderHow() {
  const steps = [
    ['01', 'Direct ou en privé', 'Jouer direct : tu es placé dans une équipe de 4 et la partie démarre toute seule. Jouer en privé : tu reçois un code de 4 lettres à envoyer à 3 potes.', null],
    ['02', 'Une image. Ta meilleure légende.', 'Chacun reçoit une image ou un GIF de la campagne. Écris la légende la plus drôle avant la fin du chrono. Pas inspiré ? Change d\'image, 5 fois max.', 'img/how-round.jpg'],
    ['03', 'Le niveau du lobby', 'Tous les mèmes défilent en même temps sur chaque écran, 10 secondes chacun. Puis tout le monde vote pour son préféré. Pas pour le sien.', 'img/how-lobby.jpg'],
    ['04', 'Adopté sans vote', 'Le lauréat gagne la manche et des points de profil. Partage-le sur Insta, WhatsApp ou X et fais monter ton grade, de militant·e à président·e.', 'img/how-adopte.jpg'],
  ];
  $app.innerHTML = `<div class="play-page how-page">
    ${pageNav('how')}
    <h1 class="pp-title small">LES<br><span>RÈGLES.</span></h1>
    ${steps.map(([n, t, d, img]) => `<section class="how-step">
      <div class="how-head"><b>${n}</b><h2>${t}</h2></div>
      <p>${d}</p>${img ? `<img src="${img}" alt="" loading="lazy">` : ''}</section>`).join('')}
    <button class="btn-yellow wide" data-action="ask-create-from-how">CRÉER UNE PARTIE <i>→</i></button>
  </div>`;
}

function renderProfile(p) {
  const chip = $app.querySelector('.profile-chip');
  if (!chip) return;
  chip.hidden = false;
  chip.innerHTML = `🏛️ <b>${p.points} pts</b> · ${grade(p.points)}`;
  const nx = nextGrade(p.points);
  $app.querySelector('.profile-sheet .sheet-card').innerHTML = `
    <h3>${esc(session.name || 'Ton profil')}</h3>
    <div class="grade"><b>${grade(p.points)}</b><span>${p.points} points${nx ? ` · encore ${nx[0] - p.points} pour devenir ${nx[1]}` : ''}</span></div>
    <div class="stats">
      <div><b>${p.games}</b><span>parties</span></div><div><b>${p.games_won}</b><span>gagnées</span></div>
      <div><b>${p.rounds_won}</b><span>manches</span></div><div><b>${p.votes_received}</b><span>votes reçus</span></div>
    </div>
    <h3>Barème</h3>
    <ul class="bareme">
      <li><span>Mème présenté au vote</span><b>+1</b></li>
      <li><span>Chaque vote reçu</span><b>+2</b></li>
      <li><span>Manche gagnée</span><b>+5</b></li>
      <li><span>Partie gagnée</span><b>+10</b></li>
    </ul>`;
}

// ---------- lobby ----------
function renderLobby() {
  if (S.room.is_public) return renderQuickLobby();
  const link = `${location.origin}${location.pathname}?r=${S.room.code}`;
  stage(
    `<button class="code-big" data-action="share" data-link="${esc(link)}"><small>CODE DE LA SÉANCE</small><b>${S.room.code}</b><small>tape pour partager</small></button>`,
    `<div class="panel">
      <h3>Séance privée</h3>
      <p class="muted">Envoie le code à tes potes. 4 joueurs max, un par coin de l'écran.</p>
      ${isHost() ? `<div class="settings">
        <label>Manches <select data-set="rounds">${[1, 3, 5, 7, 10].map((n) => `<option ${n === S.room.max_rounds ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label>Chrono <select data-set="secs">${[10, 20, 30, 40, 60, 90].map((n) => `<option value="${n}" ${n === S.room.caption_seconds ? 'selected' : ''}>${n < 60 ? n + ' s' : n === 60 ? '1 min' : '1 min 30'}</option>`).join('')}</select></label>
      </div>` : ''}
      ${uploadBlock()}
    </div>`,
    (isHost()
      ? `<button class="primary" data-action="next">LANCER LA SÉANCE</button>`
      : `<p class="wait">L'hôte prépare le 49.3…</p>`)
      + `<button class="link" data-action="leave-now">← Quitter la séance</button>`,
  );
}

// Équipe « jouer direct » : on attend des joueurs, la partie part toute seule
function renderQuickLobby() {
  const n = S.players.length, ticking = !!S.room.phase_ends_at;
  stage(ticking ? chrono('ÉQUIPE <b>PRÊTE</b>', 'DÉPART DANS') : `<div class="roundbar"><div class="rb-title">RECHERCHE <b>D'ÉQUIPE</b></div></div>`,
    `<div class="panel center">
      <h3>${n}/4 joueurs</h3>
      <p class="muted">${n >= 4 ? 'Équipe complète, c\'est parti !' : n >= 2 ? 'La partie démarre à 4 joueurs, ou à la fin du compte à rebours.' : 'On te trouve des adversaires… La partie démarre dès qu\'un 2e joueur arrive (30 s d\'attente max).'}</p>
      <p class="muted small">3 manches · 40 s pour légender</p>
    </div>`,
    (isHost() && n >= 2 ? `<button class="primary" data-action="next">LANCER MAINTENANT</button>` : `<p class="wait">Matchmaking en cours…</p>`)
      + `<button class="link" data-action="leave-now">← Quitter</button>`);
}

function uploadBlock() {
  return `<label class="upload">📷 Ajouter mes images / GIF
      <input type="file" accept="image/*,video/mp4,video/webm,video/quicktime" multiple hidden data-action="upload"></label>
    ${S.pending_uploads ? `<p class="muted small">${S.pending_uploads} image(s) perso → tirées en priorité à la prochaine manche</p>` : ''}`;
}

// ---------- légende ----------
function renderCaption() {
  const m = S.my_meme, r = S.room;
  const top = chrono(roundTitle());
  if (!m) return stage(top, `<div class="panel"><h3>Tu arrives en pleine séance</h3><p class="muted">Tu joueras à la prochaine manche.</p></div>`);
  if (m.submitted && !editing) {
    editor = null;
    stage(top, `<div class="card"><div class="meme-wrap stamped" data-stamp="ADOPTÉ"></div></div>
      <p class="wait" data-live="progress"></p>`,
      `<button class="ghost" data-action="edit">✏️ Modifier</button>`);
    $app.querySelector('.meme-wrap').appendChild(renderMeme(src(m.template), m.template, m.texts));
    return;
  }
  stage(top, `<div class="card"><div class="editor"></div></div>`,
    `<button class="primary" data-action="submit">VALIDER ✓</button>`);
  const tools = m.rerolls_left > 0 ? `<button data-action="reroll" class="reroll">🎲 ${m.rerolls_left}</button>` : '';
  editor = mountEditor($app.querySelector('.editor'), src(m.template), m.template, m.texts, null, tools);
}

// ---------- défilé synchronisé ----------
function renderShowcase() {
  const r = S.room, list = S.memes, cur = list[r.vote_index];
  stage(chrono(`MÈME <b>${two(r.vote_index + 1)}</b> / ${two(list.length)}`, roundTitle().replace(/<\/?b>/g, '')),
    `<div class="card show-in"><div class="meme-wrap"></div></div>
     <div class="progress">${list.map((_, i) => `<i class="${i <= r.vote_index ? 'on' : ''}"></i>`).join('')}</div>`,
    `<p class="wait">${cur.mine ? 'C\'est le tien. Fais pas cette tête.' : 'Prépare ton vote…'}</p>`, 'showcase');
  $app.querySelector('.meme-wrap').appendChild(renderMeme(src(cur.template), cur.template, cur.texts));
}

// ---------- vote : tous les mèmes empilés ----------
function renderVote() {
  stage(chrono(roundTitle(), 'VOTE POUR TON PRÉFÉRÉ'),
    `<div class="vote-list">${S.memes.map((m, i) => `
      <div class="card vote-card ${S.my_vote === m.id ? 'chosen' : ''}">
        <div class="meme-wrap ${S.my_vote === m.id ? 'stamped' : ''}" data-stamp="ADOPTÉ" data-i="${i}"></div>
        ${m.mine ? '<button class="ghost" disabled>C\'est ton mème</button>'
                 : `<button class="vote-btn ${S.my_vote === m.id ? 'on' : ''}" data-vote="${m.id}">${S.my_vote === m.id ? 'VOTÉ ✓' : 'VOTER'}</button>`}
      </div>`).join('')}</div>`,
    `<p class="wait">${S.my_vote ? 'A voté ! Tu peux encore changer d\'avis.' : 'Un seul vote. Pas de 49.3 ici.'}</p>`);
  $app.querySelectorAll('.meme-wrap[data-i]').forEach((w) => {
    const m = S.memes[+w.dataset.i];
    w.appendChild(renderMeme(src(m.template), m.template, m.texts));
  });
}

// ---------- lauréat ----------
function renderResults() {
  const r = S.room, w = S.memes?.find((m) => m.won);
  const last = r.round >= r.max_rounds;
  const line = WIN_LINES[hash(`${r.code}${r.round}`) % WIN_LINES.length];
  const others = (S.memes || []).filter((m) => !m.won);
  stage(chrono(roundTitle(), last ? 'PODIUM DANS' : 'MANCHE SUIVANTE DANS'),
    w ? `<div class="laureat">
        <h1 class="bravo">FÉLICITATIONS</h1>
        <p class="who">${esc(w.author)}${w.mine ? ' (toi !)' : ''}</p>
        <p class="line">${esc(line)}</p>
        <div class="card"><div class="meme-wrap stamped big-stamp" data-stamp="ADOPTÉ" data-w></div></div>
        <p class="muted small center">${w.votes} vote${w.votes > 1 ? 's' : ''} · +1 manche</p>
        ${shareRow()}
      </div>
      ${myGain()}
      ${others.length ? `<div class="others">${others.map((m, i) => `<div class="mini"><div class="meme-wrap" data-o="${i}"></div><span>${esc(m.author)} · ${m.votes}</span></div>`).join('')}</div>` : ''}`
      : `<div class="laureat"><h1 class="bravo">MOTION REJETÉE</h1><p class="line">Personne n'a voté. L'abstention gagne encore.</p></div>`,
    `<button class="link" data-action="report-open" ${w ? '' : 'hidden'}>🚩 Signaler</button>`, 'results burst');
  if (w) { $app.querySelector('[data-w]').appendChild(renderMeme(src(w.template), w.template, w.texts)); prepareShare(w); }
  $app.querySelectorAll('[data-o]').forEach((el) => { const m = others[+el.dataset.o]; el.appendChild(renderMeme(src(m.template), m.template, m.texts)); });
  $app.querySelector('[data-action=report-open]')?.setAttribute('data-id', w?.id || '');
}

// ---------- fin de partie ----------
function renderPodium() {
  const ranked = [...S.players].sort((a, b) => b.score - a.score);
  const medals = ['🥇', '🥈', '🥉', '4'];
  stage(`<div class="roundbar"><div class="rb-title">FIN DE LA <b>LÉGISLATURE</b></div></div>`,
    `<div class="panel">
      <ol class="ranking">${ranked.map((p, i) => `<li><span>${medals[i]}</span><b>${esc(p.name)}</b><em>${p.score} pt${p.score > 1 ? 's' : ''}</em></li>`).join('')}</ol>
    </div>
    ${S.memes?.length ? `${shareRow('Partager le meilleur mème')}<h3 class="center">Les lois adoptées</h3><div class="vote-list">${S.memes.map((m, i) => `
      <div class="card"><div class="meme-wrap" data-p="${i}"></div><p class="muted small center">Manche ${m.round} · ${esc(m.author)}</p></div>`).join('')}</div>` : ''}
    <div class="panel">${uploadBlock()}</div>`,
    isHost()
      ? `<button class="primary" data-action="next">REJOUER</button><button class="link" data-action="lobby">Changer les réglages</button>`
      : `<p class="wait">En attente de l'hôte…</p><button class="link" data-action="leave-now">← Quitter</button>`, 'burst');
  $app.querySelectorAll('[data-p]').forEach((el) => { const m = S.memes[+el.dataset.p]; el.appendChild(renderMeme(src(m.template), m.template, m.texts)); });
  const best = [...(S.memes || [])].sort((a, b) => b.votes - a.votes)[0];
  if (best) prepareShare(best);
}

function shareRow(label = 'Partager le mème') {
  return `<div class="share"><small>${label}</small><div class="share-row">
    <button class="sh insta" data-action="share-net" data-net="insta">Insta</button>
    <button class="sh wa" data-action="share-net" data-net="whatsapp">WhatsApp</button>
    <button class="sh x" data-action="share-net" data-net="x">X</button></div></div>`;
}

function prepareShare(m) {
  if (shareKey === m.id) return;
  shareKey = m.id; shareFile = null;
  memeImage(src(m.template), m.template, m.texts).then((f) => { if (shareKey === m.id) shareFile = f; }).catch(console.warn);
}

// points de profil gagnés cette manche (même barème que le serveur)
function myGain() {
  const mine = S.memes?.find((m) => m.mine);
  if (!mine) return '';
  const pts = 1 + 2 * mine.votes + (mine.won ? 5 : 0);
  return `<p class="gain">+${pts} pts sur ton profil</p>`;
}

// Précharge tous les mèmes de la manche dès le défilé : sur mobile, 3 s ne suffisent pas à charger un GIF.
const preloaded = new Map();
function preloadRound() {
  if (!['showcase', 'vote', 'results'].includes(S.room.phase)) return;
  for (const m of S.memes || []) {
    const url = src(m.template);
    if (preloaded.has(url)) continue;
    let el;
    if (m.template.kind === 'video') {
      el = document.createElement('video');
      el.muted = true; el.playsInline = true; el.preload = 'auto'; el.src = url; el.load();
    } else { el = new Image(); el.src = url; }
    preloaded.set(url, el);   // garder une référence évite que le navigateur abandonne le chargement
  }
  if (preloaded.size > 40) preloaded.delete(preloaded.keys().next().value);
}

// Clavier mobile : on cale l'appli sur la zone visible pour que le chrono et VALIDER restent à l'écran.
function fitViewport() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : innerHeight;
  document.documentElement.style.setProperty('--app-h', h + 'px');
  document.body.classList.toggle('kb', vv ? vv.height < innerHeight * 0.75 : false);
  if (vv && vv.offsetTop) window.scrollTo(0, 0);
}
window.visualViewport?.addEventListener('resize', fitViewport);
window.visualViewport?.addEventListener('scroll', fitViewport);
addEventListener('resize', fitViewport);
fitViewport();

// iPhone en mode économie d'énergie : la lecture auto des vidéos est bloquée → on la relance au premier toucher
document.addEventListener('pointerdown', () => {
  document.querySelectorAll('.meme video').forEach((v) => { if (v.paused) v.play().catch(() => {}); });
}, { passive: true });

// ---------- actions (délégation d'événements) ----------
$app.addEventListener('click', (e) => {
  const b = e.target.closest('[data-action],[data-vote]');
  if (!b) return;
  const room = session.room;
  if (b.dataset.vote) {
    navigator.vibrate?.(25);
    return act(() => api.vote(room, b.dataset.vote));
  }
  switch (b.dataset.action) {
    case 'close-sheet': b.closest('.sheet').hidden = true; break;
    case 'leave-now': leave(); break;
    case 'lobby': act(() => api.backToLobby(room)); break;
    case 'home': renderHome(); break;
    case 'play': renderPlay(); break;
    case 'how': renderHow(); break;
    case 'top': renderTop(); break;
    case 'top-more': loadTop(); break;
    case 'top-report':
      act(async () => { await api.reportTop(b.dataset.id); b.closest('.top-card').remove(); toast('Signalé : le mème est retiré.'); });
      break;
    case 'ask-quit': askQuit(); break;
    case 'ask-create': openEntry('create'); break;
    case 'ask-join': openEntry('join'); break;
    case 'ask-create-from-how': renderPlay('create'); break;
    case 'profile': $app.querySelector('.profile-sheet').hidden = false; break;
    case 'share-net': shareTo(b.dataset.net, shareFile, toast); break;
    case 'quick': return act(async () => {
      const n = getName(); if (!n) return;
      const res = await api.quickJoin(n);
      session.code = res.code; await enterRoom(res.room_id);
    });
    case 'ask-quick': openEntry('quick'); break;
    case 'create': return act(async () => {
      const n = getName(); if (!n) return;
      const res = await api.createRoom(n);
      session.code = res.code; await enterRoom(res.room_id);
    });
    case 'join': return act(async () => {
      const n = getName(); if (!n) return;
      const c = $app.querySelector('#code').value.trim().toUpperCase();
      if (c.length !== 4) return toast('Le code fait 4 lettres.');
      const res = await api.joinRoom(c, n);
      session.code = res.code; await enterRoom(res.room_id);
    });

    case 'next': act(() => api.hostNext(room)); break;
    case 'reroll': act(() => api.reroll(room)); break;
    case 'edit': editing = true; render(); break;
    case 'submit': {
      const texts = editor.texts;
      if (!texts.some((t) => t.t.trim())) return toast('Écris au moins un texte !');
      editing = false;
      act(() => api.submit(room, texts, true));
      break;
    }
    case 'report-open':
      if (confirm('Signaler ce contenu (haine, harcèlement, contenu illégal) ?'))
        act(async () => { await api.report(room, b.dataset.id); toast('Signalement envoyé. Merci.'); });
      break;
    case 'share': {
      const url = b.dataset.link;
      if (navigator.share) navigator.share({ title: '49.meme', text: `Rejoins ma séance 49.meme : code ${S.room.code}`, url }).catch(() => {});
      else navigator.clipboard?.writeText(url).then(() => toast('Lien copié !'));
      break;
    }
  }
});
// fermer la feuille d'entrée en touchant le fond
$app.addEventListener('pointerdown', (e) => { if (e.target.classList.contains('sheet')) e.target.hidden = true; });

function getName() {
  const n = $app.querySelector('#name').value.trim();
  if (!n) { toast('Il te faut un blaze !'); return null; }
  session.name = n; save(); return n;
}

$app.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.set) {
    const rounds = +$app.querySelector('[data-set=rounds]').value;
    const secs = +$app.querySelector('[data-set=secs]').value;
    act(() => api.updateSettings(session.room, rounds, secs));
  }
  if (el.dataset.action === 'upload') act(() => uploadFiles([...el.files].slice(0, 5)));
});

// Images : redimensionnées côté client (max 1280px, JPEG). GIF et vidéos envoyés tels quels (max 5 Mo).
async function uploadFiles(files) {
  for (const f of files) {
    const kind = f.type === 'image/gif' ? 'gif' : f.type.startsWith('video/') ? 'video' : 'image';
    if (kind !== 'image' && f.size > 5 * 1024 * 1024) { toast(`${f.name} : trop lourd (5 Mo max)`); continue; }
    if (kind === 'video') { await api.upload(session.room, f, kind, null, null); continue; }
    const img = await new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = ko; i.src = URL.createObjectURL(f); });
    let blob = f, w = img.naturalWidth, h = img.naturalHeight;
    if (kind === 'image') {
      const k = Math.min(1, 1280 / Math.max(w, h));
      w = Math.round(w * k); h = Math.round(h * k);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      blob = new File([await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.85))], 'upload.jpg', { type: 'image/jpeg' });
    }
    await api.upload(session.room, blob, kind, w, h);
  }
  toast('Ajouté à la prochaine manche ✓');
}

boot();
