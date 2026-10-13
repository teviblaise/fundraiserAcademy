import { detectCandlePatterns } from './candle-patterns.js';
import { MARKETS } from './simulator.js';

const hasMarket = symbol => typeof symbol === 'string' && Object.hasOwn(MARKETS, symbol);
const TIMEFRAMES = { '1m': '1 minute', '5m': '5 minutes', '15m': '15 minutes', '1h': '1 hour', '1d': '1 day' };
const SVG_NS = 'http://www.w3.org/2000/svg';
const dateLabel = (seconds, daily = false) => new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', ...(daily ? {} : { hour: '2-digit', minute: '2-digit' }), timeZone: 'UTC' }).format(seconds * 1000);
const isCrypto = symbol => MARKETS[symbol]?.category === 'Crypto';
const priceLabel = (value, symbol) => Number.isFinite(value) ? new Intl.NumberFormat('en-US', { minimumFractionDigits: MARKETS[symbol].decimals, maximumFractionDigits: MARKETS[symbol].decimals }).format(value) : '—';
const svgNode = (tag, attrs) => { const node = document.createElementNS(SVG_NS, tag); for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value); return node; };

// Historical charts are for study. The order ticket uses fresh quotes verified by the server.
export function createMarketReference(container, initialSymbol = 'EURUSD', userId = 'anonymous') {
  const storageKey = `fundraiser:market-reference:${userId}`;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { /* Preferences are optional. */ }
  let symbol = hasMarket(initialSymbol) ? initialSymbol : 'EURUSD';
  let interval = TIMEFRAMES[saved.interval] ? saved.interval : '15m';
  let view = isCrypto(symbol) ? (['candles', 'line', 'tradingview'].includes(saved.cryptoView) ? saved.cryptoView : 'candles') : (saved.forexView === 'line' ? 'line' : 'tradingview');
  let data = null, chartData = [], offset = 0, count = 80, selectedTime = null;
  let executionQuote = null, executionReady = null;
  let controller = null, sequence = 0, destroyed = false, chartEvents = null, refreshing = false;
  let tvLoadedKey = '', historyEnd = null;

  container.classList.add('market-reference');
  container.innerHTML = `<style>
.market-reference{min-width:0;overflow:hidden}.market-reference *{box-sizing:border-box}.mr-top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}.mr-eyebrow{font-size:10px;letter-spacing:.19em;color:#ffd700;font-weight:700;margin:0 0 8px}.mr-title{font-size:24px;letter-spacing:-.04em;margin:0;color:#fff}.mr-quote{text-align:right}.mr-price{font-size:26px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.035em}.mr-subtle{color:#b9b9b9;font-size:11px;line-height:1.6;margin:4px 0}.mr-source{color:#ffd700;text-decoration:underline;text-underline-offset:3px}.mr-badge{display:inline-flex;align-items:center;gap:6px;font-size:10px;padding:5px 8px;border:1px solid #3c3a26;border-radius:5px;color:#ffe879;margin:12px 0}.mr-controls{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:10px 0 12px}.mr-segment{display:flex;border:1px solid #3a3a3a;border-radius:7px;padding:3px;gap:3px;flex-wrap:wrap}.mr-btn{appearance:none;border:1px solid #393939;border-radius:6px;background:#191919;color:#c7c7c7;padding:7px 10px;font:inherit;font-size:11px;cursor:pointer;min-height:33px;white-space:nowrap}.mr-segment .mr-btn{border-color:transparent;background:transparent}.mr-btn:hover{color:#fff;border-color:#6d6020}.mr-btn[aria-pressed=true]{background:#ffd700;color:#0b0b0b;border-color:#ffd700;font-weight:650}.mr-btn:focus-visible,.mr-chart:focus-visible{outline:2px solid #ffd700;outline-offset:3px}.mr-btn:disabled{opacity:.4;cursor:not-allowed}.mr-select{margin:0!important;width:auto!important;padding:7px 30px 7px 10px!important;font-size:11px!important;min-height:33px!important;border-radius:6px!important}.mr-canvas{position:relative;border:1px solid #303030;background:#0b0b0b;border-radius:9px;overflow:hidden}.mr-chart{display:block;width:100%;height:330px;touch-action:pan-y}.mr-readout{min-height:40px;padding:10px 12px;font-size:10px;border-bottom:1px solid #282828;color:#b9b9b9;font-variant-numeric:tabular-nums;line-height:1.7}.mr-readout strong{color:#f4f4f4;font-weight:500}.mr-placeholder{display:flex;align-items:center;justify-content:center;padding:32px;text-align:center;height:330px;color:#b9b9b9;font-size:12px;line-height:1.8}.mr-tradingview{height:430px;width:100%;min-width:0}.mr-tv-loading{padding:20px;font-size:12px;color:#b9b9b9}.mr-navigation{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin:11px 0}.mr-nav-buttons{display:flex;gap:5px;flex-wrap:wrap}.mr-status{margin:9px 0 4px;font-size:11px;color:#b9b9b9;line-height:1.65}.mr-status[data-state=error],.mr-status[data-state=stale]{color:#ffce80}.mr-notice{font-size:11px;color:#b9b9b9;line-height:1.7;padding-top:13px;margin:12px 0 0;border-top:1px solid #303030}.mr-patterns{border-top:1px solid #303030;padding-top:16px;margin-top:15px}.mr-pattern-heading{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:7px}.mr-pattern-heading h3{font-size:14px;margin:0}.mr-pattern-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin:11px 0}.mr-pattern{display:flex;flex-direction:column;align-items:flex-start;white-space:normal;text-align:left;gap:3px;padding:10px}.mr-pattern span{font-size:10px;color:inherit;opacity:.8}.mr-pattern-name{font-weight:600;font-size:11px}.mr-pattern-empty{font-size:11px;color:#b9b9b9;line-height:1.7}.mr-hidden{display:none!important}@media(max-width:500px){.mr-chart{height:270px}.mr-price{font-size:23px}.mr-top{gap:9px}.mr-pattern-list{grid-template-columns:1fr}.mr-tradingview{height:380px}.mr-controls{align-items:stretch}.mr-select{max-width:100%}.mr-readout{min-height:54px}}
</style><div class="mr-top"><div><p class="mr-eyebrow">MARKET REFERENCE</p><h2 class="mr-title"></h2><p class="mr-subtle">Price history &amp; candlestick study</p></div><div class="mr-quote"><p class="mr-subtle mr-quote-label">Latest price reference</p><div class="mr-price">—</div><p class="mr-subtle mr-price-unit">USD per unit</p></div></div><div class="mr-badge">REFERENCE PRICES · DEMO FUNDS</div><div class="mr-controls"><div class="mr-segment" role="group" aria-label="Reference chart view"></div><label class="mr-subtle mr-timeframe-label">Timeframe <select class="mr-select" aria-label="Reference chart timeframe"></select></label></div><div class="mr-canvas"><div class="mr-local"><div class="mr-readout" aria-live="off">Move over the chart to inspect a candle.</div><svg class="mr-chart" viewBox="0 0 920 340" role="img" aria-label="Market reference price history" tabindex="0"></svg><div class="mr-placeholder mr-hidden"></div></div><div class="mr-tradingview mr-hidden"></div></div><div class="mr-navigation"><span class="mr-range mr-subtle"></span><div class="mr-nav-buttons"><button class="mr-btn" data-nav="older">Older history</button><button class="mr-btn" data-nav="back" aria-label="Pan chart to earlier prices">←</button><button class="mr-btn" data-nav="forward" aria-label="Pan chart to later prices">→</button><button class="mr-btn" data-nav="zoom-in" aria-label="Zoom in on chart">＋</button><button class="mr-btn" data-nav="zoom-out" aria-label="Zoom out of chart">−</button><button class="mr-btn" data-nav="latest">Latest</button></div></div><p class="mr-status" role="status" aria-live="polite"></p><div class="mr-source-row mr-subtle"></div><section class="mr-patterns"><div class="mr-pattern-heading"><h3>Candle pattern study</h3><span class="mr-subtle">Educational indicators</span></div><p class="mr-pattern-intro mr-subtle"></p><div class="mr-pattern-list"></div></section><p class="mr-notice">Demo fills, stops, targets and alerts use fresh server-verified market reference quotes. Charts and the order ticket can refresh at different times, and TradingView can use another provider. Daily forex rates are chart references only; forex execution waits for fresh intraday quotes. Chart patterns do not predict outcomes.</p>`;
  const el = selector => container.querySelector(selector);
  const title = el('.mr-title'), quote = el('.mr-price'), controls = el('.mr-segment'), timeframe = el('.mr-select');
  const status = el('.mr-status'), sourceRow = el('.mr-source-row'), chart = el('.mr-chart'), readout = el('.mr-readout');
  const tv = el('.mr-tradingview'), local = el('.mr-local'), nav = el('.mr-navigation'), patternList = el('.mr-pattern-list');
  const iframeObserver = new MutationObserver(() => { for (const iframe of tv.querySelectorAll('iframe')) if (!iframe.title) iframe.title = `${symbol} TradingView candlestick chart`; }); iframeObserver.observe(tv, { childList: true, subtree: true });
  const persist = () => { try { localStorage.setItem(storageKey, JSON.stringify({ interval, cryptoView: isCrypto(symbol) ? view : saved.cryptoView, forexView: !isCrypto(symbol) ? view : saved.forexView })); saved = JSON.parse(localStorage.getItem(storageKey)); } catch { /* Storage may be unavailable. */ } };
  function setStatus(message, state = '') { status.textContent = message; status.dataset.state = state; }
  function resetData() { data = null; chartData = []; offset = 0; historyEnd = null; selectedTime = null; quote.textContent = '—'; sourceRow.replaceChildren(); patternList.replaceChildren(); chart.replaceChildren(); readout.textContent = 'Loading market reference…'; }
  function renderControls() {
    const market = MARKETS[symbol];
    title.textContent = `${market.baseCurrency} / ${market.quoteCurrency}`;
    el('.mr-price-unit').textContent = `${market.quoteCurrency} per ${market.baseCurrency}`;
    controls.replaceChildren();
    const options = isCrypto(symbol) ? [['candles', 'Candles'], ['line', 'Line'], ['tradingview', 'TradingView']] : [['tradingview', 'Candles · TradingView'], ['line', 'Daily closes']];
    for (const [key, label] of options) {
      const button = document.createElement('button'); button.className = 'mr-btn'; button.textContent = label; button.type = 'button'; button.setAttribute('aria-pressed', String(key === view));
      button.addEventListener('click', () => { view = key; persist(); renderControls(); renderChart(); renderPatterns(); }); controls.append(button);
    }
    timeframe.replaceChildren();
    for (const [key, label] of Object.entries(isCrypto(symbol) ? TIMEFRAMES : { '1d': 'Daily ECB reference' })) { const option = document.createElement('option'); option.value = key; option.textContent = label; timeframe.append(option); }
    timeframe.value = isCrypto(symbol) ? interval : '1d';
    el('.mr-timeframe-label').classList.toggle('mr-hidden', view === 'tradingview');
    local.classList.toggle('mr-hidden', view === 'tradingview'); tv.classList.toggle('mr-hidden', view !== 'tradingview'); nav.classList.toggle('mr-hidden', view === 'tradingview');
  }
  function sourceInfo() {
    sourceRow.replaceChildren();
    const header = executionQuote || data;
    if (!header) return;
    const link = document.createElement('a'); link.className = 'mr-source'; link.textContent = header.source || 'Market data provider';
    try { const url = new URL(header.sourceUrl); if (url.protocol === 'https:') { link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; } } catch { /* Display source text without an invalid link. */ }
    sourceRow.append('Quote source: ', link, ` · As of ${dateLabel(header.asOf, header.quoteKind === 'daily-reference')} UTC`);
    if (header.fetchedAt) sourceRow.append(` · Retrieved ${new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' }).format(header.fetchedAt)} UTC`);
    if (header.delayed) sourceRow.append(' · Delayed / periodic reference');
    if (header.deliveryMode === 'streaming') sourceRow.append(' · Streaming quotes');
    else if (header.deliveryMode === 'polling') sourceRow.append(' · Periodic quotes');
    if (executionReady === false) sourceRow.append(' · Demo execution paused');
    if (data?.historySource) sourceRow.append(` · Chart history: ${data.historySource}`);
  }
  function renderQuoteHeader() {
    const header = executionQuote || data;
    quote.textContent = priceLabel(header?.price, symbol);
    const delivery = executionQuote?.deliveryMode === 'streaming' ? 'Streaming' : executionQuote?.deliveryMode === 'polling' ? 'Periodic' : null;
    el('.mr-quote-label').textContent = executionQuote
      ? executionReady ? delivery ? `${delivery} execution reference` : 'Execution reference price' : 'Last execution reference · paused'
      : header?.quoteKind === 'daily-reference' ? 'Daily chart reference' : executionReady === false ? 'Chart reference · execution paused' : 'Latest price reference';
    sourceInfo();
  }
  function renderPatterns() {
    patternList.replaceChildren();
    if (!isCrypto(symbol)) {
      el('.mr-pattern-intro').textContent = 'Use the TradingView candle chart to study forex price action. ECB data is daily closing references, so it cannot be used to detect candle patterns.';
      return;
    }
    el('.mr-pattern-intro').textContent = 'Simple shapes detected in the loaded Coinbase OHLC history. Select one to inspect its candle. Current candles can change before they close.';
    const patterns = detectCandlePatterns(chartData).slice(-6).reverse();
    if (!patterns.length) { const message = document.createElement('p'); message.className = 'mr-pattern-empty'; message.textContent = chartData.length ? 'No matching doji, hammer or engulfing shapes in this history window.' : 'Pattern study will appear when real OHLC history is available.'; patternList.append(message); return; }
    for (const pattern of patterns) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'mr-btn mr-pattern'; button.setAttribute('aria-pressed', String(selectedTime === pattern.time));
      const name = document.createElement('strong'); name.className = 'mr-pattern-name'; name.textContent = pattern.name;
      const when = document.createElement('span'); when.textContent = `${dateLabel(pattern.time, interval === '1d')} UTC · ${pattern.bias}`;
      const explanation = document.createElement('span'); explanation.textContent = pattern.explanation;
      button.append(name, when, explanation);
      button.addEventListener('click', () => { selectedTime = pattern.time; if (view === 'tradingview') { view = 'candles'; renderControls(); persist(); } const index = chartData.findIndex(candle => candle.time === pattern.time); offset = Math.max(0, Math.min(chartData.length - count, chartData.length - index - Math.floor(count / 2))); renderChart(); renderPatterns(); });
      patternList.append(button);
    }
  }
  function tradingViewChart() {
    const key = `${symbol}:${interval}`;
    if (tvLoadedKey === key && tv.childElementCount) return;
    tvLoadedKey = key; tv.replaceChildren();
    const holder = document.createElement('div'); holder.className = 'tradingview-widget-container'; holder.style.height = '100%'; holder.style.width = '100%';
    const widget = document.createElement('div'); widget.className = 'tradingview-widget-container__widget'; widget.style.height = 'calc(100% - 27px)'; widget.style.width = '100%';
    const loading = document.createElement('p'); loading.className = 'mr-tv-loading'; loading.textContent = 'Loading TradingView candles…'; widget.append(loading); holder.append(widget);
    const attribution = document.createElement('div'); attribution.style.cssText = 'font-size:10px;padding:5px 10px;color:#b9b9b9'; const link = document.createElement('a'); link.href = 'https://www.tradingview.com/'; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Charts by TradingView'; link.className = 'mr-source'; attribution.append(link); holder.append(attribution);
    const script = document.createElement('script'); script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js'; script.async = true;
    script.textContent = JSON.stringify({ autosize: true, symbol: `${isCrypto(symbol) ? 'COINBASE' : 'FX'}:${symbol}`, interval: isCrypto(symbol) ? ({ '1m': '1', '5m': '5', '15m': '15', '1h': '60', '1d': 'D' }[interval]) : '60', timezone: 'Etc/UTC', theme: 'dark', style: '1', locale: 'en', backgroundColor: 'rgba(11, 11, 11, 1)', gridColor: 'rgba(48, 48, 48, 0.45)', hide_top_toolbar: false, hide_side_toolbar: false, allow_symbol_change: false, save_image: false, calendar: false, support_host: 'https://www.tradingview.com' });
    script.onerror = () => { if (!destroyed && key === tvLoadedKey) loading.textContent = 'TradingView could not load. Use the history view or retry after checking your connection.'; };
    holder.append(script); tv.append(holder);
  }
  function renderChart() {
    if (view === 'tradingview') { tradingViewChart(); return; }
    chartEvents?.abort(); chartEvents = new AbortController(); chart.replaceChildren();
    const placeholder = el('.mr-placeholder'); placeholder.classList.toggle('mr-hidden', Boolean(chartData.length)); chart.classList.toggle('mr-hidden', !chartData.length);
    if (!chartData.length) { placeholder.textContent = refreshing ? 'Loading market history…' : 'Market history is unavailable. Retry after checking your connection or select another market.'; nav.querySelectorAll('button').forEach(button => { button.disabled = true; }); el('.mr-range').textContent = ''; readout.textContent = 'No reference history'; return; }
    const end = Math.max(1, chartData.length - offset), start = Math.max(0, end - count), visible = chartData.slice(start, end);
    const daily = !isCrypto(symbol) || interval === '1d';
    el('.mr-range').textContent = `${dateLabel(visible[0].time, daily)} – ${dateLabel(visible.at(-1).time, daily)} UTC`;
    const points = view === 'candles' ? visible.flatMap(candle => [candle.low, candle.high]) : visible.map(point => point.close);
    let low = Math.min(...points), high = Math.max(...points); const padding = Math.max((high - low) * .1, high * .0001); low -= padding; high += padding;
    const canvasWidth = Math.max(320, Math.min(920, chart.clientWidth || 920)); chart.setAttribute('viewBox', `0 0 ${canvasWidth} 340`);
    const width = canvasWidth - 80, height = 270, left = 12, top = 18; const y = value => top + height - (value - low) / (high - low) * height; const step = width / visible.length; const x = index => left + step * (index + .5);
    for (let index = 0; index <= 4; index++) { const value = low + (high - low) * index / 4; const at = y(value); chart.append(svgNode('line', { x1: left, x2: left + width, y1: at, y2: at, stroke: '#282828', 'stroke-dasharray': '3 4' })); const text = svgNode('text', { x: canvasWidth - 8, y: at + 4, 'text-anchor': 'end', fill: '#999', 'font-size': '10' }); text.textContent = priceLabel(value, symbol); chart.append(text); }
    if (view === 'candles') {
      for (const [index, candle] of visible.entries()) { const positive = candle.close >= candle.open, color = positive ? '#ffd700' : '#c97b75', at = x(index); chart.append(svgNode('line', { x1: at, x2: at, y1: y(candle.high), y2: y(candle.low), stroke: color, 'stroke-width': '1' })); chart.append(svgNode('rect', { x: at - Math.max(1.5, step * .29), y: Math.min(y(candle.open), y(candle.close)), width: Math.max(3, step * .58), height: Math.max(1.1, Math.abs(y(candle.open) - y(candle.close))), fill: positive ? '#ffd700' : '#c97b75', opacity: '.9', rx: '.4' })); }
    } else { chart.append(svgNode('path', { d: visible.map((point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(2)} ${y(point.close).toFixed(2)}`).join(' '), fill: 'none', stroke: '#ffd700', 'stroke-width': '2' })); }
    for (const index of [...new Set(canvasWidth < 500 ? [0, visible.length - 1] : [0, Math.floor(visible.length / 2), visible.length - 1])]) { const label = svgNode('text', { x: x(index), y: 318, fill: '#999', 'font-size': '10', 'text-anchor': index === 0 ? 'start' : index === visible.length - 1 ? 'end' : 'middle' }); label.textContent = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', ...(daily ? {} : { hour: '2-digit', minute: '2-digit' }), timeZone: 'UTC' }).format(visible[index].time * 1000); chart.append(label); }
    const cursor = svgNode('line', { x1: 0, x2: 0, y1: top, y2: top + height, stroke: '#b9b9b9', 'stroke-dasharray': '3 3', visibility: 'hidden' }); chart.append(cursor);
    const selected = visible.findIndex(candle => candle.time === selectedTime); if (selected >= 0) chart.append(svgNode('rect', { x: x(selected) - step * .5, y: top, width: Math.max(step, 2), height, fill: '#ffd700', opacity: '.1', stroke: '#ffd700', 'stroke-width': '1' }));
    const inspect = index => { const candle = visible[Math.max(0, Math.min(visible.length - 1, index))]; cursor.setAttribute('x1', x(index)); cursor.setAttribute('x2', x(index)); cursor.setAttribute('visibility', 'visible'); readout.replaceChildren(); const when = document.createElement('strong'); when.textContent = `${dateLabel(candle.time, daily)} UTC`; readout.append(when, '  '); if (view === 'candles') { for (const [label, value] of [['O', candle.open], ['H', candle.high], ['L', candle.low], ['C', candle.close]]) { const text = document.createElement('strong'); text.textContent = `${label} ${priceLabel(value, symbol)}`; readout.append(text, '   '); } if (Number.isFinite(candle.volume)) readout.append(`Volume ${candle.volume.toLocaleString(undefined, { maximumFractionDigits: 2 })}`); } else readout.append(`Close ${priceLabel(candle.close, symbol)}`); };
    chart.addEventListener('pointermove', event => { const rect = chart.getBoundingClientRect(); const index = Math.floor(((event.clientX - rect.left) / rect.width * canvasWidth - left) / step); if (index >= 0 && index < visible.length) inspect(index); }, { signal: chartEvents.signal });
    chart.addEventListener('pointerleave', () => cursor.setAttribute('visibility', 'hidden'), { signal: chartEvents.signal });
    chart.addEventListener('keydown', event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); offset = Math.max(0, Math.min(Math.max(0, chartData.length - count), offset + (event.key === 'ArrowLeft' ? 10 : -10))); renderChart(); } }, { signal: chartEvents.signal });
    chart.addEventListener('wheel', event => { if (!event.ctrlKey) return; event.preventDefault(); count = Math.max(20, Math.min(300, count + (event.deltaY > 0 ? 20 : -20))); renderChart(); }, { passive: false, signal: chartEvents.signal });
    readout.textContent = view === 'candles' ? 'Move over a candle for open, high, low and close. Gold = up · Rose = down.' : 'Move over the line for the closing reference price.';
    el('[data-nav=older]').disabled = !isCrypto(symbol) || refreshing; el('[data-nav=back]').disabled = start === 0; el('[data-nav=forward]').disabled = offset === 0; el('[data-nav=latest]').disabled = false; el('[data-nav=zoom-in]').disabled = count <= 20; el('[data-nav=zoom-out]').disabled = count >= 300;
  }
  async function load({ older = false } = {}) {
    controller?.abort(); controller = new AbortController(); const id = ++sequence, requestSymbol = symbol, requestInterval = isCrypto(symbol) ? interval : '1d';
    refreshing = true; if (!data) setStatus('Connecting to market reference…'); else if (older) setStatus('Loading earlier market history…');
    renderChart();
    const query = new URLSearchParams({ symbol, interval: requestInterval }); if (older && chartData.length) query.set('end', String(chartData[0].time - 1));
    try {
      const response = await fetch(`/api/market-reference?${query}`, { credentials: 'same-origin', signal: controller.signal });
      const result = await response.json(); if (destroyed || id !== sequence || requestSymbol !== symbol) return;
      if (!response.ok || result.unavailable) throw new Error(result.error || 'Market reference is temporarily unavailable.');
      const rows = (isCrypto(symbol) ? result.candles : result.points) || [];
      const clean = rows.filter(row => Number.isFinite(row.time) && Number.isFinite(row.close) && row.close > 0 && (!isCrypto(symbol) || ([row.open, row.high, row.low].every(value => Number.isFinite(value) && value > 0) && row.high >= Math.max(row.open, row.close) && row.low <= Math.min(row.open, row.close)))).sort((a, b) => a.time - b.time);
      if (!clean.length) throw new Error('The provider returned no price history for this period.');
      if (older) {
        const existingLength = chartData.length, oldFirst = chartData[0].time; const byTime = new Map([...clean, ...chartData].map(row => [row.time, row])); chartData = [...byTime.values()].sort((a, b) => a.time - b.time).slice(-3000); offset = Math.min(chartData.length - 1, existingLength); historyEnd = oldFirst;
        setStatus(clean.some(row => row.time < oldFirst) ? 'Earlier history loaded. Use the arrows or Latest to navigate.' : 'No earlier prices were returned for this period.');
      } else {
        data = result; renderQuoteHeader();
        // Keep a browsed historical window stable while the latest quote updates.
        if (!historyEnd) { chartData = clean; offset = Math.min(offset, Math.max(0, chartData.length - 1)); }
        setStatus(result.stale
          ? 'STALE reference · prices may be out of date. Demo execution waits for a fresh server quote.'
          : isCrypto(symbol)
            ? `${result.source || 'Coinbase'} price reference and OHLC history · chart refreshes every 30 seconds. The ticket uses the latest fresh server quote.`
            : result.quoteKind === 'intraday'
              ? `${result.source || 'Intraday provider'} price reference · line history uses daily ECB closes. TradingView provides a separate intraday candle chart.`
              : 'Daily ECB chart history · published on business days. Forex demo fills require verified intraday references; TradingView candles alone do not provide order-ticket prices.', result.stale ? 'stale' : result.quoteKind === 'daily-reference' ? 'stale' : '');
      }
    } catch (error) {
      if (error.name === 'AbortError' || destroyed || id !== sequence) return;
      setStatus(data ? `STALE reference · ${error.message} Last successful quote is still shown.` : `Reference unavailable · ${error.message}`, data ? 'stale' : 'error');
      if (!data) renderQuoteHeader();
    } finally { if (id === sequence && !destroyed) { refreshing = false; renderChart(); renderPatterns(); } }
  }
  timeframe.addEventListener('change', () => { interval = timeframe.value; persist(); resetData(); tvLoadedKey = ''; load(); });
  nav.addEventListener('click', event => {
    const action = event.target.closest('[data-nav]')?.dataset.nav; if (!action) return;
    if (action === 'older') return void load({ older: true });
    if (action === 'latest') { offset = 0; historyEnd = null; selectedTime = null; return void load(); }
    if (action === 'back') offset = Math.min(Math.max(0, chartData.length - count), offset + Math.max(20, Math.floor(count / 2)));
    if (action === 'forward') offset = Math.max(0, offset - Math.max(20, Math.floor(count / 2)));
    if (action === 'zoom-in') count = Math.max(20, count - 20);
    if (action === 'zoom-out') count = Math.min(300, count + 20);
    renderChart();
  });
  const onVisible = () => { if (!document.hidden && !destroyed) load(); };
  document.addEventListener('visibilitychange', onVisible);
  let observedWidth = 0; const resizeObserver = new ResizeObserver(entries => { const width = entries[0]?.contentRect.width; if (width && Math.abs(width - observedWidth) > 1) { observedWidth = width; if (!destroyed) renderChart(); } }); resizeObserver.observe(container);
  const timer = setInterval(() => { if (!document.hidden && !destroyed && !refreshing) load(); }, 30000);
  renderControls(); load();
  return {
    selectSymbol(next) { if (!hasMarket(next) || symbol === next || destroyed) return; symbol = next; executionQuote = null; executionReady = null; view = isCrypto(symbol) ? (['candles', 'line', 'tradingview'].includes(saved.cryptoView) ? saved.cryptoView : 'candles') : (saved.forexView === 'line' ? 'line' : 'tradingview'); resetData(); tvLoadedKey = ''; renderControls(); load(); },
    updateExecutionQuote(next, currentQuote, ready) {
      if (destroyed || next !== symbol) return;
      executionReady = ready === true;
      const valid = Number.isFinite(currentQuote?.price) && currentQuote.price > 0 && Number.isFinite(currentQuote.asOf) && Number.isFinite(currentQuote.fetchedAt) && typeof currentQuote.source === 'string' && currentQuote.source.length > 0;
      executionQuote = valid ? { price:currentQuote.price, asOf:currentQuote.asOf, fetchedAt:currentQuote.fetchedAt, source:currentQuote.source, sourceUrl:({ 'Coinbase Exchange':'https://www.coinbase.com/advanced-trade', 'Twelve Data':'https://twelvedata.com/' })[currentQuote.source], deliveryMode:currentQuote.deliveryMode, quoteKind:isCrypto(symbol) ? 'last-trade' : 'intraday', delayed:false } : null;
      renderQuoteHeader();
    },
    destroy() { destroyed = true; sequence++; controller?.abort(); chartEvents?.abort(); clearInterval(timer); resizeObserver.disconnect(); iframeObserver.disconnect(); document.removeEventListener('visibilitychange', onVisible); container.replaceChildren(); }
  };
}
