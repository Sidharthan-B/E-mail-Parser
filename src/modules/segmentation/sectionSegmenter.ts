import { SectionMap } from "../../shared/types";

const SECTION_HINTS: Record<keyof SectionMap, RegExp[]> = {
  eligibility_section: [/eligibility/i, /cgpa/i, /backlog/i, /eligible/i],
  compensation_section: [/ctc/i, /salary/i, /compensation/i, /lpa/i],
  skills_section: [/skills?/i, /technolog/i, /requirements?/i],
  job_description_section: [/job description/i, /responsibilit/i, /role/i],
  dates_section: [/deadline/i, /important date/i, /last date/i, /date/i],
  registration_section: [/register/i, /registration/i, /apply/i, /form/i]
};

export function segmentSections(cleanedText: string): SectionMap {
  const sections: SectionMap = {};
  const lines = cleanedText.split(/\n+/).map((line) => line.trim()).filter(Boolean);

  for (const [key, rules] of Object.entries(SECTION_HINTS) as [keyof SectionMap, RegExp[]][]) {
    const hits = lines.filter((line) => rules.some((rule) => rule.test(line)));
    if (hits.length > 0) {
      sections[key] = hits.join("\n");
    }
  }

  return sections;
}
