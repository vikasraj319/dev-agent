import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, DEFAULTS, loadConfig } from '../../src/config.js';
import { splitCommand } from '../../src/util.js';

test('defaults load and validate; default repair budget is five', () => {
  const c = loadConfig({ env: {} });
  assert.equal(c.limits.maxRepairs, 5);
  assert.equal(c.deploy.productionEnabled, false);
  assert.equal(c.git.autoCommit, true);
});
test('environment overrides apply', () => {
  const c = loadConfig({ env: { AGENT_MAX_REPAIRS: '8', AGENT_PORT: '5000', AGENT_ALLOWED_DIRS: '/a:/b' } });
  assert.equal(c.limits.maxRepairs, 8); assert.equal(c.port, 5000); assert.deepEqual(c.allowedProjectDirs, ['/a', '/b']);
});
test('invalid values produce a readable error listing every problem', () => {
  assert.throws(() => loadConfig({ env: { AGENT_MAX_REPAIRS: '99' }, overrides: { sandbox: { mode: 'vm' }, host: '0.0.0.0' } }), (e) => {
    assert.ok(e instanceof ConfigError); assert.match(e.message, /maxRepairs/); assert.match(e.message, /sandbox\.mode/); assert.match(e.message, /loopback/); return true; });
});
test('requireProvider explains missing model and API key', () => {
  assert.throws(() => loadConfig({ env: {}, requireProvider: true }), /AGENT_LLM_MODEL[\s\S]*AGENT_LLM_API_KEY/);
  assert.doesNotThrow(() => loadConfig({ env: { AGENT_LLM_MODEL: 'm', AGENT_LLM_API_KEY: 'k' }, requireProvider: true }));
});
test('local endpoints need no API key', () => {
  assert.doesNotThrow(() => loadConfig({ env: { AGENT_LLM_MODEL: 'm', AGENT_LLM_BASE_URL: 'http://localhost:11434/v1' }, requireProvider: true }));
});
test('unknown provider reference and shell operators in commands are rejected', () => {
  assert.throws(() => loadConfig({ env: {}, overrides: { models: { planning: 'nope', implementation: 'main', debugging: 'main' } } }), /unknown provider/);
  assert.throws(() => loadConfig({ env: {}, overrides: { commands: { test: 'npm test && rm -rf /' } } }), /Shell operator/);
});
test('production enable without a command is rejected', () => {
  assert.throws(() => loadConfig({ env: {}, overrides: { deploy: { productionEnabled: true } } }), /productionCommand/);
});
test('splitCommand handles quotes and refuses operators', () => {
  assert.deepEqual(splitCommand('npm run "my script" --flag'), ['npm', 'run', 'my script', '--flag']);
  assert.throws(() => splitCommand('echo $(whoami)'), /Shell operator/);
  assert.throws(() => splitCommand('a | b'), /Shell operator/);
});
test('DEFAULTS are frozen against accidental mutation', () => { assert.ok(Object.isFrozen(DEFAULTS)); });
