-- Inventory levels synced from Shopify (and, later, other channels).
-- One row per (org, inventory item, location). Backs the
-- inventory_levels/update webhook -> Supabase sync in the OMS app
-- (app/routes/webhooks.app.inventory_levels_update.tsx ->
-- app/lib/shopifySync.server.ts: syncInventoryLevelWebhook).
--
-- Multi-tenant by org_id (see docs/PROJECT_ARCHITECTURE.md section 3); isolation
-- is enforced in application code via app/lib/orgScopedClient.server.ts because
-- the service role bypasses RLS. Idempotent / safe to re-run.
--
-- Shopify identifiers are stored as Admin GraphQL GIDs
-- (gid://shopify/InventoryItem/<id>, gid://shopify/Location/<id>) to match the
-- external_id convention already used by the orders/products sync.

create table if not exists public.stock_levels (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  inventory_item_id text not null,
  location_id text not null,
  available integer,
  raw jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Conflict target for the idempotent upsert (tenant-safe: includes org_id).
create unique index if not exists stock_levels_org_item_location_key
  on public.stock_levels (org_id, inventory_item_id, location_id);

-- Common lookup: all stock for one org.
create index if not exists stock_levels_org_id_idx
  on public.stock_levels (org_id);

alter table public.stock_levels enable row level security;
