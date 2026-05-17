import { runExtractionPipeline } from "../src/modules/parser/pipeline";

const text = `Subject: Nexora Technologies - Campus Hiring Drive 2027 Batch

Dear Placement Team,

Greetings from Nexora Technologies Pvt. Ltd.

We are excited to announce our campus recruitment process for the 2027 graduating batch for the role of Associate Software Engineer under our Cloud & Digital Platforms division.

Eligibility Criteria:

* B.Tech / BE students from Computer Science Engineering, Information Technology, AI & Data Science, Electronics and Communication Engineering
* MCA students may also apply
* Minimum CGPA requirement: 7.0 and above
* Candidates should not have more than 1 active backlog at the time of application

Role: Associate Software Engineer

Business Unit: Cloud & Digital Platforms

Compensation:

* Full Time CTC: INR 11,20,000 per annum
* Additional joining bonus applicable based on performance

Job Location:
Hybrid working model based out of Bangalore and Hyderabad offices.

Preferred Skills:

* React.js
* Node.js
* AWS
* Docker
* Strong understanding of DBMS concepts

Mandatory Skills:

* DSA
* Java or Python
* SQL fundamentals
* OOP concepts

Selection Process:

1. Online Coding Assessment
2. Technical Interview
3. HR Discussion

Eligible Batch:
2027 graduating students only.

Registration Link:
https://careers.nexora.ai/campus-hiring-2027

Last Date to Apply:
14 August 2026, 11:59 PM

Additional Information:
Students having internship experience in backend/full-stack development will be preferred.

Regards,
Akhil Menon
University Relations Team
Nexora Technologies Pvt. Ltd.
careers@nexora.ai`;

async function main() {
  const result = await runExtractionPipeline({
    messageId: "nexora-test",
    threadId: "manual-test",
    subject: "Nexora Technologies - Campus Hiring Drive 2027 Batch",
    sender: "careers@nexora.ai",
    recipients: ["placement@college.edu"],
    html: "",
    text,
    cleanedText: text,
    attachments: []
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
