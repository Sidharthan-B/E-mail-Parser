import { processLocalInbox } from "../src/modules/localFolder/processInbox";



async function main() {

  const move = process.argv.includes("--move");

  const result = await processLocalInbox({ moveToProcessed: move });

  // eslint-disable-next-line no-console

  console.log(JSON.stringify(result, null, 2));

  if (result.errors.length > 0) {

    process.exit(1);

  }

}



main().catch((error) => {

  // eslint-disable-next-line no-console

  console.error(error);

  process.exit(1);

});

