import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getOrgIdForShop,
  recordSyncLog,
  syncProductWebhook,
} from "../lib/shopifySync.server";

/**
 * PRODUCTS_UPDATE webhook -> idempotent upsert into Supabase `products`, one row
 * per variant (keyed on `(org_id, sku)`), scoped to the shop's org. Mirrors
 * webhooks.app.uninstalled.tsx. Always returns 200 quickly after handling; a
 * missing org is logged and acknowledged so Shopify does not retry indefinitely.
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
    await syncProductWebhook(orgId, topic, payload);
  } catch (err) {
    console.error(`${topic}: failed to sync product for ${shop}:`, err);
    await recordSyncLog({
      orgId,
      eventType: topic,
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return new Response();
};
