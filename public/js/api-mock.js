// Mode DÉMO : même interface que api-supabase.js, logique de jeu simulée en mémoire + 3 bots.
// Utilise la vraie bibliothèque locale (public/library/index.json).
// La logique de référence est dans supabase/migrations/0001_init.sql : garder les deux alignés.

const BOTS = ['Jean-Luc', 'Marine', 'Gabriel'];
const BOT_LINES = [
  'QUAND TU VOIS TA RETRAITE', 'MOI APRÈS LE 49.3', 'LE PEUPLE : NON', 'ADOPTÉ SANS VOTE',
  'JE NE DÉMISSIONNERAI PAS', 'LE BUDGET 2027', 'EN MÊME TEMPS', 'MOTION DE CENSURE EN COURS',
  'QUAND LE PRÉFET DIT NON', 'MOI DEVANT MA FEUILLE D\'IMPÔTS',
];
const ZONES = [{ x: .5, y: .03, s: .09 }, { x: .5, y: .97, s: .09 }];
const T = { showcase: 10, vote: 25, results: 12 };

// Profil local (le vrai est en base, table profiles). Barème identique au SQL.
const PROFILE_KEY = '49meme-profile';
const blankProfile = { points: 0, games: 0, games_won: 0, rounds_won: 0, memes: 0, votes_received: 0 };
function loadProfile() { try { return { ...blankProfile, ...JSON.parse(localStorage.getItem(PROFILE_KEY)) }; } catch { return { ...blankProfile }; } }
function award(delta) {
  const p = loadProfile();
  for (const k in delta) p[k] = (p[k] || 0) + delta[k];
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch {}
}

const ME = 'me-' + Math.random().toString(36).slice(2, 8);
let templates = [];
let room = null, players = [], memes = [], votes = [], listeners = new Set();
const now = () => Date.now();
const rnd = (a) => a[Math.floor(Math.random() * a.length)];
const later = (ms, fn) => setTimeout(fn, ms);
const tplJson = (t) => ({ id: t.id, path: null, url: t.url, kind: t.kind, w: t.w, h: t.h, zones: t.zones });

function bump() { room.version++; listeners.forEach((f) => f()); }
const roundMemes = () => memes.filter((m) => m.round === room.round);
const shown = () => roundMemes().filter((m) => m.vote_order != null).sort((a, b) => a.vote_order - b.vote_order);

function pickTemplate() {
  const fresh = templates.filter((t) => !room.seen.includes(t.id)).sort((a, b) => (b.room - a.room) || Math.random() - .5);
  const t = fresh[0] || rnd(templates);
  room.seen.push(t.id);
  return t;
}

function resetGame() {
  memes = []; votes = [];
  players.forEach((p) => (p.score = 0));
  Object.assign(room, { phase: 'lobby', round: 0, vote_index: 0, phase_ends_at: null });
}

function startRound() {
  Object.assign(room, { phase: 'caption', round: room.round + 1, vote_index: 0, phase_ends_at: now() + room.caption_seconds * 1000 });
  players.forEach((p) => memes.push({ id: Math.random().toString(36).slice(2) + Date.now().toString(36), round: room.round, player: p.user_id, template: pickTemplate(),
    texts: [], submitted_at: null, rerolls: 0, vote_order: null, votes: 0, won: false }));
  botsCaption();
}

