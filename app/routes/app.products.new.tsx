import React, { useState, useMemo, useEffect } from "react";
import {
  json,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
} from "@remix-run/node";
import {
  useLoaderData,
  useSubmit,
  useNavigation,
  useActionData,
} from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  InlineStack,
  InlineGrid,
  Button,
  TextField,
  Select,
  ResourceList,
  ResourceItem,
  Thumbnail,
  Badge,
  Banner,
  DataTable,
  Box,
  Link,
  Checkbox,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { searchTCGPlayerProduct } from "../lib/tcgplayer.server";
import { previewEbaySoldListings } from "../lib/ebay.server";
import { searchPriceChartingProducts } from "../lib/pricecharting.server";
import type { EbaySoldListing } from "../lib/ebay.server";
import { EBAY_POKEMON_CATEGORIES } from "../lib/ebay-categories";

// ── Loader: fetch Shopify products ───────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);

  const response = await admin.graphql(`
    query {
      products(first: 250) {
        edges {
          node {
            id
            title
            featuredImage { url }
            variants(first: 5) {
              edges {
                node {
                  id
                  title
                  price
                  inventoryItem {
                    unitCost { amount currencyCode }
                  }
                }
              }
            }
          }
        }
      }
    }
  `);

  const { data } = await response.json();
  const shopifyProducts = data?.products?.edges?.map((e: any) => e.node) ?? [];

  const store = await prisma.store.findUnique({
    where: { shop: session.shop },
    select: { id: true },
  });

  const trackedProducts = store
    ? await prisma.trackedProduct.findMany({
        where: { storeId: store.id },
        select: {
          shopifyVariantId: true,
          priceSource: true,
          cardCondition: true,
          ebaySearchQuery: true,
          ebayCategoryId: true,
          externalId: true,
          externalName: true,
        },
      })
    : [];

  return json({ shopifyProducts, storeId: store?.id, trackedProducts });
}

// ── Action ───────────────────────────────────────────────────────────────────

type ActionResult =
  | { intent: "search_results"; results: { id: string; name: string; extra?: string }[]; error: string | null }
  | { intent: "ebay_preview"; listings: EbaySoldListing[]; effectiveQuery: string; generation: number; usedSoldData: boolean; error: string | null }
  | { intent: "link_success"; count: number; error: null }
  | { error: string };

