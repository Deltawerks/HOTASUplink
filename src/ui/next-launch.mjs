function errorMessage(error) {
  return (error?.message || 'Check the selected game installation and try again.')
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

function backupTime(backup) {
  const date = new Date(backup.createdAt);
  return Number.isNaN(date.getTime()) ? 'the last apply' : date.toLocaleString();
}

export function createNextLaunch({ bridge, isEditing, onRestored }) {
  const byId = id => document.getElementById(id);
  const dialog = byId('next-launch-dialog');
  const title = byId('next-launch-title');
  const summary = byId('next-launch-summary');
  const detail = byId('next-launch-detail');
  const install = byId('next-launch-install');
  const backupChoice = byId('backup-choice');
  const backupVersion = byId('backup-version');
  const status = byId('next-launch-result');
  const confirm = byId('next-launch-confirm');
  const dismiss = byId('next-launch-dismiss');
  let operation = null;
  let writing = false;

  async function availability() {
    try {
      return await bridge.nextLaunchStatus();
    } catch (error) {
      return { canApply: false, canRestore: false, reason: errorMessage(error) };
    }
  }

  function describeRestore(backup) {
    summary.textContent = 'Restore the active profile backed up on ' + backupTime(backup) + '?';
  }
  backupVersion.addEventListener('change', () => {
    if (!operation?.restore || writing) return;
    const backup = operation.state.backups.find(item => item.id === backupVersion.value);
    operation.backup = backup;
    confirm.disabled = !backup || !operation.state.canRestore;
    if (backup) describeRestore(backup);
  });

  function show(kind, saved, done) {
    if (dialog.open || isEditing()) return;
    const restore = kind === 'restore';
    const request = { restore, saved, done, state: null };
    operation = request;
    install.textContent = '';
    backupChoice.hidden = true;
    backupVersion.disabled = false;
    backupVersion.replaceChildren();
    title.textContent = restore ? 'Restore previous bindings' : 'Apply for next launch';
    summary.textContent = restore ? 'Restore this installation’s active profile from its backup?'
      : 'Use “' + saved.name + '” for the next Star Citizen launch?';
    detail.textContent = restore ? 'This restores the full control profile, replacing control changes made since the backup.'
      : 'HOTAS Uplink will back up the active profile before updating the joystick bindings.';
    status.textContent = 'Checking the game and active profile…';
    confirm.textContent = restore ? 'Restore bindings' : 'Apply preset';
    confirm.hidden = false;
    confirm.disabled = true;
    dismiss.disabled = false;
    dismiss.textContent = 'Cancel';
    dialog.showModal();
    dismiss.focus();
    availability().then(state => {
      if (operation !== request || !dialog.open) return;
      request.state = state;
      install.textContent = state.installation ? 'Game installation · ' + state.installation : '';
      const ready = restore ? state.canRestore : state.canApply;
      confirm.disabled = !ready;
      if (restore && state.backup) {
        request.backup = state.backup;
        describeRestore(state.backup);
        if (state.backups?.length > 1) {
          state.backups.forEach((backup, index) => {
            let label = backupTime(backup);
            if (index === 0) label += ' · Latest';
            if (index === state.backups.length - 1) label += ' · Oldest';
            backupVersion.add(new Option(label, backup.id));
          });
          backupVersion.value = state.backup.id;
          backupChoice.hidden = false;
        }
      }
      status.textContent = ready ? '' : state.reason || 'No binding backup is available in this installation.';
      if (!ready) dismiss.textContent = 'Close';
    });
  }

  confirm.addEventListener('click', async () => {
    const request = operation;
    if (!request?.state || writing || confirm.disabled || isEditing()) return;
    const { state, restore, saved } = request;
    const expected = { expectedActiveRevision: state.activeRevision, installation: state.installation };
    writing = true;
    confirm.disabled = true;
    dismiss.disabled = true;
    backupVersion.disabled = true;
    status.textContent = restore ? 'Restoring bindings…' : 'Backing up and applying bindings…';
    try {
      const result = restore
        ? await bridge.restorePreviousBindings({ ...expected, backupId: request.backup.id })
        : await bridge.applyNextLaunch({ ...expected, source: saved.sourceId, expectedRevision: saved.revision });
      title.textContent = restore ? 'Bindings restored' : 'Ready for next launch';
      summary.textContent = restore ? 'The backed-up active profile is in place.'
        : (result.changed ? 'Applied “' + saved.name + '”.' : 'The active bindings already match “' + saved.name + '”.');
      detail.textContent = result.backup?.path ? 'Backup file · ' + result.backup.path : '';
      backupChoice.hidden = true;
      const count = result.unlistedActionCount;
      status.textContent = !restore && count > 0
        ? (count === 1 ? '1 preset action is missing from this build’s action catalog. Star Citizen may ignore it.'
          : count + ' preset actions are missing from this build’s action catalog. Star Citizen may ignore them.')
        : '';
      if (restore) await onRestored();
      else request.done?.(result);
    } catch (error) {
      status.textContent = errorMessage(error);
    } finally {
      writing = false;
      confirm.hidden = true;
      dismiss.disabled = false;
      dismiss.textContent = 'Close';
      dismiss.focus();
    }
  });
  dismiss.addEventListener('click', () => { if (!writing) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (writing) event.preventDefault(); });
  dialog.addEventListener('close', () => { operation = null; });

  // Opening the layout picker is also how someone viewing the active profile
  // finds and restores a backup after an app restart.
  function addRestoreOption(section) {
    const info = document.createElement('p');
    info.className = 'dialog-note';
    info.textContent = 'Checking for a binding backup…';
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'next-launch-button';
    restore.textContent = 'Restore previous bindings…';
    restore.disabled = true;
    restore.addEventListener('click', () => show('restore'));
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'text-button';
    retry.textContent = 'Check again';
    retry.hidden = true;
    const controls = document.createElement('div');
    controls.className = 'next-launch-options';
    controls.append(restore, retry);
    section.append(info, controls);
    async function update() {
      retry.disabled = true;
      const state = await availability();
      if (!section.isConnected) return;
      restore.disabled = !state.canRestore || isEditing();
      const timestamp = state.backup ? 'Backup from ' + backupTime(state.backup) + '. ' : '';
      info.textContent = timestamp + (isEditing() && state.backup ? 'Finish editing to restore it.'
        : state.reason || (state.backup ? '' : 'Your first apply creates a backup here.'));
      retry.hidden = !state.reason;
      retry.disabled = false;
    }
    retry.addEventListener('click', update);
    update();
  }
  return { availability, show, addRestoreOption, get writing() { return writing; } };
}
