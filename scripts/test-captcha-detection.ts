import { chromium } from "playwright";
import { leverAdapter } from "../src/adapters/lever.js";

async function testCaptcha() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await leverAdapter.openForm(page, "https://jobs.lever.co/leverdemo/82fbbecc-5535-466b-a84b-7957cf49e443/apply");

  console.log("Checking hCaptcha locators before submit:");
  const locator = page.locator("iframe[src*='hcaptcha'], .h-captcha, #h-captcha, iframe[title*='hCaptcha']");
  const count = await locator.count();
  console.log("Count:", count);
  for (let i = 0; i < count; i++) {
    const el = locator.nth(i);
    const vis = await el.isVisible();
    const src = await el.getAttribute("src").catch(() => "");
    const title = await el.getAttribute("title").catch(() => "");
    console.log(`  [${i}] vis=${vis} src=${src?.slice(0, 50)} title=${title}`);
  }

  await browser.close();
}

testCaptcha().catch(console.error);
