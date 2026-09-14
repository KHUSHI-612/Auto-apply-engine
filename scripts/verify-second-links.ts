import * as fs from "node:fs";
import * as path from "node:path";
import { chromium } from "playwright";
import { apply, applyResume } from "../src/engine.js";
import { getRun } from "../src/store.js";
import { engineEvents } from "../src/events.js";
import type { Profile, Question, ApplyResult } from "../src/types.js";

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
    "What is your age range?": "21-29",
    "What gender do you identify as?": "Male",
    "I identify my ethnicity as...": "Asian",
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

// Helper to check URL status
async function checkUrlStatus(url: string): Promise<{ ok: boolean; status: number; finalUrl: string; title: string }> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    const status = resp?.status() || 0;
    const finalUrl = page.url();
    const title = await page.title();
    return { ok: status >= 200 && status < 400, status, finalUrl, title };
  } finally {
    await browser.close();
  }
}

// Helper to inspect recording directory
function inspectRecordings(runId: string): { webmFile?: string; webmSizeKB?: string; pngCount: number; files: string[] } {
  const recDir = path.resolve(`./recordings/${runId}`);
  if (!fs.existsSync(recDir)) {
    return { pngCount: 0, files: [] };
  }
  const files = fs.readdirSync(recDir);
  let webmFile: string | undefined;
  let webmSizeKB: string | undefined;
  let pngCount = 0;

  for (const f of files) {
    const full = path.join(recDir, f);
    const stats = fs.statSync(full);
    if (f.endsWith(".webm")) {
      webmFile = f;
      webmSizeKB = (stats.size / 1024).toFixed(2);
    } else if (f.endsWith(".png")) {
      pngCount++;
    }
  }
  return { webmFile, webmSizeKB, pngCount, files };
}

async function runSingleTest(atsName: string, targetUrl: string) {
  console.log(`\n=================================================================`);
  console.log(`🔍 [${atsName.toUpperCase()}] TESTING LINK: ${targetUrl}`);
  console.log(`=================================================================`);

  // Step 1: Check URL status
  console.log(`Checking URL availability...`);
  const check = await checkUrlStatus(targetUrl);
  console.log(`- Status: ${check.status} (${check.ok ? "OPEN / OK" : "FAILED / CLOSED"})`);
  console.log(`- Page Title: "${check.title}"`);
  console.log(`- Final URL: ${check.finalUrl}`);

  if (!check.ok) {
    throw new Error(`Target URL '${targetUrl}' is not open (status ${check.status}).`);
  }

  // Subscribe to engine events for this test
  const eventListener = (e: any) => {
    if (e.type === "step") {
      console.log(`  [${atsName}] Step: ${e.data.step} - ${e.data.message || ""}`);
    } else if (e.type === "trace") {
      console.log(`  [${atsName}] Field Filled: ${e.data.field} = "${e.data.value}"`);
    } else if (e.type === "needs_input") {
      console.log(`  [${atsName}] NEEDS_INPUT triggered (${e.data.questions?.length} questions)`);
    } else if (e.type === "submitted") {
      console.log(`  [${atsName}] SUBMITTED! Receipt keys: ${Object.keys(e.data.receipt || {}).length}`);
    } else if (e.type === "failed") {
      console.log(`  [${atsName}] FAILED! Step: ${e.data.step}, Error: ${e.data.error}`);
    }
  };
  engineEvents.on("event", eventListener);

  try {
    console.log(`Triggering apply()...`);
    const applyResult = await apply(targetUrl, sampleProfile, resumePdfPath);

    let finalRunId = applyResult.runId;
    let finalOutcome: ApplyResult = applyResult;

    console.log(`\napply() Result Status: ${applyResult.status}`);

    if (applyResult.status === "NEEDS_INPUT") {
      console.log(`Questions sent to NEEDS_INPUT (${applyResult.questions.length}):`);
      applyResult.questions.forEach((q, i) => {
        console.log(`  ${i + 1}. [${q.type}] ${q.id}: "${q.label}" (req: ${q.required})`);
      });

      // Provide answers to resume form
      const answers: Record<string, string> = {};
      for (const q of applyResult.questions) {
        if (q.id.includes("37056594002")) {
          answers[q.id] = "None of the above";
        } else if (q.id.includes("37056595002")) {
          answers[q.id] = "Not applicable (i.e., I selected “none of the above” for the prior question)";
        } else if (q.options && q.options.length > 0) {
          const safeOption = q.options.find(opt => /not applicable/i.test(opt) || /none of the above/i.test(opt));
          answers[q.id] = safeOption || q.options[0];
        } else if (q.type === "number") {
          answers[q.id] = "2";
        } else {
          answers[q.id] = "Yes";
        }
      }

      console.log(`\nResuming with applyResume()...`);
      finalOutcome = await applyResume(applyResult.runId, answers);
      finalRunId = finalOutcome.runId || applyResult.runId;
      console.log(`applyResume() Final Status: ${finalOutcome.status}`);
    }

    const runRecord = getRun(finalRunId!);
    const traceCount = runRecord?.trace.length || 0;
    const recInfo = inspectRecordings(finalRunId!);

    console.log(`\n--- SUMMARY FOR ${atsName.toUpperCase()} ---`);
    console.log(`- Run ID: ${finalRunId}`);
    console.log(`- Total Fields Traced & Filled: ${traceCount}`);
    console.log(`- Final Status: ${finalOutcome.status}`);
    if (finalOutcome.status === "FAILED") {
      console.log(`  - Failed Step: ${finalOutcome.step}`);
      console.log(`  - Error: ${finalOutcome.error}`);
    } else if (finalOutcome.status === "SUBMITTED") {
      console.log(`  - Confirmation Text: "${finalOutcome.confirmationText}"`);
    }
    console.log(`- Recordings Artifacts:`);
    console.log(`  - WebM Video: ${recInfo.webmFile ? `${recInfo.webmFile} (${recInfo.webmSizeKB} KB)` : "NONE"}`);
    console.log(`  - Screenshots: ${recInfo.pngCount} PNG file(s)`);

    return {
      atsName,
      targetUrl,
      finalRunId,
      finalOutcome,
      traceCount,
      recInfo,
    };
  } finally {
    engineEvents.off("event", eventListener);
  }
}

