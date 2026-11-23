export function createGameHandoff(verifyLayout, nextLaunch) {
  const element = id => document.getElementById(id);
  const panel = element('game-handoff');
  const toggle = element('handoff-toggle');
  const body = element('handoff-body');
  const check = element('verify-layout');
  const status = element('verification-status');
  const caption = element('handoff-caption');
  const apply = element('apply-next-launch');
  const retry = element('recheck-next-launch');
  const undo = element('undo-next-launch');
  const availability = element('next-launch-availability');
  let current = null;

  async function checkAvailability() {
    const saved = current;
    if (!saved) return;
    apply.disabled = retry.disabled = true;
    availability.textContent = 'Checking whether Star Citizen is closed…';
    const state = await nextLaunch.availability();
    if (saved !== current) return;
    apply.disabled = !state.canApply;
    retry.disabled = false;
    retry.hidden = state.canApply;
    availability.textContent = state.canApply ? '' : state.reason || 'Check the active game profile and try again.';
    if (!state.canApply) expand(true);
  }
  retry.addEventListener('click', checkAvailability);
  apply.addEventListener('click', () => {
    const saved = current;
    if (!saved || apply.disabled) return;
    nextLaunch.show('apply', saved, result => {
      if (current !== saved) return;
      availability.textContent = result.changed ? 'Applied for next launch.' : 'The active bindings already match this preset.';
      undo.hidden = !result.backup;
    });
  });
  undo.addEventListener('click', () => nextLaunch.show('restore'));

  function expand(open) {
    body.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  }
  toggle.addEventListener('click', () => expand(body.hidden));
  check.addEventListener('click', async () => {
    const saved = current;
    if (!saved || check.disabled) return;
    check.disabled = true;
    status.textContent = 'Reading the active game profile…';
    status.removeAttribute('data-result');
    try {
      const result = await verifyLayout(saved.sourceId, saved.revision, saved.scope);
      if (current !== saved) return;
      status.dataset.result = result.status;
      if (result.status === 'match') {
        const checked = new Date(result.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        caption.textContent = 'Active bindings matched at ' + checked;
        status.textContent = result.message + ' Try the control in your ship.';
      } else {
        caption.textContent = 'Load in Star Citizen';
        status.textContent = result.message + (result.status === 'different'
          ? ' After loading this preset, check again once the game saves its settings.' : '');
      }
    } catch {
      if (current !== saved) return;
      caption.textContent = 'Load in Star Citizen';
      status.textContent = 'Could not read the bindings. Check the selected LIVE folder and try again.';
    } finally {
      if (current === saved) check.disabled = false;
    }
  });

  return {
    show(saved, justSaved = false) {
      current = saved;
      panel.hidden = !saved;
      expand(Boolean(saved && justSaved));
      if (!saved) return;
      element('handoff-name').textContent = (justSaved ? 'Layout saved · ' : '') + saved.name;
      element('handoff-preset').textContent = saved.name;
      caption.textContent = 'In-game load instructions';
      check.hidden = status.hidden = !saved.sourceId.startsWith('export:');
      check.disabled = false;
      status.removeAttribute('data-result');
      status.textContent = 'After loading, check the joystick bindings Star Citizen has written to disk.';
      undo.hidden = retry.hidden = true;
      checkAvailability();
      if (justSaved) requestAnimationFrame(() => {
        if (saved === current) toggle.focus({ preventScroll: true });
      });
    },
  };
}
