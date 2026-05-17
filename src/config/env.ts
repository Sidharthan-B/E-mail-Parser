import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

/** Node env vars are strings; avoid z.coerce.boolean() which treats "false" as true. */
function parseEnvBool(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(s)) {
    return false;
  }
  return defaultValue;
}

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(8080),
  GMAIL_CLIENT_ID: z.string().optional(),
  GMAIL_CLIENT_SECRET: z.string().optional(),
  GMAIL_REDIRECT_URI: z.string().optional(),
  GMAIL_REFRESH_TOKEN: z.string().optional(),
  GMAIL_USER_ID: z.string().default("me"),
  NLP_PYTHON_CMD: z.string().default("python"),
  NLP_SERVICE_SCRIPT: z.string().default("python/gliner_service.py"),
  OLLAMA_ENABLED: z.preprocess((v) => parseEnvBool(v, false), z.boolean()),
  OLLAMA_BASE_URL: z.string().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().default("qwen2.5:7b-instruct"),
  OLLAMA_TIMEOUT_MS: z.coerce.number().default(120000),
  UPLOAD_INBOX_DIR: z.string().default("uploads/inbox"),
  UPLOAD_OUTPUT_DIR: z.string().default("uploads/parsed"),
  UPLOAD_PROCESSED_DIR: z.string().default("uploads/processed")
});

export const env = envSchema.parse(process.env);