async function main() {
  console.log("=================================================================");
  console.log("🚀 TESTING SECOND LIVE LINKS FOR LEVER & GREENHOUSE");
  console.log("=================================================================");

  // Link 1: Lever
  const leverUrl = "https://jobs.lever.co/leverdemo/ad208490-4052-4f91-a57e-433f2d1e484b";
  const leverResult = await runSingleTest("Lever", leverUrl);

  // Link 2: Greenhouse
  const greenhouseUrl = "https://job-boards.greenhouse.io/databricks/jobs/8604614002";
  const greenhouseResult = await runSingleTest("Greenhouse", greenhouseUrl);

  console.log("\n=================================================================");
  console.log("🏁 ALL TESTS FINISHED — FINAL COMPARISON TABLE");
  console.log("=================================================================");
  console.table([
    {
      ATS: "Lever (Link 2)",
      URL: leverUrl,
      RunId: leverResult.finalRunId,
      FieldsFilled: leverResult.traceCount,
      Status: leverResult.finalOutcome.status,
      ErrorOrConfirm: leverResult.finalOutcome.status === "FAILED" ? leverResult.finalOutcome.error : (leverResult.finalOutcome as any).confirmationText,
      Video: leverResult.recInfo.webmFile ? `${leverResult.recInfo.webmSizeKB} KB` : "No",
      Screenshots: `${leverResult.recInfo.pngCount} PNGs`,
    },
    {
      ATS: "Greenhouse (Link 2)",
      URL: greenhouseUrl,
      RunId: greenhouseResult.finalRunId,
      FieldsFilled: greenhouseResult.traceCount,
      Status: greenhouseResult.finalOutcome.status,
      ErrorOrConfirm: greenhouseResult.finalOutcome.status === "FAILED" ? greenhouseResult.finalOutcome.error : (greenhouseResult.finalOutcome as any).confirmationText,
      Video: greenhouseResult.recInfo.webmFile ? `${greenhouseResult.recInfo.webmSizeKB} KB` : "No",
      Screenshots: `${greenhouseResult.recInfo.pngCount} PNGs`,
    },
  ]);
}

main().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
