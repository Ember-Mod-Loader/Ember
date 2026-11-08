import '@fontsource-variable/manrope';
import '@fontsource-variable/space-grotesk';
import './styles.css';
import { GAMES, getGame } from './catalog.js';
import { createManager, MAX_IMPORT_LENGTH, PROFILE_NAME_LIMIT, WALLPAPERS } from './model.js';
import { icon } from './icons.js';
import { createStartupUpdateFlow } from './startup-updates.js';

const desktop = window.modRelayDesktop;
const CLIENT_VERSION = __APP_VERSION__;
const manager = createManager(undefined, { live: true });
const availableGames = GAMES.filter(game => ['lethal-company', 'repo', 'peak', 'mimesis'].includes(game.id));
if (!availableGames.some(game => game.id === manager.game.id)) manager.switchGame(availableGames[0].id);
const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const toasts = document.querySelector('#toasts');
const startup = document.querySelector('#startup');
let startupRunning = false;
let clientUpdateEventsSeen = 0;
const pages = {
  browse: ['Browse mods', 'compass'],
  library: ['Installed mods', 'layers'],
  favorites: ['Favorites', 'heart'],
  profiles: ['Profiles', 'users'],
  downloads: ['Downloads', 'download'],
  settings: ['Settings', 'settings'],
};
const compactNumber = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const displayTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const emptyFeed = () => ({ mods: [], count: 0, categories: [], hasMore: false, page: 0, loading: false, error: '' });
const ui = { page: 'browse', query: '', category: '', sort: '', showDeprecated: false, library: 'all', menu: false, dialog: null, feed: emptyFeed(), downloading: false, detail: null, checkingUpdates: false, gameStatus: undefined, gameBusy: false, downloads: [] };
const startupUpdates = createStartupUpdateFlow({
  start: typeof desktop?.startupClientUpdate === 'function' ? () => desktop.startupClientUpdate() : undefined,
  finish: () => desktop?.finishClientStartup?.(),
  onStatus: status => { ui.clientUpdate = status; renderStartupUpdate(status); },
});
let presenceState = { status: typeof desktop?.presenceStatus === 'function' ? 'connecting' : 'not-configured', count: null, updatedAt: null };
let presenceEventsSeen = 0;
let requestNumber = 0;
let gameStatusRequestNumber = 0;
let runningStatusPolling = false;
let runningStatusTimer;
let searchTimer;
let searchComposing = false;
let renderAfterComposition = false;
let prefetchTimer;
const removedDownloadIds = new Set();
const catalogObserver = new IntersectionObserver(entries => {
  if (entries.some(entry => entry.isIntersecting) && startup.dataset.ready === 'true' &&
      manager.live && ui.page === 'browse' && ui.feed.hasMore && !ui.feed.loading && !ui.feed.error &&
      ui.feed.requestKey === catalogRequestKey()) {
    void loadCatalog(true);
  }
}, { rootMargin: '5000px 0px' });

const esc = (value = '') => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
function updateDate(value) {
  if (!Number.isFinite(Date.parse(value))) return 'Update date unavailable';
  const date = new Date(value);
  const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));
  const [amount, unit] = days >= 365 ? [Math.floor(days / 365), 'year']
    : days >= 30 ? [Math.floor(days / 30), 'month'] : [days, 'day'];
  return `Updated <time datetime="${date.toISOString()}" title="${esc(displayTime.format(date))}">${esc(relativeTime.format(-amount, unit))}</time>`;
}
const asset = path => `${import.meta.env.BASE_URL}${path.replace(/^(?:\.\/|\/)/, '')}`;
const plural = (number, noun) => `${number} ${noun}${number === 1 ? '' : 's'}`;
const SHORT_PROFILE_CODE = /^(?:EMBER-)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const gameArt = (game, sizeClass = '') => `<img class="game-art ${sizeClass}" src="${esc(asset(game.icon))}" alt="">`;
const modArt = (mod, sizeClass = '') => mod.icon
  ? `<img class="mod-art ${sizeClass}" src="${esc(mod.icon.startsWith('https://') ? mod.icon : asset(mod.icon))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
  : `<span class="mod-art fallback-art ${sizeClass}">${icon('package', 27)}</span>`;
const pageLabel = page => pages[page][0];
const nativeLaunchSupported = () => manager.live && availableGames.some(game => game.id === manager.game.id);
const gameIsActive = () => Boolean(ui.gameStatus?.running || ui.gameStatus?.launchPending);
function launchPresentation() {
  if (ui.gameBusy) return { label: 'Please wait…', symbol: 'clock', disabled: true };
  if (ui.gameStatus?.running) return { label: 'Running', symbol: 'check', disabled: true };
  if (ui.gameStatus?.launchPending) return { label: 'Starting…', symbol: 'clock', disabled: true };
  if (ui.gameStatus?.statusError) return { label: 'Checking game…', symbol: 'clock', disabled: true };
  return { label: `${manager.live ? 'Launch' : 'Preview'} ${manager.state.settings.launchMode}`, symbol: 'play', disabled: false };
}

function updateLaunchControls() {
  const presentation = launchPresentation();
  const control = document.querySelector('[data-action="launch-default"]');
  if (control) {
    control.innerHTML = `${icon(presentation.symbol, 16)} ${esc(presentation.label)}`;
    control.disabled = presentation.disabled;
    control.setAttribute('aria-label', presentation.label);
  }
  for (const control of document.querySelectorAll('.game-actions [data-action="prepare-profile"], .game-actions [data-action="setup-request"], .game-actions [data-action="remove-loader-request"]')) {
    control.disabled = ui.gameBusy || gameIsActive();
  }
}
const errorMessage = error => String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
const PRESENCE_TOOLTIP = 'Active Ember app sessions in the last 90 seconds. Refreshes about every 30 seconds.';

function presencePresentation() {
  const online = presenceState.status === 'online' && Number.isSafeInteger(presenceState.count) && presenceState.count >= 0;
  const label = online ? `${presenceState.count.toLocaleString()} online`
    : presenceState.status === 'connecting' ? 'Connecting…' : 'Online count unavailable';
  return {
    status: online ? 'online' : presenceState.status === 'connecting' ? 'connecting' : 'unavailable',
    label,
    accessibleLabel: online ? `${presenceState.count.toLocaleString()} active Ember ${presenceState.count === 1 ? 'session' : 'sessions'} online` : label,
  };
}

function presencePill() {
  const { status, label, accessibleLabel } = presencePresentation();
  return `<div id="presence-status" class="presence-pill" data-status="${status}" role="status" aria-live="polite" aria-atomic="true" aria-label="${esc(accessibleLabel)}" title="${PRESENCE_TOOLTIP}"><span class="presence-dot" aria-hidden="true"></span><span class="presence-text">${esc(label)}</span></div>`;
}

function updatePresence(value) {
  const status = ['connecting', 'online', 'unavailable', 'not-configured'].includes(value?.status) ? value.status : 'unavailable';
  presenceState = {
    status,
    count: status === 'online' && Number.isSafeInteger(value?.count) && value.count >= 0 ? value.count : null,
    updatedAt: typeof value?.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt)) ? value.updatedAt : null,
  };
  const pill = document.querySelector('#presence-status');
  if (!pill) return;
  const presentation = presencePresentation();
  if (pill.dataset.status !== presentation.status) pill.dataset.status = presentation.status;
  const text = pill.querySelector('.presence-text');
  if (text.textContent !== presentation.label) text.textContent = presentation.label;
  if (pill.getAttribute('aria-label') !== presentation.accessibleLabel) pill.setAttribute('aria-label', presentation.accessibleLabel);
}

function button(label, glyph, action, options = {}) {
  const { id, style = '', disabled = false, end, pressed } = options;
  return `<button type="button" class="button ${style}" data-action="${action}"${id !== undefined ? ` data-id="${esc(id)}"` : ''}${disabled ? ' disabled' : ''}${pressed !== undefined ? ` aria-pressed="${pressed}"` : ''}>${glyph ? icon(glyph, 16) : ''}<span>${esc(label)}</span>${end ? icon(end, 15) : ''}</button>`;
}

function iconButton(label, glyph, action, id, selected = false) {
  return `<button type="button" class="icon-button${selected ? ' selected' : ''}" aria-label="${esc(label)}" title="${esc(label)}" data-action="${action}"${id !== undefined ? ` data-id="${esc(id)}"` : ''}${action === 'favorite' ? ` aria-pressed="${selected}"` : ''}>${icon(glyph, 17)}</button>`;
}

function nav(page, count) {
  const glyph = pages[page][1];
  const label = pageLabel(page);
  return `<button type="button" class="nav-item${ui.page === page ? ' current' : ''}" data-action="navigate" data-id="${page}"${ui.page === page ? ' aria-current="page"' : ''}>${icon(glyph, 18)}<span>${label}</span>${count ? `<small>${count}</small>` : ''}</button>`;
}

function render() {
  if (searchComposing && document.activeElement?.id === 'search-input') {
    renderAfterComposition = true;
    return;
  }
  reportClientBusy();
  document.documentElement.dataset.wallpaper = manager.state.settings.wallpaper;
  const { game, profile, installed, updates } = manager;
  const enabledCount = installed.filter(entry => entry.enabled).length;
  const mode = manager.state.settings.launchMode;
  const focused = app.contains(document.activeElement) ? document.activeElement : null;
  const selector = focusSelector(focused);
  const searchSelection = focused?.id === 'search-input'
    ? { value: focused.value, start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection } : null;
  app.innerHTML = `
    <a class="skip" href="#main">Skip to content</a>
    ${ui.menu ? '<button class="nav-overlay" data-action="menu" aria-label="Close navigation"></button>' : ''}
    <aside class="sidebar${ui.menu ? ' open' : ''}">
      <button type="button" class="brand" data-action="navigate" data-id="browse" aria-label="Ember home">
        <img src="${asset('/art/ember-flame.png')}" alt="">
        <span>EMBER<small>MOD MANAGER</small></span>
      </button>
      <div class="game-section">
        <div class="side-label">ACTIVE GAME</div>
        <button type="button" class="game-picker" data-action="games" aria-label="Change game, ${esc(game.name)}">
          ${gameArt(game)}<span><strong>${esc(game.name)}</strong><small>Switch game</small></span>${icon('chevrons', 16)}
        </button>
      </div>
      <nav aria-label="Workspace">
        <div class="nav-group"><div class="side-label">LIBRARY</div>
          ${nav('browse')}${nav('library', installed.length)}${nav('favorites')}${nav('downloads', activeDownloads())}
        </div>
        <div class="nav-group"><div class="side-label">MANAGE</div>
          ${nav('profiles')}${nav('settings')}
        </div>
      </nav>
      <div class="sidebar-bottom">
        <div class="launch-panel">
          <div class="launch-caption"><span class="status-dot${enabledCount ? ' active' : ''}" aria-hidden="true"></span><span><strong>${enabledCount.toLocaleString()}</strong> ${enabledCount === 1 ? 'mod' : 'mods'} enabled</span></div>
          ${!manager.live || nativeLaunchSupported() ? `<div class="launch-actions">
            ${button(launchPresentation().label, launchPresentation().symbol, 'launch-default', { style: 'primary launch-button', disabled: launchPresentation().disabled })}
            <button class="launch-options" type="button" data-action="launch-options" aria-label="Launch options" title="Launch options">${icon('down', 16)}</button>
          </div>` : ''}
          ${updates.length ? `<button type="button" class="launch-update" data-action="show-updates">${icon('refresh', 13)} ${plural(updates.length, 'update')} available</button>` : ''}
        </div>
        <div class="sidebar-footer"><span>EMBER</span><span>v${esc(CLIENT_VERSION)}</span></div>
      </div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <div class="breadcrumbs">
          <button class="mobile-menu icon-button" type="button" data-action="menu" aria-label="Open navigation" aria-expanded="${ui.menu}">${icon('menu', 21)}</button>
          <span class="crumb-game">${esc(game.name)}</span>${icon('chevron', 13)}<strong>${pageLabel(ui.page)}</strong>
        </div>
        <div class="top-actions">
          <button type="button" class="source-badge demo-badge" data-action="about"><span></span>Thunderstore</button>
          ${presencePill()}
          <button type="button" class="profile-picker" data-action="pick-profile" aria-label="Switch profile, ${esc(profile.name)}">
            <span class="profile-icon">${icon('users', 15)}</span><span class="profile-picker-name">${esc(profile.name)}</span>${icon('down', 15)}
          </button>
        </div>
      </header>
      <main id="main" class="content${manager.state.settings.compactMode ? ' compact' : ''}" tabindex="-1">${renderPage()}</main>
    </div>`;
  if (selector) {
    const replacement = app.querySelector(selector);
    replacement?.focus({ preventScroll: true });
    if (searchSelection && replacement?.value === searchSelection.value && Number.isInteger(searchSelection.start)) {
      replacement.setSelectionRange(searchSelection.start, searchSelection.end, searchSelection.direction ?? 'none');
    }
  }
  observeCatalog();
}

function focusSelector(element) {
  if (!element) return null;
  if (element.id) return `#${CSS.escape(element.id)}`;
  const attribute = ['data-action', 'data-toggle-mod'].find(name => element.hasAttribute(name));
  if (!attribute) return null;
  const id = element.getAttribute('data-id');
  return `[${attribute}="${CSS.escape(element.getAttribute(attribute))}"]${id === null ? '' : `[data-id="${CSS.escape(id)}"]`}`;
}

