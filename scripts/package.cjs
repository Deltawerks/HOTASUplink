const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { fileURLToPath } = require('node:url');
const { Data, NtExecutable, NtExecutableResource, Resource } = require('resedit');
const { readerCompiler } = require('../src/input');
const { modelAssetsByRig } = require('../src/rig/model-assets.mjs');
const app = require('../package.json');

const run = promisify(execFile);
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const releaseName = app.productName.replaceAll(' ', '-');
const exeName = app.productName + '.exe';
const stagePrefix = '.hotas-uplink-build-';
const marker = '.hotas-uplink-build.sha256';
const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const launcher = app.productName + ' - Compatibility.cmd';
const threeFiles = [
  'LICENSE', 'package.json', 'build/three.module.js', 'build/three.core.js',
  'examples/jsm/controls/OrbitControls.js', 'examples/jsm/loaders/GLTFLoader.js',
  'examples/jsm/utils/BufferGeometryUtils.js', 'examples/jsm/utils/SkeletonUtils.js',
];
const assets = ['brand/app.ico', 'brand/glyph.svg', 'brand/tokens.css', 'fonts/barlow/LICENSE',
  ...[400, 500, 600, 700].map(weight => 'fonts/barlow/barlow-latin-' + weight + '-normal.woff2')];
const rigModels = new Set();
for (const devices of Object.values(modelAssetsByRig)) {
  for (const model of Object.values(devices)) {
    const rel = path.relative(path.join(root, 'assets'), fileURLToPath(model)).split(path.sep).join('/');
    if (!rel.startsWith('rig/') || !rel.endsWith('.glb')) throw new Error('Model must be a GLB in assets/rig: ' + rel);
    rigModels.add(rel);
  }
}