export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // ── Search TCGPlayer / PriceCharting ─────────────────────────────────────
  if (intent === "search_price_source") {
    const query = formData.get("query") as string;
    const source = formData.get("source") as string;

    try {
      let results: { id: string; name: string; extra?: string }[] = [];
      if (source === "tcgplayer") {
        const r = await searchTCGPlayerProduct(query);
        results = r.map((p) => ({ id: String(p.productId), name: p.name }));
      } else if (source === "pricecharting") {
        const r = await searchPriceChartingProducts(query);
        results = r.map((p) => ({ id: p.id, name: p.name, extra: p.console }));
      }
      return json<ActionResult>({ intent: "search_results", results, error: null });
    } catch (error: any) {
      return json<ActionResult>({ intent: "search_results", results: [], error: error.message });
    }
  }

  // ── eBay: preview sold listings ──────────────────────────────────────────
  if (intent === "preview_ebay") {
    const query = formData.get("query") as string;
    const categoryId = formData.get("categoryId") as string;
    const generation = parseInt(formData.get("generation") as string, 10) || 0;
    try {
      const { listings, effectiveQuery, usedSoldData } = await previewEbaySoldListings(query, categoryId, 5);
      return json<ActionResult>({ intent: "ebay_preview", listings, effectiveQuery, usedSoldData, generation, error: null });
    } catch (error: any) {
      return json<ActionResult>({ intent: "ebay_preview", listings: [], effectiveQuery: query, usedSoldData: false, generation, error: error.message });
    }
  }

  // ── Single product link ──────────────────────────────────────────────────
  if (intent === "link_product") {
    const store = await prisma.store.findUnique({ where: { shop: session.shop } });
    if (!store) return json<ActionResult>({ error: "Store not found" });

    const shopifyProductId = formData.get("shopifyProductId") as string;
    const shopifyVariantId = formData.get("shopifyVariantId") as string;
    const shopifyProductTitle = formData.get("shopifyProductTitle") as string;
    const shopifyCurrentPrice = parseFloat(formData.get("shopifyCurrentPrice") as string);
    const priceSource = formData.get("priceSource") as string;
    const externalId = (formData.get("externalId") as string) ?? "";
    const externalName = (formData.get("externalName") as string) ?? "";
    const cardCondition = (formData.get("cardCondition") as string) || "near_mint";
    const isSealed = formData.get("isSealed") === "true";
    const ebaySearchQuery = (formData.get("ebaySearchQuery") as string) || null;
    const ebayCategoryId = (formData.get("ebayCategoryId") as string) || null;
    const costPriceRaw = formData.get("costPrice") as string;
    const costPrice = costPriceRaw ? parseFloat(costPriceRaw) : null;
    const costPriceSource = (formData.get("costPriceSource") as string) || null;

    await prisma.trackedProduct.upsert({
      where: { storeId_shopifyVariantId: { storeId: store.id, shopifyVariantId } },
      update: { priceSource, externalId, externalName, cardCondition, isSealed, ebaySearchQuery, ebayCategoryId, costPrice, costPriceSource },
      create: {
        storeId: store.id,
        shopifyProductId,
        shopifyVariantId,
        shopifyProductTitle,
        shopifyCurrentPrice,
        priceSource,
        externalId,
        externalName,
        cardCondition,
        isSealed,
        ebaySearchQuery,
        ebayCategoryId,
        costPrice,
        costPriceSource,
        baselinePrice: shopifyCurrentPrice,
      },
    });

    return json<ActionResult>({ intent: "link_success", count: 1, error: null });
  }

  // ── Bulk product link ────────────────────────────────────────────────────
  if (intent === "link_products_bulk") {
    const store = await prisma.store.findUnique({ where: { shop: session.shop } });
    if (!store) return json<ActionResult>({ error: "Store not found" });

    const priceSource = formData.get("priceSource") as string;
    const cardCondition = (formData.get("cardCondition") as string) || "near_mint";
    const ebayCategory = (formData.get("ebayCategory") as string) || "183454";
    const externalId = (formData.get("externalId") as string) ?? "";
    const externalName = (formData.get("externalName") as string) ?? "";
    const productsJson = formData.get("productsJson") as string;

    const products: {
      shopifyProductId: string;
      shopifyVariantId: string;
      shopifyProductTitle: string;
      shopifyCurrentPrice: string;
      costPrice: string;
    }[] = JSON.parse(productsJson);

    for (const p of products) {
      const isEbay = priceSource === "ebay";
      const currentPrice = parseFloat(p.shopifyCurrentPrice) || 0;
      const costPrice = p.costPrice ? parseFloat(p.costPrice) : null;

      await prisma.trackedProduct.upsert({
        where: { storeId_shopifyVariantId: { storeId: store.id, shopifyVariantId: p.shopifyVariantId } },
        update: {
          priceSource,
          externalId: isEbay ? "" : externalId,
          externalName: isEbay ? p.shopifyProductTitle : externalName,
          cardCondition,
          isSealed: false,
          ebaySearchQuery: isEbay ? p.shopifyProductTitle : null,
          ebayCategoryId: isEbay ? ebayCategory : null,
          costPrice,
          costPriceSource: costPrice ? "manual" : null,
        },
        create: {
          storeId: store.id,
          shopifyProductId: p.shopifyProductId,
          shopifyVariantId: p.shopifyVariantId,
          shopifyProductTitle: p.shopifyProductTitle,
          shopifyCurrentPrice: currentPrice,
          priceSource,
          externalId: isEbay ? "" : externalId,
          externalName: isEbay ? p.shopifyProductTitle : externalName,
          cardCondition,
          isSealed: false,
          ebaySearchQuery: isEbay ? p.shopifyProductTitle : null,
          ebayCategoryId: isEbay ? ebayCategory : null,
          costPrice,
          costPriceSource: costPrice ? "manual" : null,
          baselinePrice: currentPrice,
        },
      });
    }

    return json<ActionResult>({ intent: "link_success", count: products.length, error: null });
  }

  return json<ActionResult>({ error: "Unknown intent" });
}

// ── Static options ────────────────────────────────────────────────────────────

const conditionOptions = [
  { label: "Near Mint (NM)", value: "near_mint" },
  { label: "Lightly Played (LP)", value: "lightly_played" },
  { label: "Moderately Played (MP)", value: "moderately_played" },
  { label: "Heavily Played (HP)", value: "heavily_played" },
  { label: "PSA 10", value: "psa10" },
  { label: "PSA 9", value: "psa9" },
  { label: "PSA 8", value: "psa8" },
  { label: "Sealed / New", value: "sealed" },
];

const sourceOptions = [
  { label: "eBay sold listings (UK market prices)", value: "ebay" },
  { label: "TCGPlayer (best for individual cards)", value: "tcgplayer" },
  { label: "PriceCharting (sealed products & vintage)", value: "pricecharting" },
];

const ebayCategoryOptions = EBAY_POKEMON_CATEGORIES.map((c) => ({
  label: c.label,
  value: c.value,
}));

// ── Component ─────────────────────────────────────────────────────────────────

