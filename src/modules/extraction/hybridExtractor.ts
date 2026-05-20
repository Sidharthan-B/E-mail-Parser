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
import { extractWithGeminiSemanticAssistant, SemanticExtraction, SemanticRole } from "../semantic/geminiSemanticAssistant";
import { extractPlacementHeuristics } from "./placementHeuristics";

export async function extractRecruiterInformation(email: ParsedEmail): Promise<RecruiterEntity[]> {
  const deterministic = extractDeterministic(email.cleanedText);
  const heuristics = extractPlacementHeuristics(email.cleanedText);
  const [semantic, nlp] = await Promise.all([
    extractWithGeminiSemanticAssistant(email.text),  // use pre-section original; cleanedText has sections appended
    extractWithLocalNlp(email.cleanedText)
  ]);

  // Build shared base fields that apply to all roles
  const base = buildBaseEntity(email, deterministic, heuristics, semantic, nlp);

  // Multi-role: if Gemini returned multiple roles, fan out into separate entities
  if (semantic.roles && semantic.roles.length > 1) {
    return semantic.roles.map((roleEntry) => mergeRoleOverride(base, roleEntry));
  }

  return [base];
}

function buildBaseEntity(
  email: ParsedEmail,
  deterministic: ReturnType<typeof extractDeterministic>,
  heuristics: ReturnType<typeof extractPlacementHeuristics>,
  semantic: SemanticExtraction,
  nlp: Awaited<ReturnType<typeof extractWithLocalNlp>>
): RecruiterEntity {
  const notes = new Set<string>(semantic.additional_info ?? []);

  const companyName =
    cleanString(semantic.company_name) ||
    cleanString(nlp.company_name) ||
    cleanString(heuristics.company_name) ||
    inferCompanyFromSubject(email.subject) ||
    inferCompanyFromProfile(email.cleanedText) ||
    null;

  const role = normalizeRole(
    cleanRole(cleanString(semantic.role)) ||
      cleanRole(cleanString(nlp.role)) ||
      cleanRole(cleanString(heuristics.role)) ||
      cleanRole(inferRoleFromProfile(email.cleanedText)) ||
      "Unknown Role"
  );

  const ctcLpa = crossValidateSalary(deterministic.ctcLpa, semantic.ctc_lpa);
  const stipendMonthly = crossValidateStipend(deterministic.stipendMonthly, semantic.stipend);
  const minCgpa = crossValidateCgpa(deterministic.minCgpa, semantic.minimum_cgpa);
  const allowedBacklogs =
    deterministic.allowedBacklogs ?? nullIfNegative(normalizeBacklogCount(semantic.max_allowed_backlogs, email.cleanedText));

  const location = cleanLocation(
    cleanString(semantic.location) || cleanString(nlp.location) || inferLocation(email.cleanedText)
  ) || null;
  const modeOfWork = normalizeWorkMode(cleanString(semantic.mode_of_work) || location || "");
  const isInternship = detectInternship(email.cleanedText, semantic.internship);
  const ppoAvailable = detectPpo(email.cleanedText, isInternship, semantic.ppo);
  const serviceAgreement = detectServiceAgreement(email.cleanedText, semantic.service_agreement);
  const bondPeriodMonths = deterministic.bondPeriodMonths ?? normalizeBondPeriodMonths(semantic.bond_period_months, email.cleanedText);

  // Eligible departments — prefer structured eligible_departments from Gemini,
  // fall back to flat streams + specialisations
  const eligibleDepartments = normalizeEligibleDepartments(
    [
      ...(semantic.eligible_streams ?? []),
      ...(semantic.eligible_branches ?? []),
      ...(nlp.eligible_streams ?? []),
      ...(nlp.eligible_branches ?? []),
      ...heuristics.eligible_branches
    ],
    [...(semantic.eligible_specialisations ?? []), ...(nlp.eligible_specialisations ?? [])],
    semantic.eligible_departments ?? []
  );

  const eligibleBatchYears = normalizeEligibleBatchYears(
    [...(semantic.eligible_years ?? []), ...(nlp.eligible_years ?? [])],
    email.cleanedText
  );
  const skillsRequired = normalizeSkillGroup(mergeStringLists(semantic.skills_required, nlp.skills_required));
  const preferredSkills = normalizeSkillGroup(mergeStringLists(semantic.preferred_skills, nlp.preferred_skills));
  const roundDetails = normalizeRoundDetails(
    [...(semantic.round_details ?? []), ...(nlp.round_details ?? [])],
    email.cleanedText
  );

  const applicationLink = deterministic.applicationLink || trustedUrl(semantic.registration_link, email.cleanedText);
  const recruiterEmail = deterministic.recruiterEmail || trustedEmail(semantic.contact_email, email.cleanedText);
  const contactEmail = recruiterEmail || trustedEmail(semantic.contact_email, email.cleanedText);
  const rawPhone = deterministic.contactPhone ?? normalizePhone(semantic.contact_phone);
  const contactPhone = isPlacementCellPhone(rawPhone, email.cleanedText) ? null : rawPhone;
  const currentDeadline =
    (deterministic.deadline ? normalizeDeadlineTimestamp(deterministic.deadline) : null) ??
    (cleanString(semantic.deadline) ? normalizeDeadlineTimestamp(cleanString(semantic.deadline)) : null);
  const openings = deterministic.openings ?? extractTotalPositions(email.cleanedText, semantic.openings);

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
    openings,
    application_count: null,
    application_link: applicationLink || null,
    contact_email: contactEmail || null,
    contact_phone: contactPhone,
    additional_information: notes.size ? [...notes].join(" | ") : null
  };
}

