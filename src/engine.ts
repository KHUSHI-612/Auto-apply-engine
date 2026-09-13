import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import * as path from "node:path";
import * as fs from "node:fs";
import type {
  AtsAdapter,
  ApplyResult,
  Profile,
  Question,
  TraceEntry,
} from "./types.js";
import { detectAdapter } from "./adapters/registry.js";
import { createRun, getRun, updateRun, appendTrace } from "./store.js";
import { mapFields, isDemographicQuestion } from "./mapper.js";
import { engineEvents } from "./events.js";

interface ActiveSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  adapter: AtsAdapter;
}

// In-memory sessions map for runs waiting on user input (keyed by runId)
const activeSessions = new Map<string, ActiveSession>();

/**
 * Safely closes browser resources.
 */
async function closeSession(browser?: Browser, context?: BrowserContext, page?: Page): Promise<void> {
  if (page) await page.close().catch(() => {});
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
}

/**
 * Appends an execution trace entry, captures screenshot to recordingDir, and emits an SSE event.
 */
async function traceFill(
  runId: string,
  page: Page,
  recordingDir: string,
  fieldId: string,
  value: string
): Promise<void> {
  const timestamp = new Date().toISOString();
  let screenshotPath: string | undefined;

  try {
    const safeField = fieldId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    const filename = `screenshot_${Date.now()}_${safeField}.png`;
    const fullPath = path.join(recordingDir, filename);
    await page.screenshot({ path: fullPath });
    screenshotPath = fullPath;
  } catch {
    // Non-fatal if screenshot capture fails
  }

  const entry: TraceEntry = {
    field: fieldId,
    value,
    timestamp,
    ...(screenshotPath ? { screenshotPath } : {}),
  };

  appendTrace(runId, entry);

  engineEvents.emitEvent("trace", runId, entry);
}

/**
 * Submits the form, compiles receipt from trace history, marks run SUBMITTED,
 * closes browser session, emits SSE event, and returns the final ApplyResult.
 */
async function submitAndFinalize(
  runId: string,
  adapter: AtsAdapter,
  page: Page,
  browser: Browser,
  context: BrowserContext
): Promise<ApplyResult> {
  try {
    engineEvents.emitEvent("step", runId, { step: "submit", message: "Submitting application form..." });
    const { confirmationText } = await adapter.submit(page);

    const run = getRun(runId);
    if (run?.recordingDir) {
      const confirmScreenshot = path.join(
        run.recordingDir,
        `screenshot_${Date.now()}_confirmation.png`
      );
      await page.screenshot({ path: confirmScreenshot }).catch(() => {});
    }

    // Build receipt: Record<field, value> strictly from traced fills
    const receipt: Record<string, string> = {};
    if (run?.trace) {
      for (const t of run.trace) {
        receipt[t.field] = t.value;
      }
    }

    updateRun(runId, {
      state: "SUBMITTED",
      receipt,
      confirmationText,
    });

    await closeSession(browser, context, page);
    activeSessions.delete(runId);

    engineEvents.emitEvent("submitted", runId, { receipt, confirmationText });

    return {
      status: "SUBMITTED",
      runId,
      receipt,
      confirmationText,
    };
  } catch (err: unknown) {
    await closeSession(browser, context, page);
    activeSessions.delete(runId);

    const errorMessage = err instanceof Error ? err.message : String(err);
    updateRun(runId, {
      state: "FAILED",
      error: errorMessage,
      failedStep: "submit",
    });

    engineEvents.emitEvent("failed", runId, { step: "submit", error: errorMessage });

    return {
      status: "FAILED",
      runId,
      step: "submit",
      error: errorMessage,
    };
  }
}

/**
 * Executes an autonomous job application flow.
 */
