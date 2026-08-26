/**
 * DomainPricingBot — Telegram Bot check giá domain qua Cloudflare Registrar API
 * Chạy trên Cloudflare Workers, không dùng framework (không Hono).
 * Toàn bộ logic nằm trong 1 file duy nhất theo yêu cầu.
 *
 * Website: https://domainpricing.uk
 */

// =====================================================================================
// TYPES
// =====================================================================================

export interface Env {
  ASSETS: Fetcher;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; first_name?: string; username?: string };
  text?: string;
  entities?: Array<{ type: string; offset: number; length: number }>;
}

interface CfDomainCheckResultItem {
  name: string;
  registrable: boolean;
  tier: "standard" | "premium";
  reason?: string;
  pricing?: {
    currency: string;
    registration_cost: string;
    renewal_cost: string;
  };
}

interface CfDomainCheckResponse {
  result: { domains: CfDomainCheckResultItem[] };
  success: boolean;
  errors: unknown[];
  messages: unknown[];
}

// Một dòng dữ liệu đã chuẩn hoá để đưa vào bảng
interface DomainRow {
  domain: string;
  // Nếu status !== null, ô Registration/Renewal sẽ được gộp (colspan=2) hiển thị status
  status: string | null; // vd "Domain unavailable" | "Domain premium" | "❌ Unsupported domain"
  registration?: string; // vd "$30.00"
  renewal?: string; // vd "$30.00"
  linkLabel: string; // vd "Whois" | "Cloudflare" | "Spaceship" | "Redirect"
  linkUrl: string;
}

// =====================================================================================
// CONFIG: PROVIDER MAP (lệnh -> tên file CSV trong static/)
// Bảng ánh xạ cố định theo yêu cầu (không quét thư mục, số lượng không đổi).
// Phần trước dấu "." đầu tiên của tên file được dùng làm tên lệnh.
// =====================================================================================

interface ProviderInfo {
  csvFile: string; // tên file trong static/
  displayName: string; // tên hiển thị trong cột Link vd "Spaceship"
}

const PROVIDER_MAP: Record<string, ProviderInfo> = {
  spaceship: { csvFile: "spaceship.com.csv", displayName: "Spaceship" },
  name: { csvFile: "name.com.csv", displayName: "Name.com" },
  godaddy: { csvFile: "godaddy.com.csv", displayName: "GoDaddy" },
  namecheap: { csvFile: "namecheap.com.csv", displayName: "Namecheap" },
  namesilo: { csvFile: "namesilo.com.csv", displayName: "NameSilo" },
  porkbun: { csvFile: "porkbun.com.csv", displayName: "Porkbun" },
  dynadot: { csvFile: "dynadot.com.csv", displayName: "Dynadot" },
  gandi: { csvFile: "gandi.net.csv", displayName: "Gandi" },
  hover: { csvFile: "hover.com.csv", displayName: "Hover" },
  hostinger: { csvFile: "hostinger.com.csv", displayName: "Hostinger" },
  dreamhost: { csvFile: "dreamhost.com.csv", displayName: "DreamHost" },
  ionos: { csvFile: "ionos.com.csv", displayName: "IONOS" },
  sav: { csvFile: "sav.com.csv", displayName: "Sav" },
  squarespace: { csvFile: "squarespace.com.csv", displayName: "Squarespace" },
  "101domain": { csvFile: "101domain.com.csv", displayName: "101domain" },
};

const SITE_BASE_URL = "https://domainpricing.uk";

// =====================================================================================
// UTILITIES: keyword -> danh sách domain, format tiền, v.v.
// =====================================================================================

const DEFAULT_TLDS = [
  "com", "org", "net", "io", "ai", "co", "app", "dev", "me", "xyz",
  "tech", "cloud", "online", "site", "link", "blog", "info", "gg", "pro", "wiki",
];

/** Trả về true nếu chuỗi trông giống 1 domain đầy đủ (có dấu chấm và TLD hợp lệ cơ bản) */
function looksLikeFullDomain(input: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(input);
}

/** Tách "example.com" -> { sld: "example", tld: "com" } (tld = phần sau dấu . cuối cùng) */
function splitDomain(domain: string): { sld: string; tld: string } {
  const idx = domain.lastIndexOf(".");
  return { sld: domain.slice(0, idx), tld: domain.slice(idx + 1) };
}

function buildDomainListFromKeyword(keyword: string): string[] {
  const cleanKeyword = keyword.toLowerCase().trim();
  return DEFAULT_TLDS.map((tld) => `${cleanKeyword}.${tld}`);
}

