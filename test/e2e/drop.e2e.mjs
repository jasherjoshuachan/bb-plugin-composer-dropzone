// End-to-end check against a running bb: node test/e2e/drop.e2e.mjs [bb url]. Needs Google Chrome; uses the new-thread composer and removes its attachments afterwards.
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://127.0.0.1:38886/";
const out = process.env.E2E_OUT ?? "/tmp";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const log = [];
page.on("pageerror", (e) => log.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") log.push(`console.error: ${m.text()}`); });
page.on("response", async (r) => {
  const u = r.url();
  if (/attachments|composer-dropzone/.test(u)) {
    let body = "";
    try { body = (await r.text()).slice(0, 300); } catch {}
    log.push(`RES ${r.status()} ${u.replace("http://127.0.0.1:38886", "")} ${body}`);
  }
});

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(3000);
log.push(`bridge markers: ${await page.locator("[data-composer-dropzone-bridge]").count()}`);

async function drop(where, files) {
  return page.evaluate(async ({ where, files }) => {
    const form = document.querySelector("form[data-promptbox]");
    let target;
    if (where === "composer") target = form.querySelector(".ProseMirror") ?? form;
    else {
      // A point in the composer's panel but outside the composer.
      const panel = form.closest("[data-panel]");
      const r = panel.getBoundingClientRect();
      target = document.elementFromPoint(r.left + 40, r.bottom - 40) ?? panel;
    }
    const dt = new DataTransfer();
    for (const f of files) {
      const bytes = f.size ? new Uint8Array(f.size) : new TextEncoder().encode(f.text);
      dt.items.add(new File([bytes], f.name, { type: f.type }));
    }
    const r = target.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt,
      clientX: r.left + Math.min(20, r.width / 2), clientY: r.top + Math.min(20, r.height / 2) };
    const res = { target: `${target.tagName}.${String(target.className).slice(0, 40)}` };
    for (const type of ["dragenter", "dragover", "drop"]) {
      const ev = new DragEvent(type, opts);
      target.dispatchEvent(ev);
      res[type] = ev.defaultPrevented;
    }
    return res;
  }, { where, files });
}

const chips = () => page.evaluate(() =>
  Array.from(document.querySelector("form[data-promptbox]").querySelectorAll("img, span, div"))
    .map((el) => el.textContent?.trim() ?? "")
    .filter((t) => /dz-/.test(t) && t.length < 60)
    .filter((t, i, a) => a.indexOf(t) === i));

log.push(`A composer small: ${JSON.stringify(await drop("composer", [{ name: "dz-small.txt", type: "text/plain", text: "hello\n" }]))}`);
await page.waitForTimeout(2500);
log.push(`B panel image: ${JSON.stringify(await drop("panel", [{ name: "dz-pic.png", type: "image/png", text: "notreallyapng" }]))}`);
await page.waitForTimeout(2500);
log.push(`C composer large: ${JSON.stringify(await drop("composer", [{ name: "dz-big.mp4", type: "video/mp4", size: 30 * 1024 * 1024 }]))}`);
await page.waitForTimeout(20000);
log.push(`chips: ${JSON.stringify(await chips())}`);
await page.screenshot({ path: `${out}/e2e.png` });
const toasts = await page.locator("[data-sonner-toast]").allTextContents();
log.push(`toasts: ${JSON.stringify(toasts)}`);

// Clean up: remove every attachment from this draft.
for (let i = 0; i < 10; i += 1) {
  const btn = page.locator('form[data-promptbox] button[aria-label*="emove" i]').first();
  if ((await btn.count()) === 0) break;
  await btn.click();
  await page.waitForTimeout(300);
}
log.push(`chips after cleanup: ${JSON.stringify(await chips())}`);
console.log(log.join("\n"));
await browser.close();
