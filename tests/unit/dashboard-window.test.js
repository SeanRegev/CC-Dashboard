'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const { resolveDashboardTarget, isNavigationAllowed } = require('../../packages/app/src/main/dashboard-window.js');

const yes = () => true;
const no = () => false;
const dir = path.join(os.tmpdir(), 'plug');
const file = path.join(dir, 'ui', 'index.html');

test('only local http(s) addresses open', () => {
  assert.equal(resolveDashboardTarget({ url: 'http://127.0.0.1:4545/' }).ok, true);
  assert.equal(resolveDashboardTarget({ url: 'https://localhost:8443/x' }).ok, true);
  for (const url of ['http://example.com/', 'http://localhost.evil.com/', 'http://127.0.0.1.evil.com/', 'ftp://localhost/', 'file:///etc/passwd', 'javascript:alert(1)', 'nonsense', 'http://user:pw@localhost/', 'http://0.0.0.0:80/']) {
    assert.equal(resolveDashboardTarget({ url }).ok, false, url);
  }
});

test('files must be absolute, existing .html', () => {
  assert.equal(resolveDashboardTarget({ file }, { exists: yes }).ok, true);
  assert.equal(resolveDashboardTarget({ file }, { exists: no }).ok, false);
  assert.equal(resolveDashboardTarget({ file: 'ui/index.html' }, { exists: yes }).ok, false);
  assert.equal(resolveDashboardTarget({ file: path.join(dir, 'run.exe') }, { exists: yes }).ok, false);
});

test('exactly one of url and file; title defaults', () => {
  assert.equal(resolveDashboardTarget({}).ok, false);
  assert.equal(resolveDashboardTarget({ url: 'http://localhost/', file }, { exists: yes }).ok, false);
  assert.equal(resolveDashboardTarget({ url: 'http://localhost/' }).title, 'Dashboard');
  assert.equal(resolveDashboardTarget({ url: 'http://localhost/', title: ' CodeBurn ' }).title, 'CodeBurn');
});

test('navigation: a url target stays on its origin', () => {
  const t = resolveDashboardTarget({ url: 'http://127.0.0.1:4545/' });
  assert.equal(isNavigationAllowed(t, 'http://127.0.0.1:4545/other?x=1'), true);
  assert.equal(isNavigationAllowed(t, 'http://127.0.0.1:4546/'), false);
  assert.equal(isNavigationAllowed(t, 'http://localhost:4545/'), false);
  assert.equal(isNavigationAllowed(t, 'https://127.0.0.1:4545/'), false);
  assert.equal(isNavigationAllowed(t, 'https://example.com/'), false);
  assert.equal(isNavigationAllowed(t, 'file:///etc/passwd'), false);
  assert.equal(isNavigationAllowed(t, 'not a url'), false);
});

test('navigation: a file target stays in the plugin folder', () => {
  const t = resolveDashboardTarget({ file }, { exists: yes });
  assert.equal(isNavigationAllowed(t, pathToFileURL(path.join(dir, 'ui', 'other.html')).toString() + '#a'), true);
  assert.equal(isNavigationAllowed(t, pathToFileURL(path.join(dir, 'x.html')).toString()), false); // a parent of the page's folder
  assert.equal(isNavigationAllowed(t, pathToFileURL(path.join(dir, '..', 'secret.html')).toString()), false);
  assert.equal(isNavigationAllowed(t, pathToFileURL(path.join(os.tmpdir(), 'plug-evil', 'a.html')).toString()), false);
  assert.equal(isNavigationAllowed(t, 'http://127.0.0.1/'), false);
  assert.equal(isNavigationAllowed(t, 'https://example.com/'), false);
});
