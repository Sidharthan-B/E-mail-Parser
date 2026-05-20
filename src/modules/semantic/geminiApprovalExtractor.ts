import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../../config/env";

export type ApprovalEntity = {
  round: Record<string, unknown> | null;
  capacity: number | null;
  panel: number | null;
  suggested_dates_with_time: Array<{ date: string; time: string }>;
  mode: string | null;
  location: string | null;
};

const SYSTEM_PROMPT = `You are an information extraction engine for campus recruitment session approval requests.

Extract session/approval details into the following JSON schema. Only extract what is explicitly stated. Do NOT invent facts.

Fields:
- round: A JSON object describing the interview rounds. Structure:
    { "total": <number of rounds>, "details": [ { "name": "<round name>", "duration_minutes": <number or null> } ] }
  If rounds are not mentioned, use null.
- capacity: Maximum number of students/applicants allowed for the session. Integer only, null if not stated.
- panel: Number of panelists/interviewers the recruiter is bringing. Integer only, null if not stated.
- suggested_dates_with_time: Array of suggested date+time slots proposed by the recruiter.
    Each entry: { "date": "YYYY-MM-DD", "time": "HH:MM" } (24h format for time, ISO date for date).
    If only a date is given without time, use "00:00" for time. Empty array [] if none stated.
- mode: "Online" or "Offline". null if not stated.
- location: Venue/room/city if the session is offline, or platform name if online (e.g. "Zoom", "Room 204"). null if not stated.

Output a single JSON object only. No markdown. No explanation.

{
  "round": null,
  "capacity": null,
  "panel": null,
  "suggested_dates_with_time": [],
  "mode": null,
  "location": null
}`;

function safeParseJson(raw: string): ApprovalEntity {
  let text = raw.trim();
  if (text.startsWith("```json")) text = text.replace(/^```json\s*/, "").replace(/\s*```$/, "");
  else if (text.startsWith("```")) text = text.replace(/^```\s*/, "").replace(/\s*```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return emptyEntity();
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    return {
      round: typeof parsed.round === "object" && parsed.round !== null && !Array.isArray(parsed.round)
        ? (parsed.round as Record<string, unknown>)
        : null,
      capacity: positiveInt(parsed.capacity),
      panel: positiveInt(parsed.panel),
      suggested_dates_with_time: parseDates(parsed.suggested_dates_with_time),
      mode: parseMode(parsed.mode),
      location: str(parsed.location),
    };
  } catch {
    return emptyEntity();
  }
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

function positiveInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseMode(v: unknown): string | null {
  const s = str(v)?.toLowerCase();
  if (!s) return null;
  if (s.includes("online") || s.includes("virtual")) return "Online";
  if (s.includes("offline") || s.includes("in-person") || s.includes("onsite")) return "Offline";
  return null;
}

function parseDates(v: unknown): Array<{ date: string; time: string }> {
  if (!Array.isArray(v)) return [];
  return v
    .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
    .map((e) => ({ date: str(e.date) ?? "", time: str(e.time) ?? "00:00" }))
    .filter((e) => e.date);
}

function emptyEntity(): ApprovalEntity {
  return { round: null, capacity: null, panel: null, suggested_dates_with_time: [], mode: null, location: null };
}

export async function extractApproval(text: string): Promise<ApprovalEntity> {
  if (!env.GEMINI_ENABLED || !env.GEMINI_API_KEY) return emptyEntity();

  console.log(`[Gemini/Approval] Calling ${env.GEMINI_MODEL}`);
  const start = Date.now();
  try {
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: env.GEMINI_MODEL, generationConfig: { temperature: 0.05, maxOutputTokens: 1024 } });
    const result = await model.generateContent(`${SYSTEM_PROMPT}\n\nExtract approval/session request details from:\n\n${text.slice(0, 5000)}`);
    const raw = result.response.text();
    console.log(`[Gemini/Approval] Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
    return safeParseJson(raw);
  } catch (err) {
    console.error(`[Gemini/Approval] FAILED — ${err instanceof Error ? err.message : String(err)}`);
    return emptyEntity();
  }
}
