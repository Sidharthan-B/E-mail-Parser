import * as cheerio from "cheerio";

const SIGNATURE_HINTS = ["thanks", "regards", "confidential", "disclaimer", "do not reply"];

export function cleanHtmlToText(html: string): string {
  if (!html.trim()) {
    return "";
  }

  const $ = cheerio.load(html);
  $("style,script,img,svg,header,footer,nav").remove();
  $("blockquote").remove();

  const rawText = $("body").text() || $.text();
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => !SIGNATURE_HINTS.some((hint) => line.toLowerCase().includes(hint)));

  return lines
    .join("\n")
    .replace(/[•●▪◦]/g, "-")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
