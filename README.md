# DomainPricingBot

Telegram Bot for checking domain pricing via the Cloudflare Registrar API, running on Cloudflare Workers.
Companion website: https://domainpricing.uk (domain not yet purchased)

## Structure

```
.
├── src/
│   └── index.ts          # All Worker logic (single file)
├── static/                # Registrar pricing CSVs, read via Workers Static Assets
│   ├── spaceship.com.csv
│   ├── godaddy.com.csv
│   ├── ...
│   └── rdap_supported_tlds.json
├── wrangler.toml
├── package.json
└── tsconfig.json
```

## How it works

1. **Plain chat** (not a `/...` command):
   - Send a full domain (e.g. `example.com`) → the bot checks that exact domain via the Cloudflare Registrar API.
   - Send a keyword (e.g. `example`) → the bot combines it with 20 popular TLDs and checks them in bulk.
   - Pricing shown comes directly from the Cloudflare Registrar API (`tier: standard`).
   - Premium domains (`tier: premium`) → shown as "Domain premium", link points to Cloudflare.
   - Unavailable domains → shown as "Domain unavailable", link points to Whois (`/whois?whois=domain.com`).

2. **Provider commands** (`/spaceship`, `/name`, `/godaddy`, ...):
   - Still calls the Cloudflare Registrar API to determine `tier`/`registrable`.
   - If `tier: standard` and registrable → the price is looked up from the matching CSV file in `static/` (that provider's own API is never called).
   - If the TLD is not found in the CSV → `❌ Unsupported domain`.
   - If `tier: premium` → shown as "Domain premium", link points to the provider name (e.g. "Spaceship").

3. Result tables are sent as a **Telegram Rich Message** (`sendRichMessage`, Bot API 10.1+) using `RichBlockTable` with `colspan` to merge the "Domain unavailable"/"Domain premium" cell. If the client/API doesn't support it, the bot automatically falls back to a plain HTML message.

## Command → CSV mapping

Hardcoded in `PROVIDER_MAP` (`src/index.ts`), no directory scanning:

| Command | CSV file | Display name |
|---|---|---|
| /spaceship | spaceship.com.csv | Spaceship |
| /name | name.com.csv | Name.com |
| /godaddy | godaddy.com.csv | GoDaddy |
| /namecheap | namecheap.com.csv | Namecheap |
| /namesilo | namesilo.com.csv | NameSilo |
| /porkbun | porkbun.com.csv | Porkbun |
| /dynadot | dynadot.com.csv | Dynadot |
| /gandi | gandi.net.csv | Gandi |
| /hover | hover.com.csv | Hover |
| /hostinger | hostinger.com.csv | Hostinger |
| /dreamhost | dreamhost.com.csv | DreamHost |
| /ionos | ionos.com.csv | IONOS |
| /sav | sav.com.csv | Sav |
| /squarespace | squarespace.com.csv | Squarespace |
| /101domain | 101domain.com.csv | 101domain |

> ⚠️ The CSV files in `static/` (other than `spaceship.com.csv`) are currently **placeholders you need to replace with real data**, following the `tld,registration,renewal` format.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Set secrets

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET   # a secret string you choose (A-Z a-z 0-9 _ -)
wrangler secret put CLOUDFLARE_API_TOKEN      # token with Registrar:Read permission
wrangler secret put CLOUDFLARE_ACCOUNT_ID
```

### 3. Deploy

```bash
npm run deploy
```

After deploying, you'll get a URL like `https://domainpricingbot.<subdomain>.workers.dev`.

### 4. Register the webhook with Telegram

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<worker-url>/webhook",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET>"
  }'
```

### 5. Register the command list with BotFather (optional, utility endpoint)

```bash
curl "https://<worker-url>/setup-commands"
```

## Type-check

```bash
npm run typecheck
```

## Notes

- `sendRichMessage` / `RichBlockTable` is a Bot API 10.1 feature (June 2026). Make sure to use a recent enough Telegram client to see the table rendered correctly; otherwise the bot falls back to a plain HTML message.
- The routes `/whois?whois=domain.com` and `/redirect?provider=...&domain=...` are expected to be implemented on your `domainpricing.uk` website.
