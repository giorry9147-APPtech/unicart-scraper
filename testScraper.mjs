const base = "https://unicart-scraper-1.onrender.com";
const token = "uni_123"; // <-- zet exact jouw Render token hier

const r = await fetch(`${base}/scrape`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,
  },
  body: JSON.stringify({
    url: "https://www.mediamarkt.nl/nl/product/_google-pixel-10a-obsidiaan-128-gb-zwart-1896011.html",
  }),
});

console.log("status:", r.status);
console.log(await r.text());