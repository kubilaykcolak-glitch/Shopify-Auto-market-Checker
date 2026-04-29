# PriceSync for Shopify â€” Design Spec
**Date:** 2026-04-29
**Approach:** Option B â€” Full audit + targeted extension of existing starter codebase

---

## 1. What This App Does

PriceSync is an embedded Shopify admin app for UK-based PokÃ©mon TCG merchants. It links each Shopify product to a tracked eBay market search, fetches real sold-listing prices on a schedule, evaluates merchant-defined automation rules, and takes actions (update price, disable listing, send alert) when market prices move beyond configured thresholds.

---

## 2. Stack

| Layer | Technology | Reason |
|-------|-----------|--------|
| Framework | Remix (Shopify App Remix SDK) | Official Shopify-recommended framework for embedded apps |
| UI | Shopify Polaris | Required for embedded admin apps |
| ORM | Prisma | Type-safe, works with SQLite (dev) and PostgreSQL (prod) |
| Database | SQLite (dev) / PostgreSQL (prod) | Simple local dev, scalable prod |
| Scheduler | node-cron (in-process) | Sufficient for single-server Fly.io deployment with min_machines_running=1 |
| eBay API | Browse API v1 (OAuth app token) | Current standard, richer sold-listing data than legacy Finding API |
| TCGPlayer API | Partner API v1.39.0 | Official card pricing source |
| PriceCharting | REST API | Good for sealed products and vintage sets |
| Email alerts | Resend SDK | Simple, generous free tier, TypeScript-first |
| Deployment | Fly.io | Low cost, persistent server (required for in-process cron) |

---

## 3. Repository Structure

```
pokeprice-sync/
â”œâ”€â”€ app/
â”‚   â”œâ”€â”€ lib/
â”‚   â”‚   â”œâ”€â”€ ebay.server.ts          â† REWRITE: Browse API with OAuth token cache
â”‚   â”‚   â”œâ”€â”€ tcgplayer.server.ts     â† KEEP: minor hardening only
â”‚   â”‚   â”œâ”€â”€ pricecharting.server.ts â† KEEP: minor hardening only
â”‚   â”‚   â”œâ”€â”€ price-engine.server.ts  â† FIX: floor logic, wire Resend alerts
â”‚   â”‚   â”œâ”€â”€ cron.server.ts          â† KEEP: no changes needed
â”‚   â”‚   â”œâ”€â”€ resend.server.ts        â† NEW: email alert implementation
â”‚   â”‚   â””â”€â”€ fetch-utils.server.ts   â† NEW: fetchWithRetry + rate limit backoff
â”‚   â”œâ”€â”€ routes/
â”‚   â”‚   â”œâ”€â”€ app._index.tsx          â† VERIFY + fix if incomplete
â”‚   â”‚   â”œâ”€â”€ app.products.new.tsx    â† EXTEND: add eBay confirmation step
â”‚   â”‚   â”œâ”€â”€ app.products.$id.tsx    â† NEW: product detail, cost price override
â”‚   â”‚   â”œâ”€â”€ app.rules.tsx           â† VERIFY + fix if incomplete
â”‚   â”‚   â”œâ”€â”€ app.settings.tsx        â† VERIFY + fix if incomplete
â”‚   â”‚   â”œâ”€â”€ api.sync.tsx            â† KEEP
â”‚   â”‚   â”œâ”€â”€ app.tsx                 â† KEEP
â”‚   â”‚   â”œâ”€â”€ auth.$.tsx              â† KEEP
â”‚   â”‚   â””â”€â”€ webhooks.app-uninstalled.tsx â† KEEP
â”‚   â”œâ”€â”€ db.server.ts                â† KEEP
â”‚   â”œâ”€â”€ shopify.server.ts           â† FIX: double boundary import
â”‚   â”œâ”€â”€ root.tsx                    â† KEEP
â”‚   â””â”€â”€ entry.server.tsx            â† KEEP
â”œâ”€â”€ prisma/
â”‚   â””â”€â”€ schema.prisma               â† EXTEND: add costPrice, costPriceSource, ebaySearchQuery, ebayCategoryId
â”œâ”€â”€ docs/
â”‚   â””â”€â”€ superpowers/specs/
â”‚       â””â”€â”€ 2026-04-29-pokeprice-sync-design.md
â”œâ”€â”€ .env.example                    â† EXTEND: add RESEND_API_KEY, EBAY_CLIENT_ID, EBAY_CLIENT_SECRET
â”œâ”€â”€ shopify.app.toml
â”œâ”€â”€ fly.toml
â”œâ”€â”€ Dockerfile
â”œâ”€â”€ package.json                    â† EXTEND: add resend dependency
â”œâ”€â”€ tsconfig.json
â””â”€â”€ vite.config.ts
```

---

## 4. Data Model Changes

