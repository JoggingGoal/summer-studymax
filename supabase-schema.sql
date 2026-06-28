-- Run this once in your Supabase project's SQL Editor (Project > SQL Editor > New query).
-- It creates one table that holds each group's full state as JSON, which keeps
-- this migration simple and mirrors the original app's data shape closely.

create table if not exists public.groups (
  code text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- Automatically bump updated_at on every write (handy for debugging / future use)
create or replace function public.touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists groups_touch_updated_at on public.groups;
create trigger groups_touch_updated_at
  before update on public.groups
  for each row
  execute function public.touch_updated_at();

-- Row Level Security: this app has no login system (friends share a group
-- code instead, same as the original artifact), so we allow anyone with the
-- anon key to read/write any group row. The anon key is meant to be public —
-- security here comes from the group code being hard to guess (5 random
-- letters/numbers), the same trust model the original app used.
alter table public.groups enable row level security;

drop policy if exists "Anyone can read groups" on public.groups;
create policy "Anyone can read groups"
  on public.groups for select
  using (true);

drop policy if exists "Anyone can insert groups" on public.groups;
create policy "Anyone can insert groups"
  on public.groups for insert
  with check (true);

drop policy if exists "Anyone can update groups" on public.groups;
create policy "Anyone can update groups"
  on public.groups for update
  using (true);

-- Enable realtime so all members see updates live without polling
alter publication supabase_realtime add table public.groups;
