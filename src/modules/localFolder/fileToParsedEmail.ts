import fs from "node:fs/promises";
import path from "node:path";
import { ParsedEmail } from "../../shared/types";
import { normalizeText } from "../normalization/normalizer";
import { parseMimeBuffer } from "../parser/mailExtractor";
import { DocumentTextExtractor } from "../parser/documentTextExtractor";

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"
};

const TEXT_EXTENSIONS = new Set([".txt", ".text", ".md"]);
const MIME_EXTENSIONS = new Set(Object.keys(MIME_BY_EXT));
const EML_EXTENSIONS = new Set([".eml", ".mime"]);

export function isSupportedIngestFileName(fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase();
  if (fileName.startsWith(".")) {
    return false;
  }
  return TEXT_EXTENSIONS.has(ext) || MIME_EXTENSIONS.has(ext) || EML_EXTENSIONS.has(ext);
}

function syntheticEmail(baseName: string, textBody: string): ParsedEmail {
  const cleaned = normalizeText(textBody);
  const id = `local:${baseName}`;
  return {
    messageId: id,
    threadId: "local-folder",
    subject: baseName,
    sender: "local@uploads",
    recipients: [],
    html: "",
    text: cleaned,
    cleanedText: cleaned,
    attachments: []
  };
}

export async function bufferToParsedEmail(
  originalName: string,
  buf: Buffer,
  extractor: DocumentTextExtractor
): Promise<ParsedEmail | null> {
  const baseName = path.basename(originalName);
  const ext = path.extname(baseName).toLowerCase();

  if (!isSupportedIngestFileName(baseName)) {
    return null;
  }

  if (EML_EXTENSIONS.has(ext)) {
    const id = `local:${path.basename(baseName, ext)}`;
    return parseMimeBuffer(id, "local-folder", buf, extractor);
  }

  if (TEXT_EXTENSIONS.has(ext)) {
    const textBody = buf.toString("utf-8");
    return syntheticEmail(path.basename(baseName, ext) || baseName, textBody);
  }

  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    return null;
  }

  const extracted = await extractor.parse(buf, mime);
  const stem = path.basename(baseName, ext) || baseName;
  return syntheticEmail(stem, extracted);
}

export async function fileToParsedEmail(
  absoluteFilePath: string,
  extractor: DocumentTextExtractor
): Promise<ParsedEmail | null> {
  const buf = await fs.readFile(absoluteFilePath);
  return bufferToParsedEmail(path.basename(absoluteFilePath), buf, extractor);
}
