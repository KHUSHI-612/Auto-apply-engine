import type { Page } from "playwright";

export type FieldType =
  | "text"
  | "textarea"
  | "email"
  | "phone"
  | "select"   // dropdown -> has `options`
  | "radio"    // yes/no or multi-choice -> has `options`
  | "checkbox"
  | "file"     // resume upload
  | "number";

export interface FormField {
  id: string;            // unique id/name attribute on the page, used to fill it back
  label: string;          // the human-readable question, e.g. "Notice period (weeks)"
  type: FieldType;
  required: boolean;
  options?: string[];     // only present for select/radio
}

export interface Question extends FormField {
  note?: string;
}

export interface SocialProfile {
  network: string;
  url: string;
}

export interface WorkExperience {
  company: string;
  jobTitle: string;
  current?: boolean;
  startDate?: string;
  endDate?: string;
  description?: string;
}

export interface Education {
  school: string;
  degree: string;
  fieldOfStudy?: string;
  graduationYear?: string | number;
}

export interface PersonalInfo {
  fullName: string;
  firstName?: string;
  lastName?: string;
  email: string;
  phone: string;
  location?: string;
}

export interface Profile {
  personalInfo: PersonalInfo;
  profiles?: SocialProfile[];
  experience?: WorkExperience[];
  education?: Education[];
  answersBank?: Record<string, string>;
}

export interface AtsAdapter {
  name: string;
  openForm(page: Page, jobUrl: string): Promise<void>;
  readFields(page: Page): Promise<FormField[]>;
  fillField(page: Page, field: FormField, value: string): Promise<void>;
  uploadResume(page: Page, resumePath: string): Promise<void>;
  submit(page: Page): Promise<{ confirmationText: string }>;
}

export type ApplyStatus = "SUBMITTED" | "NEEDS_INPUT" | "FAILED";

export interface ApplyResultSubmitted {
  status: "SUBMITTED";
  runId: string;
  receipt: Record<string, string>;
  confirmationText: string;
}

export interface ApplyResultNeedsInput {
  status: "NEEDS_INPUT";
  runId: string;
  questions: Question[];
}

export interface ApplyResultFailed {
  status: "FAILED";
  runId?: string;
  step?: string;
  error: string;
}

export type ApplyResult =
  | ApplyResultSubmitted
  | ApplyResultNeedsInput
  | ApplyResultFailed;

export interface TraceEntry {
  field: string;
  value: string;
  timestamp: string;
  screenshotPath?: string;
}

export type RunState = "CREATED" | "RUNNING" | "NEEDS_INPUT" | "SUBMITTED" | "FAILED";

export interface RunRecord {
  runId: string;
  jobUrl: string;
  adapterName: string;
  profile: Profile;
  state: RunState;
  recordingDir?: string;
  trace: TraceEntry[];
  pendingQuestions?: Question[];
  receipt?: Record<string, string>;
  confirmationText?: string;
  error?: string;
  failedStep?: string;
  createdAt: string;
  updatedAt: string;
}


