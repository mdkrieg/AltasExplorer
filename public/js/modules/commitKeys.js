/**
 * Commit Keys Module
 *
 * One rule for the whole app: Ctrl+Enter (Cmd+Enter on macOS) commits the
 * innermost thing that can be committed. An inline editor claims the key
 * first; only once nothing is being edited does the surrounding modal claim
 * it. So in the TODO modal, the first Ctrl+Enter confirms the comment you are
 * typing and the second saves the TODO.
 *
 * Two ways to opt in:
 *
 *   Declarative — mark a container `data-commit-scope` and its primary button
 *   `data-commit-action`. installCommitScopes() walks up from the focused
 *   element to the nearest scope and clicks its action. Modal overlays get
 *   `data-commit-root` as well, which makes them the fallback target when
 *   focus is not inside any scope (e.g. it fell back to <body> after an
 *   inline edit re-rendered its row).
 *
 *   Imperative — onCommitKey() for surfaces whose commit is real logic rather
 *   than a button click, and addMonacoCommitCommand() for Monaco editors,
 *   which swallow keys before they reach the DOM.
 *
 * Nesting works through normal propagation: an inner onCommitKey() handler
 * stops the event, so the document-level scope resolver never sees it.
 *
 * Opt out of an entire subtree with `data-commit-ignore` — used by the hotkey
 * recorder, where Ctrl+Enter is a value being captured, not a command.
 */

/**
 * True when the event is the app's commit chord. Shift and Alt are excluded
 * so modified variants stay available for other bindings.
 */
export function isCommitKey(event) {
  return event.key === 'Enter'
    && (event.ctrlKey || event.metaKey)
    && !event.altKey
    && !event.shiftKey;
}

function isVisible(el) {
  return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
}

/**
 * The primary action button belonging to `scope` — descendants that sit
 * inside a nested scope belong to that scope instead, not this one.
 */
function actionFor(scope) {
  const candidates = scope.querySelectorAll('[data-commit-action]');
  for (const btn of candidates) {
    if (btn.closest('[data-commit-scope]') !== scope) continue;
    if (btn.disabled || !isVisible(btn)) continue;
    return btn;
  }
  return null;
}

/**
 * Innermost open modal root, used when focus is not inside any scope.
 * Highest stacking order wins; ties break toward the later element, which is
 * how the modals are layered in index.html.
 */
function topmostRoot() {
  const roots = [...document.querySelectorAll('[data-commit-root]')].filter(isVisible);
  let best = null;
  let bestZ = -Infinity;
  roots.forEach(root => {
    const z = parseInt(window.getComputedStyle(root).zIndex, 10);
    const zIndex = isNaN(z) ? 0 : z;
    if (zIndex >= bestZ) { bestZ = zIndex; best = root; }
  });
  return best;
}

/**
 * Attach a Ctrl+Enter handler to a DOM element.
 *
 * The handler claims the event (preventDefault + stopPropagation) so outer
 * scopes do not also fire — this is what makes the nesting work. Return
 * `false` from the handler to decline and let the event continue outward,
 * which is how a handler says "nothing here is being edited".
 *
 * @param {Element}  el
 * @param {Function} handler – receives the event; return false to decline
 */
export function onCommitKey(el, handler) {
  if (!el) return;
  el.addEventListener('keydown', (event) => {
    if (!isCommitKey(event)) return;
    if (event.target.closest && event.target.closest('[data-commit-ignore]')) return;
    if (handler(event) === false) return;
    event.preventDefault();
    event.stopPropagation();
  });
}

/**
 * Bind Ctrl+Enter inside a Monaco editor. Monaco handles keys on its own
 * hidden textarea and does not surface them as ordinary DOM keydowns, so its
 * command API is the only reliable way in.
 *
 * @param {object}   editor  – monaco.editor.IStandaloneCodeEditor
 * @param {Function} handler
 */
export function addMonacoCommitCommand(editor, handler) {
  if (!editor || typeof editor.addCommand !== 'function') return;
  if (typeof monaco === 'undefined') return;
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, handler);
}

let scopesInstalled = false;

/**
 * Install the document-level resolver for declaratively marked scopes.
 * Called once at startup. Bubble phase, so imperative handlers registered on
 * inner elements get first refusal.
 */
export function installCommitScopes() {
  if (scopesInstalled) return;
  scopesInstalled = true;

  document.addEventListener('keydown', (event) => {
    if (!isCommitKey(event)) return;

    const target = event.target;
    if (target && target.closest && target.closest('[data-commit-ignore]')) return;

    // Walk outward: a scope whose action is hidden or disabled (a collapsed
    // rule editor, say) defers to the scope enclosing it.
    let scope = target && target.closest ? target.closest('[data-commit-scope]') : null;
    let button = null;
    while (scope && !button) {
      button = actionFor(scope);
      if (!button) scope = scope.parentElement?.closest('[data-commit-scope]') || null;
    }

    if (!button) {
      const root = topmostRoot();
      button = root ? actionFor(root) : null;
    }

    if (!button) return;
    event.preventDefault();
    // stopImmediatePropagation, not stopPropagation: the global hotkey
    // dispatcher also listens on document, and Ctrl+Enter is bound there to
    // open_item ("open selected item in a new panel"). Same node, so only the
    // immediate form suppresses it — which is why this listener is installed
    // first. We reach here only when a scope actually claimed the chord, so
    // open_item still works normally with no modal open.
    event.stopImmediatePropagation();
    button.click();
  });
}
