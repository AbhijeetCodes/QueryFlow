// First-visit card: what QueryFlow does, shown once per browser. main.js loads this
// module only when `queryflow.welcomed` isn't set, so returning visitors never fetch it.

const isMac = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '');
const MOD = isMac ? '⌘' : 'Ctrl+';

// Phones and tablets get touch wording (or skip the line) instead of keyboard shortcuts.
const touch = globalThis.matchMedia?.('(hover: none)').matches;
// Phone-sized screens (the one-view-at-a-time layout in styles.css) also get a note about it.
const small = globalThis.matchMedia?.('(max-width: 820px)').matches;

// [title, text, text on touch screens (null: leave the line out; undefined: same text)]
const FEATURES = [
  ['Format and lint', `${MOD}⇧F tidies the query; warnings catch joins that change the numbers.`,
    'the Format button tidies the query; warnings catch joins that change the numbers.'],
  ['Graph and Steps', 'how the tables and CTEs feed each other.'],
  ['Values in one place', 'edit variables, filter values and date windows on the right.',
    small ? 'edit variables, filter values and date windows in the Values view.' : undefined],
  ['Navigate like code', 'hover a name, F12 to jump to it, F2 to rename it.', null],
  ['Run on test data', 'try a BigQuery query on a few rows you type in.'],
  ['Private', 'nothing leaves your browser, not even with share links.'],
];

export function showWelcome() {
  const lines = FEATURES.map(([b, t, tt = t]) => [b, touch ? tt : t]).filter(([, t]) => t);
  const el = document.createElement('aside');
  el.className = 'welcome';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-labelledby', 'welcome-title');
  el.innerHTML = `
    <div class="welcome-head">
      <b id="welcome-title"><span class="welcome-icon" aria-hidden="true">i</span>Welcome to QueryFlow</b>
      <button class="icon-btn sm" data-close aria-label="Close">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      </button>
    </div>
    <p class="welcome-sub">A SQL editor for BigQuery, PostgreSQL and MySQL that runs in your browser.</p>
    ${small ? '<p class="welcome-note"><b>Best viewed on a desktop.</b> On a phone you can still read, check and run queries: switch between them with the bar at the bottom.</p>' : ''}
    <ul class="welcome-list">
      ${lines.map(([b, t]) => `<li><b>${b}:</b> ${t}</li>`).join('')}
    </ul>
    <div class="welcome-foot">
      <span>More in the ⋯ menu</span>
      <button class="btn primary sm" data-close>Got it</button>
    </div>`;

  const close = () => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 200);
  };
  el.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });

  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
}
