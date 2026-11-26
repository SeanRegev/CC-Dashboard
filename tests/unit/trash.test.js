'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isTrashableSkillPath } = require('../../packages/app/src/main/trash.js');

const exists = (f) => f.endsWith('SKILL.md');
const posix = { platform: 'linux', configDir: '/home/u/.claude', exists };

test('trash: user and project skills are allowed', () => {
  assert.equal(isTrashableSkillPath('/home/u/.claude/skills/pdf/SKILL.md', posix), true);
  assert.equal(isTrashableSkillPath('/work/proj/.claude/skills/release/SKILL.md', posix), true);
  assert.equal(isTrashableSkillPath('/home/u/my dir/proj/.claude/skills/a-b/SKILL.md', posix), true);
});

test('trash: only a SKILL.md directly inside skills/<name>/', () => {
  for (const p of [
    '', 'relative/skills/x/SKILL.md', '/home/u/.claude/skills/pdf/skill.md', '/home/u/.claude/skills/pdf/README.md',
    '/home/u/.claude/skills/SKILL.md', '/home/u/.claude/other/pdf/SKILL.md', '/home/u/.claude/skills/pdf/deep/SKILL.md',
    '/home/u/.claude/skills/../../etc/skills/x/SKILL.md', '/home/u/.claude/skills//pdf/SKILL.md', '/SKILL.md', '/home/u/.claude/skills/pdf',
  ]) assert.equal(isTrashableSkillPath(p, posix), false, p);
  assert.equal(isTrashableSkillPath(/** @type {any} */ (null), posix), false);
});

test('trash: never plugin skills', () => {
  assert.equal(isTrashableSkillPath('/home/u/.claude/plugins/cache/m/p/1.0/skills/lint/SKILL.md', posix), false);
  assert.equal(isTrashableSkillPath('/other/.claude/plugins/synced/x/skills/lint/SKILL.md', posix), false);
  assert.equal(isTrashableSkillPath('/opt/p/skills/lint/SKILL.md', { ...posix, pluginPaths: ['/opt/p'] }), false);
  const isPluginRoot = (f) => f === '/opt/q/.claude-plugin/plugin.json' || f.endsWith('SKILL.md');
  assert.equal(isTrashableSkillPath('/opt/q/skills/lint/SKILL.md', { ...posix, exists: isPluginRoot }), false);
  assert.equal(isTrashableSkillPath('/home/u/.claude/skills/ghost/SKILL.md', { ...posix, exists: () => false }), false, 'must exist');
});

test('trash: Windows paths, case-insensitive plugin folder', () => {
  const win = { platform: 'win32', configDir: 'C:\\Users\\U\\.claude', exists };
  assert.equal(isTrashableSkillPath('C:\\Users\\U\\.claude\\skills\\pdf\\SKILL.md', win), true);
  assert.equal(isTrashableSkillPath('C:\\Users\\U\\.CLAUDE\\Plugins\\cache\\p\\skills\\x\\SKILL.md', win), false);
  assert.equal(isTrashableSkillPath('C:\\Users\\U\\.claude\\skills\\..\\skills\\pdf\\SKILL.md', win), false);
  assert.equal(isTrashableSkillPath('\\\\srv\\share\\proj\\.claude\\skills\\a\\SKILL.md', win), true);
});

test('Windows: another profile\'s plugins folder is protected whatever its letter case', () => {
  const win = { platform: 'win32', configDir: 'C:\\Users\\U\\.claude', exists: () => true };
  assert.equal(isTrashableSkillPath('D:\\Other Profile\\.Claude\\Plugins\\cache\\p\\skills\\x\\SKILL.md', win), false);
  assert.equal(isTrashableSkillPath('D:\\Other Profile\\.claude\\PLUGINS\\cache\\p\\skills\\x\\SKILL.md', win), false);
});
