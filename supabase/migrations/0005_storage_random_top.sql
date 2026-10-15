-- 2026-10-15 — Tirage vraiment varié, images ajoutées par glisser-déposer dans le Storage, Top mèmes (unanimes).

-- 1) Tirage : « sac mélangé » global. On pioche au hasard parmi les images les MOINS montrées
--    (toutes parties confondues) → on voit toute la banque avant de revoir une image,
--    et une image nouvellement ajoutée passe vite en jeu.
create or replace function public._pick_template(p_room uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid; v_seen uuid[];
begin
  select seen into v_seen from rooms where id = p_room;
  select t.id into v from templates t
   where t.active and (t.room_id is null or t.room_id = p_room)
     and not (t.id = any(v_seen))
   order by (t.room_id is not null) desc, t.plays asc, random()
   limit 1;
  if v is null then
    select t.id into v from templates t
     where t.active and (t.room_id is null or t.room_id = p_room)
     order by t.plays asc, random() limit 1;
  end if;
  if v is null then raise exception 'NO_TEMPLATES'; end if;
  update rooms set seen = array_append(seen, v) where id = p_room;
  update templates set plays = plays + 1 where id = v;
  return v;
end $$;

-- 2) Images : tout fichier déposé dans le bucket `memes`, dossier `library/`, entre dans le jeu
--    automatiquement (et en sort s'il est supprimé). Plus besoin de redéployer.
create or replace function public._storage_library_sync()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.bucket_id = 'memes' and new.name like 'library/%' and new.name !~ '/\.' then
      insert into public.templates (storage_path, kind, source)
      values (new.name,
              case when lower(new.name) like '%.gif' then 'gif'
                   when lower(new.name) ~ '\.(mp4|webm|mov)$' then 'video' else 'image' end,
              'library')
      on conflict (storage_path) do update set active = true;
    end if;
    return new;
  else
    if old.bucket_id = 'memes' and old.name like 'library/%' then
      update public.templates set active = false where storage_path = old.name;
    end if;
    return old;
  end if;
end $$;

drop trigger if exists memes_library_sync on storage.objects;
create trigger memes_library_sync after insert or delete on storage.objects
  for each row execute function public._storage_library_sync();

-- GIF jusqu'à 10 Mo depuis le tableau de bord
update storage.buckets set file_size_limit = 10485760 where id = 'memes';

-- 3) Top mèmes : les mèmes qui ont récolté TOUS les votes de leur manche (au moins 2 votes).
--    Copie figée (image + textes + pseudo) : survit à la suppression de la séance.
create table if not exists public.top_memes (
  id         uuid primary key default gen_random_uuid(),
  template   jsonb not null,
  texts      jsonb not null,
  author     text not null,
  author_id  uuid,
  votes      int  not null,
  hidden     boolean not null default false,   -- masqué après signalement
  created_at timestamptz not null default now()
);
create index if not exists top_memes_list_idx on public.top_memes(hidden, votes desc, created_at desc);
alter table public.top_memes enable row level security;

create or replace function public._record_unanimous(p_room uuid, p_round int, p_meme uuid)
returns void language plpgsql security definer set search_path = public as $$
declare m memes; v_voters int; v_name text;
begin
  select * into m from memes where id = p_meme;
  -- votants possibles pour ce mème = joueurs ayant voté cette manche, hors auteur
  select count(*) into v_voters from votes where room_id = p_room and round = p_round and voter_id <> m.player_id;
  if m.votes >= 2 and m.votes = v_voters then
    select name into v_name from players where room_id = p_room and user_id = m.player_id;
    insert into top_memes (template, texts, author, author_id, votes)
    select _template_json(t), m.texts, coalesce(v_name, 'Anonyme'), m.player_id, m.votes
      from templates t where t.id = m.template_id;
  end if;
end $$;

-- branche l'enregistrement dans la fin du vote
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
    select * into w from memes
     where room_id = p_room and round = r.round and vote_order is not null and votes > 0
     order by votes desc, submitted_at asc nulls last, vote_order
     limit 1;
    if w.id is not null then
      update memes set won = true where id = w.id;
      update players set score = score + 1 where room_id = p_room and user_id = w.player_id;
      update templates set wins = wins + 1 where id = w.template_id;
      perform _record_unanimous(p_room, r.round, w.id);
    end if;
    update templates t set total_votes = t.total_votes + m.votes
      from memes m where m.template_id = t.id and m.room_id = p_room and m.round = r.round;
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

-- Liste publique (paginée), du plus voté au plus récent
create or replace function public.top_memes_list(p_limit int default 20, p_offset int default 0)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'template', template, 'texts', texts, 'author', author,
                                               'votes', votes, 'created_at', created_at)), '[]')
    from (select * from top_memes where not hidden
          order by votes desc, created_at desc limit least(p_limit, 50) offset greatest(p_offset, 0)) t;
$$;

create or replace function public.report_top(p_id uuid)
returns void language sql security definer set search_path = public as $$
  update top_memes set hidden = true where id = p_id and auth.uid() is not null;
$$;

revoke execute on function public._storage_library_sync(), public._record_unanimous(uuid,int,uuid) from public, anon, authenticated;
revoke execute on function public.top_memes_list(int,int), public.report_top(uuid) from public, anon;
grant execute on function public.top_memes_list(int,int), public.report_top(uuid) to authenticated;
