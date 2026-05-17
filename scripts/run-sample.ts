import { runExtractionPipeline } from "../src/modules/parser/pipeline";

async function main() {
  const sample =
    "Deloitte US India\nRole: Analyst\nCGPA of 6.5 and above\nNo active backlogs\nCTC INR 7,60,000\nCSE and IT students eligible\nDeadline: 2026-05-07 17:00\nApply: https://forms.gle/demo";

  const result = await runExtractionPipeline({
    messageId: "sample-mid",
    threadId: "sample-thid",
    subject: "Campus Drive",
    sender: "placement@cet.ac.in",
    recipients: ["students@college.edu"],
    html: "",
    text: sample,
    cleanedText: sample,
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
