import { readFileSync } from "fs";
import { extractRecruiterInformation } from "../src/modules/extraction/hybridExtractor";
import { ParsedEmail } from "../src/shared/types";

async function testVeritasExtraction() {
  const text = readFileSync("test-veritas.txt", "utf-8");
  
  const mockEmail: ParsedEmail = {
    messageId: "test-veritas",
    threadId: "test-thread",
    subject: "Veritas Analytics Internship Opportunity – PPO Based Hiring",
    sender: "internships@veritasanalytics.io",
    recipients: ["placement@college.edu"],
    html: "",
    text: text,
    cleanedText: text,
    attachments: []
  };

  console.log("Testing Veritas Analytics extraction...\n");
  
  const results = await extractRecruiterInformation(mockEmail);

  console.log("Extracted JSON:");
  console.log(JSON.stringify(results, null, 2));

  // Verify key fields (first entity)
  const result = results[0];
  console.log(`\n=== VERIFICATION (${results.length} role(s)) ===`);
  console.log(`Additional info: ${result.additional_information}`);
  console.log(`Role: ${result.role}`);
  console.log(`Is Internship: ${result.is_internship}`);
  console.log(`PPO Available: ${result.ppo_available}`);
  console.log(`Stipend: ${result.stipend}`);
  console.log(`CTC: ${result.ctc}`);
  console.log(`Min CGPA: ${result.min_cgpa}`);
  console.log(`Mode of Work: ${result.mode_of_work}`);
  console.log(`Recruiter Email: ${result.recruiter_email}`);
  console.log(`Total Rounds: ${result.total_rounds}`);
  console.log(`Eligible Departments: ${result.eligible_departments?.length || 0} found`);
  console.log(`Skills Required: ${result.skills_required?.technical?.length || 0} technical, ${result.skills_required?.soft_skills?.length || 0} soft`);
  console.log(`Preferred Skills: ${result.preferred_skills?.technical?.length || 0} technical, ${result.preferred_skills?.soft_skills?.length || 0} soft`);
}

testVeritasExtraction().catch(console.error);