export async function apply(
  jobUrl: string,
  profile: Profile,
  resumePdfPath: string
): Promise<ApplyResult> {
  try {
    // 1. Detect ATS Adapter
    let adapter: AtsAdapter;
    try {
      adapter = detectAdapter(jobUrl);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        status: "FAILED",
        step: "detect_adapter",
        error: errorMessage,
      };
    }

    // 2. Initialize run record and emit run_created event
    const run = createRun(jobUrl, adapter.name, profile);
    engineEvents.emitEvent("run_created", run.runId, {
      jobUrl,
      adapterName: adapter.name,
      createdAt: run.createdAt,
    });

    // 3. Launch browser with video recording
    const recordingDir = path.resolve(`./recordings/${run.runId}`);
    fs.mkdirSync(recordingDir, { recursive: true });

    let browser: Browser;
    let context: BrowserContext;
    let page: Page;

    try {
      engineEvents.emitEvent("step", run.runId, { step: "launch_browser", message: "Launching browser..." });

      const isHeaded = process.env.HEADED === "true";
      browser = await chromium.launch({
        headless: isHeaded ? false : true,
        slowMo: isHeaded ? 300 : 0,
      });
      context = await browser.newContext({
        recordVideo: { dir: recordingDir },
      });
      page = await context.newPage();

      updateRun(run.runId, {
        state: "RUNNING",
        recordingDir,
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      updateRun(run.runId, {
        state: "FAILED",
        error: errorMessage,
        failedStep: "launch_browser",
      });
      engineEvents.emitEvent("failed", run.runId, { step: "launch_browser", error: errorMessage });
      return {
        status: "FAILED",
        runId: run.runId,
        step: "launch_browser",
        error: errorMessage,
      };
    }

    // 4. Open form and read fields
    try {
      engineEvents.emitEvent("step", run.runId, { step: "open_form", message: `Opening form at ${jobUrl}...` });
      await adapter.openForm(page, jobUrl);
    } catch (err: unknown) {
      await closeSession(browser, context, page);
      const errorMessage = err instanceof Error ? err.message : String(err);
      updateRun(run.runId, {
        state: "FAILED",
        error: errorMessage,
        failedStep: "open_form",
      });
      engineEvents.emitEvent("failed", run.runId, { step: "open_form", error: errorMessage });
      return {
        status: "FAILED",
        runId: run.runId,
        step: "open_form",
        error: errorMessage,
      };
    }

    let fields;
    try {
      engineEvents.emitEvent("step", run.runId, { step: "read_fields", message: "Extracting form fields..." });
      fields = await adapter.readFields(page);
    } catch (err: unknown) {
      await closeSession(browser, context, page);
      const errorMessage = err instanceof Error ? err.message : String(err);
      updateRun(run.runId, {
        state: "FAILED",
        error: errorMessage,
        failedStep: "read_fields",
      });
      engineEvents.emitEvent("failed", run.runId, { step: "read_fields", error: errorMessage });
      return {
        status: "FAILED",
        runId: run.runId,
        step: "read_fields",
        error: errorMessage,
      };
    }

    // 5. Map fields against profile
    const { filled, missing } = mapFields(fields, profile);

    // 6. Fill confidently matched fields and record traces
    for (const item of filled) {
      try {
        await adapter.fillField(page, item.field, item.value);
        await traceFill(run.runId, page, recordingDir, item.field.id, item.value);
      } catch (err: unknown) {
        await closeSession(browser, context, page);
        const errorMessage = err instanceof Error ? err.message : String(err);
        updateRun(run.runId, {
          state: "FAILED",
          error: errorMessage,
          failedStep: "fill_field",
        });
        engineEvents.emitEvent("failed", run.runId, { step: "fill_field", error: errorMessage });
        return {
          status: "FAILED",
          runId: run.runId,
          step: "fill_field",
          error: `Failed to fill field '${item.field.label}' (${item.field.id}): ${errorMessage}`,
        };
      }
    }

    // 7. Upload resume and record trace
    try {
      engineEvents.emitEvent("step", run.runId, { step: "upload_resume", message: "Uploading resume document..." });
      await adapter.uploadResume(page, resumePdfPath);
      await traceFill(run.runId, page, recordingDir, "resume", resumePdfPath);
    } catch (err: unknown) {
      await closeSession(browser, context, page);
      const errorMessage = err instanceof Error ? err.message : String(err);
      updateRun(run.runId, {
        state: "FAILED",
        error: errorMessage,
        failedStep: "upload_resume",
      });
      engineEvents.emitEvent("failed", run.runId, { step: "upload_resume", error: errorMessage });
      return {
        status: "FAILED",
        runId: run.runId,
        step: "upload_resume",
        error: errorMessage,
      };
    }

    // 8. Handle missing questions & apply EEO-default rule
    const nonFileMissing = missing.filter(
      (q) => q.type !== "file" && q.id !== "resume" && !/^(resume|cv)(\/cv)?$/i.test(q.label.trim())
    );

    const remainingMissing: Question[] = [];

    for (const q of nonFileMissing) {
      if (
        isDemographicQuestion(q.label, q.id) &&
        (q.type === "select" || q.type === "radio" || (q.options && q.options.length > 0))
      ) {
        // EEO/Demographic question: auto-fill with "Decline to state" (or best matching option)
        let declineVal = "Decline to state";
        if (q.options && q.options.length > 0) {
          const matchedOpt = q.options.find(
            (opt) => /decline/i.test(opt) || /not to answer/i.test(opt) || /not wish/i.test(opt)
          );
          if (matchedOpt) declineVal = matchedOpt;
        }

        try {
          await adapter.fillField(page, q, declineVal);
          await traceFill(run.runId, page, recordingDir, q.id, declineVal);
        } catch {
          // If filling EEO default fails and it is required, keep in missing
          if (q.required) remainingMissing.push(q);
        }
      } else if (q.required) {
        remainingMissing.push(q);
      }
    }

    // If any questions are still missing, suspend and wait for user input
    if (remainingMissing.length > 0) {
      updateRun(run.runId, {
        state: "NEEDS_INPUT",
        pendingQuestions: remainingMissing,
      });

      // Keep browser session alive in memory - survives indefinitely until answered
      activeSessions.set(run.runId, {
        browser,
        context,
        page,
        adapter,
      });

      engineEvents.emitEvent("needs_input", run.runId, { questions: remainingMissing });

      return {
        status: "NEEDS_INPUT",
        runId: run.runId,
        questions: remainingMissing,
      };
    }

    // 9. All fields filled: submit and finalize
    return await submitAndFinalize(run.runId, adapter, page, browser, context);
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      status: "FAILED",
      step: "unexpected_error",
      error: errorMessage,
    };
  }
}

