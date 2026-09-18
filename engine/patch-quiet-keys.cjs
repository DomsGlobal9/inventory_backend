// Stops the engine printing encryption keys to its log.
//
// libsignal (2.0.1, under Baileys) logs whole session objects when it opens, closes or prunes a
// session -- "Closing session: SessionEntry { ... privKey: <Buffer ...> ... }". Those are the
// keys that protect a shop's chats, and on Render the log is readable by anyone with dashboard
// access and kept by the log provider. The message stays; the object is dropped.
//
// Run at image build time. Fails the build if a line it expects has moved, so a new base image
// can never quietly start logging keys again.
const fs = require('fs');

const edits = [
  ['/evolution/node_modules/libsignal/src/session_record.js', [
    [`console.warn("Session already closed", session);`, `console.warn("Session already closed");`],
    [`console.info("Closing session:", session);`, `console.info("Closing session");`],
    [`console.info("Opening session:", session);`, `console.info("Opening session");`],
    [`console.info("Removing old closed session:", oldestSession);`, `console.info("Removing old closed session");`]
  ]],
  ['/evolution/node_modules/libsignal/src/queue_job.js', [
    [`console.warn("Unhandled bucket type (for naming):", typeof bucket, bucket);`, `console.warn("Unhandled bucket type (for naming):", typeof bucket);`]
  ]]
];

for (const [file, swaps] of edits) {
  let src = fs.readFileSync(file, 'utf8');
  for (const [from, to] of swaps) {
    const at = src.indexOf(from);
    if (at === -1 || src.indexOf(from, at + 1) !== -1) {
      console.error(`quiet-keys patch: expected exactly once in ${file}:\n${from}`);
      process.exit(1);
    }
    src = src.replace(from, to);
  }
  fs.writeFileSync(file, src);
}

// Nothing else in libsignal may print a session, key or record object.
const leftover = require('child_process')
  .execSync(`grep -rnE "console\\.(log|info|warn|error)\\([^)]*,\\s*(session|record|key|privKey|oldestSession|bucket)\\b" /evolution/node_modules/libsignal/src || true`)
  .toString().trim();
if (leftover) {
  console.error('quiet-keys patch: libsignal still logs an object that may hold keys:\n' + leftover);
  process.exit(1);
}
console.log('quiet-keys patch applied');
