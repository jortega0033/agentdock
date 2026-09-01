import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const markerFixture = fileURLToPath(new URL('./fake-marker-writer.mjs', import.meta.url));
const grandchild = spawn(process.execPath, [markerFixture, process.argv[2], process.argv[3]], {
  stdio: 'ignore',
  // Make the fixture a genuine Windows orphan before the leader exits. Job Object membership is
  // inherited independently of this process-group flag and must still let the host reap it.
  detached: true,
});
await new Promise((resolve, reject) => {
  grandchild.once('spawn', resolve);
  grandchild.once('error', reject);
});
const deadline = Date.now() + 5_000;
while ((!existsSync(process.argv[2]) || !existsSync(process.argv[3])) && Date.now() < deadline) {
  if (grandchild.exitCode !== null) process.exit(2);
  await new Promise((resolve) => setTimeout(resolve, 25));
}
if (!existsSync(process.argv[2]) || !existsSync(process.argv[3])) process.exit(2);
grandchild.unref();
