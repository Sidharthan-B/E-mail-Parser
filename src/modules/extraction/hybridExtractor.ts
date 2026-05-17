import { ParsedEmail, RecruiterEntity } from "../../shared/types";
import {
  detectInternship,
  detectPpo,
  detectServiceAgreement,
  extractTotalPositions,
  normalizeBacklogCount,
  normalizeBondPeriodMonths,
  normalizeDeadlineTimestamp,
  normalizeEligibleBatchYears,
  normalizeEligibleDepartments,
  normalizePhone,
  normalizeRole,
  normalizeRoundDetails,
  normalizeSalaryDisplay,
  normalizeSkillGroup,
  normalizeStipendDisplay,
  normalizeWorkMode
} from "../normalization/normalizer";
import { extractDeterministic } from "./deterministicExtractor";
import { extractWithLocalNlp } from "./nlpBridge";
import { extractWithOllamaSemanticAssistant, SemanticExtraction } from "../semantic/ollamaSemanticAssistant";
import { extractPlacementHeuristics } from "./placementHeuristics";

export async function extractRecruiterInformation(email: ParsedEmail): Promise<RecruiterEntity> {
  const deterministic = extractDeterministic(email.cleanedText);
  const heuristics = extractPlacementHeuristics(email.cleanedText);
  const [semantic, nlp] = await Promise.all([
    extractWithOllamaSemanticAssistant(email.cleanedText),
    extractWithLocalNlp(email.cleanedText)
  ]);

  const notes = new Set<string>(semantic.additional_info ?? []);

  const companyName =
    cleanString(semantic.company_name) ||
    cleanString(nlp.company_name) ||
    cleanString(heuristics.company_name) ||
    inferCompanyFromSubject(email.subject) ||
    inferCompanyFromProfile(email.cleanedText) ||
    null;

  const role = normalizeRole(
    cleanString(semantic.role) ||
      cleanString(nlp.role) ||
      cleanString(heuristics.role) ||
      inferRoleFromProfile(email.cleanedText) ||
      "Unknown Role"
  );

  const ctcLpa = crossValidateSalary(deterministic.ctcLpa, semantic.ctc_lpa);
  const stipendMonthly = crossValidateStipend(deterministic.stipendMonthly, semantic.stipend);
  const minCgpa = crossValidateCgpa(deterministic.minCgpa, semantic.minimum_cgpa);
  const allowedBacklogs =
    deterministic.allowedBacklogs ?? nullIfNegative(normalizeBacklogCount(semantic.max_allowed_backlogs, email.cleanedText));

  const location = cleanString(semantic.location) || cleanString(nlp.location) || inferLocation(email.cleanedText) || null;
  const modeOfWork = normalizeWorkMode(cleanString(semantic.mode_of_work) || location || "");
  const isInternship = detectInternship(email.cleanedText, semantic.internship);
  const ppoAvailable = detectPpo(email.cleanedText, isInternship, semantic.ppo);
  const serviceAgreement = detectServiceAgreement(email.cleanedText, semantic.service_agreement);
  const bondPeriodMonths = deterministic.bondPeriodMonths ?? normalizeBondPeriodMonths(semantic.bond_period_months, email.cleanedText);

  const eligibleDepartments = normalizeEligibleDepartments(
    [
      ...(semantic.eligible_streams ?? []),
      ...(semantic.eligible_branches ?? []),
      ...(nlp.eligible_streams ?? []),
      ...(nlp.eligible_branches ?? []),
      ...heuristics.eligible_branches
    ],
    [...(semantic.eligible_specialisations ?? []), ...(nlp.eligible_specialisations ?? [])]
  );

  const eligibleBatchYears = normalizeEligibleBatchYears([...(semantic.eligible_years ?? []), ...(nlp.eligible_years ?? [])], email.cleanedText);
  const skillsRequired = normalizeSkillGroup(mergeStringLists(semantic.skills_required, nlp.skills_required));
  const preferredSkills = normalizeSkillGroup(mergeStringLists(semantic.preferred_skills, nlp.preferred_skills));
  const roundDetails = normalizeRoundDetails([...(semantic.round_details ?? []), ...(nlp.round_details ?? [])], email.cleanedText);

  const applicationLink = deterministic.applicationLink || trustedUrl(semantic.registration_link, email.cleanedText);
  const recruiterEmail = deterministic.recruiterEmail || trustedEmail(semantic.contact_email, email.cleanedText);
  const contactEmail = recruiterEmail || trustedEmail(semantic.contact_email, email.cleanedText);
  const contactPhone = deterministic.contactPhone ?? normalizePhone(semantic.contact_phone);
  const currentDeadline =
    (deterministic.deadline ? normalizeDeadlineTimestamp(deterministic.deadline) : null) ??
    (cleanString(semantic.deadline) ? normalizeDeadlineTimestamp(cleanString(semantic.deadline)) : null);
  const totalPositions = deterministic.totalPositions ?? extractTotalPositions(email.cleanedText, semantic.total_positions);

  if (eligibleDepartments?.some((item) => item.category === "circuit")) {
    addIfMentioned(notes, email.cleanedText, /all\s+circuit\s+branches/i, "Circuit branches inferred semantically.");
  }
  if (!applicationLink && /registration\s+link|click\s+here\s+to\s+register|register\s+on\s+the\s+link/i.test(email.cleanedText)) {
    notes.add("Registration link referenced but actual URL missing.");
  }
  if (allowedBacklogs === null && /backlog|arrears/i.test(email.cleanedText)) {
    notes.add("Backlog policy mentioned but could not be normalized confidently.");
  }
  if (!cleanString(semantic.description) && /job description|jd|responsibilit|about company/i.test(email.cleanedText)) {
    notes.add("Description section referenced but concise role summary was not confidently extracted.");
  }

  return {
    company_name: companyName,
    recruiter_email: recruiterEmail || null,
    role: role || "Unknown Role",
    description: normalizeDescription(semantic.description),
    location,
    mode_of_work: modeOfWork,
    ctc: normalizeSalaryDisplay(ctcLpa),
    stipend: normalizeStipendDisplay(stipendMonthly),
    min_cgpa: minCgpa,
    allowed_backlogs: allowedBacklogs,
    eligible_departments: eligibleDepartments,
    eligible_batch_years: eligibleBatchYears,
    skills_required: skillsRequired ?? { technical: [], soft_skills: [] },
    preferred_skills: preferredSkills,
    is_internship: isInternship,
    ppo_available: ppoAvailable,
    service_agreement: serviceAgreement,
    bond_period_months: bondPeriodMonths,
    total_rounds: roundDetails.length,
    round_details: roundDetails,
    current_deadline: currentDeadline,
    total_positions: totalPositions,
    application_link: applicationLink || null,
    contact_email: contactEmail || null,
    contact_phone: contactPhone,
    additional_information: notes.size ? [...notes].join(" ") : null,
    job_source: normalizeJobSource(semantic.job_source, email.cleanedText)
  };
}

