import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getOrgIdForShop,
  recordSyncLog,
  syncOrderWebhook,
} from "../lib/shopifySync.server";

/**
 * ORDERS_UPDATED webhook -> idempotent upsert into Supabase `orders` (+ its
 * `order_items`), scoped to the shop's org. Same handling as orders/create:
 * the upsert on `(channel_id, external_id)` makes a re-sync of an existing
 * order update it in place. Always returns 200 quickly after handling.
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
    await syncOrderWebhook(orgId, topic, payload);
  } catch (err) {
    console.error(`${topic}: failed to sync order for ${shop}:`, err);
    await recordSyncLog({
      orgId,
      eventType: topic,
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return new Response();
};
