export function createUpdateControls(bridge, restartBlocker, closeSettings) {
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const actions = document.createElement('div');
  actions.className = 'next-launch-options';
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'next-launch-button';
  const later = document.createElement('button');
  later.type = 'button';
  later.className = 'text-button';
  later.textContent = 'Restart later';
  later.onclick = closeSettings;
  actions.append(action, later);

  let state = 'idle';
  let version = '';
  let working = '';
  let error = '';

  function render() {
    const blocked = state === 'ready' ? restartBlocker() : '';
    const messages = {
      idle: '', current: 'Version ' + version + ' is up to date.',
      available: 'Version ' + version + ' is available on GitHub.',
      ready: blocked || 'Version ' + version + ' is ready. You can use it now or the next time you open HOTAS Uplink.',
      unsupported: 'In-app updates are available in the packaged Windows app.',
    };
    status.textContent = working || error || messages[state];
    status.hidden = !status.textContent;
    action.textContent = state === 'ready' ? 'Restart now' : state === 'available' ? 'Download update' : 'Check for updates';
    action.hidden = state === 'unsupported';
    action.disabled = Boolean(working || blocked);
    later.hidden = state !== 'ready' || Boolean(working);
  }

  action.onclick = async () => {
    if (working || state === 'unsupported') return;
    if (state === 'ready' && restartBlocker()) { render(); return; }
    error = '';
    working = state === 'ready' ? 'Restarting HOTAS Uplink…' : state === 'available'
      ? 'Downloading and verifying version ' + version + '…' : 'Checking GitHub for updates…';
    render();
    try {
      if (state === 'ready') {
        await bridge.restartForUpdate();
      } else {
        const result = state === 'available' ? await bridge.downloadUpdate() : await bridge.checkUpdate();
        state = result.status;
        version = result.version;
      }
    } catch (e) {
      error = (e?.message || 'The update request failed. Try again.').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
      if (state === 'available') state = 'idle';
    } finally {
      working = '';
      render();
    }
  };
  return section => {
    section.append(status, actions);
    render();
  };
}
