-- =====================================================================
-- 49.meme — schéma V2 (pas encore déployé : ce fichier reste la migration initiale)
-- À coller tel quel dans Supabase > SQL Editor > Run.
--
-- Principe : le serveur fait autorité. Les clients ne lisent/écrivent
-- JAMAIS directement les tables de jeu : tout passe par des fonctions RPC
-- (security definer) qui vérifient l'appartenance à la room.
-- Le temps réel = 1 seule table écoutée (rooms) dont la colonne `version`
-- est incrémentée à chaque action ; les clients rechargent alors l'état
-- complet via room_state().
--
-- Déroulé d'une manche :
--   lobby → caption (légende, chrono) → showcase (chaque mème ~8 s, synchro)
--         → vote (tous les mèmes, on choisit son préféré) → results (lauréat, +1 pt)
--         → caption (manche suivante, auto) … → podium → lobby
--
-- Points de profil (cumulés d'une partie à l'autre, par appareil/compte anonyme) :
--   mème présenté +1 · vote reçu +2 · manche gagnée +5 · partie gagnée +10
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists public.rooms (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  host_id          uuid not null,
  phase            text not null default 'lobby'
                   check (phase in ('lobby','caption','showcase','vote','results','podium')),
  round            int  not null default 0,
  max_rounds       int  not null default 5  check (max_rounds between 1 and 15),
  caption_seconds  int  not null default 30 check (caption_seconds between 10 and 40),
  showcase_seconds int  not null default 3  check (showcase_seconds between 3 and 20),
  vote_seconds     int  not null default 25 check (vote_seconds between 5 and 60),
  results_seconds  int  not null default 12 check (results_seconds between 3 and 30),
  vote_index       int  not null default 0,          -- mème affiché pendant le showcase
  phase_ends_at    timestamptz,
  seen             uuid[] not null default '{}',      -- images déjà montrées dans la partie (anti-doublon, rerolls inclus)
  version          bigint not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists public.players (
  room_id   uuid not null references public.rooms(id) on delete cascade,
  user_id   uuid not null,
  name      text not null check (char_length(name) between 1 and 20),
  avatar    text not null default '🗳️',
  score     int  not null default 0,               -- nb de manches gagnées
  joined_at timestamptz not null default now(),    -- détermine le coin de l'écran (slot 1..4)
  primary key (room_id, user_id)
);

-- Banque d'images / GIF / vidéos. room_id NULL = bibliothèque globale.
-- room_id renseigné = image uploadée par un joueur, utilisable dans SA room.
create table if not exists public.templates (
  id           uuid primary key default gen_random_uuid(),
  storage_path text,                       -- chemin dans le bucket 'memes' (ex: library/img-001.gif)
  url          text,                       -- OU URL externe
  kind         text not null default 'image' check (kind in ('image','gif','video')),  -- video = mp4/webm muet en boucle
  width        int,
  height       int,
  -- zones de texte par défaut (coordonnées relatives 0..1, s = taille en fraction de la largeur)
  zones        jsonb not null default '[{"x":0.5,"y":0.03,"s":0.09},{"x":0.5,"y":0.97,"s":0.09}]',
  tags         text[] not null default '{}',
  source       text not null default 'library' check (source in ('library','player')),
  room_id      uuid references public.rooms(id) on delete cascade,
  uploaded_by  uuid,
  license      text,
  source_url   text,
  active       boolean not null default true,
  plays        int not null default 0,     -- nb de fois tirée
  total_votes  int not null default 0,     -- votes récoltés → classer les images qui font rire
  wins         int not null default 0,     -- manches gagnées avec cette image
  created_at   timestamptz not null default now(),
  check (storage_path is not null or url is not null)
);
create unique index if not exists templates_storage_path_key on public.templates(storage_path);
create unique index if not exists templates_url_key on public.templates(url);
create index if not exists templates_pool_idx on public.templates(active, room_id);

create table if not exists public.memes (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references public.rooms(id) on delete cascade,
  round        int  not null,
  player_id    uuid not null,
  template_id  uuid not null references public.templates(id),
  texts        jsonb not null default '[]',  -- [{t,x,y,s}]
  submitted_at timestamptz,
  rerolls      int  not null default 0,      -- max 5 par manche
  vote_order   int,                          -- ordre de passage (null = mème vide, non présenté)
  votes        int  not null default 0,
  won          boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (room_id, round, player_id)
);
create index if not exists memes_room_round_idx on public.memes(room_id, round);

-- 1 vote par joueur et par manche : son mème préféré
create table if not exists public.votes (
  room_id    uuid not null references public.rooms(id) on delete cascade,
  round      int  not null,
  voter_id   uuid not null,
  meme_id    uuid not null references public.memes(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (room_id, round, voter_id)
);

-- Profil joueur persistant (le compte anonyme Supabase reste sur le téléphone)
create table if not exists public.profiles (
  user_id        uuid primary key,
  name           text,
  points         int not null default 0,
  games          int not null default 0,
  games_won      int not null default 0,
  rounds_won     int not null default 0,
  memes          int not null default 0,
  votes_received int not null default 0,
  updated_at     timestamptz not null default now()
);

create table if not exists public.reports (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid references public.rooms(id) on delete set null,
  template_id uuid references public.templates(id) on delete cascade,
  meme_id     uuid references public.memes(id) on delete cascade,
  reporter_id uuid not null,
  reason      text,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- RLS : tout fermé, sauf lecture de sa propre room (nécessaire au realtime)
-- ---------------------------------------------------------------------

alter table public.rooms     enable row level security;
alter table public.players   enable row level security;
alter table public.templates enable row level security;
alter table public.memes     enable row level security;
alter table public.votes     enable row level security;
alter table public.reports   enable row level security;
alter table public.profiles  enable row level security;

create or replace function public.is_member(p_room uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from players where room_id = p_room and user_id = auth.uid());
$$;

drop policy if exists rooms_member_read on public.rooms;
create policy rooms_member_read on public.rooms for select to authenticated
  using (public.is_member(id));

drop policy if exists templates_library_read on public.templates;
create policy templates_library_read on public.templates for select
  using (active and room_id is null);

-- ---------------------------------------------------------------------
-- Helpers internes
-- ---------------------------------------------------------------------

create or replace function public._template_json(t public.templates)
returns jsonb language sql stable as $$
  select jsonb_build_object('id', t.id, 'path', t.storage_path, 'url', t.url, 'kind', t.kind,
                            'w', t.width, 'h', t.height, 'zones', t.zones);
$$;

create or replace function public._bump(p_room uuid)
returns void language sql security definer set search_path = public as $$
  update rooms set version = version + 1, updated_at = now() where id = p_room;
$$;

create or replace function public._require_member(p_room uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if not is_member(p_room) then raise exception 'NOT_IN_ROOM'; end if;
end $$;

-- Tire une image jamais vue dans la partie (uploads de la room en priorité).
-- Si la banque est épuisée, on repioche au hasard.
create or replace function public._pick_template(p_room uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid; v_seen uuid[];
begin
  select seen into v_seen from rooms where id = p_room;
  select t.id into v from templates t
   where t.active and (t.room_id is null or t.room_id = p_room)
     and not (t.id = any(v_seen))
   order by (t.room_id is not null) desc, random()
   limit 1;
  if v is null then
    select t.id into v from templates t
     where t.active and (t.room_id is null or t.room_id = p_room)
     order by random() limit 1;
  end if;
  if v is null then raise exception 'NO_TEMPLATES'; end if;
  update rooms set seen = array_append(seen, v) where id = p_room;
  update templates set plays = plays + 1 where id = v;
  return v;
end $$;

create or replace function public._start_round(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r rooms; p record;
begin
  update rooms set phase = 'caption', round = round + 1, vote_index = 0,
         phase_ends_at = now() + make_interval(secs => caption_seconds)
   where id = p_room returning * into r;
  for p in select user_id from players where room_id = p_room order by joined_at loop
    insert into memes (room_id, round, player_id, template_id)
    values (p_room, r.round, p.user_id, _pick_template(p_room));
  end loop;
end $$;

-- Machine à états. Appelée avec la room verrouillée (for update).
create or replace function public._advance(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r rooms; n int; w memes;
begin
  select * into r from rooms where id = p_room;

  if r.phase = 'caption' then
    with ordered as (
      select id, row_number() over (order by random()) - 1 as o
        from memes
       where room_id = p_room and round = r.round
         and jsonb_path_exists(texts, '$[*] ? (@.t != "")')
    )
    update memes m set vote_order = o.o from ordered o where m.id = o.id;
    get diagnostics n = row_count;
    if n = 0 then
      update rooms set phase = 'results', phase_ends_at = now() + make_interval(secs => r.results_seconds) where id = p_room;
    else
      update rooms set phase = 'showcase', vote_index = 0,
             phase_ends_at = now() + make_interval(secs => r.showcase_seconds) where id = p_room;
    end if;

  elsif r.phase = 'showcase' then
    select count(*) into n from memes where room_id = p_room and round = r.round and vote_order is not null;
    if r.vote_index + 1 < n then
      update rooms set vote_index = vote_index + 1,
             phase_ends_at = now() + make_interval(secs => r.showcase_seconds) where id = p_room;
    else
      update rooms set phase = 'vote', phase_ends_at = now() + make_interval(secs => r.vote_seconds) where id = p_room;
    end if;

  elsif r.phase = 'vote' then
    update memes m set votes = (select count(*) from votes v where v.meme_id = m.id)
     where m.room_id = p_room and m.round = r.round;
    -- lauréat : le plus de votes ; égalité → le plus rapide à avoir validé
    select * into w from memes
     where room_id = p_room and round = r.round and vote_order is not null and votes > 0
     order by votes desc, submitted_at asc nulls last, vote_order
     limit 1;
    if w.id is not null then
      update memes set won = true where id = w.id;
      update players set score = score + 1 where room_id = p_room and user_id = w.player_id;
      update templates set wins = wins + 1 where id = w.template_id;
    end if;
    update templates t set total_votes = t.total_votes + m.votes
      from memes m where m.template_id = t.id and m.room_id = p_room and m.round = r.round;
    -- points de profil : +1 mème présenté, +2 par vote reçu, +5 manche gagnée
    insert into profiles (user_id, name, points, memes, votes_received, rounds_won)
    select m.player_id, p.name, 1 + 2 * m.votes + case when m.won then 5 else 0 end, 1, m.votes, m.won::int
      from memes m join players p on p.room_id = m.room_id and p.user_id = m.player_id
     where m.room_id = p_room and m.round = r.round and m.vote_order is not null
    on conflict (user_id) do update set name = excluded.name, points = profiles.points + excluded.points,
       memes = profiles.memes + 1, votes_received = profiles.votes_received + excluded.votes_received,
       rounds_won = profiles.rounds_won + excluded.rounds_won, updated_at = now();
    update rooms set phase = 'results', phase_ends_at = now() + make_interval(secs => r.results_seconds) where id = p_room;

  elsif r.phase = 'results' then
    if r.round >= r.max_rounds then
      update rooms set phase = 'podium', phase_ends_at = null where id = p_room;
      -- +10 au(x) vainqueur(s) de la partie, +1 partie jouée pour tous
      insert into profiles (user_id, name, points, games, games_won)
      select p.user_id, p.name, case when p.score = s.mx and s.mx > 0 then 10 else 0 end, 1,
             (p.score = s.mx and s.mx > 0)::int
        from players p, (select max(score) as mx from players where room_id = p_room) s
       where p.room_id = p_room
      on conflict (user_id) do update set name = excluded.name, points = profiles.points + excluded.points,
         games = profiles.games + 1, games_won = profiles.games_won + excluded.games_won, updated_at = now();
    else
      perform _start_round(p_room);
    end if;
  end if;

  perform _bump(p_room);
end $$;

-- ---------------------------------------------------------------------
-- RPC publiques (appelées par le client)
-- ---------------------------------------------------------------------

create or replace function public.create_room(p_name text, p_avatar text default '🗳️')
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_code text; v_id uuid; abc text := 'ABCDEFGHJKLMNPQRSTUVWXYZ';
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  loop
    v_code := '';
    for i in 1..4 loop v_code := v_code || substr(abc, 1 + floor(random() * length(abc))::int, 1); end loop;
    exit when not exists (select 1 from rooms where code = v_code);
  end loop;
  insert into rooms (code, host_id) values (v_code, auth.uid()) returning id into v_id;
  insert into players (room_id, user_id, name, avatar) values (v_id, auth.uid(), trim(p_name), coalesce(p_avatar, '🗳️'));
  return jsonb_build_object('room_id', v_id, 'code', v_code);
end $$;

-- 4 joueurs max (un par coin de l'écran)
create or replace function public.join_room(p_code text, p_name text, p_avatar text default '🗳️')
returns jsonb language plpgsql security definer set search_path = public as $$
declare r rooms;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into r from rooms where code = upper(trim(p_code)) for update;
  if r.id is null then raise exception 'ROOM_NOT_FOUND'; end if;
  if (select count(*) from players where room_id = r.id) >= 4
     and not exists (select 1 from players where room_id = r.id and user_id = auth.uid()) then
    raise exception 'ROOM_FULL';
  end if;
  insert into players (room_id, user_id, name, avatar)
  values (r.id, auth.uid(), trim(p_name), coalesce(p_avatar, '🗳️'))
  on conflict (room_id, user_id) do update set name = excluded.name, avatar = excluded.avatar;
  perform _bump(r.id);
  return jsonb_build_object('room_id', r.id, 'code', r.code);
end $$;

-- Hôte uniquement : lobby → 1re manche, podium → lobby
create or replace function public.host_next(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r rooms;
begin
  perform _require_member(p_room);
  select * into r from rooms where id = p_room for update;
  if r.host_id <> auth.uid() then raise exception 'HOST_ONLY'; end if;
  if r.phase = 'lobby' then
    perform _start_round(p_room);
  elsif r.phase = 'podium' then
    -- `seen` est conservé : la partie suivante pioche d'abord des images encore jamais vues
    update rooms set phase = 'lobby', round = 0, phase_ends_at = null where id = p_room;
    update players set score = 0 where room_id = p_room;
  else
    raise exception 'BAD_PHASE';
  end if;
  perform _bump(p_room);
end $$;

create or replace function public.update_settings(p_room uuid, p_max_rounds int, p_caption_seconds int)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _require_member(p_room);
  update rooms set max_rounds = p_max_rounds, caption_seconds = p_caption_seconds
   where id = p_room and host_id = auth.uid() and phase = 'lobby';
  perform _bump(p_room);
end $$;

-- Changer d'image (5 fois max par manche, jamais une image déjà vue)
create or replace function public.reroll(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r rooms;
begin
  perform _require_member(p_room);
  select * into r from rooms where id = p_room for update;
  if r.phase <> 'caption' then raise exception 'BAD_PHASE'; end if;
  if exists (select 1 from memes where room_id = p_room and round = r.round and player_id = auth.uid() and rerolls >= 5) then
    raise exception 'NO_REROLL';
  end if;
  update memes set template_id = _pick_template(p_room), rerolls = rerolls + 1, texts = '[]', submitted_at = null
   where room_id = p_room and round = r.round and player_id = auth.uid();
  perform _bump(p_room);
end $$;

-- Enregistre (ou ré-enregistre) la légende. Appelée au clic « Valider » et en auto-save.
create or replace function public.submit_meme(p_room uuid, p_texts jsonb, p_final boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare r rooms; v_clean jsonb; n_total int; n_done int;
begin
  perform _require_member(p_room);
  select * into r from rooms where id = p_room for update;
  if r.phase <> 'caption' or now() > r.phase_ends_at + interval '4 seconds' then raise exception 'TOO_LATE'; end if;
  if jsonb_typeof(p_texts) <> 'array' or jsonb_array_length(p_texts) > 6 then raise exception 'BAD_TEXTS'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           't', left(coalesce(e->>'t', ''), 140),
           'x', least(greatest(coalesce((e->>'x')::numeric, 0.5), 0), 1),
           'y', least(greatest(coalesce((e->>'y')::numeric, 0.5), 0), 1),
           's', least(greatest(coalesce((e->>'s')::numeric, 0.08), 0.03), 0.2))), '[]')
    into v_clean from jsonb_array_elements(p_texts) e;

  update memes set texts = v_clean, submitted_at = case when p_final then now() else submitted_at end
   where room_id = p_room and round = r.round and player_id = auth.uid();

  select count(*), count(submitted_at) into n_total, n_done from memes where room_id = p_room and round = r.round;
  if n_done = n_total then
    update rooms set phase_ends_at = least(phase_ends_at, now() + interval '1 second') where id = p_room;
  end if;
  perform _bump(p_room);
end $$;

-- Vote pour son mème préféré (pas le sien). Re-voter = changer d'avis.
create or replace function public.cast_vote(p_room uuid, p_meme uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r rooms; m memes; n_needed int; n_done int;
begin
  perform _require_member(p_room);
  select * into r from rooms where id = p_room for update;
  if r.phase <> 'vote' then raise exception 'BAD_PHASE'; end if;
  select * into m from memes where id = p_meme and room_id = p_room and round = r.round and vote_order is not null;
  if m.id is null then raise exception 'NOT_FOUND'; end if;
  if m.player_id = auth.uid() then raise exception 'OWN_MEME'; end if;

  insert into votes (room_id, round, voter_id, meme_id) values (p_room, r.round, auth.uid(), p_meme)
  on conflict (room_id, round, voter_id) do update set meme_id = excluded.meme_id, created_at = now();

  -- votants attendus = joueurs ayant au moins un mème (autre que le leur) à départager
  select count(*) into n_needed from players p
   where p.room_id = p_room
     and exists (select 1 from memes x where x.room_id = p_room and x.round = r.round
                 and x.vote_order is not null and x.player_id <> p.user_id);
  select count(*) into n_done from votes where room_id = p_room and round = r.round;
  if n_done >= n_needed then
    update rooms set phase_ends_at = least(phase_ends_at, now() + interval '1 second') where id = p_room;
  end if;
  perform _bump(p_room);
end $$;

-- N'importe quel joueur peut « pousser » la partie quand le chrono est écoulé
-- (pas de blocage si l'hôte perd le réseau). Idempotent grâce au verrou + p_phase/p_vote_index.
create or replace function public.tick(p_room uuid, p_phase text, p_vote_index int default 0)
returns void language plpgsql security definer set search_path = public as $$
declare r rooms;
begin
  perform _require_member(p_room);
  select * into r from rooms where id = p_room for update;
  if r.phase = p_phase and r.vote_index = coalesce(p_vote_index, r.vote_index)
     and r.phase in ('caption', 'showcase', 'vote', 'results') and now() >= r.phase_ends_at then
    perform _advance(p_room);
  end if;
end $$;

-- Après upload dans storage (memes/uploads/<room_id>/<fichier>)
create or replace function public.add_room_template(p_room uuid, p_path text, p_kind text, p_w int, p_h int)
returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  perform _require_member(p_room);
  if p_path not like 'uploads/' || p_room::text || '/%' then raise exception 'BAD_PATH'; end if;
  if (select count(*) from templates where room_id = p_room) >= 40 then raise exception 'TOO_MANY_UPLOADS'; end if;
  insert into templates (storage_path, kind, width, height, source, room_id, uploaded_by)
  values (p_path, case when p_kind in ('gif', 'video') then p_kind else 'image' end, p_w, p_h, 'player', p_room, auth.uid())
  returning id into v;
  perform _bump(p_room);
  return v;
end $$;

create or replace function public.report(p_room uuid, p_meme uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare m memes;
begin
  perform _require_member(p_room);
  select * into m from memes where id = p_meme and room_id = p_room;
  if m.id is null then raise exception 'NOT_FOUND'; end if;
  insert into reports (room_id, template_id, meme_id, reporter_id, reason)
  values (p_room, m.template_id, m.id, auth.uid(), left(p_reason, 300));
  update templates set active = false where id = m.template_id and source = 'player';
end $$;

create or replace function public.my_profile()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((select to_jsonb(p) - 'user_id' - 'updated_at' from profiles p where p.user_id = auth.uid()),
                  jsonb_build_object('points', 0, 'games', 0, 'games_won', 0, 'rounds_won', 0, 'memes', 0, 'votes_received', 0));
$$;

-- Échantillon aléatoire de la bibliothèque (polaroïds de la page d'accueil)
create or replace function public.library_sample(p_n int default 14)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(_template_json(t)), '[]') from (
    select * from templates where active and room_id is null order by random() limit least(p_n, 30)) t;
$$;

-- L'état complet vu par le joueur courant. Ne révèle que ce qu'il a le droit de voir.
create or replace function public.room_state(p_room uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r rooms; me uuid := auth.uid(); res jsonb;
begin
  perform _require_member(p_room);
  select * into r from rooms where id = p_room;

  res := jsonb_build_object(
    'me', me,
    'now', now(),
    'room', to_jsonb(r) - 'created_at' - 'updated_at' - 'seen',
    -- ordre d'arrivée = coin de l'écran (stable pendant toute la partie)
    'players', (select coalesce(jsonb_agg(jsonb_build_object(
                   'user_id', p.user_id, 'name', p.name, 'avatar', p.avatar, 'score', p.score,
                   'submitted', exists (select 1 from memes m where m.room_id = p.room_id and m.round = r.round
                                        and m.player_id = p.user_id and m.submitted_at is not null),
                   'voted', exists (select 1 from votes v where v.room_id = p.room_id and v.round = r.round
                                    and v.voter_id = p.user_id))
                 order by p.joined_at), '[]')
                from players p where p.room_id = p_room),
    'pending_uploads', (select count(*) from templates t where t.room_id = p_room and t.active
                        and not (t.id = any(r.seen)))
  );

  if r.phase = 'caption' then
    res := res || jsonb_build_object('my_meme',
      (select jsonb_build_object('id', m.id, 'texts', m.texts, 'submitted', m.submitted_at is not null,
                                 'rerolls_left', 5 - m.rerolls, 'template', _template_json(t))
         from memes m join templates t on t.id = m.template_id
        where m.room_id = p_room and m.round = r.round and m.player_id = me));

  elsif r.phase in ('showcase', 'vote') then
    -- auteurs masqués jusqu'aux résultats
    res := res || jsonb_build_object(
      'memes', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', m.id, 'texts', m.texts, 'mine', m.player_id = me, 'template', _template_json(t))
                  order by m.vote_order), '[]')
                from memes m join templates t on t.id = m.template_id
               where m.room_id = p_room and m.round = r.round and m.vote_order is not null),
      'my_vote', (select meme_id from votes where room_id = p_room and round = r.round and voter_id = me));

  elsif r.phase = 'results' then
    res := res || jsonb_build_object(
      'memes', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', m.id, 'texts', m.texts, 'mine', m.player_id = me, 'template', _template_json(t),
                  'user_id', m.player_id, 'author', p.name, 'avatar', p.avatar, 'votes', m.votes, 'won', m.won)
                  order by m.won desc, m.votes desc), '[]')
                from memes m join templates t on t.id = m.template_id
                left join players p on p.room_id = m.room_id and p.user_id = m.player_id
               where m.room_id = p_room and m.round = r.round and m.vote_order is not null));

  elsif r.phase = 'podium' then
    -- les mèmes lauréats de chaque manche
    res := res || jsonb_build_object(
      'memes', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', m.id, 'round', m.round, 'texts', m.texts, 'template', _template_json(t),
                  'user_id', m.player_id, 'author', p.name, 'avatar', p.avatar, 'votes', m.votes)
                  order by m.round), '[]')
                from memes m join templates t on t.id = m.template_id
                left join players p on p.room_id = m.room_id and p.user_id = m.player_id
               where m.room_id = p_room and m.won));
  end if;

  return res;
end $$;

-- ---------------------------------------------------------------------
-- Admin : importer la bibliothèque depuis le Storage
-- Uploadez vos fichiers dans le bucket `memes`, dossier `library/`, puis : select public.sync_library();
-- ---------------------------------------------------------------------
create or replace function public.sync_library()
returns int language plpgsql security definer set search_path = public, storage as $$
declare n int;
begin
  insert into public.templates (storage_path, kind, source)
  select o.name,
         case when lower(o.name) like '%.gif' then 'gif'
              when lower(o.name) ~ '\.(mp4|webm|mov)$' then 'video' else 'image' end,
         'library'
    from storage.objects o
   where o.bucket_id = 'memes' and o.name like 'library/%' and o.name not like '%/.%'
     and lower(o.name) !~ '\.json$'
  on conflict (storage_path) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Droits d'exécution : seules les RPC « publiques » sont appelables
-- ---------------------------------------------------------------------
revoke execute on function public._bump(uuid), public._advance(uuid), public._pick_template(uuid),
  public._start_round(uuid), public._require_member(uuid), public.sync_library()
  from public, anon, authenticated;

revoke execute on function public.create_room(text,text), public.join_room(text,text,text),
  public.host_next(uuid), public.update_settings(uuid,int,int), public.reroll(uuid),
  public.submit_meme(uuid,jsonb,boolean), public.cast_vote(uuid,uuid), public.tick(uuid,text,int),
  public.add_room_template(uuid,text,text,int,int), public.report(uuid,uuid,text), public.room_state(uuid),
  public.library_sample(int), public.my_profile()
  from public, anon;
grant execute on function public.create_room(text,text), public.join_room(text,text,text),
  public.host_next(uuid), public.update_settings(uuid,int,int), public.reroll(uuid),
  public.submit_meme(uuid,jsonb,boolean), public.cast_vote(uuid,uuid), public.tick(uuid,text,int),
  public.add_room_template(uuid,text,text,int,int), public.report(uuid,uuid,text), public.room_state(uuid),
  public.library_sample(int), public.my_profile()
  to authenticated;

-- ---------------------------------------------------------------------
-- Realtime : on n'écoute que `rooms` (version++ à chaque action)
-- ---------------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.rooms;
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- Storage : bucket public `memes` (lecture CDN), upload joueurs limité à leur room
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('memes', 'memes', true, 6291456,
        array['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','video/quicktime'])
on conflict (id) do nothing;

drop policy if exists "memes upload room" on storage.objects;
create policy "memes upload room" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'memes'
    and (storage.foldername(name))[1] = 'uploads'
    and public.is_member(((storage.foldername(name))[2])::uuid)
  );
