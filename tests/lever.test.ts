import { chromium } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { leverAdapter } from "../src/adapters/lever.js";
import type { FormField } from "../src/types.js";

// Mock Lever HTML page with realistic markup
const mockLeverFormHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>Acme Corp - Senior Software Engineer</title>
</head>
<body class="application">
  <div class="application-page">
    <form id="application-form">
      <h4>Submit your application</h4>
      <ul>
        <!-- Resume Upload -->
        <li class="application-question resume">
          <label>
            <div class="application-label">Resume/CV <span class="required">✱</span></div>
            <div class="application-field">
              <input class="application-file-input" id="resume-upload-input" name="resume" type="file" required>
              <span class="resume-upload-success" style="display:none;">Success!</span>
            </div>
          </label>
        </li>

        <!-- Full Name -->
        <li class="application-question">
          <label>
            <div class="application-label">Full name<span class="required">✱</span></div>
            <div class="application-field">
              <input type="text" name="name" required>
            </div>
          </label>
        </li>

        <!-- Email -->
        <li class="application-question">
          <label>
            <div class="application-label">Email<span class="required">✱</span></div>
            <div class="application-field">
              <input type="email" name="email" required>
            </div>
          </label>
        </li>

        <!-- Phone -->
        <li class="application-question">
          <label>
            <div class="application-label">Phone <span class="required">✱</span></div>
            <div class="application-field">
              <input type="tel" name="phone" required>
            </div>
          </label>
        </li>

        <!-- Current Company -->
        <li class="application-question">
          <label>
            <div class="application-label">Current company</div>
            <div class="application-field">
              <input type="text" name="org">
            </div>
          </label>
        </li>

        <!-- Select Dropdown: Location -->
        <li class="application-question">
          <div class="application-label">Which location are you applying for?<span class="required">✱</span></div>
          <div class="application-field">
            <select name="opportunityLocationId" required>
              <option value="">Select...</option>
              <option value="loc-sf">San Francisco, CA</option>
              <option value="loc-ny">New York, NY</option>
              <option value="loc-remote">Remote</option>
            </select>
          </div>
        </li>

        <!-- Custom Dropdown: Work Authorization -->
        <li class="application-question custom-question">
          <div>
            <div class="application-label dropdown">
              <div class="text">Are you legally authorized to work in this country?<span class="required">✱</span></div>
            </div>
            <div class="application-field">
              <select name="cards[work_auth][field0]" required>
                <option value="">Choose one</option>
                <option value="Yes">Yes</option>
                <option value="No">No</option>
              </select>
            </div>
          </div>
        </li>

        <!-- Textarea: Additional comments -->
        <li class="application-question">
          <label>
            <div class="application-label">Additional comments</div>
            <div class="application-field">
              <textarea name="comments" placeholder="Add any notes here"></textarea>
            </div>
          </label>
        </li>

        <!-- Checkbox: Consent / Terms -->
        <li class="application-question">
          <div class="application-field">
            <label>
              <input type="checkbox" name="consent" required>
              <span>I agree to the privacy policy</span>
            </label>
          </div>
        </li>

        <!-- Radio Group: Age Confirmation -->
        <li class="application-question">
          <div class="application-label multiple-choice">
            <div class="text">Are you 18 or older?<span class="required">✱</span></div>
          </div>
          <div class="application-field">
            <ul>
              <li>
                <label>
                  <input type="radio" name="age_confirmation" value="yes">
                  <span class="application-answer-alternative">Yes, I am 18 or older</span>
                </label>
              </li>
              <li>
                <label>
                  <input type="radio" name="age_confirmation" value="no">
                  <span class="application-answer-alternative">No, I am under 18</span>
                </label>
              </li>
            </ul>
          </div>
        </li>
      </ul>

      <!-- Hidden inputs that should be skipped -->
      <input type="hidden" name="accountId" value="test-account-123">
      <input type="hidden" name="timezone" value="America/New_York">

      <!-- Submit Button -->
      <div class="section application-form last-section-apply">
        <button id="btn-submit" type="button" class="postings-btn template-btn-submit">Submit application</button>
      </div>
    </form>
    <div id="confirmation-result" style="display:none;">
      <h3 class="application-confirmation">Thank you! Your application has been submitted.</h3>
    </div>
  </div>

  <script>
    document.getElementById('btn-submit').addEventListener('click', () => {
      console.log('BTN SUBMIT CLICKED IN BROWSER');
      document.getElementById('application-form').style.display = 'none';
      document.getElementById('confirmation-result').style.display = 'block';
    });
  </script>