async function copyFile(source, destination) {
  if (!(await fs.lstat(source)).isFile()) throw new Error('Expected a regular file at ' + source);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

async function writeWindowsExecutable(electron, destination) {
  const exe = NtExecutable.from(await fs.readFile(electron));
  const resources = NtExecutableResource.from(exe);
  const versions = Resource.VersionInfo.fromEntries(resources.entries);
  const icons = Resource.IconGroupEntry.fromEntries(resources.entries);
  if (versions.length !== 1 || icons.length !== 1) throw new Error('Unexpected Electron version or icon resources.');

  const info = versions[0];
  info.setFileVersion(app.version);
  info.setProductVersion(app.version);
  for (const language of info.getAllLanguagesForStringValues()) {
    info.setStringValues(language, {
      CompanyName: 'DeltaWerks', ProductName: app.productName, FileDescription: app.productName,
      InternalName: exeName, OriginalFilename: exeName, FileVersion: app.version, ProductVersion: app.version,
    });
  }
  info.outputToResourceEntries(resources.entries);
  const icon = Data.IconFile.from(await fs.readFile(path.join(root, 'assets', 'brand', 'app.ico')));
  Resource.IconGroupEntry.replaceIconsForResource(resources.entries, icons[0].id, icons[0].lang, icon.icons.map(item => item.data));
  resources.outputResource(exe);
  await fs.writeFile(destination, Buffer.from(exe.generate()));
}

async function checkRequiredModels() {
  for (const rel of rigModels) {
    const file = path.join(root, 'assets', rel);
    if (!await exists(file)) throw new Error('Public release requires the finished model assets/' + rel);
    const handle = await fs.open(file, 'r');
    try {
      const header = Buffer.alloc(12);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      const { size } = await handle.stat();
      if (bytesRead !== header.length || header.toString('ascii', 0, 4) !== 'glTF' ||
          header.readUInt32LE(4) !== 2 || header.readUInt32LE(8) !== size || size <= header.length) {
        throw new Error('Invalid finished GLB model at assets/' + rel);
      }
    } finally { await handle.close(); }
  }
}

async function populate(destination, publicBuild) {
  // Current Electron installs its platform binary on first resolution after npm ci.
  const electron = require('electron');
  const runtime = path.dirname(electron);
  // Only the Windows runtime and its notices belong at the package root.
  for (const item of await fs.readdir(runtime, { withFileTypes: true })) {
    if (item.isFile() && (/\.(dll|pak|dat|bin)$/i.test(item.name) ||
        ['LICENSES.chromium.html', 'vk_swiftshader_icd.json', 'version'].includes(item.name))) {
      await copyFile(path.join(runtime, item.name), path.join(destination, item.name));
    }
  }
  for (const name of await fs.readdir(path.join(runtime, 'locales'))) {
    if (name.endsWith('.pak')) await copyFile(path.join(runtime, 'locales', name), path.join(destination, 'locales', name));
  }
  const executable = path.join(destination, exeName);
  await writeWindowsExecutable(electron, executable);
  for (const name of ['README.md', 'ASSET-NOTICES.md', 'LICENSE', 'docs/desk-view.png']) {
    await copyFile(path.join(root, name), path.join(destination, name));
  }
  await copyFile(path.join(runtime, 'LICENSE'), path.join(destination, 'LICENSE-Electron.txt'));
  const content = path.join(destination, 'resources', 'app');
  await copyFile(path.join(root, 'package.json'), path.join(content, 'package.json'));
  for (const folder of ['desktop', 'game', 'input', 'rig', 'ui']) {
    const dir = path.join('src', folder);
    for (const file of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
      if (file.isFile() && /\.(cjs|mjs|js|html|css)$/.test(file.name) && !file.name.includes('.test.')) {
        await copyFile(path.join(root, dir, file.name), path.join(content, dir, file.name));
      }
    }
  }
  for (const rel of assets) await copyFile(path.join(root, 'assets', rel), path.join(content, 'assets', rel));
  for (const rel of rigModels) {
    const source = path.join(root, 'assets', rel);
    if (publicBuild || await exists(source)) await copyFile(source, path.join(content, 'assets', rel));
  }
  for (const rel of threeFiles) {
    const entry = path.join('node_modules', 'three', rel);
    await copyFile(path.join(root, entry), path.join(content, entry));
  }
  const compiler = readerCompiler(path.join(content, 'src/input/VkbReader.exe'));
  await run(compiler.file, compiler.args, { windowsHide: true });
  await run(compiler.file, ['/nologo', '/optimize+', '/target:exe',
    '/out:' + path.join(content, 'src/game/GameStatus.exe'), path.join(root, 'src/game/GameStatus.cs')], { windowsHide: true });
  await fs.writeFile(path.join(destination, launcher),
    '@echo off\r\nstart "" "%~dp0' + exeName + '" --compatibility-mode\r\n');
  // Exercise the shipped runtime and its module graph without opening the UI or controllers.
  const check = [
    "import 'three/addons/controls/OrbitControls.js';",
    "import 'three/addons/loaders/GLTFLoader.js';",
    "import './src/rig/schematic.js';",
    "import './src/game/profile.cjs';",
    "console.log(JSON.stringify([process.versions.electron, process.arch]));",
  ].join('\n');
  const { stdout } = await run(executable, ['--input-type=module', '--eval', check], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, cwd: content, windowsHide: true,
  });
  const [version, arch] = JSON.parse(stdout.trim());
  if (version !== app.devDependencies.electron || arch !== process.arch) {
    throw new Error('Unexpected Electron runtime version or architecture: ' + version + ' / ' + arch);
  }
  await Promise.all(['LICENSE', 'LICENSE-Electron.txt', 'LICENSES.chromium.html', 'resources.pak', 'locales/en-US.pak'].map(rel =>
    fs.access(path.join(destination, rel))));
}

async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Hash the complete inventory before replacing a local output. A new personal
// file or a modified packaged asset makes it a user-managed directory.
async function fingerprint(dir) {
  const hash = createHash('sha256');
  async function visit(rel) {
    for (const name of (await fs.readdir(path.join(dir, rel))).sort()) {
      if (!rel && name === marker) continue;
      const child = path.join(rel, name);
      const file = path.join(dir, child);
      const stat = await fs.lstat(file);
      if (stat.isDirectory()) { hash.update('d:' + child + '\0'); await visit(child); }
      else if (stat.isFile()) {
        hash.update('f:' + child + '\0' + stat.size + '\0');
        for await (const bytes of createReadStream(file)) hash.update(bytes);
      } else throw new Error('Unexpected link or special file in local build: ' + child);
    }
  }
  await visit('');
  return hash.digest('hex');
}

