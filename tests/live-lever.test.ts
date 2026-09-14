import { chromium } from "playwright";
import { leverAdapter } from "../src/adapters/lever.js";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const url = "https://jobs.lever.co/leverdemo/82fbbecc-5535-466b-a84b-7957cf49e443";
  console.log("Navigating to:", url);
  await leverAdapter.openForm(page, url);
  console.log("Form opened successfully! Current URL:", page.url());

  const fields = await leverAdapter.readFields(page);
  console.log(`Discovered ${fields.length} fields:`);
  for (const f of fields) {
    console.log(`  - [${f.type}] id="${f.id}" label="${f.label}" req=${f.required} opts=${JSON.stringify(f.options || [])}`);
  }
  await browser.close();
}

main().catch(console.error);
