import { humaniseAction, relativeTime } from '../format.js';
import { onChanged, read, unread, write } from '../store.js';

// The tab ids the markup carries until the Notifications tab lands (plan Task 9).
const TABS = ['todos', 'reviews', 'mine'];

const EMPTY_MESSAGES = {
  todos: 'No pending to-dos.',
  reviews: 'Nothing is waiting on your review.',
  mine: 'You have no open merge requests.',
};

const byId = (id) => document.getElementById(id);
const rowTemplate = byId('row-template');

let state = null;

/**
 * Fire-and-forget: the popup is destroyed the moment the browser opens the authorization
 * window or a new tab, so the reply frequently never arrives. Every outcome the user needs to
 * see is written to storage by the worker instead (design §10).
 */
function send(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function renderSignIn(inbox) {
  const message = inbox?.error?.kind === 'auth' ? inbox.error.message : '';
  const strip = byId('signin-error');
  strip.textContent = message;
  strip.hidden = message === '';
}

/**
 * An empty `src` resolves to the document's own URL, so the browser would fetch the popup's
 * own HTML as an image and paint a broken-image icon; the attribute is left unset instead.
 */
function setAvatar(img, url) {
  if (url) img.src = url;
  else img.removeAttribute('src');
}

function renderHeader(me) {
  setAvatar(byId('avatar'), me?.avatarUrl ?? '');
  byId('username').textContent = me?.username ? `@${me.username}` : '';
}

function renderTabs(inbox, readIds, activeTab) {
  for (const tab of TABS) {
    document
      .querySelector(`.tab[data-tab="${tab}"]`)
      .setAttribute('aria-selected', String(tab === activeTab));
    document.querySelector(`.count[data-count="${tab}"]`).textContent = inbox
      ? String(visibleItems(inbox, readIds, tab).length)
      : '';
  }
}

/**
 * The rows a tab shows. Only to-dos can be marked read: the other two lists mirror live
 * GitLab state, where hiding a row would just lose the user a merge request that is still
 * open and still theirs.
 */
function visibleItems(inbox, readIds, tab) {
  return tab === 'todos' ? unread(inbox.todos, readIds) : (inbox[tab] ?? []);
}

/**
 * The row's lead line. A to-do leads with what it asks of the user — "Review requested" — and
 * keeps its subject in the tooltip; a to-do with no action name has nothing else to lead with,
 * so it falls back to the subject. A merge request has no action and leads with its title.
 */
function titleFor(item, tab) {
  if (tab !== 'todos') return item.title;
  return humaniseAction(item.actionName) || item.title;
}

function metaFor(item, tab) {
  const parts =
    tab === 'todos'
      ? [item.project, item.authorName, relativeTime(item.createdAt)]
      : [item.reference, item.authorName, relativeTime(item.updatedAt)];
  return parts.filter(Boolean).join(' · ');
}

/**
 * Hides a to-do for good. The worker owns the write, as it does every other mutation
 * (design §10), and the local copy is marked too so the row leaves on the click rather than a
 * message round trip later.
 *
 * Unlike every other message the popup sends, this one is awaited: a caller that opens a link
 * calls `window.close()` next, and a message still in flight when this context is destroyed
 * never reaches the worker at all.
 */
async function markRead(item) {
  state.readIds[item.id] = true;
  await chrome.runtime.sendMessage({ type: 'markRead', id: item.id }).catch(() => {});
}

/**
 * Builds one row from the template. Titles come from the API, so every insertion goes through
 * textContent — never innerHTML.
 */
function buildRow(item, tab) {
  const node = rowTemplate.content.firstElementChild.cloneNode(true);
  const open = node.querySelector('.row-open');

  const avatar = open.querySelector('.row-avatar');
  setAvatar(avatar, item.authorAvatar ?? '');
  avatar.alt = item.authorName ?? '';

  open.querySelector('.chip').hidden = item.draft !== true;
  open.querySelector('.row-title-text').textContent = titleFor(item, tab);
  open.querySelector('.row-meta').textContent = metaFor(item, tab);
  // On a to-do the subject is not on the row at all, so the tooltip is where it lives.
  open.title = item.title;

  open.addEventListener('click', async () => {
    // A to-do or MR whose target was deleted has no URL; the row must not look clickable by
    // closing the popup with nothing to show for it, and nothing has been read either.
    if (!item.url) return;
    if (tab === 'todos') await markRead(item);
    chrome.tabs.create({ url: item.url });
    window.close();
  });

  const readButton = node.querySelector('.row-read');
  if (tab === 'todos') {
    readButton.addEventListener('click', () => {
      markRead(item);
      render();
    });
  } else {
    // Removed rather than hidden: `.row-read` sets its own `display`, which would beat the
    // browser's `[hidden] { display: none }` and leave a dead button on the row.
    readButton.remove();
  }

  return node;
}

function renderList(inbox, readIds, activeTab) {
  const warning = byId('warning');
  const empty = byId('empty');
  const truncated = byId('truncated');

  // No poll has ever succeeded: either there is no snapshot at all, or the one on record is
  // the placeholder `setError` fabricates before any fetch has completed, whose empty lists
  // say nothing about what GitLab actually holds. Either way, show the skeleton rather than a
  // false "no pending to-dos" (design §9).
  const noSnapshot = inbox === null || inbox.fetchedAt === 0;
  byId('skeleton').hidden = !noSnapshot;
  byId('list').hidden = noSnapshot;
  warning.hidden = true;
  empty.hidden = true;
  truncated.hidden = true;

  // The error strip reflects a failed poll regardless of whether a snapshot exists yet — the
  // user still needs to know the poll failed even while the skeleton is showing.
  if (inbox?.error) {
    warning.textContent = inbox.error.message;
    warning.hidden = false;
  }

  if (noSnapshot) {
    byId('list').replaceChildren();
    return;
  }

  const items = visibleItems(inbox, readIds, activeTab);
  byId('list').replaceChildren(...items.map((item) => buildRow(item, activeTab)));

  if (items.length === 0) {
    empty.textContent = EMPTY_MESSAGES[activeTab];
    empty.hidden = false;
  } else if (inbox.truncated?.[activeTab]) {
    truncated.textContent = `Showing the first ${items.length}. Open GitLab for the rest.`;
    truncated.hidden = false;
  }
}

function renderFooter(inbox) {
  byId('updated').textContent = inbox?.fetchedAt ? `updated ${relativeTime(inbox.fetchedAt)}` : '';
}

function render() {
  const { auth, me, inbox, readIds, ui } = state;
  // A dead session renders as the sign-in screen even though `auth` was already cleared
  // (design §9, state 5).
  const signedIn = auth !== null && inbox?.error?.kind !== 'auth';

  byId('signin').hidden = signedIn;
  byId('main').hidden = !signedIn;

  if (!signedIn) {
    renderSignIn(inbox);
    return;
  }

  const activeTab = TABS.includes(ui?.activeTab) ? ui.activeTab : 'todos';
  renderHeader(me);
  renderTabs(inbox, readIds, activeTab);
  renderList(inbox, readIds, activeTab);
  renderFooter(inbox);
}

async function load() {
  state = await read();
  render();
}

byId('signin-button').addEventListener('click', () => send({ type: 'signIn' }));
byId('refresh').addEventListener('click', () => send({ type: 'refresh' }));
byId('signout').addEventListener('click', () => send({ type: 'signOut' }));

byId('tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('.tab')?.dataset.tab;
  if (!tab) return;
  state.ui = { activeTab: tab };
  render();
  // Persisted so reopening the popup lands where the user left it (design §9).
  write({ ui: state.ui });
});

// The worker writes the snapshot from an alarm that can fire while the popup is open, so
// rendering follows storage rather than the message replies.
onChanged(() => load());

load();