</body>
</html>
`;

// Posting page mock with "Apply" button leading to the application
const mockLeverPostingHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>Acme Corp - Job Description</title>
</head>
<body class="show">
  <div class="posting-header">
    <h2>Senior Software Engineer</h2>
    <div data-qa="btn-apply">
      <a href="/apply" class="postings-btn template-btn-submit">Apply for this job</a>
    </div>
  </div>
</body>
</html>
`;

async function runTests() {
  console.log("=== Running Lever ATS Adapter Tests ===");

  // 1. Start local mock HTTP server
  let serverPort = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/apply") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(mockLeverFormHtml);
    } else if (req.url === "/posting") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(mockLeverPostingHtml);
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
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

  const baseUrl = `http://localhost:${serverPort}`;
  console.log(`Mock server started on ${baseUrl}`);

  // Create temporary resume file
  const tmpResumePath = path.resolve("./temp_resume.pdf");
  fs.writeFileSync(tmpResumePath, "DUMMY RESUME CONTENT");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err));

  try {
    // --- TEST 1: openForm on posting page with Apply button ---
    console.log("Test 1: openForm navigating from posting to apply...");
    await leverAdapter.openForm(page, `${baseUrl}/posting`);
    const formVisible = await page.locator("#application-form").isVisible();
    if (!formVisible) throw new Error("openForm failed to navigate to and reveal the form.");
    console.log("✓ openForm successfully opened form via posting page");

    // --- TEST 2: openForm on direct apply page ---
    console.log("Test 2: openForm navigating directly to /apply...");
    await leverAdapter.openForm(page, `${baseUrl}/apply`);
    console.log("✓ openForm direct navigation passed");

    // --- TEST 3: readFields ---
    console.log("Test 3: readFields parsing all fields...");
    const fields = await leverAdapter.readFields(page);

    console.log(`Discovered ${fields.length} fields:`);
    for (const f of fields) {
      console.log(`  - [${f.type}] ${f.id} | Label: "${f.label}" | Req: ${f.required} ${f.options ? `| Options: ${JSON.stringify(f.options)}` : ""}`);
    }

    // Assertions on readFields
    const findField = (id: string): FormField => {
      const f = fields.find((x) => x.id === id);
      if (!f) throw new Error(`Field '${id}' was not discovered by readFields!`);
      return f;
    };

    const resumeField = findField("resume");
    if (resumeField.type !== "file") throw new Error("Resume field type mismatch");
    if (!resumeField.required) throw new Error("Resume field should be required");

    const nameField = findField("name");
    if (nameField.type !== "text") throw new Error("Name field type mismatch");
    if (nameField.label !== "Full name") throw new Error(`Name label mismatch: '${nameField.label}'`);
    if (!nameField.required) throw new Error("Name field should be required");

    const emailField = findField("email");
    if (emailField.type !== "email") throw new Error("Email field type mismatch");
    if (!emailField.required) throw new Error("Email field should be required");

    const phoneField = findField("phone");
    if (phoneField.type !== "phone") throw new Error("Phone field type mismatch");
    if (!phoneField.required) throw new Error("Phone field should be required");

    const locationField = findField("opportunityLocationId");
    if (locationField.type !== "select") throw new Error("Location field type mismatch");
    if (!locationField.options || locationField.options.length !== 3) {
      throw new Error(`Location options mismatch: ${JSON.stringify(locationField.options)}`);
    }

    const workAuthField = findField("cards[work_auth][field0]");
    if (workAuthField.type !== "select") throw new Error("Work auth field type mismatch");
    if (!workAuthField.options?.includes("Yes") || !workAuthField.options?.includes("No")) {
      throw new Error("Work auth options mismatch");
    }

    const commentsField = findField("comments");
    if (commentsField.type !== "textarea") throw new Error("Comments field type mismatch");
    if (commentsField.required) throw new Error("Comments field should not be required");

    const consentField = findField("consent");
    if (consentField.type !== "checkbox") throw new Error("Consent field type mismatch");

    const radioField = findField("age_confirmation");
    if (radioField.type !== "radio") throw new Error("Age confirmation field type mismatch");
    if (!radioField.options || radioField.options.length !== 2) {
      throw new Error(`Radio options mismatch: ${JSON.stringify(radioField.options)}`);
    }

    console.log("✓ readFields all field assertions passed!");

    // --- TEST 4: fillField for all types ---
    console.log("Test 4: fillField executing for all types...");
    await leverAdapter.fillField(page, nameField, "Jane Doe");
    await leverAdapter.fillField(page, emailField, "jane.doe@example.com");
    await leverAdapter.fillField(page, phoneField, "+1-555-0199");
    await leverAdapter.fillField(page, findField("org"), "Acme Inc");
    await leverAdapter.fillField(page, locationField, "San Francisco, CA");
    await leverAdapter.fillField(page, workAuthField, "Yes");
    await leverAdapter.fillField(page, commentsField, "Looking forward to this role!");
    await leverAdapter.fillField(page, consentField, "true");
    await leverAdapter.fillField(page, radioField, "Yes, I am 18 or older");

    // Verify values in DOM
    const nameVal = await page.locator('input[name="name"]').inputValue();
    if (nameVal !== "Jane Doe") throw new Error(`Name fill mismatch: ${nameVal}`);

    const emailVal = await page.locator('input[name="email"]').inputValue();
    if (emailVal !== "jane.doe@example.com") throw new Error(`Email fill mismatch: ${emailVal}`);

    const phoneVal = await page.locator('input[name="phone"]').inputValue();
    if (phoneVal !== "+1-555-0199") throw new Error(`Phone fill mismatch: ${phoneVal}`);

    const locVal = await page.locator('select[name="opportunityLocationId"]').inputValue();
    if (locVal !== "loc-sf") throw new Error(`Location select mismatch: ${locVal}`);

    const authVal = await page.locator('select[name="cards[work_auth][field0]"]').inputValue();
    if (authVal !== "Yes") throw new Error(`Work auth select mismatch: ${authVal}`);

    const commentsVal = await page.locator('textarea[name="comments"]').inputValue();
    if (commentsVal !== "Looking forward to this role!") throw new Error("Comments mismatch");

    const consentChecked = await page.locator('input[name="consent"]').isChecked();
    if (!consentChecked) throw new Error("Consent checkbox not checked");

    const radioChecked = await page.locator('input[name="age_confirmation"][value="yes"]').isChecked();
    if (!radioChecked) throw new Error("Radio option not checked");

    console.log("✓ fillField verified successfully across all input types");

    // --- TEST 5: uploadResume ---
    console.log("Test 5: uploadResume verifying file attachment...");
    await leverAdapter.uploadResume(page, tmpResumePath);
    const filesCount = await page.locator("#resume-upload-input").evaluate((el: HTMLInputElement) => el.files?.length || 0);
    if (filesCount !== 1) throw new Error(`Resume not attached, filesCount=${filesCount}`);
    console.log("✓ uploadResume verified successfully");

    // --- TEST 6: Error handling on missing elements ---
    console.log("Test 6: verifying explicit error handling...");
    try {
      await leverAdapter.fillField(page, { id: "non_existent_field", label: "Non existent", type: "text", required: false }, "value");
      throw new Error("Should have thrown error on non-existent field");
    } catch (err: any) {
      if (!err.message.includes("could not be found in the DOM")) {
        throw new Error(`Unexpected error message: ${err.message}`);
      }
      console.log("✓ Explicit error thrown for missing field as required");
    }

    try {
      await leverAdapter.uploadResume(page, "/invalid/path/to/resume.pdf");
      throw new Error("Should have thrown error on non-existent file path");
    } catch (err: any) {
      if (!err.message.includes("Resume file not found at path")) {
        throw new Error(`Unexpected error message: ${err.message}`);
      }
      console.log("✓ Explicit error thrown for missing file as required");
    }

    // --- TEST 7: submit ---
    console.log("Test 7: submit form and capture confirmationText...");
    const result = await leverAdapter.submit(page);
    console.log("Submission result:", result);
    if (!result.confirmationText.includes("Thank you! Your application has been submitted")) {
      throw new Error(`Confirmation text mismatch: ${result.confirmationText}`);
    }
    console.log("✓ submit verified successfully");

    console.log("\nALL LEVER ATS ADAPTER TESTS PASSED! 🎉");
  } finally {
    if (fs.existsSync(tmpResumePath)) {
      fs.unlinkSync(tmpResumePath);
    }
    await browser.close();
    server.close();
  }
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
