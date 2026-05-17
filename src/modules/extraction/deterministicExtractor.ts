import { normalizeBacklogCount, normalizeMonthlyMoney, normalizePhone, normalizeSalaryToLpa } from "../normalization/normalizer";

function firstDeadlineToken(raw: string): string {
  const trimmed = raw.trim();
  const m =
    trimmed.match(/\d{1,2}[-/][A-Za-z]{3,9}[-/]\d{2,4}(?:,\s*\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM))?/i) ??
    trimmed.match(/\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}(?:,\s*\d{1,2}:\d{2}\s*(?:AM|PM))?/i);
  return m ? m[0].trim() : trimmed.split(/\s{2,}/)[0]?.trim() ?? trimmed;
}

function extractDeadlineRaw(text: string): string {
  const lines = text.split(/\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!/(deadline|last date to apply|last date|apply by|registration closes?|registration\s+end\s+date|register\s+by)/i.test(line)) {
      continue;
    }
    const sameLine = line.replace(/.*?(?:last date to apply|registration\s+end\s+date|registration closes?|register\s+by|apply by|deadline|last date)\s*[:\-]?\s*/i, "").trim();
    const candidate = /\d/.test(sameLine) ? sameLine : lines[index + 1]?.trim() || "";
    if (candidate) return firstDeadlineToken(candidate);
  }
  return "";
}

export type DeterministicExtraction = {
  minCgpa: number | null;
  ctcLpa: number | null;
  stipendMonthly: number | null;
  allowedBacklogs: number | null;
  deadline: string;
  applicationLink: string;
  recruiterEmail: string;
  contactPhone: string | null;
  bondPeriodMonths: number | null;
  totalPositions: number | null;
  sourceSignals: Record<string, string>;
};

function extractSalary(text: string): { ctcLpa: number | null; signal: string } {
  const salaryLines = text.split(/\n/).filter((line) => /(?:ctc|salary|package|compensation|lpa|inr|rs\.?|₹)/i.test(line));

  for (const line of salaryLines) {
    if (/stipend/i.test(line) && !/\bctc\b/i.test(line)) continue;
    const val = normalizeSalaryToLpa(line);
    if (val !== null && val >= 1 && val <= 200) return { ctcLpa: val, signal: "regex" };
  }

  return { ctcLpa: null, signal: "missing" };
}

function extractStipend(text: string): { stipendMonthly: number | null; signal: string } {
  const stipendLines = text.split(/\n/).filter((line) => /stipend|per\s+month|\/\s*month|monthly/i.test(line));
  for (const line of stipendLines) {
    const value = normalizeMonthlyMoney(line);
    if (value !== null && value >= 1000 && value <= 500000) return { stipendMonthly: value, signal: "regex" };
  }
  return { stipendMonthly: null, signal: "missing" };
}

function extractCgpa(text: string): { minCgpa: number | null; signal: string } {
  const cgpa = text.match(/(?:cgpa|cpi)[^\d]{0,30}(\d{1,2}(?:\.\d+)?)/i);
  if (cgpa) {
    const value = Number(cgpa[1]);
    if (value >= 0 && value <= 10) return { minCgpa: value, signal: "regex" };
    if (value > 10 && value <= 100) return { minCgpa: Number((value / 10).toFixed(1)), signal: "regex-percent" };
  }

  const percent = text.match(/(?:aggregate|percentage|eligibility|throughout|10th\s+to\s+ug)[^\d]{0,30}(\d{2}(?:\.\d+)?)\s*%/i);
  if (percent) {
    const value = Number(percent[1]);
    if (value > 0 && value <= 100) return { minCgpa: Number((value / 10).toFixed(1)), signal: "regex-percent" };
  }

  return { minCgpa: null, signal: "missing" };
}

