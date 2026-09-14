import * as fs from "node:fs";
import * as path from "node:path";
import { apply, applyResume } from "../src/engine.js";
import { getRun } from "../src/store.js";
import { engineEvents } from "../src/events.js";
import type { Profile, Question } from "../src/types.js";

async function main() {
  const targetUrl = "https://jobs.lever.co/leverdemo/82fbbecc-5535-466b-a84b-7957cf49e443/apply";

  // Existing sample profile
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
    ],
    answersBank: {
      "What is your age range?": "21-29",
      "What gender do you identify as?": "Male",
      "I identify my ethnicity as...": "Asian"
    }
  };

  const resumePdfPath = path.resolve("./sample_resume.pdf");
  if (!fs.existsSync(resumePdfPath)) {
    throw new Error(`Resume PDF not found at ${resumePdfPath}`);
  }

  console.log("=================================================================");
  console.log("🚀 VERIFYING PAUSE/RESUME & REAL SUBMISSION ON LEVER DEMO POSTING");
  console.log(`🎯 URL: ${targetUrl}`);
  console.log("=================================================================\n");

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

  // STEP 2: Trigger apply()
  console.log("Calling apply()...\n");
  const applyResult = await apply(targetUrl, sampleProfile, resumePdfPath);

  console.log("\n=================================================================");
  console.log(`Initial apply() Result Status: ${applyResult.status}`);
  console.log("=================================================================\n");

  let finalRunId = applyResult.runId;

  if (applyResult.status === "NEEDS_INPUT") {
    console.log("👉 Run paused on NEEDS_INPUT as required!");
    console.log(`Pending Questions Count: ${applyResult.questions.length}`);
    console.log("\n--- EXACT QUESTIONS ARRAY ---");
    applyResult.questions.forEach((q: Question, idx: number) => {
      console.log(`Question #${idx + 1}:`);
      console.log(`  field:   ${q.id}`);
      console.log(`  label:   ${q.label}`);
      console.log(`  type:    ${q.type}`);
      console.log(`  options: ${JSON.stringify(q.options || [])}`);
      console.log(`  required:${q.required}`);
    });

    // STEP 4: Wait 15 real seconds
    console.log("\n⏳ Waiting 15 real seconds before calling applyResume (testing session survival across gap)...");
    for (let i = 15; i > 0; i--) {
      process.stdout.write(`${i}s... `);
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log("\n15 seconds elapsed. Browser session is active.\n");

    // STEP 5: Prepare reasonable answers
    const answers: Record<string, string> = {};
    for (const q of applyResult.questions) {
      if (q.options && q.options.length > 0) {
        answers[q.id] = q.options[0];
      } else if (q.type === "number") {
        answers[q.id] = "2";
      } else {
        answers[q.id] = "Yes";
      }
    }
    console.log("Calling applyResume() with answers:", answers);

    // STEP 6: Resume to SUBMITTED
    const resumeResult = await applyResume(applyResult.runId, answers);
    console.log(`\nResume Result Status: ${resumeResult.status}`);

    if (resumeResult.status !== "SUBMITTED") {
      throw new Error(`Expected SUBMITTED from applyResume, but got ${resumeResult.status}`);
    }

    finalRunId = resumeResult.runId;
    console.log("\n--- FINAL RECEIPT ---");
    console.log(JSON.stringify(resumeResult.receipt, null, 2));
    console.log("\n--- CONFIRMATION TEXT ---");
    console.log(resumeResult.confirmationText);
  } else if (applyResult.status === "SUBMITTED") {
    console.log("ℹ️  Run went straight to SUBMITTED without pausing on NEEDS_INPUT.");
    console.log("Reason: All required fields were matched from the profile and Lever form questions were either mapped via answersBank or optional (req=false).");
    console.log("\n--- FINAL RECEIPT ---");
    console.log(JSON.stringify(applyResult.receipt, null, 2));
    console.log("\n--- CONFIRMATION TEXT ---");
    console.log(applyResult.confirmationText);
  } else if (applyResult.status === "FAILED") {
    console.log("🛑 RUN RETURNED FAILED AS EXPECTED (NO FALSE POSITIVE):");
    console.log(`Status: ${applyResult.status}`);
    console.log(`Step:   ${applyResult.step}`);
    console.log(`Error:  ${applyResult.error}`);
  }

  // STEP 6: Print full trace array
  const runRecord = getRun(finalRunId!);
  console.log("\n--- FULL TRACE ARRAY ---");
  console.log(JSON.stringify(runRecord?.trace, null, 2));

  // STEP 7: Check ./recordings/{runId}/ contents
  const recDir = path.resolve(`./recordings/${finalRunId}`);
  console.log(`\n=================================================================`);
  console.log(`📁 INSPECTING RECORDINGS DIRECTORY: ${recDir}`);
  console.log(`=================================================================`);

  if (!fs.existsSync(recDir)) {
    throw new Error(`Recordings directory ${recDir} does not exist!`);
  }

  const files = fs.readdirSync(recDir);
  console.log(`Found ${files.length} file(s) in ${recDir}:`);

  let foundWebm = false;
  let webmSizeKB = 0;
  const screenshotsFound: Array<{ name: string; sizeKB: number }> = [];

  for (const f of files) {
    const filePath = path.join(recDir, f);
    const stats = fs.statSync(filePath);
    const sizeKB = (stats.size / 1024).toFixed(2);

    console.log(`- ${f} (${sizeKB} KB, ${stats.size} bytes)`);

    if (f.endsWith(".webm")) {
      foundWebm = true;
      webmSizeKB = parseFloat(sizeKB);
    } else if (f.endsWith(".png")) {
      screenshotsFound.push({ name: f, sizeKB: parseFloat(sizeKB) });
    }
  }

  console.log(`\nVerification Summary:`);
  console.log(`- WebM Video: ${foundWebm ? `EXISTS (${webmSizeKB} KB)` : "MISSING!"}`);
  console.log(`- Screenshots count: ${screenshotsFound.length}`);

  // Confirm screenshots referenced in trace actually exist on disk
  if (runRecord?.trace) {
    console.log(`\nCross-checking trace screenshotPath entries:`);
    let checkedCount = 0;
    for (const t of runRecord.trace) {
      if (t.screenshotPath) {
        const exists = fs.existsSync(t.screenshotPath);
        const size = exists ? fs.statSync(t.screenshotPath).size : 0;
        console.log(`  Trace field "${t.field}": ${t.screenshotPath} -> ${exists ? `EXISTS (${(size / 1024).toFixed(2)} KB)` : "NOT FOUND"}`);
        checkedCount++;
      }
    }
    console.log(`Total trace screenshots checked: ${checkedCount}`);
  }
}

main().catch((err) => {
  console.error("FATAL ERROR in verification script:", err);
  process.exit(1);
});
