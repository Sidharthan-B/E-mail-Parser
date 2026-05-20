import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../../config/env";

export type CompanyEntity = {
  name: string | null;
  description: string | null;
  website: string | null;
  linkedin_url: string | null;
  company_email: string | null;
  location: string | null;
  industry: string | null;
  top_ctc: string | null;
};

const SYSTEM_PROMPT = `You are an information extraction engine for company profile documents, brochures, and recruiter emails.

Extract company details into the following JSON schema. Only extract what is explicitly stated. Do NOT invent facts.

Fields:
- name: Full legal/brand name of the company.
- description: 2-4 sentence summary of what the company does, from source text only.
- website: Official website URL. Exact as found, no construction.
- linkedin_url: LinkedIn company page URL. Exact as found.
- company_email: Official company contact/HR email address.
- location: Headquarters or primary office city/country.
- industry: Industry sector (e.g. "Software", "FinTech", "Healthcare", "E-Commerce").
- top_ctc: Highest CTC offered as a string exactly as stated (e.g. "12 LPA", "18-24 LPA").

Output a single JSON object only. No markdown. No explanation.
Missing text → null. Missing URLs → null.

{
  "name": null,
  "description": null,
  "website": null,
  "linkedin_url": null,
  "company_email": null,
  "location": null,
  "industry": null,
  "top_ctc": null
}`;

function safeParseJson(raw: string): CompanyEntity {
  let text = raw.trim();
  if (text.startsWith("```json")) text = text.replace(/^```json\s*/, "").replace(/\s*```$/, "");
  else if (text.startsWith("```")) text = text.replace(/^```\s*/, "").replace(/\s*```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return emptyEntity();
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    return {
      name: str(parsed.name),
      description: str(parsed.description),
      website: str(parsed.website),
      linkedin_url: str(parsed.linkedin_url),
      company_email: str(parsed.company_email),
      location: str(parsed.location),
      industry: str(parsed.industry),
      top_ctc: str(parsed.top_ctc),
    };
  } catch {
    return emptyEntity();
  }
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

function emptyEntity(): CompanyEntity {
  return { name: null, description: null, website: null, linkedin_url: null, company_email: null, location: null, industry: null, top_ctc: null };
}

export async function extractCompany(text: string): Promise<CompanyEntity> {
  if (!env.GEMINI_ENABLED || !env.GEMINI_API_KEY) return emptyEntity();

  console.log(`[Gemini/Company] Calling ${env.GEMINI_MODEL}`);
  const start = Date.now();
  try {
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: env.GEMINI_MODEL, generationConfig: { temperature: 0.05, maxOutputTokens: 1024 } });
    const result = await model.generateContent(`${SYSTEM_PROMPT}\n\nExtract company information from:\n\n${text.slice(0, 6000)}`);
    const raw = result.response.text();
    console.log(`[Gemini/Company] Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
    return safeParseJson(raw);
  } catch (err) {
    console.error(`[Gemini/Company] FAILED — ${err instanceof Error ? err.message : String(err)}`);
    return emptyEntity();
  }
}
