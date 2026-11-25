'use strict';
// Fire the hooks registered in a --settings file, the way Claude does (used by test fixtures).
const { execSync } = require('child_process');
const fs = require('fs');

function loadSettings(args) {
  const i = args.indexOf('--settings');
  return i >= 0 ? JSON.parse(fs.readFileSync(args[i + 1], 'utf8')) : { hooks: {} };
}

function fire(settings, event, payload = {}) {
  const body = JSON.stringify({ ...payload, cwd: process.cwd(), hook_event_name: event });
  for (const entry of (settings.hooks && settings.hooks[event]) || []) {
    for (const h of entry.hooks || []) {
      try { execSync(h.command, { input: body, stdio: ['pipe', 'ignore', 'ignore'], shell: true, timeout: 10000 }); } catch { /* ignore */ }
    }
  }
}

module.exports = { loadSettings, fire };
