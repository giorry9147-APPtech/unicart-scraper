import express from "express";
import * as cheerio from "cheerio";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8080;
const TOKEN = process.env.SCRAPER_TOKEN || "";
function authOk(req) {
  const token = (process.env.SCRAPER_TOKEN || "").trim();
  if (!token) return true;

  const h = (req.headers.authorization || "").trim();
  return h === `Bearer ${token}`;
}

function pickFirst(...vals) {
  for (const v of vals) {
    const s = (v ?? "").toString().trim();
    if (s) return s;
  }
  return "";
}

function absUrl(base, maybe) {
  try {
    if (!maybe) return "";
    return new URL(maybe, base).toString();
  } catch {
    return "";
  }
}

function toNumberOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;

  const s = String(v).trim();
  if (!s) return null;

  const cleaned = s.replace(/[^\d.,]/g, "");
  if (!cleaned) return null;

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized = cleaned;

  if (lastComma !== -1 && lastDot !== -1) {
    const decSep = lastComma > lastDot ? "," : ".";
    normalized = cleaned
      .replace(decSep === "," ? /\./g : /,/g, "")
      .replace(decSep, ".");
  } else {
    normalized = cleaned.replace(",", ".");
  }

  const num = Number(normalized);
  return Number.isFinite(num) ? num : null;
}

function extractCurrencyLoose(s) {
  const up = (s || "").toUpperCase();
  if (up.includes("EUR") || s.includes("€")) return "EUR";
  if (up.includes("USD") || s.includes("$")) return "USD";
  if (up.includes("GBP") || s.includes("£")) return "GBP";
  return null;
}

function flattenJsonLd(input) {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== "object") return;
    out.push(node);
    if (node["@graph"]) walk(node["@graph"]);
    if (node.graph) walk(node.graph);
    if (node.mainEntity) walk(node.mainEntity);
    if (node.itemListElement) walk(node.itemListElement);
    if (node.offers) walk(node.offers);
  };
  walk(input);
  return out;
}

function isType(node, t) {
  const want = t.toLowerCase();
  const raw = node?.["@type"];
  if (!raw) return false;
  if (typeof raw === "string") return raw.toLowerCase() === want;
  if (Array.isArray(raw)) return raw.map(String).some((x) => x.toLowerCase() === want);
  return false;
}

function parseFromHtml(url, html) {
  const $ = cheerio.load(html);

  // JSON-LD
  let title = "";
  let imageUrl = "";
  let price = null;
  let currency = null;

  const scripts = $('script[type="application/ld+json"]').map((_, el) => $(el).text()).get();
  for (const raw of scripts) {
    try {
      const json = JSON.parse(raw);
      const nodes = flattenJsonLd(json);
      const products = nodes.filter((n) => isType(n, "Product"));
      const candidates = products.length ? products : nodes;

      for (const n of candidates) {
        if (!title && n?.name) title = String(n.name).trim();

        if (!imageUrl) {
          const img = n?.image;
          if (typeof img === "string") imageUrl = img;
          if (Array.isArray(img) && typeof img[0] === "string") imageUrl = img[0];
        }

        const offers = n?.offers;
        const offer = Array.isArray(offers) ? offers[0] : offers;

        if (price == null && offer) {
          price = toNumberOrNull(offer?.price ?? offer?.lowPrice ?? offer?.highPrice);
          const cur = offer?.priceCurrency ? String(offer.priceCurrency) : null;
          if (!currency && cur) currency = cur;
        }

        if (title && imageUrl && price != null) break;
      }
    } catch {}
  }

  // OG/meta fallback
  const ogTitle = pickFirst(
    $('meta[property="og:title"]').attr("content"),
    $('meta[name="twitter:title"]').attr("content"),
    $("title").text()
  );

  const ogImage = pickFirst(
    $('meta[property="og:image"]').attr("content"),
    $('meta[name="twitter:image"]').attr("content")
  );

  const metaPrice = pickFirst(
    $('meta[property="product:price:amount"]').attr("content"),
    $('meta[name="product:price:amount"]').attr("content"),
    $('[itemprop="price"]').attr("content"),
    $('[itemprop="price"]').first().text()
  );

  const metaCurrency = pickFirst(
    $('meta[property="product:price:currency"]').attr("content"),
    $('meta[name="product:price:currency"]').attr("content"),
    $('[itemprop="priceCurrency"]').attr("content"),
    $('[itemprop="priceCurrency"]').first().text()
  );

  const finalTitle = pickFirst(title, ogTitle);
  const finalImage = absUrl(url, pickFirst(imageUrl, ogImage));
  const finalPrice = price != null ? price : toNumberOrNull(metaPrice);
  const finalCurrency = currency || (metaCurrency ? metaCurrency.trim() : null) || extractCurrencyLoose(metaPrice || "");

  return {
    title: finalTitle,
    imageUrl: finalImage,
    price: finalPrice,
    currency: finalCurrency
  };
}