function heading(kicker, title, subtitle, actions = '') {
  return `<div class="page-heading">
    <div><p class="eyebrow"><span></span>${esc(kicker)}</p><h1>${esc(title)}</h1>${subtitle ? `<p class="subtitle">${esc(subtitle)}</p>` : ''}</div>
    ${actions ? `<div class="heading-actions">${actions}</div>` : ''}
  </div>`;
}

function renderPage() {
  switch (ui.page) {
    case 'browse': return browsePage();
    case 'favorites': return favoritesPage();
    case 'library': return libraryPage();
    case 'profiles': return profilesPage();
    case 'downloads': return downloadsPage();
    case 'settings': return settingsPage();
  }
}

function browsePage() {
  const count = manager.live ? ui.feed.count : manager.catalog.length;
  return `
    <section class="catalog-section" aria-labelledby="catalog-title">
      <div class="section-heading"><div class="catalog-title"><h1 id="catalog-title">Explore the catalog</h1><span class="total-badge">${count.toLocaleString()} mods</span></div></div>
      <div class="catalog-controls">${searchField('Search mods…')}${categoryControls()}${sortControls()}</div>
      <label class="deprecated-filter"><input id="show-deprecated" type="checkbox"${ui.showDeprecated ? ' checked' : ''}><span>Show deprecated</span></label>
      <div id="results" aria-live="polite">${catalogResults()}</div>
    </section>`;
}

function categoryControls() {
  return `<label class="category-control"><span class="sr-only">Category</span><select id="category-select" aria-label="Category">${categoryOptions()}</select></label>`;
}

function categoryOptions() {
  const choices = ui.feed.categories;
  return `<option value="">All categories</option>${choices.map(({ id, name }) => `<option value="${esc(id)}"${ui.category === id ? ' selected' : ''}>${esc(name)}</option>`).join('')}`;
}

function sortControls() {
  return `<div class="catalog-sort"><label class="sort-control">${icon('sort', 17)}<span class="sr-only">Sort mods</span><select id="catalog-sort" aria-label="Sort mods">${[
    ['', 'Default order'], ['popular', 'Most downloaded'], ['updated', 'Recently updated'], ['rating', 'Top rated'], ['newest', 'Newest'],
  ].map(([value, label]) => `<option value="${value}"${ui.sort === value ? ' selected' : ''}>${label}</option>`).join('')}</select>${icon('down', 14)}</label>${ui.sort ? iconButton('Clear sorting', 'close', 'clear-sort') : ''}</div>`;
}

function searchField(placeholder) {
  return `<label class="search-field">${icon('search', 18)}<span class="sr-only">${esc(placeholder.replace('…', ''))}</span><input id="search-input" type="search" placeholder="${esc(placeholder)}" value="${esc(ui.query)}" maxlength="160" autocomplete="off"><kbd>Ctrl K</kbd></label>`;
}

function match(mod) {
  const query = ui.query.trim().toLowerCase();
  return `${mod.name} ${mod.author} ${mod.description} ${mod.category}`.toLowerCase().includes(query);
}

function catalogResults() {
  const { mods, loading, error } = ui.feed;
  const grid = mods.length ? `<div class="mod-grid">${mods.map(modCard).join('')}</div>` : '';
  if (error && !grid) return empty('info', 'Thunderstore unavailable', error, button('Try again', 'refresh', 'reload-catalog'));
  if (loading && !grid) return empty('clock', 'Loading…', '');
  if (!grid) return empty('search', 'No matching mods', 'Try a different search or category.', button('Clear filters', null, 'clear-filters'));
  return `${grid}<div id="catalog-tail">${catalogTail()}</div>`;
}

function catalogTail() {
  if (ui.feed.error) return `<div class="catalog-sentinel" role="status"><span>${esc(ui.feed.error)}</span>${button('Try again', 'refresh', 'retry-more')}</div>`;
  if (!ui.feed.hasMore) return '<div class="catalog-sentinel" role="status">You’re all caught up.</div>';
  return `<div class="catalog-sentinel" data-catalog-sentinel role="status">${icon('clock', 16)}<span>${ui.feed.loading ? 'Loading…' : 'More mods load as you scroll'}</span></div>`;
}

function observeCatalog() {
  catalogObserver.disconnect();
  const sentinel = app.querySelector('[data-catalog-sentinel]');
  window.clearTimeout(prefetchTimer);
  if (sentinel && ui.page === 'browse' && !ui.feed.loading && !ui.feed.error &&
      ui.feed.requestKey === catalogRequestKey() && startup.dataset.ready === 'true') {
    catalogObserver.observe(sentinel);
    if (ui.feed.hasMore && ui.feed.mods.length < 120) {
      prefetchTimer = window.setTimeout(() => { void loadCatalog(true); }, 60);
    }
  }
}

function refreshCatalogTail() {
  const tail = app.querySelector('#catalog-tail');
  if (tail) tail.innerHTML = catalogTail();
  observeCatalog();
}

function refreshCatalogResults() {
  if (ui.page !== 'browse') return;
  const results = app.querySelector('#results');
  const search = app.querySelector('#search-input');
  const category = app.querySelector('#category-select');
  const sort = app.querySelector('#catalog-sort');
  const deprecated = app.querySelector('#show-deprecated');
  // Intentional filter resets still need fresh controls. Ordinary search responses
  // update results in place, retaining the input node, caret, and active IME.
  if (!results || search?.value !== ui.query || category?.value !== ui.category || sort?.value !== ui.sort ||
      deprecated?.checked !== ui.showDeprecated || Boolean(app.querySelector('[data-action="clear-sort"]')) !== Boolean(ui.sort)) {
    render();
    return;
  }
  const categoryKey = JSON.stringify(ui.feed.categories);
  if (category.dataset.optionsKey !== categoryKey) {
    category.innerHTML = categoryOptions();
    category.value = ui.category;
    category.dataset.optionsKey = categoryKey;
  }
  results.innerHTML = catalogResults();
  const total = app.querySelector('.catalog-title .total-badge');
  if (total) total.textContent = `${ui.feed.count.toLocaleString()} mods`;
  observeCatalog();
}

function catalogRequestKey() {
  return JSON.stringify([manager.game.id, ui.query, ui.category, ui.sort, ui.showDeprecated]);
}

function modLabels(mod, full = false) {
  const statuses = [
    mod.deprecated ? ['deprecated', 'Deprecated'] : null,
    mod.nsfw ? ['nsfw', 'NSFW'] : null,
    mod.pinned ? ['pinned', 'Pinned'] : null,
  ].filter(Boolean);
  const categories = [...new Set((mod.categories ?? []).map(item => item.name).filter(name => typeof name === 'string' && name.trim()))];
  if (!full) categories.sort((a, b) => Number(['Mods', 'Misc', 'BepInEx'].includes(a)) - Number(['Mods', 'Misc', 'BepInEx'].includes(b)));
  const visible = full ? categories : categories.slice(0, 2);
  const remaining = categories.slice(visible.length);
  if (!statuses.length && !categories.length) return '';
  return `<span class="mod-labels${full ? ' full' : ''}" aria-label="Mod tags and status">${statuses.map(([type, label]) => `<span class="mod-badge ${type}">${label}</span>`).join('')}${visible.map(name => `<span class="mod-tag" title="${esc(name)}">${esc(name)}</span>`).join('')}${remaining.length ? `<span class="mod-tag more-tags" title="${esc(remaining.join(', '))}" aria-label="${esc(`${remaining.length} more tags: ${remaining.join(', ')}`)}">+${remaining.length}</span>` : ''}</span>`;
}

function modCard(mod) {
  const entry = manager.installed.find(item => item.id === mod.id);
  const favorite = manager.state.favorites.includes(mod.id);
  return `<article class="mod-card">
    <div class="mod-card-top">
      <button type="button" class="mod-link" data-action="mod-details" data-id="${esc(mod.id)}">
        ${modArt(mod)}<span class="mod-identity"><strong>${esc(mod.name)}</strong><small>by ${esc(mod.author)}</small></span>
      </button>
      ${iconButton(favorite ? `Remove ${mod.name} from favorites` : `Favorite ${mod.name}`, 'heart', 'favorite', mod.id, favorite)}
    </div>
    ${modLabels(mod)}
    <p class="mod-description">${esc(mod.description)}</p>
    <div class="mod-card-bottom">
      <div class="mod-stats"><span class="downloads" title="${mod.downloads.toLocaleString()} downloads">${icon('download', 14)} ${compactNumber.format(mod.downloads)}</span>${manager.live ? `<span class="mod-updated">${updateDate(mod.updatedAt)}</span>` : ''}</div>
      ${entry ? button(entry.hasUpdate ? 'Update' : 'Installed', entry.hasUpdate ? 'refresh' : 'check', entry.hasUpdate ? 'update' : 'mod-details', { id: mod.id, style: entry.hasUpdate ? 'small outline-purple' : 'small installed', disabled: entry.hasUpdate && ui.downloading }) : button(manager.live ? 'Download' : 'Install', manager.live ? 'download' : 'plus', 'install', { id: mod.id, style: 'small outline-purple', disabled: manager.live && ui.downloading })}
    </div>
  </article>`;
}

function empty(glyph, title, description, action = '') {
  return `<div class="empty"><span class="empty-icon">${icon(glyph, 25)}</span><h3>${esc(title)}</h3>${description ? `<p>${esc(description)}</p>` : ''}${action}</div>`;
}

function favoritesPage() {
  const all = favoriteMods();
  return `${heading('YOUR COLLECTION', 'Favorites', 'Keep the mods you want to come back to in one place.')}
    ${all.length ? `<div class="page-tools">${searchField('Search favorites…')}<span class="total-badge">${plural(all.length, 'favorite')}</span></div>` : ''}
    <div id="results" aria-live="polite">${favoriteResults()}</div>`;
}

function favoriteResults() {
  const all = favoriteMods();
  const mods = all.filter(match);
  if (mods.length) return `<div class="mod-grid">${mods.map(modCard).join('')}</div>`;
  return all.length
    ? empty('search', 'No matching favorites', 'Try another search term.')
    : empty('heart', 'No favorites yet', 'Select the heart on any mod to save it here.', button('Browse mods', 'compass', 'navigate', { id: 'browse', style: 'primary' }));
}

function favoriteMods() {
  return manager.state.favorites.map(manager.packageById).filter(mod => mod?.gameId === manager.game.id);
}

