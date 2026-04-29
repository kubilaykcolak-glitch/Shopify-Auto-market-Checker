# 🃏 PriceSync for Shopify
### Automated Pokémon Card Price Tracking & Shopify Sync

PriceSync monitors live market prices for your Pokémon cards and sealed products across TCGPlayer, eBay, and PriceCharting. When prices move, it automatically updates your Shopify listings or disables them — based on rules you define.

---

## 📋 What This App Does

- **Tracks prices** for individual cards and sealed products across 3 data sources
- **Links** each Shopify product to a specific card in your price source
- **Runs automation rules**: update price, disable listing, protect floor price, or just notify you
- **Logs everything** — full audit trail of every price check and action taken
- **Sends alerts** via Slack when big price swings happen

---

## 🗺️ Complete Setup Guide (Start to Finish)

Follow every step in order. This takes approximately **1–2 hours** the first time.

---

### PHASE 1 — Prerequisites

#### 1.1 Install required tools

```bash
# Install Node.js 20+ from https://nodejs.org/
node --version  # Must be 18.20+ or 20.10+

# Install the Shopify CLI
npm install -g @shopify/cli@latest
yes
# Verify
shopify version
```

#### 1.2 Create a Shopify Partner account

1. Go to https://partners.shopify.com and create a free account
2. You need this to create the app and get API credentials
3. If you already have a Partners account, proceed to the next step

#### 1.3 Create a development store (skip if you have your live store)

1. In Partners Dashboard → Stores → Add store → Development store
2. Name it anything (e.g. "pokeprice-dev")
3. This is where you'll test the app before putting it on your live store

---

### PHASE 2 — Create the Shopify App in Partners Dashboard

#### 2.1 Create the app

1. Partners Dashboard → Apps → Create app → Create app manually
2. Name: **PriceSync**
3. Click "Create app"

#### 2.2 Get your API credentials

In your new app's page:
1. Click **Configuration** tab
2. Note down:
   - **Client ID** → this is your `SHOPIFY_API_KEY`
   - **Client secret** → this is your `SHOPIFY_API_SECRET`

#### 2.3 Configure URLs (you'll update these after deployment)

Under "App URL" and "Allowed redirection URLs" — leave blank for now. You'll fill these in after Phase 5.

---

### PHASE 3 — Set Up the Price API Accounts

You need accounts with the price data providers. Do these in parallel as some require approval.

#### 3.1 TCGPlayer Partner API (1-2 weeks approval time — apply first!)

1. Go to https://developer.tcgplayer.com/
2. Click "Apply for API access"
3. Fill out the form — explain you're building a Shopify price sync tool for a Pokémon store
4. You'll receive:
   - `TCGPLAYER_PUBLIC_KEY`
   - `TCGPLAYER_PRIVATE_KEY`
5. **Start this today** — it takes the longest

#### 3.2 eBay Developer Account (instant)

1. Go to https://developer.ebay.com/
2. Click "Join" → create a developer account (free)
3. Once logged in: My Account → Application Keys
4. Click "Get a Free Key Set" → choose Production
5. Copy the **App ID (Client ID)** → this is your `EBAY_APP_ID`
6. Make sure the "Finding" API is enabled (it is by default)

#### 3.3 PriceCharting API (instant, small fee)

1. Go to https://www.pricecharting.com/api-documentation
2. Purchase API access (usually $5-10/month)
3. You'll receive your `PRICECHARTING_API_KEY` immediately

---

### PHASE 4 — Local Development Setup

#### 4.1 Clone and install

```bash
# Navigate to where you want the project
cd ~/Projects

# Install dependencies
cd pokeprice-sync
npm install

# Copy the environment file
cp .env.example .env
```

#### 4.2 Fill in your .env file

Open `.env` in any text editor and fill in:

```
SHOPIFY_API_KEY=          ← From Step 2.2
SHOPIFY_API_SECRET=       ← From Step 2.2
TCGPLAYER_PUBLIC_KEY=     ← From Step 3.1 (when you get it)
TCGPLAYER_PRIVATE_KEY=    ← From Step 3.1 (when you get it)
EBAY_APP_ID=              ← From Step 3.2
PRICECHARTING_API_KEY=    ← From Step 3.3
USD_TO_GBP_RATE=0.79      ← Update this if the rate changes significantly
DATABASE_URL="file:./dev.db"
```

