/**
 * DomainPricingBot — Telegram Bot for checking domain pricing via Cloudflare Registrar API
 * Runs on Cloudflare Workers, no framework (no Hono).
 * All logic lives in a single file as required.
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

// A normalized data row to feed into the table
interface DomainRow {
  domain: string;
  // If status !== null, the Registration/Renewal cells are merged (colspan=2) to show status
  status: string | null; // e.g. "Domain unavailable" | "Domain premium" | "❌ Unsupported domain"
  registration?: string; // vd "$30.00"
  renewal?: string; // vd "$30.00"
  linkLabel: string; // vd "Whois" | "Cloudflare" | "Spaceship" | "Redirect"
  linkUrl: string;
}

// =====================================================================================
// CONFIG: PROVIDER MAP (command -> CSV filename in static/)
// Fixed mapping as required (no directory scanning, fixed number of entries).
// The part before the first "." in the filename is used as the command name.
// =====================================================================================

interface ProviderInfo {
  csvFile: string; // filename in static/
  displayName: string; // display name in the Link column, e.g. "Spaceship"
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
// UTILITIES: keyword -> domain list, money formatting, etc.
// =====================================================================================

const DEFAULT_TLDS = [
  "com", "org", "net", "io", "ai", "co", "app", "dev", "me", "xyz",
  "tech", "cloud", "online", "site", "link", "blog", "info", "gg", "pro", "wiki",
];

/** Returns true if the string looks like a full domain (has a dot and a basic valid TLD) */
function looksLikeFullDomain(input: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(input);
}

/** Splits "example.com" -> { sld: "example", tld: "com" } (tld = part after the last dot) */
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
// CSV LOADER (reads from Workers Static Assets)
// =====================================================================================

// In-memory cache per instance (per isolate); avoids re-reading the asset within the same run
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
    throw new Error(`Failed to read CSV file: ${csvFile} (status ${res.status})`);
  }
  const text = await res.text();

  const map = new Map<string, { registration: string; renewal: string }>();
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  // First line is the header: tld,registration,renewal
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
      `Cloudflare API error: ${JSON.stringify(data.errors ?? data.messages ?? "unknown")}`
    );
  }
  return data.result.domains;
}

// =====================================================================================
// BUILD DomainRow FROM CLOUDFLARE RESULT (default mode - no provider)
// =====================================================================================