function libraryPage() {
  const { installed, updates, profile } = manager;
  const actions = button('Share mods', 'upload', 'export', { id: profile.id }) + (manager.live
    ? button('Open downloads', 'file', 'open-downloads') +
      (updates.length ? button('Update all', 'refresh', 'update-all', { style: 'primary', disabled: ui.downloading }) : '') +
      (installed.length ? button(ui.checkingUpdates ? 'Checking…' : 'Check for updates', 'refresh', 'check-updates', { disabled: ui.checkingUpdates || ui.downloading }) : '')
    : updates.length ? button('Update all', 'refresh', 'update-all', { style: 'primary' }) : button('Browse mods', 'compass', 'navigate', { id: 'browse' }));
  return `${heading('YOUR COLLECTION', pageLabel('library'), '', actions)}
    <div class="stats-grid">
      ${stat('layers', 'Installed', installed.length)}
      ${stat('check', 'Enabled', installed.filter(entry => entry.enabled).length)}
      ${stat('refresh', 'Updates', updates.length)}
    </div>
    <div class="page-tools library-tools">
      <div class="category-list" aria-label="Filter profile mods">${[['all', 'All installed'], ['enabled', 'Enabled'], ['disabled', 'Disabled'], ['updates', 'Updates']].map(([id, label]) => `<button type="button" class="chip${ui.library === id ? ' active' : ''}" data-action="library-filter" data-id="${id}" aria-pressed="${ui.library === id}">${label}</button>`).join('')}</div>
      ${searchField('Search installed mods…')}
    </div>
    <div id="results" aria-live="polite">${libraryResults()}</div>`;
}

function stat(glyph, label, count) {
  return `<div class="stat"><span class="stat-icon">${icon(glyph, 18)}</span><div class="stat-content"><span>${label}</span><strong>${count.toLocaleString()}</strong></div></div>`;
}

function libraryResults() {
  const mods = manager.installed.filter(entry => match(entry.mod) && (
    ui.library === 'all' || (ui.library === 'enabled' && entry.enabled) ||
    (ui.library === 'disabled' && !entry.enabled) || (ui.library === 'updates' && entry.hasUpdate)
  ));
  if (!mods.length) return empty('layers', manager.installed.length ? 'No matching mods' : 'Your profile is empty', manager.installed.length ? 'Try another filter or search.' : 'Browse the catalog to add mods to this profile.', button('Browse mods', 'compass', 'navigate', { id: 'browse' }));
  return `<div class="list-panel">${mods.map(({ mod, id, version, enabled, hasUpdate }) => `
    <article class="list-row">
      <button class="mod-link" type="button" data-action="mod-details" data-id="${esc(id)}">
        ${modArt(mod, 'list-art')}<span class="mod-identity"><strong>${esc(mod.name)}</strong><small>${esc(mod.author)} · v${esc(version)}</small>${modLabels(manager.packageById(id) ?? mod)}${manager.live ? `<small>${updateDate(manager.packageById(id)?.updatedAt ?? mod.updatedAt)}</small>` : ''}</span>
      </button>
      <div class="row-actions">
        ${hasUpdate ? button('Update', 'refresh', 'update', { id, style: 'small outline-purple', disabled: ui.downloading }) : ''}
        <label class="switch-label"><input type="checkbox" class="switch" data-toggle-mod="${esc(id)}" aria-label="Enable ${esc(mod.name)}"${enabled ? ' checked' : ''}><span>${enabled ? 'Enabled' : 'Disabled'}</span></label>
        ${iconButton(`Remove ${mod.name}`, 'trash', 'remove-request', id)}
      </div>
    </article>`).join('')}</div>`;
}

function profilesPage() {
  return `${heading('WORKSPACE', 'Profiles', `Build separate mod lists and configs for ${manager.game.name}.`,
    button('Import profile', 'upload', 'import', { disabled: manager.live && ui.downloading }) + button('New profile', 'plus', 'profile-create', { style: 'primary' }))}
    <div class="profile-grid">${manager.profiles.map(profile => {
      const active = profile.id === manager.profile.id;
      return `<article class="profile-card${active ? ' active-profile' : ''}">
        <div class="profile-card-top"><span class="stat-icon">${icon('layers', 20)}</span>${active ? '<span class="total-badge">Active profile</span>' : ''}</div>
        <h2>${esc(profile.name)}</h2>
        <p>${plural(profile.mods.length, 'installed mod')}</p>
        <div class="profile-card-actions">${button(active ? 'Share profile' : 'Use profile', active ? 'upload' : 'check', active ? 'export' : 'select-profile', { id: profile.id, style: 'small outline-purple' })}
          ${iconButton('Profile options', 'settings', 'profile-options', profile.id)}
        </div>
      </article>`;
    }).join('')}</div>`;
}

function gameDownloads() {
  return manager.live ? ui.downloads.filter(item => item.gameId === manager.game.id) : [];
}

function activeDownloads() {
  return gameDownloads().filter(item => !['complete', 'failed'].includes(item.status)).length;
}

const byteFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const unit = bytes >= 1024 ** 3 ? 'GB' : bytes >= 1024 ** 2 ? 'MB' : 'KB';
  const divisor = unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : 1024;
  return `${byteFormat.format(bytes / divisor)} ${unit}`;
}

function downloadsPage() {
  const actions = manager.live ? button('Clear completed', 'check', 'clear-completed-downloads', {
    disabled: ui.clearingDownloads || !desktop?.clearCompletedDownloads || !gameDownloads().some(item => item.status === 'complete'),
  }) + button('Open downloads folder', 'file', 'open-downloads') : '';
  return `${heading('YOUR COLLECTION', 'Downloads', 'Completed downloads clear automatically after 30 seconds.', actions)}
    <div id="download-content">${downloadsContent()}</div>`;
}

function downloadsContent() {
  const items = gameDownloads();
  if (!items.length) return empty('download', 'No downloads to show', 'New downloads and updates for this game will appear here.', button('Browse mods', 'compass', 'navigate', { id: 'browse' }));
  return `<p class="download-summary" role="status">${downloadSummary()}</p>
    <div class="download-list">${items.map(downloadCard).join('')}</div>`;
}

function downloadSummary() {
  const items = gameDownloads();
  const complete = items.filter(item => item.status === 'complete').length;
  const failed = items.filter(item => item.status === 'failed').length;
  return `${activeDownloads()} active · ${complete} complete${failed ? ` · ${failed} failed` : ''}`;
}

function downloadCard(item) {
  const labels = { resolving: 'Finding dependencies', downloading: 'Downloading', saving: 'Saving to profile', complete: 'Complete', failed: 'Failed' };
  return `
      <article class="download-card" data-download-id="${esc(item.id)}">
        <div class="download-card-head"><div><h2>${esc(item.label)}</h2><p class="download-meta">${esc(item.profileName)} · ${esc(displayTime.format(new Date(item.createdAt)))}</p></div>
          <span class="download-status ${esc(item.status)}">${esc(labels[item.status])}</span>
        </div>
        ${item.packages.length ? item.packages.map(pkg => {
          const done = pkg.status === 'complete';
          const value = done ? 100 : pkg.total > 0 ? Math.min(99.9, pkg.received / pkg.total * 100) : pkg.status === 'queued' ? 0 : null;
          return `<div class="download-package">
            <div class="download-card-head"><strong>${esc(pkg.name)} <small>v${esc(pkg.version)}</small></strong><span class="download-meta">${done ? pkg.cached ? 'Cached' : 'Complete' : pkg.status === 'queued' ? 'Queued' : 'Downloading'}</span></div>
            <progress class="download-progress" max="100"${value === null ? '' : ` value="${value}"`} aria-label="${esc(pkg.name)} download progress"></progress>
            <p class="download-meta">${fileSize(pkg.received)}${pkg.total ? ` / ${fileSize(pkg.total)}` : ''}</p>
          </div>`;
        }).join('') : ['complete', 'failed'].includes(item.status) ? '' : '<progress class="download-progress" aria-label="Finding required packages"></progress>'}
        ${item.error ? `<p class="download-error" role="status">${esc(item.error)}</p>` : ''}
      </article>`;
}

function updateDownloadRecord(record) {
  if (record.removed) {
    removedDownloadIds.add(record.id);
    if (removedDownloadIds.size > 1000) removedDownloadIds.delete(removedDownloadIds.values().next().value);
    ui.downloads = ui.downloads.filter(item => item.id !== record.id);
    const content = document.querySelector('#download-content');
    if (content) content.innerHTML = downloadsContent();
    refreshDownloadIndicators();
    return;
  }
  if (removedDownloadIds.has(record.id)) return;
  const index = ui.downloads.findIndex(item => item.id === record.id);
  if (index < 0) ui.downloads.push(record);
  else if (record.updatedAt >= ui.downloads[index].updatedAt) ui.downloads[index] = record;
  else return;
  ui.downloads.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const content = document.querySelector('#download-content');
  if (content && record.gameId === manager.game.id) {
    const card = content.querySelector(`[data-download-id="${CSS.escape(record.id)}"]`);
    if (card) {
      card.outerHTML = downloadCard(record);
      content.querySelector('.download-summary').textContent = downloadSummary();
    } else {
      content.innerHTML = downloadsContent();
    }
  }
  refreshDownloadIndicators();
}

function refreshDownloadIndicators() {
  const clear = app.querySelector('[data-action="clear-completed-downloads"]');
  if (clear) clear.disabled = Boolean(ui.clearingDownloads || !desktop?.clearCompletedDownloads || !gameDownloads().some(item => item.status === 'complete'));
  const nav = app.querySelector('[data-id="downloads"].nav-item');
  if (nav) {
    nav.querySelector('small')?.remove();
    const active = activeDownloads();
    if (active) nav.insertAdjacentHTML('beforeend', `<small>${active}</small>`);
  }
}

async function clearCompletedDownloads() {
  if (ui.clearingDownloads || !desktop?.clearCompletedDownloads) return;
  ui.clearingDownloads = true;
  refreshDownloadIndicators();
  try {
    const ids = await desktop.clearCompletedDownloads(manager.game.id);
    for (const id of ids) updateDownloadRecord({ id, removed: true });
  } finally {
    ui.clearingDownloads = false;
    refreshDownloadIndicators();
  }
}

function downloadContext(workspace, profile, label) {
  const context = { id: crypto.randomUUID(), gameId: profile.gameId ?? workspace.game.id, profileId: profile.id, profileName: profile.name, label };
  const now = new Date().toISOString();
  updateDownloadRecord({ ...context, status: 'resolving', createdAt: now, updatedAt: now, packages: [], error: '' });
  return context;
}

async function finishDownload(context, error, profile) {
  try {
    if (desktop.finishDownload) {
      await desktop.finishDownload(context.id, error ? errorMessage(error) : null, profile ? { profileId: profile.id, profileName: profile.name } : undefined);
      return;
    }
  } catch (failure) {
    error = error ?? failure;
  }
  const record = ui.downloads.find(item => item.id === context.id);
  if (record) updateDownloadRecord({
    ...record, status: error ? 'failed' : 'complete', error: error ? errorMessage(error) : '',
    updatedAt: new Date().toISOString(),
  });
  if (error) throw error;
}

