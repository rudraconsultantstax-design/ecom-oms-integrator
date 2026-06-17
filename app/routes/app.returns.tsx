import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { orgScoped } from "../lib/orgScopedClient.server";
import { getOrgIdForShop } from "../lib/shopifySync.server";

/**
 * Supabase-backed Returns view. Reads the `returns` rows for the installing
 * shop's org. Columns mapped from the `returns` table:
 *   id, order_id, reason, status, amount, created_at.
 * Mirrors app.orders.tsx / app.sync.tsx: org-scoped read, Polaris web-component
 * table, with not-provisioned / empty / error states.
 */
interface ReturnRow {
  id: string;
  order_id: string | null;
  reason: string | null;
  status: string | null;
  amount: number | null;
  created_at: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const orgId = await getOrgIdForShop(session.shop);
  if (!orgId) {
    // App authenticated but no tenant row yet (provisioning not finished).
    return { returns: [] as ReturnRow[], hasOrg: false };
  }

  const db = orgScoped(orgId);
  const { data, error } = await db
    .select("returns", "id, order_id, reason, status, amount, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    throw new Response(`Failed to load returns: ${error.message}`, {
      status: 500,
    });
  }

  return { returns: (data ?? []) as unknown as ReturnRow[], hasOrg: true };
};

function formatMoney(amount: number | null): string {
  if (amount === null) {
    return "—";
  }
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "INR",
    }).format(amount);
  } catch {
    return amount.toFixed(2);
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

function statusTone(
  status: string | null,
): "success" | "critical" | "warning" | "neutral" {
  switch ((status ?? "").toLowerCase()) {
    case "completed":
    case "refunded":
    case "resolved":
      return "success";
    case "rejected":
    case "cancelled":
    case "canceled":
      return "critical";
    case "pending":
    case "requested":
    case "open":
      return "warning";
    default:
      return "neutral";
  }
}

export default function ReturnsPage() {
  const { returns, hasOrg } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Returns">
      <s-section heading={`Returns (${returns.length})`}>
        {!hasOrg ? (
          <s-paragraph>
            <s-text tone="neutral">
              This store is still being set up. Returns will appear here once
              provisioning completes and data syncs in.
            </s-text>
          </s-paragraph>
        ) : returns.length === 0 ? (
          <s-stack direction="block" gap="base">
            <s-paragraph>No returns yet.</s-paragraph>
            <s-paragraph>
              <s-text tone="neutral">
                Returns recorded for this store will appear here, including the
                reason, status, and refunded amount.
              </s-text>
            </s-paragraph>
          </s-stack>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Created</s-table-header>
              <s-table-header>Order</s-table-header>
              <s-table-header>Reason</s-table-header>
              <s-table-header>Amount</s-table-header>
              <s-table-header>Status</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {returns.map((row) => (
                <s-table-row key={row.id}>
                  <s-table-cell>{formatDate(row.created_at)}</s-table-cell>
                  <s-table-cell>{row.order_id ?? "—"}</s-table-cell>
                  <s-table-cell>{row.reason ?? "—"}</s-table-cell>
                  <s-table-cell>{formatMoney(row.amount)}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={statusTone(row.status)}>
                      {row.status ?? "—"}
                    </s-badge>
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
