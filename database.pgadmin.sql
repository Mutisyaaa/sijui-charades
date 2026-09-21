-- Sijui Charades - local PostgreSQL / pgAdmin setup
-- Run the first statement while connected to the postgres database.
-- Then connect to sijui_charades and run the remaining statements.

CREATE DATABASE sijui_charades;

-- Run everything below after connecting to the sijui_charades database.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  email text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx
  ON public.users (lower(email));

CREATE TABLE IF NOT EXISTS public.sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_expires_at_idx
  ON public.sessions(expires_at);

CREATE TABLE IF NOT EXISTS public.decks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  icon text NOT NULL DEFAULT '🎭',
  theme text NOT NULL DEFAULT 'classic',
  cover_url text,
  is_published boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deck_id uuid NOT NULL REFERENCES public.decks(id) ON DELETE CASCADE,
  text text NOT NULL CHECK (length(trim(text)) > 0),
  category text NOT NULL DEFAULT 'General',
  difficulty text NOT NULL DEFAULT 'medium',
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cards_deck_id_idx ON public.cards(deck_id);
CREATE INDEX IF NOT EXISTS cards_active_idx ON public.cards(deck_id, is_active);

CREATE TABLE IF NOT EXISTS public.content_seeds (
  seed_key text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.decks ADD COLUMN IF NOT EXISTS icon text NOT NULL DEFAULT '🎭';
ALTER TABLE public.decks ADD COLUMN IF NOT EXISTS theme text NOT NULL DEFAULT 'classic';
ALTER TABLE public.decks ADD COLUMN IF NOT EXISTS cover_url text;
ALTER TABLE public.cards ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'General';
ALTER TABLE public.cards ADD COLUMN IF NOT EXISTS difficulty text NOT NULL DEFAULT 'medium';

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_set_updated_at ON public.users;
CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON public.users
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS decks_set_updated_at ON public.decks;
CREATE TRIGGER decks_set_updated_at
BEFORE UPDATE ON public.decks
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS cards_set_updated_at ON public.cards;
CREATE TRIGGER cards_set_updated_at
BEFORE UPDATE ON public.cards
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- After your first signup, promote that account to admin:
-- UPDATE public.users SET role = 'admin' WHERE email = 'you@example.com';