### `TrackedProduct` â€” additive fields only

| Field | Type | Purpose |
|-------|------|---------|
| `costPrice` | `Float?` | Merchant cost â€” floor rule anchor. Null = no floor protection active |
| `costPriceSource` | `String?` | `"shopify"` or `"manual"` â€” audit trail for where cost came from |
| `ebaySearchQuery` | `String?` | Exact eBay search string saved at link time. Used on every sync |
| `ebayCategoryId` | `String?` | eBay category ID locked at link time (e.g. `"183454"`) |

No existing fields removed or renamed. Migration is purely additive.

### New environment variables

| Variable | Purpose |
|----------|---------|
| `EBAY_CLIENT_ID` | Same value as current `EBAY_APP_ID` â€” Browse API client ID |
| `EBAY_CLIENT_SECRET` | Browse API client secret (from eBay developer dashboard, same page as Client ID) |
| `RESEND_API_KEY` | From resend.com â€” used for email alerts |

`EBAY_APP_ID` is deprecated and removed from `.env.example` (replaced by `EBAY_CLIENT_ID`).

---

## 5. eBay Browse API Integration

### Auth flow
- `getEbayAppToken()` â€” POST to `https://api.ebay.com/identity/v1/oauth2/token` with `grant_type=client_credentials` and scope `https://api.ebay.com/oauth/api_scope/buy.item.summary`
- Token cached in module-level variable with expiry timestamp
- Token refresh is transparent â€” all callers just call `getEbayAppToken()` and get a valid token

### API endpoint used
`GET https://api.ebay.com/buy/browse/v1/item_summary/search`

Key parameters:
- `q` â€” the saved `ebaySearchQuery`
- `category_ids` â€” the saved `ebayCategoryId`
- `filter` â€” `buyingOptions:{FIXED_PRICE},soldItemsOnly:true,currency:GBP,itemLocationCountry:GB`
- `sort` â€” `newlyListed` (most recent first)
- `limit` â€” `50` for price sync, `5` for confirmation preview

### Price calculation
1. Collect all `price.value` fields from response items
2. Filter to items sold within last 30 days using `itemEndDate`
3. Remove top 10% and bottom 10% outliers
4. Return median of remaining prices

### Confirmation preview (product linking)
- Returns top 5 results with: `title`, `price.value`, `itemEndDate`, `condition`
- Shown to merchant before saving â€” they confirm results look sensible
- If merchant rejects, they refine the search query and try again

---

## 6. Product Matching Flow

1. Merchant clicks "Link new product" in dashboard
2. Selects a Shopify product from a dropdown (fetched from Shopify Admin API)
3. Selects price source: `tcgplayer`, `ebay`, or `pricecharting`
4. **If eBay:**
   - Types search query (e.g. `"Charizard Obsidian Flames 199/197 PSA 10 GBP"`)
   - Selects eBay category (dropdown: Individual Cards, Sealed Packs, Sealed Boxes, etc.)
   - Clicks "Preview results"
   - App fetches top 5 sold listings and displays them in a table
   - Merchant reviews and clicks "Looks right â€” save" or refines query and tries again
   - On save: `ebaySearchQuery` + `ebayCategoryId` stored in DB
5. **If TCGPlayer or PriceCharting:**
   - Types card name â†’ search results shown â†’ merchant picks exact match
   - Product ID stored as `externalId`
6. App attempts to pull `costPrice` from Shopify `inventoryItem.unitCost`
7. If Shopify cost is present: pre-fills the cost price field, sets `costPriceSource = "shopify"`
8. Merchant can override the cost price value before saving
9. Product saved to DB as `TrackedProduct` with all fields populated

---

## 7. Price Engine Fixes

### Floor rule fix
**Current (broken):** `floorPrice = shopifyCurrentPrice * (1 + margin%)`
**Fixed:** `floorPrice = costPrice * (1 + margin%)`

The floor is only applied if `costPrice` is set. If `costPrice` is null, the floor rule is skipped with a warning logged.

### Rule evaluation order (unchanged)
1. Floor check â€” if market price < floor, cap at floor price, stop
2. Price drop rules â€” evaluate largest threshold first
3. Price rise rules â€” evaluate largest threshold first
4. Notify rules â€” always evaluate, fire alert if threshold exceeded

### Alert wiring
- Slack: existing implementation kept
- Email: new `sendEmailAlert()` call in `resend.server.ts` â€” fires if `settings.emailAlerts === true` and `settings.alertEmail` is set

---

## 8. Email Alerts (Resend)

**File:** `app/lib/resend.server.ts`

- Uses `resend` npm package
- Sends a plain-text email (no HTML template required for MVP)
- Subject: `PriceSync Alert â€” [product title]`
- Body: action taken, old price, new price, change percent, rule that triggered
- From address: configurable via `RESEND_FROM_EMAIL` env var (defaults to `alerts@yourdomain.com`)
- Only fires when `settings.emailAlerts === true` AND `settings.alertEmail` is non-null

