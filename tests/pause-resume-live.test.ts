import { apply, applyResume } from "../src/engine.js";
import { engineEvents } from "../src/events.js";
import type { Profile } from "../src/types.js";

async function main() {
  engineEvents.on("event", (e) => {
    console.log(`[Event ${e.type}] (run: ${e.runId})`, e.data);
  });

  // Profile WITHOUT answers for the custom survey questions
  const profileWithoutSurvey: Profile = {
    personalInfo: {
      fullName: "Jordan Lee",
      email: "jordan.lee.test@example.com",
      phone: "+1 (555) 987-6543",
      location: "San Francisco, CA"
    },
    profiles: [
      { network: "LinkedIn", url: "https://linkedin.com/in/jordanlee-demo" }
    ],
    experience: [
      {
        company: "Venture Automation Inc",
        jobTitle: "Staff Software Engineer",
        current: true
      }
    ],
    education: [
      {
        school: "Stanford University",
        degree: "B.S. Symbolic Systems"
      }
    ]
    // Notice: answersBank is intentionally omitted for custom screener questions!
  };

  const url = "http://localhost:3000/mock-ats/lever/apply?withQuestions=true";
  console.log("=== Testing Pause/Resume across real gap ===");
  console.log("Target URL:", url);

  console.log("\n1. Calling apply()...");
  const result1 = await apply(url, profileWithoutSurvey, "./sample_resume.pdf");
  console.log("Apply result status:", result1.status);

  if (result1.status !== "NEEDS_INPUT") {
    throw new Error(`Expected NEEDS_INPUT but got ${result1.status}`);
  }

  console.log(`Run ${result1.runId} paused cleanly with ${result1.questions.length} questions.`);
  console.log("Waiting for a real time gap (10 seconds) to verify browser session survival...");

  await new Promise((r) => setTimeout(r, 10000));

  console.log("\n2. Resuming the SAME browser session with user answers via applyResume()...");
  const answers: Record<string, string> = {
    "cards[typescript_years]": "5",
    "cards[notice_period_weeks]": "2",
    "cards[us_work_authorization]": "Yes"
  };

  const result2 = await applyResume(result1.runId, answers);
  if (result2.status === "SUBMITTED") {
    console.log("\nResume result status:", result2.status);
    console.log("Receipt:", JSON.stringify(result2.receipt, null, 2));
    console.log("Confirmation Text:", result2.confirmationText);
    console.log("\n🎉 PAUSE/RESUME ACROSS GAP VERIFIED SUCCESSFULLY!");
  } else {
    throw new Error(`Expected SUBMITTED but got ${result2.status}`);
  }
}

main().catch(console.error);
