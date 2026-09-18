// `wrangler dev` serves whatever sits in `assets.directory`, which is now build
// output rather than source, so a dev session needs the bundler running too.
// Both children share this terminal and either one exiting takes the other down.
import { spawn } from 'node:child_process';

const children = [
  spawn('npx', ['vite', 'build', '--watch'], { stdio: 'inherit' }),
  spawn('npx', ['wrangler', 'dev', ...process.argv.slice(2)], { stdio: 'inherit' }),
];

let stopping = false;
function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code ?? 0;
}

for (const child of children) child.on('exit', stopAll);
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
