import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env";
import { runExtractionPipeline } from "../parser/pipeline";
import { DocumentTextExtractor } from "../parser/documentTextExtractor";
import { fileToParsedEmail, isSupportedIngestFileName } from "./fileToParsedEmail";

function errorToMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const rec = error as Record<string, unknown>;
    const msg = rec.message;
    if (typeof msg === "string" && msg.trim()) {
      return msg;
    }
    const code = rec.code;
    if (typeof code === "string" && code.trim()) {
      return code;
    }
  }
  if (error instanceof Error) {
    return error.message || error.name || "Error";
  }
  return String(error);
}

export type ProcessInboxItemOk = {
  input: string;
  outputs: string[];
  movedTo?: string;
};

export type ProcessInboxItemErr = {
  input: string;
  error: string;
};

export type ProcessInboxResult = {
  inboxDir: string;
  outputDir: string;
  processed: ProcessInboxItemOk[];
  errors: ProcessInboxItemErr[];
};

function resolveDir(relativeOrAbsolute: string): string {
  return path.isAbsolute(relativeOrAbsolute)
    ? path.normalize(relativeOrAbsolute)
    : path.resolve(process.cwd(), relativeOrAbsolute);
}

export async function processLocalInbox(options?: {
  moveToProcessed?: boolean;
}): Promise<ProcessInboxResult> {
  const moveToProcessed = options?.moveToProcessed ?? false;
  const inboxDir = resolveDir(env.UPLOAD_INBOX_DIR);
  const outputDir = resolveDir(env.UPLOAD_OUTPUT_DIR);
  const processedDir = resolveDir(env.UPLOAD_PROCESSED_DIR);

  await fs.mkdir(inboxDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
  if (moveToProcessed) {
    await fs.mkdir(processedDir, { recursive: true });
  }

  const processed: ProcessInboxItemOk[] = [];
  const errors: ProcessInboxItemErr[] = [];
  const extractor = new DocumentTextExtractor();

  let names: string[];
  try {
    names = await fs.readdir(inboxDir);
  } catch (e) {
    return { inboxDir, outputDir, processed, errors: [{ input: inboxDir, error: errorToMessage(e) }] };
  }

  for (const name of names) {
    if (!isSupportedIngestFileName(name)) {
      continue;
    }

    const inputPath = path.join(inboxDir, name);
    let st: Awaited<ReturnType<typeof fs.stat>>;
    try {
      st = await fs.stat(inputPath);
    } catch (e) {
      errors.push({
        input: name,
        error: errorToMessage(e)
      });
      continue;
    }
    if (!st.isFile()) {
      continue;
    }

    try {
      const email = await fileToParsedEmail(inputPath, extractor);
      if (!email) {
        errors.push({ input: name, error: "unsupported or empty file" });
        continue;
      }

      const entities = await runExtractionPipeline(email);
      const basename = path.basename(name, path.extname(name));
      const outputs: string[] = [];

      for (let i = 0; i < entities.length; i++) {
        const suffix = entities.length > 1 ? `-${i + 1}` : "";
        const jsonName = `${basename}${suffix}.json`;
        const outPath = path.join(outputDir, jsonName);
        await fs.writeFile(outPath, `${JSON.stringify(entities[i], null, 2)}\n`, "utf-8");
        outputs.push(outPath);
      }

      const ok: ProcessInboxItemOk = {
        input: inputPath,
        outputs
      };

      if (moveToProcessed) {
        const dest = path.join(processedDir, name);
        await fs.rename(inputPath, dest);
        ok.movedTo = dest;
      }

      processed.push(ok);
    } catch (e) {
      errors.push({
        input: name,
        error: errorToMessage(e)
      });
    }
  }

  return { inboxDir, outputDir, processed, errors };
}

export async function listInboxFiles(): Promise<{ inboxDir: string; files: string[] }> {
  const inboxDir = resolveDir(env.UPLOAD_INBOX_DIR);
  await fs.mkdir(inboxDir, { recursive: true });
  const names = await fs.readdir(inboxDir);
  const supported = names.filter((n) => isSupportedIngestFileName(n));
  const files: string[] = [];
  for (const n of supported) {
    const p = path.join(inboxDir, n);
    try {
      if ((await fs.stat(p)).isFile()) {
        files.push(n);
      }
    } catch {
      /* skip */
    }
  }
  return { inboxDir, files };
}
