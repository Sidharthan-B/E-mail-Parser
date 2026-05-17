import { ParsedEmail, RecruiterEntity } from "../../shared/types";
import { segmentSections } from "../segmentation/sectionSegmenter";
import { extractRecruiterInformation } from "../extraction/hybridExtractor";
import { validateRecruiterEntity } from "../validation/validators";

export async function runExtractionPipeline(email: ParsedEmail): Promise<RecruiterEntity[]> {
  const sections = segmentSections(email.cleanedText);
  const sectionText = Object.values(sections).join("\n");
  const enhancedEmail: ParsedEmail = {
    ...email,
    cleanedText: sectionText ? `${email.cleanedText}\n\n${sectionText}` : email.cleanedText
  };
  const entities = await extractRecruiterInformation(enhancedEmail);
  return entities.map(validateRecruiterEntity);
}