function settingsPage() {
  const settings = manager.state.settings;
  return `${heading('WORKSPACE', 'Settings', 'Manage your game setup and app preferences.')}
    ${nativeLaunchSupported() ? gameSetupPanel() : ''}
    <section class="settings-panel"><h2>Preferences</h2>
      <div class="settings-row"><div><strong>Wallpaper</strong><p>${esc(WALLPAPERS.find(item => item.id === settings.wallpaper)?.name)} · Choose Ember’s background.</p></div>${button('Wallpapers', null, 'wallpapers')}</div>
      <div class="settings-row"><div><strong>Codes</strong></div>${button('Codes', null, 'codes')}</div>
      ${nativeLaunchSupported() || !manager.live ? `<div class="settings-row"><div><label for="launch-mode">Default launch mode</label><p>Choose the primary launch button in the sidebar.</p></div><select id="launch-mode" class="field" data-setting="launchMode"><option value="modded"${settings.launchMode === 'modded' ? ' selected' : ''}>Modded</option><option value="vanilla"${settings.launchMode === 'vanilla' ? ' selected' : ''}>Vanilla</option></select></div>` : ''}
      ${settingToggle('confirmRemoval', 'Confirm mod removal', 'Confirm removals from the active profile. Dependency warnings always appear.')}
      ${settingToggle('compactMode', 'Compact mod cards', 'Fit more packages into the catalog by hiding card descriptions.')}
    </section>
    <section class="settings-panel"><h2>Client updates</h2>
      <div class="settings-row"><div><strong>Ember ${esc(CLIENT_VERSION)}</strong><p id="client-update-message">${esc(ui.clientUpdate?.message || 'Checking client update status…')}</p></div>${button('Update client', 'refresh', 'client-update', { disabled: ui.checkingClientUpdate })}</div>
    </section>
`;
}

function gameSetupPanel() {
  const status = ui.gameStatus;
  return `<section class="settings-panel game-setup">
    <h2>${esc(manager.game.name)} setup</h2>
    <p class="muted">${status === undefined ? 'Looking for your Steam installation…' : esc(status?.message || `Choose the ${manager.game.name} folder from your Steam library.`)}</p>
    ${status?.gameDir ? `<p class="game-path">${esc(status.gameDir)}</p>` : ''}
    <div class="game-actions">
      ${button('Choose game folder', 'file', 'choose-game', { disabled: ui.gameBusy })}
      ${button('Prepare profile', 'package', 'prepare-profile', { disabled: ui.gameBusy || gameIsActive() })}
      ${button('Open profile folder', 'file', 'open-profile')}
      ${status?.loader === 'clean' ? button('Set up modded launch', 'play', 'setup-request', { style: 'primary', disabled: ui.gameBusy || gameIsActive() }) : ''}
      ${status?.loader === 'managed' ? button('Remove loader', 'trash', 'remove-loader-request', { style: 'danger', disabled: ui.gameBusy || gameIsActive() }) : ''}
    </div>
  </section>`;
}

function settingToggle(id, label, description) {
  return `<div class="settings-row"><div><label for="${id}">${label}</label><p>${description}</p></div><input id="${id}" type="checkbox" class="switch" data-setting="${id}"${manager.state.settings[id] ? ' checked' : ''}></div>`;
}

function openDialog(type, id) {
  ui.dialog = { type, id };
  reportClientBusy();
  renderDialog();
  if (!dialog.open) dialog.showModal();
  (dialog.querySelector('[data-initial-focus]') ?? dialog.querySelector('[data-action="close-dialog"]'))?.focus();
}

function dialogHeader(title, description = '', closable = true) {
  return `<header class="dialog-header"><div><h2 id="dialog-title">${esc(title)}</h2>${description ? `<p>${esc(description)}</p>` : ''}</div>${closable ? iconButton('Close dialog', 'close', 'close-dialog') : ''}</header>`;
}

function renderDialog() {
  const { type, id } = ui.dialog;
  const focus = dialog.contains(document.activeElement) ? focusSelector(document.activeElement) : null;
  const profile = manager.profiles.find(item => item.id === id);
  dialog.className = type === 'mod' ? 'drawer' : 'modal';
  dialog.classList.toggle('launch-mode-dialog', type === 'launch-options');
  dialog.classList.toggle('dependency-dialog', ['toggle-dependencies', 'remove-dependencies'].includes(type));
  dialog.classList.toggle('wallpaper-dialog', type === 'wallpapers');
  switch (type) {
    case 'client-update': {
      const status = ui.clientUpdate;
      const installing = status?.status === 'installing';
      dialog.innerHTML = `${dialogHeader('Client updates', `Ember ${status?.version || CLIENT_VERSION}`, !installing)}
        <div class="dialog-form"><p class="launch-message">${esc(status?.message || 'Online client updates are not available yet.')}</p>
          ${installing ? '<p class="client-update-note">Ember will restart automatically to finish updating.</p>' : ''}
          ${status?.progress ? `<progress class="download-progress" max="100" value="${status.progress.percent}" aria-label="Client update download"></progress><p class="client-update-note">${Math.round(status.progress.percent)}% downloaded</p>` : ''}
        </div>
        <div class="dialog-footer">${installing ? '<p role="status">Restarting Ember…</p>' : button('View releases', 'diagonal', 'client-release-page') + (status?.status === 'downloaded' ? button('Install and restart', 'refresh', 'client-install', { style: 'primary' }) : status?.status === 'error' ? button('Try again', 'refresh', 'client-update', { style: 'primary' }) : button('Done', 'check', 'close-dialog', { style: 'primary' }))}</div>`;
      break;
    }
    case 'wallpapers':
      dialog.innerHTML = `${dialogHeader('Wallpapers', 'Choose the background for Ember.')}
        <div class="wallpaper-grid">${manager.wallpapers.map(wallpaper => {
          const selected = manager.state.settings.wallpaper === wallpaper.id;
          return `<button type="button" class="wallpaper-choice" data-action="select-wallpaper" data-id="${wallpaper.id}" aria-pressed="${selected}">
            <img src="${asset(wallpaper.file)}" alt="">
            <span class="wallpaper-name">${esc(wallpaper.name)}${selected ? icon('check', 18) : ''}</span>
          </button>`;
        }).join('')}</div>
        <div class="dialog-footer">${button('Done', 'check', 'close-dialog', { style: 'primary' })}</div>`;
      break;
    case 'codes':
      dialog.innerHTML = `${dialogHeader('Codes')}
        <form id="dialog-form" class="dialog-form">
          <label for="reward-code">Code<input id="reward-code" class="field reward-code" name="rewardCode" placeholder="Enter your code" maxlength="64" autocomplete="off" autocapitalize="characters" spellcheck="false" required data-initial-focus></label>
          <p class="form-error" role="alert" hidden></p>
          <div class="dialog-footer">${button('Cancel', null, 'close-dialog')}<button type="submit" class="button primary">Redeem code</button></div>
        </form>`;
      break;
    case 'code-reward': {
      const { wallpaper, status } = id;
      dialog.innerHTML = `${dialogHeader(status === 'already-unlocked' ? 'Already unlocked' : 'Wallpaper unlocked')}
        <div class="reward-preview"><img src="${asset(wallpaper.file)}" alt="${esc(wallpaper.name)} wallpaper preview"><h3>${esc(wallpaper.name)}</h3></div>
        <div class="dialog-footer">${button('Done', null, 'close-dialog')}${button('Use wallpaper', 'check', 'use-reward-wallpaper', { id: wallpaper.id, style: 'primary' })}</div>`;
      break;
    }
    case 'mod': {
      const mod = manager.packageById(id);
      const installed = manager.installed.find(item => item.id === id);
      const favorite = manager.state.favorites.includes(id);
      const dependencies = mod.dependencies;
      const details = ui.detail?.id === id ? ui.detail : null;
      dialog.innerHTML = `${dialogHeader('Mod details')}
        <div class="detail-body">
          <div class="detail-package">${modArt(mod, 'detail-art')}<div><div class="detail-category">${esc(mod.category)}</div><h3>${esc(mod.name)}</h3><p>by ${esc(mod.author)}</p></div></div>
          <p class="detail-description">${esc(mod.description)}</p>
          ${modLabels(mod, true)}
          ${mod.deprecated ? `<p class="deprecated-notice">${icon('info', 17)}<span><strong>Deprecated mod</strong>Marked as deprecated on Thunderstore. It may be outdated or no longer supported.</span></p>` : ''}
          <dl class="detail-stats"><div><dt>Latest version</dt><dd>${details?.loading ? 'Loading…' : mod.version ? `v${esc(mod.version)}` : 'Unavailable'}</dd></div><div><dt>Thunderstore downloads</dt><dd>${mod.downloads.toLocaleString()}</dd></div></dl>
          ${manager.live ? `<p class="mod-updated">${updateDate(mod.updatedAt)}</p>` : ''}
          <section class="detail-section"><h4>Dependencies</h4>${dependencies.length
            ? `<div class="dependency-list">${dependencies.map(dep => button(`${dep.name} v${dep.version}`, 'package', 'mod-details', { id: dep.id, end: 'chevron' })).join('')}</div>`
            : `<p>${details?.loading ? 'Loading dependencies…' : details?.error ? 'Dependency information is unavailable.' : 'This package has no dependencies.'}</p>`}</section>
          <section class="detail-section"><h4>Active profile</h4><p>${esc(manager.profile.name)} · ${installed ? `v${esc(installed.version)} ${installed.enabled ? 'enabled' : 'disabled'}` : manager.live ? 'Available to download' : 'Available to install'}</p></section>
          ${manager.live && mod.url ? button('View on Thunderstore', 'diagonal', 'open-package-page', { id }) : ''}
          ${details?.error ? `<p class="demo-note">${icon('info', 17)}<span>${esc(details.error)}</span></p>` : ''}
        </div>
        <div class="dialog-footer">${iconButton(favorite ? 'Remove from favorites' : 'Add to favorites', 'heart', 'favorite', id, favorite)}
          ${installed
            ? button(installed.hasUpdate ? 'Download update' : ('View installed mods'), installed.hasUpdate ? 'refresh' : 'layers', installed.hasUpdate ? 'update' : 'navigate', { id: installed.hasUpdate ? id : 'library', style: 'primary', disabled: installed.hasUpdate && ui.downloading })
            : button(ui.downloading ? 'Downloading…' : 'Download mod', 'download', 'install', { id, style: 'primary', disabled: ui.downloading || details?.loading })}
        </div>`;
      break;
    }
    case 'games':
      dialog.innerHTML = `${dialogHeader('Switch game', 'Each game has its own catalog and profiles.')}
        <div class="dialog-list">${availableGames.map(game => `<button type="button" class="dialog-row" data-action="select-game" data-id="${esc(game.id)}">${gameArt(game)}<span><strong>${esc(game.name)}</strong><small>${game.id === manager.game.id ? 'Current game' : 'Thunderstore community'}</small></span>${icon(game.id === manager.game.id ? 'check' : 'chevron', 17)}</button>`).join('')}</div>`;
      break;
    case 'profiles':
      dialog.innerHTML = `${dialogHeader('Switch profile', `Choose a profile for ${manager.game.name}.`)}
        <div class="dialog-list">${manager.profiles.map(item => `<button class="dialog-row" type="button" data-action="select-profile" data-id="${esc(item.id)}"><span class="stat-icon">${icon('layers', 17)}</span><span><strong>${esc(item.name)}</strong><small>${plural(item.mods.length, 'installed mod')}</small></span>${icon(item.id === manager.profile.id ? 'check' : 'chevron', 17)}</button>`).join('')}</div>
        <div class="dialog-footer">${button('Manage profiles', 'users', 'navigate', { id: 'profiles' })}${button('New profile', 'plus', 'profile-create', { style: 'primary' })}</div>`;
      break;
    case 'profile-options':
      dialog.innerHTML = `${dialogHeader(profile.name, 'Manage this profile.')}
        <div class="dialog-list action-list">
          ${button('Rename profile', 'edit', 'profile-rename', { id })}
          ${button('Duplicate profile', 'copy', 'profile-clone', { id })}
          ${button('Share profile', 'upload', 'export', { id })}
          ${button('Delete profile', 'trash', 'profile-delete-request', { id, style: 'danger', disabled: manager.profiles.length < 2 })}
        </div>`;
      break;
    case 'profile-create':
    case 'profile-rename':
    case 'profile-clone': {
      const [title, label, value] = {
        'profile-create': ['New profile', 'Create profile', ''],
        'profile-rename': ['Rename profile', 'Save name', profile?.name],
        'profile-clone': ['Duplicate profile', 'Duplicate profile', profile ? `${profile.name.slice(0, PROFILE_NAME_LIMIT - 5)} Copy` : ''],
      }[type];
      dialog.innerHTML = `${dialogHeader(title)}
        <form id="dialog-form" class="dialog-form"><label>Profile name<input class="field" type="text" name="profileName" value="${esc(value)}" placeholder="e.g. Weekend crew" maxlength="${PROFILE_NAME_LIMIT}" required data-initial-focus></label>
          <p class="form-error" role="alert" hidden></p>
          <div class="dialog-footer">${button('Cancel', null, 'close-dialog')}<button type="submit" class="button primary">${esc(label)}</button></div>
        </form>`;
      break;
    }
    case 'export': {
      const share = ui.share?.profileId === id ? ui.share : null;
      dialog.innerHTML = `${dialogHeader('Share profile', `Share ${profile.name} with a short code or export a file.`)}
        <div class="dialog-form share-form">${share?.code
          ? `<label>Share code<input class="field share-code" type="text" value="${esc(share.code)}" readonly spellcheck="false" aria-label="Share code"></label><p>Paste this code into Import profile on another device running Ember.</p>`
          : '<p>Create a short code to share this profile. The profile is uploaded to Thunderstore, and anyone with the code can import it.</p>'}
          ${share?.error ? `<p class="form-error" role="alert">${esc(share.error)}</p>` : ''}
        </div>
        <div class="dialog-footer">${button('Download JSON', 'download', 'export-file', { id })}${share?.code
          ? button('Copy code', 'copy', 'export-copy', { id, style: 'primary' })
          : button(share?.busy ? 'Creating code…' : 'Create share code', 'upload', 'export-create', { id, style: 'primary', disabled: share?.busy || !desktop?.shareProfile })}</div>`;
      break;
    }
    case 'import':
      dialog.innerHTML = `${dialogHeader('Import profile', 'Import an Ember profile or a Thunderstore profile code.')}
        <form id="dialog-form" class="dialog-form">
          <label>Import from<select class="field" id="import-source" name="importSource"><option value="ember">Ember</option><option value="thunderstore">Thunderstore / r2modman</option></select></label>
          <div data-import-section="ember">
            <label>Share code or JSON<textarea class="field code-field" name="profileCode" rows="3" placeholder="Paste a share code or an exported profile…" data-initial-focus></textarea></label>
            <label class="import-file">Or choose a JSON file<input class="field" type="file" name="profileFile" accept=".json,application/json"></label>
          </div>
          <div data-import-section="thunderstore" hidden>
            <label>Profile code<input class="field code-field" type="text" name="thunderstoreCode" placeholder="Paste your Thunderstore profile code" maxlength="100" spellcheck="false" autocomplete="off"></label>
            <label>Game<select class="field" name="importGame">${availableGames.map(game => `<option value="${esc(game.id)}"${game.id === manager.game.id ? ' selected' : ''}>${esc(game.name)}</option>`).join('')}</select></label>
            <p class="import-note">Choose the game this profile was made for.</p>
          </div>
          <div class="import-review" role="status" hidden></div>
          <p class="form-error" role="alert" hidden></p>
          <div class="dialog-footer"><button type="button" class="button" data-action="import-review-back" hidden>Back</button>${button('Cancel', null, 'close-dialog')}<button type="submit" class="button primary">${icon('upload', 16)} Import profile</button></div>
        </form>`;
      break;
    case 'launch-options':
      dialog.innerHTML = `${dialogHeader('Launch mode')}
        <div class="dialog-list action-list">${[['modded', 'Modded'], ['vanilla', 'Vanilla']].map(([mode, label]) => {
          const selected = manager.state.settings.launchMode === mode;
          return button(label, selected ? 'check' : null, 'select-launch-mode', { id: mode, pressed: selected, style: selected ? 'outline-purple' : '' });
        }).join('')}</div>`;
      break;
    case 'launch-confirm':
      dialog.innerHTML = `${dialogHeader(id.title, id.description)}
        <div class="dialog-form"><p class="game-path">${esc(id.gameDir)}</p></div>
        <div class="dialog-footer">${button('Cancel', null, 'close-dialog')}${button(id.label, 'play', id.action, { id: id.fingerprint, style: 'primary' })}</div>`;
      break;
    case 'toggle-dependencies': {
      const { enabled, requirements } = id;
      const missing = enabled ? requirements.missingDependencies ?? [] : [];
      const affected = enabled ? [...missing, ...requirements.dependencies] : requirements.dependents;
      const mod = requirements.mod;
      dialog.innerHTML = `${dialogHeader(enabled ? `Enable ${mod.name}?` : `Disable ${mod.name}?`,
        enabled ? (missing.length ? 'This mod has missing or disabled requirements.' : 'This mod needs the following mods enabled.') : 'These enabled mods require this mod.')}
        <div class="dialog-form">
          <div class="dependency-list">${affected.map(item => `<div>${icon('package', 17)}<span>${esc(item.name)}</span>${missing.some(ref => ref.id === item.id) ? '<small>Not installed</small>' : ''}</div>`).join('')}</div>
          <p class="dependency-notice">${enabled ? (missing.length ? 'Install the missing requirements from Browse mods to restore them. Enable anyway may prevent this mod from loading.' : 'Enable anyway leaves its dependencies disabled and may prevent this mod from loading.') : 'Disable affected mods turns off this mod and all listed mods. Disable anyway turns off only this mod and may prevent the listed mods from loading.'}</p>
        </div>
        <div class="dialog-footer">${button('Cancel', null, 'close-dialog')}
          ${button(enabled ? 'Enable anyway' : 'Disable anyway', null, 'toggle-anyway')}
          ${missing.length ? '' : button(enabled ? 'Enable required mods' : 'Disable affected mods', 'check', enabled ? 'toggle-required' : 'toggle-dependents', { style: 'primary' })}
        </div>`;
      break;
    }
    case 'remove-dependencies': {
      const { mod, dependents } = id.requirements;
      dialog.innerHTML = `${dialogHeader(`Remove ${mod.name}?`, 'These installed mods depend on this mod.')}
        <div class="dialog-form">
          <div class="dependency-list">${dependents.map(item => `<div>${icon('package', 17)}<span>${esc(item.name)}</span>${item.enabled ? '' : '<small>Disabled</small>'}</div>`).join('')}</div>
          <p class="dependency-notice">Delete anyway removes only ${esc(mod.name)} and keeps the listed mods installed. They may not work until you reinstall it.</p>
        </div>
        <div class="dialog-footer">${button('Cancel', null, 'close-dialog')}${button('Delete anyway', null, 'remove-anyway')}${button(`Remove all ${dependents.length + 1} mods`, 'trash', 'remove-dependents', { style: 'danger-fill' })}</div>`;
      break;
    }
    case 'confirm': {
      const { title, message, label, action, target } = id;
      dialog.innerHTML = `${dialogHeader(title, message)}<div class="dialog-footer">${button('Cancel', null, 'close-dialog')}${button(label, null, action, { id: target, style: 'danger-fill' })}</div>`;
      break;
    }
    case 'about':
      dialog.innerHTML = `${dialogHeader('Ember', 'Live Thunderstore mods for your game profiles.')}
        <div class="dialog-form"><p class="launch-message">Browse the community catalog, download mods, and manage your profiles. Your profiles and downloads are saved on this device.</p></div>
        <div class="dialog-footer">${button('Done', 'check', 'close-dialog', { style: 'primary' })}</div>`;
      break;
  }
  if (focus) dialog.querySelector(focus)?.focus({ preventScroll: true });
}

