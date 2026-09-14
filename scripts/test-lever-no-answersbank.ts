import * as fs from "node:fs";
import * as path from "node:path";
import { apply, applyResume } from "../src/engine.js";
import { getRun } from "../src/store.js";
import { engineEvents } from "../src/events.js";
import type { Profile, Question } from "../src/types.js";

async function main() {
  const targetUrl = "https://jobs.lever.co/leverdemo/82fbbecc-5535-466b-a84b-7957cf49e443/apply";

  // Standard profile WITHOUT survey questions in answersBank
  const profileWithoutSurvey: Profile = {
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
    // NO answersBank!
  };

  const resumePdfPath = path.resolve("./sample_resume.pdf");

  console.log("=================================================================");
  console.log("TESTING REAL LEVER DEMO WITH PROFILE LACKING SURVEY ANSWERS");
  console.log("=================================================================");

  engineEvents.on("event", (e) => {
    if (e.type === "step") {
      console.log(`[ENGINE STEP] ${e.data.step}: ${e.data.message || ""}`);
    } else if (e.type === "trace") {
      console.log(`[FIELD FILLED] ${e.data.field} -> "${e.data.value}"`);
    } else if (e.type === "needs_input") {
      console.log(`[ENGINE NEEDS_INPUT] Paused with questions:`, e.data.questions);
    }
  });

  const result = await apply(targetUrl, profileWithoutSurvey, resumePdfPath);
  console.log("\nApply Result Status:", result.status);
  if (result.status === "NEEDS_INPUT") {
    console.log("Paused on questions:", JSON.stringify(result.questions, null, 2));
  } else if (result.status === "SUBMITTED") {
    console.log("Went straight to SUBMITTED. Confirmation:", result.confirmationText);
  } else {
    console.log("Failed:", result.error);
  }
}

main().catch(console.error);
