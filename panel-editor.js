/* =====================================================================================
   AVDEN-Studio · PANEL EDITOR v4.4.1
   Встраиваемый визуальный WYSIWYG-редактор и менеджер сигналов для AV-панелей

   Copyright 2026 Вяхирев Алексей Алексеевич (Alexey A. Vyakhirev)
   Licensed under the Apache License, Version 2.0 (see LICENSE and NOTICE)

   ПОДКЛЮЧЕНИЕ (после av-core.js и перед </body>):
   <script src="panel-editor.js" id="pe-script"></script>

   ОСНОВНЫЕ ВОЗМОЖНОСТИ:
   • Визуальная правка геометрии: Smart Guides, сетка, Lasso-выделение, выравнивание
   • Реестр, валидация, авто-выделение и миграция join-сигналов (числовые ↔ именованные)
   • Прямая вставка HTML-экранов и виджетов из буфера обмена (LLM-генерация по AV-SKILL.md)
   • Менеджер цветовых тем (готовые пресеты + 3 пипетки на color-mix с сохранением в HTML)
   • Редактор многосостоянийных кнопок (data-states) и защита текста (data-text-lock)
   • Чистый экспорт: автоматическое удаление UI редактора, сброс сцены и верификация в iframe

   ГОРЯЧИЕ КЛАВИШИ:
   • E — режим правки · J — бейджи join-ов · S — активный экран · O — отступ холста
   • Tab / H — скрыть инспектор / верхнюю панель · Ctrl+Z / Ctrl+Y — история · Ctrl+S — экспорт
   ===================================================================================== */

