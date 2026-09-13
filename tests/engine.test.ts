import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { apply, applyResume } from "../src/engine.js";
import { getRun, clearStore } from "../src/store.js";
import type { Profile } from "../src/types.js";

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// Mock Lever HTML form containing standard fields, EEO fields, and a custom screener question
const mockLeverHtml = `
<!DOCTYPE html>
<html>
<head><title>Senior Engineer - Lever Application</title></head>
<body class="application">
  <div class="application-page">
    <form id="application-form">
      <h4>Submit Application</h4>
      <ul>
        <li>
          <label>
            <div class="application-label">Resume/CV <span class="required">✱</span></div>
            <input id="resume-upload-input" name="resume" type="file" required>
          </label>
        </li>
        <li>
          <label>
            <div class="application-label">Full name<span class="required">✱</span></div>
            <input type="text" name="name" required>
          </label>
        </li>
        <li>
          <label>
            <div class="application-label">Email<span class="required">✱</span></div>
            <input type="email" name="email" required>
          </label>
        </li>
        <li>
          <label>
            <div class="application-label">Phone<span class="required">✱</span></div>
            <input type="tel" name="phone" required>
          </label>
        </li>
        <li>
          <label>
            <div class="application-label">Current company</div>
            <input type="text" name="org">
          </label>
        </li>
        <!-- EEO question: gender -->
        <li>
          <label>
            <div class="application-label">Gender</div>
            <select name="gender">
              <option value="">Select...</option>
              <option value="Male">Male</option>
              <option value="Female">Female</option>
              <option value="Decline to state">Decline to state</option>
            </select>
          </label>
        </li>
        <!-- EEO question: veteran status -->
        <li>
          <label>
            <div class="application-label">Veteran Status</div>
            <select name="veteran">
              <option value="">Select...</option>
              <option value="I am a veteran">I am a veteran</option>
              <option value="Decline to state">Decline to state</option>
            </select>
          </label>
        </li>
        <!-- Custom screener question that will require user input -->
        <li id="custom-q-container">
          <label>
            <div class="application-label">Notice period (weeks)<span class="required">✱</span></div>
            <input type="text" name="notice_period" required>
          </label>
        </li>
      </ul>
      <button id="btn-submit" type="button">Submit Application</button>
    </form>
    <div id="confirmation-result" style="display:none;">
      <h3 class="application-confirmation">Thank you! Application submitted successfully.</h3>
    </div>
  </div>
  <script>
    document.getElementById('btn-submit').addEventListener('click', () => {
      document.getElementById('application-form').style.display = 'none';
      document.getElementById('confirmation-result').style.display = 'block';
    });
  </script>
</body>
</html>
`;

