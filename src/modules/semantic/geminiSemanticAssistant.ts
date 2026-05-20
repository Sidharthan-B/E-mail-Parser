import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../../config/env";

export type SemanticRole = {
  company_name?: string;
  role?: string;
  description?: string;
  ctc_lpa?: number;
  stipend?: number;
  is_internship?: boolean;
  ppo?: boolean;
  skills_required?: string[];
  preferred_skills?: string[];
};

export type SemanticExtraction = {
  company_name?: string;
  role?: string;
  description?: string;
  location?: string;
  mode_of_work?: string;
  internship?: boolean;
  ppo?: boolean;
  service_agreement?: boolean;
  bond_period_months?: number;
  openings?: number;
  ctc_lpa?: number;
  stipend?: number;
  minimum_cgpa?: number;
  max_allowed_backlogs?: number;
  eligible_departments?: Array<{ department: string; specialisation?: string | null }>;
  eligible_streams?: string[];
  eligible_specialisations?: string[];
  eligible_years?: string[];
  eligible_branches?: string[];
  skills_required?: string[];
  preferred_skills?: string[];
  round_details?: string[];
  registration_link?: string;
  deadline?: string;
  contact_email?: string;
  contact_phone?: string;
  additional_info?: string[];
  /** Populated when the document contains multiple distinct job roles. */
  roles?: SemanticRole[];
};

const EXPECTED_KEYS = new Set([
  "company_name", "role", "description", "location", "mode_of_work",
  "internship", "ppo", "service_agreement", "bond_period_months", "openings",
  "ctc_lpa", "stipend", "minimum_cgpa", "max_allowed_backlogs",
  "eligible_departments", "eligible_streams", "eligible_specialisations",
  "eligible_years", "eligible_branches",
  "skills_required", "preferred_skills", "round_details",
  "registration_link", "deadline", "contact_email", "contact_phone",
  "additional_info", "roles"
]);

const FIELD_ALIASES: Record<string, keyof SemanticExtraction> = {
  organization: "company_name", company: "company_name", recruiter: "company_name",
  job_role: "role", position: "role", title: "role",
  job_description: "description", about_role: "description",
  work_location: "location", job_location: "location",
  work_mode: "mode_of_work", employment_type: "mode_of_work",
  is_internship: "internship",
  ppo_available: "ppo",
  has_bond: "service_agreement", bond: "service_agreement",
  total_positions: "openings", vacancies: "openings", positions: "openings",
  cgpa: "minimum_cgpa", min_cgpa: "minimum_cgpa",
  backlogs: "max_allowed_backlogs", allowed_backlogs: "max_allowed_backlogs",
  streams: "eligible_streams", departments: "eligible_streams",
  specialisations: "eligible_specialisations", specializations: "eligible_specialisations",
  batch_years: "eligible_years", graduating_year: "eligible_years",
  branches: "eligible_branches",
  required_skills: "skills_required", mandatory_skills: "skills_required",
  nice_to_have: "preferred_skills", good_to_have: "preferred_skills",
  selection_process: "round_details", interview_rounds: "round_details", rounds: "round_details",
  apply_link: "registration_link", application_link: "registration_link", register_link: "registration_link",
  last_date: "deadline", apply_by: "deadline", last_date_to_apply: "deadline",
  email: "contact_email", hr_email: "contact_email",
  phone: "contact_phone", contact_number: "contact_phone", mobile: "contact_phone",
  additional_information: "additional_info", notes: "additional_info",
  job_roles: "roles", positions_list: "roles", openings_list: "roles",
};

const ROLE_ENTRY_ALIASES: Record<string, keyof SemanticRole> = {
  job_role: "role", position: "role", title: "role", job_title: "role",
  organization: "company_name", company: "company_name",
  job_description: "description", about_role: "description",
  is_internship: "is_internship",
  ppo_available: "ppo",
  required_skills: "skills_required", mandatory_skills: "skills_required",
  nice_to_have: "preferred_skills", good_to_have: "preferred_skills",
};

const ROLE_ENTRY_KEYS = new Set<string>([
  "company_name", "role", "description", "ctc_lpa", "stipend",
  "is_internship", "ppo", "skills_required", "preferred_skills"
]);

function normaliseRoleEntry(raw: Record<string, unknown>): SemanticRole {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const lower = k.toLowerCase().replace(/\s+/g, "_");
    if (ROLE_ENTRY_KEYS.has(lower)) {
      out[lower] = v;
    } else if (ROLE_ENTRY_ALIASES[lower] && !(ROLE_ENTRY_ALIASES[lower] in out)) {
      out[ROLE_ENTRY_ALIASES[lower]] = v;
    }
  }
  return out as SemanticRole;
}

