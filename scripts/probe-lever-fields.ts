import { chromium } from "playwright";
import { leverAdapter } from "../src/adapters/lever.js";
import { mapFields } from "../src/mapper.js";
import type { Profile } from "../src/types.js";

async function probe() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const url = "https://jobs.lever.co/leverdemo/82fbbecc-5535-466b-a84b-7957cf49e443/apply";
  console.log("Navigating to:", url);
  await leverAdapter.openForm(page, url);

  const fields = await leverAdapter.readFields(page);
  console.log(`Extracted ${fields.length} fields:`);
  const reqFields = fields.filter(f => f.required);
  console.log(`REQUIRED FIELDS (${reqFields.length}):`);
  for (const f of reqFields) {
    console.log(`- [${f.type}] id="${f.id}" label="${f.label}"`);
  }
  const optFields = fields.filter(f => !f.required);
  console.log(`OPTIONAL FIELDS (${optFields.length})`);

  const sampleProfile: Profile = {
    personalInfo: {
      fullName: "Alex Rivera",
      email: "alex.rivera.test@gmail.com",
      phone: "+1 (555) 234-5678",
      location: "San Francisco, CA"
    },
    profiles: [
      { network: "LinkedIn", url: "https://linkedin.com/in/alexrivera-demo" },
      { network: "GitHub", url: "https://github.com/alexrivera-demo" }
    ],
    experience: [
      {
        company: "Acme Cloud Corp",
        jobTitle: "Senior Automation Engineer",
        current: true,
        startDate: "2021-01"
      }
    ],
    education: [
      {
        school: "UC Berkeley",
        degree: "B.S. Computer Science"
      }
    ]
  };

  const { filled, missing } = mapFields(fields, sampleProfile);
  console.log(`\nMapped ${filled.length} filled, ${missing.length} missing:`);
  console.log("Missing fields:");
  for (const m of missing) {
    console.log(`- id="${m.id}" label="${m.label}" type="${m.type}" req=${m.required} opts=${JSON.stringify(m.options || [])}`);
  }

  await browser.close();
}

probe().catch(console.error);
