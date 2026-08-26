# DomainPricingBot

Telegram Bot check giá domain qua Cloudflare Registrar API, chạy trên Cloudflare Workers.
Website đi kèm: https://domainpricing.uk (chưa mua domain)

## Cấu trúc

```
.
├── src/
│   └── index.ts          # Toàn bộ logic Worker (1 file duy nhất)
├── static/                # CSV giá của các nhà đăng ký, đọc qua Workers Static Assets
│   ├── spaceship.com.csv
│   ├── godaddy.com.csv
│   ├── ...
│   └── rdap_supported_tlds.json
├── wrangler.toml
├── package.json
└── tsconfig.json
```

## Cách hoạt động

1. **Chat thường** (không phải lệnh `/...`):
   - Gửi 1 domain đầy đủ (vd `example.com`) → bot check đúng domain đó qua Cloudflare Registrar API.
   - Gửi 1 từ khoá (vd `example`) → bot ghép với 20 TLD phổ biến và check hàng loạt.
   - Giá hiển thị lấy trực tiếp từ Cloudflare Registrar API (`tier: standard`).
   - Domain premium (`tier: premium`) → hiển thị "Domain premium", link trỏ Cloudflare.
   - Domain unavailable → hiển thị "Domain unavailable", link Whois (`/whois?whois=domain.com`).

2. **Lệnh nhà cung cấp** (`/spaceship`, `/name`, `/godaddy`, ...):
   - Vẫn gọi Cloudflare Registrar API để biết `tier`/`registrable`.
   - Nếu `tier: standard` và registrable → lấy giá từ file CSV tương ứng trong `static/` (không gọi API của nhà cung cấp đó).
   - Nếu TLD không có trong CSV → `❌ Unsupported domain`.
   - Nếu `tier: premium` → hiển thị "Domain premium", link trỏ tên nhà cung cấp (vd "Spaceship").

3. Bảng kết quả được gửi dưới dạng **Telegram Rich Message** (`sendRichMessage`, Bot API 10.1+) dùng `RichBlockTable` với `colspan` để gộp ô "Domain unavailable"/"Domain premium". Nếu client/API không hỗ trợ, bot tự động fallback sang tin nhắn HTML thường.

## Bảng ánh xạ lệnh → CSV

Khai báo cứng trong `PROVIDER_MAP` (`src/index.ts`), không quét thư mục:

| Lệnh | File CSV | Tên hiển thị |
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

> ⚠️ Các file CSV trong `static/` hiện tại (trừ `spaceship.com.csv`) là **placeholder cần bạn thay bằng file thật** theo đúng format `tld,registration,renewal`.

## Setup

### 1. Cài đặt

```bash
npm install
```

### 2. Set secrets

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET   # chuỗi bí mật tự đặt (A-Z a-z 0-9 _ -)
wrangler secret put CLOUDFLARE_API_TOKEN      # token có quyền Registrar:Read
wrangler secret put CLOUDFLARE_ACCOUNT_ID
```

### 3. Deploy

```bash
npm run deploy
```

Sau khi deploy, bạn sẽ có URL dạng `https://domain-pricing-bot.<subdomain>.workers.dev`.

### 4. Đăng ký webhook với Telegram

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<worker-url>/webhook",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET>"
  }'
```

### 5. Đăng ký danh sách lệnh với BotFather (tuỳ chọn, endpoint tiện ích)

```bash
curl "https://<worker-url>/setup-commands"
```

## Type-check

```bash
npm run typecheck
```

## Ghi chú

- `sendRichMessage` / `RichBlockTable` là tính năng Bot API 10.1 (June 2026). Đảm bảo dùng client Telegram đủ mới để thấy bảng hiển thị đúng; nếu không, bot tự fallback về tin nhắn HTML.
- Đường dẫn `/whois?whois=domain.com` và `/redirect?provider=...&domain=...` là các route cần bạn tự triển khai trên website `domainpricing.uk`.
