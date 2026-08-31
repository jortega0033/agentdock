// Waits until the test has observed a live grandchild, then exits after the intermediate parent
// already exited. PID-lineage snapshots cannot rediscover that orphan; a Windows Job Object
// still owns it.
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const markerPath = process.argv[2];
const pidPath = process.argv[3];
const intermediateFixture = fileURLToPath(
  new URL('./fake-orphaning-intermediate.mjs', import.meta.url),
);
const intermediate = spawn(process.execPath, [intermediateFixture, markerPath, pidPath], {
  stdio: 'ignore',
});
await new Promise((resolve) => intermediate.once('exit', resolve));

const deadline = Date.now() + 5_000;
while ((!existsSync(markerPath) || !existsSync(pidPath)) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
if (!existsSync(markerPath) || !existsSync(pidPath)) process.exit(2);
await new Promise((resolve) => process.stdin.once('data', resolve));
process.exit(0);
