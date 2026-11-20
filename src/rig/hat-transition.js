const active = new WeakMap();

// Draw the moving faces in an inert layer. The real summary and direction
// buttons already occupy their final positions for hit testing and focus.
function face(source, className) {
  const copy = document.createElement('span');
  copy.className = className;
  for (const child of source.children) copy.append(child.cloneNode(true));
  return copy;
}

export function animateHatTransition(chip, detailed, directionsSize, previousBox, nextBox) {
  const previous = active.get(chip);
  const from = previous ? previous.openness() : Number(!detailed);
  previous?.clear();
  const to = Number(detailed);
  if (from === to || !previousBox || !nextBox || chip.hidden ||
      matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const layer = document.createElement('span');
  layer.className = 'rig-hat-motion';
  layer.setAttribute('aria-hidden', 'true');
  layer.inert = true;
  const summaryBox = detailed ? previousBox : nextBox;
  const summary = face(chip.querySelector('.rig-hat-summary'), 'rig-hat-motion-summary');
  summary.style.width = summaryBox.w + 'px';
  const grid = document.createElement('span');
  grid.className = 'rig-hat-motion-grid';
  const directions = chip.querySelector('.rig-compact-directions');
  grid.dataset.hatName = directions.dataset.hatName;
  grid.style.width = ((detailed ? nextBox : previousBox).w || directionsSize[0]) + 'px';
  for (const button of directions.children) {
    const tile = face(button, 'rig-compact-direction rig-hat-motion-slot');
    tile.dataset.direction = button.dataset.direction;
    tile.classList.toggle('rig-hat-empty', button.classList.contains('rig-hat-empty'));
    tile.toggleAttribute('data-active', button.hasAttribute('data-active'));
    grid.append(tile);
  }
  layer.append(summary, grid);
  chip.append(layer);
  chip.classList.add('rig-hat-animating');

  const dx = previousBox.x - nextBox.x + (previousBox.w - nextBox.w) / 2;
  const dy = previousBox.y - nextBox.y + (previousBox.h - nextBox.h) / 2;
  const frames = [from, to];
  const timing = { duration: 180 * Math.abs(to - from), easing: 'cubic-bezier(.22,.65,.32,1)', fill: 'both' };
  const travel = layer.animate(frames.map(p => {
    const offset = detailed ? 1 - p : p;
    return { transform: `translate(${offset * dx}px, ${offset * dy}px)` };
  }), timing);
  const gridMotion = grid.animate(frames.map(p => ({
    opacity: p, transform: `scale(${.69 + .31 * p}, ${.55 + .45 * p})`
  })), timing);
  const summaryMotion = summary.animate(frames.map(p => ({
    opacity: 1 - p, transform: `scale(${1 + .08 * p})`
  })), timing);

  const motion = {
    openness: () => from + (to - from) * (travel.effect.getComputedTiming().progress ?? 0),
    clear() {
      if (active.get(chip) !== motion) return;
      active.delete(chip);
      layer.remove();
      chip.classList.remove('rig-hat-animating');
      for (const animation of [travel, gridMotion, summaryMotion]) animation.cancel();
    }
  };
  active.set(chip, motion);
  travel.onfinish = travel.oncancel = motion.clear;
}
