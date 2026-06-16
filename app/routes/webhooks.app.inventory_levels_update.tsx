import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getOrgIdForShop,
  recordSyncLog,
  syncInventoryLevelWebhook,
} from "../lib/shopifySync.server";

/**
 * INVENTORY_LEVELS_UPDATE webhook -> idempotent upsert into Supabase
 * `stock_levels`, one row per (org, inventory item, location), scoped to the
 * shop's org. Mirrors webhooks.app.products_update.tsx. The upsert on
 * `(org_id, inventory_item_id, location_id)` makes a re-delivery update the row
 * in place. Always returns 200 quickly after handling; a missing org is logged
 * and acknowledged so Shopify does not retry indefinitely.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const orgId = await getOrgIdForShop(shop);
  if (!orgId) {
    console.warn(`${topic}: no org for shop ${shop}; acknowledging.`);
    return new Response();
  }

  try {
    await syncInventoryLevelWebhook(orgId, topic, payload);
  } catch (err) {
    console.error(`${topic}: failed to sync inventory level for ${shop}:`, err);
    await recordSyncLog({
      orgId,
      eventType: topic,
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return new Response();
};
