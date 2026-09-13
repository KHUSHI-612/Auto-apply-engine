import type { FormField, Profile, Question, WorkExperience } from "./types.js";

/**
 * Normalizes text for case-insensitive and fuzzy punctuation/whitespace matching.
 */
function normalizeKey(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "") // Remove punctuation
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Checks if a normalized label matches an answersBank key fuzzily.
 */
function matchAnswersBank(label: string, answersBank?: Record<string, string>): string | undefined {
  if (!answersBank) return undefined;
  const normalizedLabel = normalizeKey(label);

  for (const [key, value] of Object.entries(answersBank)) {
    if (normalizeKey(key) === normalizedLabel && value !== undefined && value !== null) {
      const strVal = String(value).trim();
      if (strVal.length > 0) {
        return strVal;
      }
    }
  }

  return undefined;
}

/**
 * Retrieves current or most recent work experience according to the rule:
 * assume experience[0] is most recent, unless current is explicitly false on it,
 * in which case locate the entry where current === true.
 */
function getCurrentExperience(experiences?: WorkExperience[]): WorkExperience | undefined {
  if (!experiences || experiences.length === 0) return undefined;

  const first = experiences[0];
  if (first.current !== false) {
    return first;
  }

  return experiences.find((e) => e.current === true);
}

/**
 * Detects if a label or fieldId corresponds to an EEO or demographic question.
 */
export function isDemographicQuestion(label: string, fieldId?: string): boolean {
  if (fieldId && /^(eeo|demographic|survey)/i.test(fieldId)) {
    return true;
  }
  const norm = normalizeKey(label);
  return (
    /\b(race|ethnicity|ethnic|hispanic|latino)\b/i.test(norm) ||
    /\b(gender|sex|pronoun|pronouns)\b/i.test(norm) ||
    /\b(veteran|veterans|military|armed forces)\b/i.test(norm) ||
    /\b(disability|handicap|impairment)\b/i.test(norm) ||
    /\b(eeo|equal opportunity)\b/i.test(norm)
  );
}

/**
 * Maps a list of form fields against a user profile.
 *
 * Rules:
 * 1. Checks profile.answersBank first (fuzzy on punctuation and whitespace).
 * 2. Uses pattern matching on field.label for standard fields:
 *    - name / full name / first name / last name
 *    - email
 *    - phone
 *    - linkedin
 *    - github
 *    - current company / employer
 *    - current title / job title
 *    - school / university
 *    - degree
 * 3. Anything not confidently matched goes into `missing` as a Question.
 * 4. Demographic/EEO questions are placed in `missing` with an explanatory note.
 *
 * Pure, synchronous, and side-effect free.
 */
