import { supabase } from "../supabase.server";

/**
 * Multi-tenant access helper.
 *
 * Every table in the Supabase `public` schema carries an `org_id` column for
 * tenant isolation (docs/PROJECT_ARCHITECTURE.md §3). Since the server uses the
 * service-role key — which bypasses RLS — isolation MUST be enforced here in
 * application code. This helper guarantees that:
 *   - selects/updates/deletes are filtered to a single `org_id`
 *   - inserts have `org_id` stamped onto every row
 *   - callers cannot reassign `org_id` via update (it is stripped)
 *
 * Server-only: it imports the service-role client, so never reference it from
 * client code.
 *
 * NOTE: row payloads are intentionally loosely typed (`OrgScopedRow`) because
 * the database column types are not yet generated in this repo. Once the schema
 * stabilises, run `supabase gen types typescript` and replace `OrgScopedRow`
 * with the generated per-table Row/Insert/Update types for full column safety.
 */

/**
 * Per-tenant data tables. `orgs` is deliberately excluded: it is the tenant
 * table itself (keyed by `id`, not `org_id`), so look organisations up through
 * the raw `supabase` client by `id` rather than through this helper.
 */
export type OrgScopedTable =
  | "customers"
  | "products"
  | "orders"
  | "order_items"
  | "payments"
  | "shipments"
  | "returns"
  | "channels"
  | "channel_listings"
  | "sync_logs";

export type OrgId = string;

/**
 * Loosely-typed row until generated Supabase types are wired in (see above).
 *
 * Writes accept any object shape (`OrgScopedWritableRow`) so callers can pass
 * strongly-typed mapper output (e.g. the `OrderRow`/`ProductRow` interfaces in
 * `shopifySync.server.ts`) without each interface needing an explicit index
 * signature. The `org_id` key is stamped/managed by the helper.
 */
export type OrgScopedRow = Record<string, unknown>;
export type OrgScopedWritableRow = Record<string, unknown> | object;

/**
 * Returns a thin query builder bound to a single organisation. All operations
 * are automatically scoped to `orgId`.
 *
 * @example
 *   const db = orgScoped(orgId);
 *   const { data, error } = await db.select("orders", "id, status");
 *   await db.insert("order_items", [{ order_id, sku, qty }]);
 */
export function orgScoped(orgId: OrgId) {
  if (!orgId) {
    throw new Error("orgScoped requires a non-empty orgId for tenant isolation.");
  }

  return {
    orgId,

    /** SELECT scoped to this org. */
    select(table: OrgScopedTable, columns = "*") {
      return supabase.from(table).select(columns).eq("org_id", orgId);
    },

    /** INSERT with `org_id` stamped onto every row; returns the inserted rows. */
    insert(
      table: OrgScopedTable,
      rows: OrgScopedWritableRow | OrgScopedWritableRow[],
    ) {
      const stamped = Array.isArray(rows)
        ? rows.map((row) => ({ ...row, org_id: orgId }))
        : { ...rows, org_id: orgId };
      return supabase.from(table).insert(stamped).select();
    },

    /**
     * Idempotent UPSERT with `org_id` stamped onto every row. Use for
     * webhook-driven sync where the same Shopify resource can arrive more than
     * once (Shopify delivers at-least-once) — re-delivery updates the existing
     * row instead of erroring or duplicating.
     *
     * `onConflict` must be a unique constraint that INCLUDES the scoping
     * (e.g. `"channel_id,external_id"` for orders, `"org_id,sku"` for products)
     * so the conflict target is tenant-safe.
     *
     * @example
     *   await db.upsert("orders", row, "channel_id,external_id");
     */
    upsert(
      table: OrgScopedTable,
      rows: OrgScopedWritableRow | OrgScopedWritableRow[],
      onConflict: string,
    ) {
      const stamped = Array.isArray(rows)
        ? rows.map((row) => ({ ...row, org_id: orgId }))
        : { ...rows, org_id: orgId };
      return supabase
        .from(table)
        .upsert(stamped, { onConflict })
        .select();
    },

    /**
     * UPDATE scoped to this org. Any `org_id` in `values` is stripped so a row
     * can never be moved to another tenant.
     */
    update(table: OrgScopedTable, values: OrgScopedRow) {
      // Strip any caller-supplied `org_id` so a row can never be reassigned to
      // another tenant via update.
      const safeValues: OrgScopedRow = { ...values };
      delete safeValues.org_id;
      return supabase.from(table).update(safeValues).eq("org_id", orgId);
    },

    /** DELETE scoped to this org. */
    delete(table: OrgScopedTable) {
      return supabase.from(table).delete().eq("org_id", orgId);
    },
  };
}

export type OrgScopedClient = ReturnType<typeof orgScoped>;
