import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import { EligibleBatchYear, EligibleDepartment, RoundDetail, SkillGroup } from "../../shared/types";
import {
  BRANCH_ALIASES,
  CIRCUIT_BRANCHES,
  INTERNSHIP_TERMS,
  PPO_TERMS,
  ROLE_ALIASES,
  ROUND_ALIASES,
  SERVICE_AGREEMENT_TERMS,
  SPECIALISATION_ALIASES,
  SPECIALISATION_PARENT,
  WORK_MODE_ALIASES
} from "./ontologies";

dayjs.extend(customParseFormat);

const BRANCH_MAP = Object.entries(BRANCH_ALIASES).reduce<Record<string, string>>((acc, [canonical, aliases]) => {
  acc[canonical.toLowerCase()] = canonical;
  for (const alias of aliases) acc[alias.toLowerCase()] = canonical;
  return acc;
}, {});

export function normalizeText(text: string): string {
  return text
    .replace(/\r/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/([a-zA-Z])\n([a-zA-Z])/g, "$1 $2")
    .replace(/-\s*\n/g, "- ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[^\x20-\x7E\n]/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .trim();
}

export function normalizeSalaryToLpa(raw: string): number | null {
  const clean = raw.replace(/,/g, "").toLowerCase();
  const range = clean.match(/(\d+(?:\.\d+)?)\s*[-~to]+\s*(\d+(?:\.\d+)?)\s*(?:lpa|lakh)/);
  if (range) return Number(range[1]);

  const lakhMatch = clean.match(/(\d+(?:\.\d+)?)\s*(lpa|lakh)/);
  if (lakhMatch) return Number(lakhMatch[1]);

  const inrMatch = clean.match(/(?:inr|rs|rupees|₹)?\s*(\d{5,8}(?:\.\d+)?)/i);
  if (inrMatch) {
    const inr = Number(inrMatch[1]);
    if (Number.isFinite(inr)) return Number((inr / 100000).toFixed(2));
  }

  const genericNumber = Number(clean.replace(/[^\d.]/g, ""));
  if (Number.isFinite(genericNumber) && genericNumber >= 100000) return Number((genericNumber / 100000).toFixed(2));
  if (Number.isFinite(genericNumber) && genericNumber > 0 && genericNumber < 100) return Number(genericNumber.toFixed(2));
  return null;
}

export function normalizeMonthlyMoney(raw: string): number | null {
  const clean = raw.replace(/,/g, "").toLowerCase();
  const kMatch = clean.match(/(?:rs\.?|inr|₹)?\s*(\d+(?:\.\d+)?)\s*k\b/);
  if (kMatch) return Math.round(Number(kMatch[1]) * 1000);

  const amountMatch = clean.match(/(?:rs\.?|inr|₹)?\s*(\d{4,7}(?:\.\d+)?)/);
  if (amountMatch) {
    const amount = Number(amountMatch[1]);
    return Number.isFinite(amount) ? Math.round(amount) : null;
  }
  return null;
}

export function normalizeSalaryDisplay(lpa: number | null | undefined): string | null {
  if (typeof lpa !== "number" || !Number.isFinite(lpa) || lpa <= 0) return null;
  return `${Number(lpa.toFixed(2)).toString()} LPA`;
}

export function normalizeStipendDisplay(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return `Rs. ${Math.round(value).toLocaleString("en-IN")}/month`;
}

export function normalizeBranch(branch: string): string {
  if (!branch) return "";
  const key = branch.toLowerCase().replace(/[./]/g, " ").replace(/\s+/g, " ").trim();
  return BRANCH_MAP[key] ?? branch.trim();
}

export function normalizeBranches(values: string[]): string[] {
  const expanded = values.flatMap((value) => {
    const lower = value.toLowerCase();
    const out: string[] = [];
    if (/\ball\s+circuit\s+branches?\b/.test(lower)) out.push(...CIRCUIT_BRANCHES);
    if (/\bcs\s*\/\s*it\b/i.test(value)) out.push("CSE", "IT");
    out.push(...value.split(/[,;/]|\band\b/i));
    return out;
  });
  return [...new Set(expanded.map(normalizeBranch).filter(Boolean))];
}

export function normalizeSpecialisations(values: string[]): string[] {
  const candidates = values.flatMap((value) => value.split(/[,;/]|\band\b/i));
  const normalized = candidates
    .map((value) => {
      const key = value.toLowerCase().replace(/[./]/g, " ").replace(/\s+/g, " ").trim();
      for (const [canonical, aliases] of Object.entries(SPECIALISATION_ALIASES)) {
        if (canonical.toLowerCase() === key || aliases.some((alias) => alias.toLowerCase() === key)) return canonical;
      }
      return "";
    })
    .filter(Boolean);
  return [...new Set(normalized)];
}

/**
 * Parses a raw string that may be a compound "Department Specialisation" token
 * such as "CSE AI/ML" or "IT Security".  Returns {department, specialisation}.
 */
function parseCompoundDept(raw: string): { department: string; specialisation: string | null } {
  const trimmed = raw.trim();

  // Check if the whole string is a known specialisation first
  const specNorm = normalizeSpecialisations([trimmed]);
  if (specNorm.length) {
    const spec = specNorm[0];
    return { department: SPECIALISATION_PARENT[spec] ?? spec, specialisation: spec };
  }

  // Try splitting "DEPT SPEC" — first token is dept, rest is specialisation
  const parts = trimmed.split(/\s*[-–/]\s*|\s+/);
  if (parts.length >= 2) {
    const deptCandidate = normalizeBranch(parts[0]);
    const specCandidate = parts.slice(1).join(" ");
    const specNorm2 = normalizeSpecialisations([specCandidate]);
    if (specNorm2.length) {
      return { department: deptCandidate || parts[0], specialisation: specNorm2[0] };
    }
  }

  return { department: normalizeBranch(trimmed) || trimmed, specialisation: null };
}

export function normalizeEligibleDepartments(
  streams: string[],
  specialisations: string[] = [],
  deptSpecPairs: Array<{ department: string; specialisation?: string | null }> = []
): EligibleDepartment[] | null {
  // key = "DEPT||SPEC" to deduplicate
  const seen = new Map<string, EligibleDepartment>();

  const add = (dept: string, spec: string | null) => {
    if (!dept) return;
    const key = `${dept.toLowerCase()}||${(spec ?? "").toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, { department: dept, specialisation: spec });
  };

  // Explicit pairs from Ollama when it returns structured dept+specialisation
  for (const pair of deptSpecPairs) {
    if (!pair.department) continue;
    const dept = normalizeBranch(pair.department) || pair.department;
    const spec = pair.specialisation ? (normalizeSpecialisations([pair.specialisation])[0] ?? pair.specialisation) : null;
    add(dept, spec);
  }

  // Flat stream strings — may be compound ("CSE AI/ML") or plain ("CSE")
  for (const raw of normalizeBranches(streams)) {
    const { department, specialisation } = parseCompoundDept(raw);
    add(department, specialisation);
  }

  // Standalone specialisations — pair with their natural parent dept
  for (const spec of normalizeSpecialisations(specialisations)) {
    const parent = SPECIALISATION_PARENT[spec];
    if (parent) {
      add(parent, spec);
    } else {
      add(spec, null);
    }
  }

  return seen.size ? [...seen.values()] : null;
}

export function normalizeRole(value: string): string {
  const key = value.toLowerCase().replace(/\s+/g, " ").trim();
  for (const [canonical, aliases] of Object.entries(ROLE_ALIASES)) {
    if (canonical.toLowerCase() === key || aliases.some((alias) => alias.toLowerCase() === key)) return canonical;
  }
  return value.trim();
}

export function normalizeWorkMode(value: string): string | null {
  const lower = value.toLowerCase();
  for (const mode of ["Hybrid", "Remote", "Onsite"] as const) {
    if (WORK_MODE_ALIASES[mode].some((alias) => lower.includes(alias))) return mode;
  }
  return null;
}

export function detectInternship(text: string, semanticValue?: boolean): boolean {
  if (semanticValue === true) return true;
  const lower = text.toLowerCase().replace(/\binternship\s+experience\b/g, "");
  return INTERNSHIP_TERMS.some((term) => wordContains(lower, term));
}

export function detectPpo(text: string, internship: boolean, semanticValue?: boolean): boolean {
  if (!internship) return false;
  if (semanticValue === true) return true;
  const lower = text.toLowerCase();
  return PPO_TERMS.some((term) => wordContains(lower, term));
}

export function detectServiceAgreement(text: string, semanticValue?: boolean): boolean {
  if (semanticValue === true) return true;
  const lower = text.toLowerCase();
  return SERVICE_AGREEMENT_TERMS.some((term) => lower.includes(term));
}

function wordContains(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

export function normalizeEligibleYears(values: string[], text = ""): string[] {
  const out = new Set<string>();
  const yearLines = text
    .split(/\n/)
    .filter((line) => /\b(batch|graduate|graduating|eligible|students?|final\s+year|third\s+year|3rd\s+year)\b/i.test(line));

  for (const value of [...values, ...yearLines]) {
    const yearMatches = value.match(/\b20\d{2}\b/g) ?? [];
    for (const year of yearMatches) out.add(year);
    if (/\bfinal\s+year\b/i.test(value)) out.add("Final Year");
    if (/\b3(?:rd)?\s+year\b/i.test(value) || /\bthird\s+year\b/i.test(value)) out.add("3rd Year");
  }
  return [...out];
}

export function normalizeEligibleBatchYears(values: string[], text = ""): EligibleBatchYear[] | null {
  const normalized = normalizeEligibleYears(values, text);
  const out = normalized.map((value) => {
    const year = Number(value);
    return Number.isInteger(year) && year >= 2000 && year <= 2100 ? { year } : { label: value };
  });
  return out.length ? out : null;
}

export function normalizeBacklogCount(value: string | number | undefined, text = ""): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  const source = `${value ?? ""}\n${text}`.toLowerCase();
  if (/(no\s+(?:active|standing)?\s*backlogs?|no\s+standing\s+arrears|no\s+active\s+arrears)/i.test(source)) return 0;
  const match = source.match(
    /(?:max(?:imum)?|up\s+to|allowed|not\s+(?:have\s+)?more\s+than|more\s+than)\D{0,20}(\d+)\s+(?:active\s+)?(?:backlogs?|arrears?)/i
  );
  return match ? Number(match[1]) : -1;
}

export function normalizeDate(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const formats = [
    "D-MMM-YYYY, h:mm A",
    "D-MMM-YYYY, hh:mm A",
    "D-MMM-YYYY H:mm",
    "D-MMM-YYYY",
    "DD-MMM-YYYY, h:mm A",
    "DD-MMM-YYYY",
    "D MMMM YYYY, h:mm A",
    "D MMMM YYYY h:mm A",
    "DD MMMM YYYY, h:mm A",
    "DD MMMM YYYY h:mm A",
    "YYYY-MM-DD H:mm",
    "YYYY-MM-DD",
    "MMM D, YYYY",
    "MMM DD, YYYY"
  ];

  let parsed = dayjs(trimmed);
  if (!parsed.isValid()) {
    for (const fmt of formats) {
      const d = dayjs(trimmed, fmt, true);
      if (d.isValid()) {
        parsed = d;
        break;
      }
    }
  }
  return parsed.isValid() ? parsed.toISOString() : "";
}

export function normalizeDeadlineTimestamp(value: string): number | null {
  const iso = normalizeDate(value);
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

export function normalizeSkillGroup(values: string[]): SkillGroup | null {
  const technical: string[] = [];
  const soft_skills: string[] = [];
  const softPatterns = /\b(communication|teamwork|leadership|problem[- ]solving|analytical|presentation|collaboration)\b/i;

  for (const raw of values) {
    const value = raw.replace(/\s+/g, " ").trim();
    if (!value) continue;
    if (softPatterns.test(value)) soft_skills.push(value);
    else technical.push(value);
  }

  const group = { technical: [...new Set(technical)], soft_skills: [...new Set(soft_skills)] };
  return group.technical.length || group.soft_skills.length ? group : null;
}

export function normalizeBondPeriodMonths(value: number | undefined, text: string): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.round(value);
  const match =
    text.match(/(\d+(?:\.\d+)?)\s*(months?|years?)\s+(?:service\s+agreement|bond|commitment|mandatory\s+agreement)/i) ??
    text.match(/(?:service\s+agreement|bond|commitment|mandatory\s+agreement)\D{0,20}(\d+(?:\.\d+)?)\s*(months?|years?)/i);
  if (!match) return null;
  const amount = Number(match[1]);
  return match[2].toLowerCase().startsWith("year") ? Math.round(amount * 12) : Math.round(amount);
}

export function normalizeRoundName(value: string): string {
  const lower = value.toLowerCase().trim();
  for (const [canonical, aliases] of Object.entries(ROUND_ALIASES)) {
    if (aliases.some((alias) => lower.includes(alias))) return canonical;
  }
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeRoundDetails(values: string[], text: string): RoundDetail[] {
  const candidates = values.length ? values : extractRoundsFromText(text);
  const seen = new Set<string>();
  const details: RoundDetail[] = [];

  for (const candidate of candidates) {
    const name = normalizeRoundName(candidate.replace(/^\d+[.)-]?\s*/, ""));
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    details.push({ round: details.length + 1, name });
  }

  return details;
}

function extractRoundsFromText(text: string): string[] {
  const lines = text.split(/\n/);
  const out: string[] = [];
  let inSelection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(selection|interview|hiring)\s+process/i.test(trimmed)) {
      inSelection = true;
      continue;
    }
    if (inSelection && !trimmed) continue;
    if (inSelection && /^[A-Z][A-Za-z ]+:\s*$/.test(trimmed)) break;
    if (inSelection) {
      const bullet = trimmed.match(/^(?:\d+[.)]|[-*])\s*(.+)$/)?.[1];
      if (bullet) out.push(bullet.trim());
      else if (out.length && !/^\d/.test(trimmed)) break;
    }
  }

  if (!out.length) {
    for (const aliases of Object.values(ROUND_ALIASES)) {
      for (const alias of aliases) {
        if (wordContains(text, alias)) {
          out.push(alias);
          break;
        }
      }
    }
  }

  return out;
}

export function extractTotalPositions(text: string, semanticValue?: number): number | null {
  if (typeof semanticValue === "number" && Number.isFinite(semanticValue) && semanticValue > 0 && !isBatchYear(semanticValue)) {
    return Math.floor(semanticValue);
  }
  const match =
    text.match(/\b(?:hiring|hire|openings?|vacancies|positions?)\D{0,12}(\d{1,4})\b/i) ??
    text.match(/\b(\d{1,4})\s+(?:openings?|vacancies|positions?|interns?)\b/i);
  if (match) {
    const value = Number(match[1]);
    if (!isBatchYear(value)) return value;
  }
  return null;
}

function isBatchYear(value: number): boolean {
  return Number.isInteger(value) && value >= 2000 && value <= 2100;
}

export function normalizePhone(raw: string | undefined): string | null {
  if (!raw) return null;
  const phone = raw.replace(/[^\d+]/g, "");
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 13) return null;
  if (phone.startsWith("+")) return `+${digits}`;
  return digits.length === 10 ? digits : `+${digits}`;
}