(function () {
'use strict';
if (window.__panelEditorLoaded) return;
window.__panelEditorLoaded = true;

if (!window.AVStates || !window.AVVisibility || !window.AVRadio || !window.AVStepRepeat) {
  console.error('[Panel Editor] Нужен av-core.js v3.1+ со встроенными рантаймами. Обновите ядро рядом с панелью.');
}



function ensureStatesRuntime() {
  if (window.AVStates) return;
  if (document.getElementById('av-states-compat')) return;
  var sc = document.createElement('script');
  sc.id = 'av-states-compat';
  sc.textContent = '(' + function () {
    if (window.AVStates) return;
    function isNum(v) { return /^\d+$/.test(String(v)); }
    function token(v) { return isNum(v) ? +v : String(v); }
    function normJoin(j) { return j == null ? '' : String(j).trim(); }
    function statesOf(el) { try { return JSON.parse(el.getAttribute('data-states') || '[]'); } catch (e) { return []; } }
    function apply(el, idx) {
      if (!el || el.nodeType !== 1) return;
      var list = statesOf(el); if (!list.length) return;
      idx = Math.max(0, Math.min(list.length - 1, idx | 0));
      var st = list[idx] || {};
      el.setAttribute('data-state-index', String(idx));
      var lab = el.querySelector('[data-role="label"]');
      if (lab && st.label != null && !lab.hasAttribute('data-text-lock')) lab.textContent = st.label;
      var ico = el.querySelector('[data-role="icon"]');
      if (ico) {
        if (st.svg) ico.innerHTML = st.svg;
        else if (st.img) ico.innerHTML = '<img alt="" src="' + st.img.replace(/"/g, '&quot;') + '">';
        else ico.innerHTML = '';
        var ch = ico.firstElementChild;
        if (ch) { ch.style.width = '100%'; ch.style.height = '100%'; ch.style.display = 'block'; ch.style.objectFit = 'contain'; }
      }
      if (st.color) {
        el.style.setProperty('--st-c', st.color);
        el.style.borderColor = 'color-mix(in srgb, ' + st.color + ' 55%, transparent)';
      }
      if (st.bg) {
        el.style.setProperty('--st-bg', st.bg);
        el.style.background = 'linear-gradient(180deg, ' + st.bg + ', rgba(13,26,41,.7))';
      }
      el.setAttribute('aria-pressed', idx > 0 ? 'true' : 'false');
    }
    window.AVStates = {
      apply: apply, states: statesOf, token: token,
      refresh: function () {
        document.querySelectorAll('[data-states]').forEach(function (el) {
          if (!el.closest('[data-pe-ui]')) apply(el, +(el.getAttribute('data-state-index') || 0));
        });
      },
      rx: function (join, value) {
        var key = normJoin(join);
        document.querySelectorAll('[data-states]').forEach(function (el) {
          if (!el.closest('[data-pe-ui]') && normJoin(el.getAttribute('data-state-join') || el.getAttribute('data-cmd-join')) === key) apply(el, value);
        });
      }
    };
    document.addEventListener('click', function (e) {
      if (document.body.classList.contains('pe-editing')) return;
      var el = e.target.closest && e.target.closest('[data-states]');
      if (!el || el.closest('[data-pe-ui]') || el.hasAttribute('data-static')) return;
      var list = statesOf(el); if (!list.length) return;
      var cur = +(el.getAttribute('data-state-index') || 0);
      var next = el.getAttribute('data-cmd-mode') === 'set' ? parseInt(el.getAttribute('data-cmd-value') || '0', 10) : (cur + 1) % list.length;
      apply(el, next);
      var j = el.getAttribute('data-state-join') || el.getAttribute('data-cmd-join');
      if (j && typeof window.sendControlSignal === 'function') window.sendControlSignal('analog', token(j), next);
      else if (j && window.Panel && typeof window.Panel.send === 'function') window.Panel.send('analog', token(j), next);
    });
    ['av:analog', 'av:serial'].forEach(function (ev) {
      document.addEventListener(ev, function (e) { if (e.detail && e.detail.join != null) window.AVStates.rx(e.detail.join, e.detail.value); });
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', window.AVStates.refresh);
    else window.AVStates.refresh();
  }.toString() + ')();';
  document.body.appendChild(sc);
}


if (!window.AVStates && document.querySelector('[data-states]')) ensureStatesRuntime();


/* ===================== МОДЕЛЬ JOIN: ОДИН ЭЛЕМЕНТ — ОДИН JOIN НА РОЛЬ ===================== */


var ROLES = [
  { key: 'digital', label: 'Digital', canon: 'data-join-digital', alias: ['data-digital-join', 'data-cmd-join'], letter: 'D' },
  { key: 'analog',  label: 'Analog',  canon: 'data-join-analog',  alias: ['data-analog-join'], letter: 'A' },
  { key: 'text',    label: 'String',  canon: 'data-join-string',  alias: ['data-text-join'], letter: 'S' },
  { key: 'ph',      label: 'Placeholder', canon: 'data-join-placeholder', alias: [], letter: 'P' },
  { key: 'state',   label: 'State (analog)', canon: 'data-state-join', alias: [], letter: 'T' },
  { key: 'vis',     label: 'Visibility (0/1)', canon: 'data-visibility-join', alias: [], letter: 'H' },
  { key: 'mute',    label: 'Mute ref', canon: 'data-mute-join', alias: [], letter: 'M' },
  { key: 'readout', label: 'Readout ref', canon: 'data-readout-for', alias: [], letter: 'R' },
  { key: 'meter',   label: 'Meter ref', canon: 'data-meter-for', alias: [], letter: 'V' },
  { key: 'save',    label: 'Preset save', canon: 'data-preset-save', alias: [], letter: 'W' }
];


var ROLE_BY_KEY = {}, JOIN_ATTRS = [], ATTR_ROLE = {};
ROLES.forEach(function (r) {
  ROLE_BY_KEY[r.key] = r;
  JOIN_ATTRS.push(r.canon); ATTR_ROLE[r.canon] = r.key;
  r.alias.forEach(function (a) { JOIN_ATTRS.push(a); ATTR_ROLE[a] = r.key; });
});
var BIND_TIME_ATTRS = ['data-latch', 'data-local', 'data-preset-save'];

var SHOWN_ATTRS = JOIN_ATTRS.concat([
  'data-cmd-mode', 'data-state-type', 'data-state-mode', 'data-nav', 'data-app', 'data-active-class',
  'data-nav-dialog', 'data-nav-back', 'data-nav-toggle', 'data-nav-reset', 'data-nav-key',
  'data-source-target', 'data-cam-tab', 'data-audio-tab', 'data-visibility', 'data-initial',
  'data-active-style', 'data-icon-on', 'data-icon-off', 'data-char', 'data-pw-char', 'data-dtmf-char',
  'data-channel', 'data-no-join', 'data-dialog', 'data-screen', 'data-screensaver',
  'data-latch', 'data-local', 'data-label-on', 'data-label-off', 'data-tab-target', 'data-tab-panel',
  'data-tab-scope', 'data-tabs', 'data-enter-join', 'data-list-join', 'data-list-search',
  'data-list-empty', 'data-list-seed', 'data-list-colors', 'data-list-template', 'data-field',
  'data-route-dest', 'data-route-src', 'data-route-current', 'data-route-default', 'data-route-labels',
  'data-cam-pose', 'data-pose-scene', 'data-power-for', 'data-brightness-for', 'data-theme-toggle',
  'data-sound-toggle', 'data-width', 'data-height', 'data-panel-root', 'data-suffix', 'data-drawer',
  'data-radio-group', 'data-radio-local', 'data-radio-scope', 'data-repeat', 'data-repeat-delay', 'data-repeat-rate'
]);

var MANAGED_ATTRS = SHOWN_ATTRS.concat([
  'data-states', 'data-state-index', 'data-role', 'data-cmd-value', 'data-cmd-pulse-ms',
  'data-state-pulse-ms', 'data-cmd-echo', 'data-text-lock'
]);


var LOCK_ATTR = 'data-text-lock';
var NAME_RE = /^[A-Za-z][A-Za-z0-9_.\-]*$/;
var ACTIVE_TOKENS = ['is-active', 'active', 'is-open', 'open', 'visible', 'is-visible', 'show', 'shown'];
var TRANSIENT_CLASSES = ['flash', 'held', 'pr-done', 'bump', 'shake', 'is-pressed', 'is-shake', 'is-holding', 'jb-flash', 'jb-outline', 'is-leaving'];
var PAGE_SEL = '[data-screen],.screen,.page,.av-page,[id^="screen-"],[id^="page-"],[id^="subpage-"]';
var DIALOG_SEL = '.overlay,.av-modal,.modal,.dialog,[data-dialog],[id^="overlay-"],[id^="modal-"],[id^="dialog-"],#journal,#shutdown-overlay';
var SAVER_SEL = '[data-screensaver],#splash,#screensaver';
var SCREEN_SEL = PAGE_SEL + ',' + DIALOG_SEL + ',' + SAVER_SEL;
var SAVER_RE = /screensaver|saver|standby|idle|splash/i;
var ICON_SEL = '[data-role="icon"],.av-ico,.av-icon,script,style';
var LABEL_HINT = /(^|[-_ ])(label|name|title|text|txt|caption|desc|subtitle)([-_ ]|$)/i;
var BADGE_HINT = /(^|[-_ ])(num|number|idx|index|badge|count|digit|code|tag|chip|key)([-_ ]|$)/i;
var DECOR_HINT = /(^|[-_ ])(track|bar|meter|progress|fill|thumb|knob|dot|led)([-_ ]|$)/i;

function isNum(v) { return /^\d+$/.test(String(v)); }
function family(v) { return isNum(v) ? 'num' : 'name'; }
function validJoin(v) { return isNum(v) || NAME_RE.test(String(v)); }
function panelNodes() { return Array.from(document.querySelectorAll('*')).filter(function (n) { return !n.closest('[data-pe-ui]'); }); }
function isScreenEl(el) { return !!el && el.nodeType === 1 && el.matches(SCREEN_SEL); }
function pressable(el) {
  if (!el || el.nodeType !== 1 || isScreenEl(el)) return false;
  if (el.tagName === 'BUTTON') return true;
  if (el.getAttribute('role') === 'button') return true;
  if (el.id === 'splash') return true;
  if (el.hasAttribute('data-nav') || el.hasAttribute('data-nav-back') || el.hasAttribute('data-nav-dialog')) return true;
  if (el.hasAttribute('data-char') || el.hasAttribute('data-pw-char') || el.hasAttribute('data-dtmf-char')) return true;
  return /\b(av-book-row|av-toggle|av-mute|av-check-row|av-preset|av-dpad-btn|av-key|list-item|book-item)\b/.test(el.className || '');
}

var _diagCache = null, _diagT = 0;
function invalidateDiag() { _diagCache = null; }
function readRole(el, role) {
  var r = ROLE_BY_KEY[role], attrs = [r.canon].concat(r.alias), found = null, extra = [];
  attrs.forEach(function (a) {
    var v = (el.getAttribute(a) || '').trim();
    if (!v) return;
    if (found === null) found = { attr: a, value: v };
    else extra.push({ attr: a, value: v });
  });
  return { role: role, canon: r.canon, main: found, extra: extra };
}
function writeRole(el, role, value) {
  var r = ROLE_BY_KEY[role], v = String(value == null ? '' : value).trim();
  var before = readRole(el, role);
  if (v) el.setAttribute(r.canon, v); else el.removeAttribute(r.canon);
  r.alias.forEach(function (a) { el.removeAttribute(a); });
  invalidateDiag();
  return !before.main || before.main.value !== v || before.main.attr !== r.canon || before.extra.length > 0;
}
function canonizeEl(el) {
  var changed = false;
  ROLES.forEach(function (r) {
    var info = readRole(el, r.key);
    if (!info.main) return;
    if (info.main.attr !== r.canon || info.extra.length) { writeRole(el, r.key, info.main.value); changed = true; }
  });
  return changed;
}
function canonizeAll() {
  var out = [];
  panelNodes().forEach(function (el) { if (canonizeEl(el)) out.push(el); });
  return out;
}

/* ===================== JOIN ЭКРАНА: чтение, запись, нормализация, копирование ===================== */
function screenJoin(el) { var i = readRole(el, 'digital'); return i.main ? i.main.value : ''; }
function screenId(el) { return el.id || el.getAttribute('data-screen') || el.getAttribute('data-dialog') || ''; }
function joinFromId(el) {
  var id = screenId(el), k = kindOf(el);
  if (!id) return '';
  if (/^page-/.test(id)) return 'page.' + id.slice(5);
  if (/^modal-/.test(id)) return 'dialog.' + id.slice(6);
  if (/^dialog-/.test(id)) return 'dialog.' + id.slice(7);
  if (/^overlay-/.test(id)) return 'overlay.' + id.slice(8);
  if (/^screen-/.test(id)) return 'screen.' + id.slice(7);
  if (/^subpage-/.test(id)) return 'subpage.' + id.slice(8);
  if (id === 'splash' || id === 'screensaver') return 'panel.wake';
  if (id === 'journal') return 'dialog.debugger';
  if (id === 'shutdown-overlay') return 'system.shutdown.busy';
  return (k === 'dialog' ? 'dialog.' : k === 'saver' ? 'saver.' : 'page.') + id;
}
function rxCommandFor(el) {
  var j = screenJoin(el);
  if (!j) return '';
  return JSON.stringify({ type: 'digital', join: isNum(j) ? Number(j) : j, value: 1 });
}
function copyText(t, okMsg) {
  if (!t) { toast('warn', 'Нечего копировать'); return; }
  var done = function () { toast('ok', okMsg || 'Скопировано'); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(done, function () { legacyCopy(t, done); });
  } else legacyCopy(t, done);
}
function legacyCopy(t, done) {
  var ta = document.createElement('textarea');
  ta.value = t; ta.setAttribute('data-pe-ui', '1');
  ta.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.appendChild(ta); ta.select();
  var ok = false;
  try { ok = document.execCommand('copy'); } catch (e) {}
  ta.remove();
  ok ? done() : toast('warn', 'Буфер недоступен — скопируйте вручную');
}

/* ===================== ПЕРЕПРИВЯЗКА ===================== */
function syncLiveFields(root) {
  var one = function (n) {
    if (n.tagName === 'INPUT') {
      if (n.type === 'checkbox' || n.type === 'radio') { if (n.checked) n.setAttribute('checked', ''); else n.removeAttribute('checked'); }
      else n.setAttribute('value', n.value);
    } else if (n.tagName === 'TEXTAREA') n.textContent = n.value;
    else if (n.tagName === 'SELECT') Array.from(n.options).forEach(function (o) { if (o.selected) o.setAttribute('selected', ''); else o.removeAttribute('selected'); });
  };
  if (root.matches && root.matches('input,textarea,select')) one(root);
  if (root.querySelectorAll) root.querySelectorAll('input,textarea,select').forEach(one);
}
function softRebind() {
  invalidateDiag();
  if (window.Panel && typeof window.Panel.rebuild === 'function') { try { window.Panel.rebuild(); } catch (e) {} }
  else if (window.AVPanel && typeof window.AVPanel.rebind === 'function') { try { window.AVPanel.rebind(); } catch (e) {} }
  if (window.AVStates) window.AVStates.refresh();
  if (window.AVTextLock) window.AVTextLock.refresh();
  setTimeout(function () { paintBadges(); paintStats(); syncActiveChip(); }, 60);
}
function rebindChanged(els) {
  var uniq = [];
  (els || []).forEach(function (el) { if (el && uniq.indexOf(el) < 0) uniq.push(el); });
  var replaced = 0;
  uniq.forEach(function (el) {
    if (!el.isConnected || !pressable(el)) return;
    syncLiveFields(el);
    var clone = el.cloneNode(true);
    try { delete clone._bound; } catch (e) {}
    if (PE.sel === el) PE.sel = clone;
    el.replaceWith(clone);
    replaced++;
  });
  softRebind();
  return replaced;
}

/* ===================== ДИАГНОСТИКА ===================== */
function diagnostics(force) {
  var now = (window.performance && performance.now) ? performance.now() : Date.now();
  if (!force && _diagCache && now - _diagT < 150) return _diagCache;
  var multi = [], shared = [], legacy = [], invalid = [], noJoin = [], byDigital = new Map();
  panelNodes().forEach(function (el) {
    ROLES.forEach(function (r) {
      var info = readRole(el, r.key);
      if (!info.main) return;
      if (info.extra.length) multi.push({ el: el, role: r.key, keep: info.main, extra: info.extra });
      if (info.main.attr !== r.canon || info.extra.length) legacy.push({ el: el, role: r.key });
      if (!validJoin(info.main.value)) invalid.push({ el: el, role: r.key, value: info.main.value });
    });
    if (isScreenEl(el) && !screenJoin(el)) noJoin.push(el);
    var d = readRole(el, 'digital');
    if (d.main && pressable(el)) {
      if (!byDigital.has(d.main.value)) byDigital.set(d.main.value, []);
      byDigital.get(d.main.value).push(el);
    }
  });
  byDigital.forEach(function (els, v) { if (els.length > 1) shared.push({ value: v, els: els }); });
  _diagCache = { multi: multi, shared: shared, legacy: legacy, invalid: invalid, noJoin: noJoin };
  _diagT = now;
  return _diagCache;
}
function fixMulti() {
  var d = diagnostics(true), touched = [];
  d.multi.forEach(function (m) { writeRole(m.el, m.role, m.keep.value); touched.push(m.el); });
  return touched;
}
function fixShared() {
  var d = diagnostics(true), touched = [], used = usedSet(), reserved = new Set();
  d.shared.forEach(function (s) {
    s.els.slice(1).forEach(function (el) {
      var v = nextFree(s.value, used, reserved); reserved.add(v);
      writeRole(el, 'digital', v); touched.push(el);
    });
  });
  return touched;
}
function fixScreenJoins() {
  var d = diagnostics(true), touched = [];
  d.noJoin.forEach(function (el) {
    var v = joinFromId(el);
    if (v && validJoin(v)) { writeRole(el, 'digital', v); touched.push(el); }
  });
  return touched;
}

/* ===================== РЕЕСТР / ВЫДЕЛЕНИЕ JOIN ===================== */
function registry() {
  var map = new Map();
  panelNodes().forEach(function (n) {
    JOIN_ATTRS.forEach(function (a) {
      var v = (n.getAttribute(a) || '').trim(); if (!v) return;
      var rec = map.get(v);
      if (!rec) { rec = { value: v, family: family(v), kinds: new Set(), attrs: new Set(), els: [] }; map.set(v, rec); }
      rec.kinds.add(ATTR_ROLE[a]); rec.attrs.add(a);
      if (rec.els.indexOf(n) < 0) rec.els.push(n);
    });
  });
  return map;
}
function usedSet() { var s = new Set(); registry().forEach(function (r, v) { s.add(v); }); return s; }
function nextFree(v, used, reserved) {
  var taken = function (x) { return used.has(x) || reserved.has(x); };
  if (isNum(v)) {
    var m = 0; used.forEach(function (x) { if (isNum(x)) m = Math.max(m, +x); });
    var n = Math.ceil((m + 1) / 10) * 10 || 100;
    while (taken(String(n))) n += 10;
    return String(n);
  }
  var parts = String(v).split(/([_.\-])/), idx = -1;
  for (var i = parts.length - 1; i >= 0; i--) if (/^\d+$/.test(parts[i])) { idx = i; break; }
  if (idx >= 0) {
    var base = parts.slice(), k = +parts[idx];
    for (var t = 0; t < 999; t++) { k++; base[idx] = String(k); var c = base.join(''); if (!taken(c)) return c; }
  }
  var s = 2; while (taken(v + '_' + s)) s++;
  return v + '_' + s;
}
function valuesIn(root) {
  var out = [];
  var push = function (n) {
    JOIN_ATTRS.forEach(function (a) { var v = (n.getAttribute(a) || '').trim(); if (v && out.indexOf(v) < 0) out.push(v); });
  };
  push(root); root.querySelectorAll('*').forEach(push);
  return out;
}
function allocMap(values) {
  var used = usedSet(), reserved = new Set(), map = new Map();
  if (values.length && values.every(isNum)) {
    var m = 0; used.forEach(function (x) { if (isNum(x)) m = Math.max(m, +x); });
    var off = Math.ceil((m + 1) / 10) * 10 || 100;
    values.forEach(function (v) { map.set(v, String(+v + off)); });
    return map;
  }
  values.forEach(function (v) { var c = nextFree(v, used, reserved); map.set(v, c); reserved.add(c); });
  return map;
}
function applyMap(root, map) {
  var n = 0;
  var fix = function (el) {
    JOIN_ATTRS.forEach(function (a) { var v = (el.getAttribute(a) || '').trim(); if (v && map.has(v)) { el.setAttribute(a, map.get(v)); n++; } });
  };
  fix(root); root.querySelectorAll('*').forEach(fix);
  invalidateDiag();
  return n;
}

/* ===================== СОСТОЯНИЕ ===================== */
var BAR_H = 44, DOCK_W = 356, UI_KEY = 'pe-ui-v44', LIB_KEY = 'pe-library-v2';
var PE = {
  on: false, sel: null, root: null, drag: null, raf: 0, undo: [], redo: [],
  tab: 'props', lib: [], dock: true, jq: '', jfam: 'all', jkind: 'all', migPrefix: 'panel', mig: null,
  bar: true, offset: true, margin: 12, autoHide: false, handlePos: 'center', scale: 1,
  boot: null, bootScreen: '', resetOnExport: true, bootReport: null, lastReset: 0,
  textNodes: [], autoLock: true, verify: null, verifying: false, badges: false, pageBadgesHidden: false,
  newJoinsOnCopy: true
};



PE.sels = [];
Object.defineProperty(PE, 'sel', {
  get: function () { return PE.sels[0] || null; },
  set: function (v) { PE.sels = v ? [v] : []; }
});
function isSelected(el) { return PE.sels.indexOf(el) >= 0; }
function toggleSelect(el) {
  if (!el) return;
  if (isScreenEl(el)) { PE.sels = [el]; placeOv(); renderAll(); return; }
  // Если до этого был выделен сам экран — сбрасываем его
  PE.sels = PE.sels.filter(function (n) { return !isScreenEl(n) && document.contains(n); });
  var idx = PE.sels.indexOf(el);
  if (idx >= 0) PE.sels.splice(idx, 1);
  else PE.sels.push(el);
  placeOv(); renderAll();
}



try {
  var saved = JSON.parse(localStorage.getItem(UI_KEY) || localStorage.getItem('pe-ui-v43') || localStorage.getItem('pe-ui-v4') || '{}');
  ['bar', 'offset', 'margin', 'autoHide', 'handlePos', 'dock', 'resetOnExport', 'autoLock'].forEach(function (k) {
    if (saved[k] !== undefined) PE[k] = saved[k];
  });
} catch (e) {}
function saveUI() {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({
      bar: PE.bar, offset: PE.offset, margin: PE.margin, autoHide: PE.autoHide,
      handlePos: PE.handlePos, dock: PE.dock, resetOnExport: PE.resetOnExport, autoLock: PE.autoLock, newJoinsOnCopy: PE.newJoinsOnCopy
    }));
  } catch (e) {}
}
function h(t, c, html) { var n = document.createElement(t); if (c) n.className = c; if (html != null) n.innerHTML = html; return n; }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function ui(n) { n.setAttribute('data-pe-ui', '1'); return n; }
function $(id) { return document.querySelector('[data-pe-ui] #' + id); }
function findRoot() {
  return document.querySelector('[data-panel-root]') || document.getElementById('panel-stage') ||
    document.getElementById('stage') || document.getElementById('app-viewport') || document.body;
}
function noteOf(el) {
  var tag = String(el.tagName || '').toLowerCase();
  var id = el.id ? '#' + el.id : '';
  var cls = String(el.className || '').split(/\s+/).filter(function (c) { return c && !/^pe-/.test(c); })[0];
  return tag + id + (cls ? '.' + cls : '');
}

/* ===================== ТЕКСТОВЫЕ УЗЛЫ ===================== */
function inSvgGraphic(n) { var s = n.closest && n.closest('svg'); return !!s && !/^(TEXT|TSPAN)$/.test(n.tagName || ''); }
function classOf(n) { return n.nodeType === 3 ? String((n.parentElement && n.parentElement.className) || '') : String(n.className || ''); }
function readText(t) { return t ? String(t.node.textContent || '') : ''; }
function textRank(t) {
  var n = t.node, cls = classOf(n), txt = readText(t).trim(), s = 0;
  var role = n.nodeType === 1 && n.getAttribute('data-role');
  if (role === 'label') s += 100;
  if (/\bav-label\b/.test(cls)) s += 90;
  if (LABEL_HINT.test(cls)) s += 60;
  if (BADGE_HINT.test(cls)) s -= 40;
  if (DECOR_HINT.test(cls)) s -= 80;
  if (/^\d+$/.test(txt)) s -= 30;
  if (txt.length >= 3) s += Math.min(20, txt.length);
  if (!txt) s -= 60;
  if (n.nodeType === 3) s += 25;
  return s;
}
function textCaption(t) {
  var n = t.node, cls = classOf(n);
  if (n.nodeType === 1 && n.getAttribute('data-role') === 'label') return 'Подпись';
  if (/\bav-label\b/.test(cls)) return 'Подпись';
  if (/(^|[-_ ])(num|number|idx|index|digit)([-_ ]|$)/i.test(cls)) return 'Номер';
  if (/(^|[-_ ])(name|title)([-_ ]|$)/i.test(cls)) return 'Название';
  if (/(^|[-_ ])(sub|desc|caption|hint|note)([-_ ]|$)/i.test(cls)) return 'Пояснение';
  if (/(^|[-_ ])(val|value|count)([-_ ]|$)/i.test(cls)) return 'Значение';
  return n.nodeType === 3 ? 'Текст' : 'Надпись';
}
function textTargets(el) {
  if (!el || el.nodeType !== 1) return [];
  var raw = [];
  var push = function (node) { if (node && !raw.some(function (t) { return t.node === node; })) raw.push({ node: node }); };
  if (el.getAttribute('data-role') === 'label') push(el);
  var lab = el.querySelector('[data-role="label"]'); if (lab) push(lab);
  var av = el.querySelector('.av-label'); if (av) push(av);
  Array.from(el.childNodes).forEach(function (n) { if (n.nodeType === 3 && n.textContent.trim()) push(n); });
  if (!el.children.length && !inSvgGraphic(el) && !el.matches(ICON_SEL)) push(el);
  Array.from(el.querySelectorAll('*')).forEach(function (c) {
    if (c.children.length || c.matches(ICON_SEL) || inSvgGraphic(c) || c.getAttribute('data-role') === 'label') return;
    push(c);
  });
  var out = raw.filter(function (t) {
    var txt = readText(t).trim();
    return txt ? true : (LABEL_HINT.test(classOf(t.node)) || (t.node.nodeType === 1 && t.node.getAttribute('data-role') === 'label'));
  });
  out.forEach(function (t) { t.rank = textRank(t); t.cap = textCaption(t); t.note = t.node.nodeType === 3 ? 'текст узла' : noteOf(t.node); });
  out.sort(function (a, b) { return b.rank - a.rank; });
  return out.slice(0, 8);
}
function labelHost(el, t) {
  var btn = el.hasAttribute('data-states') ? el : el.closest('[data-states]');
  if (!btn) return null;
  var lab = btn.querySelector('[data-role="label"]');
  if (!lab) return null;
  var node = t.node.nodeType === 3 ? t.node.parentElement : t.node;
  if (node !== lab) return null;
  return { btn: btn, idx: +(btn.getAttribute('data-state-index') || 0) };
}
function lockOwner(t) {
  if (!t) return null;
  var el = t.node.nodeType === 3 ? t.node.parentElement : t.node;
  if (!el || el.nodeType !== 1 || el.children.length) return null;
  if (el.hasAttribute('data-text-join') || el.hasAttribute('data-join-string')) return null;
  if (el.closest('[data-text-join]') || el.closest('[data-join-string]')) return null;
  return el;
}
function lockedList() { return panelNodes().filter(function (n) { return n.hasAttribute(LOCK_ATTR); }); }

/* ===================== ЭКРАНЫ / ДИАЛОГИ / ЗАСТАВКА ===================== */
function screenNodes(scope) {
  return Array.from(scope.querySelectorAll(SCREEN_SEL)).filter(function (n) {
    return !n.closest('[data-pe-ui]') && !n.hasAttribute('data-pe-ui');
  });
}
function isSaver(n) {
  return !!n && (n.hasAttribute('data-screensaver') || n.matches(SAVER_SEL) || SAVER_RE.test((n.id || '') + ' ' + (n.getAttribute('class') || '')));
}
function kindOf(n) {
  if (!n) return 'page';
  if (isSaver(n)) return 'saver';
  if (n.matches(PAGE_SEL)) return 'page';
  if (n.matches(DIALOG_SEL)) return 'dialog';
  return 'page';
}
function kindLabel(k) { return k === 'dialog' ? 'диалог' : k === 'saver' ? 'заставка' : 'страница'; }
function kindTag(k) { return k === 'dialog' ? 'DLG' : k === 'saver' ? 'SVR' : 'PAGE'; }
function isOverlay(n) { return kindOf(n) === 'dialog'; }
function hasActive(cls) { var l = String(cls || '').split(/\s+/); return ACTIVE_TOKENS.some(function (t) { return l.indexOf(t) >= 0; }); }
function isOn(n) { return kindOf(n) === 'saver' ? !n.classList.contains('is-hidden') : hasActive(n.getAttribute('class')); }
function nodeKey(n, i) {
  if (n.id) return 'id:' + n.id;
  var ds = n.getAttribute('data-screen') || n.getAttribute('data-dialog');
  return ds ? 'ds:' + ds + '#' + i : 'idx:' + i;
}
function screens() {
  var set = new Set();
  document.querySelectorAll(SCREEN_SEL).forEach(function (n) {
    if (!n.closest('[data-pe-ui]') && !n.hasAttribute('data-pe-ui')) set.add(n);
  });
  return Array.from(set);
}
function screensOfKind(k) { return screens().filter(function (n) { return kindOf(n) === k; }); }
function activateNode(n) {
  var k = kindOf(n);
  n.classList.remove('hidden', 'is-hidden');
  if (k === 'dialog') { n.classList.add('is-active'); if (n.classList.contains('overlay') || n.hasAttribute('data-drawer')) n.classList.add('is-open'); }
  else if (k === 'page') { n.classList.add('is-active'); if (n.classList.contains('page')) n.classList.add('active'); }
}
function deactivateNode(n) {
  var k = kindOf(n);
  ACTIVE_TOKENS.forEach(function (t) { n.classList.remove(t); });
  if (k === 'saver') n.classList.add('is-hidden');
  else if (n.hasAttribute('data-screen')) n.classList.add('hidden');
}
function showScreen(el, alsoSelect) {
  if (!el) return;
  var k = kindOf(el), all = screens();
  if (k === 'page') {
    if (window.Panel && typeof window.Panel.showPage === 'function' && el.id) { try { window.Panel.showPage(el.id); } catch (e) {} }
    all.forEach(function (s) { if (s !== el && kindOf(s) !== 'saver') deactivateNode(s); });
    activateNode(el);
  } else if (k === 'dialog') {
    all.forEach(function (s) { if (s !== el && kindOf(s) === 'dialog') deactivateNode(s); });
    if (!all.some(function (s) { return kindOf(s) === 'page' && isOn(s); })) {
      var first = screensOfKind('page')[0]; if (first) activateNode(first);
    }
    if (window.Panel && typeof window.Panel.openDialog === 'function' && el.id) { try { window.Panel.openDialog(el.id); } catch (e) {} }
    activateNode(el);
  } else {
    all.forEach(function (s) { if (kindOf(s) === 'dialog') deactivateNode(s); });
    activateNode(el);
  }
  softRebind(); applyLayout(); fillScreens(); placeOv(); syncActiveChip();
  setTimeout(paintBadges, 320);
  if (alsoSelect) { select(el); }
  toast('info', kindLabel(k) + ' ' + screenId(el) + ' · D ' + (screenJoin(el) || '—'));
}
function activeScreen() {
  var list = screens(), act = list.filter(isOn);
  var dlg = act.filter(function (n) { return kindOf(n) === 'dialog'; });
  if (dlg.length) return dlg[dlg.length - 1];
  var sv = act.filter(function (n) { return kindOf(n) === 'saver'; });
  if (sv.length) return sv[sv.length - 1];
  var pg = act.filter(function (n) { return kindOf(n) === 'page'; });
  if (pg.length) return pg[pg.length - 1];
  return act[act.length - 1] || list[0] || null;
}
function fillScreens() {
  var s = $('pe-screen'); if (!s) return;
  var list = screens(), groups = { page: [], dialog: [], saver: [] };
  list.forEach(function (n, i) { groups[kindOf(n)].push({ n: n, i: i }); });
  var block = function (key, title) {
    if (!groups[key].length) return '';
    return '<optgroup label="' + esc(title + ' · ' + groups[key].length) + '">' +
      groups[key].map(function (r) {
        var j = screenJoin(r.n);
        var name = screenId(r.n) || (kindLabel(key) + ' ' + (r.i + 1));
        return '<option value="' + r.i + '"' + (isOn(r.n) ? ' selected' : '') + '>' +
          esc(name) + (j ? '  ·  D ' + esc(j) : '  ·  D —') + (isOn(r.n) ? ' •' : '') + '</option>';
      }).join('') + '</optgroup>';
  };
  s.innerHTML = block('page', 'Страницы') + block('dialog', 'Диалоги') + block('saver', 'Заставка');
  var cur = activeScreen();
  if (cur) s.value = String(list.indexOf(cur));
  var chip = $('pe-sstat');
  if (chip) chip.innerHTML = 'экраны <b>' + groups.page.length + '</b> · диалоги <b>' + groups.dialog.length + '</b>';
  syncActiveChip();
}
function syncActiveChip() {
  var chip = $('pe-ajoin'); if (!chip) return;
  var el = activeScreen();
  if (!el) { chip.innerHTML = '▣ <b>нет экрана</b>'; chip.title = ''; return; }
  var j = screenJoin(el), id = screenId(el);
  chip.innerHTML = '▣ ' + esc(id) + ' · <b>D ' + esc(j || '—') + '</b>';
  chip.title = kindLabel(kindOf(el)) + ' ' + id + '\ndata-join-digital = ' + (j || 'нет') + '\nКлик — выделить экран (S)';
  chip.classList.toggle('hot', !j);
}
function selectActiveScreen() {
  var el = activeScreen();
  if (!el) { toast('warn', 'Активный экран не найден'); return; }
  if (!PE.on) setEdit(true);
  select(el); setTab('props');
  toast('ok', kindLabel(kindOf(el)) + ' ' + screenId(el) + ' · D ' + (screenJoin(el) || '—'));
}

/* ===================== СНИМОК ПЕРВОГО КАДРА ===================== */
function captureBoot(force) {
  var root = PE.root || findRoot(), list = screenNodes(root), old = {};
  (PE.boot || []).forEach(function (r) { old[r.key] = r; });
  PE.boot = list.map(function (n, i) {
    var key = nodeKey(n, i), prev = (!force && old[key]) ? old[key] : null;
    return { key: key, cls: prev ? prev.cls : (n.getAttribute('class') || ''), id: n.id || '',
      ds: n.getAttribute('data-screen') || n.getAttribute('data-dialog') || '',
      saver: isSaver(n), overlay: isOverlay(n), kind: kindOf(n) };
  });
  if (force) PE.bootScreen = '';
  return PE.boot.length;
}
function bootOptions() { return (PE.boot || []).filter(function (r) { return !r.overlay; }); }
function clsList(el) { return (el.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
function setCls(el, list) { var s = list.filter(Boolean).join(' '); if (s) el.setAttribute('class', s); else el.removeAttribute('class'); }
function stripActive(el) { setCls(el, clsList(el).filter(function (c) { return ACTIVE_TOKENS.indexOf(c) < 0; })); }
function hideSaver(el) { var l = clsList(el).filter(function (c) { return c !== 'is-hidden' && ACTIVE_TOKENS.indexOf(c) < 0; }); l.push('is-hidden'); setCls(el, l); }
function showSaver(el) { setCls(el, clsList(el).filter(function (c) { return c !== 'is-hidden'; })); }
function activatePageEl(el) {
  var l = clsList(el).filter(function (c) { return c !== 'hidden' && ACTIVE_TOKENS.indexOf(c) < 0; });
  l.push('is-active'); if (el.classList.contains('page')) l.push('active'); setCls(el, l);
}
function deactivatePageEl(el) {
  var l = clsList(el).filter(function (c) { return ACTIVE_TOKENS.indexOf(c) < 0; });
  if (el.hasAttribute('data-screen') && !el.classList.contains('av-page')) l.push('hidden');
  setCls(el, l);
}
function normalizeBoot(d) {
  if (!PE.resetOnExport) return 0;
  var changed = 0;
  if (PE.boot && PE.boot.length) {
    var list = screenNodes(d), map = {};
    PE.boot.forEach(function (r) { map[r.key] = r; });
    var pairs = list.map(function (el, i) { return { el: el, rec: map[nodeKey(el, i)] }; }).filter(function (p) { return p.rec; });
    pairs.forEach(function (p) {
      if ((p.el.getAttribute('class') || '') !== p.rec.cls) { p.el.setAttribute('class', p.rec.cls); changed++; }
    });
    var savers = pairs.filter(function (p) { return p.rec.saver; });
    var dialogs = pairs.filter(function (p) { return p.rec.overlay; });
    var pages = pairs.filter(function (p) { return !p.rec.saver && !p.rec.overlay; });
    if (PE.bootScreen) {
      var target = pairs.filter(function (p) { return p.rec.id === PE.bootScreen || p.rec.ds === PE.bootScreen; })[0];
      if (target && target.rec.saver) {
        savers.forEach(function (p) { showSaver(p.el); changed++; });
        dialogs.forEach(function (p) { stripActive(p.el); changed++; });
      } else if (target) {
        savers.forEach(function (p) { hideSaver(p.el); changed++; });
        dialogs.forEach(function (p) { stripActive(p.el); changed++; });
        pages.forEach(function (p) { if (p === target) activatePageEl(p.el); else deactivatePageEl(p.el); changed++; });
      }
    }
  }
  Array.from(d.querySelectorAll('*')).forEach(function (n) {
    if (n.closest('[data-pe-ui]') || !n.classList) return;
    var hit = TRANSIENT_CLASSES.filter(function (c) { return n.classList.contains(c); });
    if (!hit.length) return;
    hit.forEach(function (c) { n.classList.remove(c); });
    if (!n.getAttribute('class')) n.removeAttribute('class');
    changed++;
  });
  return changed;
}
function inspectFirstFrame() {
  var d = new DOMParser().parseFromString(cleanDocument(), 'text/html');
  var list = screenNodes(d);
  var act = list.filter(function (n) { return hasActive(n.getAttribute('class')); })
    .map(function (n) { return n.id || n.getAttribute('data-screen') || n.tagName.toLowerCase(); });
  var saver = list.filter(isSaver)[0];
  PE.bootReport = { active: act, saver: saver ? !saver.classList.contains('is-hidden') : null,
    total: list.length, dialogs: list.filter(isOverlay).length };
  return PE.bootReport;
}

/* ===================== СТИЛИ ===================== */
var CSS = `:root{--pe-bg0:#070D16;--pe-bg1:#0A1420;--pe-bg2:#0E1C2C;--pe-surf:#122336;--pe-surf2:#17293E;--pe-line:#22405C;--pe-line2:#2E5375;--pe-txt:#E9F1F8;--pe-mut:#8CA3B8;--pe-dim:#5D7690;--pe-grn:#12B981;--pe-cyn:#22D3EE;--pe-blu:#3E8BFF;--pe-vio:#8B5CF6;--pe-amb:#F5A623;--pe-red:#F0455A;--pe-grad:linear-gradient(135deg,#12B981 0%,#22D3EE 55%,#3E8BFF 100%);--pe-bar-h:44px}
[data-pe-ui]{font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;box-sizing:border-box}
[data-pe-ui] *{box-sizing:border-box}
#pe-bar{position:fixed;top:0;left:0;right:0;height:44px;z-index:2147483100;display:flex;align-items:center;gap:8px;padding:0 12px;color:var(--pe-txt);background:linear-gradient(180deg,var(--pe-surf2),var(--pe-bg2));border-bottom:1px solid var(--pe-line);box-shadow:0 6px 22px -14px #000;transition:transform .24s cubic-bezier(.3,1,.4,1),opacity .2s}
#pe-bar.pe-hidden{transform:translateY(-100%);opacity:0;pointer-events:none}
#pe-bar .brand{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:800;white-space:nowrap;flex:none}
#pe-bar .brand i{width:8px;height:8px;border-radius:99px;background:var(--pe-grad);box-shadow:0 0 9px var(--pe-cyn)}
#pe-bar .sp{flex:1;min-width:4px}
.pe-acts{display:flex;align-items:center;gap:6px;min-width:0;overflow-x:auto;scrollbar-width:none}
.pe-acts::-webkit-scrollbar{display:none}
#pe-handle{position:fixed;top:0;z-index:2147483101;height:20px;padding:0 12px;display:none;align-items:center;gap:6px;cursor:pointer;color:#04241A;background:var(--pe-grad);border:0;border-radius:0 0 9px 9px;font-family:inherit;font-size:10.5px;font-weight:800}
#pe-handle.on{display:flex}
#pe-handle.pe-left{left:14px}#pe-handle.pe-center{left:50%;transform:translateX(-50%)}#pe-handle.pe-right{right:14px}
.pe-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 10px;border-radius:8px;border:1px solid var(--pe-line2);cursor:pointer;white-space:nowrap;flex:none;background:linear-gradient(180deg,var(--pe-surf2),var(--pe-surf));color:var(--pe-txt);font-size:11.5px;font-weight:700;font-family:inherit;transition:transform .1s,filter .15s}
.pe-btn:hover{filter:brightness(1.18)}.pe-btn:active{transform:scale(.95)}
.pe-btn.pri{background:var(--pe-grad);border-color:transparent;color:#04241A}
.pe-btn.dgr{background:linear-gradient(135deg,#E23B52,#F0455A);border-color:transparent;color:#fff}
.pe-btn.vio{background:rgba(139,92,246,.16);border-color:rgba(139,92,246,.6);color:#C9B4FA}
.pe-btn.amb{background:rgba(245,166,35,.16);border-color:rgba(245,166,35,.6);color:#F8CD7E}
.pe-btn.on{background:rgba(18,185,129,.2);border-color:rgba(18,185,129,.75);color:#9FEED4}
.pe-btn.sm{height:23px;padding:0 7px;font-size:10.5px;border-radius:6px}
.pe-btn.xs{height:20px;padding:0 6px;font-size:9.5px;border-radius:5px}
.pe-btn.ico{width:28px;padding:0}
.pe-btn[disabled]{opacity:.35;pointer-events:none}
.pe-chip{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:99px;flex:none;border:1px solid var(--pe-line);background:rgba(13,26,41,.6);font-size:10.5px;font-weight:700;color:var(--pe-mut);white-space:nowrap}
.pe-chip b{color:var(--pe-cyn)}
.pe-chip.hot{border-color:rgba(240,69,90,.65);color:#FFC2CB}
.pe-chip.act{cursor:pointer;max-width:330px;overflow:hidden;text-overflow:ellipsis;border-color:rgba(34,211,238,.5)}
.pe-chip.act:hover{filter:brightness(1.2)}
.pe-sel,.pe-inp,.pe-ta{border-radius:7px;border:1px solid var(--pe-line2);background:var(--pe-bg0);color:var(--pe-txt);font-size:11.5px;font-weight:600;padding:0 7px;height:26px;font-family:inherit;min-width:0}
.pe-sel optgroup{background:var(--pe-bg2);color:var(--pe-cyn);font-style:normal;font-weight:800}
.pe-sel option{background:var(--pe-bg0);color:var(--pe-txt)}
.pe-ta{height:auto;padding:7px;font-family:"JetBrains Mono",ui-monospace,monospace;font-size:10.5px;line-height:1.5;resize:vertical;width:100%}
.pe-inp.mono{font-family:"JetBrains Mono",ui-monospace,monospace}
.pe-inp.bad{border-color:var(--pe-red);box-shadow:0 0 0 1px rgba(240,69,90,.4)}
.pe-inp.wide{flex:1;width:auto}
.pe-sel:focus,.pe-inp:focus,.pe-ta:focus{outline:2px solid var(--pe-cyn);outline-offset:1px}
input[type=range].pe-range{-webkit-appearance:none;appearance:none;width:96px;height:20px;background:none;cursor:pointer;margin:0}
input[type=range].pe-range::-webkit-slider-runnable-track{height:6px;border-radius:99px;border:1px solid var(--pe-line);background:linear-gradient(90deg,var(--pe-grn) 0%,var(--pe-cyn) var(--p,40%),var(--pe-bg0) var(--p,40%))}
input[type=range].pe-range::-webkit-slider-thumb{-webkit-appearance:none;width:15px;height:15px;margin-top:-5.5px;border-radius:99px;background:#EAF6FF;border:3px solid var(--pe-grn)}
input[type=range].pe-range::-moz-range-track{height:6px;border-radius:99px;background:var(--pe-bg0);border:1px solid var(--pe-line)}
input[type=range].pe-range::-moz-range-progress{height:6px;border-radius:99px;background:linear-gradient(90deg,var(--pe-grn),var(--pe-cyn))}
input[type=range].pe-range::-moz-range-thumb{width:11px;height:11px;border-radius:99px;background:#EAF6FF;border:3px solid var(--pe-grn)}
.pe-sw{width:34px;height:19px;border-radius:99px;background:var(--pe-bg0);border:1px solid var(--pe-line2);position:relative;cursor:pointer;flex:none;transition:.18s}
.pe-sw i{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:99px;background:var(--pe-dim);transition:.18s cubic-bezier(.4,1.5,.5,1)}
.pe-sw.on{background:rgba(18,185,129,.22);border-color:rgba(18,185,129,.7)}
.pe-sw.on i{left:17px;background:var(--pe-grad)}
#pe-dock{position:fixed;top:var(--pe-bar-h);right:0;bottom:0;width:356px;z-index:2147483099;display:flex;flex-direction:column;color:var(--pe-txt);background:linear-gradient(180deg,var(--pe-bg2),var(--pe-bg1));border-left:1px solid var(--pe-line2);box-shadow:-24px 0 60px -30px #000;transform:translateX(102%);transition:transform .24s cubic-bezier(.3,1,.4,1),top .24s}
#pe-dock.on{transform:none}
.pe-tabs{display:flex;gap:2px;padding:6px;border-bottom:1px solid var(--pe-line)}
.pe-tab{flex:1;height:27px;border-radius:7px;border:1px solid transparent;background:none;cursor:pointer;color:var(--pe-dim);font-size:10px;font-weight:800;font-family:inherit}
.pe-tab:hover{color:var(--pe-txt);background:rgba(34,64,92,.3)}
.pe-tab.on{background:var(--pe-grad);color:#04241A}
.pe-panes{flex:1;min-height:0;position:relative}
.pe-pane{position:absolute;inset:0;overflow-y:auto;padding:10px;display:none}
.pe-pane.on{display:block}
.pe-pane,.pe-ta{scrollbar-width:thin;scrollbar-color:var(--pe-grn) var(--pe-bg0)}
.pe-pane::-webkit-scrollbar,.pe-ta::-webkit-scrollbar{width:9px;height:9px}
.pe-pane::-webkit-scrollbar-track,.pe-ta::-webkit-scrollbar-track{background:var(--pe-bg0);border-radius:99px}
.pe-pane::-webkit-scrollbar-thumb,.pe-ta::-webkit-scrollbar-thumb{background:linear-gradient(180deg,var(--pe-grn),var(--pe-cyn));border-radius:99px;border:2px solid var(--pe-bg0)}
.pe-grp{margin-bottom:11px;border:1px solid var(--pe-line);border-radius:11px;background:var(--pe-surf);overflow:hidden}
.pe-grp>h4{margin:0;padding:7px 10px;font-size:9.5px;font-weight:800;letter-spacing:.13em;text-transform:uppercase;color:var(--pe-dim);background:rgba(13,26,41,.45);border-bottom:1px solid var(--pe-line);display:flex;gap:6px;align-items:center}
.pe-grp>h4 em{margin-left:auto;font-style:normal;color:var(--pe-cyn);letter-spacing:0}
.pe-grp>div{padding:9px 10px;display:flex;flex-direction:column;gap:8px}
.pe-row{display:flex;align-items:center;gap:7px}
.pe-row label{flex:1;font-size:11px;font-weight:600;color:var(--pe-mut);min-width:0}
.pe-row .pe-inp,.pe-row .pe-sel{width:132px}
.pe-row .pe-inp.wide{width:auto}
.pe-jbox{border:1px solid var(--pe-line);border-radius:9px;background:var(--pe-surf2);padding:7px 8px;display:flex;flex-direction:column;gap:5px}
.pe-jbox.warn{border-color:rgba(245,166,35,.6)}
.pe-jhead{display:flex;align-items:center;gap:6px;font-size:10px;font-weight:800;color:var(--pe-txt)}
.pe-jhead code{margin-left:auto;font-family:"JetBrains Mono",monospace;font-size:8.5px;font-weight:600;color:var(--pe-dim)}
.pe-alias{font-family:"JetBrains Mono",monospace;font-size:9px;color:#F8CD7E;line-height:1.45;word-break:break-all}
.pe-owner{border:1px solid rgba(34,211,238,.45);border-radius:9px;background:rgba(34,211,238,.07);padding:7px 8px;display:flex;flex-direction:column;gap:5px}
.pe-owner .pe-jname{font-size:11.5px;color:#9BE9F7}
.pe-txt-row{display:flex;flex-direction:column;gap:5px;padding:7px 8px;border:1px solid var(--pe-line);border-radius:9px;background:var(--pe-surf2)}
.pe-txt-row.locked{border-color:rgba(18,185,129,.5)}
.pe-txt-head{display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:800;color:var(--pe-txt)}
.pe-txt-head code{font-family:"JetBrains Mono",monospace;font-size:9px;font-weight:600;color:var(--pe-dim);margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:130px}
.pe-txt-head i{width:7px;height:7px;border-radius:99px;background:var(--pe-cyn);flex:none;font-style:normal}
.pe-txt-head i.sec{background:var(--pe-dim)}
.pe-lockrow{display:flex;align-items:center;gap:6px}
.pe-lockrow span{flex:1;font-size:9.5px;font-weight:700;color:var(--pe-dim)}
.pe-note{font-size:10px;line-height:1.5;color:var(--pe-dim)}
.pe-note code{font-family:"JetBrains Mono",monospace;color:var(--pe-mut)}
.pe-note b{color:var(--pe-cyn)}
.pe-stat{font-family:"JetBrains Mono",monospace;font-size:10px;padding:7px 9px;border-radius:8px;background:var(--pe-bg0);border:1px solid var(--pe-line);color:var(--pe-mut);word-break:break-word;line-height:1.5}
.pe-stat.ok{border-color:rgba(18,185,129,.55);color:#9FEED4}
.pe-stat.warn{border-color:rgba(245,166,35,.6);color:#F8CD7E}
.pe-stat.err{border-color:rgba(240,69,90,.6);color:#FFC2CB}
.pe-st{border:1px solid var(--pe-line);border-radius:9px;background:var(--pe-surf2);padding:8px;display:flex;flex-direction:column;gap:6px}
.pe-st-h{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:800}
.pe-st-h i{width:16px;height:16px;border-radius:5px;background:var(--pe-bg0);border:1px solid var(--pe-line2);display:flex;align-items:center;justify-content:center;font-size:9px;font-style:normal;color:var(--pe-cyn)}
.pe-thumb{width:32px;height:32px;border-radius:7px;border:1px solid var(--pe-line2);background:var(--pe-bg0);display:flex;align-items:center;justify-content:center;overflow:hidden;flex:none;margin-left:auto}
.pe-thumb img,.pe-thumb svg{max-width:100%;max-height:100%;display:block}
.pe-jrow{border:1px solid var(--pe-line);border-radius:9px;background:var(--pe-surf2);padding:7px 8px;display:flex;flex-direction:column;gap:6px}
.pe-jrow.bad{border-color:rgba(240,69,90,.6)}
.pe-jrow.dup{border-color:rgba(245,166,35,.65)}
.pe-jname{flex:1;min-width:0;font-family:"JetBrains Mono",monospace;font-size:11px;font-weight:700;overflow:hidden;text-overflow:ellipsis}
.pe-tag{font-family:"JetBrains Mono",monospace;font-size:8.5px;font-weight:800;padding:2px 5px;border-radius:5px;flex:none}
.pe-tag.num{background:rgba(245,166,35,.18);color:#F8CD7E}
.pe-tag.name{background:rgba(18,185,129,.18);color:#8FE8C8}
.pe-tag.dlg{background:rgba(139,92,246,.2);color:#C9B4FA}
.pe-tag.pg{background:rgba(62,139,255,.2);color:#A9CBFF}
.pe-tag.sv{background:rgba(34,211,238,.2);color:#9BE9F7}
.pe-kind{font-size:9px;font-weight:700;color:var(--pe-dim);font-family:"JetBrains Mono",monospace}
.pe-lib{display:flex;align-items:center;gap:7px;padding:7px 8px;border-radius:9px;border:1px solid var(--pe-line);background:var(--pe-surf2)}
.pe-lib b{flex:1;min-width:0;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pe-empty{padding:18px 8px;text-align:center;font-size:11px;color:var(--pe-dim)}
.pe-scrlist{display:flex;flex-direction:column;gap:5px}
.pe-scrrow{display:flex;flex-direction:column;gap:5px;padding:6px 7px;border-radius:8px;border:1px solid var(--pe-line);background:var(--pe-surf2)}
.pe-scrrow.on{border-color:rgba(18,185,129,.6)}
.pe-scrrow.sel{border-color:var(--pe-cyn);box-shadow:0 0 0 1px rgba(34,211,238,.35)}
.pe-scrhead{display:flex;align-items:center;gap:6px}
.pe-scrhead b{flex:1;min-width:0;font-size:10.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pe-scrjoin{display:flex;align-items:center;gap:5px}
.pe-scrjoin .pe-kind{flex:none}
.pe-scrjoin code{flex:1;min-width:0;font-family:"JetBrains Mono",monospace;font-size:10px;color:#8FE8C8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#pe-ov{position:fixed;z-index:2147483090;pointer-events:none;display:none}
#pe-ov.on{display:block}
.pe-guide-v{position:fixed;top:0;bottom:0;width:1px;background:#F0455A;box-shadow:0 0 4px rgba(240,69,90,.8)}
.pe-guide-h{position:fixed;left:0;right:0;height:1px;background:#F0455A;box-shadow:0 0 4px rgba(240,69,90,.8)}
.pe-sub-ov{position:fixed;z-index:2147483088;pointer-events:none;border:1.5px dashed #34D399;border-radius:3px;background:rgba(52,211,153,.06)}
#pe-lasso{position:fixed;z-index:2147483095;pointer-events:none;border:1.5px solid var(--pe-cyn);background:rgba(34,211,238,.12);display:none}
#pe-lasso.on{display:block}
.pe-align-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}

.pe-badge.H{background:#94A3B8}
body.pe-editing [data-vis-hidden]{display:revert!important;opacity:.35!important;outline:1px dashed #94A3B8}

#pe-ov .frame{position:absolute;inset:0;border:2px solid var(--pe-cyn);border-radius:3px;box-shadow:0 0 0 1px rgba(4,10,18,.6),0 0 18px -4px rgba(34,211,238,.8);pointer-events:auto;cursor:move}
#pe-ov .tag{position:absolute;left:-2px;top:-22px;height:20px;padding:0 7px;border-radius:6px 6px 0 0;background:var(--pe-cyn);color:#04241A;font-size:10px;font-weight:800;display:flex;align-items:center;white-space:nowrap}
#pe-ov .hd{position:absolute;width:11px;height:11px;background:#EAF6FF;border:2px solid var(--pe-grn);border-radius:3px;pointer-events:auto}
#pe-ov .hd[data-d="nw"]{left:-6px;top:-6px;cursor:nwse-resize}
#pe-ov .hd[data-d="n"]{left:calc(50% - 5px);top:-6px;cursor:ns-resize}
#pe-ov .hd[data-d="ne"]{right:-6px;top:-6px;cursor:nesw-resize}
#pe-ov .hd[data-d="e"]{right:-6px;top:calc(50% - 5px);cursor:ew-resize}
#pe-ov .hd[data-d="se"]{right:-6px;bottom:-6px;cursor:nwse-resize}
#pe-ov .hd[data-d="s"]{left:calc(50% - 5px);bottom:-6px;cursor:ns-resize}
#pe-ov .hd[data-d="sw"]{left:-6px;bottom:-6px;cursor:nesw-resize}
#pe-ov .hd[data-d="w"]{left:-6px;top:calc(50% - 5px);cursor:ew-resize}
#pe-badges{position:fixed;inset:0;z-index:2147483080;pointer-events:none;display:none}
#pe-badges.on{display:block}
.pe-badge{position:absolute;pointer-events:auto;cursor:pointer;max-width:230px;padding:1px 6px;border-radius:6px;font-family:"JetBrains Mono",monospace;font-size:9.5px;font-weight:800;color:#06121E;line-height:1.55;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 7px rgba(0,0,0,.55);border:1px solid rgba(6,18,30,.35)}
.pe-badge.D{background:#34D399}.pe-badge.A{background:#38BDF8}.pe-badge.S{background:#E879F9}
.pe-badge.P{background:#F0ABFC}.pe-badge.T{background:#A78BFA}.pe-badge.M{background:#FB7185}
.pe-badge.R{background:#FBBF24}.pe-badge.V{background:#FB923C}.pe-badge.W{background:#FDE68A}
.pe-badge.dup{outline:2px solid #F0455A;outline-offset:1px}
#pe-toasts{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483200;display:flex;flex-direction:column-reverse;gap:7px;align-items:center;pointer-events:none}
.pe-toast{display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:10px;max-width:620px;background:rgba(10,20,32,.97);border:1px solid var(--pe-line2);color:#E9F1F8;font-size:12px;font-weight:700;box-shadow:0 16px 36px -14px #000;opacity:0;transform:translateY(8px) scale(.96);transition:.22s cubic-bezier(.3,1.3,.5,1)}
.pe-toast.on{opacity:1;transform:none}
.pe-toast i{width:7px;height:7px;border-radius:99px;flex:none}
.pe-toast.ok{border-color:rgba(18,185,129,.65)}.pe-toast.ok i{background:var(--pe-grn)}
.pe-toast.info{border-color:rgba(62,139,255,.6)}.pe-toast.info i{background:var(--pe-blu)}
.pe-toast.warn{border-color:rgba(245,166,35,.65)}.pe-toast.warn i{background:var(--pe-amb)}
.pe-toast.err{border-color:rgba(240,69,90,.7)}.pe-toast.err i{background:var(--pe-red)}
@media (prefers-reduced-motion:reduce){#pe-dock,#pe-bar,.pe-toast{transition:none!important}}`;
var styleEl = document.createElement('style');
styleEl.id = 'pe-css'; styleEl.setAttribute('data-pe-ui', '1'); styleEl.textContent = CSS;
document.head.appendChild(styleEl);
var layoutStyle = document.createElement('style');
layoutStyle.id = 'pe-layout'; layoutStyle.setAttribute('data-pe-ui', '1');
document.head.appendChild(layoutStyle);

/* ===================== ТОСТЫ ===================== */
var toasts = ui(h('div')); toasts.id = 'pe-toasts'; document.body.appendChild(toasts);
function toast(kind, msg) {
  var n = ui(h('div', 'pe-toast ' + kind, '<i></i><span>' + esc(msg) + '</span>'));
  toasts.appendChild(n);
  requestAnimationFrame(function () { n.classList.add('on'); });
  while (toasts.children.length > 3) toasts.firstChild.remove();
  setTimeout(function () { n.classList.remove('on'); setTimeout(function () { n.remove(); }, 260); }, 3600);
}

/* ===================== ОТСТУП ХОЛСТА ===================== */
function layoutCenter(el) {
  var x = 0, y = 0, n = el, guard = 0;
  while (n && guard++ < 40) { x += n.offsetLeft || 0; y += n.offsetTop || 0; n = n.offsetParent; }
  return { x: x + el.offsetWidth / 2, y: y + el.offsetHeight / 2 };
}
function applyLayout() {
  document.documentElement.style.setProperty('--pe-bar-h', (PE.bar ? BAR_H : 0) + 'px');
  PE.root = PE.root && document.contains(PE.root) ? PE.root : findRoot();
  var root = PE.root, chip = $('pe-scale');
  if (!PE.offset || !root || root === document.body || root === document.documentElement) {
    layoutStyle.textContent = ''; PE.scale = 1;
    if (chip) chip.innerHTML = 'масштаб <b>панели</b>';
    return;
  }
  var w = root.offsetWidth, hgt = root.offsetHeight;
  if (!w || !hgt) { layoutStyle.textContent = ''; return; }
  try { root.setAttribute('data-pe-root', '1'); } catch (e) {}
  layoutStyle.textContent = '[data-pe-root]{left:0 !important;top:0 !important;margin:0 !important;}';
  var dockW = (PE.dock && PE.on) ? DOCK_W : 0, top = PE.bar ? BAR_H : 0, m = PE.margin;
  var k = Math.min(Math.max(160, window.innerWidth - dockW - m * 2) / w, Math.max(120, window.innerHeight - top - m * 2) / hgt);
  var lc = layoutCenter(root);
  var tx = (window.innerWidth - dockW) / 2 - lc.x, ty = top + (window.innerHeight - top) / 2 - lc.y;
  layoutStyle.textContent = '[data-pe-root]{left:0 !important;top:0 !important;margin:0 !important;transform:translate(' + tx.toFixed(2) + 'px,' + ty.toFixed(2) +
    'px) scale(' + k.toFixed(4) + ') !important;transform-origin:center center !important;}';
  PE.scale = k;
  if (chip) chip.innerHTML = 'масштаб <b>' + Math.round(k * 100) + '%</b>';
}


/* ===================== СЕРИАЛИЗАЦИЯ ===================== */
function cleanNode(n) {
  if (n.nodeType !== 1) return;
  if (n.hasAttribute('data-pe-ui') || n.id === 'pe-css' || n.id === 'pe-layout' || n.id === 'pe-script') { n.remove(); return; }
  if (n.tagName === 'SCRIPT' && /panel-editor\.js/.test(n.getAttribute('src') || '')) { n.remove(); return; }
  Array.from(n.attributes).forEach(function (a) {
    if (/^data-pe-/.test(a.name) || a.name === 'contenteditable') n.removeAttribute(a.name);
  });
  if (n.classList) {
    Array.from(n.classList).forEach(function (c) { if (/^pe-/.test(c)) n.classList.remove(c); });
    if (!n.getAttribute('class')) n.removeAttribute('class');
  }
  Array.from(n.children).forEach(cleanNode);
}
function cleanElementHTML(el) {
  syncLiveFields(el);
  var c = el.cloneNode(true);
  Array.from(c.querySelectorAll('[data-pe-ui]')).forEach(function (n) { n.remove(); });
  cleanNode(c);
  TRANSIENT_CLASSES.forEach(function (t) { c.classList.remove(t); });
  Array.from(c.querySelectorAll('*')).forEach(function (n) {
    if (!n.classList) return;
    TRANSIENT_CLASSES.forEach(function (t) { n.classList.remove(t); });
    if (!n.getAttribute('class')) n.removeAttribute('class');
  });
  if (!c.getAttribute('class')) c.removeAttribute('class');
  return c.outerHTML;
}


function bakeElementHTML(el) {
  if (!el || !el.isConnected) return cleanElementHTML(el);
  syncLiveFields(el);
  var clone = el.cloneNode(true);
  var origList = [el].concat(Array.from(el.querySelectorAll('*')));
  var cloneList = [clone].concat(Array.from(clone.querySelectorAll('*')));

  var PROPS = [
    'display', 'flexDirection', 'flexWrap', 'alignItems', 'justifyContent', 'gap',
    'boxSizing', 'width', 'height', 'minWidth', 'minHeight', 'padding', 'borderRadius',
    'color', 'background', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft',
    'boxShadow', 'opacity', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight',
    'letterSpacing', 'textAlign', 'textTransform', 'whiteSpace', 'cursor'
  ];

  for (var i = 0; i < origList.length; i++) {
    var orig = origList[i], cln = cloneList[i];
    if (!orig || !cln || orig.nodeType !== 1) continue;
    /* Внутренности SVG (path, rect, circle) не трогаем */
    if (orig.closest('svg') && orig.tagName.toLowerCase() !== 'svg') continue;

    var cs = getComputedStyle(orig);
    PROPS.forEach(function (p) {
      if (!cln.style[p] && cs[p]) cln.style[p] = cs[p];
    });

    /* Сохраняем динамическую смену цветов для многосостоянийных кнопок */
    if (orig.hasAttribute('data-states')) {
      cln.style.borderColor = 'color-mix(in srgb, var(--st-c, #22D3EE) 55%, transparent)';
      cln.style.background = 'linear-gradient(180deg, var(--st-bg, rgba(34,211,238,.10)), rgba(13,26,41,.7))';
      cln.style.boxShadow = '0 0 22px -12px var(--st-c, #22D3EE), inset 0 1px 0 rgba(255,255,255,.05)';
    }
    if (orig.getAttribute('data-role') === 'icon') {
      cln.style.color = 'var(--st-c, #22D3EE)';
      cln.style.flex = 'none';
    }
    if (orig.getAttribute('data-role') === 'label') {
      cln.style.flex = '1';
    }
  }

  Array.from(clone.querySelectorAll('[data-pe-ui]')).forEach(function (n) { n.remove(); });
  cleanNode(clone);
  TRANSIENT_CLASSES.forEach(function (t) { clone.classList.remove(t); });
  Array.from(clone.querySelectorAll('*')).forEach(function (n) {
    if (!n.classList) return;
    TRANSIENT_CLASSES.forEach(function (t) { n.classList.remove(t); });
    if (!n.getAttribute('class')) n.removeAttribute('class');
  });
  if (!clone.getAttribute('class')) clone.removeAttribute('class');
  return clone.outerHTML;
}



function cleanDocument(forVerify) {
  syncLiveFields(document.body);
  var d = document.documentElement.cloneNode(true);
  Array.from(d.querySelectorAll('[data-pe-ui]')).forEach(function (n) { n.remove(); });
  cleanNode(d);
  var b = d.querySelector('body'); if (b) b.classList.remove('pe-editing');
  var r = d.querySelector('[data-pe-root]'); if (r) r.removeAttribute('data-pe-root');
  PE.lastReset = normalizeBoot(d);


  /* legacy: рантаймы теперь в ядре — вырезаем инжектированные скрипты старых версий */
  Array.from(d.querySelectorAll('script[id^="av-"][id$="-runtime"]')).forEach(function (n) { n.remove(); });


  if (forVerify) {
    var st = d.querySelector('[data-panel-root], #panel-stage');
    if (st) { st.setAttribute('data-transport', 'mock'); st.removeAttribute('data-ws-url'); }
    Array.from(d.querySelectorAll('script[src]')).forEach(function (n) {
      if (/cr-com-lib|webxpanel/i.test(n.getAttribute('src') || '')) n.remove();
    });
    var tg = d.querySelector('#av-touch-guard'); if (tg) tg.remove();
  }
  return '<!DOCTYPE html>\n' + d.outerHTML + '\n';
}

function pathOf(n) {
  var parts = [], el = n, guard = 0;
  while (el && el.parentElement && guard++ < 30) {
    parts.unshift(el.tagName.toLowerCase() + ':' + Array.prototype.indexOf.call(el.parentElement.children, el));
    el = el.parentElement;
  }
  return parts.join('/');
}
function verifySaved() {
  if (PE.verifying) return;
  PE.verifying = true;
  var btn = $('pe-verify'); if (btn) { btn.disabled = true; btn.textContent = 'Проверяю…'; }
  var html;
  try { html = cleanDocument(true); }
  catch (e) { PE.verifying = false; if (btn) { btn.disabled = false; btn.textContent = 'Проверить сохранённый файл'; } toast('err', e.message); return; }
  var want = lockedList().map(function (n) {
    return { key: n.id ? 'id:' + n.id : 'path:' + pathOf(n), text: n.getAttribute(LOCK_ATTR), note: noteOf(n) };
  });
  var f = ui(h('iframe'));
  f.setAttribute('title', 'Проверка сохранённого файла');
  f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  f.style.cssText = 'position:fixed;left:-99999px;top:0;width:1280px;height:720px;border:0;opacity:0;pointer-events:none';
  document.body.appendChild(f);
  var done = false;
  var finish = function () {
    if (done) return; done = true;
    var res = { ok: 0, bad: [], frame: null, saver: null, dialogs: 0, total: want.length, screenJoins: 0 };
    try {
      var d = f.contentDocument;
      if (d) {
        var scr = screenNodes(d);
        res.dialogs = scr.filter(isOverlay).length;
        res.screenJoins = scr.filter(function (n) { return !!screenJoin(n); }).length;
        var sv = scr.filter(isSaver)[0];
        res.saver = sv ? !sv.classList.contains('is-hidden') : null;
        res.frame = scr.filter(function (n) { return hasActive(n.getAttribute('class')); })
          .map(function (n) { return n.id || n.getAttribute('data-screen') || n.tagName.toLowerCase(); });
        want.forEach(function (w) {
          var el = w.key.indexOf('id:') === 0 ? d.getElementById(w.key.slice(3)) : null;
          if (!el) el = Array.from(d.querySelectorAll('[' + LOCK_ATTR + ']')).filter(function (n) { return n.getAttribute(LOCK_ATTR) === w.text; })[0] || null;
          if (!el) { res.bad.push(w.note + ' — узел не найден'); return; }
          if (String(el.textContent || '') === w.text) res.ok++;
          else res.bad.push(w.note + ': «' + el.textContent + '» вместо «' + w.text + '»');
        });
      }
    } catch (e) { res.bad.push('Доступ к фрейму: ' + e.message); }
    try { f.srcdoc = ''; f.remove(); } catch (e) {}
    PE.verifying = false; PE.verify = res;
    if (btn) { btn.disabled = false; btn.textContent = 'Проверить сохранённый файл'; }
    renderProps();
    toast(res.bad.length ? 'err' : 'ok', res.bad.length ? ('Перезаписано: ' + res.bad.length + ' из ' + res.total)
      : ('Надписи целы · join у экранов ' + res.screenJoins + '/' + (res.dialogs + screensOfKind('page').length + screensOfKind('saver').length)));
  };
  f.onload = function () { setTimeout(finish, 900); };
  setTimeout(finish, 4000);
  f.srcdoc = html;
}

/* ===================== UNDO / REDO ===================== */
function snapshot() {
  PE.root = PE.root || findRoot();
  PE.undo.push(cleanElementHTML(PE.root));
  if (PE.undo.length > 30) PE.undo.shift();
  PE.redo.length = 0; syncUndo();
}
function restore(html) {
  var wrap = document.createElement('div'); wrap.innerHTML = html;
  var next = wrap.firstElementChild; if (!next) return;
  var cur = PE.root;
  if (cur === document.body) {
    Array.from(document.body.children).forEach(function (n) { if (!n.hasAttribute('data-pe-ui')) n.remove(); });
    Array.from(next.childNodes).forEach(function (n) { document.body.insertBefore(n.cloneNode(true), toasts); });
  } else { cur.replaceWith(next); PE.root = next; }
  PE.sel = null; PE.textNodes = []; hideOv();
  softRebind();
  document.dispatchEvent(new CustomEvent('pe:restored'));
  captureBoot(); applyLayout(); renderAll();
}
function doUndo() { if (!PE.undo.length) { toast('warn', 'Нечего отменять'); return; } PE.redo.push(cleanElementHTML(PE.root)); restore(PE.undo.pop()); syncUndo(); toast('info', 'Отменено'); }
function doRedo() { if (!PE.redo.length) { toast('warn', 'Нечего повторять'); return; } PE.undo.push(cleanElementHTML(PE.root)); restore(PE.redo.pop()); syncUndo(); toast('info', 'Повторено'); }
function syncUndo() { var u = $('pe-undo'), r = $('pe-redo'); if (u) u.disabled = !PE.undo.length; if (r) r.disabled = !PE.redo.length; }

/* ===================== ОВЕРЛЕЙ ВЫДЕЛЕНИЯ ===================== */
var ov = ui(h('div')); ov.id = 'pe-ov';
ov.innerHTML = '<div class="frame"></div><div class="tag"></div>' +
  ['nw','n','ne','e','se','s','sw','w'].map(function (d) { return '<div class="hd" data-d="' + d + '"></div>'; }).join('');
document.body.appendChild(ov);
var ovFrame = ov.querySelector('.frame'), ovTag = ov.querySelector('.tag');
var subOvLayer = ui(h('div')); document.body.appendChild(subOvLayer);
var lassoBox = ui(h('div')); lassoBox.id = 'pe-lasso'; document.body.appendChild(lassoBox);
var lassoState = null;

function hideOv() { ov.classList.remove('on'); subOvLayer.innerHTML = ''; }
function placeOv() {
  PE.sels = PE.sels.filter(function (n) { return n && document.contains(n); });
  if (!PE.on || !PE.sels.length) { hideOv(); return; }
  var r = getGroupScreenRect(PE.sels);
  if (!r || (r.width < 1 && r.height < 1)) { hideOv(); return; }

  ov.classList.add('on');
  ov.style.left = r.left + 'px'; ov.style.top = r.top + 'px';
  ov.style.width = r.width + 'px'; ov.style.height = r.height + 'px';
  var scale = PE.scale || 1;

  if (PE.sels.length === 1) {
    subOvLayer.innerHTML = '';
    ov.querySelectorAll('.hd').forEach(function (hd) { hd.style.display = ''; });
    var el = PE.sels[0], d = readRole(el, 'digital'), isScr = isScreenEl(el);
    var prefix = isScr ? '[' + kindLabel(kindOf(el)).toUpperCase() + '] ' : '';
    var host = isScr ? null : el.closest(SCREEN_SEL);
    if (host) prefix = '[' + kindLabel(kindOf(host)) + '] ';
    ovTag.textContent = prefix + noteOf(el) + (d.main ? '  ·  D ' + d.main.value : '  ·  D —') +
      '  ' + Math.round(r.width / scale) + '×' + Math.round(r.height / scale);
  } else {
    // Пунктирные рамки на каждый элемент группы; групповой ресайз скрываем, оставляем move
    ov.querySelectorAll('.hd').forEach(function (hd) { hd.style.display = ''; });
    ovTag.textContent = 'Группа: ' + PE.sels.length + ' эл.  ·  ' + Math.round(r.width / scale) + '×' + Math.round(r.height / scale);
    subOvLayer.innerHTML = PE.sels.map(function (el) {
      var rc = el.getBoundingClientRect();
      return '<div class="pe-sub-ov" style="left:' + rc.left + 'px;top:' + rc.top + 'px;width:' + rc.width + 'px;height:' + rc.height + 'px"></div>';
    }).join('');
  }
}
function loop() { placeOv(); positionBadges(); PE.raf = requestAnimationFrame(loop); }
function select(el) { PE.sels = el ? [el] : []; placeOv(); renderAll(); }
function px(v) { return Math.round(v) + 'px'; }




/* ===================== SMART GUIDES (НАПРАВЛЯЮЩИЕ) ===================== */
var guidesLayer = ui(h('div')); guidesLayer.id = 'pe-guides'; document.body.appendChild(guidesLayer);
var snapCache = null;

function hideGuides() {
  guidesLayer.classList.remove('on');
  guidesLayer.innerHTML = '';
}

function buildSnapCache(els) {
  var list = Array.isArray(els) ? els : [els];
  if (!list.length) return;
  var host = list[0].closest(SCREEN_SEL) || PE.root || document.body;
  var elRect = getGroupScreenRect(list);
  if (!elRect) return;
  var vLines = [], hLines = [];

  var isIgnored = function (n) {
    return list.some(function (s) { return n === s || s.contains(n) || n.contains(s); });
  };

  var candidates = [host].concat(Array.from(host.querySelectorAll('*')));
  candidates.forEach(function (n) {
    if (isIgnored(n) || n.closest('[data-pe-ui]') || !visibleEl(n)) return;
    var isTarget = (n === host) || pressable(n) || n.hasAttribute('data-states') ||
      n.hasAttribute('data-join-digital') || n.hasAttribute('data-join-analog') ||
      n.hasAttribute('data-join-string') || /\b(av-|card|box|panel|group|block|item|btn)\b/.test(n.className || '');
    if (!isTarget) return;

    var r = n.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    vLines.push(r.left, r.left + r.width / 2, r.right);
    hLines.push(r.top, r.top + r.height / 2, r.bottom);
  });

  var uniq = function (arr) {
    var s = new Set();
    arr.forEach(function (v) { s.add(Math.round(v * 2) / 2); });
    return Array.from(s);
  };

  snapCache = { v: uniq(vLines), h: uniq(hLines), startRect: elRect };
}

function showGuidesForEl(els) {
  var list = Array.isArray(els) ? els : [els];
  if (!snapCache) buildSnapCache(list);
  var r = getGroupScreenRect(list);
  if (!r || !snapCache) return;
  var xPoints = [r.left, r.left + r.width / 2, r.right];
  var yPoints = [r.top, r.top + r.height / 2, r.bottom];
  var activeV = [], activeH = [];

  xPoints.forEach(function (pt) {
    snapCache.v.forEach(function (lineX) {
      if (Math.abs(lineX - pt) < 0.8 && activeV.indexOf(lineX) < 0) activeV.push(lineX);
    });
  });
  yPoints.forEach(function (pt) {
    snapCache.h.forEach(function (lineY) {
      if (Math.abs(lineY - pt) < 0.8 && activeH.indexOf(lineY) < 0) activeH.push(lineY);
    });
  });

  if (activeV.length || activeH.length) {
    guidesLayer.classList.add('on');
    guidesLayer.innerHTML =
      activeV.map(function (x) { return '<div class="pe-guide-v" style="left:' + x + 'px"></div>'; }).join('') +
      activeH.map(function (y) { return '<div class="pe-guide-h" style="top:' + y + 'px"></div>'; }).join('');
  } else {
    hideGuides();
  }

  clearTimeout(keyGuideTimer);
  keyGuideTimer = setTimeout(function () {
    if (!PE.drag) { hideGuides(); snapCache = null; }
  }, 900);
}

function calcSnap(dxScreen, dyScreen, altKey) {
  if (!snapCache || altKey) {
    hideGuides();
    return { dx: dxScreen, dy: dyScreen };
  }
  var thr = 5; // порог прилипания в экранных пикселях
  var sr = snapCache.startRect;
  var curL = sr.left + dxScreen, curC = curL + sr.width / 2, curR = curL + sr.width;
  var curT = sr.top + dyScreen, curM = curT + sr.height / 2, curB = curT + sr.height;

  var bestX = null, minDx = thr + 1, activeV = [];
  var xPoints = [curL, curC, curR];
  snapCache.v.forEach(function (lineX) {
    xPoints.forEach(function (pt) {
      var diff = lineX - pt;
      if (Math.abs(diff) < minDx) { minDx = Math.abs(diff); bestX = diff; }
    });
  });
  if (bestX !== null) {
    dxScreen += bestX;
    // Собираем все линии, с которыми совпали после прилипания
    [sr.left + dxScreen, sr.left + dxScreen + sr.width / 2, sr.left + dxScreen + sr.width].forEach(function (pt) {
      snapCache.v.forEach(function (lineX) { if (Math.abs(lineX - pt) < 0.6) activeV.push(lineX); });
    });
  }

  var bestY = null, minDy = thr + 1, activeH = [];
  var yPoints = [curT, curM, curB];
  snapCache.h.forEach(function (lineY) {
    yPoints.forEach(function (pt) {
      var diff = lineY - pt;
      if (Math.abs(diff) < minDy) { minDy = Math.abs(diff); bestY = diff; }
    });
  });
  if (bestY !== null) {
    dyScreen += bestY;
    [sr.top + dyScreen, sr.top + dyScreen + sr.height / 2, sr.top + dyScreen + sr.height].forEach(function (pt) {
      snapCache.h.forEach(function (lineY) { if (Math.abs(lineY - pt) < 0.6) activeH.push(lineY); });
    });
  }

  // Отрисовка совпавших линий
  if (activeV.length || activeH.length) {
    guidesLayer.classList.add('on');
    guidesLayer.innerHTML =
      activeV.map(function (x) { return '<div class="pe-guide-v" style="left:' + x + 'px"></div>'; }).join('') +
      activeH.map(function (y) { return '<div class="pe-guide-h" style="top:' + y + 'px"></div>'; }).join('');
  } else {
    hideGuides();
  }

  return { dx: dxScreen, dy: dyScreen };
}



var keyGuideTimer = 0;

/*
function showGuidesForEl(el) {
  if (!snapCache) buildSnapCache(el);
  var r = el.getBoundingClientRect();
  var xPoints = [r.left, r.left + r.width / 2, r.right];
  var yPoints = [r.top, r.top + r.height / 2, r.bottom];
  var activeV = [], activeH = [];

  xPoints.forEach(function (pt) {
    snapCache.v.forEach(function (lineX) {
      if (Math.abs(lineX - pt) < 0.8 && activeV.indexOf(lineX) < 0) activeV.push(lineX);
    });
  });
  yPoints.forEach(function (pt) {
    snapCache.h.forEach(function (lineY) {
      if (Math.abs(lineY - pt) < 0.8 && activeH.indexOf(lineY) < 0) activeH.push(lineY);
    });
  });

  if (activeV.length || activeH.length) {
    guidesLayer.classList.add('on');
    guidesLayer.innerHTML =
      activeV.map(function (x) { return '<div class="pe-guide-v" style="left:' + x + 'px"></div>'; }).join('') +
      activeH.map(function (y) { return '<div class="pe-guide-h" style="top:' + y + 'px"></div>'; }).join('');
  } else {
    hideGuides();
  }

  clearTimeout(keyGuideTimer);
  keyGuideTimer = setTimeout(function () {
    if (!PE.drag) { hideGuides(); snapCache = null; }
  }, 900);
}

*/

function getGroupScreenRect(els) {
  var l = Infinity, t = Infinity, r = -Infinity, b = -Infinity, ok = false;
  els.forEach(function (el) {
    if (!el || !document.contains(el)) return;
    var rc = el.getBoundingClientRect();
    if (rc.width < 1 && rc.height < 1) return;
    l = Math.min(l, rc.left); t = Math.min(t, rc.top);
    r = Math.max(r, rc.right); b = Math.max(b, rc.bottom);
    ok = true;
  });
  return ok ? { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t } : null;
}


function lockParentHeight(el) {
  var p = el && el.parentElement;
  if (!p || isScreenEl(p) || p === document.body) return;
  if (!p.style.minHeight) {
    var scale = PE.scale || 1;
    var h = Math.round(p.getBoundingClientRect().height / scale);
    if (h > 0) p.style.minHeight = h + 'px';
  }
}


function startDrag(e, dir) {
  if (!PE.sels.length) return;
  e.preventDefault(); e.stopPropagation(); snapshot();
  var k = PE.scale || 1;
  var grpScreen = getGroupScreenRect(PE.sels);

  // Фильтруем вложенных потомков, если выделен их родитель
  var targets = PE.sels.filter(function (el) {
    return !PE.sels.some(function (p) { return p !== el && p.contains(el); });
  });

  var items = targets.map(function (el) {
    var cs = getComputedStyle(el), abs = cs.position === 'absolute' || cs.position === 'fixed';
    var rEl = el.getBoundingClientRect();
    var parent = el.parentElement;
    var rPar = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 };

    // Относительные координаты элемента внутри общей рамки группы (0..1)
    var rx = grpScreen.width > 0 ? (rEl.left - grpScreen.left) / grpScreen.width : 0;
    var ry = grpScreen.height > 0 ? (rEl.top - grpScreen.top) / grpScreen.height : 0;
    var rw = grpScreen.width > 0 ? rEl.width / grpScreen.width : 1;
    var rh = grpScreen.height > 0 ? rEl.height / grpScreen.height : 1;

    var needDetach = !abs && (dir === 'move' || targets.length > 1);
    return {
      el: el,
      detach: needDetach,
      l: needDetach ? Math.round((rEl.left - rPar.left) / k) : (parseFloat(el.style.left) || (abs ? el.offsetLeft : 0)),
      t: needDetach ? Math.round((rEl.top - rPar.top) / k) : (parseFloat(el.style.top) || (abs ? el.offsetTop : 0)),
      w: Math.round(rEl.width / k),
      h: Math.round(rEl.height / k),
      // Смещение начала координат родителя относительно группы (в пикселях панели)
      parOffsetX: (grpScreen.left - rPar.left) / k,
      parOffsetY: (grpScreen.top - rPar.top) / k,
      rx: rx, ry: ry, rw: rw, rh: rh,
      pos: cs.position
    };
  });

  items.forEach(function (it) {
    if (it.detach) {
      lockParentHeight(it.el);
      it.el.style.position = 'absolute';
      it.el.style.left = it.l + 'px';
      it.el.style.top = it.t + 'px';
      it.el.style.width = it.w + 'px';
      it.el.style.height = it.h + 'px';
      it.el.style.margin = '0';
    }
    it.el.style.boxSizing = 'border-box';
  });

  PE.drag = {
    dir: dir, x: e.clientX, y: e.clientY, k: k, items: items,
    grpW: grpScreen.width / k,
    grpH: grpScreen.height / k
  };
  if (dir === 'move') buildSnapCache(targets);
  try { ov.setPointerCapture(e.pointerId); } catch (err) {}
}


function onMove(e) {
  if (lassoState) {
    var x1 = Math.min(lassoState.x, e.clientX), y1 = Math.min(lassoState.y, e.clientY);
    var w = Math.abs(e.clientX - lassoState.x), hgt = Math.abs(e.clientY - lassoState.y);
    lassoBox.style.left = x1 + 'px'; lassoBox.style.top = y1 + 'px';
    lassoBox.style.width = w + 'px'; lassoBox.style.height = hgt + 'px';
    if (w > 4 || hgt > 4) lassoBox.classList.add('on');
    return;
  }
  var d = PE.drag; if (!d || !d.items.length) return;
  if (d.dir === 'move') {
    var snapped = calcSnap(e.clientX - d.x, e.clientY - d.y, e.altKey);
    var dx = snapped.dx / d.k, dy = snapped.dy / d.k;
    d.items.forEach(function (it) {
      it.el.style.left = px(it.l + dx);
      it.el.style.top = px(it.t + dy);
    });
  } else if (d.items.length === 1) {
    // Одиночный ресайз (без изменений)
    var it = d.items[0], el = it.el;
    var dx2 = (e.clientX - d.x) / d.k, dy2 = (e.clientY - d.y) / d.k;
    if (/e/.test(d.dir)) el.style.width = px(Math.max(16, it.w + dx2));
    if (/s/.test(d.dir)) el.style.height = px(Math.max(16, it.h + dy2));
    if (/w/.test(d.dir)) { el.style.width = px(Math.max(16, it.w - dx2)); el.style.left = px(it.l + dx2); }
    if (/n/.test(d.dir)) { el.style.height = px(Math.max(16, it.h - dy2)); el.style.top = px(it.t + dy2); }
    if (it.pos === 'static') el.style.position = 'relative';
  } else {
    // Групповой пропорциональный ресайз
    var dxG = (e.clientX - d.x) / d.k, dyG = (e.clientY - d.y) / d.k;
    var newW = d.grpW, newH = d.grpH, shiftX = 0, shiftY = 0;

    if (/e/.test(d.dir)) newW = Math.max(24, d.grpW + dxG);
    if (/s/.test(d.dir)) newH = Math.max(24, d.grpH + dyG);
    if (/w/.test(d.dir)) {
      newW = Math.max(24, d.grpW - dxG);
      shiftX = d.grpW - newW;
    }
    if (/n/.test(d.dir)) {
      newH = Math.max(24, d.grpH - dyG);
      shiftY = d.grpH - newH;
    }

    d.items.forEach(function (it) {
      it.el.style.left = px(it.parOffsetX + shiftX + it.rx * newW);
      it.el.style.top = px(it.parOffsetY + shiftY + it.ry * newH);
      it.el.style.width = px(Math.max(12, it.rw * newW));
      it.el.style.height = px(Math.max(12, it.rh * newH));
    });
  }
  placeOv();
}



function endDrag(e) {
  if (lassoState) {
    var ls = lassoState; lassoState = null;
    lassoBox.classList.remove('on');
    var lr = {
      left: Math.min(ls.x, e.clientX), top: Math.min(ls.y, e.clientY),
      right: Math.max(ls.x, e.clientX), bottom: Math.max(ls.y, e.clientY)
    };
    if (lr.right - lr.left > 6 && lr.bottom - lr.top > 6) {
      var host = activeScreen() || PE.root || document.body;
      var hits = [];
      Array.from(host.querySelectorAll('*')).forEach(function (n) {
        if (n === host || isScreenEl(n) || n.closest('[data-pe-ui]') || !visibleEl(n)) return;
        var isTarget = pressable(n) || n.hasAttribute('data-states') ||
          n.hasAttribute('data-join-digital') || n.hasAttribute('data-join-analog') ||
          n.hasAttribute('data-join-string') || /\b(av-|card|box|panel|group|block|item|btn)\b/.test(n.className || '');
        if (!isTarget) return;
        var r = n.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return;
        // Проверяем пересечение рамки лассо с элементом
        if (r.left < lr.right && r.right > lr.left && r.top < lr.bottom && r.bottom > lr.top) hits.push(n);
      });
      // Убираем дочерние элементы, если их родитель тоже попал в рамку
      hits = hits.filter(function (n) { return !hits.some(function (p) { return p !== n && p.contains(n); }); });
      if (hits.length) {
        PE.sels = ls.shift ? Array.from(new Set(PE.sels.concat(hits))) : hits;
        placeOv(); renderAll();
        toast('ok', 'Выделено элементов: ' + PE.sels.length);
      }
    }
    return;
  }
  if (!PE.drag) return;
  PE.drag = null;
  snapCache = null;
  hideGuides();
  renderProps();
  toast('ok', 'Геометрия записана в style=""');
}

ovFrame.addEventListener('pointerdown', function (e) {
  if (e.shiftKey) {
    // Позволяем Shift+кликом снять выделение с элемента под курсором
    ov.style.pointerEvents = 'none';
    var under = document.elementFromPoint(e.clientX, e.clientY);
    ov.style.pointerEvents = '';
    if (under && !under.closest('[data-pe-ui]')) {
      var hit = PE.sels.find(function (s) { return s === under || s.contains(under); });
      if (hit) { toggleSelect(hit); return; }
    }
  }
  startDrag(e, 'move');
});
ov.querySelectorAll('.hd').forEach(function (hd) { hd.addEventListener('pointerdown', function (e) { startDrag(e, hd.dataset.d); }); });
window.addEventListener('pointermove', onMove);
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

document.addEventListener('click', function (e) {
  if (!PE.on || e.target.closest('[data-pe-ui]')) return;
  e.preventDefault(); e.stopPropagation();
  if (e.target === document.body || e.target === document.documentElement) return;
  if (PE.justLassoed) { PE.justLassoed = false; return; }
  var target = e.altKey ? (e.target.closest(SCREEN_SEL) || e.target) : e.target;
  if (e.shiftKey) toggleSelect(target);
  else select(target);
}, true);

document.addEventListener('pointerdown', function (e) {
  if (!PE.on || e.target.closest('[data-pe-ui]') || e.target.closest('#pe-ov')) return;
  e.preventDefault(); e.stopPropagation();
  // Если нажали на пустую область экрана или зажали Shift — начинаем выделение рамкой (Lasso)
  if (isScreenEl(e.target) || e.target === PE.root || e.shiftKey) {
    lassoState = { x: e.clientX, y: e.clientY, shift: e.shiftKey };
  }
}, true);

/* ===================== БЕЙДЖИ ===================== */
var badgeLayer = ui(h('div')); badgeLayer.id = 'pe-badges'; document.body.appendChild(badgeLayer);
var badgeItems = [];
function visibleEl(el) {
  if (!el || !el.isConnected) return false;
  var pg = el.closest('.av-page'); if (pg && !pg.classList.contains('is-active')) return false;
  var md = el.closest('.av-modal'); if (md && !md.classList.contains('is-active')) return false;
  var jr = el.closest('#journal'); if (jr && !jr.classList.contains('is-open')) return false;
  var sp = el.closest('#splash'); if (sp && sp.classList.contains('is-hidden')) return false;
  var so = el.closest('#shutdown-overlay'); if (so && !so.classList.contains('is-active')) return false;
  if (el.closest('.hidden') && !(PE.on && el.closest('[data-vis-hidden]'))) return false;
  if (typeof el.checkVisibility === 'function') return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  var n = el;
  while (n && n !== document.body) {
    var cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    n = n.parentElement;
  }
  return el.getClientRects().length > 0;
}
function positionBadges() {
  if (!PE.badges || !badgeItems.length) return;
  var barTop = (PE.bar ? BAR_H : 0) + 2;
  for (var i = 0; i < badgeItems.length; i++) {
    var it = badgeItems[i];
    if (!it.el.isConnected) { it.b.style.display = 'none'; continue; }
    var r = it.el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) { it.b.style.display = 'none'; continue; }
    it.b.style.display = '';
    var top = r.top - 15 - it.stack * 15;
    if (top < barTop) top = r.bottom + 2 + it.stack * 15;
    it.b.style.left = Math.max(2, Math.min(window.innerWidth - 60, r.left)) + 'px';
    it.b.style.top = top + 'px';
  }
}
function paintBadges() {
  badgeLayer.classList.toggle('on', PE.badges);
  badgeLayer.innerHTML = ''; badgeItems = [];
  Array.from(document.querySelectorAll('.jb-outline')).forEach(function (n) { n.classList.remove('jb-outline'); });
  if (!PE.badges) return;
  var dup = {};
  diagnostics().shared.forEach(function (s) { dup[s.value] = true; });
  var frag = document.createDocumentFragment();
  panelNodes().forEach(function (el) {
    if (isScreenEl(el)) return;                 // join экранов — в чипе шапки и в списках, без наложения
    if (el.closest('[data-no-join]') || !visibleEl(el)) return;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    var stack = 0;
    ROLES.forEach(function (role) {
      var info = readRole(el, role.key);
      if (!info.main) return;
      var b = document.createElement('span');
      b.className = 'pe-badge ' + role.letter + (role.key === 'digital' && dup[info.main.value] ? ' dup' : '');
      b.textContent = role.letter + ' ' + info.main.value + (info.extra.length ? '  ⚠' + info.extra.length : '');
      b.title = role.label + ' · ' + info.main.attr + ' = ' + info.main.value +
        (info.extra.length ? '\nЛИШНИЕ: ' + info.extra.map(function (x) { return x.attr + '=' + x.value; }).join(', ') : '') +
        '\n' + noteOf(el);
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (!PE.on) setEdit(true);
        select(el); setTab('props');
      });
      frag.appendChild(b);
      badgeItems.push({ el: el, b: b, stack: stack });
      stack++;
    });
    if (stack) el.classList.add('jb-outline');
  });
  badgeLayer.appendChild(frag);
  positionBadges();
}
function setBadges(v) {
  PE.badges = !!v;
  var pageLayer = document.getElementById('join-badges');
  if (pageLayer) {
    if (PE.badges) { pageLayer.dataset.pePrev = pageLayer.style.display || ''; pageLayer.style.display = 'none'; PE.pageBadgesHidden = true; }
    else if (PE.pageBadgesHidden) { pageLayer.style.display = pageLayer.dataset.pePrev || ''; PE.pageBadgesHidden = false; }
  }
  var b = $('pe-badges-btn'); if (b) b.classList.toggle('on', PE.badges);
  paintBadges();
  toast('info', PE.badges ? 'Join-ы элементов показаны (J) · join экранов — в чипе ▣ и во вкладке Join’ы' : 'Join-ы скрыты');
}
function paintStats() {
  var d = diagnostics(), reg = registry(), chip = $('pe-jstat');
  if (chip) {
    var problems = d.multi.length + d.shared.length + d.invalid.length + d.noJoin.length;
    chip.innerHTML = 'join <b>' + reg.size + '</b>' + (problems ? ' · ⚠' + problems : '');
    chip.classList.toggle('hot', problems > 0);
  }
  syncActiveChip();
}

/* ===================== КЛОНИРОВАНИЕ ЭКРАНОВ ===================== */
function nextScreenId(base) {
  var clean = String(base || 'screen').replace(/[-_]\d+$/, '');
  var used = new Set(screens().map(function (s) { return screenId(s); }));
  var k = 2, sep = String(base).indexOf('_') >= 0 ? '_' : '-';
  while (used.has(clean + sep + k)) k++;
  return clean + sep + k;
}
function askScreenPlacement(defaultName, canAddNav, onConfirm, kind) {
  var list = screensOfKind(kind), cur = activeScreen();
  var wrap = ui(h('div'));
  wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483150;background:rgba(4,10,18,.75);display:flex;align-items:center;justify-content:center;';
  var opts = list.map(function (s, i) {
    return '<option value="' + i + '"' + (s === cur ? ' selected' : '') + '>После: ' + esc(screenId(s) || (kindLabel(kind) + ' ' + (i + 1))) + '</option>';
  }).join('');
  var noun = kind === 'dialog' ? 'диалога' : kind === 'saver' ? 'заставки' : 'страницы';
  wrap.innerHTML =
    '<div style="width:344px;background:var(--pe-bg2);border:1px solid var(--pe-line2);border-radius:12px;padding:14px;color:var(--pe-txt);box-shadow:0 20px 50px #000;display:flex;flex-direction:column;gap:10px">' +
    '<div style="font-size:12px;font-weight:800;color:var(--pe-cyn)">Куда вставить копию ' + noun + '?</div>' +
    '<div style="display:flex;flex-direction:column;gap:4px"><label style="font-size:10.5px;color:var(--pe-mut)">ID нового узла</label>' +
    '<input class="pe-inp mono wide" id="pe-m-name" value="' + esc(defaultName) + '"></div>' +
    '<div style="display:flex;flex-direction:column;gap:4px"><label style="font-size:10.5px;color:var(--pe-mut)">Позиция в слое</label>' +
    '<select class="pe-sel" id="pe-m-pos" style="width:100%">' + opts + '<option value="last">После последнего узла слоя</option>' +
    (PE.sel ? '<option value="sel">Внутрь выделенного (' + esc(PE.sel.tagName.toLowerCase()) + ')</option>' : '') + '</select></div>' +
    (canAddNav ? '<label style="display:flex;align-items:center;gap:7px;font-size:11px;color:var(--pe-mut);cursor:pointer"><input type="checkbox" id="pe-m-nav" style="accent-color:var(--pe-grn)"><span>Добавить кнопку в нижнее меню</span></label>' : '') +
    '<p style="margin:0;font-size:10px;line-height:1.5;color:var(--pe-dim)">' +
    (PE.newJoinsOnCopy ? 'Копия получит новые уникальные join’ы.' : 'Включён режим сохранения старых join’ов (изменить можно в Свойствах).') +
    '</p>' +
    '<div style="display:flex;gap:6px;margin-top:2px"><button class="pe-btn pri" id="pe-m-ok" style="flex:1">Вставить</button><button class="pe-btn" id="pe-m-cancel">Отмена</button></div></div>';
  document.body.appendChild(wrap);
  var nameInp = wrap.querySelector('#pe-m-name'); nameInp.focus(); nameInp.select();
  wrap.querySelector('#pe-m-cancel').onclick = function () { wrap.remove(); };
  wrap.querySelector('#pe-m-ok').onclick = function () {
    var name = nameInp.value.trim() || defaultName;
    var pos = wrap.querySelector('#pe-m-pos').value;
    var addNav = !!(wrap.querySelector('#pe-m-nav') && wrap.querySelector('#pe-m-nav').checked);
    wrap.remove(); onConfirm(name, pos, addNav);
  };
}
function layerContainer(kind) {
  var same = screensOfKind(kind);
  if (same.length && same[0].parentElement) return same[0].parentElement;
  if (kind === 'dialog') return document.getElementById('panel-stage') || document.querySelector('[data-panel-root]') || PE.root || findRoot();
  return document.getElementById('pages') || PE.root || findRoot();
}
function insertScreenNode(node, newId, pos, srcIdForNav, addNav, kind) {
  kind = kind || kindOf(node);
  if (node.id || !node.hasAttribute('data-screen')) node.id = newId;
  if (node.hasAttribute('data-screen')) node.setAttribute('data-screen', newId);
  if (kind === 'dialog') node.setAttribute('data-dialog', newId);
  else if (kind === 'saver') node.setAttribute('data-screensaver', '');
  else if (!node.matches(SCREEN_SEL)) node.setAttribute('data-screen', newId);
  node.querySelectorAll('[id]').forEach(function (n) { n.removeAttribute('id'); });
  var moved = PE.newJoinsOnCopy ? applyMap(node, allocMap(valuesIn(node))) : 0;
  var canon = canonizeEl(node) ? 1 : 0;
  node.querySelectorAll('*').forEach(function (n) { if (canonizeEl(n)) canon++; });
  ACTIVE_TOKENS.forEach(function (t) { node.classList.remove(t); });
  TRANSIENT_CLASSES.forEach(function (t) { node.classList.remove(t); });
  if (kind === 'saver') node.classList.add('is-hidden');
  else if (node.hasAttribute('data-screen') && !node.classList.contains('av-page')) node.classList.add('hidden');
  var list = screensOfKind(kind);
  if (pos === 'sel' && PE.sel) PE.sel.appendChild(node);
  else if (list.length) {
    var target = (pos === 'last') ? list[list.length - 1] : (list[+pos] || list[list.length - 1]);
    target.after(node);
  } else layerContainer(kind).appendChild(node);
  if (addNav && srcIdForNav && kind === 'page') {
    Array.from(document.querySelectorAll('[data-nav="' + srcIdForNav + '"]')).filter(function (n) {
      return !n.closest('[data-pe-ui]') && !node.contains(n);
    }).forEach(function (btn) {
      var nb = btn.cloneNode(true);
      nb.removeAttribute('id');
      nb.classList.remove('is-active', 'active', 'is-current');
      nb.setAttribute('data-nav', newId);
      var dj = readRole(nb, 'digital');
      if (dj.main) writeRole(nb, 'digital', nextFree(dj.main.value, usedSet(), new Set()));
      canonizeEl(nb);
      btn.after(nb);
      var p = btn.parentElement;
      if (p && getComputedStyle(p).display === 'grid') {
        var items = Array.from(p.children).filter(function (c) { return getComputedStyle(c).display !== 'none'; }).length;
        p.style.gridTemplateColumns = 'repeat(' + items + ', minmax(0, 1fr))';
      }
    });
  }
  captureBoot(); softRebind();
  showScreen(node); select(node); renderJoins();
  toast('ok', kindLabel(kind) + ' «' + newId + '» · D ' + (screenJoin(node) || '—') + (PE.newJoinsOnCopy ? ' · новых join’ов: ' + moved : ' · старые join сохранены'));

}
function duplicateScreen() {
  var src = activeScreen();
  if (!src) { toast('warn', 'Не найдена активная страница или диалог'); return; }
  var kind = kindOf(src), oldId = screenId(src) || (kind === 'dialog' ? 'modal' : kind === 'saver' ? 'splash' : 'screen');
  var hasNav = kind === 'page' && document.querySelectorAll('[data-nav="' + oldId + '"]').length > 0;
  askScreenPlacement(nextScreenId(oldId), hasNav, function (newId, pos, addNav) {
    snapshot(); insertScreenNode(src.cloneNode(true), newId, pos, oldId, addNav, kind);
  }, kind);
}
function copyScreenHTML() {
  var src = activeScreen();
  if (!src) { toast('warn', 'Нет активной страницы или диалога'); return; }
  copyText(cleanElementHTML(src), 'HTML скопирован: ' + kindLabel(kindOf(src)) + ' ' + screenId(src));
}
function pasteScreenHTML() {
  var processRaw = function (raw) {
    var w = document.createElement('div'); w.innerHTML = String(raw || '').trim();
    var node = w.firstElementChild;
    if (!node) { toast('err', 'В буфере нет HTML-элемента'); return; }
    var kind = kindOf(node);
    if (!node.matches(SCREEN_SEL)) {
      kind = /modal|dialog|overlay/i.test((node.id || '') + ' ' + (node.className || '')) ? 'dialog'
        : /splash|saver/i.test((node.id || '') + ' ' + (node.className || '')) ? 'saver' : 'page';
      if (kind === 'dialog') node.classList.add('av-modal');
    }
    var oldId = node.id || (kind === 'dialog' ? 'modal_pasted' : kind === 'saver' ? 'splash_pasted' : 'screen_pasted');
    askScreenPlacement(nextScreenId(oldId), false, function (newId, pos) {
      snapshot(); insertScreenNode(node, newId, pos, null, false, kind);
    }, kind);
  };
  if (navigator.clipboard && navigator.clipboard.readText) {
    navigator.clipboard.readText().then(processRaw, function () {
      var m = prompt('Вставьте HTML страницы, диалога или заставки:'); if (m) processRaw(m);
    });
  } else { var m = prompt('Вставьте HTML страницы, диалога или заставки:'); if (m) processRaw(m); }
}

/* ===================== ГРУППЫ ===================== */
function diagGroup(compact) {
  var d = diagnostics();
  var total = d.multi.length + d.shared.length + d.invalid.length + d.noJoin.length;
  var body = '';
  if (!total) {
    body = '<div class="pe-stat ok">✓ Конфликтов нет: один join на роль, у всех экранов есть join, общих digital у нажимаемых нет.</div>';
  } else {
    if (d.noJoin.length) {
      body += '<div class="pe-stat warn">⚠ Экраны без digital join: ' + d.noJoin.length + ' — ' + esc(d.noJoin.map(screenId).join(', ')) + '</div>' +
        '<button class="pe-btn amb" data-fix="screenjoins">Выдать join из ID (' + d.noJoin.length + ')</button>';
    }
    if (d.multi.length) {
      body += '<div class="pe-stat err">✕ Несколько join одной роли на узле: ' + d.multi.length + '</div>';
      if (!compact) body += d.multi.slice(0, 6).map(function (m, i) {
        return '<div class="pe-jrow bad" data-multi="' + i + '"><div class="pe-jhead"><span class="pe-tag num">' + esc(m.role) + '</span>' +
          '<span class="pe-jname">' + esc(m.keep.value) + '</span></div>' +
          '<div class="pe-alias">лишние: ' + esc(m.extra.map(function (x) { return x.attr + '=' + x.value; }).join(', ')) + '</div>' +
          '<div class="pe-kind">' + esc(noteOf(m.el)) + '</div>' +
          '<div class="pe-row"><button class="pe-btn sm" data-a="sel">◎</button><button class="pe-btn sm pri" data-a="fix">Оставить ' + esc(m.keep.value) + '</button></div></div>';
      }).join('');
      body += '<button class="pe-btn pri" data-fix="multi">Исправить все (' + d.multi.length + ')</button>';
    }
    if (d.shared.length) {
      body += '<div class="pe-stat warn">⚠ Один digital join на нескольких нажимаемых: ' + d.shared.length + '</div>';
      if (!compact) body += d.shared.slice(0, 6).map(function (s, i) {
        return '<div class="pe-jrow dup" data-shared="' + i + '"><div class="pe-jhead"><span class="pe-tag num">D</span>' +
          '<span class="pe-jname">' + esc(s.value) + '</span><span class="pe-kind">' + s.els.length + ' шт</span></div>' +
          '<div class="pe-kind">' + esc(s.els.map(noteOf).join(' · ')) + '</div>' +
          '<div class="pe-row"><button class="pe-btn sm" data-a="sel">◎</button><button class="pe-btn sm pri" data-a="fix">Выдать уникальные</button></div></div>';
      }).join('');
      body += '<button class="pe-btn pri" data-fix="shared">Развести все (' + d.shared.length + ')</button>';
    }
    if (d.invalid.length) body += '<div class="pe-stat err">✕ Недопустимых имён: ' + d.invalid.length + '</div>';
  }
  body += '<div class="pe-row"><button class="pe-btn amb" data-fix="canon" style="flex:1">Канонизировать атрибуты</button>' +
    '<button class="pe-btn" data-fix="rebind">Перепривязать выделенное</button></div>';
  return '<div class="pe-grp"><h4>Диагностика join’ов <em>' + (total ? '⚠ ' + total : 'чисто') + '</em></h4><div>' + body + '</div></div>';
}

/* Компактный список экранов для вкладки «Свойства»: id + join + быстрый переход */
function screensGroup() {
  var list = screens();
  var rows = function (k, title) {
    var g = list.filter(function (n) { return kindOf(n) === k; });
    if (!g.length) return '';
    return '<div class="pe-kind" style="margin-top:2px">' + esc(title) + ' · ' + g.length + '</div>' +
      g.map(function (n) {
        var i = list.indexOf(n), j = screenJoin(n);
        return '<div class="pe-scrrow' + (isOn(n) ? ' on' : '') + (PE.sel === n ? ' sel' : '') + '" data-scr="' + i + '">' +
          '<div class="pe-scrhead"><span class="pe-tag ' + (k === 'dialog' ? 'dlg' : k === 'saver' ? 'sv' : 'pg') + '">' + kindTag(k) + '</span>' +
          '<b>' + esc(screenId(n) || ('узел ' + i)) + '</b>' +
          '<button class="pe-btn xs" data-a="show" title="Показать и выделить">◎</button>' +
          '<button class="pe-btn xs vio" data-a="dup" title="Дублировать">⧉</button></div>' +
          '<div class="pe-scrjoin"><span class="pe-kind">D</span><code>' + esc(j || '— нет join —') + '</code>' +
          '<button class="pe-btn xs" data-a="copyjoin" title="Скопировать join">⎘</button>' +
          '<button class="pe-btn xs amb" data-a="copyrx" title="Скопировать RX-команду для контроллера">RX</button></div>' +
          '</div>';
      }).join('');
  };
  return '<div class="pe-grp"><h4>Экраны и диалоги <em>' + list.length + '</em></h4><div><div class="pe-scrlist">' +
    rows('page', 'Страницы') + rows('dialog', 'Диалоги') + rows('saver', 'Заставка') + '</div>' +
    '<p class="pe-note">◎ показать и выделить · ⧉ копия · ⎘ join · RX готовая команда. Полное редактирование join экранов — вкладка <b>Join’ы</b>.</p>' +
    '</div></div>';
}

/* Полный редактор join экранов для вкладки «Join’ы» */
function screensJoinGroup() {
  var list = screens();
  var rows = function (k, title) {
    var g = list.filter(function (n) { return kindOf(n) === k; });
    if (!g.length) return '';
    return '<div class="pe-kind" style="margin-top:4px">' + esc(title) + ' · ' + g.length + '</div>' +
      g.map(function (n) {
        var i = list.indexOf(n), j = screenJoin(n), info = readRole(n, 'digital');
        var suggested = joinFromId(n);
        return '<div class="pe-scrrow' + (isOn(n) ? ' on' : '') + (PE.sel === n ? ' sel' : '') + '" data-scr="' + i + '">' +
          '<div class="pe-scrhead"><span class="pe-tag ' + (k === 'dialog' ? 'dlg' : k === 'saver' ? 'sv' : 'pg') + '">' + kindTag(k) + '</span>' +
          '<b>' + esc(screenId(n) || ('узел ' + i)) + '</b>' +
          '<span class="pe-kind">' + (isOn(n) ? 'открыт' : 'закрыт') + '</span>' +
          '<button class="pe-btn xs" data-a="show" title="Показать и выделить">◎</button></div>' +
          '<div class="pe-row"><input class="pe-inp mono wide' + (j && !validJoin(j) ? ' bad' : '') + '" data-scrjoin value="' + esc(j) + '" placeholder="' + esc(suggested) + '">' +
          '<button class="pe-btn sm pri" data-a="setjoin" title="Записать join">✎</button>' +
          '<button class="pe-btn sm vio" data-a="allocjoin" title="Свободный join">＋</button></div>' +
          '<div class="pe-row">' +
          '<button class="pe-btn xs" data-a="copyjoin">⎘ join</button>' +
          '<button class="pe-btn xs amb" data-a="copyrx">⎘ RX</button>' +
          '<button class="pe-btn xs" data-a="fromid" title="' + esc(suggested) + '">join из ID</button>' +
          '<button class="pe-btn xs dgr" data-a="clearjoin">✕</button></div>' +
          (info.extra.length ? '<div class="pe-alias">⚠ лишние: ' + esc(info.extra.map(function (x) { return x.attr + '=' + x.value; }).join(', ')) + '</div>' : '') +
          (info.main && info.main.attr !== 'data-join-digital' ? '<div class="pe-alias">значение в legacy ' + esc(info.main.attr) + '</div>' : '') +
          '</div>';
      }).join('');
  };
  return '<div class="pe-grp"><h4>Экраны и диалоги · join <em>' + list.length + '</em></h4><div>' +
    '<p class="pe-note">Здесь виден и правится <code>data-join-digital</code> каждой страницы, диалога и заставки — включая закрытые. <b>RX</b> копирует готовую команду для Node-RED.</p>' +
    '<div class="pe-scrlist">' + rows('page', 'Страницы') + rows('dialog', 'Диалоги и оверлеи') + rows('saver', 'Заставка') + '</div>' +
    '<div class="pe-row"><button class="pe-btn" data-a="copyall" style="flex:1">⎘ Карта экранов JSON</button>' +
    '<button class="pe-btn amb" data-a="allfromid">Все join из ID</button></div>' +
    '</div></div>';
}
function verifyGroup() {
  var v = PE.verify, stat = 'Проверка ещё не запускалась', cls = 'pe-stat';
  if (v) {
    cls = 'pe-stat ' + (v.bad.length ? 'err' : 'ok');
    stat = (v.bad.length ? '✕ ' : '✓ ') + 'надписей ' + v.ok + '/' + v.total + ' · диалогов ' + v.dialogs +
      ' · join у экранов ' + v.screenJoins +
      ' · заставка ' + (v.saver === null ? '—' : (v.saver ? 'вкл' : 'выкл')) +
      ' · первый кадр → ' + ((v.frame && v.frame.join(', ')) || '—') + (v.bad.length ? '\n' + v.bad.join('\n') : '');
  }
  return '<div class="pe-grp"><h4>Сохранённый файл <em>' + lockedList().length + ' защ.</em></h4><div>' +
    '<button class="pe-btn pri" id="pe-verify">Проверить сохранённый файл</button>' +
    '<div class="' + cls + '" style="white-space:pre-wrap">' + esc(stat) + '</div></div></div>';
}
function bootGroup() {
  var opts = bootOptions(), rep = PE.bootReport;
  var pgOpts = opts.filter(function (r) { return !r.saver; }), svOpts = opts.filter(function (r) { return r.saver; });
  var stat = 'Снимок: ' + (PE.boot ? PE.boot.length : 0) + ' узлов', cls = 'pe-stat';
  if (rep) {
    cls = 'pe-stat ' + ((rep.saver === true || rep.active.length === 1) ? 'ok' : 'warn');
    stat = 'Первый кадр → ' + (rep.saver ? 'заставка (splash)' : (rep.active.join(', ') || 'ничего')) + ' · диалогов ' + rep.dialogs;
  }
  var opt = function (r) {
    var v = r.id || r.ds;
    return '<option value="' + esc(v) + '"' + (PE.bootScreen === v ? ' selected' : '') + '>' + esc(v) + (r.saver ? ' (заставка)' : '') + '</option>';
  };
  return '<div class="pe-grp"><h4>Первый кадр <em>' + (PE.resetOnExport ? 'сброс' : 'как есть') + '</em></h4><div>' +
    '<div class="pe-row"><label>Сбрасывать при экспорте</label><div class="pe-sw' + (PE.resetOnExport ? ' on' : '') + '" data-ui="resetOnExport"><i></i></div></div>' +
    '<div class="pe-row"><label>Стартовый экран</label><select class="pe-sel" data-ui="bootScreen">' +
    '<option value=""' + (PE.bootScreen ? '' : ' selected') + '>как в исходнике</option>' +
    (pgOpts.length ? '<optgroup label="Страницы · ' + pgOpts.length + '">' + pgOpts.map(opt).join('') + '</optgroup>' : '') +
    (svOpts.length ? '<optgroup label="Заставка · ' + svOpts.length + '">' + svOpts.map(opt).join('') + '</optgroup>' : '') +
    '</select></div><div class="' + cls + '">' + esc(stat) + '</div>' +
    '<div class="pe-row"><button class="pe-btn" data-ui="bootProbe" style="flex:1">Первый кадр</button>' +
    '<button class="pe-btn amb" data-ui="bootRecapture">Переснять</button></div></div></div>';
}
function interfaceGroup() {
  return '<div class="pe-grp"><h4>Интерфейс редактора</h4><div>' +
    '<div class="pe-row"><label>Join-ы элементов (J)</label><div class="pe-sw' + (PE.badges ? ' on' : '') + '" data-ui="badges"><i></i></div></div>' +
    '<div class="pe-row"><label>Авто-защита надписей</label><div class="pe-sw' + (PE.autoLock ? ' on' : '') + '" data-ui="autoLock"><i></i></div></div>' +
    '<div class="pe-row"><label>Новые join при копировании</label><div class="pe-sw' + (PE.newJoinsOnCopy ? ' on' : '') + '" data-ui="newJoinsOnCopy"><i></i></div></div>' +
    '<div class="pe-row"><label>Отступ холста</label><div class="pe-sw' + (PE.offset ? ' on' : '') + '" data-ui="offset"><i></i></div></div>' +
    '<div class="pe-row"><label>Поля вокруг</label><input type="range" class="pe-range" data-ui="margin" min="0" max="48" step="2" value="' + PE.margin + '"><span class="pe-chip" id="pe-margin-v"><b>' + PE.margin + 'px</b></span></div>' +
    '<div class="pe-row"><label>Шапка сверху</label><div class="pe-sw' + (PE.bar ? ' on' : '') + '" data-ui="bar"><i></i></div></div>' +
    '<div class="pe-row"><label>Скрывать в просмотре</label><div class="pe-sw' + (PE.autoHide ? ' on' : '') + '" data-ui="autoHide"><i></i></div></div>' +
    '<div class="pe-row"><label>Ярлык возврата</label><select class="pe-sel" data-ui="handlePos">' +
    ['left','center','right'].map(function (p) { return '<option value="' + p + '"' + (PE.handlePos === p ? ' selected' : '') + '>' + (p === 'left' ? 'слева' : p === 'center' ? 'по центру' : 'справа') + '</option>'; }).join('') +
    '</select></div><div class="pe-row"><button class="pe-btn" data-ui="reset" style="flex:1">Сбросить вид</button></div>' +
    '<p class="pe-note">Alt+клик — выделить экран вместо вложенного элемента. <b>S</b> — выделить активный экран.</p>' +
    '</div></div>';
}
function locksGroup() {
  var list = lockedList();
  return '<div class="pe-grp"><h4>Защищённые надписи <em>' + list.length + '</em></h4><div>' +
    (list.length ? list.map(function (n, i) {
      return '<div class="pe-jrow" data-lockrow="' + i + '"><div class="pe-jhead"><span class="pe-tag name">lock</span>' +
        '<span class="pe-jname">' + esc(n.getAttribute(LOCK_ATTR)) + '</span></div>' +
        '<div class="pe-kind">' + esc(noteOf(n)) + '</div>' +
        '<div class="pe-row"><button class="pe-btn sm" data-a="sel">◎ Показать</button><button class="pe-btn sm dgr" data-a="free">Снять</button></div></div>';
    }).join('') : '<div class="pe-empty">Пока нет</div>') + '</div></div>';
}

/* единый обработчик строк экранов (используется в обеих вкладках) */
function bindScreenRows(box) {
  var all = screens();
  box.querySelectorAll('[data-scr]').forEach(function (row) {
    var n = all[+row.dataset.scr]; if (!n) return;
    var on = function (sel, fn) { var b = row.querySelector(sel); if (b) b.onclick = fn; };
    on('[data-a="show"]', function () { if (!PE.on) setEdit(true); showScreen(n, true); setTab('props'); });
    on('[data-a="dup"]', function () {
      var k = kindOf(n), oldId = screenId(n) || (k === 'dialog' ? 'modal' : k === 'saver' ? 'splash' : 'screen');
      var hasNav = k === 'page' && document.querySelectorAll('[data-nav="' + oldId + '"]').length > 0;
      askScreenPlacement(nextScreenId(oldId), hasNav, function (newId, pos, addNav) {
        snapshot(); insertScreenNode(n.cloneNode(true), newId, pos, oldId, addNav, k);
      }, k);
    });
    on('[data-a="copyjoin"]', function () { copyText(screenJoin(n), 'join скопирован: ' + screenJoin(n)); });
    on('[data-a="copyrx"]', function () { copyText(rxCommandFor(n), 'RX-команда скопирована'); });
    on('[data-a="setjoin"]', function () {
      var inp = row.querySelector('[data-scrjoin]'); if (!inp) return;
      var v = inp.value.trim();
      if (v && !validJoin(v)) { inp.classList.add('bad'); toast('err', 'Недопустимый join: ' + v); return; }
      inp.classList.remove('bad');
      snapshot(); writeRole(n, 'digital', v); softRebind(); renderAll(); placeOv();
      toast('ok', screenId(n) + ' · D ' + (v || '—'));
    });
    on('[data-a="allocjoin"]', function () {
      var cur = screenJoin(n) || joinFromId(n);
      var v = nextFree(cur, usedSet(), new Set());
      snapshot(); writeRole(n, 'digital', v); softRebind(); renderAll();
      toast('ok', screenId(n) + ' · D ' + v);
    });
    on('[data-a="fromid"]', function () {
      var v = joinFromId(n);
      if (!v || !validJoin(v)) { toast('err', 'Не удалось вывести join из ID'); return; }
      snapshot(); writeRole(n, 'digital', v); softRebind(); renderAll();
      toast('ok', screenId(n) + ' · D ' + v);
    });
    on('[data-a="clearjoin"]', function () {
      snapshot(); writeRole(n, 'digital', ''); softRebind(); renderAll();
      toast('info', 'Join убран у ' + screenId(n));
    });
    on('[data-a="copyall"]', function () {
      var obj = {};
      screens().forEach(function (s) { obj[screenId(s)] = { kind: kindOf(s), join: screenJoin(s) || null, open: isOn(s) }; });
      copyText(JSON.stringify(obj, null, 2), 'Карта экранов скопирована');
    });
    on('[data-a="allfromid"]', function () {
      snapshot();
      var touched = [];
      screens().forEach(function (s) { var v = joinFromId(s); if (v && validJoin(v)) { writeRole(s, 'digital', v); touched.push(s); } });
      softRebind(); renderAll();
      toast('ok', 'Join из ID выставлен: ' + touched.length);
    });
    var inp = row.querySelector('[data-scrjoin]');
    if (inp) inp.onkeydown = function (e) {
      if (e.key === 'Enter') { e.preventDefault(); var b = row.querySelector('[data-a="setjoin"]'); if (b) b.click(); }
    };
  });
}
function bindGroups(box) {
  box.querySelectorAll('[data-ui]').forEach(function (n) {
    var k = n.dataset.ui;
    if (k === 'reset') { n.onclick = resetUI; return; }
    if (k === 'badges') { n.onclick = function () { setBadges(!PE.badges); renderProps(); }; return; }
    if (k === 'bootProbe') { n.onclick = function () { var r = inspectFirstFrame(); renderProps(); toast(r.saver || r.active.length === 1 ? 'ok' : 'warn', 'Первый кадр: ' + (r.saver ? 'splash' : (r.active.join(', ') || 'нет'))); }; return; }
    if (k === 'bootRecapture') { n.onclick = function () { var c = captureBoot(true); PE.bootReport = null; renderProps(); toast('ok', 'Снимок переснят: ' + c); }; return; }
    if (k === 'bootScreen') { n.onchange = function () { PE.bootScreen = n.value; PE.bootReport = null; renderProps(); }; return; }
    if (k === 'resetOnExport') { n.onclick = function () { PE.resetOnExport = !PE.resetOnExport; saveUI(); PE.bootReport = null; renderProps(); }; return; }
    if (k === 'autoLock') { n.onclick = function () { PE.autoLock = !PE.autoLock; saveUI(); renderProps(); }; return; }
    if (k === 'newJoinsOnCopy') { n.onclick = function () { PE.newJoinsOnCopy = !PE.newJoinsOnCopy; saveUI(); renderProps(); toast('info', PE.newJoinsOnCopy ? 'При копировании: новые join' : 'При копировании: старые join сохраняются'); }; return; }
    if (k === 'margin') {
      var paint = function () { n.style.setProperty('--p', ((n.value - n.min) / (n.max - n.min)) * 100 + '%'); };
      paint();
      n.oninput = function () { PE.margin = +n.value; paint(); var v = box.querySelector('#pe-margin-v'); if (v) v.innerHTML = '<b>' + PE.margin + 'px</b>'; applyLayout(); saveUI(); };
      return;
    }
    if (k === 'handlePos') { n.onchange = function () { PE.handlePos = n.value; syncBar(); saveUI(); }; return; }
    n.onclick = function () {
      if (k === 'offset') setOffset(!PE.offset);
      else if (k === 'bar') setBar(!PE.bar);
      else if (k === 'autoHide') { PE.autoHide = !PE.autoHide; saveUI(); renderProps(); }
    };
  });
  box.querySelectorAll('[data-fix]').forEach(function (b) {
    b.onclick = function () {
      var k = b.dataset.fix;
      if (k === 'rebind') {
        if (!PE.sel) { toast('warn', 'Ничего не выделено'); return; }
        snapshot();
        var n = rebindChanged([PE.sel]);
        renderAll();
        toast('ok', n ? 'Узел перепривязан' : 'Узел не нажимаемый — перепривязка не нужна');
        return;
      }
      snapshot();
      var touched = [];
      if (k === 'multi') touched = fixMulti();
      else if (k === 'shared') touched = fixShared();
      else if (k === 'canon') touched = canonizeAll();
      else if (k === 'screenjoins') touched = fixScreenJoins();
      rebindChanged(touched); renderAll();
      toast('ok', 'Исправлено узлов: ' + touched.length);
    };
  });
  var dg = diagnostics();
  box.querySelectorAll('[data-multi]').forEach(function (row) {
    var m = dg.multi[+row.dataset.multi]; if (!m) return;
    row.querySelector('[data-a="sel"]').onclick = function () { select(m.el); m.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); };
    row.querySelector('[data-a="fix"]').onclick = function () {
      snapshot(); writeRole(m.el, m.role, m.keep.value); rebindChanged([m.el]); renderAll(); toast('ok', 'Оставлен ' + m.keep.value);
    };
  });
  box.querySelectorAll('[data-shared]').forEach(function (row) {
    var s = dg.shared[+row.dataset.shared]; if (!s) return;
    row.querySelector('[data-a="sel"]').onclick = function () { select(s.els[0]); s.els[0].scrollIntoView({ block: 'center', behavior: 'smooth' }); };
    row.querySelector('[data-a="fix"]').onclick = function () {
      snapshot(); var used = usedSet(), res = new Set(), touched = [];
      s.els.slice(1).forEach(function (el) { var v = nextFree(s.value, used, res); res.add(v); writeRole(el, 'digital', v); touched.push(el); });
      rebindChanged(touched); renderAll(); toast('ok', 'Разведены: ' + touched.length);
    };
  });
  bindScreenRows(box);
  var ll = lockedList();
  box.querySelectorAll('[data-lockrow]').forEach(function (row) {
    var n = ll[+row.dataset.lockrow]; if (!n) return;
    row.querySelector('[data-a="sel"]').onclick = function () { select(n); n.scrollIntoView({ block: 'center', behavior: 'smooth' }); };
    row.querySelector('[data-a="free"]').onclick = function () {
      snapshot();
      if (window.AVTextLock) window.AVTextLock.release(n); else n.removeAttribute(LOCK_ATTR);
      PE.verify = null; renderAll(); toast('info', 'Защита снята');
    };
  });
  var vb = box.querySelector('#pe-verify'); if (vb) vb.onclick = verifySaved;
}

