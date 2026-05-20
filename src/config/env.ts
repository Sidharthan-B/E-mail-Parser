import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

function parseEnvBool(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return defaultValue;
}

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(8080),
  NLP_PYTHON_CMD: z.string().default("python"),
  NLP_SERVICE_SCRIPT: z.string().default("python/gliner_service.py"),
  GEMINI_ENABLED: z.preprocess((v) => parseEnvBool(v, true), z.boolean()),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-1.5-flash"),
  GEMINI_TIMEOUT_MS: z.coerce.number().default(60000),
  UPLOAD_INBOX_DIR: z.string().default("uploads/inbox-job"),
  UPLOAD_OUTPUT_DIR: z.string().default("uploads/parsed-jobs"),
  UPLOAD_PROCESSED_DIR: z.string().default("uploads/processed-job"),
  COMPANY_INBOX_DIR: z.string().default("uploads/inbox-companies"),
  COMPANY_OUTPUT_DIR: z.string().default("uploads/parsed-companies"),
  RECRUITER_INBOX_DIR: z.string().default("uploads/inbox-recruiters"),
  RECRUITER_OUTPUT_DIR: z.string().default("uploads/parsed-recruiters"),
  APPROVAL_INBOX_DIR: z.string().default("uploads/inbox-approvals"),
  APPROVAL_OUTPUT_DIR: z.string().default("uploads/parsed-approvals")
});

export const env = envSchema.parse(process.env);
