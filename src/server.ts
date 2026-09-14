import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { URL } from "node:url";
import { apply, applyResume } from "./engine.js";
import { getAllRuns, getRun } from "./store.js";
import { engineEvents, type EngineEvent } from "./events.js";
import type { Profile } from "./types.js";

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const PUBLIC_DIR = path.join(process.cwd(), "public");

/**
 * Helper to parse JSON request body
 */
function parseJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 5 * 1024 * 1024) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : ({} as T));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Helper to send JSON responses
 */
function sendJson(res: http.ServerResponse, statusCode: number, data: any): void {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

/**
 * Helper to send HTML responses
 */
function sendHtml(res: http.ServerResponse, statusCode: number, html: string): void {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(html);
}

/**
 * Helper to safely stream static files from disk
 */
function serveStaticFile(res: http.ServerResponse, filePath: string): void {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
  };

  const contentType = mimeTypes[ext] || "application/octet-stream";
  const stat = fs.statSync(filePath);

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Cache-Control": "no-cache",
  });

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
}

/**
 * Renders the Mock Lever Job Description page
 */
function getMockLeverPostingHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Senior Full Stack Engineer - Lever Demo</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      max-width: 820px;
      margin: 40px auto;
      padding: 24px;
      line-height: 1.6;
      color: #24292e;
      background: #fafbfc;
    }
    .container {
      background: #ffffff;
      border: 1px solid #e1e4e8;
      border-radius: 8px;
      padding: 36px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.05);
    }
    .header {
      border-bottom: 1px solid #eaecef;
      padding-bottom: 20px;
      margin-bottom: 24px;
    }
    h1 {
      margin: 0 0 8px 0;
      color: #111827;
      font-size: 2rem;
    }
    .posting-categories {
      color: #586069;
      font-size: 0.95rem;
      display: flex;
      gap: 16px;
    }
    .postings-btn {
      display: inline-block;
      background: #0077c5;
      color: #ffffff;
      padding: 12px 24px;
      border-radius: 4px;
      text-decoration: none;
      font-weight: 600;
      margin: 20px 0;
      transition: background 0.2s;
    }
    .postings-btn:hover {
      background: #005a9e;
    }
    .section-title {
      font-size: 1.25rem;
      margin-top: 24px;
      margin-bottom: 12px;
      color: #1f2937;
    }
    ul {
      padding-left: 20px;
      margin-bottom: 20px;
    }
    li {
      margin-bottom: 6px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Senior Full Stack Engineer</h1>
      <div class="posting-categories">
        <span>Engineering</span> &bull; <span>San Francisco, CA / Remote</span> &bull; <span>Full-Time</span>
      </div>
    </div>

    <a href="/mock-ats/lever/apply" class="postings-btn" data-qa="btn-apply">Apply for this job</a>

    <div class="description">
      <div class="section-title">About the Role</div>
      <p>We are building autonomous form orchestration engines. As a Senior Full Stack Engineer, you will design robust, self-healing browser automation pipelines and event-driven interfaces.</p>

      <div class="section-title">Key Responsibilities</div>
      <ul>
        <li>Develop and maintain reliable Playwright browser automation engines.</li>
        <li>Build clean, performant TypeScript architectures with zero runtime crashes.</li>
        <li>Implement streaming, event-driven interfaces with Server-Sent Events.</li>
      </ul>
    </div>

    <div style="margin-top: 32px; border-top: 1px solid #eaecef; padding-top: 20px;">
      <a href="/mock-ats/lever/apply" class="postings-btn" data-qa="btn-apply">Apply for this job</a>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Renders the Mock Lever Application Form page
 */
function getMockLeverApplyHtml(withQuestions: boolean = false): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Apply - Senior Full Stack Engineer | Lever Mock</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      max-width: 780px;
      margin: 40px auto;
      padding: 24px;
      line-height: 1.5;
      color: #24292e;
      background: #f8fafc;
    }
    .form-wrapper {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 36px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.04);
    }
    h1 {
      font-size: 1.75rem;
      margin-top: 0;
      margin-bottom: 8px;
      color: #0f172a;
    }
    .subhead {
      color: #64748b;
      font-size: 0.95rem;
      margin-bottom: 28px;
    }
    .field {
      margin-bottom: 22px;
    }
    label {
      display: block;
      font-weight: 600;
      font-size: 0.88rem;
      margin-bottom: 6px;
      color: #334155;
    }
    .required-star {
      color: #e11d48;
    }
    input[type="text"], input[type="email"], input[type="tel"], input[type="number"], select, textarea {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      font-size: 0.95rem;
      box-sizing: border-box;
      transition: border-color 0.15s;
    }
    input:focus, select:focus, textarea:focus {
      outline: none;
      border-color: #0077c5;
      box-shadow: 0 0 0 3px rgba(0, 119, 197, 0.15);
    }
    textarea {
      min-height: 90px;
      font-family: inherit;
    }
    .radio-option {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
      font-weight: normal;
      cursor: pointer;
    }
    .section-divider {
      border-top: 1px solid #e2e8f0;
      margin: 32px 0 24px 0;
      padding-top: 20px;
    }
    .section-divider h2 {
      font-size: 1.15rem;
      color: #1e293b;
      margin: 0 0 16px 0;
    }
    .btn-submit {
      background: #0077c5;
      color: #ffffff;
      border: none;
      padding: 12px 32px;
      font-size: 1rem;
      font-weight: 600;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .btn-submit:hover {
      background: #005a9e;
    }
    .file-input-wrapper {
      padding: 14px;
      border: 2px dashed #cbd5e1;
      border-radius: 6px;
      background: #f8fafc;
    }
  </style>
</head>
<body>
  <div class="form-wrapper">
    <h1>Submit Your Application</h1>
    <div class="subhead">Senior Full Stack Engineer &bull; Acme Corp</div>

    <form id="application-form" class="application-form" method="POST" action="/mock-ats/lever/apply" enctype="multipart/form-data">
      
      <!-- Resume Upload -->
      <div class="field">
        <label for="resume-upload-input">Resume/CV <span class="required-star">✱</span></label>
        <div class="file-input-wrapper">
          <input type="file" id="resume-upload-input" name="resume" class="application-file-input" required />
        </div>
      </div>

      <!-- Basic Info -->
      <div class="field">
        <label>Full Name <span class="required-star">✱</span></label>
        <input type="text" name="name" required />
      </div>

      <div class="field">
        <label>Email <span class="required-star">✱</span></label>
        <input type="email" name="email" required />
      </div>

      <div class="field">
        <label>Phone <span class="required-star">✱</span></label>
        <input type="tel" name="phone" required />
      </div>

      <div class="field">
        <label>Current Company</label>
        <input type="text" name="org" />
      </div>

      <!-- Links -->
      <div class="field">
        <label>LinkedIn URL</label>
        <input type="text" name="urls[LinkedIn]" placeholder="https://linkedin.com/in/..." />
      </div>

      <div class="field">
        <label>GitHub URL</label>
        <input type="text" name="urls[GitHub]" placeholder="https://github.com/..." />
      </div>

      <div class="field">
        <label>Additional Information</label>
        <textarea name="comments" placeholder="Add any notes or cover letter context here..."></textarea>
      </div>

      ${
        withQuestions
          ? `
      <!-- Additional Screener Questions (Triggers NEEDS_INPUT for Candidate) -->
      <div class="section-divider">
        <h2>Additional Screener Questions</h2>

        <div class="field">
          <label>Years of experience with TypeScript? <span class="required-star">✱</span></label>
          <input type="number" name="cards[typescript_years]" min="0" max="30" required />
        </div>

        <div class="field">
          <label>Notice period (weeks) <span class="required-star">✱</span></label>
          <input type="number" name="cards[notice_period_weeks]" min="0" max="52" required />
        </div>

        <div class="field">
          <label>Are you legally authorized to work in the United States? <span class="required-star">✱</span></label>
          <div style="margin-top: 6px;">
            <label class="radio-option">
              <input type="radio" name="cards[us_work_authorization]" value="Yes" required /> Yes
            </label>
            <label class="radio-option">
              <input type="radio" name="cards[us_work_authorization]" value="No" required /> No
            </label>
          </div>
        </div>
      </div>
      `
          : ""
      }

      <!-- EEO Survey -->
      <div class="section-divider">
        <h2>Voluntary Demographic Survey (EEO)</h2>
        <p style="font-size: 0.85rem; color: #64748b; margin-top: -8px; margin-bottom: 16px;">
          Submission of this information is strictly voluntary. Choosing not to answer will not adversely affect your candidacy.
        </p>

        <div class="field">
          <label>Race / Ethnicity</label>
          <select name="eeo[race]">
            <option value="">Select an option</option>
            <option value="Decline to specify">Decline to specify</option>
            <option value="Asian">Asian</option>
            <option value="White">White</option>
            <option value="Black or African American">Black or African American</option>
            <option value="Hispanic or Latino">Hispanic or Latino</option>
            <option value="Two or More Races">Two or More Races</option>
          </select>
        </div>

        <div class="field">
          <label>Gender Identity</label>
          <select name="eeo[gender]">
            <option value="">Select an option</option>
            <option value="Decline to self-identify">Decline to self-identify</option>
            <option value="Male">Male</option>
            <option value="Female">Female</option>
            <option value="Non-binary">Non-binary</option>
          </select>
        </div>

        <div class="field">
          <label>Veteran Status</label>
          <select name="eeo[veteran]">
            <option value="">Select an option</option>
            <option value="I am not a veteran">I am not a veteran</option>
            <option value="I identify as one or more of the classifications of protected veteran">Protected Veteran</option>
            <option value="I do not wish to self-identify">I do not wish to self-identify</option>
          </select>
        </div>
      </div>

      <div style="margin-top: 32px;">
        <button type="submit" id="btn-submit" class="template-btn-submit btn-submit">Submit Application</button>
      </div>

    </form>
  </div>
</body>
</html>`;
}

/**
 * Renders the Mock Lever Post-Submit Confirmation page
 */
function getMockLeverConfirmationHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Application Submitted | Acme Corp</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      max-width: 600px;
      margin: 80px auto;
      padding: 24px;
      text-align: center;
      background: #f8fafc;
      color: #1e293b;
    }
    .card {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 48px 32px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.06);
    }
    .check-icon {
      width: 64px;
      height: 64px;
      background: #dcfce7;
      color: #16a34a;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 20px;
    }
    .check-icon svg {
      width: 36px;
      height: 36px;
      stroke: currentColor;
      fill: none;
      stroke-width: 3;
    }
    h1 {
      font-size: 1.75rem;
      margin-bottom: 12px;
      color: #0f172a;
    }
    p {
      color: #64748b;
      font-size: 1rem;
      line-height: 1.6;
    }
    .application-confirmation {
      background: #f0fdf4;
      border: 1px solid #bbf7d0;
      padding: 12px 20px;
      border-radius: 6px;
      font-weight: 600;
      color: #166534;
      display: inline-block;
      margin-top: 16px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="check-icon">
      <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>
    </div>
    <h1>Application Received!</h1>
    <p>Thank you for applying to Acme Corp. Our hiring team will review your background and credentials shortly.</p>
    <div class="application-confirmation">
      Application submitted! Thank you for applying.
    </div>
  </div>
</body>
</html>`;
}