/* ===================== СВОЙСТВА ===================== */
function ownerGroup(el) {
  if (isScreenEl(el)) return '';
  var host = el.closest(SCREEN_SEL);
  if (!host) return '';
  var j = screenJoin(host), k = kindOf(host);
  return '<div class="pe-grp"><h4>Экран-владелец <em>' + kindTag(k) + '</em></h4><div>' +
    '<div class="pe-owner"><div class="pe-jhead"><span class="pe-tag ' + (k === 'dialog' ? 'dlg' : k === 'saver' ? 'sv' : 'pg') + '">' + kindTag(k) + '</span>' +
    '<span class="pe-jname">' + esc(screenId(host)) + '</span></div>' +
    '<div class="pe-scrjoin"><span class="pe-kind">D</span><code>' + esc(j || '— нет join —') + '</code></div>' +
    '<div class="pe-row"><button class="pe-btn sm pri" id="pe-owner-sel" style="flex:1">▣ Выделить экран</button>' +
    '<button class="pe-btn sm" id="pe-owner-copy">⎘ join</button>' +
    '<button class="pe-btn sm amb" id="pe-owner-rx">⎘ RX</button></div></div>' +
    '<p class="pe-note">Join экрана открывает его по контроллеру: <code>{"type":"digital","join":"' + esc(j || '…') + '","value":1}</code></p>' +
    '</div></div>';
}
function renderProps() {
  var box = $('pe-props'); if (!box) return;
  var head = diagGroup(true) + verifyGroup() + bootGroup();
  
if (!PE.sel) { 
  box.innerHTML = head + interfaceGroup() + locksGroup() + '<div class="pe-empty">Кликните элемент · Alt+клик — экран · S — активный экран</div>' + screensGroup(); 
  bindGroups(box); 
  return; 
}

  var el = PE.sel, a = el.attributes, cs = getComputedStyle(el);
  PE.textNodes = textTargets(el);

  var joinBoxes = ROLES.map(function (r) {
    var info = readRole(el, r.key);
    var v = info.main ? info.main.value : '';
    var bad = v && !validJoin(v);
    var warn = info.extra.length > 0;
    var isHidden = el.classList.contains('hidden');
    return '<div class="pe-jbox' + (warn ? ' warn' : '') + '">' +
      '<div class="pe-jhead"><span class="pe-tag ' + (v && isNum(v) ? 'num' : 'name') + '">' + r.letter + '</span>' +
      '<span>' + esc(r.label) + '</span><code>' + esc(r.canon) + '</code></div>' +
      '<div class="pe-row"><input class="pe-inp mono wide' + (bad ? ' bad' : '') + '" data-role-join="' + r.key + '" list="pe-jlist" value="' + esc(v) + '" placeholder="' + esc(isScreenEl(el) ? joinFromId(el) : '1001 / display.power') + '">' +
      '<button class="pe-btn sm vio" data-role-alloc="' + r.key + '" title="Свободный join">＋</button>' +
      (r.key === 'vis' ? '<button class="pe-btn sm ' + (isHidden ? 'amb' : 'on') + '" data-role-vis-test title="Тест 0/1 (переключить видимость)">' + (isHidden ? '👁 0' : '👁 1') + '</button>' : '') +
      (v ? '<button class="pe-btn sm" data-role-copy="' + r.key + '" title="Скопировать">⎘</button>' : '') +
      (v ? '<button class="pe-btn sm dgr" data-role-clear="' + r.key + '" title="Убрать">✕</button>' : '') + '</div>' +
      (warn ? '<div class="pe-alias">⚠ лишние: ' + esc(info.extra.map(function (x) { return x.attr + '=' + x.value; }).join(', ')) + '</div>' : '') +
      (info.main && info.main.attr !== r.canon ? '<div class="pe-alias">значение в legacy ' + esc(info.main.attr) + '</div>' : '') +
      '</div>';
  }).join('');


  var labels = PE.textNodes.length ? PE.textNodes.map(function (t, i) {
    var host = labelHost(el, t), own = lockOwner(t), locked = own && own.hasAttribute(LOCK_ATTR);
    var ownerNode = t.node.nodeType === 3 ? t.node.parentElement : t.node;
    var ctrl = ownerNode && ownerNode.hasAttribute && ownerNode.hasAttribute('data-join-string');
    return '<div class="pe-txt-row' + (locked ? ' locked' : '') + '">' +
      '<div class="pe-txt-head"><i class="' + (i ? 'sec' : '') + '"></i>' + esc(t.cap) +
      (ctrl ? ' <span class="pe-kind">join</span>' : '') + '<code>' + esc(t.note) + '</code></div>' +
      '<input class="pe-inp wide" data-text="' + i + '" value="' + esc(readText(t)) + '">' +
      (own && !host ? '<div class="pe-lockrow"><span>' + (locked ? 'защищена' : 'рантайм может перезаписать') + '</span>' +
        '<button class="pe-btn sm ' + (locked ? 'on' : '') + '" data-lock="' + i + '">' + (locked ? '🔒' : '🔓') + '</button></div>'
        : '<div class="pe-lockrow"><span>' + (host ? 'подпись состояния' : ctrl ? 'надписью владеет контроллер' : 'составной узел') + '</span></div>') +
      '</div>';
  }).join('') : '<div class="pe-empty">Текстовых узлов нет</div>';

  var dataRows = [];
  Array.from(a).forEach(function (at) {
    if (!/^data-/.test(at.name) || /^data-(pe|av|gjs)-/.test(at.name) || MANAGED_ATTRS.indexOf(at.name) >= 0) return;
    dataRows.push(at.name);
  });
  var dataGroup = '<div class="pe-grp"><h4>Прочие data-атрибуты <em>' + dataRows.length + '</em></h4><div>' +
    (dataRows.length ? dataRows.map(function (k) {
      return '<div class="pe-row" data-drow="' + esc(k) + '"><label>' + esc(k.replace('data-', '')) + '</label>' +
        '<input class="pe-inp mono" data-dval value="' + esc(a.getNamedItem(k).value) + '">' +
        '<button class="pe-btn sm dgr" data-ddel>✕</button></div>';
    }).join('') : '<div class="pe-empty">Нет</div>') +
    '<div class="pe-row"><input class="pe-inp mono" id="pe-dnew" placeholder="data-preset" style="width:112px">' +
    '<input class="pe-inp mono" id="pe-dnewv" placeholder="значение" style="flex:1;width:auto">' +
    '<button class="pe-btn sm pri" id="pe-dadd">＋</button></div></div></div>';

  var opts = Array.from(registry().keys()).map(function (v) { return '<option value="' + esc(v) + '">'; }).join('');

  var extra = [
    'data-nav', 'data-nav-dialog', 'data-nav-back', 'data-nav-toggle', 'data-nav-reset', 'data-nav-key',
    'data-radio-group', 'data-radio-local', 'data-repeat',
    'data-visibility', 'data-initial', 'data-active-style', 'data-latch', 'data-local', 'id', 'class'
  ];



  var rows2 = extra.map(function (k) {
    var v = a.getNamedItem(k) ? a.getNamedItem(k).value : '';
    return '<div class="pe-row"><label>' + esc(k.replace('data-', '')) + '</label><input class="pe-inp" data-attr="' + k + '" value="' + esc(v) + '"></div>';
  }).join('');


  var alignGroup = PE.sels.length > 1
    ? '<div class="pe-grp"><h4>Выравнивание группы <em>' + PE.sels.length + ' эл.</em></h4><div>' +
      '<div class="pe-align-grid">' +
      '<button class="pe-btn sm" data-align="left" title="По левому краю">⫷ Лево</button>' +
      '<button class="pe-btn sm" data-align="center" title="По горизонтальному центру">⫿ Центр X</button>' +
      '<button class="pe-btn sm" data-align="right" title="По правому краю">⫸ Право</button>' +
      '<button class="pe-btn sm" data-align="top" title="По верхнему краю">⊤ Верх</button>' +
      '<button class="pe-btn sm" data-align="middle" title="По вертикальному центру">⊟ Центр Y</button>' +
      '<button class="pe-btn sm" data-align="bottom" title="По нижнему краю">⊥ Низ</button>' +
      '</div>' +
      '<div class="pe-row">' +
      '<button class="pe-btn sm vio" data-align="dist-h" style="flex:1" title="Равные отступы по горизонтали">⇹ Распределить X</button>' +
      '<button class="pe-btn sm vio" data-align="dist-v" style="flex:1" title="Равные отступы по вертикали">⇳ Распределить Y</button>' +
      '</div>' +
      '<div class="pe-row">' +
      '<button class="pe-btn sm amb" data-align="same-w" style="flex:1" title="Сделать ширину как у первого выделенного элемента">↔ Одинаковая W</button>' +
      '<button class="pe-btn sm amb" data-align="same-h" style="flex:1" title="Сделать высоту как у первого выделенного элемента">↕ Одинаковая H</button>' +
      '</div>' +
      '<div class="pe-row"><button class="pe-btn sm dgr" id="pe-del-grp" style="flex:1">🗑 Удалить группу (' + PE.sels.length + ')</button></div>' +
      '</div></div>'
    : '';



  box.innerHTML = head + alignGroup + interfaceGroup() + ownerGroup(el) +
    '<datalist id="pe-jlist">' + opts + '</datalist>' +
    '<div class="pe-grp"><h4>Join’ы ' + (isScreenEl(el) ? kindLabel(kindOf(el)) : 'элемента') + ' <em>' + esc(noteOf(el)) + '</em></h4><div>' + joinBoxes +
    (isScreenEl(el) ? '<div class="pe-row"><button class="pe-btn sm amb" id="pe-scr-rx" style="flex:1">⎘ RX-команда открытия</button><button class="pe-btn sm" id="pe-scr-fromid">join из ID</button></div>' : '') +
    '<p class="pe-note">Один join на роль. Значение пишется в канонический атрибут, legacy-алиасы снимаются.</p></div></div>' +
    '<div class="pe-grp"><h4>Надписи <em>' + PE.textNodes.length + '</em></h4><div>' + labels +
    '<div class="pe-row"><button class="pe-btn vio" id="pe-text-add" style="flex:1">＋ Добавить надпись</button></div></div></div>' +
    locksGroup() +
    '<div class="pe-grp"><h4>Узел</h4><div>' + rows2 + '</div></div>' + dataGroup +
    '<div class="pe-grp"><h4>Геометрия</h4><div>' +
    '<div class="pe-row"><label>Позиция</label><select class="pe-sel" id="pe-pos">' + ['static','relative','absolute','fixed'].map(function (p) { return '<option' + (cs.position === p ? ' selected' : '') + '>' + p + '</option>'; }).join('') + '</select></div>' +
    '<div class="pe-row"><label>Ширина</label><input class="pe-inp mono" id="pe-w" value="' + esc(el.style.width || '') + '" placeholder="' + el.offsetWidth + 'px"></div>' +
    '<div class="pe-row"><label>Высота</label><input class="pe-inp mono" id="pe-h" value="' + esc(el.style.height || '') + '" placeholder="' + el.offsetHeight + 'px"></div>' +
    '<div class="pe-row"><label>Left / Top</label><input class="pe-inp mono" id="pe-l" style="width:62px" value="' + esc(el.style.left || '') + '"><input class="pe-inp mono" id="pe-t" style="width:62px" value="' + esc(el.style.top || '') + '"></div>' +
    '<div class="pe-row"><button class="pe-btn amb" id="pe-lock" style="flex:1">⤢ Зафиксировать</button><button class="pe-btn" id="pe-unlock" style="flex:1">Снять</button></div>' +
    '<div class="pe-row"><button class="pe-btn" id="pe-detach2" style="flex:1">⇱ Отвязать от потока</button></div></div></div>' +

    '<div class="pe-grp"><h4>Действия</h4><div>' +
    '<div class="pe-row"><button class="pe-btn vio" id="pe-dup" style="flex:1">⧉ Дублировать</button><button class="pe-btn dgr" id="pe-del" style="flex:1">🗑 Удалить</button></div>' +
    '<div class="pe-row"><button class="pe-btn" id="pe-parent" style="flex:1">↑ Родитель</button></div>' +
    '</div></div>' +
    screensGroup();

  bindGroups(box);

box.querySelectorAll('[data-align]').forEach(function (b) {
    b.onclick = function () { alignSelected(b.dataset.align); };
  });
  var dgBtn = box.querySelector('#pe-del-grp');
  if (dgBtn) dgBtn.onclick = deleteSel;

  var os = box.querySelector('#pe-owner-sel');
  if (os) os.onclick = function () { var host = el.closest(SCREEN_SEL); if (host) { select(host); toast('ok', 'Выделен ' + kindLabel(kindOf(host)) + ' ' + screenId(host)); } };
  var oc = box.querySelector('#pe-owner-copy');
  if (oc) oc.onclick = function () { var host = el.closest(SCREEN_SEL); copyText(screenJoin(host), 'join экрана скопирован'); };
  var orx = box.querySelector('#pe-owner-rx');
  if (orx) orx.onclick = function () { var host = el.closest(SCREEN_SEL); copyText(rxCommandFor(host), 'RX-команда скопирована'); };
  var srx = box.querySelector('#pe-scr-rx');
  if (srx) srx.onclick = function () { copyText(rxCommandFor(el), 'RX-команда скопирована'); };
  var sfid = box.querySelector('#pe-scr-fromid');
  if (sfid) sfid.onclick = function () {
    var v = joinFromId(el);
    if (!v || !validJoin(v)) { toast('err', 'Не удалось вывести join из ID'); return; }
    snapshot(); writeRole(el, 'digital', v); softRebind(); renderAll(); toast('ok', 'D ' + v);
  };

  box.querySelectorAll('[data-role-join]').forEach(function (inp) {
    var commit = function () {
      var role = inp.dataset.roleJoin, v = inp.value.trim();
      if (v && !validJoin(v)) { inp.classList.add('bad'); toast('err', 'Недопустимый join: ' + v); return; }
      inp.classList.remove('bad');
      var before = readRole(el, role);
      if (before.main && before.main.value === v && before.main.attr === ROLE_BY_KEY[role].canon && !before.extra.length) return;
      snapshot(); writeRole(el, role, v); rebindChanged([el]); renderAll(); placeOv();
      toast('ok', ROLE_BY_KEY[role].label + ' = ' + (v || '—'));
    };
    inp.onchange = commit;
    inp.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); commit(); inp.blur(); } };
  });
  box.querySelectorAll('[data-role-alloc]').forEach(function (b) {
    b.onclick = function () {
      var role = b.dataset.roleAlloc, cur = readRole(el, role);
      var seed = cur.main ? cur.main.value : (isScreenEl(el) && role === 'digital' ? joinFromId(el) : suggestName(el, role));
      var v = nextFree(seed, usedSet(), new Set());
      snapshot(); writeRole(el, role, v); rebindChanged([el]); renderAll(); toast('ok', ROLE_BY_KEY[role].label + ' = ' + v);
    };
  });
  box.querySelectorAll('[data-role-copy]').forEach(function (b) {
    b.onclick = function () { var i = readRole(el, b.dataset.roleCopy); copyText(i.main ? i.main.value : '', 'join скопирован'); };
  });
  box.querySelectorAll('[data-role-clear]').forEach(function (b) {
    b.onclick = function () { snapshot(); writeRole(el, b.dataset.roleClear, ''); rebindChanged([el]); renderAll(); toast('info', 'Join убран'); };
  });


  var vtest = box.querySelector('[data-role-vis-test]');
  if (vtest) vtest.onclick = function () {
    snapshot();
    var nextShow = el.classList.contains('hidden');
    if (window.AVVisibility) window.AVVisibility.apply(el, nextShow ? 1 : 0);
    else {
      el.classList.toggle('hidden', !nextShow);
      el.toggleAttribute('data-vis-hidden', !nextShow);
    }
    placeOv(); renderProps(); paintBadges();
    toast('info', nextShow ? 'Видимость: 1 (показан)' : 'Видимость: 0 (скрыт)');
  };

  box.querySelectorAll('[data-text]').forEach(function (inp) {
    var commit = function () {
      var t = PE.textNodes[+inp.dataset.text];
      var ownerEl = t && (t.node.nodeType === 3 ? t.node.parentElement : t.node);
      if (!t || !ownerEl || !document.contains(ownerEl) || readText(t) === inp.value) return;
      snapshot(); t.node.textContent = inp.value;
      var host2 = labelHost(el, t);
      if (host2) {
        var st = readStates(host2.btn);
        if (st[host2.idx]) { st[host2.idx].label = inp.value; host2.btn.setAttribute('data-states', JSON.stringify(st)); }
      } else if (PE.autoLock) {
        var own = lockOwner(t);
        if (own) { if (window.AVTextLock) window.AVTextLock.set(own, inp.value); else own.setAttribute(LOCK_ATTR, inp.value); }
      }
      if (window.AVStates) window.AVStates.refresh();
      if (window.AVTextLock) window.AVTextLock.refresh();
      PE.verify = null; placeOv(); renderProps(); renderStates(); renderCode(); paintBadges();
      toast('ok', t.cap + ' обновлён');
    };
    inp.onchange = commit;
    inp.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); commit(); inp.blur(); } };
  });
  box.querySelectorAll('[data-lock]').forEach(function (b) {
    b.onclick = function () {
      var t = PE.textNodes[+b.dataset.lock], own = lockOwner(t);
      if (!own) return;
      snapshot();
      if (own.hasAttribute(LOCK_ATTR)) { if (window.AVTextLock) window.AVTextLock.release(own); else own.removeAttribute(LOCK_ATTR); }
      else { if (window.AVTextLock) window.AVTextLock.set(own, readText(t)); else own.setAttribute(LOCK_ATTR, readText(t)); }
      PE.verify = null; renderProps(); renderCode();
    };
  });
  var tadd = box.querySelector('#pe-text-add');
  if (tadd) tadd.onclick = function () {
    snapshot();
    var sp = document.createElement('span');
    if (!el.querySelector('[data-role="label"]') && el.hasAttribute('data-states')) { sp.setAttribute('data-role', 'label'); sp.className = 'av-label'; }
    else sp.className = 'av-sub';
    sp.textContent = 'Новая надпись';
    el.appendChild(sp); softRebind(); renderAll(); placeOv();
  };
  box.querySelectorAll('[data-drow]').forEach(function (row) {
    var k = row.dataset.drow;
    row.querySelector('[data-dval]').onchange = function (e) {
      snapshot(); var v = e.target.value.trim();
      if (v) el.setAttribute(k, v); else el.removeAttribute(k);
      if (BIND_TIME_ATTRS.indexOf(k) >= 0) rebindChanged([el]); else softRebind();
      renderCode(); placeOv();
    };
    row.querySelector('[data-ddel]').onclick = function () {
      snapshot(); el.removeAttribute(k);
      if (BIND_TIME_ATTRS.indexOf(k) >= 0) rebindChanged([el]); else softRebind();
      renderProps(); renderCode();
    };
  });
  var dadd = box.querySelector('#pe-dadd');
  if (dadd) dadd.onclick = function () {
    var nb = box.querySelector('#pe-dnew'), vb = box.querySelector('#pe-dnewv');
    var k = nb.value.trim().toLowerCase();
    if (k && !/^data-/.test(k)) k = 'data-' + k;
    if (!/^data-[a-z0-9][a-z0-9-]*$/.test(k) || /^data-(pe|av|gjs)-/.test(k)) { nb.classList.add('bad'); toast('err', 'Имя: data-имя, латиница и дефис'); return; }
    nb.classList.remove('bad'); snapshot(); el.setAttribute(k, vb.value.trim());
    if (BIND_TIME_ATTRS.indexOf(k) >= 0) rebindChanged([el]); else softRebind();
    renderProps(); renderCode();
  };
  box.querySelectorAll('[data-attr]').forEach(function (inp) {
    inp.onchange = function () {
      snapshot(); var k = inp.dataset.attr, v = inp.value.trim();
      if (v) el.setAttribute(k, v); else el.removeAttribute(k);
      if (BIND_TIME_ATTRS.indexOf(k) >= 0) rebindChanged([el]); else softRebind();
      renderAll(); placeOv();
    };
  });
  var pos = box.querySelector('#pe-pos');
  pos.onchange = function () {
    snapshot();
    if (pos.value !== 'static' && cs.position === 'static') { el.style.left = el.offsetLeft + 'px'; el.style.top = el.offsetTop + 'px'; }
    el.style.position = pos.value; placeOv(); renderProps();
  };
  ['pe-w','pe-h','pe-l','pe-t'].forEach(function (id) {
    var i = box.querySelector('#' + id);
    i.onchange = function () {
      snapshot();
      var map = { 'pe-w': 'width', 'pe-h': 'height', 'pe-l': 'left', 'pe-t': 'top' }, v = i.value.trim();
      if (v) el.style[map[id]] = /^\d+$/.test(v) ? v + 'px' : v; else el.style.removeProperty(map[id]);
      el.style.boxSizing = 'border-box'; placeOv();
    };
  });
  box.querySelector('#pe-lock').onclick = function () {
    snapshot();
    el.style.boxSizing = 'border-box'; el.style.width = el.offsetWidth + 'px'; el.style.height = el.offsetHeight + 'px'; el.style.flexShrink = '0';
    if (cs.position === 'absolute' || cs.position === 'fixed') { el.style.left = el.offsetLeft + 'px'; el.style.top = el.offsetTop + 'px'; }
    placeOv(); renderProps();
  };
  box.querySelector('#pe-unlock').onclick = function () {
    snapshot();
    ['width','height','left','top','position','flex-shrink','box-sizing'].forEach(function (p) { el.style.removeProperty(p); });
    placeOv(); renderProps();
  };
  box.querySelector('#pe-detach2').onclick = detachFromFlow;
  box.querySelector('#pe-dup').onclick = duplicateSel;
  box.querySelector('#pe-del').onclick = deleteSel;
  box.querySelector('#pe-parent').onclick = function () { if (el.parentElement && el.parentElement !== document.body) select(el.parentElement); };
}
function suggestName(el, role) {
  var scr = el.closest(SCREEN_SEL);
  var scope = scr ? (screenId(scr) || 'panel') : 'panel';
  scope = String(scope).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'panel';
  var lab = ((el.querySelector('[data-role="label"]') || el).textContent || '').trim().toLowerCase();
  var slug = lab.replace(/[^a-zа-я0-9]+/gi, '_').replace(/^_|_$/g, '').slice(0, 18);
  var tr = { 'микрофон':'mic','камера':'cam','звук':'snd','громкость':'lvl','вкл':'on','выкл':'off','источник':'src','экран':'scr','ракурс':'preset','поддержка':'support','питание':'power' };
  Object.keys(tr).forEach(function (k) { slug = slug.replace(new RegExp(k, 'g'), tr[k]); });
  slug = slug.replace(/[^a-z0-9_]/g, '') || role;
  return scope + '_' + slug + '_' + role;
}
function detachFromFlow() {
  var el = PE.sel;
  if (!el || isScreenEl(el) || el.matches('[data-panel-root]')) { toast('warn', 'Экран отвязывать нельзя'); return; }
  var parent = el.parentElement; if (!parent) return;
  snapshot();
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
  var rEl = el.getBoundingClientRect(), rPar = parent.getBoundingClientRect();
  var scale = PE.scale || parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--stage-scale')) || 1;
  lockParentHeight(el); 
  el.style.position = 'absolute';
  el.style.left = Math.round((rEl.left - rPar.left) / scale) + 'px';
  el.style.top = Math.round((rEl.top - rPar.top) / scale) + 'px';
  el.style.width = Math.round(rEl.width / scale) + 'px';
  el.style.height = Math.round(rEl.height / scale) + 'px';
  el.style.margin = '0'; el.style.flex = 'none';
  placeOv(); renderProps(); toast('ok', 'Элемент отвязан от потока');
}


