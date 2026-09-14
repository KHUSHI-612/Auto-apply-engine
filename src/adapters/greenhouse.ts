import type { Page, Frame, Locator } from "playwright";
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
 * Locates the active Greenhouse context (either top-level page or embedded iframe).
 * Greenhouse forms are hosted directly on boards.greenhouse.io / job-boards.greenhouse.io,
 * or embedded inside an iframe (such as grnhse_iframe) on company-hosted careers pages.
 */
async function getGreenhouseContext(page: Page): Promise<Page | Frame> {
  // 1. Check if application form is directly on the top-level page
  const directForm = page.locator("#application-form, form#application_form, form.application--form").first();
  if (await directForm.isVisible().catch(() => false)) {
    return page;
  }

  // 2. Check if embedded inside a known Greenhouse iframe
  const ghFrame = page.frames().find(
    (f) =>
      f.name() === "grnhse_iframe" ||
      f.url().includes("greenhouse.io") ||
      f.url().includes("job_app")
  );

  if (ghFrame) {
    return ghFrame;
  }

  // 3. Fall back to frameElement handle if frame was not in page.frames() yet
  const iframeLocator = page.locator("iframe#grnhse_iframe, iframe[src*='greenhouse.io'], iframe[src*='job_app']").first();
  if ((await iframeLocator.count().catch(() => 0)) > 0) {
    const handle = await iframeLocator.elementHandle().catch(() => null);
    const contentFrame = await handle?.contentFrame().catch(() => null);
    if (contentFrame) {
      return contentFrame;
    }
  }

  // 4. Fall back to top-level page
  return page;
}

/**
 * Greenhouse ATS Adapter implementation.
 * Handles Greenhouse application forms (https://job-boards.greenhouse.io/{company}/jobs/{id}
 * and https://boards.greenhouse.io/{company}/jobs/{id}).
 */