/**
 * Main HTTP Request Handler
 */
const server = http.createServer(async (req, res) => {
  const reqUrl = req.url || "/";
  const parsedUrl = new URL(reqUrl, `http://${req.headers.host || "localhost:3000"}`);
  const pathname = parsedUrl.pathname;
  const method = req.method || "GET";

  // Handle CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  try {
    // -------------------------------------------------------------
    // 1. Static Front-End Dashboard (public/index.html)
    // -------------------------------------------------------------
    if ((method === "GET" && pathname === "/") || pathname === "/index.html") {
      const indexPath = path.join(PUBLIC_DIR, "index.html");
      serveStaticFile(res, indexPath);
      return;
    }

    // -------------------------------------------------------------
    // 2. Server-Sent Events (SSE) Stream - Event-Driven, Not Polling!
    // -------------------------------------------------------------
    if (method === "GET" && pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      // Send initial connection event
      res.write(`data: ${JSON.stringify({ type: "connected", timestamp: new Date().toISOString() })}\n\n`);

      const listener = (event: EngineEvent) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      engineEvents.on("event", listener);

      // Keep connection alive with periodic heartbeat
      const pingTimer = setInterval(() => {
        res.write(`: ping\n\n`);
      }, 15000);

      req.on("close", () => {
        clearInterval(pingTimer);
        engineEvents.off("event", listener);
      });

      return;
    }

    // -------------------------------------------------------------
    // 3. API: GET /api/runs (All runs)
    // -------------------------------------------------------------
    if (method === "GET" && pathname === "/api/runs") {
      const runs = getAllRuns();
      sendJson(res, 200, runs);
      return;
    }

    // -------------------------------------------------------------
    // 4. API: GET /api/runs/:id (Single run details)
    // -------------------------------------------------------------
    if (method === "GET" && pathname.startsWith("/api/runs/")) {
      const runId = pathname.replace(/^\/api\/runs\//, "").trim();
      const run = getRun(runId);

      if (!run) {
        sendJson(res, 404, { error: `Run '${runId}' not found.` });
        return;
      }

      sendJson(res, 200, run);
      return;
    }

    // -------------------------------------------------------------
    // 5. API: POST /api/apply (Launch new application)
    // -------------------------------------------------------------
    if (method === "POST" && pathname === "/api/apply") {
      const body = await parseJsonBody<{
        jobUrl: string;
        profile: Profile;
        resumePath?: string;
      }>(req);

      if (!body.jobUrl || !body.profile) {
        sendJson(res, 400, {
          error: "Missing required fields: 'jobUrl' and 'profile' are required.",
        });
        return;
      }

      const resumePath = body.resumePath || path.join(process.cwd(), "sample_resume.pdf");

      console.log(`[Server] Initiating apply for ${body.jobUrl}...`);
      const result = await apply(body.jobUrl, body.profile, resumePath);
      console.log(`[Server] Apply result: ${result.status} (runId: ${result.runId})`);

      sendJson(res, 200, result);
      return;
    }

    // -------------------------------------------------------------
    // 6. API: POST /api/resume (Resume application with answers)
    // -------------------------------------------------------------
    if (method === "POST" && pathname === "/api/resume") {
      const body = await parseJsonBody<{
        runId: string;
        answers: Record<string, string>;
      }>(req);

      if (!body.runId || !body.answers) {
        sendJson(res, 400, {
          error: "Missing required fields: 'runId' and 'answers' are required.",
        });
        return;
      }

      console.log(`[Server] Resuming application for run ${body.runId}...`);
      const result = await applyResume(body.runId, body.answers);
      console.log(`[Server] Resume result: ${result.status}`);

      sendJson(res, 200, result);
      return;
    }

    // -------------------------------------------------------------
    // 7. Mock Lever ATS Pages
    // -------------------------------------------------------------
    if (method === "GET" && pathname === "/mock-ats/lever/posting") {
      sendHtml(res, 200, getMockLeverPostingHtml());
      return;
    }

    if (method === "GET" && pathname === "/mock-ats/lever/apply") {
      const withQuestions = parsedUrl.searchParams.get("withQuestions") === "true";
      sendHtml(res, 200, getMockLeverApplyHtml(withQuestions));
      return;
    }

    if (method === "POST" && pathname === "/mock-ats/lever/apply") {
      // Mock ATS form submit receiver: drain incoming payload and display confirmation
      await parseJsonBody(req).catch(() => {});
      sendHtml(res, 200, getMockLeverConfirmationHtml());
      return;
    }

    // 404 Fallback
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  } catch (error: any) {
    console.error("[Server Error]", error);
    sendJson(res, 500, { error: error.message || "Internal Server Error" });
  }
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Auto-Apply Engine Server listening on http://localhost:${PORT}`);
  console.log(`📊 Dashboard:   http://localhost:${PORT}`);
  console.log(`⚡ SSE Events:  http://localhost:${PORT}/api/events`);
  console.log(`💼 Mock Lever:  http://localhost:${PORT}/mock-ats/lever/posting`);
  console.log(`======================================================\n`);
});
