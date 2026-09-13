import type { Page, Locator } from "playwright";
import * as fs from "node:fs";
import type { AtsAdapter, FormField, FieldType } from "../types.js";

/**
 * Escapes special CSS characters in a selector attribute value.
 */
function escapeCssAttr(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/**
 * Normalizes label text by stripping leading/trailing asterisks and excess whitespace.
 */
function normalizeLabel(text: string): string {
  return text
    .replace(/[\u2731\u2732\u2733*✱]/g, "") // Remove asterisk/star markers
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Lever ATS Adapter implementation.
 * Handles Lever job applications (https://jobs.lever.co/{company}/{postingId}).
 */
export const leverAdapter: AtsAdapter = {
  name: "lever",

  /**
   * Navigates to the job URL and ensures the application form is visible.
   */
  async openForm(page: Page, jobUrl: string): Promise<void> {
    if (!jobUrl || !jobUrl.startsWith("http")) {
      throw new Error(`Invalid job URL provided to openForm: '${jobUrl}'`);
    }

    await page.goto(jobUrl, { waitUntil: "domcontentloaded" });

    // Lever postings can either be the job description page (with an Apply button)
    // or the direct application form page (typically ending in /apply).
    const formSelector = "#application-form, .application-form, .application-page";
    let isFormVisible = await page.locator(formSelector).first().isVisible().catch(() => false);

    if (!isFormVisible) {
      // Look for the "Apply" / "Apply for this job" button on the posting page
      const applyBtnSelectors = [
        'a.postings-btn[href*="/apply"]',
        '[data-qa="btn-apply"] a',
        'a.template-btn-submit',
        'a:has-text("Apply for this job")',
        'a:has-text("Apply")',
      ];

      let clickedApply = false;
      for (const selector of applyBtnSelectors) {
        const applyBtn = page.locator(selector).first();
        if (await applyBtn.isVisible().catch(() => false)) {
          await applyBtn.click();
          clickedApply = true;
          break;
        }
      }

      if (!clickedApply && !jobUrl.endsWith("/apply")) {
        // Direct navigation fallback if Apply button was not found in the DOM
        const applyUrl = jobUrl.replace(/\/+$/, "") + "/apply";
        await page.goto(applyUrl, { waitUntil: "domcontentloaded" });
      }
    }

    // Wait for the application form container to become visible
    try {
      await page.waitForSelector(formSelector, {
        state: "visible",
        timeout: 15000,
      });
    } catch {
      throw new Error(
        `Failed to open application form: container matching '${formSelector}' was not visible after navigating to '${jobUrl}'.`
      );
    }

    // Wait for network idle to ensure asynchronous form components (surveys, EEO) settle
    try {
      await page.waitForLoadState("networkidle", { timeout: 10000 });
    } catch {
      // Network idle timeout is non-fatal if DOM is already present
    }
  },

  /**
   * Scrapes all fillable form fields inside Lever's application form.
   */
  async readFields(page: Page): Promise<FormField[]> {
    const formLocator = page.locator("#application-form, .application-form").first();
    const formExists = await formLocator.isVisible().catch(() => false);

    if (!formExists) {
      throw new Error(
        "Application form not found on the page. Ensure openForm() was called and resolved successfully."
      );
    }

    // Execute in-browser DOM scraping for high fidelity and performance
    const rawFields = await formLocator.evaluate((form) => {
      const results: Array<{
        id: string;
        label: string;
        type: string;
        required: boolean;
        options?: string[];
      }> = [];

      const processedRadioNames = new Set<string>();

      // Select all potential form inputs
      const elements = Array.from(
        form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
          "input, select, textarea"
        )
      );

      for (const el of elements) {
        const tagName = el.tagName.toLowerCase();
        const inputType = (el.getAttribute("type") || (tagName === "select" ? "select" : tagName === "textarea" ? "textarea" : "text")).toLowerCase();

        // Exclude non-user-fillable or system inputs
        if (
          inputType === "hidden" ||
          inputType === "submit" ||
          inputType === "button" ||
          inputType === "reset" ||
          el.id === "hcaptchaResponseInput" ||
          el.name === "h-captcha-response" ||
          el.classList.contains("hidden") ||
          el.name === "timezone" ||
          el.name === "resumeStorageId" ||
          el.name === "accountId"
        ) {
          continue;
        }

        // Radio buttons are grouped by name attribute
        if (inputType === "radio") {
          const radioName = el.getAttribute("name");
          if (!radioName) continue;
          if (processedRadioNames.has(radioName)) continue;
          processedRadioNames.add(radioName);

          // Find all radios sharing this name
          const groupRadios = Array.from(
            form.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(radioName)}"]`)
          );

          // Find question container & label
          const questionContainer = el.closest(".application-question") || el.closest("li") || el.closest("div");
          let labelText = "";
          let isRequired = false;

          if (questionContainer) {
            const labelEl = questionContainer.querySelector(".application-label, .card-label, label");
            if (labelEl) {
              if (
                labelEl.querySelector(".required, .form-required") ||
                labelEl.textContent?.includes("✱") ||
                labelEl.textContent?.includes("*")
              ) {
                isRequired = true;
              }

              const clone = labelEl.cloneNode(true) as HTMLElement;
              clone.querySelectorAll(".required, .form-required").forEach((s) => s.remove());
              const textEl = clone.querySelector(".text") || clone;
              labelText = textEl.textContent || "";
            }
          }

          if (!labelText) {
            labelText = radioName;
          }

          // Gather all radio options
          const options: string[] = [];
          for (const radio of groupRadios) {
            if (radio.required) isRequired = true;
            // Lever typically has <span class="application-answer-alternative"> or text in parent <label>
            const parentLabel = radio.closest("label");
            const altSpan = parentLabel?.querySelector(".application-answer-alternative, .eeo-option-text");
            const optText = altSpan?.textContent || parentLabel?.textContent || radio.value;
            const cleaned = optText.replace(/\s+/g, " ").trim();
            if (cleaned && !options.includes(cleaned)) {
              options.push(cleaned);
            }
          }

          results.push({
            id: radioName,
            label: labelText.replace(/[\u2731\u2732\u2733*✱]/g, "").replace(/\s+/g, " ").trim(),
            type: "radio",
            required: isRequired,
            options,
          });
          continue;
        }

        // Standard inputs, selects, textareas, checkboxes, files
        const id = el.getAttribute("name") || el.getAttribute("id") || "";
        if (!id) {
          continue;
        }

        // Determine field type
        let mappedType: FieldType = "text";
        if (tagName === "textarea") {
          mappedType = "textarea";
        } else if (tagName === "select") {
          mappedType = "select";
        } else if (inputType === "checkbox") {
          mappedType = "checkbox";
        } else if (inputType === "file") {
          mappedType = "file";
        } else if (inputType === "email") {
          mappedType = "email";
        } else if (inputType === "tel" || id.toLowerCase().includes("phone")) {
          mappedType = "phone";
        } else if (inputType === "number") {
          mappedType = "number";
        } else {
          mappedType = "text";
        }

        // Determine label and required status
        let labelText = "";
        let isRequired = el.hasAttribute("required") || el.getAttribute("aria-required") === "true";
        const questionContainer = el.closest(".application-question") || el.closest("li");

        if (questionContainer) {
          const appLabel = questionContainer.querySelector(".application-label, .card-label");
          if (appLabel) {
            if (
              appLabel.querySelector(".required, .form-required") ||
              appLabel.textContent?.includes("✱") ||
              appLabel.textContent?.includes("*")
            ) {
              isRequired = true;
            }

            const clone = appLabel.cloneNode(true) as HTMLElement;
            clone.querySelectorAll(".required, .form-required").forEach((s) => s.remove());
            const innerText = clone.querySelector(".text") || clone;
            labelText = innerText.textContent || "";
          }
        }

        if (!labelText) {
          const parentLabel = el.closest("label");
          if (parentLabel) {
            const clone = parentLabel.cloneNode(true) as HTMLElement;
            clone.querySelectorAll(".required, .form-required, input, select, textarea").forEach((s) => s.remove());
            labelText = clone.textContent || "";
          }
        }

        if (!labelText && el.id) {
          const explicitLabel = form.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (explicitLabel) {
            const clone = explicitLabel.cloneNode(true) as HTMLElement;
            clone.querySelectorAll(".required, .form-required").forEach((s) => s.remove());
            labelText = clone.textContent || "";
          }
        }

        if (!labelText) {
          labelText = el.getAttribute("placeholder") || el.getAttribute("aria-label") || id;
        }

        if (!isRequired && questionContainer) {
          const labelEl = questionContainer.querySelector(".application-label, .card-label, label");
          if (
            labelEl?.querySelector(".required, .form-required") ||
            labelEl?.textContent?.includes("✱") ||
            labelEl?.textContent?.includes("*")
          ) {
            isRequired = true;
          }
        }

        // Extract options for select elements
        let options: string[] | undefined = undefined;
        if (tagName === "select") {
          const selectEl = el as HTMLSelectElement;
          options = Array.from(selectEl.options)
            .filter((opt) => {
              const val = opt.value.trim();
              const txt = opt.textContent?.trim() || "";
              // Exclude empty or standard placeholder options
              if (!val && !txt) return false;
              if (/^(select|choose\s+one|select\s*\.\.\.)$/i.test(txt)) return false;
              return true;
            })
            .map((opt) => (opt.textContent || opt.value).trim());
        }

        results.push({
          id,
          label: labelText.replace(/[\u2731\u2732\u2733*✱]/g, "").replace(/\s+/g, " ").trim(),
          type: mappedType,
          required: isRequired,
          options,
        });
      }

      return results;
    });

    return rawFields.map((f) => ({
      id: f.id,
      label: normalizeLabel(f.label),
      type: f.type as FieldType,
      required: f.required,
      ...(f.options ? { options: f.options } : {}),
    }));
  },

  /**
   * Fills a FormField with the specified value.
   */
  async fillField(page: Page, field: FormField, value: string): Promise<void> {
    if (!field || !field.id) {
      throw new Error("Invalid FormField provided: field or field.id is missing.");
    }

    const escapedId = escapeCssAttr(field.id);

    // Locate the element using name or id attribute
    const candidateSelectors = [
      `[name="${escapedId}"]`,
      `[id="${escapedId}"]`,
      `[data-qa="${escapedId}"]`,
    ];

    let targetLocator: Locator | null = null;
    for (const sel of candidateSelectors) {
      const loc = page.locator(sel);
      if (await loc.first().count().catch(() => 0) > 0) {
        targetLocator = loc;
        break;
      }
    }

    if (!targetLocator || (await targetLocator.count()) === 0) {
      throw new Error(
        `Field '${field.label}' (id/name: '${field.id}') could not be found in the DOM.`
      );
    }

    switch (field.type) {
      case "text":
      case "email":
      case "phone":
      case "number":
      case "textarea": {
        const inputEl = targetLocator.first();
        const isVisible = await inputEl.isVisible().catch(() => false);
        if (!isVisible && !field.required) {
          // If optional and not visible in the DOM, skip safely
          return;
        }
        await inputEl.scrollIntoViewIfNeeded().catch(() => {});
        await inputEl.fill(value);
        break;
      }

      case "select": {
        const selectEl = targetLocator.first();
        const isVisible = await selectEl.isVisible().catch(() => false);
        if (!isVisible && !field.required) {
          return;
        }
        await selectEl.scrollIntoViewIfNeeded().catch(() => {});

        const targetVal = value.trim().toLowerCase();

        // 1. Try fast label select
        let selected = false;
        try {
          await selectEl.selectOption({ label: value }, { timeout: 1500 });
          selected = true;
        } catch {}

        // 2. Try fast value select
        if (!selected) {
          try {
            await selectEl.selectOption({ value: value }, { timeout: 1500 });
            selected = true;
          } catch {}
        }

        // 3. Evaluate in DOM to match case-insensitively and select option immediately
        if (!selected) {
          selected = await selectEl.evaluate((sel: HTMLSelectElement, target: string) => {
            for (let i = 0; i < sel.options.length; i++) {
              const opt = sel.options[i];
              const optText = opt.text.trim().toLowerCase();
              const optVal = opt.value.trim().toLowerCase();
              if (
                optText === target ||
                optVal === target ||
                optText.includes(target) ||
                (target.length > 3 && optText.startsWith(target.slice(0, 5)))
              ) {
                sel.selectedIndex = i;
                sel.dispatchEvent(new Event("change", { bubbles: true }));
                return true;
              }
            }
            return false;
          }, targetVal).catch(() => false);
        }

        if (!selected && field.required) {
          throw new Error(
            `Option '${value}' could not be selected for field '${field.label}'. Available options: [${(field.options || []).join(", ")}]`
          );
        }
        break;
      }

      case "checkbox": {
        const checkboxEl = targetLocator.first();
        await checkboxEl.scrollIntoViewIfNeeded().catch(() => {});
        const truthy =
          value === "true" ||
          value === "1" ||
          value.toLowerCase() === "yes" ||
          value.toLowerCase() === "checked";

        if (truthy) {
          await checkboxEl.check({ force: true });
        } else {
          await checkboxEl.uncheck({ force: true });
        }
        break;
      }

      case "radio": {
        // In radio groups, multiple inputs share the same name attribute
        const radios = page.locator(`input[type="radio"][name="${escapedId}"]`);
        const count = await radios.count();

        if (count === 0) {
          throw new Error(`Radio group for field '${field.label}' with name '${field.id}' not found.`);
        }

        let selected = false;

        for (let i = 0; i < count; i++) {
          const radio = radios.nth(i);
          const radioVal = await radio.getAttribute("value");

          // Also inspect the label / alternative text adjacent to this radio
          const parentLabel = radio.locator("xpath=ancestor::label[1]");
          const labelText = (await parentLabel.textContent().catch(() => "")) || "";

          if (
            radioVal?.trim().toLowerCase() === value.trim().toLowerCase() ||
            labelText.trim().toLowerCase().includes(value.trim().toLowerCase())
          ) {
            await radio.scrollIntoViewIfNeeded().catch(() => {});
            await radio.check({ force: true });
            selected = true;
            break;
          }
        }

        if (!selected) {
          throw new Error(
            `Could not find radio option matching value '${value}' in field '${field.label}'. Available options: [${(field.options || []).join(", ")}]`
          );
        }
        break;
      }

      case "file": {
        const fileInput = targetLocator.first();
        if (!fs.existsSync(value)) {
          throw new Error(`File not found on disk at path: '${value}' for field '${field.label}'.`);
        }
        await fileInput.setInputFiles(value);
        break;
      }

      default: {
        // Fallback for any other custom types
        const el = targetLocator.first();
        await el.fill(value);
        break;
      }
    }
  },

  /**
   * Uploads the resume file using the resume file input.
   */
  async uploadResume(page: Page, resumePath: string): Promise<void> {
    if (!fs.existsSync(resumePath)) {
      throw new Error(`Resume file not found at path: '${resumePath}'`);
    }

    // Lever uses #resume-upload-input or input[name="resume"]
    const resumeSelectors = [
      "#resume-upload-input",
      'input[type="file"][name="resume"]',
      'input[type="file"][data-qa="input-resume"]',
      'input.application-file-input[type="file"]',
      'input[type="file"]',
    ];

    let fileInputLocator: Locator | null = null;
    for (const selector of resumeSelectors) {
      const locator = page.locator(selector).first();
      if ((await locator.count().catch(() => 0)) > 0) {
        fileInputLocator = locator;
        break;
      }
    }

    if (!fileInputLocator) {
      throw new Error(
        "Resume upload input element (#resume-upload-input / input[name='resume']) not found on the page."
      );
    }

    await fileInputLocator.setInputFiles(resumePath);

    // Wait briefly for Lever's resume parser animation/indicator to settle
    // TODO: Verify on live page if resume upload indicator (.resume-upload-success / .loading-indicator.completed)
    // is required before proceeding or if setInputFiles is sufficient for form submission.
    try {
      await page.waitForSelector(".resume-upload-success, .resume-upload-failure", {
        timeout: 5000,
      });
    } catch {
      // Non-fatal if animation state isn't rendered or is instant
    }
  },

  /**
   * Submits the application form and captures confirmation details.
   */
  async submit(page: Page): Promise<{ confirmationText: string }> {
    // Lever's submit button is typically #btn-submit or .template-btn-submit
    const submitSelectors = [
      "#btn-submit",
      'button[data-qa="btn-submit"]',
      "button.template-btn-submit",
      'button[type="submit"]',
      'input[type="submit"]',
    ];

    let submitButton: Locator | null = null;
    for (const selector of submitSelectors) {
      const btn = page.locator(selector).first();
      if ((await btn.count().catch(() => 0)) > 0 && (await btn.isVisible().catch(() => false))) {
        submitButton = btn;
        break;
      }
    }

    if (!submitButton) {
      throw new Error(
        "Submit button (#btn-submit / button[data-qa='btn-submit']) not found on the application page."
      );
    }

    const currentUrl = page.url();

    // Trigger form submit
    await submitButton.click();

    // Wait for post-submit confirmation: either URL change or confirmation text in the page
    // Lever standard confirmation page typically contains "Thank you" or redirects to /thanks
    const confirmationTargetSelectors = [
      ".application-confirmation",
      ".confirmation-message",
      "#confirmation-result",
      "[data-qa='confirmation-message']",
      ".thank-you",
      ":has-text('Thank you')",
      ":has-text('Application submitted')",
    ];

    // Safely await URL change OR confirmation DOM elements OR captcha prompt (up to 10s)
    const urlPromise = page
      .waitForURL((url) => url.toString() !== currentUrl && !url.toString().includes("#"), {
        timeout: 10000,
      })
      .then(() => "url-changed")
      .catch(() => null);

    const domPromise = page
      .locator(confirmationTargetSelectors.join(", "))
      .first()
      .waitFor({ state: "visible", timeout: 10000 })
      .then(() => "dom-appeared")
      .catch(() => null);

    const captchaPromise = page
      .locator("iframe[src*='hcaptcha'], .h-captcha, #h-captcha, iframe[title*='hCaptcha']")
      .first()
      .waitFor({ state: "visible", timeout: 10000 })
      .then(() => "captcha-appeared")
      .catch(() => null);

    await Promise.race([urlPromise, domPromise, captchaPromise]);

    // Give DOM a brief moment to settle
    await page.waitForTimeout(1000).catch(() => {});

    // 1. Explicitly check whether an hCaptcha challenge is currently visible on the page
    const captchaLocator = page.locator("iframe[src*='hcaptcha'], .h-captcha, #h-captcha, iframe[title*='hCaptcha']");
    const captchaCount = await captchaLocator.count().catch(() => 0);
    for (let i = 0; i < captchaCount; i++) {
      if (await captchaLocator.nth(i).isVisible().catch(() => false)) {
        throw new Error(
          "Submission blocked by hCaptcha challenge — automated solving is not implemented"
        );
      }
    }

    // Check if submission was halted by validation errors
    const errorEl = page.locator(".error-message, .invalid, .form-error").first();
    if (await errorEl.isVisible().catch(() => false)) {
      const errorText = await errorEl.textContent().catch(() => "");
      throw new Error(
        `Form submission failed with validation error: '${errorText?.trim()}'.`
      );
    }

    // 2. Extract confirmation text
    // CRITICAL: ".posting-headline", bare "h2", and bare "h3" were intentionally removed from extractSelectors.
    // They match the pre-existing job title header that is present on the form BEFORE submission,
    // which previously produced false-positive SUBMITTED reports when hCaptcha blocked the submission.
    // Keep only selectors that genuinely and exclusively appear on confirmation pages after a real submission.
    const extractSelectors = [
      ".application-confirmation",
      ".confirmation-message",
      "#confirmation-result h3",
      "#confirmation-result",
      "[data-qa='confirmation-message']",
      ".thank-you",
    ];

    let confirmationText = "";
    for (const sel of extractSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        const text = await el.textContent().catch(() => "");
        if (text && text.trim().length > 0 && !text.includes("Submit your application")) {
          confirmationText = text.trim();
          break;
        }
      }
    }

    // 3. Fallback: if URL changed to a genuine thank-you / confirmation endpoint
    if (!confirmationText && page.url() !== currentUrl && (page.url().includes("thanks") || page.url().includes("confirmation"))) {
      const pageTitle = await page.title().catch(() => "");
      const bodyText = (await page.locator("body").textContent().catch(() => "")) || "";
      confirmationText = pageTitle || bodyText.slice(0, 100).trim() || "Application submitted successfully";
    }

    // 4. If none of the genuine confirmation selectors match AND no captcha is present after timeout,
    // return FAILED rather than guessing SUBMITTED.
    if (!confirmationText) {
      throw new Error("No confirmation detected after submit — outcome unknown");
    }

    return { confirmationText };
  },
};
