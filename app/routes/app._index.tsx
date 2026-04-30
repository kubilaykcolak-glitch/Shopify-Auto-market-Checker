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

  const enabledRulesCount = await prisma.automationRule.count({
    where: { storeId: store.id, isEnabled: true },
  });

  // Checked server-side so env vars never leak to client
  const integrationStatus = {
    hasDataSource: !!(
      (process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET) ||
      (process.env.TCGPLAYER_PUBLIC_KEY && process.env.TCGPLAYER_PRIVATE_KEY) ||
      process.env.PRICECHARTING_API_KEY
    ),
  };

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
    enabledRulesCount,
    integrationStatus,
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

// Human-readable action labels for the activity log
const ACTION_LABELS: Record<string, string> = {
  price_updated: "Price updated",
  product_disabled: "Set out of stock",
  floor_applied: "Floor price applied",
  notified: "Alert sent",
  nothing: "No change",
};

const SOURCE_LABELS: Record<string, string> = {
  tcgplayer: "TCGPlayer",
  ebay: "eBay",
  pricecharting: "PriceCharting",
};

export default function Dashboard() {
  const { storeId, shop, products, recentLogs, stats, enabledRulesCount } =
    useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSyncing = navigation.state === "submitting";

  function handleSyncNow() {
    submit({ intent: "sync_now", storeId }, { method: "POST" });
  }

  // ── Onboarding steps ────────────────────────────────────────────────────────
  const setupSteps = [
    {
      label: "Link your first product",
      detail: "Connect a Shopify product to live pricing data",
      complete: products.length > 0,
      action: "Link product",
      url: "/app/products/new",
    },
    {
      label: "Set up an automation rule",
      detail: "Auto-update prices or get alerts on market changes",
      complete: enabledRulesCount > 0,
      action: "Add rule",
      url: "/app/rules",
    },
  ];

  const completedSteps = setupSteps.filter((s) => s.complete).length;
  const allStepsComplete = completedSteps === setupSteps.length;

  // ── Table rows ──────────────────────────────────────────────────────────────
  const productRows: React.ReactNode[][] = products.map((p) => [
    <Button key={`title-${p.id}`} variant="plain" url={`/app/products/${p.id}`}>
      {p.shopifyProductTitle}{p.cardSet ? ` — ${p.cardSet}` : ""}
    </Button>,
    <Badge key={`src-${p.id}`} tone="info">
      {SOURCE_LABELS[p.priceSource] ?? p.priceSource}
    </Badge>,
    p.lastKnownPrice != null ? `£${p.lastKnownPrice.toFixed(2)}` : "—",
    p.lastCheckedAt ? new Date(p.lastCheckedAt).toLocaleTimeString("en-GB") : "Never",
    p.disabledByRule ? (
      <Badge key={`s-${p.id}`} tone="critical">Out of stock</Badge>
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
      <Text
        as="span"
        tone={log.changePercent >= 0 ? "success" : "critical"}
        key={`chg-${log.id}`}
      >
        {log.changePercent >= 0 ? "+" : ""}
        {log.changePercent.toFixed(1)}%
      </Text>
    ) : (
      "—"
    ),
    `£${log.fetchedPrice.toFixed(2)}`,
    <Badge
      key={`act-${log.id}`}
      tone={
        log.actionTaken === "price_updated"
          ? "success"
          : log.actionTaken === "product_disabled"
          ? "critical"
          : log.actionTaken === "floor_applied"
          ? "warning"
          : "info"
      }
    >
      {ACTION_LABELS[log.actionTaken ?? ""] ?? log.actionTaken ?? "—"}
    </Badge>,
  ]);

  return (
    <Page
      title="Dashboard"
      subtitle={shop}
      primaryAction={{ content: "Sync now", onAction: handleSyncNow, loading: isSyncing }}
      secondaryActions={[
        { content: "Link product", url: "/app/products/new" },
        { content: "Rules", url: "/app/rules" },
        { content: "Settings", url: "/app/settings" },
      ]}
    >
      <BlockStack gap="500">

        {/* ── Onboarding ─────────────────────────────────────────────────────── */}
        {!allStepsComplete && (
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="050">
                  <Text variant="headingMd" as="h2">Getting started</Text>
                  <Text tone="subdued" variant="bodySm" as="p">
                    Complete these steps to start tracking prices automatically.
                  </Text>
                </BlockStack>
                <Badge tone={completedSteps === 0 ? "warning" : "info"}>
                  {completedSteps} of {setupSteps.length} complete
                </Badge>
              </InlineStack>

              <BlockStack gap="200">
                {setupSteps.map((step) => (
                  <Box
                    key={step.label}
                    padding="300"
                    background={
                      step.complete ? "bg-surface-success-subdued" : "bg-surface-secondary"
                    }
                    borderRadius="200"
                  >
                    <InlineStack align="space-between" blockAlign="center">
                      <InlineStack gap="300" blockAlign="center">
                        <Text as="span" variant="bodyMd">
                          {step.complete ? "✅" : "⬜"}
                        </Text>
                        <BlockStack gap="050">
                          <Text
                            as="span"
                            variant="bodyMd"
                            fontWeight={step.complete ? "regular" : "semibold"}
                            tone={step.complete ? "subdued" : undefined}
                          >
                            {step.label}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {step.detail}
                          </Text>
                        </BlockStack>
                      </InlineStack>
                      {!step.complete && step.action && (
                        <Button size="slim" url={step.url ?? undefined}>
                          {step.action}
                        </Button>
                      )}
                    </InlineStack>
                  </Box>
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        )}

        {/* ── Stats row ──────────────────────────────────────────────────────── */}
        <InlineStack gap="400" wrap={false}>
          {[
            {
              label: "Tracked products",
              value: String(stats.totalProducts),
              sub: stats.activeProducts > 0 ? `${stats.activeProducts} active` : "None active",
            },
            {
              label: "Price updates today",
              value: String(stats.updatesToday),
              sub: "Auto-applied by rules",
            },
            {
              label: "Out of stock",
              value: String(stats.disabledProducts),
              sub: stats.disabledProducts > 0 ? "Needs your attention" : "All products in stock",
              critical: stats.disabledProducts > 0,
            },
            {
              label: "Active rules",
              value: String(enabledRulesCount),
              sub: enabledRulesCount > 0 ? "Monitoring prices" : "No rules configured",
            },
          ].map(({ label, value, sub, critical }) => (
            <Box key={label} width="25%">
              <Card>
                <BlockStack gap="200">
                  <Text variant="bodySm" tone="subdued" as="p">
                    {label}
                  </Text>
                  <Text
                    variant="heading2xl"
                    as="p"
                    tone={critical ? "critical" : undefined}
                  >
                    {value}
                  </Text>
                  <Text variant="bodySm" tone="subdued" as="p">
                    {sub}
                  </Text>
                </BlockStack>
              </Card>
            </Box>
          ))}
        </InlineStack>

        {/* ── Products table ─────────────────────────────────────────────────── */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between">
              <Text variant="headingMd" as="h2">Tracked Products</Text>
              <Button url="/app/products/new" variant="primary">
                Link new product
              </Button>
            </InlineStack>

            {products.length === 0 ? (
              <EmptyState
                heading="No products tracked yet"
                action={{ content: "Link your first product", url: "/app/products/new" }}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>
                  Connect your Shopify products to live market price sources to start tracking.
                </p>
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

        {/* ── Activity log ───────────────────────────────────────────────────── */}
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