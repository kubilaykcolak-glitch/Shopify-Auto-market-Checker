import React from "react";
import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Badge,
  Button,
  DataTable,
  EmptyState,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { runSyncForStore } from "../lib/price-engine.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const { shop } = session;
  const accessToken = session.accessToken ?? "";

  // Upsert store record, then fetch with relations separately for correct TypeScript inference
  await prisma.store.upsert({
    where: { shop },
    update: { accessToken },
    create: { shop, accessToken },
  });

  const store = await prisma.store.findUniqueOrThrow({
    where: { shop },
    include: {
      products: { orderBy: { updatedAt: "desc" } },
      priceLogs: { orderBy: { createdAt: "desc" }, take: 50 },
      settings: true,
    },
  });

  const totalProducts = store.products.length;
  const activeProducts = store.products.filter((p) => p.isActive && !p.isPaused).length;
  const disabledProducts = store.products.filter((p) => p.disabledByRule).length;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const updatesToday = store.priceLogs.filter(
    (l) => new Date(l.createdAt) >= today && l.actionTaken === "price_updated"
  ).length;

  return json({
    storeId: store.id,
    shop,
    products: store.products,
    recentLogs: store.priceLogs.slice(0, 20),
    stats: { totalProducts, activeProducts, disabledProducts, updatesToday },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "sync_now") {
    const storeId = formData.get("storeId") as string;
    runSyncForStore(storeId).catch(console.error);
    return json({ success: true });
  }

  return json({ success: false });
}

export default function Dashboard() {
  const { storeId, shop, products, recentLogs, stats } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSyncing = navigation.state === "submitting";

  function handleSyncNow() {
    submit({ intent: "sync_now", storeId }, { method: "POST" });
  }

  const productRows: React.ReactNode[][] = products.map((p) => [
    <Button key={`title-${p.id}`} variant="plain" url={`/app/products/${p.id}`}>
      {p.shopifyProductTitle}{p.cardSet ? ` — ${p.cardSet}` : ""}
    </Button>,
    <Badge key={`src-${p.id}`} tone="info">{p.priceSource}</Badge>,
    p.lastKnownPrice != null ? `£${p.lastKnownPrice.toFixed(2)}` : "—",
    p.lastCheckedAt ? new Date(p.lastCheckedAt).toLocaleTimeString("en-GB") : "Never",
    p.disabledByRule ? (
      <Badge key={`s-${p.id}`} tone="critical">Disabled</Badge>
    ) : p.isPaused ? (
      <Badge key={`s-${p.id}`} tone="warning">Paused</Badge>
    ) : (
      <Badge key={`s-${p.id}`} tone="success">Active</Badge>
    ),
  ]);

  const logRows: React.ReactNode[][] = recentLogs.map((log) => [
    new Date(log.createdAt).toLocaleString("en-GB"),
    log.actionDetail?.split(":")[0] ?? "—",
    log.changePercent != null ? (
      <Text as="span" tone={log.changePercent >= 0 ? "success" : "critical"} key={`chg-${log.id}`}>
        {log.changePercent >= 0 ? "+" : ""}{log.changePercent.toFixed(1)}%
      </Text>
    ) : "—",
    `£${log.fetchedPrice.toFixed(2)}`,
    <Badge
      key={`act-${log.id}`}
      tone={
        log.actionTaken === "price_updated" ? "success" :
        log.actionTaken === "product_disabled" ? "critical" :
        log.actionTaken === "floor_applied" ? "warning" : "info"
      }
    >
      {log.actionTaken ?? "nothing"}
    </Badge>,
  ]);

  return (
    <Page
      title="PriceSync Dashboard"
      subtitle={`Connected to ${shop}`}
      primaryAction={{ content: "Sync Now", onAction: handleSyncNow, loading: isSyncing }}
      secondaryActions={[
        { content: "Add Product", url: "/app/products/new" },
        { content: "Automation Rules", url: "/app/rules" },
        { content: "Settings", url: "/app/settings" },
      ]}
    >
      <BlockStack gap="500">

        {/* Stats row — 4 equal-width cards using InlineStack */}
        <InlineStack gap="400" wrap={false}>
          {[
            { label: "Tracked products", value: String(stats.totalProducts), sub: `${stats.activeProducts} active` },
            { label: "Price updates today", value: String(stats.updatesToday), sub: "Auto-applied" },
            { label: "Disabled by rule", value: String(stats.disabledProducts), sub: "Need review", critical: stats.disabledProducts > 0 },
            { label: "Data sources", value: "3", sub: "eBay · TCGPlayer · PriceCharting" },
          ].map(({ label, value, sub, critical }) => (
            <Box key={label} width="25%">
              <Card>
                <BlockStack gap="200">
                  <Text variant="bodySm" tone="subdued" as="p">{label}</Text>
                  <Text variant="heading2xl" as="p" tone={critical ? "critical" : undefined}>{value}</Text>
                  <Text variant="bodySm" tone="subdued" as="p">{sub}</Text>
                </BlockStack>
              </Card>
            </Box>
          ))}
        </InlineStack>

        {/* Products table */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between">
              <Text variant="headingMd" as="h2">Tracked Products</Text>
              <Button url="/app/products/new" variant="primary">Link new product</Button>
            </InlineStack>

            {products.length === 0 ? (
              <EmptyState
                heading="No products tracked yet"
                action={{ content: "Link your first product", url: "/app/products/new" }}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>Connect your Shopify products to live Pokémon price sources to get started.</p>
              </EmptyState>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "text"]}
                headings={["Product", "Source", "Market Price", "Last Checked", "Status"]}
                rows={productRows}
              />
            )}
          </BlockStack>
        </Card>

        {/* Activity log */}
        {recentLogs.length > 0 && (
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">Recent Activity</Text>
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "text"]}
                headings={["Time", "Product", "Change", "Price", "Action"]}
                rows={logRows}
              />
            </BlockStack>
          </Card>
        )}

      </BlockStack>
    </Page>
  );
}