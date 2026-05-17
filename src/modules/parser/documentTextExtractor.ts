import JSZip from "jszip";
import pdfParse from "pdf-parse";
import WordExtractor from "word-extractor";

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

async function extractPptxText(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const lines: string[] = [];
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort((a, b) => {
      const na = Number(a.match(/\d+/)?.[0] ?? 0);
      const nb = Number(b.match(/\d+/)?.[0] ?? 0);
      return na - nb;
    });
  for (const name of slideNames) {
    const file = zip.file(name);
    if (!file) {
      continue;
    }
    const xml = await file.async("string");
    const matches = xml.matchAll(/<a:t>([^<]*)<\/a:t>/g);
    for (const m of matches) {
      const t = m[1]?.trim();
      if (t) {
        lines.push(t);
      }
    }
  }
  return lines.join("\n");
}

export class DocumentTextExtractor {
  private readonly wordExtractor = new WordExtractor();

  async parse(buffer: Buffer, mimeType: string): Promise<string> {
    const mt = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
    try {
      if (mt === "application/pdf") {
        const result = await pdfParse(buffer);
        return typeof result.text === "string" ? result.text : "";
      }

      if (
        mt === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        mt === "application/msword"
      ) {
        const doc = await this.wordExtractor.extract(buffer);
        return doc.getBody() ?? "";
      }

      if (mt === PPTX_MIME) {
        return await extractPptxText(buffer);
      }
    } catch {
      return "";
    }
    return "";
  }
}
