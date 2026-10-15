// Adaptateur Supabase : toutes les actions passent par des RPC Postgres (voir supabase/migrations).
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

export const api = {
  mode: 'supabase',

  async init() {
    const { data } = await sb.auth.getSession();
    if (!data.session) {
      const { error } = await sb.auth.signInAnonymously();
      if (error) throw new Error('Connexion anonyme impossible : activez "Anonymous sign-ins" dans Supabase (' + error.message + ')');
    }
  },

  mediaUrl(t) {
    return t.url || `${SUPABASE_URL}/storage/v1/object/public/memes/${t.path}`;
  },

  myProfile: () => rpc('my_profile'),
  librarySample: (n = 14) => rpc('library_sample', { p_n: n }),
  createRoom: (name, avatar) => rpc('create_room', { p_name: name, p_avatar: avatar }),
  joinRoom: (code, name, avatar) => rpc('join_room', { p_code: code, p_name: name, p_avatar: avatar }),
  state: (room) => rpc('room_state', { p_room: room }),
  hostNext: (room) => rpc('host_next', { p_room: room }),
  updateSettings: (room, rounds, secs) => rpc('update_settings', { p_room: room, p_max_rounds: rounds, p_caption_seconds: secs }),
  reroll: (room) => rpc('reroll', { p_room: room }),
  leaveRoom: (room) => rpc('leave_room', { p_room: room }),
  backToLobby: (room) => rpc('back_to_lobby', { p_room: room }),
  submit: (room, texts, final = true) => rpc('submit_meme', { p_room: room, p_texts: texts, p_final: final }),
  vote: (room, meme) => rpc('cast_vote', { p_room: room, p_meme: meme }),
  tick: (room, phase, idx) => rpc('tick', { p_room: room, p_phase: phase, p_vote_index: idx }),
  report: (room, meme) => rpc('report', { p_room: room, p_meme: meme }),

  async upload(room, file, kind, w, h) {
    const ext = kind === 'gif' ? 'gif' : kind === 'video' ? (file.name.split('.').pop() || 'mp4').toLowerCase() : 'jpg';
    const path = `uploads/${room}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.${ext}`;
    const { error } = await sb.storage.from('memes').upload(path, file, {
      contentType: file.type, cacheControl: '31536000', upsert: false,
    });
    if (error) throw new Error(error.message);
    return rpc('add_room_template', { p_room: room, p_path: path, p_kind: kind, p_w: w, p_h: h });
  },

  // Écoute la ligne `rooms` : chaque action serveur incrémente `version`.
  subscribe(room, onChange) {
    const ch = sb.channel('room:' + room)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${room}` }, onChange)
      .subscribe();
    return () => sb.removeChannel(ch);
  },
};
