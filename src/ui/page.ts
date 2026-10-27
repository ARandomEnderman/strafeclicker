// Cleanup for whatever the current page subscribed to; run on every navigation.
const cleanups: (() => void)[] = [];

export function onLeave(fn: () => void) {
  cleanups.push(fn);
}

export function leavePage() {
  while (cleanups.length) cleanups.pop()!();
}