function formatMoney(amount: string, currency: string): string {
  const symbol = currency === "USD" ? "$" : `${currency} `;
  return `${symbol}${amount}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// =====================================================================================
// CSV LOADER (đọc từ Workers Static Assets)
// =====================================================================================

// Cache trong bộ nhớ instance (mỗi isolate); tránh đọc lại asset trong cùng 1 lần chạy
const csvCache = new Map<string, Map<string, { registration: string; renewal: string }>>();

async function loadProviderCsv(
  env: Env,
  csvFile: string
): Promise<Map<string, { registration: string; renewal: string }>> {
  const cached = csvCache.get(csvFile);
  if (cached) return cached;

  const url = new URL(`https://assets.local/${csvFile}`);
  const res = await env.ASSETS.fetch(new Request(url.toString()));
  if (!res.ok) {
    throw new Error(`Không đọc được file CSV: ${csvFile} (status ${res.status})`);
  }
  const text = await res.text();

  const map = new Map<string, { registration: string; renewal: string }>();
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  // Dòng đầu là header: tld,registration,renewal
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length < 3) continue;
    const [tld, registration, renewal] = parts;
    map.set(tld.trim().toLowerCase(), {
      registration: registration.trim(),
      renewal: renewal.trim(),
    });
  }

  csvCache.set(csvFile, map);
  return map;
}

// =====================================================================================
// CLOUDFLARE REGISTRAR API
// =====================================================================================