/* ===================== ВЫРАВНИВАНИЕ И РАСПРЕДЕЛЕНИЕ ГРУППЫ ===================== */
function alignSelected(mode) {
  var els = PE.sels.filter(function (n) { return n && !isScreenEl(n) && document.contains(n); });
  if (els.length < 2) { toast('warn', 'Выделите минимум 2 элемента (Shift+клик или рамкой)'); return; }
  snapshot();
  var scale = PE.scale || 1;

  // Переводим элементы в position:absolute с сохранением текущей визуальной позиции
  var items = els.map(function (el) {
    var parent = el.parentElement;
    if (parent && getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    var rEl = el.getBoundingClientRect(), rPar = parent.getBoundingClientRect();
    var l = (rEl.left - rPar.left) / scale;
    var t = (rEl.top - rPar.top) / scale;
    var w = rEl.width / scale;
    var h = rEl.height / scale;
    lockParentHeight(el);
    el.style.position = 'absolute';
    el.style.margin = '0';
    el.style.left = Math.round(l) + 'px';
    el.style.top = Math.round(t) + 'px';
    return { el: el, l: l, t: t, r: l + w, b: t + h, w: w, h: h, cx: l + w / 2, cy: t + h / 2 };
  });

  var minL = Math.min.apply(null, items.map(function (i) { return i.l; }));
  var maxR = Math.max.apply(null, items.map(function (i) { return i.r; }));
  var minT = Math.min.apply(null, items.map(function (i) { return i.t; }));
  var maxB = Math.max.apply(null, items.map(function (i) { return i.b; }));
  var midX = (minL + maxR) / 2, midY = (minT + maxB) / 2;

  if (mode === 'left') items.forEach(function (i) { i.el.style.left = Math.round(minL) + 'px'; });
  else if (mode === 'center') items.forEach(function (i) { i.el.style.left = Math.round(midX - i.w / 2) + 'px'; });
  else if (mode === 'right') items.forEach(function (i) { i.el.style.left = Math.round(maxR - i.w) + 'px'; });
  else if (mode === 'top') items.forEach(function (i) { i.el.style.top = Math.round(minT) + 'px'; });
  else if (mode === 'middle') items.forEach(function (i) { i.el.style.top = Math.round(midY - i.h / 2) + 'px'; });
  else if (mode === 'bottom') items.forEach(function (i) { i.el.style.top = Math.round(maxB - i.h) + 'px'; });
  else if (mode === 'dist-h') {
    if (items.length < 3) { toast('warn', 'Для распределения нужно 3+ элемента'); return; }
    items.sort(function (a, b) { return a.l - b.l; });
    var totalW = items.reduce(function (s, i) { return s + i.w; }, 0);
    var gapX = ((maxR - minL) - totalW) / (items.length - 1);
    var curX = minL;
    items.forEach(function (i) { i.el.style.left = Math.round(curX) + 'px'; curX += i.w + gapX; });
  } else if (mode === 'dist-v') {
    if (items.length < 3) { toast('warn', 'Для распределения нужно 3+ элемента'); return; }
    items.sort(function (a, b) { return a.t - b.t; });
    var totalH = items.reduce(function (s, i) { return s + i.h; }, 0);
    var gapY = ((maxB - minT) - totalH) / (items.length - 1);
    var curY = minT;
    items.forEach(function (i) { i.el.style.top = Math.round(curY) + 'px'; curY += i.h + gapY; });
  }
    else if (mode === 'same-w') {
    var targetW = Math.round(items[0].w);
    items.forEach(function (i) {
      i.el.style.boxSizing = 'border-box';
      i.el.style.width = targetW + 'px';
    });
  } else if (mode === 'same-h') {
    var targetH = Math.round(items[0].h);
    items.forEach(function (i) {
      i.el.style.boxSizing = 'border-box';
      i.el.style.height = targetH + 'px';
    });
  }


  placeOv();
  toast('ok', 'Выравнивание применено (' + items.length + ' эл.)');
}


function duplicateSel() {
  if (!PE.sels.length) { toast('warn', 'Ничего не выделено'); return; }
  if (PE.sels.length === 1 && isScreenEl(PE.sels[0])) { duplicateScreen(); return; }

  // Фильтруем вложенных потомков, если выделен их родитель
  var targets = PE.sels.filter(function (el) {
    return el && !isScreenEl(el) && !PE.sels.some(function (p) { return p !== el && p.contains(el); });
  });
  if (!targets.length) return;

  snapshot();
  var clones = [];
  var totalMoved = 0;
  var totalCanon = 0;
  var scale = PE.scale || 1;
  var isGroup = targets.length > 1;

  // Замеряем позиции до изменения DOM (если копируем группу — сразу ставим сдвиг +20px)
  var plans = targets.map(function (el) {
    var cs = getComputedStyle(el);
    var abs = cs.position === 'absolute' || cs.position === 'fixed';
    var parent = el.parentElement;
    var rEl = el.getBoundingClientRect();
    var rPar = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 };
    return {
      el: el,
      abs: abs,
      l: abs ? (parseFloat(el.style.left) || el.offsetLeft) : Math.round((rEl.left - rPar.left) / scale),
      t: abs ? (parseFloat(el.style.top) || el.offsetTop) : Math.round((rEl.top - rPar.top) / scale),
      w: Math.round(rEl.width / scale),
      h: Math.round(rEl.height / scale)
    };
  });

  plans.forEach(function (p) {
    syncLiveFields(p.el);
    var c = p.el.cloneNode(true);

   try { delete c._bound; } catch (e) {}
   c.querySelectorAll('*').forEach(function (n) { try { delete n._bound; } catch (e) {} });

    c.removeAttribute('id');
    c.querySelectorAll('[id]').forEach(function (n) { n.removeAttribute('id'); });

    if (PE.newJoinsOnCopy) {
      var map = allocMap(valuesIn(c));
      totalMoved += applyMap(c, map);
    }

    if (canonizeEl(c)) totalCanon++;
    c.querySelectorAll('*').forEach(function (n) { if (canonizeEl(n)) totalCanon++; });

    // Для группы (или уже абсолютных элементов) сдвигаем копию на +20px, чтобы не перекрывала оригинал
    if (isGroup || p.abs) {
      if (p.el.parentElement && getComputedStyle(p.el.parentElement).position === 'static') {
        p.el.parentElement.style.position = 'relative';
      }
      lockParentHeight(p.el);
      c.style.position = 'absolute';
      c.style.left = (p.l + 20) + 'px';
      c.style.top = (p.t + 20) + 'px';
      if (!p.abs) {
        c.style.width = p.w + 'px';
        c.style.height = p.h + 'px';
        c.style.margin = '0';
      }
    }

    p.el.after(c);
    clones.push(c);
  });

  PE.sels = clones;
  placeOv();
  softRebind();
  renderAll();

  var modeNote = PE.newJoinsOnCopy ? ('новых join’ов: ' + totalMoved) : 'старые join сохранены';
  toast('ok', 'Скопировано: ' + clones.length + ' эл. · ' + modeNote + (totalCanon ? ' · алиасов снято ' + totalCanon : ''));
}