export default function NewProduct() {
  const { shopifyProducts, trackedProducts } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();

  // ── Product list state ───────────────────────────────────────────────────
  const [searchFilter, setSearchFilter] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // ── Price source config ──────────────────────────────────────────────────
  const [priceSource, setPriceSource] = useState("ebay");
  const [cardCondition, setCardCondition] = useState("near_mint");
  const [ebayCategory, setEbayCategory] = useState("183454");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedExternal, setSelectedExternal] = useState<{ id: string; name: string; extra?: string } | null>(null);
  const [ebayConfirmed, setEbayConfirmed] = useState(false);

  // ── Preview generation counter ───────────────────────────────────────────
  // Incremented whenever the product selection changes so that stale
  // actionData from a previous product's eBay preview is never displayed.
  const [previewGeneration, setPreviewGeneration] = useState(0);

  // ── Per-product draft state ──────────────────────────────────────────────
  // Persists each product's in-progress config as the user switches between
  // products, so returning to a product restores exactly what they typed.
  // Stored in a ref (not state) so saves don't trigger re-renders.
  type ProductDraft = {
    priceSource: string;
    cardCondition: string;
    ebayCategory: string;
    searchQuery: string;
    ebayConfirmed: boolean;
    selectedExternal: { id: string; name: string; extra?: string } | null;
  };
  const perProductDraft = React.useRef<Map<string, ProductDraft>>(new Map());
  const prevProductId = React.useRef<string | null>(null);

  // ── Cost price ───────────────────────────────────────────────────────────
  const [costPriceShared, setCostPriceShared] = useState("");
  const [useShopifyCost, setUseShopifyCost] = useState(true);

  // ── Derived state ────────────────────────────────────────────────────────
  const filteredProducts = useMemo(
    () => shopifyProducts.filter((p: any) =>
      p.title.toLowerCase().includes(searchFilter.toLowerCase())
    ),
    [shopifyProducts, searchFilter]
  );

  const selectedProducts = useMemo(
    () => shopifyProducts.filter((p: any) => selectedIds.includes(p.id)),
    [shopifyProducts, selectedIds]
  );

  // Map shopifyVariantId → tracked config for quick lookups
  const trackedByVariantId = useMemo(
    () => new Map(trackedProducts.map((t) => [t.shopifyVariantId, t])),
    [trackedProducts]
  );

  // Which of the currently-selected products already have a tracked price source?
  const selectedWithExistingConfig = useMemo(
    () =>
      selectedProducts.filter((p: any) => {
        const variantId = p.variants.edges[0]?.node?.id;
        return variantId && trackedByVariantId.has(variantId);
      }),
    [selectedProducts, trackedByVariantId]
  );

  const isSingleSelect = selectedIds.length === 1;
  const isMultiSelect = selectedIds.length > 1;
  const singleProduct = isSingleSelect ? selectedProducts[0] : null;
  const singleVariant = singleProduct ? singleProduct.variants.edges[0]?.node : null;
  const shopifyCostForSingle = singleVariant?.inventoryItem?.unitCost?.amount
    ? parseFloat(singleVariant.inventoryItem.unitCost.amount)
    : null;

  // ── Pre-fill / reset config when selection changes ───────────────────────
  useEffect(() => {
    // 1. Save the outgoing product's in-progress config so we can restore it
    //    if the user comes back to it before saving.
    //    (Effect closure captures state from the render that triggered it —
    //    i.e. the state still reflects the PREVIOUS product at this point.)
    if (prevProductId.current) {
      perProductDraft.current.set(prevProductId.current, {
        priceSource, cardCondition, ebayCategory, searchQuery, ebayConfirmed, selectedExternal,
      });
    }

    // 2. Bump generation — stale ebay_preview actionData becomes invisible.
    setPreviewGeneration((g) => g + 1);

    const newProductId = isSingleSelect && singleProduct ? singleProduct.id : null;
    prevProductId.current = newProductId;

    if (isSingleSelect && singleProduct) {
      const variantId = singleProduct.variants.edges[0]?.node?.id;
      const tracked = variantId ? trackedByVariantId.get(variantId) : undefined;
      const draft = newProductId ? perProductDraft.current.get(newProductId) : null;

      if (draft) {
        // 3a. Restore the draft the user was editing for this product
        setPriceSource(draft.priceSource);
        setCardCondition(draft.cardCondition);
        setEbayCategory(draft.ebayCategory);
        setSearchQuery(draft.searchQuery);
        setEbayConfirmed(draft.ebayConfirmed);
        setSelectedExternal(draft.selectedExternal);
      } else if (tracked) {
        // 3b. Pre-fill from the product's saved tracked config (first visit)
        setPriceSource(tracked.priceSource);
        setCardCondition(tracked.cardCondition);
        if (tracked.priceSource === "ebay") {
          setEbayCategory(tracked.ebayCategoryId ?? "183454");
          setSearchQuery(tracked.ebaySearchQuery ?? "");
          setEbayConfirmed(!!(tracked.ebaySearchQuery));
          setSelectedExternal(null);
        } else {
          setSearchQuery(tracked.externalName ?? "");
          setSelectedExternal(
            tracked.externalId
              ? { id: tracked.externalId, name: tracked.externalName ?? "" }
              : null
          );
          setEbayConfirmed(false);
        }
      } else {
        // 3c. Fresh product — reset to defaults
        setPriceSource("ebay");
        setCardCondition("near_mint");
        setEbayCategory("183454");
        setSearchQuery("");
        setSelectedExternal(null);
        setEbayConfirmed(false);
      }
    }
    // For multi-select we leave the config alone so the user sets it intentionally
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds]);

  // ── Navigation states ────────────────────────────────────────────────────
  const isSearching =
    navigation.state === "submitting" &&
    (navigation.formData?.get("intent") === "search_price_source" ||
      navigation.formData?.get("intent") === "preview_ebay");
  const isLinking =
    navigation.state === "submitting" &&
    (navigation.formData?.get("intent") === "link_product" ||
      navigation.formData?.get("intent") === "link_products_bulk");

  // ── Action data ──────────────────────────────────────────────────────────
  const searchResults =
    actionData && "intent" in actionData && actionData.intent === "search_results"
      ? actionData.results : [];

  // Only treat actionData as valid if it belongs to the current selection.
  // When the user picks a different product, previewGeneration is incremented
  // so stale ebay_preview responses from the previous product are ignored.
  const isCurrentPreview =
    actionData && "intent" in actionData &&
    actionData.intent === "ebay_preview" &&
    actionData.generation === previewGeneration;

  const ebayPreviewListings: EbaySoldListing[] = isCurrentPreview
    ? (actionData as any).listings : [];

  const ebayEffectiveQuery: string | null = isCurrentPreview
    ? (actionData as any).effectiveQuery : null;

  // True when preview results come from real sold transactions.
  // False means eBay had no sold data and active listings were used instead.
  const ebayUsedSoldData: boolean = isCurrentPreview
    ? (actionData as any).usedSoldData ?? false : false;

  // Average of the preview results — gives the merchant an upfront sense of
  // what price will be used for tracking before they confirm.
  const ebayPreviewAverage = useMemo(() => {
    const valid = ebayPreviewListings.map((l) => l.price).filter((p) => p > 0);
    if (valid.length === 0) return null;
    return valid.reduce((sum, p) => sum + p, 0) / valid.length;
  }, [ebayPreviewListings]);

  const hasEbayError = isCurrentPreview && (actionData as any).error;

  // ── Cost price missing check ─────────────────────────────────────────────
  // True when we're ready to link but no cost price will be saved for any product
  const costPriceMissing =
    // Single: Shopify cost unchecked or unavailable, and no manual value entered
    (isSingleSelect && ((!useShopifyCost && !costPriceShared) || (useShopifyCost && !shopifyCostForSingle && !costPriceShared))) ||
    // Multi: opted out of Shopify cost AND no fallback entered (complete blank)
    (isMultiSelect && !useShopifyCost && !costPriceShared);

  // ── Ready-to-link check ──────────────────────────────────────────────────
  const configReady =
    selectedIds.length > 0 &&
    (priceSource === "ebay"
      ? isMultiSelect || (ebayConfirmed && searchQuery.trim().length > 0)
      : !!selectedExternal);

  // ── Handlers ─────────────────────────────────────────────────────────────
  function handleSourceChange(v: string) {
    setPriceSource(v);
    setSelectedExternal(null);
    setEbayConfirmed(false);
    setSearchQuery("");
  }

  function handleSearch() {
    submit({ intent: "search_price_source", query: searchQuery, source: priceSource }, { method: "POST" });
  }

  function handleEbayPreview() {
    // Reset confirmation so the results table is always visible after a new search,
    // even if the user had previously confirmed a query for this product.
    setEbayConfirmed(false);
    submit(
      { intent: "preview_ebay", query: searchQuery, categoryId: ebayCategory, generation: String(previewGeneration) },
      { method: "POST" }
    );
  }

  function handleLink() {
    // Clear the draft for any products we're about to save so that after
    // linking, re-selecting them loads the freshly-saved tracked config.
    selectedIds.forEach((id) => perProductDraft.current.delete(id));

    if (isSingleSelect && singleProduct && singleVariant) {
      const isEbay = priceSource === "ebay";
      let costPrice = costPriceShared;
      if (useShopifyCost && shopifyCostForSingle && shopifyCostForSingle > 0) {
        costPrice = shopifyCostForSingle.toFixed(2);
      }
      submit(
        {
          intent: "link_product",
          shopifyProductId: singleProduct.id,
          shopifyVariantId: singleVariant.id,
          shopifyProductTitle: singleProduct.title,
          shopifyCurrentPrice: singleVariant.price,
          priceSource,
          externalId: isEbay ? "" : (selectedExternal?.id ?? ""),
          externalName: isEbay ? searchQuery : (selectedExternal?.name ?? ""),
          cardCondition,
          isSealed: String(cardCondition === "sealed"),
          ebaySearchQuery: isEbay ? searchQuery : "",
          ebayCategoryId: isEbay ? ebayCategory : "",
          costPrice,
          costPriceSource: (useShopifyCost && shopifyCostForSingle) ? "shopify" : "manual",
        },
        { method: "POST" }
      );
    } else {
      const productsPayload = selectedProducts.map((p: any) => {
        const variant = p.variants.edges[0]?.node;
        let costPrice = costPriceShared;
        if (useShopifyCost) {
          const shopifyCost = variant?.inventoryItem?.unitCost?.amount;
          if (shopifyCost && parseFloat(shopifyCost) > 0) {
            costPrice = parseFloat(shopifyCost).toFixed(2);
          }
        }
        return {
          shopifyProductId: p.id,
          shopifyVariantId: variant?.id ?? "",
          shopifyProductTitle: p.title,
          shopifyCurrentPrice: variant?.price ?? "0",
          costPrice,
        };
      });

      submit(
        {
          intent: "link_products_bulk",
          productsJson: JSON.stringify(productsPayload),
          priceSource,
          cardCondition,
          ebayCategory,
          externalId: selectedExternal?.id ?? "",
          externalName: selectedExternal?.name ?? "",
        },
        { method: "POST" }
      );
    }
  }

  // ── Success screen ────────────────────────────────────────────────────────
  if (actionData && "intent" in actionData && actionData.intent === "link_success") {
    const count = actionData.count;
    return (
      <Page title={count === 1 ? "Product Linked!" : "Products Linked!"} backAction={{ content: "Dashboard", url: "/app" }}>
        <BlockStack gap="400">
          <Banner
            tone="success"
            title={count === 1 ? "Product successfully linked" : `${count} products successfully linked`}
          >
            <p>
              {count === 1
                ? "The product is now tracked. Prices will sync on the next scheduled check, or trigger a manual sync from the dashboard."
                : `All ${count} products are now tracked. Prices will sync on the next scheduled check.`}
            </p>
          </Banner>
          <InlineStack gap="300">
            <Button url="/app/products/new" variant="primary">Link more products</Button>
            <Button url="/app">Back to dashboard</Button>
          </InlineStack>
        </BlockStack>
      </Page>
    );
  }

  return (
    <Page title="Link Products" backAction={{ content: "Dashboard", url: "/app" }}>
      <InlineGrid columns={["oneHalf", "oneHalf"]} gap="500">

        {/* ── LEFT: Search + Select ─────────────────────────────────────────── */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="050">
                <Text variant="headingMd" as="h2">Select products</Text>
                <Text variant="bodySm" tone="subdued" as="p">
                  Choose one or more products to track.
                </Text>
              </BlockStack>
              {selectedIds.length > 0 && (
                <InlineStack gap="200" blockAlign="center">
                  <Badge tone="info">{`${selectedIds.length} selected`}</Badge>
                  <Button size="slim" variant="plain" onClick={() => setSelectedIds([])}>
                    Clear
                  </Button>
                </InlineStack>
              )}
            </InlineStack>

            <TextField
              label="Search products"
              labelHidden
              value={searchFilter}
              onChange={setSearchFilter}
              placeholder="Search by product name..."
              autoComplete="off"
              clearButton
              onClearButtonClick={() => setSearchFilter("")}
            />

            {filteredProducts.length === 0 && searchFilter ? (
              <Box padding="400">
                <Text tone="subdued" as="p" alignment="center">
                  No products match "{searchFilter}"
                </Text>
              </Box>
            ) : (
              <ResourceList
                resourceName={{ singular: "product", plural: "products" }}
                items={filteredProducts}
                selectedItems={selectedIds}
                onSelectionChange={(ids) =>
                  setSelectedIds(
                    ids === "All"
                      ? filteredProducts.map((p: any) => p.id)
                      : (ids as string[])
                  )
                }
                selectable
                renderItem={(product: any) => {
                  const variant = product.variants.edges[0]?.node;
                  const isTracked = variant && trackedByVariantId.has(variant.id);
                  const trackedConfig = isTracked ? trackedByVariantId.get(variant.id) : null;
                  return (
                    <ResourceItem
                      id={product.id}
                      onClick={() => {
                        setSelectedIds((prev) =>
                          prev.includes(product.id)
                            ? prev.filter((id) => id !== product.id)
                            : [...prev, product.id]
                        );
                      }}
                      media={
                        product.featuredImage ? (
                          <Thumbnail source={product.featuredImage.url} alt={product.title} size="small" />
                        ) : (
                          <Thumbnail source="" alt={product.title} size="small" />
                        )
                      }
                    >
                      <BlockStack gap="100">
                        <InlineStack gap="200" blockAlign="center" wrap={false}>
                          <Text variant="bodyMd" fontWeight="semibold" as="span">
                            {product.title}
                          </Text>
                          {isTracked && (
                            <Badge tone="success" size="small">
                              {`✓ ${trackedConfig!.priceSource}`}
                            </Badge>
                          )}
                        </InlineStack>
                        <Text variant="bodySm" tone="subdued" as="span">
                          {product.variants.edges.length} variant
                          {product.variants.edges.length !== 1 ? "s" : ""} · £{variant?.price}
                        </Text>
                      </BlockStack>
                    </ResourceItem>
                  );
                }}
              />
            )}

            {shopifyProducts.length === 250 && (
              <Banner tone="warning">
                <p>
                  Showing your first 250 products. Use the search above to find others.
                </p>
              </Banner>
            )}
          </BlockStack>
        </Card>

        {/* ── RIGHT: Configure + Cost + Link ───────────────────────────────── */}
        <BlockStack gap="400">
          {selectedIds.length === 0 ? (
            /* Placeholder when nothing is selected */
            <Card>
              <Box padding="600">
                <BlockStack gap="200">
                  <Text variant="bodyMd" tone="subdued" as="p" alignment="center">
                    ← Select one or more products to configure their price source.
                  </Text>
                </BlockStack>
              </Box>
            </Card>
          ) : (
            <>
              {/* ── Overwrite warning (multi-select) ───────────────────────── */}
              {isMultiSelect && selectedWithExistingConfig.length > 0 && (
                <Banner tone="warning" title="Some products already have a price source">
                  <p>
                    {selectedWithExistingConfig.length === 1
                      ? `"${selectedWithExistingConfig[0].title}" already has a price source configured.`
                      : `${selectedWithExistingConfig.length} of the selected products already have a price source configured.`}{" "}
                    Saving will overwrite their existing settings.
                  </p>
                </Banner>
              )}

              {/* ── Configure price source ─────────────────────────────────── */}
              <Card>
                <BlockStack gap="400">
                  <BlockStack gap="050">
                    <Text variant="headingMd" as="h2">Configure price source</Text>
                    {isSingleSelect && singleProduct && (() => {
                      const variantId = singleProduct.variants.edges[0]?.node?.id;
                      return variantId && trackedByVariantId.has(variantId);
                    })() && (
                      <Banner tone="info">
                        <p>This product is already tracked — the existing settings have been pre-filled. Save to update them.</p>
                      </Banner>
                    )}
                    {isMultiSelect && (
                      <Text variant="bodySm" tone="subdued" as="p">
                        Applies to all {selectedIds.length} selected products.
                      </Text>
                    )}
                  </BlockStack>

                  <Select
                    label="Price data source"
                    options={sourceOptions}
                    value={priceSource}
                    onChange={handleSourceChange}
                  />

                  {priceSource !== "ebay" && (
                    <Select
                      label="Card condition / grade"
                      options={conditionOptions}
                      value={cardCondition}
                      onChange={setCardCondition}
                    />
                  )}

                  {/* ── eBay ───────────────────────────────────────────────── */}
                  {priceSource === "ebay" && (
                    <BlockStack gap="400">
                      <Select
                        label="eBay category"
                        options={ebayCategoryOptions}
                        value={ebayCategory}
                        onChange={(v) => { setEbayCategory(v); setEbayConfirmed(false); }}
                      />

                      {isMultiSelect ? (
                        <Banner tone="info" title="Bulk eBay tracking">
                          <p>
                            Each product's Shopify title will be used as its eBay search query.
                            You can refine per-product from the product detail page after linking.
                          </p>
                        </Banner>
                      ) : (
                        <BlockStack gap="300">
                          <Banner tone="info" title="How eBay tracking works">
                            <p>
                              Enter a precise query — we lock it in and run it on every sync.
                              Include set name, card number, and grade/condition.
                            </p>
                          </Banner>

                          <TextField
                            label="eBay search query"
                            value={searchQuery}
                            onChange={(v) => {
                              setSearchQuery(v);
                              setEbayConfirmed(false);
                              // Auto-switch category when a grading service is detected
                              if (/\b(psa|bgs|cgc|sgc|ace)\b/i.test(v)) {
                                setEbayCategory("261328");
                              }
                            }}
                            placeholder='"Charizard Obsidian Flames 199/197 PSA 10" GBP'
                            autoComplete="off"
                            helpText="Include condition/grade, set name, and card number"
                            connectedRight={
                              <Button
                                onClick={handleEbayPreview}
                                loading={isSearching}
                                disabled={!searchQuery.trim()}
                              >
                                Preview
                              </Button>
                            }
                          />

                          {hasEbayError && (
                            <Banner tone="critical" title="eBay search failed">
                              <p>{(actionData as any).error}</p>
                            </Banner>
                          )}

                          {ebayPreviewListings.length > 0 && !ebayConfirmed && (
                            <BlockStack gap="300">
                              {/* Data source indicator */}
                              {ebayUsedSoldData ? (
                                <Banner tone="success" title="Showing sold listings">
                                  <p>
                                    Prices below are from completed transactions — what buyers
                                    actually paid on eBay. This is the most accurate signal for
                                    true market value.
                                  </p>
                                </Banner>
                              ) : (
                                <Banner tone="warning" title="No sold listings found — showing active listings">
                                  <p>
                                    eBay returned no recent sold data for this query. The prices
                                    below are from active (unsold) listings and may not reflect
                                    what buyers are actually paying. Consider refining your query
                                    or checking eBay directly.
                                  </p>
                                </Banner>
                              )}

                              {/* Simplified query notice */}
                              {ebayEffectiveQuery && ebayEffectiveQuery !== searchQuery && (
                                <Banner tone="info" title="Search was simplified">
                                  <p>
                                    No results were found for your exact query. eBay was searched
                                    using a simplified version instead:{" "}
                                    <strong>"{ebayEffectiveQuery}"</strong>. The listings below
                                    reflect that broader search — confirm only if they match the
                                    card you want to track.
                                  </p>
                                </Banner>
                              )}
                              <Text variant="bodyMd" fontWeight="semibold" as="p">
                                Top {ebayPreviewListings.length} {ebayUsedSoldData ? "sold" : "active"} listings:
                              </Text>
                              <DataTable
                                columnContentTypes={["text", "text", "text", "text"]}
                                headings={["Title", "Price", "Condition", ebayUsedSoldData ? "Sold date" : "Listed date"]}
                                rows={ebayPreviewListings.map((l) => [
                                  <Text as="span" variant="bodySm" key={l.itemUrl}>
                                    <Link url={l.itemUrl} external>
                                      {l.title.length > 45 ? l.title.slice(0, 45) + "…" : l.title}
                                    </Link>
                                  </Text>,
                                  `£${l.price.toFixed(2)}`,
                                  l.condition,
                                  l.soldDate ? new Date(l.soldDate).toLocaleDateString("en-GB") : "—",
                                ])}
                              />

                              {/* Average price summary */}
                              {ebayPreviewAverage !== null && (
                                <Box
                                  padding="400"
                                  background="bg-surface-secondary"
                                  borderRadius="200"
                                  borderWidth="025"
                                  borderColor="border"
                                >
                                  <InlineStack align="space-between" blockAlign="center">
                                    <BlockStack gap="100">
                                      <Text variant="bodyMd" fontWeight="semibold" as="p">
                                        Estimated tracking price
                                      </Text>
                                      <Text variant="bodySm" tone="subdued" as="p">
                                        Average of {ebayPreviewListings.length} {ebayUsedSoldData ? "sold" : "active"} listings shown · actual sync uses up to 50
                                      </Text>
                                    </BlockStack>
                                    <Text variant="headingLg" as="p" fontWeight="bold">
                                      £{ebayPreviewAverage.toFixed(2)}
                                    </Text>
                                  </InlineStack>
                                </Box>
                              )}

                              <Banner tone="warning" title="Do these look right?">
                                <p>
                                  If they don't match, refine your query and preview again.
                                </p>
                              </Banner>
                              <InlineStack gap="300">
                                <Button variant="primary" tone="success" onClick={() => setEbayConfirmed(true)}>
                                  ✓ Confirm
                                </Button>
                                <Button onClick={() => { setSearchQuery(""); setEbayConfirmed(false); }}>
                                  Try again
                                </Button>
                              </InlineStack>
                            </BlockStack>
                          )}

                          {isCurrentPreview && ebayPreviewListings.length === 0 && !hasEbayError && (
                            <Banner tone="warning" title="No listings found for this query">
                              <p>
                                eBay returned no active listings for this search. Try:
                              </p>
                              <ul>
                                <li>Removing the grade or condition (e.g. drop "Pristine" or "PSA 10")</li>
                                <li>Shortening to card name + set name only</li>
                                <li>Checking the card number format (e.g. "199/197" vs "199")</li>
                              </ul>
                            </Banner>
                          )}

                          {ebayConfirmed && (
                            <BlockStack gap="300">
                              <Banner tone="success" title="Search confirmed">
                                <p>
                                  <strong>"{searchQuery}"</strong> ·{" "}
                                  {EBAY_POKEMON_CATEGORIES.find((c) => c.value === ebayCategory)?.label}
                                </p>
                              </Banner>
                              {ebayPreviewAverage !== null && (
                                <Box
                                  padding="400"
                                  background="bg-surface-secondary"
                                  borderRadius="200"
                                  borderWidth="025"
                                  borderColor="border"
                                >
                                  <InlineStack align="space-between" blockAlign="center">
                                    <BlockStack gap="100">
                                      <Text variant="bodyMd" fontWeight="semibold" as="p">
                                        Estimated tracking price
                                      </Text>
                                      <Text variant="bodySm" tone="subdued" as="p">
                                        Average of {ebayPreviewListings.length} {ebayUsedSoldData ? "sold" : "active"} listings · actual sync uses up to 50
                                      </Text>
                                    </BlockStack>
                                    <Text variant="headingLg" as="p" fontWeight="bold">
                                      £{ebayPreviewAverage.toFixed(2)}
                                    </Text>
                                  </InlineStack>
                                </Box>
                              )}
                            </BlockStack>
                          )}
                        </BlockStack>
                      )}
                    </BlockStack>
                  )}

                  {/* ── TCGPlayer / PriceCharting ───────────────────────────── */}
                  {priceSource !== "ebay" && (
                    <BlockStack gap="300">
                      {isMultiSelect && (
                        <Banner tone="info" title="Linking multiple products">
                          <p>
                            The same card ID will be linked to all {selectedIds.length} selected
                            products — useful for the same card at different conditions.
                          </p>
                        </Banner>
                      )}

                      <TextField
                        label="Search for this card"
                        value={searchQuery}
                        onChange={setSearchQuery}
                        placeholder="e.g. Charizard ex Obsidian Flames"
                        autoComplete="off"
                        connectedRight={
                          <Button onClick={handleSearch} loading={isSearching}>
                            Search
                          </Button>
                        }
                      />

                      {actionData && "error" in actionData && actionData.error && (
                        <Banner tone="critical" title="Search failed">
                          <p>{actionData.error}</p>
                        </Banner>
                      )}

                      {searchResults.length > 0 && (
                        <BlockStack gap="200">
                          <Text variant="bodyMd" as="p">Select the matching result:</Text>
                          <ResourceList
                            resourceName={{ singular: "result", plural: "results" }}
                            items={searchResults}
                            renderItem={(result: any) => (
                              <ResourceItem id={result.id} onClick={() => setSelectedExternal(result)}>
                                <InlineStack align="space-between">
                                  <BlockStack gap="050">
                                    <Text as="span" variant="bodyMd">{result.name}</Text>
                                    {result.extra && (
                                      <Text as="span" variant="bodySm" tone="subdued">{result.extra}</Text>
                                    )}
                                  </BlockStack>
                                  {selectedExternal?.id === result.id && (
                                    <Badge tone="success">Selected ✓</Badge>
                                  )}
                                </InlineStack>
                              </ResourceItem>
                            )}
                          />
                        </BlockStack>
                      )}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>

              {/* ── Cost price ─────────────────────────────────────────────── */}
              {selectedIds.length > 0 && (
                <Card>
                  <BlockStack gap="400">
                    <BlockStack gap="050">
                      <Text variant="headingMd" as="h2">Cost price (optional)</Text>
                      <Text tone="subdued" variant="bodySm" as="p">
                        Used with floor price rules to protect your minimum margin.
                      </Text>
                    </BlockStack>

                    {/* Single product — Shopify cost available: offer checkbox to use it */}
                    {isSingleSelect && shopifyCostForSingle && (
                      <>
                        <Checkbox
                          label={`Use Shopify cost price (£${shopifyCostForSingle.toFixed(2)})`}
                          checked={useShopifyCost}
                          onChange={setUseShopifyCost}
                        />
                        {!useShopifyCost && (
                          <TextField
                            label="Cost price (£)"
                            type="number"
                            value={costPriceShared}
                            onChange={setCostPriceShared}
                            autoComplete="off"
                            placeholder="e.g. 12.50"
                            prefix="£"
                            helpText="What you paid — used as the anchor for floor price rules."
                          />
                        )}
                      </>
                    )}

                    {/* Single product — no Shopify cost: just show the text field */}
                    {isSingleSelect && !shopifyCostForSingle && (
                      <TextField
                        label="Cost price (£)"
                        type="number"
                        value={costPriceShared}
                        onChange={setCostPriceShared}
                        autoComplete="off"
                        placeholder="e.g. 12.50"
                        prefix="£"
                        helpText="What you paid — used as the anchor for floor price rules."
                      />
                    )}

                    {/* Multi-select: checkbox for Shopify cost + fallback field */}
                    {isMultiSelect && (
                      <>
                        <Checkbox
                          label="Use each product's Shopify cost price where available"
                          checked={useShopifyCost}
                          onChange={setUseShopifyCost}
                        />
                        <TextField
                          label="Fallback cost price (£)"
                          type="number"
                          value={costPriceShared}
                          onChange={setCostPriceShared}
                          autoComplete="off"
                          placeholder="e.g. 12.50"
                          prefix="£"
                          helpText="Applied to products where Shopify cost is not set."
                        />
                      </>
                    )}
                  </BlockStack>
                </Card>
              )}

              {/* ── Cost price warning ──────────────────────────────────────── */}
              {configReady && costPriceMissing && (
                <Banner tone="warning" title="No cost price set">
                  <p>
                    Without a cost price, floor price rules cannot protect your margin.{" "}
                    {isMultiSelect
                      ? "Set a fallback cost price above, or each product's Shopify cost will be used where available."
                      : "Set a cost price above to enable floor price protection."}
                  </p>
                </Banner>
              )}

              {/* ── Link button ─────────────────────────────────────────────── */}
              {configReady && (
                <InlineStack gap="300">
                  <Button variant="primary" onClick={handleLink} loading={isLinking}>
                    {selectedIds.length > 1
                      ? `Link ${selectedIds.length} products`
                      : "Link product"}
                  </Button>
                  <Button
                    onClick={() => {
                      setSelectedIds([]);
                      setSelectedExternal(null);
                      setEbayConfirmed(false);
                      setSearchQuery("");
                      setCostPriceShared("");
                    }}
                  >
                    Clear selection
                  </Button>
                </InlineStack>
              )}
            </>
          )}
        </BlockStack>

      </InlineGrid>
    </Page>
  );
}