/**
 * Resumes an existing run waiting on user input (NEEDS_INPUT state).
 */
export async function applyResume(
  runId: string,
  answers: Record<string, string>
): Promise<ApplyResult> {
  const session = activeSessions.get(runId);
  const run = getRun(runId);

  if (!session || !run) {
    return {
      status: "FAILED",
      runId,
      step: "session_lookup",
      error: `Active browser session for run '${runId}' not found or has expired.`,
    };
  }

  if (run.state !== "NEEDS_INPUT") {
    return {
      status: "FAILED",
      runId,
      step: "invalid_state",
      error: `Run '${runId}' is in state '${run.state}', expected 'NEEDS_INPUT'.`,
    };
  }

  // Validate that all required pending questions are answered
  for (const q of run.pendingQuestions || []) {
    if (q.required && (!answers[q.id] || answers[q.id].trim().length === 0)) {
      return {
        status: "FAILED",
        runId,
        step: "validate_answers",
        error: `Required question '${q.label}' (${q.id}) remains unanswered.`,
      };
    }
  }

  const { browser, context, page, adapter } = session;
  engineEvents.emitEvent("resumed", runId, { answers });

  try {
    const pendingQuestions = run.pendingQuestions || [];

    // Fill each answered field using the active page
    for (const [questionId, value] of Object.entries(answers)) {
      const fieldDef = pendingQuestions.find((q) => q.id === questionId) || {
        id: questionId,
        label: questionId,
        type: "text" as const,
        required: true,
      };

      try {
        await adapter.fillField(page, fieldDef, value);
        const recDir = run.recordingDir || path.resolve(`./recordings/${runId}`);
        await traceFill(runId, page, recDir, questionId, value);
      } catch (err: unknown) {
        await closeSession(browser, context, page);
        activeSessions.delete(runId);

        const errorMessage = err instanceof Error ? err.message : String(err);
        updateRun(runId, {
          state: "FAILED",
          error: errorMessage,
          failedStep: "fill_resumed_field",
        });
        engineEvents.emitEvent("failed", runId, { step: "fill_resumed_field", error: errorMessage });
        return {
          status: "FAILED",
          runId,
          step: "fill_resumed_field",
          error: `Failed to fill field '${fieldDef.label}': ${errorMessage}`,
        };
      }
    }

    // Submit and finalize on the SAME browser page
    return await submitAndFinalize(runId, adapter, page, browser, context);
  } catch (err: unknown) {
    await closeSession(browser, context, page);
    activeSessions.delete(runId);

    const errorMessage = err instanceof Error ? err.message : String(err);
    updateRun(runId, {
      state: "FAILED",
      error: errorMessage,
      failedStep: "resume_submit",
    });
    engineEvents.emitEvent("failed", runId, { step: "resume_submit", error: errorMessage });
    return {
      status: "FAILED",
      runId,
      step: "resume_submit",
      error: errorMessage,
    };
  }
}