function deleteSel() {
  if (!PE.sels.length) { toast('warn', 'Ничего не выделено'); return; }
  snapshot();
  var count = PE.sels.length;
  var p = PE.sels[0].parentElement;
  PE.sels.forEach(function (el) { if (el && el.isConnected) el.remove(); });
  PE.sels = (count === 1 && p && p !== document.body) ? [p] : [];
  PE.textNodes = []; hideOv(); captureBoot(); softRebind(); renderAll();
  toast('info', 'Удалено элементов: ' + count + ' · Ctrl+Z вернёт');
}



/* ===================== РЕЕСТР JOIN ===================== */
function renameJoin(oldV, newV) {
  if (!validJoin(newV)) { toast('err', 'Недопустимое имя: ' + newV); return false; }
  if (registry().has(newV) && newV !== oldV) { toast('err', 'Имя занято: ' + newV); return false; }
  var n = 0, touched = [];
  snapshot();
  panelNodes().forEach(function (el) {
    var hit = false;
    JOIN_ATTRS.forEach(function (a) { if ((el.getAttribute(a) || '').trim() === oldV) { el.setAttribute(a, newV); n++; hit = true; } });
    if (hit) touched.push(el);
  });
  invalidateDiag();
  canonizeAll().forEach(function (el) { if (touched.indexOf(el) < 0) touched.push(el); });
  rebindChanged(touched); renderAll();
  toast('ok', oldV + ' → ' + newV + ' · носителей ' + n);
  return true;
}
function buildMigration() {
  var reg = registry(), rows = [], used = usedSet(), reserved = new Set();
  reg.forEach(function (r, v) {
    if (!isNum(v)) return;
    var el = r.els[0], role = Array.from(r.kinds)[0];
    var base = suggestName(el, role).replace(/_(digital|analog|text|ph|state|mute|readout|meter|save)$/, '');
    var name = ((PE.migPrefix ? PE.migPrefix + '_' : '') + base + '_' + v).replace(/_+/g, '_').toLowerCase();
    if (!NAME_RE.test(name)) name = 'j_' + name.replace(/[^a-z0-9_]/g, '');
    var cand = name, k = 2;
    while (used.has(cand) || reserved.has(cand)) { cand = name + '_' + k; k++; }
    reserved.add(cand); rows.push({ from: v, to: cand });
  });
  PE.mig = rows; return rows;
}
function applyJoinMap(map) {
  var n = 0, touched = [];
  panelNodes().forEach(function (el) {
    var hit = false;
    JOIN_ATTRS.forEach(function (a) { var v = (el.getAttribute(a) || '').trim(); if (v && map.has(v)) { el.setAttribute(a, map.get(v)); n++; hit = true; } });
    if (hit) touched.push(el);
  });
  invalidateDiag();
  canonizeAll().forEach(function (el) { if (touched.indexOf(el) < 0) touched.push(el); });
  rebindChanged(touched);
  return n;
}
function renderJoins() {
  var box = $('pe-joins'); if (!box) return;
  var reg = registry(), all = Array.from(reg.values());
  var dg = diagnostics();
  var dupSet = {}; dg.shared.forEach(function (s) { dupSet[s.value] = true; });
  var bad = all.filter(function (r) { return !validJoin(r.value); });
  var num = all.filter(function (r) { return r.family === 'num'; }).length;
  var list = all.filter(function (r) {
    if (PE.jfam !== 'all' && r.family !== PE.jfam) return false;
    if (PE.jkind !== 'all' && !r.kinds.has(PE.jkind)) return false;
    if (PE.jq && r.value.toLowerCase().indexOf(PE.jq.toLowerCase()) < 0) return false;
    return true;
  }).sort(function (a, b) { return a.value.localeCompare(b.value); });
  var kinds = ['all'].concat(ROLES.map(function (r) { return r.key; }));
  box.innerHTML = screensJoinGroup() + diagGroup(false) +
    '<div class="pe-grp"><h4>Реестр <em>' + all.length + ' · чисел ' + num + '</em></h4><div>' +
    '<div class="pe-row"><input class="pe-inp mono wide" id="pe-jq" placeholder="поиск join…" value="' + esc(PE.jq) + '"></div>' +
    '<div class="pe-row"><label>Семья</label><select class="pe-sel" id="pe-jfam">' +
    ['all','name','num'].map(function (f) { return '<option value="' + f + '"' + (PE.jfam === f ? ' selected' : '') + '>' + (f === 'all' ? 'все' : f === 'name' ? 'именованные' : 'числовые') + '</option>'; }).join('') + '</select></div>' +
    '<div class="pe-row"><label>Роль</label><select class="pe-sel" id="pe-jkind">' +
    kinds.map(function (k) { return '<option value="' + k + '"' + (PE.jkind === k ? ' selected' : '') + '>' + (k === 'all' ? 'все роли' : k) + '</option>'; }).join('') + '</select></div>' +
    (bad.length ? '<div class="pe-stat err">✕ Недопустимых имён: ' + bad.length + '</div>' : '') +
    '</div></div>' +
    '<div class="pe-grp"><h4>Join’ы элементов <em>' + list.length + '</em></h4><div>' +
    (list.length ? list.map(function (r) {
      var hosts = r.els.map(function (e) { var s = e.closest(SCREEN_SEL); return s ? screenId(s) : ''; }).filter(Boolean);
      var uniq = Array.from(new Set(hosts)).slice(0, 2).join(', ');
      var pressCount = r.els.filter(pressable).length;
      var scrCount = r.els.filter(isScreenEl).length;
      return '<div class="pe-jrow' + (validJoin(r.value) ? '' : ' bad') + (dupSet[r.value] ? ' dup' : '') + '" data-v="' + esc(r.value) + '">' +
        '<div class="pe-jhead"><span class="pe-tag ' + r.family + '">' + r.family + '</span>' +
        '<span class="pe-jname">' + esc(r.value) + '</span>' +
        '<span class="pe-kind">' + esc(Array.from(r.kinds).join('/')) + ' · ' + r.els.length +
        (scrCount ? ' · экранов ' + scrCount : '') + (pressCount > 1 ? ' ⚠' + pressCount : '') + '</span></div>' +
        '<div class="pe-kind">' + esc(Array.from(r.attrs).join(', ')) + (uniq ? ' · ' + esc(uniq) : '') + '</div>' +
        '<div class="pe-row"><input class="pe-inp mono wide" data-new value="' + esc(r.value) + '">' +
        '<button class="pe-btn sm pri" data-a="ren">✎</button>' +
        '<button class="pe-btn sm" data-a="copy">⎘</button>' +
        '<button class="pe-btn sm vio" data-a="dup">⧉</button>' +
        '<button class="pe-btn sm" data-a="sel">◎</button></div></div>';
    }).join('') : '<div class="pe-empty">Ничего не найдено</div>') + '</div></div>' +
    '<div class="pe-grp"><h4>Миграция чисел в имена</h4><div>' +
    '<div class="pe-row"><label>Префикс</label><input class="pe-inp mono" id="pe-migp" value="' + esc(PE.migPrefix) + '"></div>' +
    '<div class="pe-row"><button class="pe-btn" id="pe-migbuild" style="flex:1">Построить карту</button>' +
    '<button class="pe-btn pri" id="pe-migapply"' + (PE.mig && PE.mig.length ? '' : ' disabled') + '>Применить</button></div>' +
    (PE.mig && PE.mig.length ? PE.mig.map(function (m, i) {
      return '<div class="pe-row" data-mig="' + i + '"><span class="pe-kind" style="width:38px">' + esc(m.from) + '</span><input class="pe-inp mono wide" data-mto value="' + esc(m.to) + '"></div>';
    }).join('') : '<p class="pe-note">Карта не построена.</p>') +
    '<div class="pe-row"><button class="pe-btn" id="pe-mapexp" style="flex:1">Экспорт карты</button><button class="pe-btn" id="pe-mapimp" style="flex:1">Импорт карты</button></div></div></div>';

  bindGroups(box);
  box.querySelector('#pe-jq').oninput = function (e) { PE.jq = e.target.value; renderJoins(); };
  box.querySelector('#pe-jfam').onchange = function (e) { PE.jfam = e.target.value; renderJoins(); };
  box.querySelector('#pe-jkind').onchange = function (e) { PE.jkind = e.target.value; renderJoins(); };
  box.querySelectorAll('.pe-jrow[data-v]').forEach(function (row) {
    var v = row.dataset.v, rec = reg.get(v);
    row.querySelector('[data-a="ren"]').onclick = function () { renameJoin(v, row.querySelector('[data-new]').value.trim()); };
    row.querySelector('[data-a="copy"]').onclick = function () { copyText(v, 'join скопирован: ' + v); };
    row.querySelector('[data-a="dup"]').onclick = function () { renameJoin(v, nextFree(v, usedSet(), new Set())); };
    row.querySelector('[data-a="sel"]').onclick = function () {
      if (!rec || !rec.els[0]) return;
      var target = rec.els.filter(isScreenEl)[0] || rec.els[0];
      var host = target.closest(SCREEN_SEL);
      if (host && !isOn(host)) showScreen(host);
      if (!PE.on) setEdit(true);
      select(target);
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
  });
  box.querySelector('#pe-migp').onchange = function (e) { PE.migPrefix = e.target.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, ''); PE.mig = null; renderJoins(); };
  box.querySelector('#pe-migbuild').onclick = function () { buildMigration(); renderJoins(); toast('info', 'Карта: ' + (PE.mig ? PE.mig.length : 0)); };
  var ap = box.querySelector('#pe-migapply');
  if (ap) ap.onclick = function () {
    var map = new Map(), bad2 = 0;
    box.querySelectorAll('[data-mig]').forEach(function (r) {
      var to = r.querySelector('[data-mto]').value.trim();
      if (!validJoin(to) || isNum(to)) { bad2++; return; }
      map.set(PE.mig[+r.dataset.mig].from, to);
    });
    if (bad2) { toast('err', 'Недопустимых имён: ' + bad2); return; }
    var seen = new Set(), clash = 0;
    map.forEach(function (v) { if (seen.has(v)) clash++; seen.add(v); });
    if (clash) { toast('err', 'Повторы: ' + clash); return; }
    snapshot();
    var n = applyJoinMap(map);
    PE.mig = null; renderAll();
    toast('ok', 'Мигрировано носителей: ' + n);
  };
  box.querySelector('#pe-mapexp').onclick = function () {
    var obj = {}; (PE.mig || []).forEach(function (m) { obj[m.from] = m.to; });
    if (!Object.keys(obj).length) registry().forEach(function (r, v) { obj[v] = v; });
    download(JSON.stringify(obj, null, 2), 'join-map.json', 'application/json');
  };
  box.querySelector('#pe-mapimp').onclick = function () {
    pickFile('.json', function (txt) {
      try {
        var obj = JSON.parse(txt), map = new Map(), bad3 = 0;
        Object.keys(obj).forEach(function (k) { var v = String(obj[k]).trim(); if (!validJoin(v)) { bad3++; return; } map.set(String(k).trim(), v); });
        if (bad3) { toast('err', 'Недопустимых имён: ' + bad3); return; }
        snapshot();
        var n = applyJoinMap(map);
        renderAll(); toast('ok', 'Карта применена · ' + n);
      } catch (e) { toast('err', 'Импорт: ' + e.message); }
    });
  };
  paintStats();
}

