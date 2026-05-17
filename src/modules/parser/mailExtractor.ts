import { simpleParser } from "mailparser";
import { DocumentTextExtractor } from "./documentTextExtractor";
import { cleanHtmlToText } from "./htmlCleaner";
import { normalizeText } from "../normalization/normalizer";
import { ParsedAttachment, ParsedEmail } from "../../shared/types";

function toRecipients(parsedTo: unknown): string[] {
  if (!parsedTo) {
    return [];
  }
  if (Array.isArray(parsedTo)) {
    return parsedTo
      .flatMap((entry) => (entry?.value && Array.isArray(entry.value) ? entry.value : []))
      .map((recipient: { address?: string }) => recipient.address ?? "")
      .filter(Boolean);
  }
  if ((parsedTo as { value?: unknown }).value && Array.isArray((parsedTo as { value?: unknown }).value)) {
    return ((parsedTo as { value: Array<{ address?: string }> }).value ?? [])
      .map((recipient) => recipient.address ?? "")
      .filter(Boolean);
  }
  return [];
}

export async function parseMimeBuffer(
  messageId: string,
  threadId: string,
  rawMime: Buffer,
  attachmentExtractor: DocumentTextExtractor
): Promise<ParsedEmail> {
  const parsed = await simpleParser(rawMime);

  const html = parsed.html ? String(parsed.html) : "";
  const text = parsed.text ? String(parsed.text) : "";

  const extractedAttachments: ParsedAttachment[] = [];
  for (const item of parsed.attachments) {
    const mimeType = item.contentType ?? "";
    let attachmentText = "";
    if (item.content) {
      attachmentText = await attachmentExtractor.parse(item.content, mimeType);
    }
    extractedAttachments.push({
      fileName: item.filename ?? "unknown",
      mimeType,
      text: attachmentText
    });
  }

  const cleanedHtml = cleanHtmlToText(html);
  const mergedText = normalizeText([text, cleanedHtml, ...extractedAttachments.map((a) => a.text)].join("\n"));

  return {
    messageId,
    threadId,
    subject: parsed.subject ?? "",
    sender: parsed.from?.text ?? "",
    recipients: toRecipients(parsed.to),
    html,
    text,
    cleanedText: mergedText,
    attachments: extractedAttachments
  };
}

export async function parseRawMime(
  messageId: string,
  threadId: string,
  rawMime: string,
  attachmentExtractor: DocumentTextExtractor
): Promise<ParsedEmail> {
  return parseMimeBuffer(messageId, threadId, Buffer.from(rawMime, "utf-8"), attachmentExtractor);
}
