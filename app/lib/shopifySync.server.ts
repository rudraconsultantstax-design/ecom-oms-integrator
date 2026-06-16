import { supabase } from "../supabase.server";
import { orgScoped, type OrgId } from "./orgScopedClient.server";

/**
 * Shopify -> Supabase sync helpers (webhook-driven).
 *
 * These functions back the `webhooks.app.orders_*` / `webhooks.app.products_update`
 * route handlers. They:
 *   - resolve a Shopify shop domain to its tenant `org_id` (same key
 *     `provisionOrg` uses: `orgs.shop_domain`),
 *   - ensure a per-tenant Shopify sales channel exists (the `orders` table
 *     requires a NOT NULL `channel_id`, unique on `(channel_id, external_id)`),
 *   - map the REST-shaped webhook payload onto the EXACT Supabase columns, and
 *   - record a best-effort audit row in `sync_logs`.
 *
 * Tenant isolation is enforced in application code via `orgScoped(orgId)` (the
 * service-role client bypasses RLS — see app/supabase.server.ts).
 *
 * Server-only: imports the service-role client.
 */

/** Marks every audit/sync row written by these webhook handlers. */
export const SYNC_SOURCE = "shopify-webhook";

/**
 * Identity of the per-tenant Shopify channel. `channels` is unique on
 * `(org_id, platform, name)`; keeping `platform`/`name` stable makes channel
 * resolution idempotent and aligns with the seeded `shopify` channel.
 */
const SHOPIFY_CHANNEL_PLATFORM = "shopify";
const SHOPIFY_CHANNEL_NAME = "Shopify";

/**
 * Resolve a Shopify shop domain to its tenant `org_id`.
 *
 * Returns `null` when no org exists for the shop (e.g. a webhook arrived before
 * install provisioning finished, or after teardown) so callers can log-and-200
 * instead of throwing. `orgs` is the tenant table (keyed by `id`), so this uses
 * the raw service-role client by `shop_domain`.
 */
export async function getOrgIdForShop(
  shopDomain: string,
): Promise<OrgId | null> {
  if (!shopDomain) return null;

  const { data, error } = await supabase
    .from("orgs")
    .select("id")
    .eq("shop_domain", shopDomain)
    .maybeSingle();

  if (error || !data) return null;
  return data.id as OrgId;
}

/**
 * Ensure a Shopify sales channel exists for this org and return its `id`.
 *
 * Idempotent and race-safe via `ON CONFLICT (org_id, platform, name)`: the
 * insert is ignored when the channel already exists, then the row is read back.
 * Used as `orders.channel_id`.
 */
export async function ensureShopifyChannelId(orgId: OrgId): Promise<string> {
  // Insert-if-new; never clobber an existing channel's status/config.
  const { error: upsertError } = await supabase
    .from("channels")
    .upsert(
      {
        org_id: orgId,
        platform: SHOPIFY_CHANNEL_PLATFORM,
        name: SHOPIFY_CHANNEL_NAME,
        status: "connected",
      },
      { onConflict: "org_id,platform,name", ignoreDuplicates: true },
    );

  if (upsertError) {
    throw new Error(
      `ensureShopifyChannelId: failed to upsert Shopify channel for org "${orgId}": ${upsertError.message}`,
    );
  }

  const { data, error } = await supabase
    .from("channels")
    .select("id")
    .eq("org_id", orgId)
    .eq("platform", SHOPIFY_CHANNEL_PLATFORM)
    .eq("name", SHOPIFY_CHANNEL_NAME)
    .single();

  if (error || !data) {
    throw new Error(
      `ensureShopifyChannelId: channel row missing after upsert for org "${orgId}": ${error?.message ?? "no row returned"}`,
    );
  }

  return data.id as string;
}