function closeDialog() {
  if (ui.dialog?.type === 'client-update' && ui.clientUpdate?.status === 'installing') return;
  ui.dialog = null;
  reportClientBusy();
  ui.detail = null;
  if (dialog.open) dialog.close();
}

function notify(message, error = false) {
  const toast = document.createElement('div');
  toast.className = `toast${error ? ' error' : ''}`;
  toast.innerHTML = `${icon(error ? 'info' : 'check', 18)}<span>${esc(message)}</span>`;
  if (dialog.open) {
    const notice = dialog.querySelector('.dialog-notice') ?? document.createElement('div');
    notice.className = 'dialog-notice';
    notice.setAttribute('role', 'status');
    if (!notice.isConnected) dialog.insertBefore(notice, dialog.querySelector(':scope > .dialog-footer'));
    notice.replaceChildren(toast);
  } else {
    toasts.append(toast);
  }
  window.setTimeout(() => toast.remove(), error ? 5500 : 3500);
}

function navigate(page, libraryFilter = 'all') {
  closeDialog();
  window.clearTimeout(searchTimer);
  window.clearTimeout(prefetchTimer);
  requestNumber++;
  Object.assign(ui, { page, query: '', category: '', library: libraryFilter, menu: false });
  render();
  window.scrollTo(0, 0);
  document.querySelector('#main').focus({ preventScroll: true });
  if (manager.live && page === 'browse') void loadCatalog();
  if (nativeLaunchSupported() && page === 'settings') void loadGameStatus();
}

async function loadGameStatus() {
  const gameId = manager.game.id;
  const request = ++gameStatusRequestNumber;
  let status;
  try {
    status = await desktop.gameStatus(gameId);
  } catch (error) {
    status = { ...ui.gameStatus, message: errorMessage(error), statusError: true };
  }
  if (gameId !== manager.game.id || request !== gameStatusRequestNumber) return;
  ui.gameStatus = status;
  updateLaunchControls();
  if (nativeLaunchSupported() && ui.page === 'settings') render();
}

async function pollRunningGame() {
  if (!nativeLaunchSupported() || typeof desktop?.gameRunningStatus !== 'function' || runningStatusPolling) return;
  const gameId = manager.game.id;
  runningStatusPolling = true;
  try {
    const status = await desktop.gameRunningStatus(gameId);
    if (gameId !== manager.game.id) return;
    ui.gameStatus = { ...ui.gameStatus, ...status, statusError: false };
    updateLaunchControls();
  } catch {
    if (gameId === manager.game.id) {
      ui.gameStatus = { ...ui.gameStatus, statusError: true };
      updateLaunchControls();
    }
  } finally { runningStatusPolling = false; }
}

function scheduleRunningCheck() {
  window.clearTimeout(runningStatusTimer);
  runningStatusTimer = window.setTimeout(async () => {
    if (startup.dataset.ready === 'true') await pollRunningGame();
    scheduleRunningCheck();
  }, document.hidden ? 5000 : 2000);
}

function enabledRefs() {
  return manager.installed.filter(entry => entry.enabled).map(({ mod, version }) => ({
    namespace: mod.namespace, name: mod.name, version,
  }));
}

async function gameTask(task, success) {
  if (ui.gameBusy) return;
  closeDialog();
  ui.gameBusy = true;
  render();
  try {
    const result = await task();
    if (success) notify(success);
    return result;
  } finally {
    ui.gameBusy = false;
    render();
  }
}

async function setupRequest() {
  const { id: gameId, name: gameName } = manager.game;
  const profileId = manager.profile.id;
  const status = await desktop.gameStatus(gameId);
  if (gameId !== manager.game.id || profileId !== manager.profile.id) return;
  if (status?.loader !== 'clean') throw new Error(`Choose a clean Steam installation in ${gameName} setup.`);
  openDialog('launch-confirm', {
    title: 'Set up modded launch',
    description: `Set up ${manager.game.id === 'mimesis' || enabledRefs().some(ref => ref.namespace === 'LavaGang' && ref.name === 'MelonLoader') ? 'MelonLoader' : 'BepInEx'} for this Steam game folder and your selected profile.`,
    gameDir: status.gameDir,
    label: 'Set up loader',
    action: 'setup-loader',
  });
}

