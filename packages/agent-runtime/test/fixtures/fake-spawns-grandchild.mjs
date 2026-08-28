// Simulates a CLI that itself launches a tool subprocess (e.g. a shell command). Spawns a real
// grandchild node process that continuously touches a marker file, so a test can observe whether
// killing *this* process (the direct child of the daemon) also terminates the grandchild, or
// leaves it orphaned.
import { spawn } from 'node:child_process';

const markerPath = process.argv[2];

process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'grandchild-test' }) + '\n');

const grandchild = spawn(
  process.execPath,
  [
    '-e',
    `
      const fs = require('fs');
      const path = process.argv[1];
      setInterval(() => { try { fs.writeFileSync(path, String(Date.now())); } catch {} }, 100);
    `,
    markerPath,
  ],
  { stdio: 'ignore' },
);

process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: `spawned grandchild pid ${grandchild.pid}` } }) + '\n');

// Keep this process alive (simulating a CLI mid-turn) until killed.
setInterval(() => {}, 1000);
