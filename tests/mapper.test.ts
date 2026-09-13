import { mapFields } from "../src/mapper.js";
import type { FormField, Profile } from "../src/types.js";

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function runMapperTests() {
  console.log("=== Running mapFields Unit Tests ===");

  const sampleProfile: Profile = {
    personalInfo: {
      fullName: "Alex Morgan Rivera",
      email: "alex.rivera@example.com",
      phone: "+1-415-555-2671",
    },
    profiles: [
      { network: "LinkedIn", url: "https://linkedin.com/in/alexrivera" },
      { network: "GitHub", url: "https://github.com/alexrivera" },
      { network: "Twitter", url: "https://twitter.com/alexrivera" },
    ],
    experience: [
      {
        company: "Stripe",
        jobTitle: "Senior Staff Engineer",
        current: true,
      },
      {
        company: "Google",
        jobTitle: "Software Engineer",
        current: false,
      },
    ],
    education: [
      {
        school: "UC Berkeley",
        degree: "B.S. in Computer Science",
      },
    ],
    answersBank: {
      "Are you authorized to work in the United States?": "Yes",
      "notice period (weeks)": "2 weeks",
      "Preferred Pronouns": "They/them",
    },
  };

  // Test 1: Standard personal info mapping
  {
    console.log("Test 1: Standard personal info mapping (full name, first, last, email, phone)...");
    const fields: FormField[] = [
      { id: "f1", label: "Full Name", type: "text", required: true },
      { id: "f2", label: "First Name", type: "text", required: true },
      { id: "f3", label: "Last Name", type: "text", required: true },
      { id: "f4", label: "Email Address", type: "email", required: true },
      { id: "f5", label: "Phone Number", type: "phone", required: true },
    ];

    const { filled, missing } = mapFields(fields, sampleProfile);

    assert(filled.length === 5, `Expected 5 filled fields, got ${filled.length}`);
    assert(missing.length === 0, `Expected 0 missing fields, got ${missing.length}`);

    assert(filled[0].value === "Alex Morgan Rivera", "Full Name mismatch");
    assert(filled[1].value === "Alex", `First Name mismatch: ${filled[1].value}`);
    assert(filled[2].value === "Morgan Rivera", `Last Name mismatch: ${filled[2].value}`);
    assert(filled[3].value === "alex.rivera@example.com", "Email mismatch");
    assert(filled[4].value === "+1-415-555-2671", "Phone mismatch");
    console.log("✓ Personal info mapping passed");
  }

  // Test 2: Social profiles (LinkedIn and GitHub)
  {
    console.log("Test 2: Social profiles mapping (LinkedIn and GitHub)...");
    const fields: FormField[] = [
      { id: "l1", label: "LinkedIn URL", type: "text", required: false },
      { id: "g1", label: "GitHub Profile", type: "text", required: false },
    ];

    const { filled, missing } = mapFields(fields, sampleProfile);
    assert(filled.length === 2, "Expected 2 filled fields");
    assert(filled[0].value === "https://linkedin.com/in/alexrivera", "LinkedIn URL mismatch");
    assert(filled[1].value === "https://github.com/alexrivera", "GitHub URL mismatch");
    assert(missing.length === 0, "Expected 0 missing fields");
    console.log("✓ Social profiles mapping passed");
  }

  // Test 3: Experience current-check rule
  {
    console.log("Test 3: Experience current-check rule...");
    // Case A: experience[0].current is true (or undefined)
    const fieldsA: FormField[] = [
      { id: "c1", label: "Current Company", type: "text", required: true },
      { id: "t1", label: "Current Title", type: "text", required: true },
    ];
    const resA = mapFields(fieldsA, sampleProfile);
    assert(resA.filled[0].value === "Stripe", "Current company should be Stripe");
    assert(resA.filled[1].value === "Senior Staff Engineer", "Current title should be Senior Staff Engineer");

    // Case B: experience[0].current === false, must find entry where current === true
    const pastFirstProfile: Profile = {
      ...sampleProfile,
      experience: [
        {
          company: "Consulting Gig",
          jobTitle: "Contractor",
          current: false, // Not current!
        },
        {
          company: "Datadog",
          jobTitle: "Lead Infrastructure Engineer",
          current: true, // This is current!
        },
      ],
    };
    const resB = mapFields(fieldsA, pastFirstProfile);
    assert(resB.filled[0].value === "Datadog", `Expected Datadog, got ${resB.filled[0]?.value}`);
    assert(resB.filled[1].value === "Lead Infrastructure Engineer", `Expected Lead Infrastructure Engineer, got ${resB.filled[1]?.value}`);
    console.log("✓ Experience current-check rule passed");
  }

  // Test 4: Education mapping
  {
    console.log("Test 4: Education mapping (School & Degree)...");
    const fields: FormField[] = [
      { id: "s1", label: "School / University", type: "text", required: false },
      { id: "d1", label: "Degree", type: "text", required: false },
    ];
    const { filled } = mapFields(fields, sampleProfile);
    assert(filled[0].value === "UC Berkeley", "School mismatch");
    assert(filled[1].value === "B.S. in Computer Science", "Degree mismatch");
    console.log("✓ Education mapping passed");
  }

  // Test 5: AnswersBank priority and fuzzy key matching
  {
    console.log("Test 5: AnswersBank priority and fuzzy matching...");
    const fields: FormField[] = [
      // Fuzzy match on punctuation and case: "notice period (weeks)" vs "Notice Period (weeks)?"
      { id: "np", label: "Notice period (weeks)?", type: "text", required: true },
      // AnswersBank overrides even standard field if explicit
      { id: "auth", label: "Are you authorized to work in the United States?", type: "select", required: true, options: ["Yes", "No"] },
    ];

    const { filled, missing } = mapFields(fields, sampleProfile);
    assert(filled.length === 2, `Expected 2 filled, got ${filled.length}`);
    assert(filled[0].value === "2 weeks", `Notice period mismatch: ${filled[0].value}`);
    assert(filled[1].value === "Yes", `Work auth mismatch: ${filled[1].value}`);
    assert(missing.length === 0, "Expected 0 missing");
    console.log("✓ AnswersBank priority & fuzzy matching passed");
  }

  // Test 6: Hard rule: non-confidently-matched fields MUST go to missing, not guessed
  {
    console.log("Test 6: Unmatched questions go to missing without fabrication...");
    const fields: FormField[] = [
      { id: "sponsorship", label: "Will you now or in the future require visa sponsorship?", type: "radio", required: true, options: ["Yes", "No"] },
      { id: "custom_q", label: "What is your experience with Kubernetes?", type: "textarea", required: false },
      { id: "salary", label: "Desired annual compensation (USD)", type: "number", required: true },
    ];

    const { filled, missing } = mapFields(fields, sampleProfile);
    assert(filled.length === 0, `Expected 0 filled fields, got ${filled.length}`);
    assert(missing.length === 3, `Expected 3 missing fields, got ${missing.length}`);

    // Verify type and options are carried over unchanged
    assert(missing[0].id === "sponsorship", "Missing field id mismatch");
    assert(missing[0].type === "radio", "Missing field type must be preserved");
    assert(missing[0].options?.length === 2, "Missing field options must be preserved");
    assert(missing[1].type === "textarea", "Missing textarea type must be preserved");
    assert(missing[2].type === "number", "Missing number type must be preserved");
    console.log("✓ Unmatched fields correctly routed to missing with preserved type/options");
  }

  // Test 7: EEO / Demographic questions specifically carry a note and are NOT defaulted to 'Decline'
  {
    console.log("Test 7: EEO / Demographic questions placed in missing with a note...");
    const fields: FormField[] = [
      { id: "gender", label: "Gender Identity", type: "select", required: false, options: ["Female", "Male", "Non-binary", "Decline to state"] },
      { id: "race", label: "Race / Ethnicity", type: "radio", required: false, options: ["Asian", "White", "Black", "Two or more", "Decline"] },
      { id: "veteran", label: "Veteran Status", type: "select", required: false, options: ["I am a veteran", "I am not a veteran", "Decline"] },
      { id: "disability", label: "Disability Status", type: "select", required: false, options: ["Yes", "No", "Decline"] },
    ];

    const { filled, missing } = mapFields(fields, sampleProfile);
    assert(filled.length === 0, `Expected 0 filled fields, got ${filled.length}`);
    assert(missing.length === 4, `Expected 4 missing fields, got ${missing.length}`);

    for (const m of missing) {
      assert(Boolean(m.note), `Missing EEO field '${m.label}' must have a note`);
      assert(m.note!.includes("Demographic/EEO"), `Note mismatch: ${m.note}`);
      assert(Array.isArray(m.options) && m.options.length > 0, "Options must be preserved");
    }
    console.log("✓ EEO/Demographic questions properly tagged with note in missing");
  }

  // Test 8: Missing profile values (e.g. no phone or empty string) must not fabricate values
  {
    console.log("Test 8: Incomplete profile fields route to missing...");
    const emptyProfile: Profile = {
      personalInfo: {
        fullName: "Taylor Swift",
        email: "taylor@example.com",
        phone: "", // Empty phone!
      },
    };
    const fields: FormField[] = [
      { id: "p1", label: "Phone", type: "phone", required: true },
      { id: "comp", label: "Current Company", type: "text", required: false },
    ];

    const { filled, missing } = mapFields(fields, emptyProfile);
    assert(filled.length === 0, `Expected 0 filled fields, got ${filled.length}`);
    assert(missing.length === 2, `Expected 2 missing fields, got ${missing.length}`);
    console.log("✓ Incomplete profile fields handled without fabrication");
  }

  console.log("\nALL MAPPER TESTS PASSED! 🎉");
}

runMapperTests();