async function requestLaunch(mode = manager.state.settings.launchMode) {
  if (!nativeLaunchSupported() || ui.gameBusy) return;
  const { id: gameId, name: gameName } = manager.game;
  const profileId = manager.profile.id;
  const status = await desktop.gameStatus(gameId);
  if (gameId !== manager.game.id || profileId !== manager.profile.id) return;
  if (!status) {
    navigate('settings');
    notify('Choose your Steam game folder to continue.');
    return;
  }
  ui.gameStatus = status;
  updateLaunchControls();
  if (status.running || status.launchPending) return;
  if (mode === 'modded' && status.loader === 'clean') return setupRequest();
  await launchGame(mode, mode === 'modded' && status.loader === 'existing' ? status.loaderFingerprint : undefined);
}

async function launchGame(mode, fingerprint) {
  const workspace = manager;
  const gameId = workspace.game.id;
  const profileId = workspace.profile.id;
  const profileName = workspace.profile.name;
  const refs = mode === 'modded' ? enabledRefs() : [];
  const configFiles = structuredClone(mode === 'modded' ? workspace.profile.configFiles ?? {} : {});
  const userDataFiles = structuredClone(mode === 'modded' ? workspace.profile.userDataFiles ?? {} : {});
  await gameTask(async () => {
    await desktop.launchGame(mode, profileId, refs, fingerprint, profileName, gameId, configFiles, userDataFiles);
    if (gameId === manager.game.id) {
      ui.gameStatus = { ...ui.gameStatus, launchPending: true, statusError: false };
      await pollRunningGame();
    }
    workspace.recordLaunch(profileId, mode);
  }, 'Steam received the launch request.');
}

async function loadCatalog(append = false) {
  window.clearTimeout(prefetchTimer);
  if (!manager.live || ui.page !== 'browse') return;
  if (!desktop?.fetchCatalog) {
    ui.feed = { ...emptyFeed(), error: 'Open the Ember desktop app to connect to Thunderstore.' };
    refreshCatalogResults();
    return;
  }
  if (append && (ui.feed.loading || !ui.feed.hasMore || ui.feed.requestKey !== catalogRequestKey())) return;
  const requestKey = catalogRequestKey();
  const token = ++requestNumber;
  const page = append ? ui.feed.page + 1 : 1;
  const { query, category, sort, showDeprecated } = ui;
  const gameId = manager.game.id;
  ui.feed = {
    ...ui.feed,
    ...(append ? {} : { mods: [], count: 0, hasMore: false, page: 0 }),
    loading: true,
    error: '',
  };
  if (append) refreshCatalogTail();
  else refreshCatalogResults();
  try {
    const result = await desktop.fetchCatalog({ gameId, query, sort: sort || 'popular', page, category, showDeprecated });
    if (token !== requestNumber || requestKey !== catalogRequestKey() || ui.page !== 'browse') return;
    manager.registerPackages(result.mods);
    const mods = new Map((append ? ui.feed.mods : []).map(mod => [mod.id, mod]));
    const added = result.mods.filter(mod => !mods.has(mod.id));
    for (const mod of result.mods) mods.set(mod.id, mod);
    ui.feed = { ...result, mods: [...mods.values()], page, requestKey, loading: false, error: '' };
    if (append) app.querySelector('.mod-grid')?.insertAdjacentHTML('beforeend', added.map(modCard).join(''));
  } catch (error) {
    if (token !== requestNumber || requestKey !== catalogRequestKey() || ui.page !== 'browse') return;
    ui.feed = { ...ui.feed, loading: false, error: errorMessage(error) };
  }
  if (append) refreshCatalogTail();
  else refreshCatalogResults();
}

async function showDetails(id) {
  if (!manager.live) {
    openDialog('mod', id);
    return;
  }
  let mod = manager.packageById(id);
  if (!mod && ui.dialog?.type === 'mod') {
    const ref = manager.packageById(ui.dialog.id)?.dependencies.find(item => item.id === id);
    if (ref) {
      manager.registerPackages([{ ...ref, version: null, gameId: manager.game.id, dependencies: [] }]);
      mod = manager.packageById(id);
    }
  }
  if (!mod) return;
  const request = { id, loading: true, error: '' };
  ui.detail = request;
  openDialog('mod', id);
  try {
    const result = await desktop.fetchPackage(mod.gameId, mod.namespace, mod.name);
    if (ui.detail !== request) return;
    manager.registerPackages([result]);
    render();
  } catch (error) {
    if (ui.detail !== request) return;
    request.error = errorMessage(error);
  }
  request.loading = false;
  renderDialog();
}

async function downloadLive(mods) {
  if (ui.downloading || !mods.length) return;
  const workspace = manager;
  const { game, profile } = workspace;
  const refs = mods.map(({ namespace, name }) => ({ namespace, name }));
  const context = downloadContext(workspace, profile, mods.length === 1 ? mods[0].name : `${mods.length} mods`);
  ui.downloading = true;
  refreshWorkspace(`Downloading ${plural(mods.length, 'package')} from Thunderstore…`);
  try {
    const archives = await desktop.downloadPackages(game.id, refs, context);
    workspace.recordDownloads(profile.id, game.id, archives, mods.map(mod => mod.id));
    const roots = new Set(mods.map(mod => mod.id));
    workspace.registerPackages(archives.filter(mod => roots.has(mod.id)));
    await finishDownload(context);
    const text = mods.length === 1 ? mods[0].name : plural(mods.length, 'mod');
    ui.downloading = false;
    refreshWorkspace(`Downloaded ${text} for ${profile.name}.`);
  } catch (error) {
    await finishDownload(context, error).catch(() => {});
    throw error;
  } finally {
    if (ui.downloading) {
      ui.downloading = false;
      refreshWorkspace();
    }
  }
}

async function checkUpdates() {
  if (ui.checkingUpdates) return;
  const workspace = manager;
  const entries = workspace.installed;
  const results = [];
  ui.checkingUpdates = true;
  render();
  try {
    for (let index = 0; index < entries.length; index += 4) {
      const batch = await Promise.allSettled(entries.slice(index, index + 4).map(({ mod }) =>
        desktop.fetchPackage(mod.gameId, mod.namespace, mod.name)));
      results.push(...batch);
    }
    const found = results.filter(result => result.status === 'fulfilled').map(result => result.value);
    workspace.registerPackages(found);
    const updates = workspace.updates.length;
    notify(found.length < results.length
      ? `Found ${plural(updates, 'update')}. Some packages could not be checked.`
      : updates ? `${plural(updates, 'update')} available.` : 'Your mods are up to date.');
  } finally {
    ui.checkingUpdates = false;
    render();
  }
}

function refreshResults() {
  const results = document.querySelector('#results');
  if (!results) return;
  const renderResults = { browse: catalogResults, favorites: favoriteResults, library: libraryResults }[ui.page];
  if (renderResults) results.innerHTML = renderResults();
}

function refreshWorkspace(message) {
  render();
  if (ui.dialog?.type === 'mod') openDialog('mod', ui.dialog.id);
  if (message) notify(message);
}

function confirm(title, message, label, action, target) {
  openDialog('confirm', { title, message, label, action, target });
}

function applyPendingToggle(includeRelated) {
  const pending = ui.dialog?.type === 'toggle-dependencies' ? ui.dialog.id : null;
  if (!pending) return;
  if (pending.profileId !== manager.profile.id) throw new Error('The active profile changed. Choose the mod again.');
  const requirements = manager.getToggleRequirements(pending.modId, pending.enabled);
  const affected = pending.enabled ? [...requirements.dependencies, ...(requirements.missingDependencies ?? [])] : requirements.dependents;
  const previousAffected = pending.enabled ? [...pending.requirements.dependencies, ...(pending.requirements.missingDependencies ?? [])] : pending.requirements.dependents;
  if (affected.some(item => !previousAffected.some(previous => previous.id === item.id)) ||
      (includeRelated && pending.enabled && requirements.missingDependencies?.length)) {
    openDialog('toggle-dependencies', { ...pending, requirements });
    return;
  }
  manager.setEnabled(pending.modId, pending.enabled, includeRelated
    ? (pending.enabled ? { includeDependencies: true } : { includeDependents: true }) : { force: true });
  closeDialog();
  render();
  app.querySelector(`[data-toggle-mod="${CSS.escape(pending.modId)}"]`)?.focus();
}

function applyPendingRemoval(includeDependents) {
  const pending = ui.dialog?.type === 'remove-dependencies' ? ui.dialog.id : null;
  if (!pending) return;
  if (pending.profileId !== manager.profile.id) throw new Error('The active profile changed. Choose the mod again.');
  const requirements = manager.getRemovalRequirements(pending.modId);
  if (requirements.dependents.some(item => !pending.requirements.dependents.some(previous => previous.id === item.id))) {
    openDialog('remove-dependencies', { ...pending, requirements });
    return;
  }
  const removed = manager.remove(pending.modId, includeDependents ? { includeDependents: true } : { force: true });
  closeDialog();
  render();
  notify(`${plural(removed.length, 'mod')} removed from ${manager.profile.name}.`);
}

function openShareDialog(id) {
  const { json } = manager.exportProfile(id);
  if (ui.share?.profileId !== id || ui.share.json !== json) {
    ui.share = { profileId: id, json, code: '', busy: false, error: '' };
  }
  openDialog('export', id);
}

async function createShareCode() {
  const share = ui.share;
  if (!share || share.busy || ui.dialog?.type !== 'export' || ui.dialog.id !== share.profileId) return;
  if (!desktop?.shareProfile) throw new Error('Open Ember on desktop to create a share code.');
  share.busy = true;
  share.error = '';
  renderDialog();
  try {
    share.code = await desktop.shareProfile(share.json);
  } catch (error) {
    share.error = errorMessage(error);
  } finally {
    share.busy = false;
    if (ui.share === share && ui.dialog?.type === 'export' && ui.dialog.id === share.profileId) renderDialog();
  }
}

function reportClientBusy() {
  const busy = startup.dataset.ready !== 'true' || Boolean(ui.downloading || ui.gameBusy || (ui.dialog && ui.dialog.type !== 'client-update'));
  void desktop?.setClientUiBusy?.(busy)?.catch(() => {});
}

function importSelection(form) {
  return JSON.stringify(['importSource', 'thunderstoreCode', 'importGame'].map(name => form.elements.namedItem(name)?.value ?? ''));
}

function clearImportReview(form) {
  form.importReview = null;
  form.querySelector('.import-review').hidden = true;
  form.querySelector('[data-action="import-review-back"]').hidden = true;
  const error = form.querySelector('.form-error');
  error.hidden = true;
  error.textContent = '';
  for (const field of form.querySelectorAll('input, select, textarea')) field.disabled = false;
  form.querySelector('[type="submit"]').innerHTML = `${icon('upload', 16)} Import profile`;
}

function updateClientState(status) {
  ui.clientUpdate = status;
  const message = app.querySelector('#client-update-message');
  if (message) message.textContent = status.message;
  startupUpdates.update(status);
  if (startup.dataset.ready !== 'true') return;
  if (status.status === 'installing' && !ui.dialog) openDialog('client-update', {});
  else if (ui.dialog?.type === 'client-update') renderDialog();
}

async function checkClientUpdate() {
  if (ui.checkingClientUpdate) return;
  ui.checkingClientUpdate = true;
  const request = {};
  ui.clientUpdate = { version: CLIENT_VERSION, status: 'loading', message: 'Loading client update information…' };
  openDialog('client-update', request);
  const trigger = app.querySelector('[data-action="client-update"]');
  if (trigger) trigger.disabled = true;
  try {
    const status = desktop?.checkClientUpdate ? await desktop.checkClientUpdate() : {
      version: CLIENT_VERSION, status: 'unsupported', message: 'Client updates are available in the installed Windows app.',
    };
    if (ui.clientUpdate?.status !== 'installing') ui.clientUpdate = status;
  } catch (error) {
    if (ui.clientUpdate?.status !== 'installing') ui.clientUpdate = { version: CLIENT_VERSION, status: 'error', message: errorMessage(error) };
  } finally {
    ui.checkingClientUpdate = false;
    if (ui.dialog?.type === 'client-update' && ui.dialog.id === request) renderDialog();
    const currentTrigger = app.querySelector('[data-action="client-update"]');
    if (currentTrigger) currentTrigger.disabled = false;
  }
}

