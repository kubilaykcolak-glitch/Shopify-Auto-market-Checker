import { Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    await authenticate.admin(request);
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