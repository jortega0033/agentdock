import { writeFileSync } from 'node:fs';

const markerPath = process.argv[2];
const pidPath = process.argv[3];
writeFileSync(pidPath, String(process.pid));
setInterval(() => writeFileSync(markerPath, String(Date.now())), 50);