async function handleAction(action, id) {
  const mod = manager.packageById(id);
  switch (action) {
    case 'retry-startup': await startWorkspace(); break;
    case 'offline-startup': await finishStartupAndReveal(); break;
    case 'navigate': navigate(id); break;
    case 'menu': ui.menu = !ui.menu; render(); break;
    case 'games': openDialog('games'); break;
    case 'about': openDialog('about'); break;
    case 'wallpapers': openDialog('wallpapers'); break;
    case 'codes': openDialog('codes'); break;
    case 'use-reward-wallpaper':
      manager.setSetting('wallpaper', id);
      closeDialog();
      render();
      notify('Wallpaper applied.');
      break;
    case 'client-update': await checkClientUpdate(); break;
    case 'client-release-page': await desktop?.openClientReleasePage?.(); break;
    case 'client-install': updateClientState(await desktop.installClientUpdate()); break;
    case 'select-wallpaper':
      manager.setSetting('wallpaper', id);
      render();
      renderDialog();
      break;
    case 'close-dialog': closeDialog(); break;
    case 'toggle-required': applyPendingToggle(true); break;
    case 'toggle-dependents': applyPendingToggle(true); break;
    case 'toggle-anyway': applyPendingToggle(false); break;
    case 'remove-dependents': applyPendingRemoval(true); break;
    case 'remove-anyway': applyPendingRemoval(false); break;
    case 'library-filter': ui.library = id; render(); break;
    case 'clear-filters':
      window.clearTimeout(searchTimer);
      ui.query = '';
      ui.category = '';
      ui.sort = '';
      ui.showDeprecated = false;
      if (manager.live) void loadCatalog();
      else render();
      document.querySelector('#search-input')?.focus();
      break;
    case 'clear-sort':
      window.clearTimeout(searchTimer);
      ui.sort = '';
      if (manager.live) void loadCatalog();
      else render();
      document.querySelector('#catalog-sort')?.focus();
      break;
    case 'reload-catalog': await loadCatalog(); break;
    case 'retry-more': await loadCatalog(true); break;
    case 'select-game':
      manager.switchGame(id);
      gameStatusRequestNumber++;
      ui.gameStatus = undefined;
      ui.feed = emptyFeed();
      navigate('browse');
      if (nativeLaunchSupported()) void loadGameStatus();
      notify(`Switched to ${getGame(id).name}.`);
      break;
    case 'pick-profile': openDialog('profiles'); break;
    case 'select-profile':
      manager.switchProfile(id);
      closeDialog();
      render();
      notify(`Using ${manager.profile.name}.`);
      break;
    case 'profile-options': openDialog('profile-options', id); break;
    case 'profile-create': case 'profile-rename': case 'profile-clone': openDialog(action, id); break;
    case 'profile-delete-request': {
      const profile = manager.profiles.find(item => item.id === id);
      confirm('Delete profile?', `This removes ${profile.name} and its saved mod list and settings.`, 'Delete profile', 'profile-delete', id);
      break;
    }
    case 'profile-delete':
      manager.deleteProfile(id);
      closeDialog();
      render();
      notify('Profile deleted.');
      break;
    case 'export': openShareDialog(id); break;
    case 'export-create': await createShareCode(); break;
    case 'export-copy':
      if (ui.share?.profileId !== id || !ui.share.code) throw new Error('Create a share code first.');
      await navigator.clipboard.writeText(ui.share.code);
      notify('Profile code copied.');
      break;
    case 'export-file': {
      const { json, filename } = manager.exportProfile(id);
      if (window.modRelayDesktop?.saveProfile) {
        const saved = await window.modRelayDesktop.saveProfile({ json, filename });
        if (saved) notify('Profile file saved.');
        break;
      }
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
      break;
    }
    case 'import': openDialog('import'); break;
    case 'import-review-back': {
      const form = dialog.querySelector('#dialog-form');
      if (!form || form.querySelector('[type="submit"]').disabled) break;
      clearImportReview(form);
      break;
    }
    case 'mod-details': await showDetails(id); break;
    case 'open-downloads': await desktop.openDownloads(); break;
    case 'clear-completed-downloads': await clearCompletedDownloads(); break;
    case 'open-package-page': await desktop.openPackagePage(mod.url); break;
    case 'check-updates': await checkUpdates(); break;
    case 'install':
    case 'update': await downloadLive([mod]); break;
    case 'update-all': await downloadLive(manager.updates.map(entry => entry.mod)); break;
    case 'favorite':
      manager.toggleFavorite(id);
      refreshWorkspace();
      break;
    case 'remove-request': {
      const requirements = manager.getRemovalRequirements(id);
      if (requirements.dependents.length) openDialog('remove-dependencies', { modId: id, profileId: manager.profile.id, requirements });
      else if (manager.state.settings.confirmRemoval) confirm('Remove mod?', `Remove ${mod.name} from ${manager.profile.name}?`, 'Remove mod', 'remove', id);
      else await handleAction('remove', id);
      break;
    }
    case 'remove': {
      const requirements = manager.getRemovalRequirements(id);
      if (requirements.dependents.length) {
        openDialog('remove-dependencies', { modId: id, profileId: manager.profile.id, requirements });
        break;
      }
      manager.remove(id);
      closeDialog();
      render();
      notify(`${mod.name} removed.`);
      break;
    }
    case 'show-updates': navigate('library', 'updates'); break;
    case 'choose-game': {
      const gameId = manager.game.id;
      gameStatusRequestNumber++;
      await gameTask(async () => {
        const status = await desktop.chooseGame(gameId);
        if (gameId === manager.game.id) ui.gameStatus = status;
      });
      break;
    }
    case 'prepare-profile': {
      const profileId = manager.profile.id;
      const refs = enabledRefs();
      const name = manager.profile.name;
      const { id: gameId, name: gameName } = manager.game;
      const configFiles = structuredClone(manager.profile.configFiles ?? {});
      const userDataFiles = structuredClone(manager.profile.userDataFiles ?? {});
      await gameTask(() => desktop.prepareProfile(profileId, refs, name, gameId, configFiles, userDataFiles), `Your ${gameName} profile is ready.`);
      break;
    }
    case 'open-profile': await desktop.openProfile(manager.profile.id, manager.game.id); break;
    case 'setup-request': await setupRequest(); break;
    case 'setup-loader': {
      const profileId = manager.profile.id;
      const refs = enabledRefs();
      const name = manager.profile.name;
      const gameId = manager.game.id;
      const configFiles = structuredClone(manager.profile.configFiles ?? {});
      const userDataFiles = structuredClone(manager.profile.userDataFiles ?? {});
      gameStatusRequestNumber++;
      await gameTask(async () => {
        const status = await desktop.setupLoader(profileId, refs, name, gameId, configFiles, userDataFiles);
        if (gameId === manager.game.id) ui.gameStatus = status;
      }, 'Loader ready. Use Launch modded to start through Steam.');
      break;
    }
    case 'remove-loader-request':
      confirm('Remove the Ember loader?', `Remove the loader files Ember added to your ${manager.game.name} Steam folder.`, 'Remove loader', 'remove-loader', manager.game.id);
      break;
    case 'remove-loader': {
      const gameId = id ?? manager.game.id;
      if (gameId !== manager.game.id) throw new Error('The active game changed. Choose the loader again.');
      gameStatusRequestNumber++;
      await gameTask(async () => {
        const status = await desktop.removeLoader(gameId);
        if (gameId === manager.game.id) ui.gameStatus = status;
      }, 'Ember loader removed.');
      break;
    }
    case 'launch-existing': await launchGame('modded', id); break;
    case 'launch-default': await requestLaunch(); break;
    case 'launch-options': openDialog('launch-options'); break;
    case 'select-launch-mode':
      manager.setSetting('launchMode', id);
      closeDialog();
      render();
      document.querySelector('[data-action="launch-default"]')?.focus();
      break;
  }
}

document.addEventListener('click', event => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  handleAction(target.dataset.action, target.dataset.id).catch(error => {
    if (ui.dialog?.type === 'confirm') closeDialog();
    notify(errorMessage(error), true);
  });
});

document.addEventListener('error', event => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !image.classList.contains('mod-art')) return;
  const placeholder = document.createElement('span');
  placeholder.className = `${image.className} fallback-art`;
  placeholder.innerHTML = icon('package', 27);
  image.replaceWith(placeholder);
}, true);

function updateSearchResults(composing = false) {
  if (manager.live && ui.page === 'browse') {
    window.clearTimeout(searchTimer);
    window.clearTimeout(prefetchTimer);
    catalogObserver.disconnect();
    requestNumber++;
    if (!composing) searchTimer = window.setTimeout(() => { void loadCatalog(); }, 300);
  } else if (!composing) {
    refreshResults();
  }
}

document.addEventListener('compositionstart', event => {
  if (event.target.id !== 'search-input') return;
  searchComposing = true;
  updateSearchResults(true);
});

document.addEventListener('compositionend', event => {
  if (event.target.id !== 'search-input') return;
  searchComposing = false;
  ui.query = event.target.value;
  updateSearchResults();
  if (renderAfterComposition) {
    renderAfterComposition = false;
    render();
  }
});

document.addEventListener('input', event => {
  if (event.target.id !== 'search-input') return;
  ui.query = event.target.value;
  updateSearchResults(searchComposing || event.isComposing);
});

document.addEventListener('change', event => {
  const target = event.target;
  try {
    if (target.id === 'import-source') {
      const form = target.form;
      for (const section of form.querySelectorAll('[data-import-section]')) section.hidden = section.dataset.importSection !== target.value;
      const error = form.querySelector('.form-error');
      error.hidden = true;
      error.textContent = '';
      return;
    } else if (target.id === 'catalog-sort') {
      window.clearTimeout(searchTimer);
      ui.sort = target.value;
      if (manager.live) void loadCatalog();
      else render();
    } else if (target.id === 'show-deprecated') {
      window.clearTimeout(searchTimer);
      ui.showDeprecated = target.checked;
      if (manager.live) void loadCatalog();
      else refreshResults();
    } else if (target.id === 'category-select') {
      window.clearTimeout(searchTimer);
      ui.category = target.value;
      if (manager.live) void loadCatalog();
      else refreshResults();
    } else if (target.dataset.toggleMod) {
      const modId = target.dataset.toggleMod;
      const enabled = target.checked;
      const requirements = manager.getToggleRequirements(modId, enabled);
      if ((enabled ? requirements.dependencies.length + (requirements.missingDependencies?.length ?? 0) : requirements.dependents.length)) {
        render();
        openDialog('toggle-dependencies', { modId, enabled, profileId: manager.profile.id, requirements });
      } else {
        manager.setEnabled(modId, enabled);
        render();
      }
    } else if (target.dataset.setting) {
      manager.setSetting(target.dataset.setting, target.type === 'checkbox' ? target.checked : target.value);
      refreshWorkspace('Preference saved.');
    }
  } catch (error) {
    render();
    notify(error.message, true);
  }
});