async function checkDomainsViaCloudflare(
  env: Env,
  domains: string[]
): Promise<CfDomainCheckResultItem[]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/registrar/domain-check`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ domains }),
  });

  const data: CfDomainCheckResponse = await res.json();
  if (!data.success) {
    throw new Error(
      `Cloudflare API lỗi: ${JSON.stringify(data.errors ?? data.messages ?? "unknown")}`
    );
  }
  return data.result.domains;
}

// =====================================================================================
// XÂY DỰNG DomainRow TỪ KẾT QUẢ CLOUDFLARE (chế độ mặc định - không kèm provider)
// =====================================================================================

function buildDefaultRow(item: CfDomainCheckResultItem): DomainRow {
  const whoisLink = `${SITE_BASE_URL}/whois?whois=${encodeURIComponent(item.name)}`;

  if (!item.registrable) {
    if (item.reason === "domain_premium") {
      // Domain premium: không hỗ trợ đăng ký qua API nhưng vẫn đăng ký được thực tế
      return {
        domain: item.name,
        status: "Domain premium",
        linkLabel: "Cloudflare",
        linkUrl: whoisLink,
      };
    }
    // domain_unavailable, extension_not_supported, extension_not_supported_via_api, v.v.
    return {
      domain: item.name,
      status: "Domain unavailable",
      linkLabel: "Whois",
      linkUrl: whoisLink,
    };
  }

  // registrable = true, tier standard, có pricing
  const registration = item.pricing
    ? formatMoney(item.pricing.registration_cost, item.pricing.currency)
    : "N/A";
  const renewal = item.pricing
    ? formatMoney(item.pricing.renewal_cost, item.pricing.currency)
    : "N/A";

  return {
    domain: item.name,
    status: null,
    registration,
    renewal,
    linkLabel: "Redirect",
    linkUrl: `${SITE_BASE_URL}/redirect?provider=spaceship.com&domain=${encodeURIComponent(
      item.name
    )}`,
  };
}

// =====================================================================================
// XÂY DỰNG DomainRow KHI DÙNG LỆNH PROVIDER (/spaceship, /name, ...)
//
// Quy tắc:
// - Gọi Cloudflare API để lấy tier/registrable như bình thường.
// - Nếu tier === "standard": lấy giá từ CSV của provider theo TLD (không dùng giá CF trả).
//   - Nếu domain unavailable (registrable=false, reason=domain_unavailable) -> "Domain unavailable" + link Whois.
//   - Nếu TLD không có trong CSV của provider -> "❌ Unsupported domain".
// - Nếu tier === "premium": hiển thị "Domain premium" + link = tên provider (không phải Cloudflare).
// =====================================================================================

async function buildProviderRow(
  env: Env,
  item: CfDomainCheckResultItem,
  provider: ProviderInfo
): Promise<DomainRow> {
  const whoisLink = `${SITE_BASE_URL}/whois?whois=${encodeURIComponent(item.name)}`;

  // Domain premium: dùng theo đúng yêu cầu -> |Domain premium|<Provider>|
  if (item.tier === "premium") {
    return {
      domain: item.name,
      status: "Domain premium",
      linkLabel: provider.displayName,
      linkUrl: whoisLink,
    };
  }

  // tier === "standard"
  if (!item.registrable) {
    // domain_unavailable / extension_not_supported / extension_not_supported_via_api
    return {
      domain: item.name,
      status: "Domain unavailable",
      linkLabel: "Whois",
      linkUrl: whoisLink,
    };
  }

  // Registrable, tier standard -> tra giá theo CSV provider
  const { tld } = splitDomain(item.name);
  const csvMap = await loadProviderCsv(env, provider.csvFile);
  const priceRow = csvMap.get(tld.toLowerCase());

  if (!priceRow) {
    return {
      domain: item.name,
      status: "❌ Unsupported domain",
      linkLabel: "Whois",
      linkUrl: whoisLink,
    };
  }

  return {
    domain: item.name,
    status: null,
    registration: `$${priceRow.registration}`,
    renewal: `$${priceRow.renewal}`,
    linkLabel: provider.displayName,
    linkUrl: `${SITE_BASE_URL}/redirect?provider=${encodeURIComponent(
      provider.csvFile.replace(/\.csv$/, "")
    )}&domain=${encodeURIComponent(item.name)}`,
  };
}

// =====================================================================================
// TELEGRAM RICH MESSAGE: xây bảng RichBlockTable
// Cấu trúc theo Bot API 10.1 Rich Messages, gộp ô dùng colspan/rowspan
// trên RichBlockTableCell (tương đương thuộc tính HTML table chuẩn).
// =====================================================================================

interface RichBlockTableCell {
  text: string;
  colspan?: number;
  rowspan?: number;
  bold?: boolean;
}

function buildDomainTableRichBlock(rows: DomainRow[]) {
  const headerRow: RichBlockTableCell[] = [
    { text: "Domain", bold: true },
    { text: "Registration", bold: true },
    { text: "Renewal", bold: true },
    { text: "Link", bold: true },
  ];

  const bodyRows: RichBlockTableCell[][] = rows.map((row) => {
    if (row.status !== null) {
      // Ô gộp Registration+Renewal (colspan=2)
      return [
        { text: row.domain },
        { text: row.status, colspan: 2 },
        { text: row.linkLabel },
      ];
    }
    return [
      { text: row.domain },
      { text: row.registration ?? "" },
      { text: row.renewal ?? "" },
      { text: row.linkLabel },
    ];
  });

  return {
    type: "table",
    rows: [headerRow, ...bodyRows],
  };
}

/**
 * sendRichMessage tới Telegram với 1 block bảng.
 * Vì các trường chi tiết (colspan/rowspan) đã được xác nhận tương đương
 * thuộc tính HTML chuẩn <td colspan rowspan>, ta gửi kèm text link riêng cho mỗi dòng
 * (dùng RichTextUrl) để đảm bảo tương thích ngay cả khi client chưa hỗ trợ table đầy đủ.
 */
async function sendDomainTable(
  env: Env,
  chatId: number,
  title: string,
  rows: DomainRow[],
  unsupportedNotes: string[] = []
) {
  const table = buildDomainTableRichBlock(rows);

  // Chuyển các cell text thành RichText đơn giản, cell Link thành RichTextUrl (link bấm được)
  const richRows = table.rows.map((cells, rowIndex) => {
    const isHeader = rowIndex === 0;
    return cells.map((cell, cellIndex) => {
      const isLinkColumn =
        !isHeader &&
        ((cell.colspan === 2 && cellIndex === 2) || (!("colspan" in cell) && cellIndex === 3));
      if (isLinkColumn) {
        const row = rows[rowIndex - 1];
        return {
          text: [{ type: "url", text: cell.text, url: row.linkUrl }],
          colspan: cell.colspan,
          rowspan: cell.rowspan,
        };
      }
      return {
        text: [
          isHeader
            ? { type: "bold", text: cell.text }
            : { type: "plain", text: cell.text },
        ],
        colspan: cell.colspan,
        rowspan: cell.rowspan,
      };
    });
  });

  const blocks: unknown[] = [
    { type: "paragraph", text: [{ type: "bold", text: title }] },
    { type: "table", rows: richRows },
  ];

  if (unsupportedNotes.length > 0) {
    blocks.push({
      type: "paragraph",
      text: [
        {
          type: "plain",
          text: unsupportedNotes.join("\n"),
        },
      ],
    });
  }

  const payload = {
    chat_id: chatId,
    rich_message: { blocks },
  };

  const res = await callTelegram(env, "sendRichMessage", payload);

  // Fallback: nếu sendRichMessage lỗi (client/API chưa hỗ trợ), gửi lại bằng HTML monospace
  if (!res.ok) {
    await sendFallbackHtmlTable(env, chatId, title, rows, unsupportedNotes);
  }
}

/** Fallback dùng parse_mode HTML + <pre> để đảm bảo luôn hiển thị được, kể cả khi Rich Message lỗi */
async function sendFallbackHtmlTable(
  env: Env,
  chatId: number,
  title: string,
  rows: DomainRow[],
  unsupportedNotes: string[]
) {
  const lines: string[] = [];
  lines.push(`<b>${escapeHtml(title)}</b>`);
  lines.push("");
  for (const row of rows) {
    lines.push(`<b>${escapeHtml(row.domain)}</b>`);
    if (row.status !== null) {
      lines.push(`  ${escapeHtml(row.status)}`);
    } else {
      lines.push(`  Registration: ${escapeHtml(row.registration ?? "")}`);
      lines.push(`  Renewal: ${escapeHtml(row.renewal ?? "")}`);
    }
    lines.push(`  <a href="${escapeHtml(row.linkUrl)}">${escapeHtml(row.linkLabel)}</a>`);
    lines.push("");
  }
  if (unsupportedNotes.length > 0) {
    lines.push(...unsupportedNotes.map(escapeHtml));
  }

  await callTelegram(env, "sendMessage", {
    chat_id: chatId,
    text: lines.join("\n"),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

// =====================================================================================
// TELEGRAM API HELPER
// =====================================================================================

async function callTelegram(
  env: Env,
  method: string,
  payload: Record<string, unknown>
): Promise<{ ok: boolean; description?: string }> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json<{ ok: boolean; description?: string }>();
  return data;
}

async function sendPlainMessage(env: Env, chatId: number, text: string) {
  await callTelegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

// =====================================================================================
// COMMAND HANDLERS
// =====================================================================================

const HELP_TEXT = `<b>DomainPricingBot</b> — check giá domain nhanh qua Cloudflare Registrar.