function buildDefaultRow(item: CfDomainCheckResultItem): DomainRow {
  const whoisLink = `${SITE_BASE_URL}/whois?whois=${encodeURIComponent(item.name)}`;

  if (!item.registrable) {
    if (item.reason === "domain_premium") {
      // Domain premium: not supported for registration via API but still registrable in practice
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

  // registrable = true, tier standard, has pricing
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
    linkLabel: "Cloudflare",
    linkUrl: `${SITE_BASE_URL}/redirect?provider=cloudflare&domain=${encodeURIComponent(
      item.name
    )}`,
  };
}

// =====================================================================================
// BUILD DomainRow WHEN USING A PROVIDER COMMAND (/spaceship, /name, ...)
//
// Rules:
// - Call the Cloudflare API to get tier/registrable as usual.
// - If tier === "standard": get the price from the provider's CSV by TLD (not the price CF returns).
//   - If domain unavailable (registrable=false, reason=domain_unavailable) -> "Domain unavailable" + Whois link.
//   - If the TLD is not in the provider's CSV -> "❌ Unsupported domain".
// - If tier === "premium": show "Domain premium" + link = provider name (not Cloudflare).
// =====================================================================================

async function buildProviderRow(
  env: Env,
  item: CfDomainCheckResultItem,
  provider: ProviderInfo
): Promise<DomainRow> {
  const whoisLink = `${SITE_BASE_URL}/whois?whois=${encodeURIComponent(item.name)}`;

  // Domain premium: as required -> |Domain premium|<Provider>|
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

  // Registrable, tier standard -> look up price from provider CSV
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
// TELEGRAM RICH MESSAGE: build the RichBlockTable
// Structured per Bot API 10.1 Rich Messages, merging cells using colspan/rowspan
// on RichBlockTableCell (equivalent to standard HTML table attributes).
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
      // Merged Registration+Renewal cell (colspan=2)
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
 * sendRichMessage to Telegram with a table block.
 * Since the detailed fields (colspan/rowspan) have been confirmed equivalent to
 * standard HTML <td colspan rowspan> attributes, we send a separate link text for each row
 * (using RichTextUrl) to ensure compatibility even if the client doesn't fully support tables.
 */
async function sendDomainTable(
  env: Env,
  chatId: number,
  title: string,
  rows: DomainRow[],
  unsupportedNotes: string[] = []
) {
  const table = buildDomainTableRichBlock(rows);

  // Convert cell text into plain RichText, and the Link cell into RichTextUrl (clickable link)
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

  // Fallback: if sendRichMessage fails (client/API not supported), resend using HTML monospace
  if (!res.ok) {
    await sendFallbackHtmlTable(env, chatId, title, rows, unsupportedNotes);
  }
}

/** Fallback using parse_mode HTML + <pre> to guarantee display even if the Rich Message fails */
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

const HELP_TEXT = `<b>DomainPricingBot</b> — quickly check domain pricing via Cloudflare Registrar.

<b>How to use:</b>
• Send a full domain, e.g. <code>example.com</code> → see the price for that domain.
• Send a keyword, e.g. <code>example</code> → see prices for 20 popular TLDs.

<b>Advanced commands (check pricing from a specific provider's price list):</b>
${Object.entries(PROVIDER_MAP)
  .map(([cmd, info]) => `• /${cmd} &lt;domain or keyword&gt; — pricing from ${info.displayName}`)
  .join("\n")}

Example: <code>/spaceship dexium</code> or <code>/name example.com</code>

🌐 ${SITE_BASE_URL}`;

const START_TEXT = `👋 Welcome to <b>DomainPricingBot</b>!

This bot helps you check domain registration &amp; renewal prices quickly via Cloudflare Registrar.

<b>Get started:</b>
• Send a domain, e.g. <code>example.com</code>
• Or send a keyword, e.g. <code>example</code> to check 20 popular TLDs

Type /help to see all commands and advanced features.

🌐 ${SITE_BASE_URL}`;

async function handleDefaultCheck(env: Env, chatId: number, query: string) {
  const input = query.trim().toLowerCase();
  if (!input) {
    await sendPlainMessage(env, chatId, "⚠️ Please enter a domain or keyword to check.");
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
      `❌ Error calling Cloudflare API: ${escapeHtml(String(err))}`
    );
    return;
  }

  const rows = results.map(buildDefaultRow);
  const title = isFullDomain ? `Results for ${input}` : `Results for keyword "${input}"`;
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
    await sendPlainMessage(env, chatId, `⚠️ Unrecognized command /${providerCmd}.`);
    return;
  }

  const input = query.trim().toLowerCase();
  if (!input) {
    await sendPlainMessage(
      env,
      chatId,
      `⚠️ Please enter a domain or keyword. E.g. <code>/${providerCmd} example</code>`
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
      `❌ Error calling Cloudflare API: ${escapeHtml(String(err))}`
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
    ? `Results (${provider.displayName}) for ${input}`
    : `Results (${provider.displayName}) for keyword "${input}"`;

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
  // strip the @botusername suffix if present, e.g. /spaceship@MyBot
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
    // Not a command -> treat as a direct domain/keyword
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
          `⚠️ Invalid command. Type /help to see the list of commands.`
        );
      }
      return;
  }
}

// =====================================================================================
// SETUP: setMyCommands (register the command list with BotFather)
// Called manually via GET /setup-commands (utility endpoint, not the webhook)
// =====================================================================================

async function setupBotCommands(env: Env): Promise<Response> {
  const commands = [
    { command: "start", description: "Introduction and how to use the bot" },
    { command: "help", description: "View full usage guide" },
    ...Object.entries(PROVIDER_MAP).map(([cmd, info]) => ({
      command: cmd,
      description: `Check domain pricing from ${info.displayName}`,
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

    // Utility endpoint to register commands with BotFather (call once after deploy)
    if (url.pathname === "/setup-commands" && request.method === "GET") {
      return setupBotCommands(env);
    }

    // Main webhook receiving updates from Telegram
    if (url.pathname === "/webhook" && request.method === "POST") {
      // Verify the request comes from Telegram using the secret token
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
        // Not awaiting would return a faster response to Telegram; but on Workers we need
        // to use waitUntil to ensure processing completes before the isolate is torn down.
        // (ctx is passed to the handler below if needed; here we process directly and await
        // to keep things simple, at the cost of a slightly slower webhook response.)
        try {
          await routeMessage(env, update.message);
        } catch (err) {
          console.error("Error handling message:", err);
        }
      }

      return new Response("OK", { status: 200 });
    }

    return new Response("DomainPricingBot is running.", { status: 200 });
  },
};
