# Auto-Apply Engine

An autonomous job application engine that fills job application forms across ATS platforms given a candidate profile and resume, pausing to ask the user for anything it cannot confidently fill.

---

## How to Run

### 1. Install Dependencies
```bash
npm install
npx playwright install
```

### 2. Launch the Application
- **Headless Mode (Standard)**:
  ```bash
  npm run dev
  ```
- **Headed Mode (Visible browser with 300ms pacing for screen-recording / demos)**:
  ```bash
  npm run dev:headed
  ```

### 3. Open the Dashboard
Navigate to [http://localhost:3000](http://localhost:3000) in your browser.

### 4. Running Automated Tests
```bash
npm test
```

---

## ATS Platform Support

* **Lever (`jobs.lever.co`)**: **Fully implemented and tested against live production URLs.** Handles form discovery, field extraction across multiple input types (text, email, phone, select dropdowns, radio button groups, checkboxes), file upload, EEO decline defaults, and confirmation detection against both mock ATS servers and live `jobs.lever.co/leverdemo` postings. When Lever's hCaptcha challenge blocked submission, the engine detected the challenge and honestly reported `FAILED` (`"Submission blocked by hCaptcha challenge — automated solving is not implemented"`). Reference implementation: [`src/adapters/lever.ts`](src/adapters/lever.ts).
* **Greenhouse (`job-boards.greenhouse.io` / `boards.greenhouse.io`)**: **Fully implemented and tested against live production URLs.** Supports both direct-hosted boards and iframe-embedded careers portals (`iframe#grnhse_iframe`). Handles modern Remix boards with React-Select dropdowns (`input.select__input`, `.select__control`, `.select__option`) as well as classic Greenhouse `<select>` structures. Includes automatic detection for closed/expired job requisitions that redirect to general career directories, and handles dynamic iframe mount triggers (`button:has-text("Apply now")`). Reference implementation: [`src/adapters/greenhouse.ts`](src/adapters/greenhouse.ts).
* **Ashby / Workable**: The system uses an extensible `AtsAdapter` interface and pluggable registry pattern ([`src/adapters/registry.ts`](src/adapters/registry.ts)). Adding support for Ashby or Workable requires adding a single adapter file conforming to the `AtsAdapter` contract (`openForm`, `readFields`, `fillField`, `uploadResume`, `submit`).

---

## Verified Real-World Results

The engine has been verified end-to-end against live production job postings on both supported ATS platforms. Both runs demonstrate full pause/resume cycles, automatic field mapping, and zero false-positive confirmation reporting:

| Platform | Target Production Posting | Run ID & Artifacts | Discovered / Filled | Outcome & Real-World Finding |
| :--- | :--- | :--- | :--- | :--- |
| **Lever** | `https://jobs.lever.co/leverdemo/...` | [`./recordings/run_1789362039417_bdf4ab93/`](recordings/run_1789362039417_bdf4ab93) | 10 fields (all mapped & filled) | **`FAILED`** (honest) — Blocked by visible hCaptcha challenge. Engine refused false-positive confirmation. Full `.webm` video (1.2 MB) + 15 per-field `.png` screenshots. |
| **Greenhouse** | `https://job-boards.greenhouse.io/databricks/jobs/6918763002` | [`./recordings/run_1789366961916_be472c17/`](recordings/run_1789366961916_be472c17) | 27 fields (14 filled, 13 paused on `NEEDS_INPUT`, resumed via `applyResume`) | **`FAILED`** (honest) — Blocked by reCAPTCHA Enterprise invisible challenge. Engine refused false-positive confirmation. Full `.webm` video (1.5 MB) + 27 per-field `.png` screenshots. |

---

## Architecture & Features

The engine is built around four core components:
1. **Adapter Pattern & Registry**: When a job URL is submitted, `detectAdapter(jobUrl)` in [`src/adapters/registry.ts`](src/adapters/registry.ts) matches the URL hostname and routes execution to the corresponding `AtsAdapter`. Each adapter encapsulates ATS-specific DOM selectors, form navigation, and field extraction logic.
2. **Pause/Resume State Machine**: Candidate data is processed by a pure, zero-fabrication field mapper ([`src/mapper.ts`](src/mapper.ts)). If mandatory screener questions cannot be confidently matched from candidate data, the engine halts state transition at `NEEDS_INPUT`, preserves the active Playwright browser session (`browser`, `context`, `page`) in memory, and returns pending questions. Resuming via `applyResume(runId, answers)` continues execution inside the identical browser page without restarting the session. The full lifecycle transition states are: `CREATED` $\rightarrow$ `RUNNING` $\rightarrow$ `NEEDS_INPUT` (optional pause) $\rightarrow$ `SUBMITTED` or `FAILED` (tracked via `RunRecord` in [`src/store.ts`](src/store.ts)).
3. **Resume Management & Upload API**: Custom PDF resumes can be uploaded dynamically through `POST /api/upload-resume` and fetched via `GET /api/resumes`. Resumes are persisted to `./uploads/` and can be switched dynamically from the dashboard selector or attached via drag-and-drop.
4. **Event-Driven Real-Time Dashboard**: The frontend dashboard never polls the backend for run progress. A persistent Server-Sent Events stream (`GET /api/events`, `Content-Type: text/event-stream`) streams live execution steps (`step`), field fills (`trace`), interactive input requests (`needs_input`), and terminal events (`submitted`, `failed`) directly to the client. Modern, uncluttered interface displays real-time execution histories, field fill receipts, and per-step screenshots.

---

## Known Limitations

* **In-Memory Store & Session Lifecycles**: Application runs and active browser sessions (`activeSessions`) are stored in-memory. If the server restarts while a run is paused on `NEEDS_INPUT`, the open browser session is lost. A production deployment would require distributed session persistence (e.g. remote browser pools via Playwright WebSocket endpoints) or a DOM-replay-from-trace mechanism.
* **Bot Detection & Captchas**: Live ATS forms frequently deploy security challenges (such as hCaptcha, reCAPTCHA Enterprise, or Cloudflare Turnstile). When an interactive or automated challenge prevents submission, the engine honestly detects the condition and terminates with `FAILED`. Automated captcha-bypassing or solver integration is deliberately not implemented.
* **ATS Phone Validation Constraints**: Modern Greenhouse forms using split country-code widgets (`intl-tel-input`) validate input against the selected country code. Supplying a full international prefix into the national phone input field triggers length validation errors; formatting the number as standard national digits is required.
* **ATS Adapter Coverage**: Two of four planned ATS adapters implemented (Lever, Greenhouse); Ashby and Workable follow the exact same interface, not yet written.

---

## Execution Recordings & Artifacts

All run execution artifacts are automatically saved and organized on disk by run ID:
* **Directory**: `./recordings/{runId}/`
* **Contents**:
  - Full execution video recording in `.webm` format (`page@...webm`), captured directly by Playwright context recording.
  - Per-field `.png` screenshot captures recorded immediately after each field is filled and referenced in the run's audit trace array (`screenshotPath`).
  - Terminal confirmation / failure screenshot captures.

