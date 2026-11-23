const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { checkLatest, downloadRelease } = require('./github-release.cjs');
const { installRelease, newestInstalled } = require('./update-store.cjs');

// Only the main process receives release URLs and installation paths.
function createUpdater({ version, storeDir, supported, check = checkLatest, download = downloadRelease,
  install = installRelease, newest = newestInstalled }) {
  let offered = null;
  let checking = null;
  let installing = null;

  const cached = () => supported ? newest(storeDir, version) : Promise.resolve(null);
  const ready = exe => ({ status: 'ready', version: path.basename(path.dirname(exe)) });

  async function checkUpdate() {
    if (!supported) return { status: 'unsupported', version };
    if (installing) return installing;
    if (!checking) {
      checking = (async () => {
        const exe = await cached();
        if (exe) return ready(exe);
        offered = null;
        offered = await check(version);
        return offered ? { status: 'available', version: offered.version } : { status: 'current', version };
      })().finally(() => { checking = null; });
    }
    return checking;
  }

  async function downloadUpdate() {
    if (checking) await checking;
    if (installing) return installing;
    if (!supported || !offered) throw new Error('Check for an update first.');
    const release = offered;
    installing = (async () => {
      const existing = await cached();
      if (existing) return ready(existing);
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hotas-uplink-update-'));
      const zip = path.join(temp, 'update.zip');
      try {
        await download(release, zip);
        return ready(await install(storeDir, release, zip));
      } finally {
        await fs.rm(zip, { force: true }).catch(() => {});
        await fs.rmdir(temp).catch(() => {});
      }
    })().finally(() => { installing = null; });
    return installing;
  }

  return { checkUpdate, downloadUpdate, cached };
}

module.exports = { createUpdater };