<b>Cách dùng:</b>
• Gửi trực tiếp 1 domain đầy đủ, vd: <code>example.com</code> → xem giá domain đó.
• Gửi 1 từ khoá, vd: <code>example</code> → xem giá 20 TLD phổ biến cho từ khoá đó.

<b>Lệnh nâng cao (check theo bảng giá của 1 nhà cung cấp cụ thể):</b>
${Object.entries(PROVIDER_MAP)
  .map(([cmd, info]) => `• /${cmd} &lt;domain hoặc từ khoá&gt; — giá theo ${info.displayName}`)
  .join("\n")}

Ví dụ: <code>/spaceship dexium</code> hoặc <code>/name example.com</code>

🌐 ${SITE_BASE_URL}`;

const START_TEXT = `👋 Chào mừng đến với <b>DomainPricingBot</b>!

Bot giúp bạn tra giá đăng ký &amp; gia hạn domain nhanh chóng qua Cloudflare Registrar.

<b>Bắt đầu ngay:</b>
• Gửi 1 domain, vd: <code>example.com</code>
• Hoặc gửi 1 từ khoá, vd: <code>example</code> để check 20 TLD phổ biến

Gõ /help để xem đầy đủ các lệnh và tính năng nâng cao.

🌐 ${SITE_BASE_URL}`;

async function handleDefaultCheck(env: Env, chatId: number, query: string) {
  const input = query.trim().toLowerCase();
  if (!input) {
    await sendPlainMessage(env, chatId, "⚠️ Vui lòng nhập domain hoặc từ khoá cần check.");
    return;
  }

  const isFullDomain = looksLikeFullDomain(input);
  const domains = isFullDomain ? [input] : buildDomainListFromKeyword(input);

  let results: CfDomainCheckResultItem[];
  try {
    results = await checkDomainsViaCloudflare(env, domains);
  } catch (err) {
    await sendPlainMessage(
      env,
      chatId,
      `❌ Lỗi khi gọi Cloudflare API: ${escapeHtml(String(err))}`
    );
    return;
  }

  const rows = results.map(buildDefaultRow);
  const title = isFullDomain ? `Kết quả cho ${input}` : `Kết quả cho từ khoá "${input}"`;
  await sendDomainTable(env, chatId, title, rows);
}

async function handleProviderCheck(
  env: Env,
  chatId: number,
  providerCmd: string,
  query: string
) {
  const provider = PROVIDER_MAP[providerCmd];
  if (!provider) {
    await sendPlainMessage(env, chatId, `⚠️ Không nhận diện được lệnh /${providerCmd}.`);
    return;
  }

  const input = query.trim().toLowerCase();
  if (!input) {
    await sendPlainMessage(
      env,
      chatId,
      `⚠️ Vui lòng nhập domain hoặc từ khoá. Vd: <code>/${providerCmd} example</code>`
    );
    return;
  }

  const isFullDomain = looksLikeFullDomain(input);
  const domains = isFullDomain ? [input] : buildDomainListFromKeyword(input);

  let results: CfDomainCheckResultItem[];
  try {
    results = await checkDomainsViaCloudflare(env, domains);
  } catch (err) {
    await sendPlainMessage(
      env,
      chatId,
      `❌ Lỗi khi gọi Cloudflare API: ${escapeHtml(String(err))}`
    );
    return;
  }

  const rows: DomainRow[] = [];
  const unsupportedNotes: string[] = [];

  for (const item of results) {
    const row = await buildProviderRow(env, item, provider);
    rows.push(row);
    if (row.status === "❌ Unsupported domain") {
      unsupportedNotes.push(`❌ Unsupported domain: ${row.domain}`);
    }
  }

  const title = isFullDomain
    ? `Kết quả (${provider.displayName}) cho ${input}`
    : `Kết quả (${provider.displayName}) cho từ khoá "${input}"`;

  await sendDomainTable(env, chatId, title, rows, unsupportedNotes);
}

// =====================================================================================
// PARSE TEXT -> COMMAND + ARGS
// =====================================================================================

function parseCommand(text: string): { command: string | null; args: string } {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return { command: null, args: trimmed };
  }
  const spaceIdx = trimmed.indexOf(" ");
  const rawCommand =
    spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
  // bỏ phần @botusername nếu có, vd /spaceship@MyBot
  const command = rawCommand.split("@")[0].toLowerCase();
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);
  return { command, args };
}

async function routeMessage(env: Env, message: TelegramMessage) {
  const chatId = message.chat.id;
  const text = message.text ?? "";
  if (!text.trim()) return;

  const { command, args } = parseCommand(text);

  if (command === null) {
    // Không phải lệnh -> coi như domain/keyword trực tiếp
    await handleDefaultCheck(env, chatId, text);
    return;
  }

  switch (command) {
    case "start":
      await sendPlainMessage(env, chatId, START_TEXT);
      return;
    case "help":
      await sendPlainMessage(env, chatId, HELP_TEXT);
      return;
    default:
      if (PROVIDER_MAP[command]) {
        await handleProviderCheck(env, chatId, command, args);
      } else {
        await sendPlainMessage(
          env,
          chatId,
          `⚠️ Lệnh không hợp lệ. Gõ /help để xem danh sách lệnh.`
        );
      }
      return;
  }
}

// =====================================================================================
// SETUP: setMyCommands (đăng ký danh sách lệnh với BotFather)
// Gọi thủ công qua GET /setup-commands (endpoint tiện ích, không phải webhook)
// =====================================================================================

async function setupBotCommands(env: Env): Promise<Response> {
  const commands = [
    { command: "start", description: "Giới thiệu cách sử dụng bot" },
    { command: "help", description: "Xem hướng dẫn đầy đủ" },
    ...Object.entries(PROVIDER_MAP).map(([cmd, info]) => ({
      command: cmd,
      description: `Check giá domain theo ${info.displayName}`,
    })),
  ];

  const result = await callTelegram(env, "setMyCommands", { commands });
  return new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json" },
  });
}

// =====================================================================================
// ENTRYPOINT
// =====================================================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Endpoint tiện ích để đăng ký lệnh với BotFather (gọi 1 lần sau khi deploy)
    if (url.pathname === "/setup-commands" && request.method === "GET") {
      return setupBotCommands(env);
    }

    // Webhook chính nhận update từ Telegram
    if (url.pathname === "/webhook" && request.method === "POST") {
      // Xác thực request đến từ Telegram bằng secret token
      const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (secretHeader !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      let update: TelegramUpdate;
      try {
        update = await request.json();
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      if (update.message) {
        // Không await để trả response nhanh cho Telegram; nhưng trên Workers cần
        // dùng waitUntil để đảm bảo xử lý hoàn tất trước khi isolate bị huỷ.
        // (ctx được truyền ở handler dưới nếu cần; ở đây xử lý trực tiếp và await
        // để đảm bảo đơn giản, đổi lại phản hồi webhook chậm hơn một chút.)
        try {
          await routeMessage(env, update.message);
        } catch (err) {
          console.error("Lỗi xử lý message:", err);
        }
      }

      return new Response("OK", { status: 200 });
    }

    return new Response("DomainPricingBot is running.", { status: 200 });
  },
};