/** Clone the base entity and apply per-role overrides from semantic.roles[]. */
function mergeRoleOverride(base: RecruiterEntity, roleEntry: SemanticRole): RecruiterEntity {
  const entity: RecruiterEntity = { ...base };

  if (cleanString(roleEntry.company_name)) entity.company_name = cleanString(roleEntry.company_name) || null;
  if (cleanString(roleEntry.role)) entity.role = normalizeRole(cleanRole(cleanString(roleEntry.role)) || "Unknown Role");
  if (cleanString(roleEntry.description)) entity.description = normalizeDescription(roleEntry.description);

  if (typeof roleEntry.ctc_lpa === "number" && roleEntry.ctc_lpa > 0) {
    entity.ctc = normalizeSalaryDisplay(roleEntry.ctc_lpa);
  }
  if (typeof roleEntry.stipend === "number" && roleEntry.stipend > 0) {
    entity.stipend = normalizeStipendDisplay(roleEntry.stipend);
  }
  if (typeof roleEntry.is_internship === "boolean") {
    entity.is_internship = roleEntry.is_internship;
    entity.ppo_available = roleEntry.is_internship ? Boolean(roleEntry.ppo) : false;
  }
  if (roleEntry.skills_required?.length) {
    entity.skills_required = normalizeSkillGroup(roleEntry.skills_required) ?? { technical: [], soft_skills: [] };
  }
  if (roleEntry.preferred_skills?.length) {
    entity.preferred_skills = normalizeSkillGroup(roleEntry.preferred_skills);
  }

  return entity;
}

// ─── cross-validation helpers ────────────────────────────────────────────────