export const greenhouseAdapter: AtsAdapter = {
  name: "greenhouse",

  /**
   * Navigates to the job URL and ensures the Greenhouse application form is visible.
   */
  async openForm(page: Page, jobUrl: string): Promise<void> {
    if (!jobUrl || !jobUrl.startsWith("http")) {
      throw new Error(`Invalid job URL provided to openForm: '${jobUrl}'`);
    }

    await page.goto(jobUrl, { waitUntil: "domcontentloaded" });

    // Greenhouse postings can be standalone pages or embedded in company career portals.
    // If the form is embedded in an iframe (e.g. grnhse_iframe), wait for either form or iframe.
    const formSelector = "#application-form, form#application_form, form.application--form";
    const iframeSelector = "iframe#grnhse_iframe, iframe[src*='greenhouse.io'], iframe[src*='job_app']";

    // Wait for either the application form or the Greenhouse iframe to be attached
    try {
      await Promise.race([
        page.waitForSelector(formSelector, { state: "visible", timeout: 15000 }),
        page.waitForSelector(iframeSelector, { state: "attached", timeout: 15000 }),
      ]);
    } catch {
      // Non-fatal, check for Apply button next
    }

    let isFormVisible = await page.locator(formSelector).first().isVisible().catch(() => false);
    let hasIframe = (await page.locator(iframeSelector).count().catch(() => 0)) > 0;

    if (!isFormVisible && !hasIframe) {
      // Look for an "Apply" / "Apply now" button on the posting page
      const applyBtnSelectors = [
        'a[href*="#app"]',
        'a[href*="/apply"]',
        'a:has-text("Apply now")',
        'a:has-text("Apply for this job")',
        'a:has-text("Apply")',
        'button:has-text("Apply now")',
        'button:has-text("Apply")',
      ];

      for (const selector of applyBtnSelectors) {
        const applyBtn = page.locator(selector).first();
        if (await applyBtn.isVisible().catch(() => false)) {
          await applyBtn.click();
          break;
        }
      }
    }

    // Scroll any embedded Greenhouse iframe into viewport so it renders and receives events
    const iframeLocator = page.locator(iframeSelector).first();
    if ((await iframeLocator.count().catch(() => 0)) > 0) {
      await iframeLocator.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForSelector(iframeSelector, { state: "attached", timeout: 15000 }).catch(() => {});
    }

    const context = await getGreenhouseContext(page);

    // Wait for the application form container to become visible in the active context
    try {
      await context.waitForSelector(formSelector, {
        state: "visible",
        timeout: 15000,
      });
    } catch {
      throw new Error(
        `Failed to open application form: container matching '${formSelector}' was not visible after navigating to '${jobUrl}'.`
      );
    }

    // Wait for the initial input to mount (ensuring Remix / client hydration is complete)
    await context.waitForSelector(
      "#first_name, #job_application_first_name, input[name*='first_name'], input[type='file']",
      { state: "visible", timeout: 15000 }
    ).catch(() => {});

    // Wait for network idle to allow custom select and async components to settle
    try {
      await page.waitForLoadState("networkidle", { timeout: 10000 });
    } catch {
      // Network idle timeout is non-fatal if DOM is already present
    }
  },

  /**
   * Scrapes all fillable form fields inside Greenhouse's application form.
   */
  async readFields(page: Page): Promise<FormField[]> {
    const context = await getGreenhouseContext(page);
    const formLocator = context.locator("#application-form, form#application_form, form.application--form").first();
    const formExists = await formLocator.isVisible().catch(() => false);

    if (!formExists) {
      throw new Error(
        "Application form not found on the page. Ensure openForm() was called and resolved successfully."
      );
    }

    // Execute in-browser DOM scraping across both classic Greenhouse and modern Remix boards
    const rawFields = await formLocator.evaluate((form) => {
      const results: Array<{
        id: string;
        label: string;
        type: string;
        required: boolean;
        options?: string[];
      }> = [];

      const processedRadioNames = new Set<string>();
      const processedCheckboxNames = new Set<string>();

      // Select all candidate inputs, selects, textareas inside the Greenhouse form
      const elements = Array.from(
        form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
          "input, select, textarea"
        )
      );

      for (const el of elements) {
        const tagName = el.tagName.toLowerCase();
        const inputType = (
          el.getAttribute("type") ||
          (tagName === "select" ? "select" : tagName === "textarea" ? "textarea" : "text")
        ).toLowerCase();

        // Exclude system, hidden, submit, or internal token inputs
        if (
          inputType === "hidden" ||
          inputType === "submit" ||
          inputType === "button" ||
          inputType === "reset" ||
          el.classList.contains("hidden") ||
          el.id === "authenticity_token" ||
          el.name === "authenticity_token" ||
          el.name === "utf8" ||
          el.name === "validityToken" ||
          el.classList.contains("remix-css-1a0ro4n-requiredInput") // internal proxy input in Remix
        ) {
          continue;
        }

        // Radio buttons grouped by name
        if (inputType === "radio") {
          const radioName = el.getAttribute("name");
          if (!radioName) continue;
          if (processedRadioNames.has(radioName)) continue;
          processedRadioNames.add(radioName);

          const groupRadios = Array.from(
            form.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(radioName)}"]`)
          );

          const questionContainer =
            el.closest(".field-wrapper") ||
            el.closest(".application-question") ||
            el.closest(".field") ||
            el.closest("fieldset") ||
            el.closest("div");

          let labelText = "";
          let isRequired = false;

          if (questionContainer) {
            const labelEl = questionContainer.querySelector("legend, label, .label");
            if (labelEl) {
              if (
                labelEl.querySelector(".required, [aria-hidden='true']")?.textContent?.includes("*") ||
                labelEl.textContent?.includes("*") ||
                labelEl.textContent?.includes("✱")
              ) {
                isRequired = true;
              }
              const clone = labelEl.cloneNode(true) as HTMLElement;
              clone.querySelectorAll(".required, [aria-hidden='true']").forEach((s) => s.remove());
              labelText = clone.textContent || "";
            }
          }

          if (!labelText) {
            labelText = radioName;
          }

          const options: string[] = [];
          for (const radio of groupRadios) {
            if (radio.required) isRequired = true;
            const parentLabel = radio.closest("label");
            const optText = parentLabel?.textContent || radio.value;
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

        // Checkbox groups sharing a name (e.g. question_...[])
        const cbName = el.getAttribute("name");
        const isCheckboxGroup =
          inputType === "checkbox" &&
          cbName &&
          (cbName.endsWith("[]") ||
            form.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(cbName)}"]`).length > 1);

        if (isCheckboxGroup && cbName) {
          if (processedCheckboxNames.has(cbName)) continue;
          processedCheckboxNames.add(cbName);

          const groupCheckboxes = Array.from(
            form.querySelectorAll<HTMLInputElement>(`input[type="checkbox"][name="${CSS.escape(cbName)}"]`)
          );

          const fieldset =
            el.closest("fieldset.checkbox") ||
            el.closest(".field-wrapper") ||
            el.closest(".field") ||
            el.closest("fieldset");
          const legendEl = fieldset?.querySelector("legend, label.checkbox__description, .label");

          let labelText = "";
          let isRequired = fieldset?.getAttribute("aria-required") === "true";

          if (legendEl) {
            if (
              legendEl.textContent?.includes("*") ||
              legendEl.querySelector(".required, [aria-hidden='true']")?.textContent?.includes("*")
            ) {
              isRequired = true;
            }
            const clone = legendEl.cloneNode(true) as HTMLElement;
            clone.querySelectorAll(".required, [aria-hidden='true']").forEach((s) => s.remove());
            labelText = clone.textContent || "";
          }

          if (!labelText) {
            labelText = cbName;
          }

          const options: string[] = [];
          for (const cb of groupCheckboxes) {
            if (cb.required) isRequired = true;
            let optText = "";
            if (cb.id) {
              const explicit = form.querySelector(`label[for="${CSS.escape(cb.id)}"]`);
              optText = explicit?.textContent?.trim() || "";
            }
            if (!optText) {
              const parentLabel = cb.closest("label");
              optText = parentLabel?.textContent?.trim() || "";
            }
            if (!optText) {
              optText = cb.value;
            }
            const cleaned = optText.replace(/\s+/g, " ").trim();
            if (cleaned && !options.includes(cleaned)) {
              options.push(cleaned);
            }
          }

          results.push({
            id: cbName,
            label: labelText.replace(/[\u2731\u2732\u2733*✱]/g, "").replace(/\s+/g, " ").trim(),
            type: "checkbox",
            required: isRequired,
            options,
          });
          continue;
        }

        // Standard inputs, selects, textareas, checkboxes, files
        const id = el.getAttribute("id") || el.getAttribute("name") || "";
        if (!id) {
          continue;
        }

        // Check if element is a modern Greenhouse react-select combobox
        const isReactSelect = el.classList.contains("select__input") || el.getAttribute("role") === "combobox";

        let mappedType: FieldType = "text";
        if (tagName === "textarea") {
          mappedType = "textarea";
        } else if (tagName === "select" || isReactSelect) {
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

        // Determine question label and required status
        let labelText = "";
        let isRequired =
          el.hasAttribute("required") ||
          el.getAttribute("aria-required") === "true";

        const questionContainer =
          el.closest(".field-wrapper") ||
          el.closest(".application-question") ||
          el.closest(".field") ||
          el.closest(".select__container") ||
          el.closest(".text-input-wrapper") ||
          el.closest("div");

        if (questionContainer) {
          const appLabel = questionContainer.querySelector("label, .label, legend");
          if (appLabel) {
            if (
              appLabel.textContent?.includes("*") ||
              appLabel.textContent?.includes("✱") ||
              appLabel.querySelector("[aria-hidden='true']")?.textContent?.includes("*")
            ) {
              isRequired = true;
            }

            const clone = appLabel.cloneNode(true) as HTMLElement;
            clone.querySelectorAll("[aria-hidden='true'], .required").forEach((s) => s.remove());
            labelText = clone.textContent || "";
          }
        }

        if (!labelText && el.id) {
          const explicitLabel = form.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (explicitLabel) {
            const clone = explicitLabel.cloneNode(true) as HTMLElement;
            clone.querySelectorAll("[aria-hidden='true'], .required").forEach((s) => s.remove());
            labelText = clone.textContent || "";
          }
        }

        if (!labelText) {
          labelText = el.getAttribute("aria-label") || el.getAttribute("placeholder") || id;
        }

        // Extract options for native <select> elements
        let options: string[] | undefined = undefined;
        if (tagName === "select") {
          const selectEl = el as HTMLSelectElement;
          options = Array.from(selectEl.options)
            .filter((opt) => {
              const val = opt.value.trim();
              const txt = opt.textContent?.trim() || "";
              if (!val && !txt) return false;
              if (/^(select|please\s+select|choose\s+one|select\s*\.\.\.)$/i.test(txt)) return false;
              return true;
            })
            .map((opt) => (opt.textContent || opt.value).trim());
        }

        // TODO: For modern Greenhouse react-select dropdowns, options are rendered on flyout open.
        // Option choices can be dynamically discovered or answered by mapper during fillField.

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
   * Fills a FormField with the specified value inside Greenhouse.
   */
  async fillField(page: Page, field: FormField, value: string): Promise<void> {
    if (!field || !field.id) {
      throw new Error("Invalid FormField provided: field or field.id is missing.");
    }

    const context = await getGreenhouseContext(page);
    const escapedId = escapeCssAttr(field.id);

    // Candidates matching classic and modern Greenhouse DOM patterns
    const candidateSelectors = [
      `[id="${escapedId}"]`,
      `[name="${escapedId}"]`,
      `input#job_application_${escapedId}`,
      `select#job_application_${escapedId}`,
      `textarea#job_application_${escapedId}`,
      `#job_application_answers_attributes_${escapedId}`,
      `[data-qa="${escapedId}"]`,
    ];

    let targetLocator: Locator | null = null;
    for (const sel of candidateSelectors) {
      const loc = context.locator(sel);
      if ((await loc.first().count().catch(() => 0)) > 0) {
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
          return;
        }
        await inputEl.scrollIntoViewIfNeeded().catch(() => {});
        await inputEl.fill(value);
        break;
      }

      case "select": {
        const selectEl = targetLocator.first();
        await selectEl.scrollIntoViewIfNeeded().catch(() => {});

        const tagName = await selectEl.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
        const isReactSelect = await selectEl.evaluate(
          (el) => el.classList.contains("select__input") || el.getAttribute("role") === "combobox"
        ).catch(() => false);

        if (tagName === "select") {
          // Standard HTML <select> dropdown (classic Greenhouse)
          let selected = false;
          try {
            await selectEl.selectOption({ label: value }, { timeout: 1500 });
            selected = true;
          } catch {}

          if (!selected) {
            try {
              await selectEl.selectOption({ value: value }, { timeout: 1500 });
              selected = true;
            } catch {}
          }

          if (!selected) {
            selected = await selectEl.evaluate((sel: HTMLSelectElement, target: string) => {
              const lower = target.trim().toLowerCase();
              for (let i = 0; i < sel.options.length; i++) {
                const opt = sel.options[i];
                const optText = opt.text.trim().toLowerCase();
                const optVal = opt.value.trim().toLowerCase();
                if (optText === lower || optVal === lower || optText.includes(lower)) {
                  sel.selectedIndex = i;
                  sel.dispatchEvent(new Event("change", { bubbles: true }));
                  return true;
                }
              }
              return false;
            }, value).catch(() => false);
          }

          if (!selected && field.required) {
            throw new Error(
              `Option '${value}' could not be selected for field '${field.label}'. Available options: [${(field.options || []).join(", ")}]`
            );
          }
        } else if (isReactSelect) {
          // Modern Greenhouse Remix react-select dropdown
          const control = selectEl.locator("xpath=ancestor::div[contains(@class, 'select__control')][1]");
          if (await control.isVisible().catch(() => false)) {
            await control.click();
          } else {
            await selectEl.click();
          }

          await page.waitForTimeout(300);

          // Find option in the opened react-select menu
          const optionSelector = ".select__option, [role='option'], div[id*='-option-']";
          const optionCandidates = context.locator(optionSelector);
          const optionCount = await optionCandidates.count().catch(() => 0);

          let chosen = false;
          const targetLower = value.trim().toLowerCase();

          for (let i = 0; i < optionCount; i++) {
            const opt = optionCandidates.nth(i);
            const optText = (await opt.textContent().catch(() => ""))?.trim() || "";
            if (optText.toLowerCase() === targetLower || optText.toLowerCase().includes(targetLower)) {
              await opt.click();
              chosen = true;
              break;
            }
          }

          // Fallback: if value was asking to decline/opt-out, search for any decline/opt-out option in the list
          if (!chosen && /decline|not to answer|not wish|prefer not/i.test(value)) {
            for (let i = 0; i < optionCount; i++) {
              const opt = optionCandidates.nth(i);
              const optText = (await opt.textContent().catch(() => ""))?.trim() || "";
              if (/decline|not to answer|not wish|prefer not/i.test(optText)) {
                await opt.click();
                chosen = true;
                break;
              }
            }
          }

          if (!chosen) {
            // Close the opened react-select menu cleanly with Escape
            await page.keyboard.press("Escape").catch(() => {});
          }
        }
        break;
      }

      case "checkbox": {
        // 1. Check if there is a group of checkboxes sharing this name (e.g. question_...[])
        const groupCheckboxes = context.locator(`input[type="checkbox"][name="${escapedId}"]`);
        const groupCount = await groupCheckboxes.count().catch(() => 0);

        if (groupCount > 1) {
          const targetValues = value.split(",").map((v) => v.trim().toLowerCase());
          let anyMatched = false;

          for (let i = 0; i < groupCount; i++) {
            const cb = groupCheckboxes.nth(i);
            const cbId = await cb.getAttribute("id");
            let optionText = "";
            if (cbId) {
              const labelEl = context.locator(`label[for="${escapeCssAttr(cbId)}"]`);
              optionText = (await labelEl.textContent().catch(() => ""))?.trim() || "";
            }
            if (!optionText) {
              const parentLabel = cb.locator("xpath=ancestor::label[1]");
              optionText = (await parentLabel.textContent().catch(() => ""))?.trim() || "";
            }

            const lowerOpt = optionText.toLowerCase();
            const shouldCheck = targetValues.some(
              (v) => v === lowerOpt || lowerOpt.includes(v) || (v.length > 5 && lowerOpt.startsWith(v.slice(0, 10)))
            );

            if (shouldCheck) {
              const isChecked = await cb.isChecked().catch(() => false);
              if (!isChecked) {
                let clicked = false;
                if (cbId) {
                  const labelEl = context.locator(`label[for="${escapeCssAttr(cbId)}"]`);
                  if (await labelEl.isVisible().catch(() => false)) {
                    await labelEl.scrollIntoViewIfNeeded().catch(() => {});
                    await labelEl.click();
                    clicked = true;
                  }
                }
                if (!clicked) {
                  await cb.scrollIntoViewIfNeeded().catch(() => {});
                  await cb.click({ force: true });
                }
              }
              anyMatched = true;
            } else {
              const isChecked = await cb.isChecked().catch(() => false);
              if (isChecked) {
                let clicked = false;
                if (cbId) {
                  const labelEl = context.locator(`label[for="${escapeCssAttr(cbId)}"]`);
                  if (await labelEl.isVisible().catch(() => false)) {
                    await labelEl.scrollIntoViewIfNeeded().catch(() => {});
                    await labelEl.click();
                    clicked = true;
                  }
                }
                if (!clicked) {
                  await cb.scrollIntoViewIfNeeded().catch(() => {});
                  await cb.click({ force: true });
                }
              }
            }
          }

          if (!anyMatched) {
            // If value is truthy (e.g. "yes", "true") and no specific option text was given,
            // select the safe non-conflicting default like "None of the above" or "Not applicable" if available
            let chosenIndex = 0;
            for (let i = 0; i < groupCount; i++) {
              const cb = groupCheckboxes.nth(i);
              const cbId = await cb.getAttribute("id");
              const labelText = cbId
                ? (await context.locator(`label[for="${escapeCssAttr(cbId)}"]`).textContent().catch(() => "")) || ""
                : "";
              if (/none of the above|not applicable|none of these/i.test(labelText)) {
                chosenIndex = i;
                break;
              }
            }
            const chosenCb = groupCheckboxes.nth(chosenIndex);
            const chosenId = await chosenCb.getAttribute("id");
            const isChecked = await chosenCb.isChecked().catch(() => false);
            if (!isChecked) {
              let clicked = false;
              if (chosenId) {
                const labelEl = context.locator(`label[for="${escapeCssAttr(chosenId)}"]`);
                if (await labelEl.isVisible().catch(() => false)) {
                  await labelEl.scrollIntoViewIfNeeded().catch(() => {});
                  await labelEl.click();
                  clicked = true;
                }
              }
              if (!clicked) {
                await chosenCb.scrollIntoViewIfNeeded().catch(() => {});
                await chosenCb.click({ force: true });
              }
            }
          }

          // In HTML5 checkbox groups: when at least one option is checked, remove the required
          // attribute from the unchecked siblings in the group so browser validation passes
          await context.evaluate((name) => {
            const cbs = Array.from(
              document.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(name)}"]`)
            ) as HTMLInputElement[];
            const hasChecked = cbs.some((c) => c.checked);
            if (hasChecked) {
              cbs.forEach((c) => {
                if (!c.checked) {
                  c.required = false;
                  c.removeAttribute("required");
                }
              });
            }
          }, field.id).catch(() => {});
          break;
        }

        // 2. Standalone checkbox (e.g. consent, terms)
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
        const radios = context.locator(`input[type="radio"][name="${escapedId}"]`);
        const count = await radios.count();

        if (count === 0) {
          throw new Error(`Radio group for field '${field.label}' with name '${field.id}' not found.`);
        }

        let selected = false;
        for (let i = 0; i < count; i++) {
          const radio = radios.nth(i);
          const radioVal = await radio.getAttribute("value");
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
        const el = targetLocator.first();
        await el.fill(value);
        break;
      }
    }
  },

  /**
   * Uploads the resume file using Greenhouse's resume file input.
   */
  async uploadResume(page: Page, resumePath: string): Promise<void> {
    if (!fs.existsSync(resumePath)) {
      throw new Error(`Resume file not found at path: '${resumePath}'`);
    }

    const context = await getGreenhouseContext(page);

    // Greenhouse resume file input selectors (confirmed on Databricks & classic Greenhouse)
    const resumeSelectors = [
      'input#resume[type="file"]',
      'input#job_application_resume[type="file"]',
      'input[type="file"][accept*="pdf"]',
      'input[type="file"][name*="resume"]',
      'input[type="file"]',
    ];

    let fileInputLocator: Locator | null = null;
    for (const selector of resumeSelectors) {
      const locator = context.locator(selector).first();
      if ((await locator.count().catch(() => 0)) > 0) {
        fileInputLocator = locator;
        break;
      }
    }

    if (!fileInputLocator) {
      throw new Error(
        "Resume upload input element (#resume / #job_application_resume) not found on the page."
      );
    }

    await fileInputLocator.setInputFiles(resumePath);

    // TODO: Verify on live submission whether Greenhouse displays an attachment indicator
    // (e.g. .file-upload__file-name or [data-testid='resume-file-name']) that must be waited on.
    try {
      await context.waitForSelector(".file-upload__file-name, [data-testid='resume-file-name'], .attachment-name", {
        timeout: 5000,
      });
    } catch {
      // Non-fatal if upload progress is instant or headless
    }
  },

  /**
   * Submits the Greenhouse application form and captures confirmation details.
   */
  async submit(page: Page): Promise<{ confirmationText: string }> {
    const context = await getGreenhouseContext(page);

    // Submit button selectors confirmed on modern Remix boards & classic Greenhouse
    const submitSelectors = [
      'button[type="submit"]:has-text("Submit application")',
      'button#submit_app',
      'input#submit_app',
      'button.btn--rectangle:has-text("Submit")',
      'input[type="submit"][value*="Submit"]',
      'button[type="submit"]',
    ];

    let submitButton: Locator | null = null;
    for (const selector of submitSelectors) {
      const btn = context.locator(selector).first();
      if ((await btn.count().catch(() => 0)) > 0 && (await btn.isVisible().catch(() => false))) {
        submitButton = btn;
        break;
      }
    }

    if (!submitButton) {
      throw new Error(
        "Submit button (button[type='submit'] / #submit_app) not found on the application page."
      );
    }

    const currentUrl = page.url();

    // Ensure all checked checkbox groups don't have unchecked siblings with required="" blocking form validation
    await context.evaluate(() => {
      const fieldsets = Array.from(document.querySelectorAll("fieldset.checkbox, fieldset"));
      fieldsets.forEach((fs) => {
        const cbs = Array.from(fs.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
        if (cbs.some((c) => c.checked)) {
          cbs.forEach((c) => {
            if (!c.checked) {
              c.required = false;
              c.removeAttribute("required");
            }
          });
        }
      });
    }).catch(() => {});

    // Trigger form submit
    await submitButton.click();

    // Selectors indicating genuine post-submission confirmation on Greenhouse
    const confirmationTargetSelectors = [
      "#application_confirmation",
      ".application-confirmation",
      "#confirmation-result",
      "[data-qa='confirmation']",
      ".thank-you",
      ":has-text('Thank you for applying')",
      ":has-text('Application submitted')",
    ];

    // Safely await URL change OR confirmation DOM elements OR captcha prompt (up to 10s)
    const urlPromise = page
      .waitForURL((url) => url.toString() !== currentUrl && !url.toString().includes("#"), {
        timeout: 10000,
      })
      .then(() => "url-changed")
      .catch(() => null);

    const domPromise = context
      .locator(confirmationTargetSelectors.join(", "))
      .first()
      .waitFor({ state: "visible", timeout: 10000 })
      .then(() => "dom-appeared")
      .catch(() => null);

    const captchaPromise = page
      .locator("iframe[src*='recaptcha'], .g-recaptcha, iframe[src*='hcaptcha'], .h-captcha, iframe[src*='challenges.cloudflare']")
      .first()
      .waitFor({ state: "visible", timeout: 10000 })
      .then(() => "captcha-appeared")
      .catch(() => null);

    await Promise.race([urlPromise, domPromise, captchaPromise]);

    // Give DOM a brief moment to settle
    await page.waitForTimeout(1000).catch(() => {});

    // 1. Explicitly check whether a reCAPTCHA/hCaptcha challenge is currently visible on the page
    const captchaLocator = page.locator(
      "iframe[src*='recaptcha'], .g-recaptcha, iframe[src*='hcaptcha'], .h-captcha, iframe[src*='challenges.cloudflare']"
    );
    const captchaCount = await captchaLocator.count().catch(() => 0);
    for (let i = 0; i < captchaCount; i++) {
      if (await captchaLocator.nth(i).isVisible().catch(() => false)) {
        throw new Error(
          "Submission blocked by captcha challenge — automated solving is not implemented"
        );
      }
    }

    // 2. Check if submission was blocked by validation errors
    const errorLocator = context.locator(".error, .field-error, .invalid, [class*='errorMessage'], [id*='-error']");
    const errorCount = await errorLocator.count().catch(() => 0);
    const visibleErrors: string[] = [];
    for (let i = 0; i < errorCount; i++) {
      const el = errorLocator.nth(i);
      if (await el.isVisible().catch(() => false)) {
        const info = await el.evaluate((node) => ({
          tag: node.tagName,
          id: node.id,
          className: node.className,
          text: node.textContent?.trim(),
          parent: node.parentElement?.id || node.parentElement?.className,
        })).catch(() => null);
        if (info && info.text) {
          visibleErrors.push(`[${info.id || info.className || info.tag}] ${info.text}`);
        }
      }
    }

    if (visibleErrors.length > 0) {
      throw new Error(
        `Form submission failed with validation error: ${visibleErrors.join(" | ")}.`
      );
    }

    // 3. Extract confirmation text
    const extractSelectors = [
      "#application_confirmation h1",
      "#application_confirmation h2",
      "#application_confirmation",
      ".application-confirmation",
      "#confirmation-result h3",
      "#confirmation-result",
      "[data-qa='confirmation']",
      ".thank-you",
    ];

    let confirmationText = "";
    for (const sel of extractSelectors) {
      const el = context.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        const text = await el.textContent().catch(() => "");
        if (text && text.trim().length > 0 && !text.includes("Submit application")) {
          confirmationText = text.trim();
          break;
        }
      }
    }

    // 4. Fallback: if URL changed to a genuine thank-you / confirmation endpoint
    if (
      !confirmationText &&
      page.url() !== currentUrl &&
      (page.url().includes("thanks") || page.url().includes("confirmation") || page.url().includes("applied"))
    ) {
      const pageTitle = await page.title().catch(() => "");
      const bodyText = (await page.locator("body").textContent().catch(() => "")) || "";
      confirmationText = pageTitle || bodyText.slice(0, 100).trim() || "Application submitted successfully";
    }

    // 5. If none of the confirmation selectors match and no captcha is present after timeout,
    // return FAILED rather than guessing SUBMITTED.
    if (!confirmationText) {
      throw new Error("No confirmation detected after submit — outcome unknown");
    }

    return { confirmationText };
  },
};
