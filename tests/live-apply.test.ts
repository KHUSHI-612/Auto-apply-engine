import { apply } from "../src/engine.js";
import { engineEvents } from "../src/events.js";
import type { Profile } from "../src/types.js";

async function main() {
  engineEvents.on("event", (e) => {
    console.log(`[SSE Event] ${e.type} (run: ${e.runId})`, e.data);
  });

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

  const url = "https://jobs.lever.co/leverdemo/82fbbecc-5535-466b-a84b-7957cf49e443";
  console.log("=== Testing live apply() against real Lever Demo ===");
  console.log("Target URL:", url);

  const result = await apply(url, sampleProfile, "./sample_resume.pdf");
  console.log("\nLive Apply Result Status:", result.status);
  console.log("Result details:", JSON.stringify(result, null, 2));
}

main().catch(console.error);
