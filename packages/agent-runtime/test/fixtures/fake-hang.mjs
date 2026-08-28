// Prints one line then hangs until killed, for cancellation tests.
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'hang-thread' }) + '\n');
setInterval(() => {}, 1000);
