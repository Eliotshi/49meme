-- 2026-10-15 — « Jouer direct » : matchmaking automatique en équipes de 4.
alter table public.rooms add column if not exists is_public boolean not null default false;
create index if not exists rooms_public_lobby_idx on public.rooms(is_public, phase, created_at);

-- Place le joueur dans l'équipe publique la plus remplie (< 4) ; sinon en ouvre une.
-- Verrou global : les arrivées simultanées sont traitées une par une → équipes de 4 compactes.
create or replace function public.quick_join(p_name text, p_avatar text default '🗳️')
returns jsonb language plpgsql security definer set search_path = public as $$
declare r rooms; n int; v_code text; abc text := 'ABCDEFGHJKLMNPQRSTUVWXYZ';
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  perform pg_advisory_xact_lock(4949);
  -- déjà dans une équipe publique en attente : on y reste
  select r2.* into r from rooms r2 join players p on p.room_id = r2.id and p.user_id = auth.uid()
   where r2.is_public and r2.phase = 'lobby' limit 1;
  if r.id is null then
    select r2.* into r from rooms r2
     where r2.is_public and r2.phase = 'lobby' and r2.updated_at > now() - interval '10 minutes'
       and (select count(*) from players p where p.room_id = r2.id) < 4
     order by (select count(*) from players p where p.room_id = r2.id) desc, r2.created_at
     limit 1;
  end if;
  if r.id is null then
    loop
      v_code := '';
      for i in 1..4 loop v_code := v_code || substr(abc, 1 + floor(random() * length(abc))::int, 1); end loop;
      exit when not exists (select 1 from rooms where code = v_code);
    end loop;
    insert into rooms (code, host_id, is_public, max_rounds, caption_seconds)
    values (v_code, auth.uid(), true, 3, 40) returning * into r;
  end if;
  insert into players (room_id, user_id, name, avatar)
  values (r.id, auth.uid(), trim(p_name), coalesce(p_avatar, '🗳️'))
  on conflict (room_id, user_id) do update set name = excluded.name;
  select count(*) into n from players where room_id = r.id;
  if n >= 4 then
    update rooms set phase_ends_at = now() + interval '3 seconds' where id = r.id;
  elsif n >= 2 and r.phase_ends_at is null then
    update rooms set phase_ends_at = now() + interval '30 seconds' where id = r.id;
  end if;
  perform _bump(r.id);
  return jsonb_build_object('room_id', r.id, 'code', r.code);
end $$;

-- tick : gère aussi le démarrage automatique des équipes publiques
create or replace function public.tick(p_room uuid, p_phase text, p_vote_index int default 0)
returns void language plpgsql security definer set search_path = public as $$
declare r rooms;
begin
  perform _require_member(p_room);
  select * into r from rooms where id = p_room for update;
  if r.phase <> p_phase or r.phase_ends_at is null or now() < r.phase_ends_at then return; end if;
  if r.phase = 'lobby' and r.is_public then
    if (select count(*) from players where room_id = p_room) >= 2 then
      if exists (select 1 from memes where room_id = p_room) then perform _reset_game(p_room); end if;
      perform _start_round(p_room);
    else
      update rooms set phase_ends_at = null where id = p_room;
    end if;
    perform _bump(p_room);
  elsif r.phase in ('caption', 'showcase', 'vote', 'results') and r.vote_index = coalesce(p_vote_index, r.vote_index) then
    perform _advance(p_room);
  end if;
end $$;

-- quitter : si l'équipe publique en attente retombe sous 2 joueurs, on stoppe le compte à rebours
create or replace function public.leave_room(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r rooms; v_next uuid;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into r from rooms where id = p_room for update;
  if r.id is null then return; end if;
  delete from players where room_id = p_room and user_id = auth.uid();
  if r.phase = 'caption' then
    delete from memes where room_id = p_room and round = r.round and player_id = auth.uid();
  end if;
  select user_id into v_next from players where room_id = p_room order by joined_at limit 1;
  if v_next is null then
    delete from rooms where id = p_room;
    return;
  end if;
  if r.host_id = auth.uid() then update rooms set host_id = v_next where id = p_room; end if;
  if r.phase = 'lobby' and r.is_public and (select count(*) from players where room_id = p_room) < 2 then
    update rooms set phase_ends_at = null where id = p_room;
  end if;
  perform _bump(p_room);
end $$;

revoke execute on function public.quick_join(text,text) from public, anon;
grant execute on function public.quick_join(text,text) to authenticated;