async function runEngineTests() {
  console.log("=== Running Engine Tests (apply & applyResume) ===");

  // Start local mock HTTP server
  let serverPort = 0;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(mockLeverHtml);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        serverPort = addr.port;
      }
      resolve();
    });
  });

  const jobUrl = `http://localhost:${serverPort}/jobs.lever.co/company/job123`;
  console.log(`Mock server started on ${jobUrl}`);

  // Create temporary resume file
  const tmpResumePath = path.resolve("./temp_engine_resume.pdf");
  fs.writeFileSync(tmpResumePath, "DUMMY RESUME FILE CONTENT");

  const baseProfile: Profile = {
    personalInfo: {
      fullName: "Morgan Taylor",
      email: "morgan@example.com",
      phone: "+1-555-0182",
    },
    experience: [
      {
        company: "Acme Corp",
        jobTitle: "Software Architect",
        current: true,
      },
    ],
  };

  try {
    // --- TEST 1: detectAdapter failure (Unsupported ATS) ---
    console.log("Test 1: Unsupported ATS handling...");
    const unsupportedResult = await apply(
      "https://random-unknown-board.com/careers/456",
      baseProfile,
      tmpResumePath
    );
    if (unsupportedResult.status !== "FAILED") {
      throw new Error(`Expected FAILED, got ${unsupportedResult.status}`);
    }
    assert(unsupportedResult.step === "detect_adapter", `Step should be detect_adapter, got: ${unsupportedResult.step}`);
    assert(unsupportedResult.error.includes("Unsupported ATS"), "Error should explain unsupported ATS");
    console.log("✓ Unsupported ATS handled gracefully with FAILED result");

    // --- TEST 2: apply requiring input on custom question ---
    console.log("Test 2: apply suspended with NEEDS_INPUT for custom screener question...");
    clearStore();
    const needsInputResult = await apply(jobUrl, baseProfile, tmpResumePath);

    if (needsInputResult.status !== "NEEDS_INPUT") {
      throw new Error(`Expected NEEDS_INPUT, got ${(needsInputResult as any).status} (error: ${(needsInputResult as any).error})`);
    }
    const runId = needsInputResult.runId;
    assert(Boolean(runId), "runId must be present");
    console.log("Returned missing questions:", needsInputResult.questions);
    assert(needsInputResult.questions.length === 1, `Expected 1 missing question, got ${needsInputResult.questions.length}`);
    assert(needsInputResult.questions[0].id === "notice_period", "Missing question id should be notice_period");

    // Verify run record in store
    const storedRun = getRun(runId);
    assert(storedRun !== undefined, "Run must be in store");
    assert(storedRun!.state === "NEEDS_INPUT", "Stored run state should be NEEDS_INPUT");
    assert(Boolean(storedRun!.recordingDir), "Recording directory should be saved on run");
    assert(storedRun!.trace.length >= 5, `Expected at least 5 traces (name, email, phone, company, resume, EEO), got ${storedRun!.trace.length}`);

    // Verify EEO fields were auto-filled with "Decline to state" and traced
    const genderTrace = storedRun!.trace.find((t) => t.field === "gender");
    assert(genderTrace?.value === "Decline to state", `Gender should be auto-filled with Decline to state, got ${genderTrace?.value}`);

    const veteranTrace = storedRun!.trace.find((t) => t.field === "veteran");
    assert(veteranTrace?.value === "Decline to state", `Veteran should be auto-filled with Decline to state, got ${veteranTrace?.value}`);

    console.log("✓ apply paused cleanly with NEEDS_INPUT and auto-filled EEO defaults");

    // --- TEST 3: applyResume validation failures ---
    console.log("Test 3: applyResume validation checks...");
    // 3A: Invalid runId
    const invalidRunRes = await applyResume("non_existent_run", { notice_period: "4" });
    if (invalidRunRes.status !== "FAILED") {
      throw new Error(`Expected FAILED, got ${invalidRunRes.status}`);
    }
    assert(invalidRunRes.error.includes("not found"), "Error should mention not found");

    // 3B: Missing required answer
    const missingAnsRes = await applyResume(runId, {});
    if (missingAnsRes.status !== "FAILED") {
      throw new Error(`Expected FAILED, got ${missingAnsRes.status}`);
    }
    assert(missingAnsRes.step === "validate_answers", "Step should be validate_answers");
    assert(missingAnsRes.error.includes("unanswered"), "Error should note unanswered field");
    console.log("✓ applyResume validations passed");

    // --- TEST 4: applyResume successful resume and submission ---
    console.log("Test 4: applyResume answering pending question and finalizing submission...");
    const resumeResult = await applyResume(runId, { notice_period: "3 weeks" });

    if (resumeResult.status !== "SUBMITTED") {
      throw new Error(`Expected SUBMITTED, got: ${JSON.stringify(resumeResult)}`);
    }
    assert(resumeResult.runId === runId, "runId should match");
    assert(resumeResult.confirmationText.includes("Application submitted successfully"), "Confirmation text mismatch");
    assert(Boolean(resumeResult.receipt["notice_period"]), "Receipt should include notice_period");
    assert(resumeResult.receipt["notice_period"] === "3 weeks", "Notice period receipt value mismatch");
    assert(Boolean(resumeResult.receipt["name"]), "Receipt should include name");
    assert(Boolean(resumeResult.receipt["resume"]), "Receipt should include resume");

    // Verify store after submission
    const finalRun = getRun(runId);
    assert(finalRun!.state === "SUBMITTED", "Final run state should be SUBMITTED");
    assert(finalRun!.confirmationText === resumeResult.confirmationText, "Confirmation text should be saved");
    console.log("✓ applyResume resumed, filled pending answers, and finalized submission");

    // --- TEST 5: apply with complete answersBank (immediate submission) ---
    console.log("Test 5: apply with complete answersBank submits immediately without pausing...");
    const completeProfile: Profile = {
      ...baseProfile,
      answersBank: {
        "Notice period (weeks)": "Immediate",
      },
    };

    const directSubmitResult = await apply(jobUrl, completeProfile, tmpResumePath);
    if (directSubmitResult.status !== "SUBMITTED") {
      throw new Error(`Expected direct SUBMITTED, got ${directSubmitResult.status}`);
    }
    assert(directSubmitResult.receipt["notice_period"] === "Immediate", "answersBank value should be in receipt");
    console.log("✓ apply with complete profile submitted directly without pausing");

    console.log("\nALL ENGINE TESTS PASSED! 🎉");
  } finally {
    if (fs.existsSync(tmpResumePath)) {
      fs.unlinkSync(tmpResumePath);
    }
    server.close();
  }
}

runEngineTests().catch((err) => {
  console.error("Engine test failed:", err);
  process.exit(1);
});