/** Best-effort audit log. Never throws — sync logging must not fail a webhook. */
export async function recordSyncLog(args: {
  orgId: OrgId;
  channelId?: string | null;
  eventType: string;
  status?: "ok" | "skipped" | "error";
  message?: string;
  payload?: unknown;
}): Promise<void> {
  try {
    // `sync_logs.id` is GENERATED ALWAYS AS IDENTITY — never supply it.
    await supabase.from("sync_logs").insert({
      org_id: args.orgId,
      channel_id: args.channelId ?? null,
      source: SYNC_SOURCE,
      event_type: args.eventType,
      status: args.status ?? "ok",
      message: args.message ?? null,
      payload: (args.payload ?? null) as never,
    });
  } catch (err) {
    // Swallow: logging is best-effort. Surface to server logs only.
    console.error(
      `recordSyncLog: failed to write sync log (${args.eventType}):`,
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Payload mapping (Shopify REST webhook shape -> Supabase columns)
// ---------------------------------------------------------------------------

/**
 * Shopify webhooks deliver REST-shaped JSON (numeric `id`, `line_items`, …).
 * The existing Supabase rows store `external_id` as the Admin GraphQL GID
 * (e.g. `gid://shopify/Order/123`), so we reconstruct the GID from the numeric
 * id to stay consistent with data written by the dashboard/sync jobs.
 */
function toGid(
  resource: "Order" | "Product" | "InventoryItem" | "Location",
  id: unknown,
): string {
  return `gid://shopify/${resource}/${String(id)}`;
}

/** Parse a Shopify money string ("12.34") to a number, or null when absent. */
function money(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.length > 0 ? s : null;
}

/** Minimal shape of the fields we read off an orders/* webhook payload. */
interface ShopifyOrderPayload {
  id?: number | string;
  name?: string;
  order_number?: number | string;
  created_at?: string;
  processed_at?: string;
  financial_status?: string | null;
  fulfillment_status?: string | null;
  current_subtotal_price?: string;
  subtotal_price?: string;
  total_shipping_price_set?: { shop_money?: { amount?: string } };
  total_tax?: string;
  current_total_discounts?: string;
  total_discounts?: string;
  current_total_price?: string;
  total_price?: string;
  currency?: string;
  payment_gateway_names?: string[];
  shipping_address?: {
    city?: string | null;
    province?: string | null;
    province_code?: string | null;
    zip?: string | null;
  } | null;
  line_items?: ShopifyLineItem[];
}

interface ShopifyLineItem {
  sku?: string | null;
  title?: string | null;
  name?: string | null;
  quantity?: number;
  price?: string;
}

/** Row shape written to `orders` (org_id is stamped by orgScoped.upsert). */
export interface OrderRow {
  channel_id: string;
  external_id: string;
  order_number: string | null;
  placed_at: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  subtotal: number | null;
  shipping: number | null;
  tax: number | null;
  discount: number | null;
  total: number | null;
  currency: string | null;
  payment_method: string | null;
  ship_city: string | null;
  ship_state: string | null;
  ship_pincode: string | null;
  raw: Record<string, unknown>;
  synced_at: string;
}

/**
 * Map an orders/create or orders/updated payload onto the `orders` columns.
 *
 * Status fields are upper-cased to match the convention already in the table
 * (`PAID`, `FULFILLED`, …). `fulfillment_status` is null on unfulfilled orders
 * in the REST payload, which we preserve. `external_id` is the order GID.
 */
export function mapOrder(
  payload: ShopifyOrderPayload,
  channelId: string,
): OrderRow {
  const shippingAmount =
    payload.total_shipping_price_set?.shop_money?.amount ?? null;

  return {
    channel_id: channelId,
    external_id: toGid("Order", payload.id),
    order_number: str(payload.name ?? payload.order_number),
    placed_at: str(payload.created_at ?? payload.processed_at),
    financial_status: str(payload.financial_status)?.toUpperCase() ?? null,
    fulfillment_status: str(payload.fulfillment_status)?.toUpperCase() ?? null,
    subtotal: money(payload.current_subtotal_price ?? payload.subtotal_price),
    shipping: money(shippingAmount),
    tax: money(payload.total_tax),
    discount: money(
      payload.current_total_discounts ?? payload.total_discounts,
    ),
    total: money(payload.current_total_price ?? payload.total_price),
    currency: str(payload.currency),
    payment_method: payload.payment_gateway_names?.length
      ? payload.payment_gateway_names.join(", ")
      : null,
    ship_city: str(payload.shipping_address?.city),
    ship_state: str(
      payload.shipping_address?.province ??
        payload.shipping_address?.province_code,
    ),
    ship_pincode: str(payload.shipping_address?.zip),
    raw: payload as unknown as Record<string, unknown>,
    synced_at: new Date().toISOString(),
  };
}

/** Row shape written to `order_items` (org_id + order_id stamped by caller). */
export interface OrderItemRow {
  order_id: string;
  sku: string | null;
  title: string | null;
  quantity: number;
  unit_price: number | null;
  total: number | null;
  raw: Record<string, unknown>;
}

/** Map a payload's `line_items[]` onto `order_items` rows for a given order. */
export function mapOrderItems(
  payload: ShopifyOrderPayload,
  orderId: string,
): OrderItemRow[] {
  const lineItems = payload.line_items ?? [];
  return lineItems.map((li) => {
    const quantity = Number.isFinite(li.quantity) ? Number(li.quantity) : 1;
    const unitPrice = money(li.price);
    return {
      order_id: orderId,
      sku: str(li.sku),
      title: str(li.title ?? li.name),
      quantity,
      unit_price: unitPrice,
      total: unitPrice !== null ? unitPrice * quantity : null,
      raw: li as unknown as Record<string, unknown>,
    };
  });
}

/**
 * End-to-end handler for an orders/create or orders/updated webhook:
 * resolve the Shopify channel, idempotently upsert the order, then replace its
 * line items (order_items has no natural unique key, so the existing set is
 * cleared and re-inserted). Records a best-effort `sync_logs` row. Throws on a
 * hard failure so the caller can log-and-acknowledge.
 */
export async function syncOrderWebhook(
  orgId: OrgId,
  topic: string,
  payload: unknown,
): Promise<void> {
  const channelId = await ensureShopifyChannelId(orgId);
  const db = orgScoped(orgId);

  const orderRow = mapOrder(payload as ShopifyOrderPayload, channelId);
  const { data: upserted, error } = await db.upsert(
    "orders",
    orderRow,
    "channel_id,external_id",
  );
  if (error) throw new Error(error.message);

  const orderId = (upserted?.[0] as { id?: string } | undefined)?.id;

  if (orderId) {
    const { error: deleteError } = await db
      .delete("order_items")
      .eq("order_id", orderId);
    if (deleteError) throw new Error(deleteError.message);

    const items = mapOrderItems(payload as ShopifyOrderPayload, orderId);
    if (items.length > 0) {
      const { error: itemsError } = await db.insert("order_items", items);
      if (itemsError) throw new Error(itemsError.message);
    }
  }

  await recordSyncLog({
    orgId,
    channelId,
    eventType: topic,
    status: "ok",
    message: `Upserted order ${orderRow.order_number ?? orderRow.external_id}`,
  });
}

/** Minimal shape of the fields we read off a products/update webhook payload. */
interface ShopifyProductPayload {
  id?: number | string;
  title?: string;
  handle?: string;
  status?: string | null;
  product_type?: string | null;
  variants?: ShopifyVariant[];
}

interface ShopifyVariant {
  sku?: string | null;
  price?: string;
  compare_at_price?: string | null;
  title?: string | null;
}

/** Row shape written to `products` (org_id stamped by orgScoped.upsert). */
export interface ProductRow {
  sku: string;
  title: string;
  category: string | null;
  selling_price: number | null;
  mrp: number | null;
  status: string;
  updated_at: string;
}

/**
 * Map a products/update payload to one `products` row per variant.
 *
 * `products` is keyed (uniquely) on `(org_id, sku)`, so each Shopify variant
 * with a SKU becomes its own row. Variants without a SKU are skipped (the
 * column is NOT NULL and forms the conflict target). `selling_price` is the
 * variant price; `mrp` is the compare-at price when present. `status` maps
 * Shopify's product status to the table default vocabulary ('active').
 */
export function mapProducts(payload: ShopifyProductPayload): ProductRow[] {
  const variants = payload.variants ?? [];
  const status =
    str(payload.status)?.toLowerCase() === "active" ? "active" : "inactive";
  const now = new Date().toISOString();

  const rows: ProductRow[] = [];
  for (const variant of variants) {
    const sku = str(variant.sku);
    if (!sku) continue; // SKU is the NOT NULL conflict key; skip if absent.

    const variantTitle = str(variant.title);
    const baseTitle = str(payload.title) ?? sku;
    const title =
      variantTitle && variantTitle !== "Default Title"
        ? `${baseTitle} - ${variantTitle}`
        : baseTitle;

    rows.push({
      sku,
      title,
      category: str(payload.product_type),
      selling_price: money(variant.price),
      mrp: money(variant.compare_at_price),
      status,
      updated_at: now,
    });
  }
  return rows;
}

/**
 * End-to-end handler for a products/update webhook: idempotently upsert one
 * `products` row per variant (keyed on `(org_id, sku)`). Records a best-effort
 * `sync_logs` row. Throws on a hard failure so the caller can log-and-acknowledge.
 */
export async function syncProductWebhook(
  orgId: OrgId,
  topic: string,
  payload: unknown,
): Promise<void> {
  const db = orgScoped(orgId);
  const rows = mapProducts(payload as ShopifyProductPayload);

  if (rows.length === 0) {
    await recordSyncLog({
      orgId,
      eventType: topic,
      status: "skipped",
      message: "No variants with a SKU to upsert.",
    });
    return;
  }

  const { error } = await db.upsert("products", rows, "org_id,sku");
  if (error) throw new Error(error.message);

  await recordSyncLog({
    orgId,
    eventType: topic,
    status: "ok",
    message: `Upserted ${rows.length} product variant(s).`,
  });
}

/**
 * Minimal shape of the fields we read off an inventory_levels/update webhook.
 *
 * Shopify delivers REST-shaped JSON with numeric `inventory_item_id` /
 * `location_id` and an integer `available` quantity, e.g.
 *   { "inventory_item_id": 808950810, "location_id": 905684977,
 *     "available": 6, "updated_at": "2024-01-01T00:00:00-05:00" }
 */
interface ShopifyInventoryLevelPayload {
  inventory_item_id?: number | string;
  location_id?: number | string;
  available?: number | string | null;
  updated_at?: string;
}

/** Row shape written to `stock_levels` (org_id is stamped by orgScoped.upsert). */
export interface StockLevelRow {
  inventory_item_id: string;
  location_id: string;
  available: number | null;
  raw: Record<string, unknown>;
  synced_at: string;
}

/**
 * Map an inventory_levels/update payload onto the `stock_levels` columns.
 *
 * `inventory_item_id` / `location_id` are reconstructed as Admin GraphQL GIDs to
 * match the `external_id` convention used by the orders/products sync. They form
 * the tenant-safe conflict target `(org_id, inventory_item_id, location_id)`.
 */
export function mapInventoryLevel(
  payload: ShopifyInventoryLevelPayload,
): StockLevelRow {
  const available =
    payload.available === null || payload.available === undefined
      ? null
      : Number(payload.available);

  return {
    inventory_item_id: toGid("InventoryItem", payload.inventory_item_id),
    location_id: toGid("Location", payload.location_id),
    available: available !== null && Number.isFinite(available) ? available : null,
    raw: payload as unknown as Record<string, unknown>,
    synced_at: str(payload.updated_at) ?? new Date().toISOString(),
  };
}

/**
 * End-to-end handler for an inventory_levels/update webhook: idempotently upsert
 * the `stock_levels` row for this (org, inventory item, location), keyed on
 * `(org_id, inventory_item_id, location_id)`. Records a best-effort `sync_logs`
 * row. Throws on a hard failure so the caller can log-and-acknowledge.
 */
export async function syncInventoryLevelWebhook(
  orgId: OrgId,
  topic: string,
  payload: unknown,
): Promise<void> {
  const db = orgScoped(orgId);
  const row = mapInventoryLevel(payload as ShopifyInventoryLevelPayload);

  const { error } = await db.upsert(
    "stock_levels",
    row,
    "org_id,inventory_item_id,location_id",
  );
  if (error) throw new Error(error.message);

  await recordSyncLog({
    orgId,
    eventType: topic,
    status: "ok",
    message: `Upserted stock level for ${row.inventory_item_id} @ ${row.location_id} (available: ${row.available ?? "n/a"}).`,
  });
}
