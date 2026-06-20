import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { orgScoped } from "../lib/orgScopedClient.server";
import { getOrgIdForShop } from "../lib/shopifySync.server";

interface SyncLogRow {
  id: number;
  source: string | null;
  event_type: string | null;
  status: string;
  message: string | null;
  created_at: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const orgId = await getOrgIdForShop(session.shop);
  if (!orgId) {
    // App authenticated but no tenant row yet (provisioning not finished).
    return { logs: [] as SyncLogRow[], hasOrg: false };
  }

  const db = orgScoped(orgId);
  const { data, error } = await db
    .select("sync_logs", "id, source, event_type, status, message, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    throw new Response(`Failed to load sync logs: ${error.message}`, {
      status: 500,
    });
  }

  return { logs: (data ?? []) as unknown as SyncLogRow[], hasOrg: true };
};

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusTone(status: string): "success" | "critical" | "warning" | "neutral" {
  switch (status.toLowerCase()) {
    case "ok":
      return "success";
    case "error":
      return "critical";
    case "skipped":
      return "warning";
    default:
      return "neutral";
  }
}

export default function SyncStatus() {
  const { logs, hasOrg } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Sync status">
      <s-section heading={`Recent sync activity (${logs.length})`}>
        {!hasOrg ? (
          <s-paragraph>
            <s-text tone="neutral">
              This store is still being set up. Sync activity will appear here
              once provisioning completes.
            </s-text>
          </s-paragraph>
        ) : logs.length === 0 ? (
          <s-stack direction="block" gap="base">
            <s-paragraph>No sync activity yet.</s-paragraph>
            <s-paragraph>
              <s-text tone="neutral">
                Order and product webhooks write an entry here each time they
                sync data into the backend. Create or update an order or product
                in Shopify to see it logged.
              </s-text>
            </s-paragraph>
          </s-stack>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>When</s-table-header>
              <s-table-header>Source</s-table-header>
              <s-table-header>Event</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Message</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {logs.map((log) => (
                <s-table-row key={log.id}>
                  <s-table-cell>{formatDateTime(log.created_at)}</s-table-cell>
                  <s-table-cell>{log.source ?? "—"}</s-table-cell>
                  <s-table-cell>{log.event_type ?? "—"}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={statusTone(log.status)}>{log.status}</s-badge>
                  </s-table-cell>
                  <s-table-cell>{log.message ?? "—"}</s-table-cell>
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