export function mapFields(
  fields: FormField[],
  profile: Profile
): {
  filled: { field: FormField; value: string }[];
  missing: Question[];
} {
  const filled: { field: FormField; value: string }[] = [];
  const missing: Question[] = [];

  for (const field of fields) {
    const rawLabel = field.label || "";
    const norm = normalizeKey(rawLabel);

    // 1. High priority: answersBank match
    const bankAnswer = matchAnswersBank(rawLabel, profile.answersBank);
    if (bankAnswer !== undefined) {
      filled.push({ field, value: bankAnswer });
      continue;
    }

    // If it is a demographic/EEO field, do NOT match against general profile names or links
    const isDemographic = isDemographicQuestion(rawLabel, field.id);
    if (isDemographic) {
      missing.push({
        ...field,
        type: field.type,
        options: field.options ? [...field.options] : undefined,
        note: "Demographic/EEO question (default choice should be handled by engine layer)",
      });
      continue;
    }

    // 2. Pattern matching against Profile
    let matchedValue: string | undefined = undefined;

    // --- Name fields ---
    if (
      norm === "first name" ||
      norm === "given name" ||
      norm === "forename"
    ) {
      if (profile.personalInfo.firstName?.trim()) {
        matchedValue = profile.personalInfo.firstName.trim();
      } else if (profile.personalInfo.fullName?.trim()) {
        const full = profile.personalInfo.fullName.trim();
        const spaceIdx = full.indexOf(" ");
        matchedValue = spaceIdx !== -1 ? full.slice(0, spaceIdx) : full;
      }
    } else if (
      norm === "last name" ||
      norm === "surname" ||
      norm === "family name"
    ) {
      if (profile.personalInfo.lastName?.trim()) {
        matchedValue = profile.personalInfo.lastName.trim();
      } else if (profile.personalInfo.fullName?.trim()) {
        const full = profile.personalInfo.fullName.trim();
        const spaceIdx = full.indexOf(" ");
        matchedValue = spaceIdx !== -1 ? full.slice(spaceIdx + 1).trim() : "";
      }
    } else if (
      norm === "full name" ||
      norm === "name" ||
      norm === "legal name" ||
      norm === "your name" ||
      norm === "candidate name" ||
      norm === "applicant name"
    ) {
      if (profile.personalInfo.fullName?.trim()) {
        matchedValue = profile.personalInfo.fullName.trim();
      }
    }

    // --- Email ---
    else if (
      norm === "email" ||
      norm === "email address" ||
      norm === "e mail" ||
      norm === "e mail address" ||
      norm === "contact email"
    ) {
      if (profile.personalInfo.email?.trim()) {
        matchedValue = profile.personalInfo.email.trim();
      }
    }

    // --- Phone ---
    else if (
      norm === "phone" ||
      norm === "phone number" ||
      norm === "telephone" ||
      norm === "telephone number" ||
      norm === "mobile" ||
      norm === "mobile phone" ||
      norm === "mobile number" ||
      norm === "cell phone" ||
      norm === "contact number"
    ) {
      if (profile.personalInfo.phone?.trim()) {
        matchedValue = profile.personalInfo.phone.trim();
      }
    }

    // --- LinkedIn ---
    else if (norm.includes("linkedin")) {
      const linkedInProfile = profile.profiles?.find(
        (p) => p.network.trim().toLowerCase() === "linkedin"
      );
      if (linkedInProfile?.url?.trim()) {
        matchedValue = linkedInProfile.url.trim();
      }
    }

    // --- GitHub ---
    else if (norm.includes("github")) {
      const gitHubProfile = profile.profiles?.find(
        (p) => p.network.trim().toLowerCase() === "github"
      );
      if (gitHubProfile?.url?.trim()) {
        matchedValue = gitHubProfile.url.trim();
      }
    }

    // --- Current Company / Employer ---
    else if (
      norm === "current company" ||
      norm === "company" ||
      norm === "employer" ||
      norm === "current employer" ||
      norm === "organization" ||
      norm === "current organization"
    ) {
      const currentExp = getCurrentExperience(profile.experience);
      if (currentExp?.company?.trim()) {
        matchedValue = currentExp.company.trim();
      }
    }

    // --- Current Title / Job Title ---
    else if (
      norm === "current title" ||
      norm === "job title" ||
      norm === "title" ||
      norm === "current job title" ||
      norm === "current role" ||
      norm === "role" ||
      norm === "current position" ||
      norm === "position"
    ) {
      const currentExp = getCurrentExperience(profile.experience);
      if (currentExp?.jobTitle?.trim()) {
        matchedValue = currentExp.jobTitle.trim();
      }
    }

    // --- School / University ---
    else if (
      norm === "school" ||
      norm === "university" ||
      norm === "college" ||
      norm === "institution" ||
      norm === "school or university" ||
      norm === "school university" ||
      norm === "university or college"
    ) {
      if (profile.education && profile.education.length > 0) {
        const edu = profile.education[0];
        if (edu.school?.trim()) {
          matchedValue = edu.school.trim();
        }
      }
    }

    // --- Degree ---
    else if (
      norm === "degree" ||
      norm === "degree type" ||
      norm === "highest degree" ||
      norm === "education degree"
    ) {
      if (profile.education && profile.education.length > 0) {
        const edu = profile.education[0];
        if (edu.degree?.trim()) {
          matchedValue = edu.degree.trim();
        }
      }
    }

    // 3. Output decision: filled if confidently matched with non-empty string, else missing
    if (matchedValue !== undefined && matchedValue.length > 0) {
      filled.push({ field, value: matchedValue });
    } else {
      const isDemographic = isDemographicQuestion(rawLabel);
      const question: Question = {
        ...field,
        type: field.type,
        options: field.options ? [...field.options] : undefined,
        ...(isDemographic
          ? {
              note: "Demographic/EEO question (default choice should be handled by engine layer)",
            }
          : {}),
      };
      missing.push(question);
    }
  }

  return { filled, missing };
}
