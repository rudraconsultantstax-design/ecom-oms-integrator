import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { orgScoped } from "../lib/orgScopedClient.server";
import { getOrgIdForShop } from "../lib/shopifySync.server";

const RECENT_ORDERS_QUERY = `#graphql
  query RecentOrders {
    orders(first: 25, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          name
          createdAt
          displayFinancialStatus
          displayFulfillmentStatus
          totalPriceSet {
            presentmentMoney {
              amount
              currencyCode
            }
          }
          customer {
            displayName
          }
        }
      }
    }
  }`;

interface OrderNode {
  id: string;
  name: string;
  createdAt: string;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  totalPriceSet: {
    presentmentMoney: { amount: string; currencyCode: string };
  };
  customer: { displayName: string | null } | null;
}

interface RecentOrdersResponse {
  data?: {
    orders?: { edges: { node: OrderNode }[] };
  };
}

/**
 * KPI summary computed from the Supabase OMS backend (org-scoped, read-only).
 * `null` means the KPIs could not be loaded (no tenant row yet, or a backend
 * error) — the page still renders the live-from-Shopify orders below as a
 * resilient fallback. `error` carries a short reason for the KPI band only.
 */
interface DashboardKpis {
  totalOrders: number;
  unfulfilled: number;
  returns: number;
  syncErrors24h: number;
}

interface KpiResult {
  kpis: DashboardKpis | null;
  hasOrg: boolean;
  error: string | null;
}

/** A fulfillment_status that means the order still needs fulfilling. */
function isUnfulfilled(status: string | null): boolean {
  if (!status) return true; // null = unfulfilled in the REST/synced convention
  const normalized = status.toUpperCase();
  return normalized !== "FULFILLED" && normalized !== "RESTOCKED";
}

/**
 * Compute the dashboard KPIs from Supabase for a shop. Best-effort: returns a
 * structured result instead of throwing so a backend hiccup degrades the KPI
 * band gracefully without taking down the live-orders view.
 */
async function loadKpis(shop: string): Promise<KpiResult> {
  const orgId = await getOrgIdForShop(shop);
  if (!orgId) {
    return { kpis: null, hasOrg: false, error: null };
  }

  try {
    const db = orgScoped(orgId);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Tenant-scoped, read-only reads of just the columns each KPI needs.
    const [ordersRes, returnsRes, errorsRes] = await Promise.all([
      db.select("orders", "id, fulfillment_status").limit(10000),
      db.select("returns", "id").limit(10000),
      db
        .select("sync_logs", "id")
        .eq("status", "error")
        .gte("created_at", since)
        .limit(10000),
    ]);

    if (ordersRes.error) throw new Error(ordersRes.error.message);
    if (returnsRes.error) throw new Error(returnsRes.error.message);
    if (errorsRes.error) throw new Error(errorsRes.error.message);

    const orderRows =
      (ordersRes.data as unknown as
        | { fulfillment_status: string | null }[]
        | null) ?? [];

    return {
      kpis: {
        totalOrders: orderRows.length,
        unfulfilled: orderRows.filter((o) => isUnfulfilled(o.fulfillment_status))
          .length,
        returns: (returnsRes.data ?? []).length,
        syncErrors24h: (errorsRes.data ?? []).length,
      },
      hasOrg: true,
      error: null,
    };
  } catch (err) {
    return {
      kpis: null,
      hasOrg: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // Live-from-Shopify orders (existing behavior, always the fallback view) and
  // the Supabase-backed KPI band, fetched together.
  const [ordersResponse, kpiResult] = await Promise.all([
    admin.graphql(RECENT_ORDERS_QUERY),
    loadKpis(session.shop),
  ]);

  const body = (await ordersResponse.json()) as RecentOrdersResponse;
  const orders = body.data?.orders?.edges.map((edge) => edge.node) ?? [];

  return { orders, ...kpiResult };
};

function formatMoney(amount: string, currencyCode: string): string {
  const value = Number(amount);
  if (Number.isNaN(value)) {
    return `${amount} ${currencyCode}`;
  }
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode,
    }).format(value);
  } catch {
    // Fallback if currencyCode isn't a valid ISO code for Intl.
    return `${value.toFixed(2)} ${currencyCode}`;
  }
}