document.addEventListener('submit', async event => {
  const form = event.target;
  if (form.id !== 'dialog-form') return;
  event.preventDefault();
  const submit = form.querySelector('[type="submit"]');
  if (submit.disabled) return;
  const submitLabel = submit.innerHTML;
  const formError = form.querySelector('.form-error');
  if (formError) { formError.hidden = true; formError.textContent = ''; }
  const data = new FormData(form);
  try {
    const { type, id } = ui.dialog;
    if (type === 'codes') {
      const reward = manager.redeemCode(data.get('rewardCode'));
      openDialog('code-reward', reward);
      return;
    }
    const name = data.get('profileName');
    if (type === 'profile-create') manager.createProfile(name);
    if (type === 'profile-rename') manager.renameProfile(id, name);
    if (type === 'profile-clone') manager.cloneProfile(id, name);
    if (type === 'import') {
      if (form.importReview && form.importReview.selection !== importSelection(form)) {
        clearImportReview(form);
        throw new Error('The profile details changed. Import again to review them.');
      }
      submit.disabled = true;
      for (const field of form.querySelectorAll('input, select, textarea')) field.disabled = true;
      const source = data.get('importSource');
      let content = form.importReview?.content;
      if (!content && source === 'thunderstore') {
        if (!desktop?.resolveThunderstoreProfile) throw new Error('Update Ember to import a Thunderstore profile.');
        const code = String(data.get('thunderstoreCode') ?? '').trim();
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(code)) throw new Error('Enter a valid Thunderstore profile code.');
        const gameId = data.get('importGame');
        if (!availableGames.some(game => game.id === gameId)) throw new Error('Choose a supported game.');
        submit.innerHTML = `${icon('clock', 16)} Finding profile…`;
        content = await desktop.resolveThunderstoreProfile(code, gameId);
        if (!form.isConnected || !dialog.open) return;
        const payload = JSON.parse(content);
        const warnings = Array.isArray(payload.importWarnings) ? payload.importWarnings.filter(item => typeof item === 'string') : [];
        if (warnings.length) {
          form.importReview = { content, selection: importSelection(form) };
          const review = form.querySelector('.import-review');
          review.innerHTML = `<strong>Some files can't be imported</strong><p>Review these files before continuing:</p><ul>${warnings.map(item => `<li>${esc(item)}</li>`).join('')}</ul>`;
          review.hidden = false;
          form.querySelector('[data-action="import-review-back"]').hidden = false;
          return;
        }
      } else if (!content) {
        const file = data.get('profileFile');
        if (file.size > MAX_IMPORT_LENGTH) throw new Error('Choose a profile file up to 3 MB.');
        content = file.size ? await file.text() : data.get('profileCode');
        if (typeof content === 'string' && SHORT_PROFILE_CODE.test(content.trim())) {
          if (!desktop?.resolveProfileCode) throw new Error('Open Ember on desktop to import a share code.');
          submit.innerHTML = `${icon('clock', 16)} Finding profile…`;
          content = await desktop.resolveProfileCode(content.trim());
        }
      }
      if (!form.isConnected || !dialog.open) return;
      if (manager.live) {
        const workspace = manager;
        const imported = workspace.readImport(content);
        if (!availableGames.some(game => game.id === imported.gameId)) throw new Error('Choose a profile for a supported game.');
        ui.downloading = true;
        submit.innerHTML = `${icon('clock', 16)} Importing profile…`;
        notify('Downloading the packages for this profile…');
        try {
          const context = downloadContext(workspace, { ...imported, id: `import-${crypto.randomUUID()}` }, `Import ${imported.name}`);
          try {
            const archives = await desktop.downloadPackages(imported.gameId, imported.mods.map(entry => entry.package), context);
            if (!form.isConnected || !dialog.open || manager !== workspace) throw new Error('Profile import cancelled.');
            const profile = workspace.importProfile(content, archives);
            await finishDownload(context, null, profile);
          } catch (error) {
            await finishDownload(context, error).catch(() => {});
            throw error;
          }
          ui.feed = emptyFeed();
        } finally {
          ui.downloading = false;
          render();
        }
      } else {
        manager.importProfile(content);
      }
    }
    navigate('profiles');
    notify({ 'profile-create': 'Profile created.', 'profile-rename': 'Profile renamed.', 'profile-clone': 'Profile duplicated.', import: 'Profile imported.' }[type]);
  } catch (error) {
    const field = form.querySelector('.form-error');
    if (!field) return notify(error.message, true);
    field.hidden = false;
    field.textContent = errorMessage(error);
  } finally {
    submit.disabled = false;
    submit.innerHTML = form.importReview ? `${icon('upload', 16)} Import supported files`
      : form.elements.namedItem('importSource') ? `${icon('upload', 16)} Import profile` : submitLabel;
    for (const field of form.querySelectorAll('input, select, textarea')) field.disabled = Boolean(form.importReview);
  }
});

dialog.addEventListener('cancel', event => {
  if (ui.dialog?.type === 'client-update' && ui.clientUpdate?.status === 'installing') {
    event.preventDefault();
    return;
  }
  ui.dialog = null;
  ui.detail = null;
  reportClientBusy();
});

document.addEventListener('keydown', event => {
  if (startup.dataset.ready !== 'true' || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k' || dialog.open) return;
  event.preventDefault();
  if (!document.querySelector('#search-input')) navigate('browse');
  document.querySelector('#search-input')?.focus();
});

function startupMessage(message) {
  startup.querySelector('.startup-status').textContent = message;
}

function renderStartupUpdate(status) {
  startup.dataset.phase = status.status;
  const progress = startup.querySelector('.startup-progress');
  const details = startup.querySelector('.startup-detail');
  const target = status.latestVersion ? `Ember ${status.latestVersion}` : 'Ember';
  progress.hidden = false;
  progress.removeAttribute('value');
  progress.setAttribute('aria-label', 'Updating Ember');
  details.textContent = '';
  switch (status.status) {
    case 'checking': startupMessage('Checking for updates…'); details.textContent = 'Looking for the latest Ember release.'; break;
    case 'available': startupMessage(`Preparing ${target}…`); details.textContent = 'Your update will install before Ember opens.'; break;
    case 'downloading': {
      startupMessage(`Downloading ${target}…`);
      if (Number.isFinite(status.progress?.percent)) {
        const percent = Math.min(100, Math.max(0, status.progress.percent));
        progress.max = 100;
        progress.value = percent;
        details.textContent = `${Math.round(percent)}% downloaded`;
      } else details.textContent = 'Downloading your update.';
      break;
    }
    case 'downloaded':
      startupMessage(status.installBlocked ? 'Your update is ready for later.' : `Preparing to update ${target}…`);
      details.textContent = status.installBlocked ? 'Continue in Settings → Update client.' : 'Ember will reopen automatically.';
      break;
    case 'installing': startupMessage(`Updating ${target}…`); details.textContent = 'Ember will reopen automatically. Please wait.'; break;
    case 'up-to-date': startupMessage('Ember is up to date.'); details.textContent = 'Opening your workspace…'; break;
    case 'unsupported': startupMessage('Opening Ember…'); details.textContent = 'This version uses manual client updates.'; break;
    case 'error': startupMessage('Continuing to your workspace…'); details.textContent = status.message || 'Could not check for updates. Try again in Settings.'; break;
    default: startupMessage('Opening your workspace…');
  }
  details.hidden = !details.textContent;
}

async function finishStartupAndReveal() {
  const status = await desktop?.finishClientStartup?.();
  if (status?.status === 'installing' || ui.clientUpdate?.status === 'installing') {
    renderStartupUpdate(status?.status === 'installing' ? status : ui.clientUpdate);
    return;
  }
  revealWorkspace();
}

async function preloadArt(path) {
  const image = new Image();
  image.src = asset(path);
  await image.decode();
}

function revealWorkspace() {
  startup.dataset.ready = 'true';
  reportClientBusy();
  app.inert = false;
  app.removeAttribute('aria-hidden');
  observeCatalog();
  startup.classList.add('leaving');
  window.setTimeout(() => {
    startup.hidden = true;
    document.querySelector('#main')?.focus({ preventScroll: true });
  }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 260);
}

async function startWorkspace() {
  if (startupRunning) return;
  startupRunning = true;
  startup.dataset.controlled = 'true';
  startup.querySelector('.startup-error').hidden = true;
  startup.querySelector('.startup-actions').hidden = true;
  startup.querySelector('.startup-progress').hidden = false;
  let deadline;
  let thumbnailDeadline;
  try {
    await startupUpdates.run();
    if (typeof desktop?.startupClientUpdate !== 'function') await desktop?.finishClientStartup?.();
    if (ui.clientUpdate?.status === 'installing') return;
    if (ui.clientUpdate && ['up-to-date', 'unsupported', 'error'].includes(ui.clientUpdate.status)) {
      await new Promise(resolve => window.setTimeout(resolve, 450));
    }
    startup.dataset.phase = 'workspace';
    startup.querySelector('.startup-progress').removeAttribute('value');
    startup.querySelector('.startup-progress').setAttribute('aria-label', 'Loading Ember');
    startup.querySelector('.startup-detail').hidden = true;
    startupMessage('Loading your Ember workspace…');
    const artwork = Promise.all([
      preloadArt('/art/ember-flame.png'),
      preloadArt(WALLPAPERS.find(item => item.id === manager.state.settings.wallpaper).file),
      ...availableGames.map(game => preloadArt(game.icon)),
      document.fonts.ready,
    ]);
    const essentials = Promise.race([
      artwork,
      new Promise((_, reject) => {
        deadline = window.setTimeout(() => reject(new Error('The app artwork is taking too long to load.')), 15000);
      }),
    ]);
    const catalog = manager.live ? loadCatalog() : Promise.resolve();
    await Promise.all([essentials, catalog, desktop?.gameStatus ? loadGameStatus() : Promise.resolve(), loadDownloadHistory()]);
    if (manager.live && ui.feed.error) throw new Error(ui.feed.error);
    startupMessage('Finishing your library…');
    const thumbnails = [...document.querySelectorAll('.mod-card img')].slice(0, 9);
    await Promise.race([
      Promise.allSettled(thumbnails.map(image => image.decode())),
      new Promise(resolve => { thumbnailDeadline = window.setTimeout(resolve, 5000); }),
    ]);
    startupMessage('Ready to play.');
    await finishStartupAndReveal();
  } catch (error) {
    startupMessage('Ember needs a moment.');
    const field = startup.querySelector('.startup-error');
    field.textContent = errorMessage(error);
    field.hidden = false;
    startup.querySelector('.startup-progress').hidden = true;
    startup.querySelector('.startup-actions').hidden = false;
  } finally {
    window.clearTimeout(deadline);
    window.clearTimeout(thumbnailDeadline);
    startupRunning = false;
  }
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-window]');
  if (button && desktop?.windowCommand) void desktop.windowCommand(button.dataset.window);
});

function updateWindowState(state) {
  const button = document.querySelector('[data-window="maximize"]');
  button.setAttribute('aria-label', state.maximized ? 'Restore window' : 'Maximize');
  button.title = state.maximized ? 'Restore window' : 'Maximize';
}
desktop?.onWindowState?.(updateWindowState);
desktop?.windowState?.().then(updateWindowState);
desktop?.onDownloadProgress?.(updateDownloadRecord);
desktop?.onClientUpdate?.(status => { clientUpdateEventsSeen++; updateClientState(status); });
if (typeof desktop?.startupClientUpdate !== 'function') {
  const initialUpdateEvent = clientUpdateEventsSeen;
  void desktop?.clientUpdateStatus?.().then(status => {
    if (clientUpdateEventsSeen === initialUpdateEvent) updateClientState(status);
  }).catch(() => {});
}

try {
  const unsubscribe = desktop?.onPresence?.(status => {
    presenceEventsSeen++;
    updatePresence(status);
  });
  if (typeof unsubscribe === 'function') window.addEventListener('beforeunload', unsubscribe, { once: true });
} catch {
  updatePresence({ status: 'unavailable' });
}
if (typeof desktop?.presenceStatus === 'function') {
  const initialEvent = presenceEventsSeen;
  Promise.resolve().then(() => desktop.presenceStatus()).then(status => {
    if (presenceEventsSeen === initialEvent) updatePresence(status);
  }).catch(() => {
    if (presenceEventsSeen === initialEvent) updatePresence({ status: 'unavailable' });
  });
}

async function loadDownloadHistory() {
  if (!desktop?.downloadHistory) return;
  for (const record of await desktop.downloadHistory()) updateDownloadRecord(record);
}

render();
void startWorkspace();
scheduleRunningCheck();
window.addEventListener('focus', () => { if (startup.dataset.ready === 'true') void pollRunningGame(); });
window.addEventListener('beforeunload', () => window.clearTimeout(runningStatusTimer), { once: true });
