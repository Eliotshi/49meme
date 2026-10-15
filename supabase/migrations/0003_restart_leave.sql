-- 2026-10-15 — Corrige la relance de partie + permet de quitter une séance.
-- Bug : après le podium, round repartait à 0 alors que les mèmes de la manche 1 existaient
-- → violation d'unicité (room_id, round, player_id) → impossible de relancer.

-- Remet la séance à zéro (mèmes et votes de la partie précédente effacés, `seen` conservé
-- pour ne pas revoir les mêmes images). Interne.
create or replace function public._reset_game(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from memes where room_id = p_room;          -- votes supprimés en cascade
  update players set score = 0 where room_id = p_room;
  update rooms set phase = 'lobby', round = 0, vote_index = 0, phase_ends_at = null where id = p_room;
end $$;

-- Hôte : lobby → 1re manche ; podium → nouvelle partie directement (mêmes réglages)
create or replace function public.host_next(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r rooms;
begin
  perform _require_member(p_room);
  select * into r from rooms where id = p_room for update;
  if r.host_id <> auth.uid() then raise exception 'HOST_ONLY'; end if;
  if r.phase = 'podium' then
    perform _reset_game(p_room);
    perform _start_round(p_room);
  elsif r.phase = 'lobby' then
    -- séance restée bloquée par l'ancien bug : on nettoie les mèmes restants
    if exists (select 1 from memes where room_id = p_room) then perform _reset_game(p_room); end if;
    perform _start_round(p_room);
  else
    raise exception 'BAD_PHASE';
  end if;
  perform _bump(p_room);
end $$;

-- Hôte : podium → retour au salon (pour changer les réglages)
create or replace function public.back_to_lobby(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r rooms;
begin
  perform _require_member(p_room);
  select * into r from rooms where id = p_room for update;
  if r.host_id <> auth.uid() then raise exception 'HOST_ONLY'; end if;
  if r.phase <> 'podium' then raise exception 'BAD_PHASE'; end if;
  perform _reset_game(p_room);
  perform _bump(p_room);
end $$;

-- Quitter la séance : libère le coin. Si l'hôte part, le plus ancien joueur devient hôte.
-- Si plus personne, la séance est supprimée.
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
  perform _bump(p_room);
end $$;

revoke execute on function public._reset_game(uuid) from public, anon, authenticated;
revoke execute on function public.back_to_lobby(uuid), public.leave_room(uuid) from public, anon;
grant execute on function public.back_to_lobby(uuid), public.leave_room(uuid) to authenticated;

-- Dimensions des vidéos (évite les sauts d'affichage pendant le chargement)
update public.templates set width = 498, height = 304 where url = 'library/img-066.mp4';
update public.templates set width = 216, height = 210 where url = 'library/img-068.mp4';
update public.templates set width = 370, height = 330 where url = 'library/img-069.mp4';
update public.templates set width = 498, height = 374 where url = 'library/img-073.mp4';
update public.templates set width = 640, height = 640 where url = 'library/img-074.mp4';
