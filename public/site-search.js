import { searchSite, searchCategories, MAX_QUERY_LENGTH } from './site-search-engine.js';

const form = document.getElementById('site-search-form');
const input = document.getElementById('site-search-query');
const submit = document.getElementById('site-search-submit');
const clear = document.getElementById('site-search-clear');
const categories = document.getElementById('site-search-categories');
const results = document.getElementById('site-search-results');
const heading = document.getElementById('site-search-results-heading');
const summary = document.getElementById('site-search-summary');
const empty = document.getElementById('site-search-empty');
const fallback = document.getElementById('site-search-fallback');
let selectedCategory = 'All';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The index is curated locally. Keep its links on ordinary site pages even if
// a future index entry is accidentally given an external or privileged URL.
function pageUrl(value) {
  if (typeof value !== 'string' || !/^\/(?:[a-z0-9-]+\.html)?(?:#[a-z0-9-]+)?$/.test(value)) return null;
  const url = new URL(value, window.location.origin);
  if (url.origin !== window.location.origin || ['/admin.html', '/support-agent.html'].includes(url.pathname)) return null;
  return value;
}

function resultItem(entry) {
  const href = pageUrl(entry.url);
  if (!href || typeof entry.title !== 'string' || typeof entry.description !== 'string') return null;
  const item = element('li');
  const link = element('a', 'group block rounded-xl border border-line bg-[#151515] p-5 transition-colors hover:border-lime/60 hover:bg-[#1b1b1b] sm:p-6');
  link.href = href;
  const labels = element('div', 'mb-3 flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-wider');
  labels.append(element('span', 'text-lime', entry.category));
  if (entry.requiresLogin) labels.append(element('span', 'rounded-full border border-line px-2 py-1 text-muted', 'Sign-in required'));
  const titleRow = element('div', 'mb-2 flex items-start justify-between gap-4');
  titleRow.append(element('h3', 'min-w-0 break-words text-lg group-hover:text-lime', entry.title));
  const arrow = element('span', 'shrink-0 text-lg text-lime', '→');
  arrow.setAttribute('aria-hidden', 'true');
  titleRow.append(arrow);
  link.append(labels, titleRow, element('p', 'break-words text-sm text-muted', entry.description));
  item.append(link);
  return item;
}

function render() {
  const query = input.value.slice(0, MAX_QUERY_LENGTH);
  if (input.value !== query) input.value = query;
  const searching = query.trim().length > 0;
  const popular = !searching && selectedCategory === 'All';
  const page = searchSite(query, { category: selectedCategory, limit: popular ? 6 : 20 });
  const fragment = document.createDocumentFragment();
  for (const entry of page.results) {
    const item = resultItem(entry);
    if (item) fragment.append(item);
  }
  results.replaceChildren(fragment);
  const displayed = results.children.length;
  heading.textContent = searching ? 'Search results' : popular ? 'Popular starting points' : selectedCategory;
  summary.textContent = popular
    ? `Start with these guides, or search across ${page.total} academy topics.`
    : page.total === 0
      ? 'No results. Try another phrase or browse a different topic.'
      : page.total > displayed
        ? `Showing ${displayed} of ${page.total} matching topics. Add another word to narrow your search.`
        : `${page.total} ${page.total === 1 ? 'topic' : 'topics'} found.`;
  clear.disabled = !input.value && selectedCategory === 'All';
  empty.hidden = displayed !== 0;
  fallback.hidden = true;
  for (const button of categories.querySelectorAll('button')) {
    const active = button.dataset.category === selectedCategory;
    button.setAttribute('aria-pressed', String(active));
    button.className = active
      ? 'rounded-full border border-lime bg-lime px-4 py-2 text-xs font-semibold text-black'
      : 'rounded-full border border-line px-4 py-2 text-xs font-semibold text-muted hover:border-lime/60 hover:text-white';
  }
}

function reset() {
  input.value = '';
  selectedCategory = 'All';
  render();
  input.focus();
}

input.maxLength = MAX_QUERY_LENGTH;
for (const category of ['All', ...searchCategories]) {
  const button = element('button', 'desk-action', category);
  button.type = 'button';
  button.dataset.category = category;
  button.addEventListener('click', () => { selectedCategory = category; render(); });
  categories.append(button);
}
form.addEventListener('submit', event => { event.preventDefault(); render(); });
input.addEventListener('input', render);
clear.addEventListener('click', reset);
input.addEventListener('keydown', event => {
  if (event.key === 'Escape' && (input.value || selectedCategory !== 'All')) { event.preventDefault(); reset(); }
});
document.querySelectorAll('[data-search-suggestion]').forEach(button => {
  button.addEventListener('click', () => {
    input.value = button.dataset.searchSuggestion;
    selectedCategory = 'All';
    render();
    input.focus();
  });
});
document.addEventListener('keydown', event => {
  const target = event.target;
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !target?.closest?.('input,textarea,select,button,[contenteditable="true"]')) {
    event.preventDefault();
    input.focus();
  }
});
input.disabled = false;
submit.disabled = false;
render();
