import * as fs from "node:fs";
import * as path from "node:path";
import { apply, applyResume } from "../src/engine.js";
import { getRun } from "../src/store.js";
import { engineEvents } from "../src/events.js";
import { detectAdapter } from "../src/adapters/registry.js";
import type { Profile, Question } from "../src/types.js";

async function main() {
  console.log("=================================================================");
  console.log("🚀 GREENHOUSE ADAPTER REAL END-TO-END VERIFICATION");
  console.log("=================================================================\n");

  // Sanity check 1: registry verification
  console.log("--- Registry Sanity Check ---");
  const leverCheck = detectAdapter("https://jobs.lever.co/leverdemo/82fbbecc-5535-466b-a84b-7957cf49e443/apply");
  console.log(`Lever URL resolves to: '${leverCheck.name}' (Expected: 'lever')`);
  if (leverCheck.name !== "lever") {
    throw new Error(`Registry regression: Lever URL resolved to ${leverCheck.name}`);
  }

  const targetUrl = "https://job-boards.greenhouse.io/databricks/jobs/6918763002";
  const greenhouseCheck = detectAdapter(targetUrl);
  console.log(`Greenhouse URL resolves to: '${greenhouseCheck.name}' (Expected: 'greenhouse')`);
  if (greenhouseCheck.name !== "greenhouse") {
    throw new Error(`Registry error: Greenhouse URL resolved to ${greenhouseCheck.name}`);
  }
  console.log("✓ Registry routing verified cleanly: no shadowing between adapters!\n");

  // Sample profile
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
  if (!fs.existsSync(resumePdfPath)) {
    throw new Error(`Resume PDF not found at ${resumePdfPath}`);
  }

  // Subscribe to engine events for real-time visibility
  engineEvents.on("event", (e) => {
    if (e.type === "step") {
      console.log(`[ENGINE STEP] ${e.data.step}: ${e.data.message || ""}`);
    } else if (e.type === "trace") {
      console.log(`[FIELD FILLED] ${e.data.field} -> "${e.data.value}"`);
    } else if (e.type === "needs_input") {
      console.log(`[ENGINE NEEDS_INPUT] Paused with ${e.data.questions?.length} questions`);
    } else if (e.type === "resumed") {
      console.log(`[ENGINE RESUMED] Continuing session with answers:`, e.data.answers);
    } else if (e.type === "submitted") {
      console.log(`[ENGINE SUBMITTED] Receipt fields: ${Object.keys(e.data.receipt || {}).length}`);
    } else if (e.type === "failed") {
      console.error(`[ENGINE FAILED] Step: ${e.data.step} Error: ${e.data.error}`);
    }
  });

  console.log(`🎯 Target URL: ${targetUrl}`);
  console.log("Calling apply()...\n");

  const applyResult = await apply(targetUrl, sampleProfile, resumePdfPath);

  console.log("\n=================================================================");
  console.log(`apply() Initial Result Status: ${applyResult.status}`);
  console.log("=================================================================\n");

  let finalRunId = applyResult.runId;

  if (applyResult.status === "NEEDS_INPUT") {
    console.log(`👉 Paused on NEEDS_INPUT with ${applyResult.questions.length} pending questions:`);
    applyResult.questions.forEach((q: Question, idx: number) => {
      console.log(`  ${idx + 1}. [${q.type}] ${q.id} ("${q.label}") | Req: ${q.required}`);
    });

    console.log("\nSimulating user response via applyResume()...");
    const answers: Record<string, string> = {};
    for (const q of applyResult.questions) {
      if (q.options && q.options.length > 0) {
        answers[q.id] = q.options[0];
      } else {
        answers[q.id] = "Yes";
      }
    }

    console.log("Calling applyResume() with answers:", answers);
    const resumeResult = await applyResume(applyResult.runId, answers);
    console.log(`applyResume Result Status: ${resumeResult.status}`);

    finalRunId = resumeResult.runId || applyResult.runId;

    if (resumeResult.status === "SUBMITTED") {
      console.log("--- CONFIRMATION TEXT ---");
      console.log(resumeResult.confirmationText);
      console.log("\n--- FINAL RECEIPT ---");
      console.log(JSON.stringify(resumeResult.receipt, null, 2));
    } else if (resumeResult.status === "FAILED") {
      console.log("🛑 Final Outcome: FAILED (honest report, no false positive)");
      console.log(`Step:  ${resumeResult.step}`);
      console.log(`Error: ${resumeResult.error}`);
    }
  } else if (applyResult.status === "SUBMITTED") {
    console.log("🎉 Outcome: SUBMITTED directly");
    console.log("Confirmation Text:", applyResult.confirmationText);
    console.log("Receipt fields:", Object.keys(applyResult.receipt).length);
  } else if (applyResult.status === "FAILED") {
    console.log("🛑 Outcome: FAILED");
    console.log(`Step:  ${applyResult.step}`);
    console.log(`Error: ${applyResult.error}`);
  }

  // Inspect run record & trace
  if (finalRunId) {
    const runRecord = getRun(finalRunId);
    console.log(`\nRun ID: ${finalRunId}`);
    console.log(`Total Traced Fields: ${runRecord?.trace.length || 0}`);

    const recDir = path.resolve(`./recordings/${finalRunId}`);
    console.log(`\n=================================================================`);
    console.log(`📁 INSPECTING RECORDINGS DIRECTORY: ${recDir}`);
    console.log(`=================================================================`);

    if (fs.existsSync(recDir)) {
      const files = fs.readdirSync(recDir);
      console.log(`Found ${files.length} file(s) in recordings:`);
      let foundWebm = false;
      let webmSize = "0";
      let pngCount = 0;

      for (const f of files) {
        const fullPath = path.join(recDir, f);
        const stats = fs.statSync(fullPath);
        const sizeKB = (stats.size / 1024).toFixed(2);
        console.log(`  - ${f} (${sizeKB} KB)`);
        if (f.endsWith(".webm")) {
          foundWebm = true;
          webmSize = sizeKB;
        } else if (f.endsWith(".png")) {
          pngCount++;
        }
      }

      console.log(`\nRecording Verification:`);
      console.log(`- WebM Video: ${foundWebm ? `EXISTS (${webmSize} KB)` : "NONE"}`);
      console.log(`- Screenshots: ${pngCount} screenshot(s) saved`);
    } else {
      console.warn(`Recordings directory not found: ${recDir}`);
    }
  }

  console.log("\n=================================================================");
  console.log("✅ REAL GREENHOUSE TEST EXECUTION COMPLETE");
  console.log("=================================================================");
}

main().catch((err) => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
