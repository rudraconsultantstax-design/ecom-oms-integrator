import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { orgScoped } from "../lib/orgScopedClient.server";
import { getOrgIdForShop } from "../lib/shopifySync.server";

/**
 * Supabase-backed Orders view. Reads the most recent `orders` rows synced into
 * the backend (by the orders/* webhooks) for the installing shop's org. This
 * complements the live-from-Shopify list on app._index.tsx: that one shows what
 * is in Shopify right now, this one shows what has actually landed in the OMS
 * backend — useful for confirming sync and as the basis for OMS workflows.
 */
interface OrderRow {
  id: string;
  order_number: string | null;
  placed_at: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  total: number | null;
  currency: string | null;
  ship_city: string | null;
  ship_state: string | null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const orgId = await getOrgIdForShop(session.shop);
  if (!orgId) {
    // App authenticated but no tenant row yet (provisioning not finished).
    return { orders: [] as OrderRow[], hasOrg: false };
  }

  const db = orgScoped(orgId);
  const { data, error } = await db
    .select(
      "orders",
      "id, order_number, placed_at, financial_status, fulfillment_status, total, currency, ship_city, ship_state",
    )
    .order("placed_at", { ascending: false, nullsFirst: false })
    .limit(50);

  if (error) {
    throw new Response(`Failed to load orders: ${error.message}`, {
      status: 500,
    });
  }

  return { orders: (data ?? []) as unknown as OrderRow[], hasOrg: true };
};

function formatMoney(amount: number | null, currency: string | null): string {
  if (amount === null) {
    return "—";
  }
  const currencyCode = currency ?? "INR";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode,
    }).format(amount);
  } catch {
    // Fallback if currency isn't a valid ISO code for Intl.
    return `${amount.toFixed(2)} ${currencyCode}`;
  }
}

function formatDate(iso: string | null): string {
  if (!iso) {
    return "—";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatLocation(city: string | null, state: string | null): string {
  const parts = [city, state].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(", ") : "—";
}

export default function OrdersFromBackend() {
  const { orders, hasOrg } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Orders">
      <s-section heading={`Synced orders (${orders.length})`}>
        {!hasOrg ? (
          <s-paragraph>
            <s-text tone="neutral">
              This store is still being set up. Orders will appear here once
              provisioning completes and the first orders sync in.
            </s-text>
          </s-paragraph>
        ) : orders.length === 0 ? (
          <s-stack direction="block" gap="base">
            <s-paragraph>No orders have synced into the backend yet.</s-paragraph>
            <s-paragraph>
              <s-text tone="neutral">
                Orders are written here by the order webhooks. Create or update an
                order in Shopify to see it land in the OMS backend. The Home page
                shows orders live from Shopify; this page shows what has synced.
              </s-text>
            </s-paragraph>
          </s-stack>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Order</s-table-header>
              <s-table-header>Placed</s-table-header>
              <s-table-header>Destination</s-table-header>
              <s-table-header>Total</s-table-header>
              <s-table-header>Payment</s-table-header>
              <s-table-header>Fulfillment</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {orders.map((order) => (
                <s-table-row key={order.id}>
                  <s-table-cell>{order.order_number ?? "—"}</s-table-cell>
                  <s-table-cell>{formatDate(order.placed_at)}</s-table-cell>
                  <s-table-cell>
                    {formatLocation(order.ship_city, order.ship_state)}
                  </s-table-cell>
                  <s-table-cell>
                    {formatMoney(order.total, order.currency)}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge>{order.financial_status ?? "—"}</s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge>{order.fulfillment_status ?? "—"}</s-badge>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

// Shopify needs React Router to catch some thrown responses, so their headers
// are included in the response.
export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
