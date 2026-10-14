// Read-only live status check. No note/vault writes, profile changes or secret output.
import { createClient, publicError } from '../src/client.js';
const localRestConfigPath = process.argv[2];
if (!localRestConfigPath) throw new Error('Provide the Local REST API data.json path.');
try {
  const result = await createClient({ localRestConfigPath }).status();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.log(JSON.stringify(publicError(error), null, 2));
  process.exitCode = 1;
}