function normaliseKeys(raw: Record<string, unknown>): SemanticExtraction {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const lower = k.toLowerCase().replace(/\s+/g, "_");
    if (EXPECTED_KEYS.has(lower)) {
      out[lower] = v;
    } else if (FIELD_ALIASES[lower]) {
      const canonical = FIELD_ALIASES[lower];
      if (!(canonical in out)) out[canonical] = v;
    }
  }
  // Normalise keys inside each roles[] entry
  if (Array.isArray(out.roles)) {
    out.roles = (out.roles as unknown[])
      .filter((r) => typeof r === "object" && r !== null)
      .map((r) => normaliseRoleEntry(r as Record<string, unknown>));
  }
  return out as SemanticExtraction;
}

function safeParseJsonBlock(value: string): SemanticExtraction {
  const trimmed = value.trim();
  if (!trimmed) return {};
  
  // Remove markdown code blocks if present
  let jsonText = trimmed;
  if (jsonText.startsWith("```json")) {
    jsonText = jsonText.replace(/^```json\s*/, "").replace(/\s*```$/, "");
  } else if (jsonText.startsWith("```")) {
    jsonText = jsonText.replace(/^```\s*/, "").replace(/\s*```$/, "");
  }
  
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return {};
  
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText.slice(start, end + 1));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const obj = parsed as Record<string, unknown>;

  const topKeys = Object.keys(obj);
  const knownTopLevel = topKeys.filter((k) => EXPECTED_KEYS.has(k) || k in FIELD_ALIASES);
  if (knownTopLevel.length > 0) return normaliseKeys(obj);

  if (topKeys.length === 1) {
    const inner = obj[topKeys[0]];
    if (typeof inner === "object" && inner !== null) {
      return normaliseKeys(inner as Record<string, unknown>);
    }
  }

  const merged: Record<string, unknown> = {};
  for (const v of Object.values(obj)) {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      Object.assign(merged, v);
    }
  }
  return normaliseKeys(merged);
}

const SYSTEM_INSTRUCTION = `You are an information extraction engine for Indian campus placement emails, recruiter PDFs, and job description documents.

Your output feeds a deterministic validator that maps to a placement database. Extract only what is explicitly stated. Do NOT invent facts.

## Field rules

**company_name**: Hiring organisation name.
**role**: Primary job title. Concise — strip trailing "Fresher", "Qualifications:" etc.
**description**: 3–6 sentence role summary strictly from source text.
**location**: City/office. Strip non-location text (employment type, CTC, etc.).
**mode_of_work**: "Work From Home", "Hybrid", "Office", or "".
**internship** / **ppo**: booleans.
**service_agreement** / **bond_period_months**: bond details.
**ctc_lpa**: Annual CTC in LPA as decimal. Ranges: take lower bound.
**stipend**: Monthly stipend in INR as integer.
**minimum_cgpa**: 0–10 scale. Convert percentage by dividing by 10.
**max_allowed_backlogs**: 0 = no backlogs. -1 = not mentioned.
**openings**: Only fill with an explicit integer when a specific number of vacancies/openings is stated. Leave -1 otherwise.

**eligible_departments**: Array of objects. Each object has:
  - "department": canonical dept code (CSE, IT, ECE, EEE, EIE, Mechanical, Civil, MCA, BCA, ISE)
  - "specialisation": sub-specialisation if mentioned for that dept (e.g. "AI/ML", "Cyber Security", "VLSI", "Embedded Systems", "IT Security"), else null
  Examples: CSE with AI/ML → {"department":"CSE","specialisation":"AI/ML"}
            plain ECE → {"department":"ECE","specialisation":null}
            IT Security → {"department":"IT","specialisation":"IT Security"}
If department info is not available as structured, also populate eligible_streams as a flat list.

**eligible_streams**: Flat dept codes as fallback when structured eligible_departments is not possible.
**eligible_years**: Graduation batch years ("2026") or labels ("Final Year").
**skills_required**: Mandatory skills only — short names.
**preferred_skills**: Nice-to-have skills.
**round_details**: Selection process steps in order.
**registration_link** / **deadline**: Exact URL and date string as found. No construction.
**contact_email** / **contact_phone**: Recruiter/HR only — not placement cell.
**additional_info**: Actual anecdotal info missed by other fields (internship duration, bond details, extra notes from recruiter). Do NOT put extraction confidence notes here.

## Multi-role emails
If the document lists MULTIPLE distinct job roles, populate the **roles** array with one entry per role. Rules:
- One entry per role title. If the same role title appears under TWO different companies, create TWO separate entries — one for each company with the correct company_name.
- Each entry must have at minimum "role" and "company_name". Set company_name to the specific company that is hiring for that role.
- Override per-role fields: description, ctc_lpa, stipend, skills_required, preferred_skills, is_internship, ppo.
- Leave top-level fields for shared info (location, rounds, deadline, eligible_departments, eligible_years).
- Count carefully: if you see 4 roles for Company A and 2 roles for Company B, the roles array must have 6 entries.
- If single role or single company with one role, leave roles as [].

roles entry schema:
{"company_name":"string","role":"string","description":"string","ctc_lpa":-1,"stipend":-1,"is_internship":false,"ppo":false,"skills_required":[],"preferred_skills":[]}

## Format variants
- Plain-text campus forwarding: "Profile:", "CTC:", "CGPA:", "Batch:", "Eligible Branches:"
- PDF JDs: headings like "About the Role", "Eligibility", "Selection Process"
- Recruiter outreach: semi-structured prose
- TPO-format tables: key-value pairs with pipes or dashes

## Output
Single JSON object only. No markdown. No explanation.
Missing text → "". Missing numbers → -1. Missing booleans → false. Missing arrays → [].

{
  "company_name": "",
  "role": "",
  "description": "",
  "location": "",
  "mode_of_work": "",
  "internship": false,
  "ppo": false,
  "service_agreement": false,
  "bond_period_months": -1,
  "openings": -1,
  "ctc_lpa": -1,
  "stipend": -1,
  "minimum_cgpa": -1,
  "max_allowed_backlogs": -1,
  "eligible_departments": [],
  "eligible_streams": [],
  "eligible_years": [],
  "skills_required": [],
  "preferred_skills": [],
  "round_details": [],
  "registration_link": "",
  "deadline": "",
  "contact_email": "",
  "contact_phone": "",
  "additional_info": [],
  "roles": []
}`;