/* ===================== СОСТОЯНИЯ ===================== */
function readStates(el) { try { return JSON.parse(el.getAttribute('data-states') || '[]'); } catch (e) { return []; } }
function writeStates(el, list) {
  el.setAttribute('data-states', JSON.stringify(list));
  el.setAttribute('data-state-type', 'analog');
  if (!el.getAttribute('data-state-join')) el.setAttribute('data-state-join', nextFree(suggestName(el, 'state'), usedSet(), new Set()));
  if (!el.querySelector('[data-role="icon"]')) { var ic = document.createElement('span'); ic.setAttribute('data-role', 'icon'); ic.className = 'av-ico'; el.prepend(ic); }
  if (!el.querySelector('[data-role="label"]')) {
    var lb = document.createElement('span'); lb.setAttribute('data-role', 'label'); lb.className = 'av-label';
    lb.textContent = el.textContent.trim() || 'Состояние';
    Array.from(el.childNodes).forEach(function (n) { if (n.nodeType === 3) n.remove(); });
    el.appendChild(lb);
  }

  ensureStatesRuntime();  

  if (window.AVStates) window.AVStates.apply(el, +(el.getAttribute('data-state-index') || 0));
}
function renderStates() {
  var box = $('pe-states'); if (!box) return;
  if (!PE.sel) { box.innerHTML = '<div class="pe-empty">Выделите кнопку</div>'; return; }
  var el = PE.sel, list = readStates(el);
  box.innerHTML = '<div class="pe-grp"><h4>Многосостоянийная кнопка <em>' + list.length + '</em></h4><div>' +
    '<div class="pe-row"><label>Состояний</label><input class="pe-inp mono" id="pe-n" type="number" min="2" max="8" value="' + (list.length || 3) + '" style="width:60px"><button class="pe-btn pri" id="pe-mk">Создать</button></div>' +
    '<div class="pe-row"><label>Analog join</label><input class="pe-inp mono" id="pe-sj" value="' + esc(el.getAttribute('data-state-join') || '') + '"></div>' +
    '<div class="pe-row"><label>Режим клика</label><select class="pe-sel" id="pe-sm"><option value="cycle">cycle</option><option value="set">set</option></select></div>' +
    '<div class="pe-row"><label>Показать</label><input type="range" class="pe-range" id="pe-sim" min="0" max="' + Math.max(0, list.length - 1) + '" value="' + (+(el.getAttribute('data-state-index') || 0)) + '" style="flex:1;width:auto"><span class="pe-chip" id="pe-simv"><b>' + (el.getAttribute('data-state-index') || 0) + '</b></span></div>' +
    '</div></div>' +
    (list.length ? list.map(function (st, i) {
      var thumb = st.svg ? st.svg : (st.img ? '<img src="' + esc(st.img) + '" alt="">' : '');
      return '<div class="pe-st" data-i="' + i + '"><div class="pe-st-h"><i>' + i + '</i><span>Состояние ' + i + '</span><span class="pe-thumb" data-thumb>' + thumb + '</span></div>' +
        '<div class="pe-row"><label>Подпись</label><input class="pe-inp" data-f="label" value="' + esc(st.label || '') + '"></div>' +
        '<div class="pe-row"><label>Цвет</label><input type="color" data-f="color" value="' + esc(st.color || '#22D3EE') + '" style="width:34px;height:24px;padding:0;border:1px solid var(--pe-line2);border-radius:6px;background:none"><input class="pe-inp" data-f="bg" value="' + esc(st.bg || '') + '" placeholder="фон"></div>' +
        '<div class="pe-row"><button class="pe-btn sm" data-a="file" style="flex:1">📁 PNG</button><button class="pe-btn sm vio" data-a="svg" style="flex:1">✎ SVG</button><button class="pe-btn sm" data-a="clr">✕</button></div>' +
        '<textarea class="pe-ta" data-f="svg" rows="3" spellcheck="false">' + esc(st.svg || st.img || '') + '</textarea></div>';
    }).join('') : '<div class="pe-empty">Нажмите «Создать»</div>');
  box.querySelector('#pe-mk').onclick = function () {
    snapshot();
    var n = Math.max(2, Math.min(8, +box.querySelector('#pe-n').value || 3)), old = readStates(el), next = [];
    var pal = ['#5D7690','#12B981','#22D3EE','#F5A623','#F0455A','#8B5CF6','#3E8BFF','#22C55E'];
    for (var i = 0; i < n; i++) next.push(old[i] || { label: 'Состояние ' + i, color: pal[i] || '#22D3EE' });
    writeStates(el, next); softRebind(); renderAll(); placeOv();
  };
  var sj = box.querySelector('#pe-sj');
  sj.onchange = function () {
    var v = sj.value.trim();
    if (v && !validJoin(v)) { sj.classList.add('bad'); return; }
    sj.classList.remove('bad'); snapshot();
    if (v) el.setAttribute('data-state-join', v); else el.removeAttribute('data-state-join');
    softRebind(); renderJoins();
  };
  var sm = box.querySelector('#pe-sm');
  sm.value = el.getAttribute('data-cmd-mode') === 'set' ? 'set' : 'cycle';
  sm.onchange = function () { snapshot(); el.setAttribute('data-cmd-mode', sm.value); };
  var sim = box.querySelector('#pe-sim');
  var paintSim = function () { sim.style.setProperty('--p', (list.length > 1 ? (+sim.value / (list.length - 1)) * 100 : 0) + '%'); };
  paintSim();
  sim.oninput = function () { paintSim(); box.querySelector('#pe-simv').innerHTML = '<b>' + sim.value + '</b>'; if (window.AVStates) window.AVStates.apply(el, +sim.value); placeOv(); };
  box.querySelectorAll('.pe-st').forEach(function (card) {
    var i = +card.dataset.i;
    var commit = function () {
      var l = readStates(el);
      card.querySelectorAll('[data-f]').forEach(function (f) {
        var k = f.dataset.f, v = f.value;
        if (k === 'svg') { delete l[i].svg; delete l[i].img; if (/^\s*<svg/i.test(v)) l[i].svg = v; else if (v.trim()) l[i].img = v.trim(); }
        else if (v) l[i][k] = v; else delete l[i][k];
      });
      writeStates(el, l);
      card.querySelector('[data-thumb]').innerHTML = l[i].svg || (l[i].img ? '<img src="' + esc(l[i].img) + '" alt="">' : '');
      placeOv();
    };
    card.querySelectorAll('[data-f]').forEach(function (f) { f.onchange = function () { snapshot(); commit(); }; });
    card.querySelector('[data-a="clr"]').onclick = function () { snapshot(); var l = readStates(el); delete l[i].svg; delete l[i].img; writeStates(el, l); renderStates(); };
    card.querySelector('[data-a="svg"]').onclick = function () { var ta = card.querySelector('[data-f="svg"]'); ta.focus(); ta.select(); };
    card.querySelector('[data-a="file"]').onclick = function () {
      pickFile('image/png,image/jpeg,image/svg+xml,image/webp', function (dataUrl) {
        snapshot(); var l = readStates(el); delete l[i].svg; l[i].img = dataUrl;
        writeStates(el, l); renderStates(); placeOv();
      }, true);
    };
  });
}

