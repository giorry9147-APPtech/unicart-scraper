import express from "express";
import * as cheerio from "cheerio";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8080;
const TOKEN = process.env.SCRAPER_TOKEN || "";

function authOk(req) {
  if (!TOKEN) return true;
  const h = req.headers.authorization || "";
  return h === `Bearer ${TOKEN}`;
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
        "--disable-dev-shm-usage"
      ]
    });

    const context = await browser.newContext({
      locale: "nl-NL",
      timezoneId: "Europe/Amsterdam",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
      viewport: { width: 1280, height: 800 }
    });

    const page = await context.newPage();

    // Belangrijk: load zo dat JS content er is
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(750);

    const html = await page.content();
    const parsed = parseFromHtml(url, html);

    return res.json({
      ok: true,
      url,
      html, // handig als je later server-side nog wil parseren
      ...parsed,
      ms: Date.now() - started
    });
  } catch (e) {
    return res.status(502).json({
      ok: false,
      url,
      error: e?.message ?? String(e),
      ms: Date.now() - started
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`unicart-scraper listening on :${PORT}`);
});