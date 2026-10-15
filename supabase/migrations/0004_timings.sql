-- 2026-10-15 — Chrono de légende jusqu'à 1 min 30 ; défilé de 10 s par mème.
alter table public.rooms drop constraint if exists rooms_caption_seconds_check;
alter table public.rooms add constraint rooms_caption_seconds_check check (caption_seconds between 10 and 90);
alter table public.rooms alter column showcase_seconds set default 10;
update public.rooms set showcase_seconds = 10;
