import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../../config/env";

export type RecruiterProfileEntity = {
  designation: string | null;
  linkedin_url: string | null;
  email: string | null;
  phone_no: string | null;
};

const SYSTEM_PROMPT = `You are an information extraction engine for recruiter contact documents, email signatures, and business cards.

Extract recruiter contact details into the following JSON schema. Only extract what is explicitly stated. Do NOT invent facts.

Fields:
- designation: Job title of the recruiter (e.g. "HR Manager", "Talent Acquisition Specialist", "Campus Recruiter").
- linkedin_url: LinkedIn profile URL of the recruiter. Exact as found.
- email: Email address of the recruiter. Prefer personal/professional email over generic company addresses.
- phone_no: Phone number of the recruiter, including country code if present. Exact as found.

Output a single JSON object only. No markdown. No explanation.
Missing values → null.

{
  "designation": null,
  "linkedin_url": null,
  "email": null,
  "phone_no": null
}`;

function safeParseJson(raw: string): RecruiterProfileEntity {
  let text = raw.trim();
  if (text.startsWith("```json")) text = text.replace(/^```json\s*/, "").replace(/\s*```$/, "");
  else if (text.startsWith("```")) text = text.replace(/^```\s*/, "").replace(/\s*```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return emptyEntity();
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    return {
      designation: str(parsed.designation),
      linkedin_url: str(parsed.linkedin_url),
      email: str(parsed.email),
      phone_no: str(parsed.phone_no),
    };
  } catch {
    return emptyEntity();
  }
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

function emptyEntity(): RecruiterProfileEntity {
  return { designation: null, linkedin_url: null, email: null, phone_no: null };
}

export async function extractRecruiterProfile(text: string): Promise<RecruiterProfileEntity> {
  if (!env.GEMINI_ENABLED || !env.GEMINI_API_KEY) return emptyEntity();

  console.log(`[Gemini/Recruiter] Calling ${env.GEMINI_MODEL}`);
  const start = Date.now();
  try {
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: env.GEMINI_MODEL, generationConfig: { temperature: 0.05, maxOutputTokens: 512 } });
    const result = await model.generateContent(`${SYSTEM_PROMPT}\n\nExtract recruiter details from:\n\n${text.slice(0, 4000)}`);
    const raw = result.response.text();
    console.log(`[Gemini/Recruiter] Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
    return safeParseJson(raw);
  } catch (err) {
    console.error(`[Gemini/Recruiter] FAILED — ${err instanceof Error ? err.message : String(err)}`);
    return emptyEntity();
  }
}
