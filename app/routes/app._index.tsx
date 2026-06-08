import React, { useState, useMemo } from "react";
import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  InlineGrid,
  Badge,
  Button,
  DataTable,
  EmptyState,
  Box,
  Divider,
  TextField,
  Pagination,
  Tooltip,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { runSyncForStore } from "../lib/price-engine.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const { shop } = session;

  // Store record is upserted (including accessToken refresh) by the parent
  // app.tsx loader, which always runs before this loader. Just query here.
  const store = await prisma.store.findUniqueOrThrow({
    where: { shop },
    include: {
      products: {
        orderBy: { updatedAt: "desc" },
        include: {
          priceLogs: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { actionTaken: true, changePercent: true, createdAt: true },
          },
        },
      },
      priceLogs: {
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          createdAt: true,
          fetchedPrice: true,
          changePercent: true,
          actionTaken: true,
          actionDetail: true,
          trackedProduct: { select: { shopifyProductTitle: true } },
        },
      },
      settings: true,
    },
  });

  const enabledRulesCount = await prisma.automationRule.count({
    where: { storeId: store.id, isEnabled: true },
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
    enabledRulesCount,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "sync_now") {
    const storeId = formData.get("storeId") as string;
    // Await completion so Remix revalidates the loader with fresh data after
    // the sync finishes, rather than reloading immediately while it's still running.
    await runSyncForStore(storeId);
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
  rule_failed: "Rule failed",
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

  // ── Product search + pagination ──────────────────────────────────────────────
  const PAGE_SIZE = 10;
  const [productSearch, setProductSearch] = useState("");
  const [productPage, setProductPage] = useState(1);

  // ── Activity log search + pagination ────────────────────────────────────────
  const [logSearch, setLogSearch] = useState("");
  const [logPage, setLogPage] = useState(1);

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
  // Build a flat list pairing each product with its rendered row so we can
  // filter by name and paginate without losing the row data.
  const allProductRows: { title: string; row: React.ReactNode[] }[] = products.map((p) => {
    const lastLog = (p as any).priceLogs?.[0];
    const lastAction: string | null = lastLog?.actionTaken ?? null;
    const lastChange: number | null = lastLog?.changePercent ?? null;

    // Badge 1 — product state (what it currently is)
    const isOutOfStock = p.disabledByRule || lastAction === "product_disabled";

    // Badge 2 — rule action (what the rule did), only when a rule actually fired.
    // Labels deliberately describe the ACTION, not the state, so they don't duplicate badge 1.
    const ruleBadge: { label: string; tone: "success" | "warning" | "critical" | "info" } | null =
      lastAction === "product_disabled"
        ? { label: "↓ Disabled by rule", tone: "critical" }
        : lastAction === "floor_applied"
        ? { label: "⚑ Floor price set", tone: "warning" }
        : lastAction === "price_updated"
        ? {
            label: lastChange != null && lastChange < 0 ? "↓ Price lowered" : "↑ Price raised",
            tone: lastChange != null && lastChange < 0 ? "info" : "success",
          }
        : lastAction === "rule_failed"
        ? { label: "✕ Rule failed", tone: "critical" }
        : null;

    return {
      title: p.shopifyProductTitle,
      row: [
        <Button key={`title-${p.id}`} variant="plain" url={`/app/products/${p.id}`}>
          {p.shopifyProductTitle}{(p as any).cardSet ? ` — ${(p as any).cardSet}` : ""}
        </Button>,
        <Badge key={`src-${p.id}`} tone="info">
          {SOURCE_LABELS[p.priceSource] ?? p.priceSource}
        </Badge>,
        p.lastKnownPrice != null ? `£${p.lastKnownPrice.toFixed(2)}` : "—",
        p.lastCheckedAt
          ? new Date(p.lastCheckedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
          : "Never",
        <BlockStack key={`s-${p.id}`} gap="100">
          {isOutOfStock ? (
            <Badge tone="critical">Out of stock</Badge>
          ) : p.isPaused ? (
            <Badge tone="warning">Paused</Badge>
          ) : (
            <Badge tone="success">Active</Badge>
          )}
          {ruleBadge && (
            <Badge tone={ruleBadge.tone} size="small">
              {ruleBadge.label}
            </Badge>
          )}
        </BlockStack>,
      ],
    };
  });

  // Filter by search term and paginate
  const filteredProductRows = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    return q ? allProductRows.filter((r) => r.title.toLowerCase().includes(q)) : allProductRows;
  }, [allProductRows, productSearch]);

  const totalProductPages = Math.max(1, Math.ceil(filteredProductRows.length / PAGE_SIZE));
  const clampedPage = Math.min(productPage, totalProductPages);
  const pagedProductRows = filteredProductRows
    .slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE)
    .map((r) => r.row);

  const now = new Date();

  // Keep log entries as data — render directly to avoid DataTable min-width scrolling
  const filteredLogs = useMemo(() => {
    const q = logSearch.trim().toLowerCase();
    return q
      ? recentLogs.filter((l) =>
          ((l as any).trackedProduct?.shopifyProductTitle ?? "").toLowerCase().includes(q)
        )
      : recentLogs;
  }, [recentLogs, logSearch]);

  const totalLogPages = Math.max(1, Math.ceil(filteredLogs.length / PAGE_SIZE));
  const clampedLogPage = Math.min(logPage, totalLogPages);
  const pagedLogs = filteredLogs.slice((clampedLogPage - 1) * PAGE_SIZE, clampedLogPage * PAGE_SIZE);

  return (
    <Page
      title="Dashboard"
      subtitle={shop}
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
                  {`${completedSteps} of ${setupSteps.length} complete`}
                </Badge>
              </InlineStack>

              <BlockStack gap="200">
                {setupSteps.map((step) => (
                  <Box
                    key={step.label}
                    padding="300"
                    background={
                      step.complete ? "bg-surface-success" : "bg-surface-secondary"
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
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Box minWidth="260px">
                    <TextField
                      label="Search products"
                      labelHidden
                      value={productSearch}
                      onChange={(v) => { setProductSearch(v); setProductPage(1); }}
                      placeholder="Search by product name…"
                      autoComplete="off"
                      clearButton
                      onClearButtonClick={() => { setProductSearch(""); setProductPage(1); }}
                    />
                  </Box>
                  <Text variant="bodySm" tone="subdued" as="p">
                    {filteredProductRows.length === products.length
                      ? `${products.length} product${products.length !== 1 ? "s" : ""}`
                      : `${filteredProductRows.length} of ${products.length} products`}
                  </Text>
                </InlineStack>

                {filteredProductRows.length === 0 ? (
                  <Box padding="400">
                    <Text tone="subdued" as="p" alignment="center">
                      No products match "{productSearch}"
                    </Text>
                  </Box>
                ) : (
                  <>
                    <DataTable
                      columnContentTypes={["text", "text", "text", "text", "text"]}
                      headings={["Product", "Source", "Market Price", "Last Checked", "Status"]}
                      rows={pagedProductRows}
                    />
                    {totalProductPages > 1 && (
                      <InlineStack align="center">
                        <Pagination
                          hasPrevious={clampedPage > 1}
                          onPrevious={() => setProductPage((p) => Math.max(1, p - 1))}
                          hasNext={clampedPage < totalProductPages}
                          onNext={() => setProductPage((p) => Math.min(totalProductPages, p + 1))}
                          label={`Page ${clampedPage} of ${totalProductPages}`}
                        />
                      </InlineStack>
                    )}
                  </>
                )}
              </BlockStack>
            )}
          </BlockStack>
        </Card>

        {/* ── Activity log ───────────────────────────────────────────────────── */}
        {recentLogs.length > 0 && (
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">Recent Activity</Text>

              <InlineStack align="space-between" blockAlign="center">
                <Box minWidth="260px">
                  <TextField
                    label="Search activity"
                    labelHidden
                    value={logSearch}
                    onChange={(v) => { setLogSearch(v); setLogPage(1); }}
                    placeholder="Filter by product name…"
                    autoComplete="off"
                    clearButton
                    onClearButtonClick={() => { setLogSearch(""); setLogPage(1); }}
                  />
                </Box>
                <Text variant="bodySm" tone="subdued" as="p">
                  {filteredLogs.length === recentLogs.length
                    ? `${recentLogs.length} entr${recentLogs.length !== 1 ? "ies" : "y"}`
                    : `${filteredLogs.length} of ${recentLogs.length} entries`}
                </Text>
              </InlineStack>

              {filteredLogs.length === 0 ? (
                <Box padding="400">
                  <Text tone="subdued" as="p" alignment="center">
                    No activity matches "{logSearch}"
                  </Text>
                </Box>
              ) : (
                <div>
                  {/* Header row */}
                  <div style={{
                    display: "grid",
                    gridTemplateColumns: "90px 1fr 62px 62px 130px",
                    gap: "12px",
                    padding: "8px 8px",
                    background: "var(--p-color-bg-surface-secondary)",
                    borderRadius: "8px",
                    marginBottom: "4px",
                  }}>
                    {["Time", "Product", "Change", "Price", "Action"].map((h) => (
                      <Text key={h} variant="bodySm" tone="subdued" as="span" fontWeight="semibold">{h}</Text>
                    ))}
                  </div>

                  {pagedLogs.map((log, i) => {
                    const d = new Date(log.createdAt);
                    const isToday = d.toDateString() === now.toDateString();
                    const timeStr = isToday
                      ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
                      : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) +
                        " " +
                        d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
                    const title = (log as any).trackedProduct?.shopifyProductTitle ?? "—";
                    const shortTitle = title.length > 32 ? title.slice(0, 32) + "…" : title;
                    const isFailed = log.actionTaken === "rule_failed";

                    return (
                      <React.Fragment key={log.id}>
                        {i > 0 && <Divider />}
                        <div style={{
                          display: "grid",
                          gridTemplateColumns: "90px 1fr 62px 62px 130px",
                          gap: "12px",
                          padding: "10px 8px",
                          alignItems: "start",
                        }}>
                          <Text variant="bodySm" tone="subdued" as="span">{timeStr}</Text>
                          <Text variant="bodySm" as="span">{shortTitle}</Text>
                          <Text
                            variant="bodySm"
                            as="span"
                            tone={log.changePercent == null ? undefined : log.changePercent >= 0 ? "success" : "critical"}
                          >
                            {log.changePercent != null
                              ? `${log.changePercent >= 0 ? "+" : ""}${log.changePercent.toFixed(1)}%`
                              : "—"}
                          </Text>
                          <Text variant="bodySm" as="span">£{log.fetchedPrice.toFixed(2)}</Text>
                          <BlockStack gap="100">
                            <Tooltip
                              content={(log as any).actionDetail ?? ACTION_LABELS[log.actionTaken ?? ""] ?? "—"}
                              dismissOnMouseOut
                            >
                              <Badge
                                size="small"
                                tone={
                                  log.actionTaken === "price_updated"
                                    ? "success"
                                    : log.actionTaken === "product_disabled"
                                    ? "critical"
                                    : log.actionTaken === "floor_applied"
                                    ? "warning"
                                    : isFailed
                                    ? "critical"
                                    : "info"
                                }
                              >
                                {ACTION_LABELS[log.actionTaken ?? ""] ?? log.actionTaken ?? "—"}
                              </Badge>
                            </Tooltip>
                            {(log as any).actionDetail && (
                              <Tooltip content={(log as any).actionDetail} dismissOnMouseOut>
                                <Text variant="bodySm" tone={isFailed ? "critical" : "subdued"} as="span">
                                  {(log as any).actionDetail.length > 40
                                    ? (log as any).actionDetail.slice(0, 40) + "…"
                                    : (log as any).actionDetail}
                                </Text>
                              </Tooltip>
                            )}
                          </BlockStack>
                        </div>
                      </React.Fragment>
                    );
                  })}

                  {totalLogPages > 1 && (
                    <Box paddingBlockStart="300">
                      <InlineStack align="center">
                        <Pagination
                          hasPrevious={clampedLogPage > 1}
                          onPrevious={() => setLogPage((p) => Math.max(1, p - 1))}
                          hasNext={clampedLogPage < totalLogPages}
                          onNext={() => setLogPage((p) => Math.min(totalLogPages, p + 1))}
                          label={`Page ${clampedLogPage} of ${totalLogPages}`}
                        />
                      </InlineStack>
                    </Box>
                  )}
                </div>
              )}
            </BlockStack>
          </Card>
        )}

      </BlockStack>
    </Page>
  );
}