function crossValidateSalary(regexLpa: number | null, geminiLpa: number | undefined): number | null {
  const rVal = regexLpa;
  const oVal = geminiLpa && geminiLpa > 0 && geminiLpa <= 200 ? geminiLpa : null;
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

function crossValidateCgpa(regexCgpa: number | null, geminiCgpa: number | undefined): number | null {
  const oVal = geminiCgpa && geminiCgpa > 0 ? geminiCgpa : null;
  if (regexCgpa === null && oVal === null) return null;
  if (regexCgpa === null && oVal !== null) return oVal <= 10 ? oVal : null;
  return regexCgpa;
}

function crossValidateStipend(regexStipend: number | null, geminiStipend: number | undefined): number | null {
  const oVal = geminiStipend && geminiStipend > 0 ? geminiStipend : null;
  if (regexStipend === null && oVal === null) return null;
  if (regexStipend === null) return oVal;
  return regexStipend;
}

// ─── string helpers ───────────────────────────────────────────────────────────

function cleanString(value: string | undefined): string {
  return value?.trim() && value.trim() !== "-1" ? value.trim() : "";
}

function cleanRole(value: string): string {
  if (!value) return "";
  return value
    .replace(/\s*[-–|]\s*Fresher\s*$/i, "")
    .replace(/\s+(qualifications?|requirements?|eligibility|skills?)\s*:.*$/i, "")
    .replace(/\s*[,(]\s*B\.[A-Z].*$/i, "")
    .trim();
}

const LOCATION_NOISE_PATTERN = /\b(employment\s+type|ctc|salary|requirements?|eligibility|cgpa|qualification|deadline|apply)\b/i;

function cleanLocation(raw: string): string {
  if (!raw) return "";
  const noiseIndex = raw.search(LOCATION_NOISE_PATTERN);
  const trimmed = noiseIndex > 0 ? raw.slice(0, noiseIndex) : raw;
  return trimmed.replace(/[,;:\s]+$/, "").trim();
}

function mergeStringLists(a: string[] | undefined, b: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [...(a ?? []), ...(b ?? [])]) {
    const clean = item.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(clean); }
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

const MAIL_APP_DOMAINS = /^https?:\/\/(?:mail\.google\.com|outlook\.live\.com|mail\.yahoo\.com)/i;

function trustedUrl(value: string | undefined, text: string): string {
  const url = cleanString(value);
  if (!url || !url.match(/^https?:\/\//i) || MAIL_APP_DOMAINS.test(url)) return "";
  return text.includes(url) ? url : "";
}

function trustedEmail(value: string | undefined, text: string): string {
  const email = cleanString(value);
  return email &&
    text.toLowerCase().includes(email.toLowerCase()) &&
    !/(placement|\.edu|\.ac\.in|gmail\.com|yahoo\.com|outlook\.com)/i.test(email)
    ? email
    : "";
}

function inferCompanyFromSubject(subject: string): string {
  if (!subject) return "";
  let cleaned = subject.replace(/^(Gmail\s*[-–—]|Fwd:\s*|Re:\s*|FW:\s*)/gi, "").trim();
  cleaned = cleaned
    .replace(/\s+(campus\s+)?(?:hiring|recruitment)\s+drive.*$/i, "")
    .replace(/\s+campus\s+drive.*$/i, "")
    .replace(/\s+placement\s+drive.*$/i, "")
    .replace(/\s+intern\s+hiring.*$/i, "")
    .replace(/\s+drive.*$/i, "")
    .trim();
  return cleaned.split(/\s+[|,–—]\s+|\s*,\s*/)[0]?.trim() || cleaned;
}

function inferCompanyFromProfile(text: string): string {
  const profileLine = text.match(/profile\s*:\s*([^\n]+)/i)?.[1] ?? "";
  const parts = profileLine.split("-").map((p) => p.trim()).filter(Boolean);
  return parts.length >= 2 ? parts[1] : "";
}

function inferRoleFromProfile(text: string): string {
  const profileLine = text.match(/profile\s*:\s*([^\n]+)/i)?.[1] ?? "";
  return profileLine.split(",")[0]?.trim() ?? "";
}

function inferLocation(text: string): string {
  const lines = text.split(/\n/);
  const index = lines.findIndex((l) => /\b(work\s+location|base\s+location|job\s+location|location)\b/i.test(l));
  if (index === -1) return "";
  const sameLine = lines[index].replace(/.*?\b(?:work\s+location|base\s+location|job\s+location|location)\b\s*[:\-]?\s*/i, "").trim();
  return sameLine || lines[index + 1]?.trim() || "";
}

const PLACEMENT_CELL_PHONE_PATTERN =
  /placement\s+(?:cell|officer|coordinator|head)|t\s*[&]\s*p\b|training\s+and\s+placement|tpo\b|head\s*[-–]\s*t|placement\s+cet|college\s+of\s+engineering|head\s+of\s+(?:t&p|placement)/i;

function isPlacementCellPhone(phone: string | null, text: string): boolean {
  if (!phone) return false;
  const digits = phone.replace(/\D/g, "").slice(-10);
  const lines = text.split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(digits)) continue;
    const window = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4)).join(" ");
    if (PLACEMENT_CELL_PHONE_PATTERN.test(window)) return true;
  }
  return false;
}
