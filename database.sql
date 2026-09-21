-- Sijui Charades database setup
-- PostgreSQL / Supabase-compatible schema.
-- Run this in a new PostgreSQL database or the Supabase SQL editor.

create extension if not exists pgcrypto;

-- Supabase Auth owns passwords and sessions. This table stores app-specific user data.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  role text not null default 'user' check (role in ('admin', 'user')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.decks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  is_published boolean not null default true,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cards (
  id uuid primary key default gen_random_uuid(),
  deck_id uuid not null references public.decks(id) on delete cascade,
  text text not null check (length(trim(text)) > 0),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cards_deck_id_idx on public.cards(deck_id);
create index if not exists cards_active_idx on public.cards(deck_id, is_active);

-- Automatically create a profile for each new Supabase Auth user.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', 'Sijui admin'));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Keep updated_at current whenever a row changes.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
for each row execute procedure public.set_updated_at();

drop trigger if exists decks_set_updated_at on public.decks;
create trigger decks_set_updated_at before update on public.decks
for each row execute procedure public.set_updated_at();

drop trigger if exists cards_set_updated_at on public.cards;
create trigger cards_set_updated_at before update on public.cards
for each row execute procedure public.set_updated_at();

-- Helper used by the write policies below.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- Row-level security: published decks/cards can be read publicly;
-- only signed-in admin users can create or change them.
alter table public.profiles enable row level security;
alter table public.decks enable row level security;
alter table public.cards enable row level security;

drop policy if exists "Public can read published decks" on public.decks;
create policy "Public can read published decks"
on public.decks for select
using (is_published = true or auth.uid() = created_by);

drop policy if exists "Admins can manage decks" on public.decks;
create policy "Admins can manage decks"
on public.decks for all to authenticated
using (public.is_admin())
with check (public.is_admin() and auth.uid() = created_by);

drop policy if exists "Public can read active cards in published decks" on public.cards;
create policy "Public can read active cards in published decks"
on public.cards for select
using (
  is_active = true and exists (
    select 1 from public.decks d
    where d.id = deck_id and (d.is_published = true or d.created_by = auth.uid())
  )
);

drop policy if exists "Admins can manage cards" on public.cards;
create policy "Admins can manage cards"
on public.cards for all to authenticated
using (public.is_admin())
with check (public.is_admin() and auth.uid() = created_by);

drop policy if exists "Users can read their profile" on public.profiles;
create policy "Users can read their profile"
on public.profiles for select to authenticated
using (auth.uid() = id);

-- After creating your first account, run this once to make it the admin account.
-- Replace the email with the email used in Supabase Authentication.
--
-- update public.profiles
-- set role = 'admin'
-- where id = (select id from auth.users where email = 'you@example.com');

