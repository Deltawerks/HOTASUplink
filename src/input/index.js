// Releases ship the DirectInput reader. A source checkout builds it on demand.
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

function readerCompiler(outputFile) {
  const windows = process.env.SystemRoot || 'C:\\Windows';
  return {
    file: path.join(windows, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
    args: ['/nologo', '/optimize+', '/target:exe', '/reference:System.Web.Extensions.dll',
      '/reference:System.Windows.Forms.dll', '/out:' + outputFile, path.join(__dirname, 'VkbReader.cs')],
  };
}

function startInput(onEvent) {
  let stopped = false;
  let child;
  let readerProcess;
  const status = (level, message) => {
    if (!stopped) onEvent({ type: 'status', level, message });
  };

  async function run() {
    if (process.platform !== 'win32') {
      status('warning', 'Live controller input requires Windows.');
      return;
    }

    let work;
    try {
      let exe = path.join(__dirname, 'VkbReader.exe');
      if (!existsSync(exe)) {
        work = await fs.mkdtemp(path.join(os.tmpdir(), 'vkb-input-'));
        if (stopped) return;
        exe = path.join(work, 'VkbReader.exe');
        const { file, args } = readerCompiler(exe);
        const compiler = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        child = compiler;
        let diagnostics = '';
        compiler.stdout.on('data', (data) => { diagnostics += data; });
        compiler.stderr.on('data', (data) => { diagnostics += data; });
        const result = await waitForClose(compiler);
        if (stopped) return;
        if (result !== 0) throw new Error('Could not compile the Windows input reader. ' + diagnostics.trim());
      }

      const reader = spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      readerProcess = child = reader;
      // The helper can exit between our shutdown check and closing its parent pipe.
      reader.stdin.on('error', error => { if (!stopped) status('warning', error.message); });
      const lines = readline.createInterface({ input: reader.stdout, crlfDelay: Infinity });
      lines.on('line', (line) => {
        if (stopped) return;
        let event;
        try { event = JSON.parse(line); }
        catch { status('warning', 'The Windows input reader sent an unreadable event.'); return; }
        onEvent(event);
      });
      reader.stderr.on('data', (data) => status('warning', data.toString().trim()));
      const code = await waitForClose(reader);
      if (!stopped) {
        onEvent({ type: 'devices', devices: [] });
        status('error', 'The Windows input reader stopped (exit ' + code + ').');
      }
    } finally {
      child = readerProcess = undefined;
      if (work) await fs.rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
  run().catch((error) => status('error', 'Live input unavailable. ' + error.message));
  return () => {
    if (stopped) return;
    stopped = true;
    const running = child;
    if (!running || running.exitCode !== null || running.signalCode !== null) return;
    if (running !== readerProcess) { running.kill(); return; }
    // EOF asks the reader to unacquire devices and release its notification handles.
    const deadline = setTimeout(() => running.kill(), 1500);
    deadline.unref();
    running.once('close', () => clearTimeout(deadline));
    running.stdin.end();
  };
}

function waitForClose(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
}

module.exports = { startInput, readerCompiler };

// Report connected devices and readable capabilities without requiring a button press.
if (require.main === module) {
  const deadline = setTimeout(() => {
    console.error('Timed out waiting for a controller snapshot.');
    process.exitCode = 1;
    stop();
  }, 15000);
  const stop = startInput((event) => {
    console.log(JSON.stringify(event));
    if (event.type === 'devices' || (event.type === 'status' && event.level === 'error')) {
      clearTimeout(deadline);
      if (event.type === 'status') process.exitCode = 1;
      stop();
    }
  });
}
