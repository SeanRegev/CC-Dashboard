#!/usr/bin/env node
// Stand-in for a tool's dashboard in tests.
//   term   ANSI screen, echoes typed lines ("ECHO: x"), "q" quits with code 3
//   web    prints "Listening on http://127.0.0.1:PORT" (after FAKE_DASH_DELAY ms) and stays up
//   silent prints nothing and stays up
//   crash  prints a line and exits 1
'use strict';
const mode = process.argv[2] || 'term';
const delay = Number(process.env.FAKE_DASH_DELAY || 0);
if (mode === 'term') {
  process.stdout.write('\x1b[1mDASH READY\x1b[0m \x1b[32mgreen\x1b[0m\r\n');
  process.stdin.setEncoding('utf8');
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.search(/[\r\n]/)) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line === 'q') process.exit(3);
      if (line) process.stdout.write(`ECHO: ${line}\r\n`);
    }
  });
  process.stdin.resume();
} else if (mode === 'web') {
  setTimeout(() => console.log(`\x1b[36mListening on http://127.0.0.1:${process.env.FAKE_DASH_PORT || 4545}/ \x1b[0m`), delay);
  setInterval(() => {}, 1000);
} else if (mode === 'silent') {
  setInterval(() => {}, 1000);
} else if (mode === 'crash') {
  console.log('boom');
  process.exit(1);
}