function advance() {
  const r = room;
  if (r.phase === 'caption') {
    const ok = roundMemes().filter((m) => m.texts.some((t) => t.t.trim())).sort(() => Math.random() - .5);
    ok.forEach((m, i) => (m.vote_order = i));
    if (!ok.length) Object.assign(r, { phase: 'results', phase_ends_at: now() + T.results * 1000 });
    else Object.assign(r, { phase: 'showcase', vote_index: 0, phase_ends_at: now() + T.showcase * 1000 });
  } else if (r.phase === 'showcase') {
    if (r.vote_index + 1 < shown().length) { r.vote_index++; r.phase_ends_at = now() + T.showcase * 1000; }
    else { Object.assign(r, { phase: 'vote', phase_ends_at: now() + T.vote * 1000 }); botsVote(); }
  } else if (r.phase === 'vote') {
    roundMemes().forEach((m) => (m.votes = votes.filter((v) => v.meme === m.id).length));
    const w = shown().filter((m) => m.votes > 0)
      .sort((a, b) => b.votes - a.votes || (a.submitted_at ?? Infinity) - (b.submitted_at ?? Infinity))[0];
    if (w) { w.won = true; players.find((p) => p.user_id === w.player).score++; }
    const mine = shown().find((m) => m.player === ME);
    if (mine) award({ points: 1 + 2 * mine.votes + (mine.won ? 5 : 0), memes: 1, votes_received: mine.votes, rounds_won: +mine.won });
    Object.assign(r, { phase: 'results', phase_ends_at: now() + T.results * 1000 });
  } else if (r.phase === 'results') {
    if (r.round >= r.max_rounds) {
      Object.assign(r, { phase: 'podium', phase_ends_at: null });
      const mx = Math.max(...players.map((p) => p.score)), won = mx > 0 && players.find((p) => p.user_id === ME).score === mx;
      award({ points: won ? 10 : 0, games: 1, games_won: +won });
    }
    else startRound();
  }
  bump();
}

function botsCaption() {
  const r = room.round;
  players.filter((p) => p.bot).forEach((p) => later(4000 + Math.random() * 14000, () => {
    if (room.phase !== 'caption' || room.round !== r) return;
    const m = roundMemes().find((x) => x.player === p.user_id);
    m.texts = [{ t: rnd(BOT_LINES), x: .5, y: .03, s: .09 }, { t: Math.random() > .5 ? rnd(BOT_LINES) : '', x: .5, y: .97, s: .09 }];
    m.submitted_at = now(); allSubmitted(); bump();
  }));
}
function botsVote() {
  const r = room.round;
  players.filter((p) => p.bot).forEach((p) => later(2000 + Math.random() * 8000, () => {
    if (room.phase !== 'vote' || room.round !== r) return;
    const opts = shown().filter((m) => m.player !== p.user_id);
    if (opts.length) castVote(p.user_id, rnd(opts).id);
  }));
}
function allSubmitted() {
  if (roundMemes().every((m) => m.submitted_at)) room.phase_ends_at = Math.min(room.phase_ends_at, now() + 1000);
}
function castVote(voter, meme) {
  votes = votes.filter((v) => !(v.voter === voter && v.round === room.round));
  votes.push({ voter, meme, round: room.round });
  const needed = players.filter((p) => shown().some((m) => m.player !== p.user_id)).length;
  if (votes.filter((v) => v.round === room.round).length >= needed) room.phase_ends_at = Math.min(room.phase_ends_at, now() + 1000);
  bump();
}

