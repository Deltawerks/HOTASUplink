const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const vm = require('node:vm');
const { readerCompiler } = require('../../src/input');

test('DirectInput reader handles simulated idle, input loss, buffered input and cleanup', { skip: process.platform !== 'win32' }, t => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vkb-reader-test-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const exe = path.join(work, 'ReaderTest.exe');
  const compiler = readerCompiler(exe);
  const compile = spawnSync(compiler.file, [...compiler.args, '/main:VkbReaderTests', path.join(__dirname, 'VkbReaderTests.cs')], {
    encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  assert.equal(compile.status, 0, compile.error?.message || compile.stdout + compile.stderr);
  const fixture = spawnSync(exe, [], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(fixture.status, 0, fixture.error?.message || fixture.stdout + fixture.stderr);
});

function fakeBridge() {
  const worker = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null, kills: 0, kill() { this.kills++; },
  });
  const sandbox = {
    module: { exports: {} }, process: { platform: 'win32' }, __dirname, setTimeout, clearTimeout,
    require(name) {
      if (name === 'node:child_process') return { spawn: () => worker };
      if (name === 'node:fs') return { existsSync: () => true };
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../src/input'), 'utf8'), sandbox);
  const events = [];
  const stop = sandbox.module.exports.startInput(event => events.push(event));
  return { worker, stop, events };
}

test('bridge gives the reader EOF to release its handles and ignores late events on shutdown', async () => {
  const { worker, stop, events } = fakeBridge();
  stop(); stop();
  assert.equal(worker.stdin.writableEnded, true);
  assert.equal(worker.kills, 0);
  worker.stdout.write('{"type":"button","pressed":true}\n');
  worker.emit('close', 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.length, 0);
});

test('unexpected reader exit clears the connected device snapshot and reports the exit', async () => {
  const { worker, events } = fakeBridge();
  worker.stdout.write('{"type":"devices","devices":[{"id":"fixture"}]}\n');
  worker.emit('close', 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events[0].devices[0].id, 'fixture');
  assert.equal(events[1].type, 'devices');
  assert.equal(events[1].devices.length, 0);
  assert.equal(events[2].level, 'error');
});
