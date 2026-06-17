import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { orgScoped } from "../lib/orgScopedClient.server";
import { getOrgIdForShop, recordSyncLog } from "../lib/shopifySync.server";

/**
 * Mandatory GDPR/compliance webhook: customers/redact.
 *
 * Shopify delivers this (typically 10 days after an app is uninstalled, or on
 * an explicit erasure request) to tell the app to delete a specific customer's
 * personal data. We best-effort delete the matching `customers` row(s) for the
 * shop's org, keyed by the customer email in the payload (the `customers` table
 * has no Shopify-id column, but does carry `email`).
 *
 * Never throws; always acknowledges with 200 so Shopify does not retry.
 */
interface CustomersRedactPayload {
  shop_domain?: string;
  customer?: {
    id?: number | string;
    email?: string | null;
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const orgId = await getOrgIdForShop(shop);
  if (!orgId) {
    console.warn(`${topic}: no org for shop ${shop}; acknowledging.`);
    return new Response();
  }

  const email = (payload as CustomersRedactPayload)?.customer?.email ?? null;

  let message = "No customer email in payload; nothing to redact.";
  let status: "ok" | "error" = "ok";

  if (email) {
    try {
      const db = orgScoped(orgId);
      const { error } = await db.delete("customers").eq("email", email);
      if (error) throw new Error(error.message);
      message = `Redacted customer data for the requested customer.`;
    } catch (err) {
      status = "error";
      message = err instanceof Error ? err.message : String(err);
      console.error(`${topic}: failed to redact customer for ${shop}:`, err);
    }
  }

  await recordSyncLog({ orgId, eventType: topic, status, message });

  return new Response();
};