/* ===================== КОД ===================== */
function renderCode() {
  var box = $('pe-code'); if (!box) return;
  var host = PE.sel ? (isScreenEl(PE.sel) ? PE.sel : PE.sel.closest(SCREEN_SEL)) : null;
  box.innerHTML = '<div class="pe-grp"><h4>Код выделенного <em>' + (PE.sel ? esc(PE.sel.tagName.toLowerCase()) : '—') + '</em></h4><div>' +
    '<textarea class="pe-ta" id="pe-out" rows="12" spellcheck="false"></textarea>' +
        '<div class="pe-row"><button class="pe-btn pri" id="pe-copy" style="flex:1">⧉ Копировать</button><button class="pe-btn amb" id="pe-copy-baked" style="flex:1" title="Скопировать автономный HTML со всеми стилями">⧉ Со стилями</button><button class="pe-btn" id="pe-save" style="flex:1">★ В базу</button></div>' +

    '<div class="pe-row"><button class="pe-btn" id="pe-apply" style="flex:1">Применить правки кода</button></div>' +
    (host ? '<div class="pe-row"><button class="pe-btn vio" id="pe-hostcode" style="flex:1">‹› Код ' + kindLabel(kindOf(host)) + '</button><button class="pe-btn amb" id="pe-hostrx">⎘ RX</button></div>' : '') +
    '</div></div>' +


      '<div class="pe-grp"><h4>Вставить компонент</h4><div>' +
    '<textarea class="pe-ta" id="pe-in" rows="7" spellcheck="false" placeholder="&lt;button data-join-digital=&quot;vol.up&quot;&gt;…"></textarea>' +
    '<div class="pe-row">' +
    '<button class="pe-btn pri" id="pe-ins-float" style="flex:1" title="По центру экрана поверх вёрстки (absolute)">⤢ Поверх</button>' +
    '<button class="pe-btn vio" id="pe-ins-inside" style="flex:1" title="Внутрь выделенного контейнера">↳ Внутрь</button>' +
    '<button class="pe-btn" id="pe-ins-after" style="flex:1" title="Сразу после выделенного элемента">→ После</button>' +
    '</div></div></div>';


  var out = box.querySelector('#pe-out');
  out.value = PE.sel ? cleanElementHTML(PE.sel) : '';
  box.querySelector('#pe-copy').onclick = function () {
    if (!out.value) return;
    copyText(out.value, 'Код в буфере');
  };


  box.querySelector('#pe-copy-baked').onclick = function () {
    if (!PE.sel) return;
    copyText(bakeElementHTML(PE.sel), 'Автономный код со стилями скопирован');
  };
  box.querySelector('#pe-save').onclick = function () {
    if (!PE.sel) return;
    var baked = bakeElementHTML(PE.sel);
    PE.lib.push({ id: 'c' + Date.now(), name: (screenId(PE.sel) || String(PE.sel.className).split(' ')[0] || PE.sel.tagName.toLowerCase()) + ' · ' + new Date().toLocaleTimeString('ru-RU'), html: baked });
    saveLib(); renderLib(); toast('ok', 'Сохранено в базу (со стилями)');
  };


  box.querySelector('#pe-apply').onclick = function () {
    if (!PE.sel) return;
    var w = document.createElement('div'); w.innerHTML = out.value.trim();
    var n = w.firstElementChild; if (!n) { toast('err', 'Не разобрано'); return; }
    snapshot(); PE.sel.replaceWith(n); select(n);
    canonizeAll(); softRebind(); captureBoot(); renderAll();
  };
  var hc = box.querySelector('#pe-hostcode');
  if (hc) hc.onclick = function () { out.value = cleanElementHTML(host); out.focus(); out.select(); };
  var hrx = box.querySelector('#pe-hostrx');
  if (hrx) hrx.onclick = function () { copyText(rxCommandFor(host), 'RX-команда скопирована'); };



  var insertRaw = function (mode) {
    var raw = box.querySelector('#pe-in').value.trim();
    if (!raw) { toast('err', 'Пусто'); return; }
    insertFromLib(raw, mode);
  };
  box.querySelector('#pe-ins-float').onclick = function () { insertRaw('float'); };
  box.querySelector('#pe-ins-inside').onclick = function () { insertRaw('inside'); };
  box.querySelector('#pe-ins-after').onclick = function () { insertRaw('after'); };

}