async function managedOutput(directory) {
  if (!(await fs.lstat(directory)).isDirectory()) return false;
  try {
    const name = path.join(directory, marker);
    const stat = await fs.lstat(name);
    if (!stat.isFile() || stat.size !== 64) return false;
    return (await fs.readFile(name, 'ascii')) === await fingerprint(directory);
  } catch { return false; }
}

async function removeBuildDirectory(directory) {
  // Only newly created staging directories and verified old builds go here.
  const actual = await fs.realpath(directory);
  if (path.dirname(actual) !== dist || !path.basename(actual).startsWith(stagePrefix) ||
      !(await fs.lstat(directory)).isDirectory()) throw new Error('Unexpected build cleanup path ' + directory);
  await fs.rm(actual, { recursive: true, maxRetries: 3 });
}

async function zipBuild(stage, folder, publicBuild) {
  const filename = releaseName + '-' + app.version + '-win32-' + process.arch + (publicBuild ? '' : '-local') + '.zip';
  const archive = path.join(stage, filename);
  await run(tar, ['-a', '-cf', archive, '-C', stage, folder], { windowsHide: true });
  const { stdout } = await run(tar, ['-tf', archive], { windowsHide: true });
  const entries = stdout.trim().split(/\r?\n/);
  const models = Array.from(rigModels, rel => folder + '/resources/app/assets/' + rel);
  const unexpected = entries.find(entry => /(?:\.test\.[cm]?js|\.(?:xml|log|p4k|jpe?g|heic|dng))$/i.test(entry) ||
    /\/(?:ref|models|[^/]*-backups)\//i.test(entry) || (/\.glb$/i.test(entry) && !models.includes(entry)));
  if (unexpected) throw new Error('Unexpected file in portable archive: ' + unexpected);
  const required = [folder + '/' + exeName, folder + '/' + launcher, folder + '/LICENSE', folder + '/LICENSE-Electron.txt'];
  if (publicBuild) required.push(...models);
  for (const rel of required) {
    if (!entries.includes(rel)) throw new Error('Missing file in portable archive: ' + rel);
  }
  const final = path.join(dist, filename);
  await fs.rename(archive, final);
  return final;
}

async function packageWindows() {
  if (process.platform !== 'win32') throw new Error('Run the Windows build on Windows.');
  const args = process.argv.slice(2);
  if (args.some(arg => !['--public', '--side-by-side'].includes(arg))) throw new Error('Unknown build option.');
  const publicBuild = args.includes('--public');
  if (publicBuild) await checkRequiredModels();
  const folder = args.includes('--side-by-side') ? releaseName + '-' + app.version : app.productName;
  await fs.mkdir(dist, { recursive: true });
  if (await fs.realpath(dist) !== dist) throw new Error('The build output must be inside this project.');
  const stage = await fs.mkdtemp(path.join(dist, stagePrefix));
  const next = path.join(stage, folder);
  try {
    await populate(next, publicBuild);
    if (publicBuild) return await zipBuild(stage, folder, true);
    const destination = path.join(dist, folder);
    if (await exists(destination)) {
      const old = stage + '-previous';
      // An unmarked legacy build, an edited build, or a running copy can stay in use.
      if (!(await managedOutput(destination))) return await zipBuild(stage, folder, false);
      await fs.writeFile(path.join(next, marker), await fingerprint(next));
      try { await fs.rename(destination, old); }
      catch (error) {
        if (!['EBUSY', 'EACCES', 'EPERM'].includes(error.code)) throw error;
        await fs.unlink(path.join(next, marker));
        return await zipBuild(stage, folder, false);
      }
      try { await fs.rename(next, destination); }
      catch (error) { await fs.rename(old, destination); throw error; }
      await removeBuildDirectory(old);
    } else {
      await fs.writeFile(path.join(next, marker), await fingerprint(next));
      await fs.rename(next, destination);
    }
    return path.join(destination, exeName);
  } finally { await removeBuildDirectory(stage); }
}

packageWindows().then(console.log).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