/**
 * Drop email envelope noise so the model's context is used for job-description content.
 * Strips Gmail export headers, long recipient lists, and Gmail URL lines.
 */
function stripEmailHeaders(text: string): string {
  const lines = text.split(/\n/);

  // Find the first line that looks like actual content (greeting or company/role info)
  const contentStart = lines.findIndex((l) =>
    /^\s*(dear|greetings|hi\s|hello\s|subject\s*:|company\s*:|profile\s*:|role\s*\d*\s*:|we\s+are\s+(pleased|hiring|inviting))/i.test(l)
  );

  const relevant = contentStart > 0 ? lines.slice(contentStart) : lines;

  return relevant
    .filter((l) => !/^https?:\/\/mail\.google\.com\//i.test(l.trim()))
    .join("\n");
}

export async function extractWithGeminiSemanticAssistant(text: string): Promise<SemanticExtraction> {
  if (!env.GEMINI_ENABLED) {
    console.log("[Gemini] SKIPPED - GEMINI_ENABLED is false");
    return {};
  }

  if (!env.GEMINI_API_KEY) {
    console.log("[Gemini] SKIPPED - GEMINI_API_KEY not provided");
    return {};
  }

  const inputSnippet = text.slice(0, 80).replace(/\n/g, " ");
  console.log(`[Gemini] Calling ${env.GEMINI_MODEL} — "${inputSnippet}..."`);
  const startMs = Date.now();

  try {
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ 
      model: env.GEMINI_MODEL,
      generationConfig: {
        temperature: 0.05,
        maxOutputTokens: 4096,
      }
    });

    const prompt = `${SYSTEM_INSTRUCTION}\n\nExtract placement information from the following text:\n\n${stripEmailHeaders(text).slice(0, 6000)}`;
    
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const rawOutput = response.text();

    const elapsedMs = Date.now() - startMs;
    console.log(`[Gemini] Response in ${(elapsedMs / 1000).toFixed(1)}s, length: ${rawOutput.length}`);
    
    const parsed = safeParseJsonBlock(rawOutput);
    console.log("[Gemini] Parsed:", JSON.stringify(parsed, null, 2));
    return parsed;
  } catch (err: unknown) {
    const elapsedMs = Date.now() - startMs;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Gemini] FAILED after ${(elapsedMs / 1000).toFixed(1)}s — ${message}`);
    return {};
  }
}