Leave `SHOPIFY_APP_URL` blank for now — it gets set automatically when you run the dev server.

#### 4.3 Set up the database

```bash
# Generate Prisma client and create the SQLite database
npx prisma generate
npx prisma migrate dev --name init
```

This creates a `dev.db` file — your local database.

#### 4.4 Start the development server

```bash
npm run dev
```

The Shopify CLI will:
1. Ask you to log in to your Partner account (opens browser)
2. Ask which store to use — pick your development store
3. Give you a **tunnel URL** like `https://abc123.trycloudflare.com`
4. Start the local server

**Copy the tunnel URL** — you need it for the next step.

#### 4.5 Update app URLs in Partners Dashboard

1. Partners Dashboard → Your App → Configuration
2. **App URL**: paste the tunnel URL (e.g. `https://abc123.trycloudflare.com`)
3. **Allowed redirection URLs**: add both:
   - `https://abc123.trycloudflare.com/auth/callback`
   - `https://abc123.trycloudflare.com/auth/shopify/callback`
4. Save

#### 4.6 Install the app on your development store

```bash
# In the terminal where your dev server is running, it will show:
# "Open this URL to install your app"
# Click that URL, or go to:
# Partners Dashboard → Apps → Your App → Test on development store
```

Follow the installation flow. You should see the PriceSync dashboard.

---

### PHASE 5 — Deploy to Production

For production, you need a proper hosted server. We recommend **Fly.io** (cheapest option, ~$5-10/month) or **Railway**.

#### Option A: Deploy to Fly.io (recommended)

##### 5.1 Install Fly CLI

```bash
# Mac
brew install flyctl

# Windows
iwr https://fly.io/install.ps1 -useb | iex

# Linux
curl -L https://fly.io/install.sh | sh
```

##### 5.2 Log in and create the app

```bash
fly auth login
fly launch --name pokeprice-sync
# When prompted:
# - Region: lhr (London) for UK
# - Do you want a PostgreSQL database? → Yes (choose the smallest/free tier)
# - Deploy now? → No (we'll do it manually after setting secrets)
```

##### 5.3 Set environment secrets on Fly.io

```bash
fly secrets set \
  SHOPIFY_API_KEY="your_key" \
  SHOPIFY_API_SECRET="your_secret" \
  SHOPIFY_APP_URL="https://pokeprice-sync.fly.dev" \
  TCGPLAYER_PUBLIC_KEY="your_key" \
  TCGPLAYER_PRIVATE_KEY="your_key" \
  EBAY_APP_ID="your_id" \
  PRICECHARTING_API_KEY="your_key" \
  USD_TO_GBP_RATE="0.79" \
  SCOPES="read_products,write_products,read_inventory,write_inventory"
```

##### 5.4 Update the database URL for PostgreSQL

```bash
# Get the connection string from Fly.io dashboard or:
fly postgres connect -a your-postgres-app-name

# Set it as a secret:
fly secrets set DATABASE_URL="postgresql://..."
```

Update `prisma/schema.prisma` to use PostgreSQL:
```prisma
datasource db {
  provider = "postgresql"   # ← Change from "sqlite"
  url      = env("DATABASE_URL")
}
```

##### 5.5 Create the Dockerfile

```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y openssl
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npx prisma generate
RUN npm run build
EXPOSE 3000
CMD ["npm", "run", "docker-start"]
```

Save this as `Dockerfile` in the project root.

##### 5.6 Deploy

```bash
fly deploy
```

Your app is now live at `https://pokeprice-sync.fly.dev`

#### Option B: Deploy to Railway

1. Go to https://railway.app — connect your GitHub account
2. Push this project to a GitHub repo
3. New Project → Deploy from GitHub repo → select your repo
4. Add a PostgreSQL plugin
5. Set all environment variables in Railway's dashboard
6. Railway auto-deploys on every git push

---

### PHASE 6 — Go Live on Your Shopify Store

#### 6.1 Update Partners Dashboard with production URL

1. Partners Dashboard → Your App → Configuration
2. Update **App URL** to `https://pokeprice-sync.fly.dev`
3. Update **Allowed redirection URLs** to:
   - `https://pokeprice-sync.fly.dev/auth/callback`
   - `https://pokeprice-sync.fly.dev/auth/shopify/callback`