function crossValidateSalary(regexLpa: number | null, ollamaLpa: number | undefined): number | null {
  const rVal = regexLpa;
  const oVal = ollamaLpa && ollamaLpa > 0 && ollamaLpa <= 200 ? ollamaLpa : null;
  if (rVal === null && oVal === null) return null;
  if (rVal === null) return oVal;
  if (oVal === null) return rVal;
  const ratio = Math.max(rVal, oVal) / Math.min(rVal, oVal);
  if (ratio <= 1.3) return rVal;
  if (rVal < 2 && oVal >= 2) return oVal;
  if (rVal > 100 && oVal <= 100) return oVal;
  if (oVal > rVal * 2) return oVal;
  return rVal;
}

function crossValidateCgpa(regexCgpa: number | null, ollamaCgpa: number | undefined): number | null {
  const oVal = ollamaCgpa && ollamaCgpa > 0 ? ollamaCgpa : null;
  if (regexCgpa === null && oVal === null) return null;
  if (regexCgpa === null && oVal !== null) return oVal <= 10 ? oVal : null;
  return regexCgpa;
}

function crossValidateStipend(regexStipend: number | null, ollamaStipend: number | undefined): number | null {
  const oVal = ollamaStipend && ollamaStipend > 0 ? ollamaStipend : null;
  if (regexStipend === null && oVal === null) return null;
  if (regexStipend === null) return oVal;
  return regexStipend;
}

function cleanString(value: string | undefined): string {
  return value?.trim() && value.trim() !== "-1" ? value.trim() : "";
}

function mergeStringLists(a: string[] | undefined, b: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [...(a ?? []), ...(b ?? [])]) {
    const clean = item.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(clean);
    }
  }
  return out;
}

function normalizeDescription(value: string | undefined): string | null {
  const text = cleanString(value);
  if (!text) return null;
  return text.split(/(?<=[.!?])\s+/).slice(0, 6).join(" ").trim() || null;
}

function nullIfNegative(value: number): number | null {
  return value >= 0 ? value : null;
}

function trustedUrl(value: string | undefined, text: string): string {
  const url = cleanString(value);
  return url && text.includes(url) ? url : "";
}

function trustedEmail(value: string | undefined, text: string): string {
  const email = cleanString(value);
  return email && text.toLowerCase().includes(email.toLowerCase()) && !/(placement|\.edu|\.ac\.in|gmail\.com|yahoo\.com|outlook\.com)/i.test(email)
    ? email
    : "";
}

function normalizeJobSource(value: string | undefined, text: string): string | null {
  const source = cleanString(value).toLowerCase();
  if (["campus", "linkedin", "referral", "offcampus"].includes(source)) return source;
  if (/\bcampus|placement|college|university\b/i.test(text)) return "campus";
  return null;
}

function inferCompanyFromSubject(subject: string): string {
  if (!subject) return "";
  let cleaned = subject.replace(/^(Gmail\s*[-–—]|Fwd:\s*|Re:\s*|FW:\s*)/gi, "").trim();
  cleaned = cleaned
    .replace(/\s+(campus\s+)?(?:hiring|recruitment)\s+drive.*$/i, "")
    .replace(/\s+campus\s+drive.*$/i, "")
    .replace(/\s+placement\s+drive.*$/i, "")
    .replace(/\s+drive.*$/i, "")
    .trim();
  return cleaned.split(/\s*[&|,\-–—]\s*/)[0]?.trim() || "";
}

function inferCompanyFromProfile(text: string): string {
  const profileLine = text.match(/profile\s*:\s*([^\n]+)/i)?.[1] ?? "";
  const parts = profileLine.split("-").map((part) => part.trim()).filter(Boolean);
  return parts.length >= 2 ? parts[1] : "";
}

function inferRoleFromProfile(text: string): string {
  const profileLine = text.match(/profile\s*:\s*([^\n]+)/i)?.[1] ?? "";
  return profileLine.split(",")[0]?.trim() ?? "";
}

function inferLocation(text: string): string {
  const lines = text.split(/\n/);
  const index = lines.findIndex((item) => /\b(work\s+location|base\s+location|job\s+location|location)\b/i.test(item));
  if (index === -1) return "";
  const sameLine = lines[index].replace(/.*?\b(?:work\s+location|base\s+location|job\s+location|location)\b\s*[:\-]?\s*/i, "").trim();
  return sameLine || lines[index + 1]?.trim() || "";
}

function addIfMentioned(info: Set<string>, text: string, pattern: RegExp, note: string): void {
  if (pattern.test(text)) info.add(note);
}
