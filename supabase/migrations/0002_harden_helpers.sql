-- Appliquée le 2026-10-15 (recommandations du linter Supabase).
alter function public._template_json(public.templates) set search_path = public;
revoke execute on function public.is_member(uuid) from public, anon;
grant execute on function public.is_member(uuid) to authenticated;
