import fs from "node:fs/promises";
import path from "node:path";
import { DocumentTextExtractor } from "../parser/documentTextExtractor";
import { bufferToParsedEmail, isSupportedIngestFileName } from "./fileToParsedEmail";

export type TypedInboxResult = {
  inboxDir: string;
  outputDir: string;
  processed: Array<{ input: string; output: string }>;
  errors: Array<{ input: string; error: string }>;
};

function resolveDir(p: string): string {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(process.cwd(), p);
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "object" && e !== null) {
    const r = e as Record<string, unknown>;
    return (typeof r.message === "string" && r.message) || (typeof r.code === "string" && r.code) || String(e);
  }
  return String(e);
}

export async function processTypedInbox<T extends object>(
  inboxDirRaw: string,
  outputDirRaw: string,
  extractFn: (text: string) => Promise<T>
): Promise<TypedInboxResult> {
  const inboxDir = resolveDir(inboxDirRaw);
  const outputDir = resolveDir(outputDirRaw);

  await fs.mkdir(inboxDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });

  const processed: TypedInboxResult["processed"] = [];
  const errors: TypedInboxResult["errors"] = [];
  const extractor = new DocumentTextExtractor();

  let names: string[];
  try {
    names = await fs.readdir(inboxDir);
  } catch (e) {
    return { inboxDir, outputDir, processed, errors: [{ input: inboxDir, error: errMsg(e) }] };
  }

  for (const name of names) {
    if (!isSupportedIngestFileName(name)) continue;

    const inputPath = path.join(inboxDir, name);
    try {
      const st = await fs.stat(inputPath);
      if (!st.isFile()) continue;
    } catch (e) {
      errors.push({ input: name, error: errMsg(e) });
      continue;
    }

    try {
      const buf = await fs.readFile(inputPath);
      const parsed = await bufferToParsedEmail(name, buf, extractor);
      if (!parsed) {
        errors.push({ input: name, error: "unsupported or empty file" });
        continue;
      }

      const entity = await extractFn(parsed.cleanedText);
      const basename = path.basename(name, path.extname(name));
      const outPath = path.join(outputDir, `${basename}.json`);
      await fs.writeFile(outPath, `${JSON.stringify(entity, null, 2)}\n`, "utf-8");
      processed.push({ input: inputPath, output: outPath });
    } catch (e) {
      errors.push({ input: name, error: errMsg(e) });
    }
  }

  return { inboxDir, outputDir, processed, errors };
}