4. Save

#### 6.2 Install on your live store

1. Partners Dashboard → Your App → Distribution
2. Either:
   - **Custom app** (simplest): Generate an install link and use it just on your own store
   - **Unlisted app**: Install via direct link — good for your own store only
3. Visit: `https://pokeprice-sync.fly.dev/auth?shop=yourstore.myshopify.com`
4. Approve the permissions and install

#### 6.3 Configure your first products

1. In the PriceSync dashboard, click **"Link new product"**
2. Select a Shopify product (e.g. "Charizard ex Obsidian Flames")
3. Choose your price source (TCGPlayer recommended for cards)
4. Search for the card by name
5. Select the matching result
6. Choose the condition (Near Mint, PSA 10, etc.)
7. Click **"Link product"**

#### 6.4 Set up your automation rules

Go to **Automation Rules** and set up at minimum:

1. **Price rise rule**: threshold 5%, action: Update price → This auto-raises your prices when the market rises
2. **Price drop rule**: threshold 20%, action: Disable product → Protects you from selling at a loss if prices crash
3. **Price floor**: margin 10% → Never sell below cost + 10%

#### 6.5 Trigger your first manual sync

Click **"Sync Now"** on the dashboard to immediately fetch prices and test your rules.

---

## 🔧 Ongoing Maintenance

### Updating exchange rates

PriceCharting returns USD prices. Update your `USD_TO_GBP_RATE` environment variable periodically:

```bash
fly secrets set USD_TO_GBP_RATE="0.79"
```

### Checking logs

```bash
fly logs
```

### Database management

```bash
# View your data with Prisma Studio
npx prisma studio

# Run a database migration after schema changes
npx prisma migrate dev --name describe_your_change
```

### Adding more products

You can link as many products as you want. The cron job checks all active products every 30 minutes by default (configurable in Settings).

---

## 📂 Project Structure

```
pokeprice-sync/
├── app/
│   ├── lib/
│   │   ├── tcgplayer.server.ts    ← TCGPlayer API client
│   │   ├── ebay.server.ts         ← eBay Finding API client
│   │   ├── pricecharting.server.ts← PriceCharting API client
│   │   ├── price-engine.server.ts ← Core sync + rule logic
│   │   └── cron.server.ts         ← Scheduled job runner
│   ├── routes/
│   │   ├── app._index.tsx         ← Main dashboard
│   │   ├── app.products.new.tsx   ← Product linking
│   │   ├── app.rules.tsx          ← Automation rules
│   │   ├── app.settings.tsx       ← Store settings
│   │   └── webhooks.*.tsx         ← Shopify webhooks
│   ├── db.server.ts               ← Prisma client singleton
│   ├── shopify.server.ts          ← Shopify app config
│   └── root.tsx                   ← Remix root + Polaris
├── prisma/
│   └── schema.prisma              ← Database schema
├── .env.example                   ← Environment template
└── shopify.app.toml               ← Shopify app config
```

---

## ❓ Troubleshooting

**"TCGPlayer returns no results"**
→ Make sure your API keys are set and you've been approved. Test with a simple card name like "Pikachu".

**"eBay prices seem off"**
→ eBay uses a 30-day median of sold listings. If a card rarely sells on eBay, try PriceCharting instead.

**"Products aren't syncing automatically"**
→ Check that the cron job is running: `fly logs | grep Cron`. The server must stay running — it's not serverless.

**"The app won't install on my store"**
→ Make sure the App URL and redirect URLs in Partners Dashboard exactly match your deployed URL (no trailing slash, correct https).

**"Prisma migration errors on deploy"**
→ Make sure `DATABASE_URL` is set correctly. For PostgreSQL, it must include `?sslmode=require` for most cloud providers.

---

## 🔐 Security Notes

- Never commit your `.env` file
- API keys are stored as environment variables only, never in the database
- The Shopify access token per store is stored encrypted in the database via Shopify's session storage
- All webhooks are verified using HMAC signature validation by the Shopify SDK

---

## 📞 Support

If you get stuck at any step, the most useful resources are:
- Shopify App Dev docs: https://shopify.dev/docs/apps
- Remix docs: https://remix.run/docs
- Prisma docs: https://www.prisma.io/docs
- Fly.io docs: https://fly.io/docs