function extractRecruiterEmail(text: string): { email: string; signal: string } {
  const emails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  const unique = [...new Set(emails.map((email) => email.trim()))];
  const recruiter = unique.find(
    (email) =>
      !/(placement|placements|tpo|training|college|university|edu\.|ac\.|\.edu|\.ac\.in|gmail\.com|yahoo\.com|outlook\.com|hotmail\.com)/i.test(email)
  );
  return { email: recruiter ?? "", signal: recruiter ? "regex" : "missing" };
}

function extractContactPhone(text: string): { phone: string | null; signal: string } {
  const phoneMatch = text.match(/(?:\+91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/) ?? text.match(/\b0\d{10}\b/);
  const phone = normalizePhone(phoneMatch?.[0]);
  return { phone, signal: phone ? "regex" : "missing" };
}

function extractBondPeriod(text: string): { months: number | null; signal: string } {
  const match =
    text.match(/(\d+(?:\.\d+)?)\s*(months?|years?)\s+(?:service\s+agreement|bond|commitment|mandatory\s+agreement)/i) ??
    text.match(/(?:service\s+agreement|bond|commitment|mandatory\s+agreement)\D{0,20}(\d+(?:\.\d+)?)\s*(months?|years?)/i);
  if (!match) return { months: null, signal: "missing" };
  const amount = Number(match[1]);
  return { months: match[2].toLowerCase().startsWith("year") ? Math.round(amount * 12) : Math.round(amount), signal: "regex" };
}

function extractTotalPositions(text: string): { totalPositions: number | null; signal: string } {
  const match =
    text.match(/\b(?:hiring|hire|openings?|vacancies|positions?)\D{0,12}(\d{1,4})\b/i) ??
    text.match(/\b(\d{1,4})\s+(?:openings?|vacancies|positions?|interns?)\b/i);
  if (match) {
    const value = Number(match[1]);
    if (!(Number.isInteger(value) && value >= 2000 && value <= 2100)) {
      return { totalPositions: value, signal: "regex" };
    }
  }
  return { totalPositions: /\b(role|position|hiring|recruitment|internship|drive)\b/i.test(text) ? 1 : null, signal: "implied" };
}

export function extractDeterministic(text: string): DeterministicExtraction {
  const { minCgpa, signal: cgpaSignal } = extractCgpa(text);
  const { ctcLpa, signal: salarySignal } = extractSalary(text);
  const { stipendMonthly, signal: stipendSignal } = extractStipend(text);
  const { email, signal: emailSignal } = extractRecruiterEmail(text);
  const { phone, signal: phoneSignal } = extractContactPhone(text);
  const { months, signal: bondSignal } = extractBondPeriod(text);
  const { totalPositions, signal: positionsSignal } = extractTotalPositions(text);

  const deadlineRaw = extractDeadlineRaw(text);
  const backlogMatch = text.match(
    /(no\s+(?:active|standing)?\s*backlogs?|no\s+standing\s+arrears|(?:max(?:imum)?|up\s+to|allowed|not\s+(?:have\s+)?more\s+than|more\s+than)\D{0,20}\d+\s+(?:active\s+)?(?:backlogs?|arrears?))/i
  );
  const backlogCount = normalizeBacklogCount(backlogMatch?.[1], text);
  const registrationMatch = text.match(/https?:\/\/[^\s)]+/i);
  return {
    minCgpa,
    ctcLpa,
    stipendMonthly,
    allowedBacklogs: backlogCount >= 0 ? backlogCount : null,
    deadline: deadlineRaw,
    applicationLink: registrationMatch?.[0]?.trim() ?? "",
    recruiterEmail: email,
    contactPhone: phone,
    bondPeriodMonths: months,
    totalPositions,
    sourceSignals: {
      min_cgpa: cgpaSignal,
      ctc: salarySignal,
      stipend: stipendSignal,
      allowed_backlogs: backlogCount >= 0 ? "regex" : "missing",
      current_deadline: deadlineRaw ? "regex" : "missing",
      application_link: registrationMatch ? "regex" : "missing",
      recruiter_email: emailSignal,
      contact_phone: phoneSignal,
      bond_period_months: bondSignal,
      total_positions: positionsSignal
    }
  };
}
