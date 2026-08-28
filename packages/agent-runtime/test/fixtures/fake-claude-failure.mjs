process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x' }) + '\n');
process.stderr.write('fatal: something went wrong\n');
process.exitCode = 1;