---

## 9. New Utility: fetchWithRetry

**File:** `app/lib/fetch-utils.server.ts`

- Wraps `fetch()` with up to 3 retry attempts
- Exponential backoff: 1s, 2s, 4s
- On HTTP 429 (rate limited): reads `Retry-After` header if present, waits that duration
- On HTTP 5xx: retries
- On HTTP 4xx (except 429): throws immediately (no retry â€” these are caller errors)
- All eBay, TCGPlayer, and PriceCharting fetch calls use this wrapper

---

## 10. New Route: app.products.$id.tsx

**Purpose:** Product detail and edit page for a linked product.

**Shows:**
- Product title + Shopify variant
- Price source + external name/query
- Current market price + last checked time
- Cost price field (editable) with source badge ("from Shopify" or "manual")
- Baseline price
- Pause/unpause toggle
- Price history log (last 20 entries)
- "Unlink product" button

**Actions:**
- Update cost price (POST with `intent=update_cost`)
- Pause/unpause tracking (POST with `intent=toggle_pause`)
- Unlink product (POST with `intent=unlink`)

---

## 11. shopify.server.ts Fix

**Current bug:** `boundary` is imported from `@shopify/shopify-app-remix/server` at the top, then re-exported â€” but `shopifyApp()` also returns a `boundary` property, and both are exported with the same name. This causes a TypeScript conflict and potential runtime confusion.

**Fix:** Remove the top-level `boundary` import. Export `shopify.boundary` as the named export. This matches the pattern in official Shopify App Remix examples.

---

## 12. Webhooks

| Webhook | Route | Purpose |
|---------|-------|---------|
| `app/uninstalled` | `webhooks.app-uninstalled.tsx` | Clean up store record and all associated data on uninstall |

No new webhooks needed. `products/update` webhook is not required because the app reads Shopify product data at sync time rather than maintaining a real-time mirror.

---

## 13. Scheduled Jobs

| Job | Schedule | Implementation |
|-----|----------|---------------|
| Price sync â€” all stores | Every 30 minutes | `cron.server.ts` via `node-cron`, started in `entry.server.tsx` |

Per-store interval override (`StoreSettings.pollIntervalMinutes`) is already in the schema but not yet wired into the cron logic. This is a known gap â€” deferred to future phase.

---

## 14. Deployment

Target: Fly.io, single machine, `min_machines_running = 1` (already configured in `fly.toml`).

The in-process `node-cron` scheduler requires a persistent server. Fly.io with `auto_stop_machines = false` satisfies this.

PostgreSQL in production: either Fly Postgres (managed) or an external provider (Supabase, Neon). Schema switch requires changing `prisma/schema.prisma` provider from `sqlite` to `postgresql`.

---

## 15. Known Gaps Deferred to Future Phase

- Per-store poll interval (schema exists, cron not wired to it)
- Email from-address domain verification in Resend (requires DNS setup)
- `products/update` webhook for real-time Shopify price sync reflection
- GraphQL Admin API migration (REST works correctly for current scope)
- BullMQ job queue (only needed if running multiple store instances at scale)
- PSA/BGS graded card condition refinement in eBay search
- TCGPlayer market price â†’ historical chart view

---

## 16. Files to Produce (Implementation Checklist)

### Rewrite
- [ ] `app/lib/ebay.server.ts`

### Fix
- [ ] `app/shopify.server.ts`
- [ ] `app/lib/price-engine.server.ts`
- [ ] `prisma/schema.prisma`
- [ ] `.env.example`
- [ ] `package.json` (add `resend` dependency)

### New
- [ ] `app/lib/resend.server.ts`
- [ ] `app/lib/fetch-utils.server.ts`
- [ ] `app/routes/app.products.$id.tsx`

### Verify and complete
- [ ] `app/routes/app._index.tsx`
- [ ] `app/routes/app.products.new.tsx`
- [ ] `app/routes/app.rules.tsx`
- [ ] `app/routes/app.settings.tsx`

### Keep as-is (no changes)
- [ ] `app/lib/tcgplayer.server.ts`
- [ ] `app/lib/pricecharting.server.ts`
- [ ] `app/lib/cron.server.ts`
- [ ] `app/db.server.ts`
- [ ] `app/root.tsx`
- [ ] `app/entry.server.tsx`
- [ ] `app/routes/app.tsx`
- [ ] `app/routes/auth.$.tsx`
- [ ] `app/routes/api.sync.tsx`
- [ ] `app/routes/webhooks.app-uninstalled.tsx`
- [ ] `shopify.app.toml`
- [ ] `fly.toml`
- [ ] `Dockerfile`
- [ ] `tsconfig.json`
- [ ] `vite.config.ts`