// ── Cookie-consent selectors (covers ~95 % of Dutch / EU shops) ──
const COOKIE_ACCEPT_SELECTORS = [
  // Generic CMP frameworks
  "#onetrust-accept-btn-handler",
  ".onetrust-accept-btn-handler",
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  "#CybotCookiebotDialogBodyButtonAccept",
  ".cc-accept-all",
  ".cc-allow",
  '[data-testid="cookie-accept"]',
  '[data-action="accept-cookies"]',
  '[data-cookiefirst-action="accept"]',
  // Common Dutch labels
  'button:has-text("Alles accepteren")',
  'button:has-text("Accepteren")',
  'button:has-text("Alle cookies accepteren")',
  'button:has-text("Akkoord")',
  'button:has-text("Ja, ik ga akkoord")',
  'button:has-text("Accept all")',
  'button:has-text("Accept cookies")',
  'button:has-text("Accept All Cookies")',
  'button:has-text("Allow all")',
  'button:has-text("Got it")',
  'button:has-text("OK")',
  // Bol.com specific
  'button[data-test="consent-modal-confirm-btn"]',
  '#js-first-screen-accept',
  // MediaMarkt / Saturn
  'button.gdpr-cookie-accept',
  '[data-purpose="cookie-consent-accept"]',
  // Zalando
  '#uc-btn-accept-banner',
  // Generic fallbacks
  'button[id*="accept" i]',
  'button[class*="accept" i]',
  'a[id*="accept" i]',
  '[role="dialog"] button:has-text("OK")',
];

async function dismissCookieWall(page) {
  for (const sel of COOKIE_ACCEPT_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 400 })) {
        await btn.click({ timeout: 2000 });
        await page.waitForTimeout(400);
        return true;
      }
    } catch {
      // selector not found, try next
    }
  }
  return false;
}

app.post("/scrape", async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const url = req.body?.url;
  if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ ok: false, error: "invalid url" });
  }

  const started = Date.now();

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    const context = await browser.newContext({
      locale: "nl-NL",
      timezoneId: "Europe/Amsterdam",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
      extraHTTPHeaders: {
        "Accept-Language": "nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    });

    // Hide webdriver flag
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    const page = await context.newPage();

    // Navigate
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Try to dismiss cookie wall early
    await dismissCookieWall(page);

    // Wait for JS content to render
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);

    // Try cookie dismiss again (some walls appear after networkidle)
    await dismissCookieWall(page);
    await page.waitForTimeout(500);

    const html = await page.content();
    const parsed = parseFromHtml(url, html);

    const debug = req.query.debug === "1";

    return res.json({
      ok: true,
      url,
      ...parsed,
      ...(debug ? { html } : {}),
      ms: Date.now() - started,
    });
  } catch (e) {
    return res.status(502).json({
      ok: false,
      url,
      error: e?.message ?? String(e),
      ms: Date.now() - started,
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`unicart-scraper listening on :${PORT}`);
});