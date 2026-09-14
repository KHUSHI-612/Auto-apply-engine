import * as fs from "node:fs";
import * as path from "node:path";
import { apply } from "../src/engine.js";
import { getRun } from "../src/store.js";
import { engineEvents } from "../src/events.js";
import type { Profile } from "../src/types.js";

async function main() {
  const targetUrl = "https://jobs.lever.co/leverdemo/82fbbecc-5535-466b-a84b-7957cf49e443/apply";

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
  console.log("🚀 STARTING REAL END-TO-END LIVE LEVER DEMO SUBMISSION");
  console.log(`🎯 URL: ${targetUrl}`);
  console.log("=================================================================\n");

  engineEvents.on("event", (e) => {
    if (e.type === "step") {
      console.log(`[ENGINE STEP] ${e.data.step}: ${e.data.message || ""}`);
    } else if (e.type === "trace") {
      console.log(`[FIELD FILLED] ${e.data.field} -> "${e.data.value}"`);
    } else if (e.type === "submitted") {
      console.log(`[ENGINE SUBMITTED] Confirmed: "${e.data.confirmationText}"`);
    } else if (e.type === "failed") {
      console.error(`[ENGINE FAILED] Step: ${e.data.step} Error: ${e.data.error}`);
    }
  });

  const result = await apply(targetUrl, sampleProfile, resumePdfPath);

  console.log("\n=================================================================");
  console.log(`🏁 APPLY COMPLETED WITH STATUS: ${result.status}`);
  console.log("=================================================================\n");

  if (result.status !== "SUBMITTED") {
    console.error("Submission failed or did not reach SUBMITTED state:", result);
    process.exit(1);
  }

  const runId = result.runId;
  const runRecord = getRun(runId);

  // Check recordings directory and video file
  const recDir = path.resolve(`./recordings/${runId}`);
  console.log(`📂 Checking recording directory: ${recDir}`);
  if (!fs.existsSync(recDir)) {
    throw new Error(`Recordings directory does not exist: ${recDir}`);
  }

  const files = fs.readdirSync(recDir);
  console.log(`📁 Files in ${recDir}:`, files);

  const videoFile = files.find((f) => f.endsWith(".webm"));
  if (!videoFile) {
    throw new Error(`No .webm video file found in ${recDir}`);
  }

  const videoPath = path.join(recDir, videoFile);
  const stat = fs.statSync(videoPath);
  console.log(`\n📹 Video file found: ${videoPath}`);
  console.log(`📊 Video file size: ${stat.size} bytes (${(stat.size / 1024).toFixed(2)} KB)`);

  if (stat.size === 0) {
    throw new Error(`Video file is empty (size is 0 bytes): ${videoPath}`);
  }

  console.log("\n=================================================================");
  console.log("📜 FULL RUN RECORD DETAILS");
  console.log("=================================================================");
  console.log("Run ID:", runRecord?.runId);
  console.log("Job URL:", runRecord?.jobUrl);
  console.log("State:", runRecord?.state);
  console.log("Created At:", runRecord?.createdAt);
  console.log("Updated At:", runRecord?.updatedAt);
  console.log("\n--- CONFIRMATION TEXT ---");
  console.log(runRecord?.confirmationText);
  console.log("\n--- VERIFIED SUBMISSION RECEIPT ---");
  console.log(JSON.stringify(runRecord?.receipt, null, 2));
  console.log("\n--- EXECUTION TRACE LOG ---");
  console.log(JSON.stringify(runRecord?.trace, null, 2));

  console.log("\n=================================================================");
  console.log("✅ SUMMARY DELIVERABLES");
  console.log("=================================================================");
  console.log(`- Run ID: ${runId}`);
  console.log(`- Confirmation Text: ${result.confirmationText}`);
  console.log(`- Video File Path: ${videoPath}`);
  console.log(`- Video File Size: ${stat.size} bytes (${(stat.size / 1024).toFixed(2)} KB)`);
  console.log("=================================================================\n");
}

main().catch((err) => {
  console.error("FATAL ERROR during live test execution:", err);
  process.exit(1);
});