function formatDate(iso: string): string {
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

function KpiCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "critical" | "warning";
}) {
  return (
    <s-box
      padding="base"
      borderWidth="base"
      borderRadius="base"
      background="subdued"
      minInlineSize="160px"
    >
      <s-stack direction="block" gap="small-100">
        <s-text tone="neutral">{label}</s-text>
        <s-heading>
          {tone ? <s-text tone={tone}>{value}</s-text> : value}
        </s-heading>
      </s-stack>
    </s-box>
  );
}

function KpiBand({
  kpis,
  hasOrg,
  error,
  loading,
}: KpiResult & { loading: boolean }) {
  if (loading) {
    return (
      <s-stack direction="inline" gap="base" alignItems="center">
        <s-spinner accessibilityLabel="Loading metrics" size="base" />
        <s-text tone="neutral">Loading metrics…</s-text>
      </s-stack>
    );
  }

  if (!hasOrg) {
    return (
      <s-paragraph>
        <s-text tone="neutral">
          This store is still being set up. Key metrics will appear here once
          provisioning completes and data syncs in.
        </s-text>
      </s-paragraph>
    );
  }

  if (error || !kpis) {
    return (
      <s-banner tone="critical" heading="Couldn’t load metrics">
        <s-paragraph>
          The dashboard metrics are temporarily unavailable. Recent orders from
          Shopify are still shown below.
        </s-paragraph>
      </s-banner>
    );
  }

  return (
    <s-stack direction="inline" gap="base">
      <KpiCard label="Total orders" value={kpis.totalOrders} />
      <KpiCard
        label="Unfulfilled"
        value={kpis.unfulfilled}
        tone={kpis.unfulfilled > 0 ? "warning" : undefined}
      />
      <KpiCard label="Returns" value={kpis.returns} />
      <KpiCard
        label="Sync errors (24h)"
        value={kpis.syncErrors24h}
        tone={kpis.syncErrors24h > 0 ? "critical" : undefined}
      />
    </s-stack>
  );
}

export default function OrdersDashboard() {
  const { orders, kpis, hasOrg, error } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const loading = navigation.state === "loading";

  return (
    <s-page heading="Dashboard">
      <s-section heading="Overview">
        <KpiBand
          kpis={kpis}
          hasOrg={hasOrg}
          error={error}
          loading={loading}
        />
      </s-section>

      <s-section heading={`Recent orders (${orders.length})`}>
        {orders.length === 0 ? (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              No orders yet. Orders placed in this store will appear here.
            </s-paragraph>
            <s-paragraph>
              <s-text tone="neutral">
                This is a development store, so it may not have any orders. Create
                a test order in the Shopify admin to see it listed.
              </s-text>
            </s-paragraph>
          </s-stack>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Order</s-table-header>
              <s-table-header>Date</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Total</s-table-header>
              <s-table-header>Payment</s-table-header>
              <s-table-header>Fulfillment</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {orders.map((order) => (
                <s-table-row key={order.id}>
                  <s-table-cell>{order.name}</s-table-cell>
                  <s-table-cell>{formatDate(order.createdAt)}</s-table-cell>
                  <s-table-cell>
                    {order.customer?.displayName ?? "—"}
                  </s-table-cell>
                  <s-table-cell>
                    {formatMoney(
                      order.totalPriceSet.presentmentMoney.amount,
                      order.totalPriceSet.presentmentMoney.currencyCode,
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge>{order.displayFinancialStatus ?? "—"}</s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge>{order.displayFulfillmentStatus ?? "—"}</s-badge>
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