export const api = {
  mode: 'mock',
  async init() {
    try {
      const list = await (await fetch('library/index.json')).json();
      templates = list.map((t, i) => ({ id: 'lib' + i, url: 'library/' + t.file, kind: t.kind, w: t.w, h: t.h, zones: ZONES, room: false }));
    } catch { templates = []; }
    if (!templates.length) throw new Error('Bibliothèque vide : public/library/index.json introuvable.');
  },
  mediaUrl: (t) => t.url,
  async myProfile() { return loadProfile(); },
  async librarySample(n = 14) { return [...templates].sort(() => Math.random() - .5).slice(0, n).map(tplJson); },

  async createRoom(name) {
    room = { id: 'demo', code: 'DEMO', host_id: ME, phase: 'lobby', round: 0, max_rounds: 5, caption_seconds: 30,
             showcase_seconds: T.showcase, vote_seconds: T.vote, results_seconds: T.results,
             vote_index: 0, phase_ends_at: null, version: 0, seen: [] };
    players = [{ user_id: ME, name, score: 0 }];
    memes = []; votes = [];
    BOTS.forEach((b, i) => later(900 * (i + 1), () => { players.push({ user_id: 'bot' + i, name: b, score: 0, bot: true }); bump(); }));
    return { room_id: room.id, code: room.code };
  },
  async joinRoom() { throw new Error('Mode démo : crée une séance (le multijoueur réel passe par Supabase).'); },

  async state() {
    const r = room, rm = roundMemes();
    const res = {
      me: ME, now: new Date().toISOString(),
      room: { ...r, seen: undefined, phase_ends_at: r.phase_ends_at && new Date(r.phase_ends_at).toISOString() },
      players: players.map((p) => ({ user_id: p.user_id, name: p.name, score: p.score,
        submitted: rm.some((m) => m.player === p.user_id && m.submitted_at),
        voted: votes.some((v) => v.voter === p.user_id && v.round === r.round) })),
      pending_uploads: templates.filter((t) => t.room && !r.seen.includes(t.id)).length,
    };
    const author = (m) => players.find((p) => p.user_id === m.player);
    if (r.phase === 'caption') {
      const m = rm.find((x) => x.player === ME);
      res.my_meme = m && { id: m.id, texts: m.texts, submitted: !!m.submitted_at, rerolls_left: 5 - m.rerolls, template: tplJson(m.template) };
    } else if (r.phase === 'showcase' || r.phase === 'vote') {
      res.memes = shown().map((m) => ({ id: m.id, texts: m.texts, mine: m.player === ME, template: tplJson(m.template) }));
      res.my_vote = votes.find((v) => v.voter === ME && v.round === r.round)?.meme ?? null;
    } else if (r.phase === 'results') {
      res.memes = shown().sort((a, b) => b.won - a.won || b.votes - a.votes).map((m) => ({
        id: m.id, texts: m.texts, mine: m.player === ME, template: tplJson(m.template),
        user_id: m.player, author: author(m)?.name, votes: m.votes, won: m.won }));
    } else if (r.phase === 'podium') {
      res.memes = memes.filter((m) => m.won).map((m) => ({ id: m.id, round: m.round, texts: m.texts, template: tplJson(m.template),
        user_id: m.player, author: author(m)?.name, votes: m.votes }));
    }
    return JSON.parse(JSON.stringify(res));
  },

  async hostNext() {
    if (room.phase === 'lobby') startRound();
    else if (room.phase === 'podium') { resetGame(); startRound(); }
    bump();
  },
  async backToLobby() { resetGame(); bump(); },
  async leaveRoom() { listeners.clear(); },
  async updateSettings(_, rounds, secs) { room.max_rounds = rounds; room.caption_seconds = secs; bump(); },
  async reroll() {
    const m = roundMemes().find((x) => x.player === ME);
    if (m.rerolls >= 5) throw new Error('NO_REROLL');
    Object.assign(m, { template: pickTemplate(), rerolls: m.rerolls + 1, texts: [], submitted_at: null });
    bump();
  },
  async submit(_, texts, final = true) {
    const m = roundMemes().find((x) => x.player === ME);
    if (!m || room.phase !== 'caption') throw new Error('TOO_LATE');
    m.texts = texts; if (final) m.submitted_at = now();
    allSubmitted(); bump();
  },
  async vote(_, meme) {
    if (shown().find((m) => m.id === meme)?.player === ME) throw new Error('OWN_MEME');
    castVote(ME, meme);
  },
  async tick(_, phase, idx) {
    if (room.phase === phase && room.vote_index === idx && room.phase_ends_at && now() >= room.phase_ends_at) advance();
  },
  async report() {},
  async upload(_, file, kind, w, h) {
    templates.push({ id: 'up' + templates.length, url: URL.createObjectURL(file), kind, w, h, zones: ZONES, room: true });
    bump();
  },
  subscribe(_, fn) { listeners.add(fn); return () => listeners.delete(fn); },
};
