/**
 * Regex / pattern fallbacks for Indian campus placement PDFs and emails
 * when GLiNER / profile-line heuristics miss structured fields.
 */

export type PlacementHeuristics = {
  company_name: string;
  role: string;
  eligible_branches: string[];
  job_type: string;
};

function trimWords(s: string, maxLen = 120): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > maxLen ? `${t.slice(0, maxLen)}…` : t;
}

export function extractPlacementHeuristics(text: string): PlacementHeuristics {
  const company = extractCompany(text);
  const role = extractRole(text);
  const eligible_branches = extractBranches(text);
  const job_type = inferJobTypeFromPlacement(text);
  return { company_name: company, role, eligible_branches, job_type };
}

function extractCompany(raw: string): string {
  const mConsult = raw.match(
    /\b([A-Za-z0-9][A-Za-z0-9&.,'\s]+?(?:India|Technologies|Labs|Limited|Ltd\.?|Inc\.?|LLP|Consulting|Solutions))\s+Consultative\s+Offerings\b/i
  );
  if (mConsult?.[1]) {
    return trimWords(mConsult[1].replace(/\s+Consultative.*$/i, "").trim(), 80);
  }

  const mDeloitte = raw.match(/\b(Deloitte\s+US\s+India|Deloitte\s+India|Deloitte)\b/i);
  if (mDeloitte?.[1]) {
    return mDeloitte[1].trim();
  }

  const mSuffix = raw.match(
    /\b([A-Z][A-Za-z0-9&.,'\s]{2,60}?(?:India|Technologies|Labs|Limited|Ltd\.?|Inc\.?|LLP))\b(?=[^\n]{0,80}(?:campus|placement|drive|recruit|JD|profile))/i
  );
  if (mSuffix?.[1]) {
    return trimWords(mSuffix[1], 80);
  }

  return "";
}

function extractRole(raw: string): string {
  const mOffer = raw.match(
    /Consultative\s+Offerings\s*[-–]\s*([^.\n]+?)(?:\s+JD|\s+or\s+Equivalent|\s*$)/i
  );
  if (mOffer?.[1]) {
    return trimWords(
      mOffer[1]
        .replace(/\s+or\s+Equivalent\b.*$/i, "")
        .replace(/\s+JD\s*$/i, "")
        .trim(),
      80
    );
  }

  const mEquiv = raw.match(/\b([A-Za-z][A-Za-z\s]+?)\s+or\s+Equivalent\b/i);
  if (mEquiv?.[1]) {
    return trimWords(mEquiv[1], 80);
  }

  const mProfile = raw.match(
    /(?:profile\s+being\s+offered|role\s*title|role|position)\s*[:\-]\s*([^\n]+)/i
  );
  if (mProfile?.[1]) {
    return trimWords(mProfile[1], 80);
  }

  return "";
}

function extractBranches(raw: string): string[] {
  const t = raw;
  const out = new Set<string>();

  const add = (code: string) => {
    const c = code.trim().toUpperCase();
    if (c) {
      out.add(c);
    }
  };

  if (/\bB\.?E\/B\.?Tech[-\s]*CS\/IT\b/i.test(t) || /\bB\.?Tech[-\s]*CS\s*\/\s*IT\b/i.test(t)) {
    add("CSE");
    add("IT");
  }
  if (/\bCS\s*\/\s*IT\b/i.test(t) && !out.has("CSE")) {
    add("CSE");
    add("IT");
  }
  if (/\bComputer\s+Science\b/i.test(t)) {
    add("CSE");
  }
  if (/\bInformation\s+Technology\b/i.test(t)) {
    add("IT");
  }
  if (/\ballied\s+CS\b/i.test(t) || /\ballied\s+computer\b/i.test(t)) {
    add("CSE");
  }
  if (/\bM\.?E\/M\.?Tech\b/i.test(t)) {
    if (/Computer\s+Science/i.test(t)) {
      add("CSE");
    }
    if (/Information\s+Technology/i.test(t)) {
      add("IT");
    }
  }
  if (/\bMCA\b/i.test(t)) {
    add("MCA");
  }
  if (/\bMechanical\b/i.test(t)) {
    add("ME");
  }
  if (/\bCivil\b/i.test(t)) {
    add("CIVIL");
  }
  if (/\ball\s+Circuit\s+Branches?\b/i.test(t)) {
    add("ECE");
    add("EEE");
  }
  if (/\bElectronics\s+and\s+Communication\b/i.test(t) || /\bECE\b/i.test(t)) {
    add("ECE");
  }
  if (/\bElectrical\b/i.test(t) || /\bEEE\b/i.test(t)) {
    add("EEE");
  }

  return [...out];
}

function inferJobTypeFromPlacement(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes("internship") || lower.includes(" summer intern")) {
    return "Internship";
  }
  if (lower.includes("full time") || lower.includes("full-time") || lower.includes("fulltime")) {
    return "Full Time";
  }
  if (
    !lower.includes("intern") &&
    (lower.includes("graduate") || lower.includes("campus hire")) &&
    (lower.includes("ctc") || lower.includes("lpa") || lower.includes("inr"))
  ) {
    return "Full Time";
  }
  if (lower.includes("campus hire")) {
    return "Full Time";
  }
  if (lower.includes("placement") && lower.includes("graduate") && !lower.includes("intern")) {
    return "Full Time";
  }
  return "";
}
