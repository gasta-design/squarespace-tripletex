-- Squarespace -> Tripletex integrasjon: databaseskjema (idempotent – trygt å kjøre flere ganger)
-- Alle tabeller er kun tilgjengelige via service role (Edge Functions).
-- RLS er aktivert uten policyer, så anon/authenticated-nøkler får ingen tilgang.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default false,

  -- Squarespace
  sqs_api_key_enc text,                      -- kryptert (AES-GCM)

  -- Tripletex
  tx_environment text not null default 'production' check (tx_environment in ('production','test')),
  tx_auth_mode text not null default 'api_token' check (tx_auth_mode in ('api_token','consumer_employee')),
  tx_api_token_enc text,                     -- JWT API-token (intern integrasjon)
  tx_consumer_token_enc text,                -- kommersiell integrasjon
  tx_employee_token_enc text,
  tx_company_id text not null default '0',   -- 0 = selskapet til token-eieren

  -- Innstillinger for synkronisering
  settings jsonb not null default '{}'::jsonb,   -- se DEFAULT_SETTINGS i sync.ts

  sync_from timestamptz,                     -- ordre endret etter dette tidspunktet synkroniseres
  orders_watermark timestamptz,
  products_watermark timestamptz,
  locked_until timestamptz,
  last_run_at timestamptz,
  last_run_status text,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.synced_orders (
  id bigserial primary key,
  client_id uuid not null references public.clients(id) on delete cascade,
  sqs_order_id text not null,
  sqs_order_number text,
  sqs_modified_on timestamptz,
  status text not null check (status in ('done','error','skipped')),
  tx_customer_id bigint,
  tx_order_id bigint,
  tx_invoice_id bigint,
  tx_invoice_number text,
  attempts int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, sqs_order_id)
);
create index if not exists synced_orders_client_status_idx on public.synced_orders (client_id, status);

create table if not exists public.product_map (
  client_id uuid not null references public.clients(id) on delete cascade,
  product_number text not null,
  tx_product_id bigint not null,
  updated_at timestamptz not null default now(),
  primary key (client_id, product_number)
);

create table if not exists public.customer_map (
  client_id uuid not null references public.clients(id) on delete cascade,
  email text not null,
  tx_customer_id bigint not null,
  updated_at timestamptz not null default now(),
  primary key (client_id, email)
);

create table if not exists public.sync_runs (
  id bigserial primary key,
  client_id uuid not null references public.clients(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',
  trigger text,
  orders_synced int not null default 0,
  orders_failed int not null default 0,
  products_synced int not null default 0,
  message text
);
create index if not exists sync_runs_client_started_idx on public.sync_runs (client_id, started_at desc);

alter table public.clients enable row level security;
alter table public.synced_orders enable row level security;
alter table public.product_map enable row level security;
alter table public.customer_map enable row level security;
alter table public.sync_runs enable row level security;

-- Atomisk lås slik at to kjøringer for samme klient ikke overlapper
create or replace function public.try_lock_client(p_client_id uuid, p_seconds int default 300)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update clients set locked_until = now() + make_interval(secs => p_seconds)
   where id = p_client_id and (locked_until is null or locked_until < now());
  get diagnostics n = row_count;
  return n = 1;
end $$;

create or replace function public.unlock_client(p_client_id uuid)
returns void language sql security definer set search_path = public as $$
  update clients set locked_until = null where id = p_client_id;
$$;

revoke all on function public.try_lock_client(uuid, int) from public, anon, authenticated;
revoke all on function public.unlock_client(uuid) from public, anon, authenticated;

-- Rydd gamle kjøringslogger (beholder 30 dager)
create or replace function public.prune_sync_runs()
returns void language sql security definer set search_path = public as $$
  delete from sync_runs where started_at < now() - interval '30 days';
$$;
revoke all on function public.prune_sync_runs() from public, anon, authenticated;

grant execute on function public.try_lock_client(uuid, int) to service_role;
grant execute on function public.unlock_client(uuid) to service_role;
grant execute on function public.prune_sync_runs() to service_role;
