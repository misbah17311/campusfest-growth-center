// Renders slides/slides.html to a 3-page PDF (1600x900 px pages) and PNG previews.
//   node slides/render.mjs
import { chromium } from "playwright";
import path from "node:path";
import { pathToFileURL } from "node:url";

const html = path.resolve("slides/slides.html");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(pathToFileURL(html).href);
await page.pdf({ path: "slides/CampusFest_Growth_Strategy_Misbah_Ur_Rahman.pdf", width: "1600px", height: "900px", printBackground: true });
const slides = await page.locator(".slide").all();
for (let i = 0; i < slides.length; i++) await slides[i].screenshot({ path: `slides/preview_${i + 1}.png` });
// Overflow check: content must fit inside each slide.
const over = await page.evaluate(() => [...document.querySelectorAll(".slide")].map((s, i) => {
  const bad = [...s.querySelectorAll(".card")].filter((c) => c.scrollHeight > c.clientHeight + 1).length;
  return `slide ${i + 1}: ${s.scrollHeight > s.clientHeight + 1 ? "OVERFLOWS" : "fits"}, cards overflowing: ${bad}`;
}));
console.log(over.join("\n"));
await browser.close();