/* ===================== БИБЛИОТЕКА ===================== */
function loadLib() { try { PE.lib = JSON.parse(localStorage.getItem(LIB_KEY) || '[]'); } catch (e) { PE.lib = []; } }
function saveLib() { try { localStorage.setItem(LIB_KEY, JSON.stringify(PE.lib)); } catch (e) { toast('err', 'Библиотека не сохранена'); } }
function download(text, name, mime) {
  var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
  var u = URL.createObjectURL(blob), a = h('a'); a.href = u; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(u); }, 1200);
}
function pickFile(accept, cb, asDataUrl) {
  var inp = document.createElement('input'); inp.type = 'file'; inp.accept = accept;
  inp.onchange = function () {
    var f = inp.files && inp.files[0]; if (!f) return;
    var r = new FileReader();
    r.onload = function () { cb(String(r.result)); };
    r.onerror = function () { toast('err', 'Не удалось прочитать файл'); };
    if (asDataUrl) r.readAsDataURL(f); else r.readAsText(f);
  };
  inp.click();
}
function insertFromLib(html, mode) {
  var w = document.createElement('div');
  w.innerHTML = html;
  var n = w.firstElementChild;
  if (!n) return;

  if (n.matches(SCREEN_SEL)) {
    var k = kindOf(n), oldId = n.id || (k === 'dialog' ? 'modal' : k === 'saver' ? 'splash' : 'screen');
    askScreenPlacement(nextScreenId(oldId), false, function (newId, pos) {
      snapshot(); insertScreenNode(n, newId, pos, null, false, k);
    }, k);
    return;
  }

  var hostScreen = activeScreen() || PE.root;
  snapshot();

  n.removeAttribute('id');
  n.querySelectorAll('[id]').forEach(function (x) { x.removeAttribute('id'); });
  
  if (PE.newJoinsOnCopy) applyMap(n, allocMap(valuesIn(n)));

  canonizeEl(n);
  n.querySelectorAll('*').forEach(canonizeEl);

  if (mode === 'float') {
    if (getComputedStyle(hostScreen).position === 'static') hostScreen.style.position = 'relative';
    n.style.position = 'absolute';
    n.style.left = '540px';
    n.style.top = '320px';
    n.style.margin = '0';
    n.style.zIndex = '20';
    hostScreen.appendChild(n);
  } else if (mode === 'inside') {
    var targetIn = (PE.sel && !/^(INPUT|IMG|SVG|HR|BR)$/.test(PE.sel.tagName)) ? PE.sel : hostScreen;
    targetIn.appendChild(n);
  } else {
    var targetAfter = (PE.sel && !isScreenEl(PE.sel) && PE.sel !== PE.root) ? PE.sel : null;
    if (targetAfter) targetAfter.after(n);
    else hostScreen.appendChild(n);
  }


if (n.hasAttribute('data-states') || n.querySelector('[data-states]')) {
  ensureStatesRuntime();
}


  select(n);
  softRebind();
  renderAll();
  toast('ok', mode === 'float' ? 'Вставлено поверх экрана (можно двигать)' : mode === 'inside' ? 'Вставлено внутрь блока' : 'Вставлено следом');
}

function renderLib() {
  var box = $('pe-lib'); if (!box) return;
  box.innerHTML = '<div class="pe-grp"><h4>Библиотека <em>' + PE.lib.length + '</em></h4><div>' +
    (PE.lib.length ? PE.lib.map(function (it) {
      return '<div class="pe-jrow" data-id="' + it.id + '">' +
        '<div class="pe-jhead"><b class="pe-jname">' + esc(it.name) + '</b>' +
        '<button class="pe-btn xs" data-a="copy" title="Скопировать HTML">⎘</button>' +
        '<button class="pe-btn xs dgr" data-a="del" title="Удалить">✕</button></div>' +
        '<div class="pe-row">' +
        '<button class="pe-btn sm pri" data-a="float" style="flex:1" title="По центру экрана поверх вёрстки (absolute)">⤢ Поверх</button>' +
        '<button class="pe-btn sm vio" data-a="inside" style="flex:1" title="Внутрь выделенного контейнера">↳ Внутрь</button>' +
        '<button class="pe-btn sm" data-a="after" style="flex:1" title="Сразу после выделенного элемента">→ После</button>' +
        '</div></div>';
    }).join('') : '<div class="pe-empty">Пусто</div>') +
    '<div class="pe-row"><button class="pe-btn" id="pe-lib-exp" style="flex:1">Экспорт JSON</button><button class="pe-btn" id="pe-lib-imp" style="flex:1">Импорт JSON</button></div></div></div>';

  box.querySelectorAll('.pe-jrow[data-id]').forEach(function (row) {
    var it = PE.lib.find(function (x) { return x.id === row.dataset.id; });
    if (!it) return;
    row.querySelector('[data-a="copy"]').onclick = function () { copyText(it.html, 'Скопировано'); };
    row.querySelector('[data-a="del"]').onclick = function () { PE.lib = PE.lib.filter(function (x) { return x.id !== it.id; }); saveLib(); renderLib(); };
    row.querySelector('[data-a="float"]').onclick = function () { insertFromLib(it.html, 'float'); };
    row.querySelector('[data-a="inside"]').onclick = function () { insertFromLib(it.html, 'inside'); };
    row.querySelector('[data-a="after"]').onclick = function () { insertFromLib(it.html, 'after'); };
  });


  box.querySelector('#pe-lib-exp').onclick = function () {
    if (!PE.lib.length) {
      toast('warn', 'База пуста — нечего экспортировать');
      return;
    }
    download(JSON.stringify(PE.lib, null, 2), 'av-components.json', 'application/json');
    toast('ok', 'Экспортировано компонентов: ' + PE.lib.length);
  };


  box.querySelector('#pe-lib-imp').onclick = function () {
    pickFile('.json', function (txt) {
      try {
        var arr = JSON.parse(txt);
        if (!Array.isArray(arr)) throw new Error('ожидался массив');
        PE.lib = PE.lib.concat(arr.map(function (x, i) { return { id: 'i' + Date.now() + i, name: x.name || 'компонент', html: x.html || '' }; }));
        saveLib(); renderLib(); toast('ok', 'Импортировано: ' + arr.length);
      } catch (e) { toast('err', 'Импорт: ' + e.message); }
    });
  };
}

function renderAll() { renderProps(); renderStates(); renderJoins(); renderCode(); fillScreens(); paintBadges(); paintStats(); }
function exportDoc() {
  var html = cleanDocument();
  var name = (document.title || 'panel').replace(/[^\wа-яё.-]+/gi, '_').slice(0, 40) + '.html';
  download(html, name, 'text/html;charset=utf-8');
  var sv = screensOfKind('saver')[0];
  toast('ok', 'Сохранено: ' + name + ' · старт: ' + (PE.bootScreen || 'как в исходнике') + ' · заставка ' + (sv && isOn(sv) ? 'вкл' : 'выкл'));
  setTimeout(verifySaved, 200);
}

/* ===================== ИНТЕРФЕЙС ===================== */
var bar = ui(h('div')); bar.id = 'pe-bar';
bar.innerHTML =
  '<span class="brand"><i></i>Panel Editor</span><div class="pe-acts">' +
  '<button class="pe-btn" id="pe-toggle">✎ Правка</button>' +
  '<select class="pe-sel" id="pe-screen" style="width:250px" title="Страницы, диалоги, заставка — с их join"></select>' +
  '<button class="pe-btn" id="pe-screen-sel" title="Выделить активный экран · S">▣ Экран</button>' +
  '<button class="pe-btn vio ico" id="pe-scr-dup" title="Дублировать экран/диалог">⧉+</button>' +
  '<button class="pe-btn ico" id="pe-scr-copy" title="HTML в буфер">⎘</button>' +
  '<button class="pe-btn ico" id="pe-scr-paste" title="Вставить из буфера">📋</button>' +
  '<button class="pe-btn ico" id="pe-undo" title="Ctrl+Z">↶</button>' +
  '<button class="pe-btn ico" id="pe-redo" title="Ctrl+Y">↷</button>' +
  '<button class="pe-btn vio" id="pe-dup2">⧉ Копия</button>' +
  '<button class="pe-btn" id="pe-detach" title="position:absolute">⇱ Отвязать</button>' +
  '<button class="pe-btn" id="pe-badges-btn" title="Join-ы элементов · J">⌗ Join-ы</button>' +
  '<button class="pe-btn" id="pe-joins2">⌗ Реестр</button>' +
  '<button class="pe-btn" id="pe-code2">‹› Код</button>' +
  '<button class="pe-btn amb" id="pe-offset" title="O">⤢ Отступ</button>' +
  '</div><span class="sp"></span>' +
  '<span class="pe-chip act" id="pe-ajoin" title="Активный экран и его digital join">▣ <b>—</b></span>' +
  '<span class="pe-chip" id="pe-sstat">экраны <b>0</b> · диалоги <b>0</b></span>' +
  '<span class="pe-chip" id="pe-scale">масштаб <b>—</b></span>' +
  '<span class="pe-chip" id="pe-jstat">join <b>0</b></span>' +
  '<span class="pe-chip" id="pe-stat">режим <b>просмотр</b></span>' +
  '<button class="pe-btn pri" id="pe-export">💾 Сохранить</button>' +
  '<button class="pe-btn ico" id="pe-dockbtn" title="Tab">⇥</button>' +
  '<button class="pe-btn ico" id="pe-hide" title="H">▴</button>';
document.body.appendChild(bar);
var handle = ui(h('button')); handle.id = 'pe-handle'; handle.innerHTML = '▾ Panel Editor';
document.body.appendChild(handle);
var dock = ui(h('aside')); dock.id = 'pe-dock';
dock.innerHTML = '<nav class="pe-tabs">' +
  '<button class="pe-tab on" data-t="props">Свойства</button>' +
  '<button class="pe-tab" data-t="joins">Join’ы</button>' +
  '<button class="pe-tab" data-t="states">Состояния</button>' +
  '<button class="pe-tab" data-t="code">Код</button>' +
  '<button class="pe-tab" data-t="lib">База</button>' +
  '</nav><div class="pe-panes">' +
  '<section class="pe-pane on" data-t="props" id="pe-props"></section>' +
  '<section class="pe-pane" data-t="joins" id="pe-joins"></section>' +
  '<section class="pe-pane" data-t="states" id="pe-states"></section>' +
  '<section class="pe-pane" data-t="code" id="pe-code"></section>' +
  '<section class="pe-pane" data-t="lib" id="pe-lib"></section></div>';
document.body.appendChild(dock);
function setTab(t) {
  PE.tab = t;
  dock.querySelectorAll('.pe-tab').forEach(function (b) { b.classList.toggle('on', b.dataset.t === t); });
  dock.querySelectorAll('.pe-pane').forEach(function (p) { p.classList.toggle('on', p.dataset.t === t); });
  dock.classList.add('on'); PE.dock = true; saveUI(); applyLayout(); renderAll();
}
dock.querySelectorAll('.pe-tab').forEach(function (b) { b.onclick = function () { setTab(b.dataset.t); }; });
function syncBar() {
  bar.classList.toggle('pe-hidden', !PE.bar);
  handle.className = 'pe-' + PE.handlePos + (PE.bar ? '' : ' on');
  handle.id = 'pe-handle';
  var ob = $('pe-offset'); if (ob) ob.classList.toggle('on', PE.offset);
  var hb = $('pe-hide'); if (hb) hb.textContent = PE.bar ? '▴' : '▾';
  var bb = $('pe-badges-btn'); if (bb) bb.classList.toggle('on', PE.badges);
}
function setBar(v) { PE.bar = v; syncBar(); applyLayout(); saveUI(); renderProps(); }
function setOffset(v) { PE.offset = v; syncBar(); applyLayout(); saveUI(); renderProps(); }
function setDock(v) { PE.dock = v; dock.classList.toggle('on', v && PE.on); saveUI(); applyLayout(); }
function resetUI() {
  PE.bar = true; PE.offset = true; PE.margin = 12; PE.autoHide = false; PE.handlePos = 'center'; PE.dock = true;
  syncBar(); dock.classList.toggle('on', PE.on); applyLayout(); saveUI(); renderAll();
}
function setEdit(v) {
  PE.on = v;
  document.body.classList.toggle('pe-editing', v);
  $('pe-toggle').classList.toggle('on', v);
  $('pe-toggle').textContent = v ? '✎ Правка: вкл' : '✎ Правка';
  $('pe-stat').innerHTML = 'режим <b>' + (v ? 'правка' : 'просмотр') + '</b>';
  if (v) { PE.root = findRoot(); if (!PE.bar) setBar(true); else { dock.classList.toggle('on', PE.dock); loop(); renderAll(); } }
  else {
    cancelAnimationFrame(PE.raf); PE.raf = 0; hideOv(); PE.sel = null; PE.textNodes = [];
    if (PE.autoHide) { PE.bar = false; syncBar(); saveUI(); }
    dock.classList.toggle('on', PE.dock && !PE.autoHide);
    paintBadges();
  }
  applyLayout(); renderAll();
}
$('pe-toggle').onclick = function () { setEdit(!PE.on); };
$('pe-undo').onclick = doUndo;
$('pe-redo').onclick = doRedo;
$('pe-dup2').onclick = duplicateSel;
$('pe-detach').onclick = detachFromFlow;
$('pe-screen-sel').onclick = selectActiveScreen;
$('pe-ajoin').onclick = selectActiveScreen;
$('pe-badges-btn').onclick = function () { setBadges(!PE.badges); renderProps(); };
$('pe-joins2').onclick = function () { if (!PE.on) setEdit(true); setTab('joins'); };
$('pe-code2').onclick = function () { if (!PE.on) setEdit(true); setTab('code'); };
$('pe-offset').onclick = function () { setOffset(!PE.offset); };
$('pe-export').onclick = exportDoc;
$('pe-dockbtn').onclick = function () { setDock(!PE.dock); };
$('pe-hide').onclick = function () { setBar(false); };
handle.onclick = function () { setBar(true); };
$('pe-screen').onchange = function (e) { var s = screens()[+e.target.value]; if (s) { showScreen(s, true); setTab('props'); } };
$('pe-scr-dup').onclick = duplicateScreen;
$('pe-scr-copy').onclick = copyScreenHTML;
$('pe-scr-paste').onclick = pasteScreenHTML;

window.addEventListener('keydown', function (e) {
  var t = e.target;
  if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); doUndo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); exportDoc(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (PE.on && PE.sels.length && !PE.sels.some(isScreenEl) && /^Arrow(Up|Down|Left|Right)$/.test(e.key)) {
    e.preventDefault();
    if (!e.repeat) { snapshot(); snapCache = null; }
    var step = e.shiftKey ? 10 : 1;
    var dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    var dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;

    // 1. Исключаем элементы, чей родитель тоже находится в выделении
    var targets = PE.sels.filter(function (el) {
      return !PE.sels.some(function (p) { return p !== el && p.contains(el); });
    });

    // 2. Фаза чтения: замеряем позиции ВСЕХ элементов до изменения DOM
    var scale = PE.scale || 1;
    var plan = targets.map(function (el) {
      var cs = getComputedStyle(el);
      if (cs.position === 'static') {
        var parent = el.parentElement;
        if (parent && getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
        var rEl = el.getBoundingClientRect(), rPar = parent.getBoundingClientRect();
        return {
          el: el,
          detach: true,
          x: Math.round((rEl.left - rPar.left) / scale),
          y: Math.round((rEl.top - rPar.top) / scale),
          w: Math.round(rEl.width / scale),
          h: Math.round(rEl.height / scale)
        };
      }
      return {
        el: el,
        detach: false,
        x: parseFloat(el.style.left) || 0,
        y: parseFloat(el.style.top) || 0
      };
    });

    // 3. Фаза записи: применяем новые координаты ко всем разом
    plan.forEach(function (p) {
      if (p.detach) {
        lockParentHeight(p.el); 
        p.el.style.position = 'absolute';
        p.el.style.width = p.w + 'px';
        p.el.style.height = p.h + 'px';
        p.el.style.margin = '0';
      }
      p.el.style.left = (p.x + dx) + 'px';
      p.el.style.top = (p.y + dy) + 'px';
    });

    placeOv();
    showGuidesForEl(targets);
    return;
  }

  var k = e.key.toLowerCase();
  if (k === 'e') { e.preventDefault(); setEdit(!PE.on); }
  else if (k === 'h') { e.preventDefault(); setBar(!PE.bar); }
  else if (k === 'o') { e.preventDefault(); setOffset(!PE.offset); }
  else if (k === 'j') { e.preventDefault(); setBadges(!PE.badges); renderProps(); }
  else if (k === 's') { e.preventDefault(); selectActiveScreen(); }
  else if (e.key === 'Escape' && PE.on) setEdit(false);
  else if (e.key === 'Tab' && PE.on) { e.preventDefault(); setDock(!PE.dock); }
  else if (e.key === 'Delete' && PE.on && PE.sel) { e.preventDefault(); deleteSel(); }
});
window.addEventListener('resize', function () { applyLayout(); placeOv(); paintBadges(); });
window.addEventListener('scroll', function () { placeOv(); positionBadges(); }, true);
document.addEventListener('av:rebuild', function () { setTimeout(function () { paintBadges(); paintStats(); }, 40); });
document.addEventListener('av:list', function () { setTimeout(function () { paintBadges(); paintStats(); }, 80); });
document.addEventListener('av:page', function () { setTimeout(function () { fillScreens(); paintBadges(); }, 340); });
document.addEventListener('av:digital', function () { setTimeout(function () { fillScreens(); paintBadges(); }, 60); });

loadLib(); renderLib(); syncBar();
dock.classList.toggle('on', PE.dock && PE.on);
PE.root = findRoot();
captureBoot(true);
applyLayout(); renderAll(); syncUndo(); fillScreens();
setTimeout(function () {
  var changed = canonizeAll();
  if (changed.length) { rebindChanged(changed); renderAll(); toast('warn', 'Снято лишних join-атрибутов: ' + changed.length); }
  var missing = fixScreenJoins();
  if (missing.length) { softRebind(); renderAll(); toast('warn', 'Экранам без join выдан join из ID: ' + missing.length); }
  var d = diagnostics(true);
  if (d.shared.length) toast('warn', 'Общий digital join у ' + d.shared.length + ' групп — вкладка Join’ы → Развести');
  else {
    var a = activeScreen();
    toast('ok', 'Panel Editor v4.4.1 · join экранов виден в чипе ▣' + (a ? ': D ' + (screenJoin(a) || '—') : ''));
  }
}, 400);
})();