import axios from "axios";
import { env } from "../../config/env";

export type SemanticExtraction = {
  company_name?: string;
  role?: string;
  roles?: string[];
  description?: string;
  location?: string;
  mode_of_work?: string;
  internship?: boolean;
  ppo?: boolean;
  service_agreement?: boolean;
  bond_period_months?: number;
  total_positions?: number;
  job_source?: string;
  ctc_lpa?: number;
  stipend?: number;
  minimum_cgpa?: number;
  max_allowed_backlogs?: number;
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
};

function safeParseJsonBlock(value: string): SemanticExtraction {
  const trimmed = value.trim();
  if (!trimmed) return {};
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return {};

  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as SemanticExtraction;
  } catch {
    return {};
  }
}

const SYSTEM_INSTRUCTION = [
  "You are an information extraction engine for Indian campus placement emails and recruiter PDFs.",
  "The final app schema is fixed, but you are returning semantic candidates for a deterministic validator. Do not invent facts.",
  "Prefer recruiter/JD/profile/signature evidence over college forwarding boilerplate.",
  "company_name: hiring organization semantically closest to the offered role.",
  "role: primary job title. If unknown, leave empty.",
  "description: concise recruiter-style summary, 3 to 6 sentences max, only from source text.",
  "location: city/state/country/office/remote/hybrid mentions.",
  "mode_of_work: Remote, Hybrid, Onsite, or empty string.",
  "internship: true for internship/intern/trainee/summer internship role, but not for merely preferred internship experience.",
  "ppo: true for PPO/pre-placement offer/conversion/full-time conversion when internship is true.",
  "service_agreement: true for service agreement, employment bond, mandatory commitment, or bond period.",
  "eligible_streams: broad departments like CSE, IT, ECE, EEE, EIE, Mechanical, Civil, MCA, BCA, AI & DS. Expand CS/IT and circuit branches.",
  "eligible_specialisations: AI/ML, Data Science, Cyber Security, Embedded Systems, etc.",
  "eligible_years: batch years like 2026 or labels like Final Year, 3rd Year.",
  "skills_required: mandatory, must-have, required skills only.",
  "preferred_skills: preferred, nice-to-have, bonus skills only.",
  "round_details: selection/interview process round names in order.",
  "job_source: campus, linkedin, referral, offcampus, or empty string. Default campus when placement/campus drive context is clear.",
  "For ctc_lpa, stipend, minimum_cgpa, max_allowed_backlogs, bond_period_months, total_positions, registration_link, deadline, contact_email, contact_phone: extract explicit candidates only; deterministic validation may override.",
  "additional_info: short notes for ambiguity, inferred branch groups, missing URL, recruiter instructions, unsupported fields.",
  "Return a single JSON object only, no markdown.",
  "Schema:",
  "{",
  '  "company_name": "string",',
  '  "role": "string",',
  '  "roles": ["string"],',
  '  "description": "string",',
  '  "location": "string",',
  '  "mode_of_work": "Remote|Hybrid|Onsite|string",',
  '  "internship": boolean,',
  '  "ppo": boolean,',
  '  "service_agreement": boolean,',
  '  "bond_period_months": number,',
  '  "total_positions": number,',
  '  "job_source": "string",',
  '  "ctc_lpa": number,',
  '  "stipend": number,',
  '  "minimum_cgpa": number,',
  '  "max_allowed_backlogs": number,',
  '  "eligible_streams": ["string"],',
  '  "eligible_specialisations": ["string"],',
  '  "eligible_years": ["string"],',
  '  "skills_required": ["string"],',
  '  "preferred_skills": ["string"],',
  '  "round_details": ["string"],',
  '  "registration_link": "string",',
  '  "deadline": "string",',
  '  "contact_email": "string",',
  '  "contact_phone": "string",',
  '  "additional_info": ["string"]',
  "}",
  "If a field is missing, use an empty string, -1 for numbers, false for booleans, or an empty array."
].join("\n");

export async function extractWithOllamaSemanticAssistant(text: string): Promise<SemanticExtraction> {
  if (!env.OLLAMA_ENABLED) {
    console.log("[Ollama] SKIPPED - OLLAMA_ENABLED is false");
    return {};
  }

  const inputSnippet = text.slice(0, 80).replace(/\n/g, " ");
  console.log(
    `[Ollama] Calling ${env.OLLAMA_MODEL} at ${env.OLLAMA_BASE_URL} (timeout ${env.OLLAMA_TIMEOUT_MS}ms) - input: "${inputSnippet}..."`
  );
  const startMs = Date.now();

  try {
    const response = await axios.post(
      `${env.OLLAMA_BASE_URL}/api/chat`,
      {
        model: env.OLLAMA_MODEL,
        stream: false,
        format: "json",
        messages: [
          { role: "system", content: SYSTEM_INSTRUCTION },
          { role: "user", content: `Input email text:\n${text}` }
        ],
        options: { temperature: 0.1 }
      },
      { timeout: env.OLLAMA_TIMEOUT_MS }
    );

    const elapsedMs = Date.now() - startMs;
    const rawOutput = String(response.data?.message?.content ?? response.data?.response ?? "");
    console.log(`[Ollama] Response received in ${(elapsedMs / 1000).toFixed(1)}s - raw length: ${rawOutput.length}`);
    const parsed = safeParseJsonBlock(rawOutput);
    console.log("[Ollama] Parsed extraction:", JSON.stringify(parsed, null, 2));
    return parsed;
  } catch (err: unknown) {
    const elapsedMs = Date.now() - startMs;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Ollama] FAILED after ${(elapsedMs / 1000).toFixed(1)}s - ${message}`);
    return {};
  }
}
