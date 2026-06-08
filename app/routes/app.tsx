import { Outlet, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { NavMenu } from "@shopify/app-bridge-react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { session } = await authenticate.admin(request);

    // Keep Store.accessToken in sync with the live Shopify session on every
    // authenticated page visit. The Shopify SDK always has the current token
    // (Session table) but Store.accessToken is used by the background sync.
    // Without this, a user who links products without visiting the dashboard
    // would leave the sync running with a stale token.
    if (session.accessToken) {
      await prisma.store.upsert({
        where: { shop: session.shop },
        update: { accessToken: session.accessToken },
        create: { shop: session.shop, accessToken: session.accessToken },
      });
    }
  } catch (err: unknown) {
    // Log the full error to the dev-server terminal so we can see the root cause
    if (err instanceof Response) {
      const body = await err.clone().text();
      console.error("[AUTH] Response thrown:", err.status, body);
    } else if (err instanceof Error) {
      console.error("[AUTH] Error thrown:", err.message);
      console.error(err.stack);
    } else {
      console.error("[AUTH] Unknown thrown:", err);
    }
    throw err;
  }
  return null;
}

export default function AppLayout() {
  return (
    <>
      <NavMenu>
        <a href="/app" rel="home">Dashboard</a>
        <a href="/app/products/new">Link Product</a>
        <a href="/app/rules">Automation Rules</a>
        <a href="/app/settings">Settings</a>
      </NavMenu>
      <Outlet />
    </>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs: any) => {
  return boundary.headers(headersArgs);
};