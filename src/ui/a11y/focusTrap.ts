/** Focusable elements inside a container (for dialog focus traps). */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function getFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.hasAttribute('disabled') || el.getAttribute('aria-hidden') === 'true') {
      return false;
    }
    if (el.tabIndex < 0) return false;
    // Visibility (works for fixed-position dialogs where offsetParent is null)
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return true;
  });
}

/**
 * Trap Tab focus inside `root`. Returns cleanup.
 * Focuses the first focusable (or `initial`) on attach.
 */
export function trapFocus(root: HTMLElement, initial?: HTMLElement | null): () => void {
  const prev = document.activeElement as HTMLElement | null;

  const focusFirst = () => {
    const list = getFocusable(root);
    const target = initial && list.includes(initial) ? initial : list[0];
    target?.focus();
  };

  // Defer so dialog content is mounted
  const t = window.setTimeout(focusFirst, 0);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const list = getFocusable(root);
    if (list.length === 0) {
      e.preventDefault();
      return;
    }
    const first = list[0]!;
    const last = list[list.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (active === first || !root.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !root.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  };

  root.addEventListener('keydown', onKeyDown);
  return () => {
    window.clearTimeout(t);
    root.removeEventListener('keydown', onKeyDown);
    if (prev && typeof prev.focus === 'function') {
      try {
        prev.focus();
      } catch {
        /* ignore */
      }
    }
  };
}
