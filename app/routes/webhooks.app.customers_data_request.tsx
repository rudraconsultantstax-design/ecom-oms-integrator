import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getOrgIdForShop, recordSyncLog } from "../lib/shopifySync.server";

/**
 * Mandatory GDPR/compliance webhook: customers/data_request.
 *
 * Shopify delivers this when a store customer requests their data (the merchant
 * must surface/hand it over). This app stores no customer PII beyond what syncs
 * into Supabase, so there is nothing to assemble automatically here — we record
 * a best-effort audit row and acknowledge with 200 so Shopify does not retry.
 *
 * Mirrors the other webhook handlers: authenticate first, never throw, return
 * 200 quickly. A missing org is logged and acknowledged.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const orgId = await getOrgIdForShop(shop);
  if (orgId) {
    await recordSyncLog({
      orgId,
      eventType: topic,
      status: "ok",
      message: `GDPR data request received for ${shop}.`,
      payload,
    });
  } else {
    console.warn(`${topic}: no org for shop ${shop}; acknowledging.`);
  }

  return new Response();
};
