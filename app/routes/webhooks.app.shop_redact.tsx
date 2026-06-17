import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  orgScoped,
  type OrgScopedTable,
} from "../lib/orgScopedClient.server";
import { getOrgIdForShop, recordSyncLog } from "../lib/shopifySync.server";

/**
 * Mandatory GDPR/compliance webhook: shop/redact.
 *
 * Shopify delivers this ~48 hours after a store uninstalls the app, instructing
 * the app to erase that shop's data. We best-effort delete the shop's
 * org-scoped business data from Supabase. Deletion order respects foreign keys
 * (children before parents): order_items/payments/shipments/returns ->
 * orders -> channel_listings/stock_levels -> products/customers -> channels,
 * with sync_logs cleared last.
 *
 * Tenant isolation: every delete goes through `orgScoped(orgId)`, which filters
 * by `org_id`, so only this shop's rows are removed. The `orgs` row itself and
 * the Prisma session are intentionally left to the existing uninstall flow.
 *
 * Never throws; always acknowledges with 200 so Shopify does not retry.
 */

/** Child-before-parent delete order across the org-scoped tables. */
const REDACT_DELETE_ORDER: OrgScopedTable[] = [
  "order_items",
  "payments",
  "shipments",
  "returns",
  "orders",
  "channel_listings",
  "stock_levels",
  "products",
  "customers",
  "channels",
  "sync_logs",
];

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const orgId = await getOrgIdForShop(shop);
  if (!orgId) {
    console.warn(`${topic}: no org for shop ${shop}; acknowledging.`);
    return new Response();
  }

  const db = orgScoped(orgId);
  const failed: string[] = [];

  // Delete each table best-effort; collect failures but never abort the loop so
  // a single FK/permission hiccup cannot leave the rest of the data behind.
  // orgScoped.delete() already applies the `org_id = orgId` filter, so the
  // delete is both scoped and valid without any extra predicate.
  for (const table of REDACT_DELETE_ORDER) {
    try {
      const { error } = await db.delete(table);
      if (error) throw new Error(error.message);
    } catch (err) {
      failed.push(table);
      console.error(`${topic}: failed to redact ${table} for ${shop}:`, err);
    }
  }

  // Best-effort audit row (sync_logs may itself have just been cleared, which is
  // fine — this simply re-inserts a final record).
  await recordSyncLog({
    orgId,
    eventType: topic,
    status: failed.length === 0 ? "ok" : "error",
    message:
      failed.length === 0
        ? `Redacted org-scoped data for ${shop}.`
        : `Redacted org-scoped data for ${shop}; failures: ${failed.join(", ")}.`,
  });

  return new Response();
};
