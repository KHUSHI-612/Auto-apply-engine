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

* **Lever (`jobs.lever.co`)**: **Fully implemented and tested.** Handles form discovery, field extraction across multiple input types (text, email, phone, select dropdowns, radio button groups, checkboxes), file upload, EEO decline defaults, and confirmation detection against both mock ATS servers and live `jobs.lever.co/leverdemo` postings. Reference implementation: [`src/adapters/lever.ts`](src/adapters/lever.ts).
* **Greenhouse / Ashby / Workable**: The system uses an extensible `AtsAdapter` interface and pluggable registry pattern ([`src/adapters/registry.ts`](src/adapters/registry.ts)). Adding support for Greenhouse, Ashby, or Workable requires adding a single adapter file conforming to the `AtsAdapter` contract (`openForm`, `readFields`, `fillField`, `uploadResume`, `submit`). These are not yet implemented due to project time constraints.

---

## Architecture Overview

The engine is built around three core architectural components:
1. **Adapter Pattern & Registry**: When a job URL is submitted, `detectAdapter(jobUrl)` in [`src/adapters/registry.ts`](src/adapters/registry.ts) matches the URL hostname and routes execution to the corresponding `AtsAdapter`. Each adapter encapsulates ATS-specific DOM selectors, form navigation, and field extraction logic.
2. **Pause/Resume State Machine**: Candidate data is processed by a pure, zero-fabrication field mapper ([`src/mapper.ts`](src/mapper.ts)). If mandatory screener questions cannot be confidently matched from candidate data, the engine halts state transition at `NEEDS_INPUT`, preserves the active Playwright browser session (`browser`, `context`, `page`) in memory, and returns pending questions. Resuming via `applyResume(runId, answers)` continues execution inside the identical browser page without restarting the session. The full lifecycle transition states are: `CREATED` $\rightarrow$ `RUNNING` $\rightarrow$ `NEEDS_INPUT` (optional pause) $\rightarrow$ `SUBMITTED` or `FAILED` (tracked via `RunRecord` in [`src/store.ts`](src/store.ts)).
3. **Event-Driven Push via SSE**: The frontend dashboard never polls the backend for run progress. A persistent Server-Sent Events stream (`GET /api/events`, `Content-Type: text/event-stream`) streams live execution steps (`step`), field fills (`trace`), interactive input requests (`needs_input`), and terminal events (`submitted`, `failed`) directly to the client.

---

## Known Limitations

* **In-Memory Store & Session Lifecycles**: Application runs and active browser sessions (`activeSessions`) are stored in-memory. If the server restarts while a run is paused on `NEEDS_INPUT`, the open browser session is lost. A production deployment would require distributed session persistence (e.g. remote browser pools via Playwright WebSocket endpoints) or a DOM-replay-from-trace mechanism.
* **Bot Detection & Captchas**: Live ATS forms frequently deploy security challenges (such as hCaptcha or Cloudflare Turnstile). When an interactive captcha puzzle appears, the engine detects the challenge and terminates with `FAILED` (`"Submission blocked by hCaptcha challenge — automated solving is not implemented"`). Automated captcha-bypassing or solver integration is not implemented.
* **Single ATS Adapter Implemented**: Only the Lever adapter is currently active; Greenhouse, Ashby, and Workable adapters follow the exact same interface pattern but remain to be written.

---

## Execution Recordings & Artifacts

All run execution artifacts are automatically saved and organized on disk by run ID:
* **Directory**: `./recordings/{runId}/`
* **Contents**:
  - Full execution video recording in `.webm` format (`page@...webm`), captured directly by Playwright context recording.
  - Per-field `.png` screenshot captures recorded immediately after each field is filled and referenced in the run's audit trace array (`screenshotPath`).
  - Terminal confirmation / failure screenshot captures.
