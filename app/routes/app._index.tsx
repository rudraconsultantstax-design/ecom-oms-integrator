import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";

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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(RECENT_ORDERS_QUERY);
  const body = (await response.json()) as RecentOrdersResponse;
  const orders = body.data?.orders?.edges.map((edge) => edge.node) ?? [];

  return { orders };
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

export default function OrdersDashboard() {
  const { orders } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Orders">
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
