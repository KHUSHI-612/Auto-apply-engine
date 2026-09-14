import * as fs from "node:fs";
import * as path from "node:path";
import { chromium } from "playwright";
import { apply, applyResume } from "../src/engine.js";
import { getRun } from "../src/store.js";
import { engineEvents } from "../src/events.js";
import type { Profile, ApplyResult } from "../src/types.js";

const sampleProfile: Profile = {
  personalInfo: {
    fullName: "Alex Rivera",
    firstName: "Alex",
    lastName: "Rivera",
    email: "alex.rivera.test@gmail.com",
    phone: "+15552345678",
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
  ],
  answersBank: {
    "Country": "United States",
    "Preferred First Name": "Alex",
    "Do you have end to end sales experience? (from prospecting to closing deals)": "Yes",
    "Do you have experience selling Cloud Tech and/or Data& AI products?": "Yes",
    "This is an Individual Contributor role, are you comfortable with that?": "Yes",
    "Are you legally authorized to work in the country in which you are applying?": "Yes",
    "Do you now or will you in the future need sponsorship for employment visa status in the country in which you are applying?": "No",
    "Do you currently or have you previously worked for Databricks in the past?": "No"
  }
};

const resumePdfPath = path.resolve("./sample_resume.pdf");

async function checkUrl(url: string) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    return { ok: (resp?.status() || 0) < 400, status: resp?.status() || 0, url: page.url(), title: await page.title() };
  } finally {
    await browser.close();
  }
}

async function main() {
  const targetUrl = "https://job-boards.greenhouse.io/databricks/jobs/8604614002";

  console.log("=================================================================");
  console.log("🔍 INVESTIGATING & RE-RUNNING GREENHOUSE CHECKBOX FIX");
  console.log(`🎯 URL: ${targetUrl}`);
  console.log("=================================================================\n");

  const check = await checkUrl(targetUrl);
  console.log(`URL Status: ${check.status} (${check.ok ? "OPEN" : "CLOSED"})`);
  console.log(`Page Title: "${check.title}"`);
  console.log(`Final URL: ${check.url}\n`);

  if (!check.ok) {
    throw new Error(`Target URL ${targetUrl} returned status ${check.status}`);
  }

  engineEvents.on("event", (e: any) => {
    if (e.type === "step") {
      console.log(`  [Step] ${e.data.step}: ${e.data.message || ""}`);
    } else if (e.type === "trace") {
      console.log(`  [Trace] ${e.data.field} -> "${e.data.value}"`);
    } else if (e.type === "needs_input") {
      console.log(`  [Event] NEEDS_INPUT triggered (${e.data.questions?.length} questions)`);
    } else if (e.type === "submitted") {
      console.log(`  [Event] SUBMITTED! Confirmation: "${e.data.confirmationText}"`);
    } else if (e.type === "failed") {
      console.log(`  [Event] FAILED! Step: ${e.data.step}, Error: ${e.data.error}`);
    }
  });

  console.log("Starting apply()...");
  const applyResult = await apply(targetUrl, sampleProfile, resumePdfPath);

  let finalOutcome: ApplyResult = applyResult;
  let finalRunId = applyResult.runId;

  console.log(`\nApply status: ${applyResult.status}`);

  if (applyResult.status === "NEEDS_INPUT") {
    console.log(`\nNEEDS_INPUT returned ${applyResult.questions.length} questions:`);
    applyResult.questions.forEach((q, idx) => {
      console.log(`  ${idx + 1}. [${q.type}] ${q.id}: "${q.label}"`);
      if (q.options && q.options.length > 0) {
        console.log(`     Options (${q.options.length}): ${JSON.stringify(q.options)}`);
      }
    });

    const answers: Record<string, string> = {};
    for (const q of applyResult.questions) {
      if (q.id.includes("37056594002")) {
        answers[q.id] = "None of the above";
      } else if (q.id.includes("37056595002")) {
        answers[q.id] = "Not applicable (i.e., I selected “none of the above” for the prior question)";
      } else if (q.options && q.options.length > 0) {
        answers[q.id] = q.options[0];
      } else if (q.type === "number") {
        answers[q.id] = "2";
      } else {
        answers[q.id] = "Yes";
      }
    }

    console.log("\nAnswers to submit via applyResume():", JSON.stringify(answers, null, 2));
    console.log("\nResuming applyResume()...");
    finalOutcome = await applyResume(applyResult.runId, answers);
    finalRunId = finalOutcome.runId || applyResult.runId;
  }

  console.log("\n=================================================================");
  console.log(`🏁 FINAL OUTCOME: ${finalOutcome.status}`);
  console.log("=================================================================");
  if (finalOutcome.status === "FAILED") {
    console.log(`- Step: ${finalOutcome.step}`);
    console.log(`- Error: ${finalOutcome.error}`);
  } else if (finalOutcome.status === "SUBMITTED") {
    console.log(`- Confirmation Text: "${finalOutcome.confirmationText}"`);
    console.log(`- Receipt:`, finalOutcome.receipt);
  }

  const runRecord = getRun(finalRunId!);
  console.log(`\n- Run ID: ${finalRunId}`);
  console.log(`- Total Fields Traced & Filled: ${runRecord?.trace.length || 0}`);

  console.log("\nDetailed Trace of Filled Fields:");
  runRecord?.trace.forEach((t, i) => {
    console.log(`  ${i + 1}. ${t.field} = "${t.value}" (${t.screenshotPath ? "screenshot captured" : "no screenshot"})`);
  });

  const recDir = path.resolve(`./recordings/${finalRunId}`);
  if (fs.existsSync(recDir)) {
    const files = fs.readdirSync(recDir);
    const webm = files.find(f => f.endsWith(".webm"));
    const pngs = files.filter(f => f.endsWith(".png"));
    console.log(`\nArtifacts in ${recDir}:`);
    if (webm) {
      const stats = fs.statSync(path.join(recDir, webm));
      console.log(`  - Video: ${webm} (${(stats.size / 1024).toFixed(2)} KB)`);
    }
    console.log(`  - Screenshots: ${pngs.length} PNGs`);
  }
}

main().catch((err) => {
  console.error("Execution failed:", err);
  process.exit(1);
});
