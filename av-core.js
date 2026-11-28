/* =====================================================================================
   AVDEN-Studio · AV-CORE · v3.1.1 «Dual Transport»
   Controller-First Runtime для AV-панелей · сменные транспорты · декларативный DOM

   Copyright 2026 Вяхирев Алексей Алексеевич (Alexey A. Vyakhirev)
   Licensed under the Apache License, Version 2.0 (see LICENSE and NOTICE)

   ПОДКЛЮЧЕНИЕ:
   <script src="av-core.js"></script>
   <script src="panel-editor.js" id="pe-script"></script> <!-- опционально, для правки -->

   ТРАНСПОРТЫ (?transport=ws|crestron|mock или data-transport на #panel-stage):
   • ws       — универсальный JSON WebSocket (?ws=ws://host:port/path)
   • crestron — CrComLib / WebXPanel (?host=...&ipId=0x03&port=49200&authToken=...)
   • mock     — локальный имитатор ответов контроллера (демо и отладка)

   ПУБЛИЧНЫЙ API (window.Panel):
   • Panel.send(type, join, val)      — отправка сигнала контроллеру (TX)
   • Panel.receive(msg | type, j, v)  — приём сигнала от контроллера (RX)
   • Panel.setDigital / setAnalog / setString / setSmart(join, val) — обновление UI без TX
   • Panel.showPage(id) / back()      — навигация по экранам (data-screen)
   • Panel.openDialog(id) / closeDialog(id) — управление модальными окнами (data-dialog)
   • Panel.wake() / sleep()           — пробуждение / переход на заставку (#splash)
   • Panel.list(join).set/add/remove/select(...) — управление динамическими списками
   • Panel.use(mode, cfg) / connect / disconnect / resync — управление транспортом
   • Panel.setJoinMap(obj) / joinMap() — таблица соответствия имён и числовых join-ов
   • Panel.rebuild() / fit()          — перепривязка DOM и масштабирование сцены
   • Panel.diagnostics() / stats()    — диагностика привязок и состояния моста

   1. Исправлено - увод курсора мыши с кнопки без выдачи joun = 0
   2. Убрано появление меню при удержании пальца на сенсорных экранах
   3. Поддержка одновременного digital и state-analog join на мультикнопках

   ===================================================================================== */


(function () {
  'use strict';
  if (window.__avCoreLoaded) return;
  window.__avCoreLoaded = true;

  /* ===================== КОНФИГУРАЦИЯ И СОСТОЯНИЕ ===================== */
  var CORE_VERSION = '3.1.1';
  var DEFAULT_WS = 'ws://192.168.1.49:1880/socket';
  var ACTIVE_TOKENS = ['is-active', 'active', 'is-open', 'open', 'visible', 'is-visible', 'show', 'shown'];
  var DEFAULT_LIST_COLORS = ['#2DD4BF', '#38BDF8', '#E879F9', '#FBBF24', '#34D399', '#A78BFA', '#F97316'];
  var MAX_OUTBOX = 80;

  var state = {
    version: CORE_VERSION,
    transport: 'auto',
    wsUrl: DEFAULT_WS,
    host: '', ipId: '',
    online: false,
    bridgeReady: false,
    manualOffline: false,
    awake: true,
    activePage: null,
    pageHistory: [],
    digital: Object.create(null),
    analog: Object.create(null),
    analogRaw: Object.create(null),
    string: Object.create(null),
    smart: Object.create(null),
    lists: Object.create(null),
    selectedListItem: Object.create(null),
    routes: Object.create(null),
    camPoses: Object.create(null),
    soundEnabled: true,
    clockControlled: false,
    echo: false,
    analogScaleDefault: 1,
    smartSerial: false
  };

  var outbox = [];
  var pageMap = new Map();
  var dialogMap = new Map();
  var autoStrCounter = 300;
  var autoDigCounter = 900;
  var audioCtx = null;
  var clockTimer = null;
  var logSubscribers = [];
  var utf8Decoder = (typeof TextDecoder !== 'undefined') ? new TextDecoder('utf-8', { fatal: true }) : null;

  var joinMap = Object.create(null);
  var reverseMap = Object.create(null);
  var warnedLocal = new Set();

  /* ===================== УТИЛИТЫ ===================== */
  function emit(name, detail) {
    try { document.dispatchEvent(new CustomEvent('av:' + name, { detail: detail })); } catch (e) {}
  }
  function normJoin(j) { return j == null ? '' : String(j).trim(); }
  function isNum(v) { return /^\d+$/.test(String(v)); }
  function formatJoinOut(j) { var s = normJoin(j); return isNum(s) ? Number(s) : s; }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  function getAttr(el, names) {
    for (var i = 0; i < names.length; i++) {
      var v = el.getAttribute(names[i]);
      if (v != null && v.trim() !== '') return v.trim();
    }
    return '';
  }
  function getDigitalJoin(el) { return getAttr(el, ['data-join-digital', 'data-digital-join', 'data-cmd-join']); }
  function getAnalogJoin(el) { return getAttr(el, ['data-join-analog', 'data-analog-join']); }
  function getStringJoin(el) { return getAttr(el, ['data-join-string', 'data-text-join']); }
  function isEditorNode(el) { return !!(el && el.closest && el.closest('[data-pe-ui]')); }

  function isLockedText(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hasAttribute('data-join-string') || el.hasAttribute('data-text-join')) return false;
    return el.hasAttribute('data-text-lock') || !!(el.closest && el.closest('[data-text-lock]'));
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toBool(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    var s = String(v).trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'on' || s === 'yes';
  }
  function parseJSONAttr(el, attr) {
    if (!el) return null;
    var raw = el.getAttribute(attr);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { console.warn('[AV] некорректный JSON в ' + attr, e); return null; }
  }
  function fixUtf8FromLatin1(str) {
    if (!utf8Decoder || !str || !/[\u0080-\u00FF]/.test(str)) return str;
    try {
      var bytes = new Uint8Array(str.length);
      for (var i = 0; i < str.length; i++) {
        var code = str.charCodeAt(i);
        if (code > 255) return str;
        bytes[i] = code;
      }
      return utf8Decoder.decode(bytes);
    } catch (e) { return str; }
  }
  function stageRoot() { return document.querySelector('[data-panel-root], #panel-stage'); }
  function urlParams() { return new URLSearchParams(window.location.search); }

  /* ===================== ЗВУКОВОЙ ОТКЛИК ===================== */
  function playFeedbackSound(kind) {
    if (!state.soundEnabled) return;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    try {
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var now = audioCtx.currentTime;
      var osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
      osc.connect(gain); gain.connect(audioCtx.destination);
      if (kind === 'success') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, now);
        osc.frequency.setValueAtTime(880.00, now + 0.08);
        gain.gain.setValueAtTime(0.06, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        osc.start(now); osc.stop(now + 0.23);
      } else if (kind === 'error') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(220, now);
        osc.frequency.setValueAtTime(165, now + 0.09);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
        osc.start(now); osc.stop(now + 0.26);
      } else {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(920, now);
        osc.frequency.exponentialRampToValueAtTime(420, now + 0.025);
        gain.gain.setValueAtTime(0.045, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
        osc.start(now); osc.stop(now + 0.035);
      }
    } catch (e) {}
  }

  /* ===================== КАРТА JOIN’ОВ ===================== */
  function normalizeMapEntry(v) {
    if (v == null) return null;
    if (typeof v === 'number' || (typeof v === 'string' && isNum(v))) return { n: String(v), t: '', scale: 1, smart: false };
    if (typeof v === 'object') {
      var n = v.n != null ? String(v.n) : (v.join != null ? String(v.join) : '');
      if (!isNum(n)) return null;
      return {
        n: n,
        t: v.t || v.type ? String(v.t || v.type).toLowerCase().charAt(0) : '',
        scale: Number(v.scale) > 0 ? Number(v.scale) : 1,
        smart: !!v.smart
      };
    }
    return null;
  }
  function rebuildReverse() {
    reverseMap = Object.create(null);
    Object.keys(joinMap).forEach(function (name) {
      ['b', 'n', 's'].forEach(function (t) {
        var e = joinMap[name];
        if (e.t && e.t !== t) return;
        var key = t + ':' + e.n;
        if (!reverseMap[key]) reverseMap[key] = [];
        if (reverseMap[key].indexOf(name) < 0) reverseMap[key].push(name);
      });
    });
  }
  function setJoinMap(obj, silent) {
    if (!obj || typeof obj !== 'object') return 0;
    var count = 0;
    Object.keys(obj).forEach(function (name) {
      var e = normalizeMapEntry(obj[name]);
      if (!e) return;
      if (e.scale === 1 && state.analogScaleDefault !== 1) e.scaleForAnalog = state.analogScaleDefault;
      joinMap[normJoin(name)] = e;
      count++;
    });
    rebuildReverse();
    if (!silent) { resubscribe(); emit('joinmap', { count: count }); }
    return count;
  }
  function loadConfigFromMarkup() {
    var root = stageRoot() || document.documentElement;
    var m = parseJSONAttr(document.querySelector('[data-join-map]'), 'data-join-map');
    if (m) setJoinMap(m, true);
    var gs = Number(root.getAttribute('data-analog-scale'));
    state.analogScaleDefault = gs > 0 ? gs : 1;
    state.smartSerial = root.hasAttribute('data-smart-serial');
  }

  function crTypeOf(type) {
    var t = String(type).toLowerCase();
    if (t === 'digital' || t === 'd' || t === 'b') return 'b';
    if (t === 'analog' || t === 'a' || t === 'n') return 'n';
    return 's';
  }
  function resolveOut(type, join) {
    var name = normJoin(join), t = crTypeOf(type), mapped = joinMap[name];
    if (mapped) {
      var mt = mapped.t || t;
      var sc = mt === 'n' ? (mapped.scale !== 1 ? mapped.scale : (mapped.scaleForAnalog || state.analogScaleDefault)) : 1;
      return { n: mapped.n, t: mt, scale: sc, smart: mapped.smart, name: name };
    }
    if (isNum(name)) return { n: name, t: t, scale: t === 'n' ? state.analogScaleDefault : 1, smart: false, name: name };
    return null;
  }
  function resolveIn(crType, n) {
    var names = reverseMap[crType + ':' + String(n)];
    if (names && names.length) {
      return names.map(function (name) {
        var e = joinMap[name];
        var sc = crType === 'n' ? (e.scale !== 1 ? e.scale : (e.scaleForAnalog || state.analogScaleDefault)) : 1;
        return { name: name, scale: sc, smart: e.smart };
      });
    }
    return [{ name: String(n), scale: crType === 'n' ? state.analogScaleDefault : 1, smart: false }];
  }

  /* ===================== СЛОЙ ТРАНСПОРТА ===================== */
  var driver = null;
  var driverApi = null;

  function status(online, text) {
    state.online = !!online;
    setDigital('ctrl.online', online ? 1 : 0);
    setString('ctrl.status', text || (online ? 'Контроллер · онлайн' : 'Контроллер · офлайн'));
    emit('ws', { online: state.online, text: text, url: state.wsUrl, transport: state.transport });
  }
  function enqueue(msg, r) {
    outbox.push({ msg: msg, r: r });
    if (outbox.length > MAX_OUTBOX) outbox.shift();
  }
  function flushOutbox() {
    if (!driverApi || !outbox.length || state.manualOffline) return;
    if (driverApi.state && !driverApi.state().open) return;
    var pending = outbox.splice(0, outbox.length);
    for (var i = 0; i < pending.length; i++) {
      try { driverApi.publish(pending[i].msg, pending[i].r); }
      catch (e) { enqueue(pending[i].msg, pending[i].r); break; }
    }
  }

  function sendControlSignal(type, join, value, extra) {

  if (type && typeof type === 'object') {
    var m = type;
    var v = m.value !== undefined ? m.value : (m.val !== undefined ? m.val : m.text);
    return sendControlSignal(m.type, m.join, v, m.ts ? { ts: m.ts } : null);
  }
    var jStr = normJoin(join);
    if (!jStr) return;
    var msg = Object.assign({ type: String(type), join: formatJoinOut(join), value: value, ts: Date.now() }, extra || {});
    emit('log', { dir: 'TX', msg: msg });
    logSubscribers.forEach(function (fn) { try { fn({ dir: 'TX', msg: msg }); } catch (e) {} });
    if (state.echo) simulateControllerEcho(msg);

    var r = resolveOut(type, jStr);
    if (!driverApi) { enqueue(msg, r); return msg; }
    if (driverApi.caps.named && !r) r = { n: jStr, t: crTypeOf(type), scale: 1, smart: true, name: jStr };
    if (!r) {
      if (!warnedLocal.has(jStr)) {
        warnedLocal.add(jStr);
        console.info('[AV] join «' + jStr + '» локальный: нет числа в data-join-map для режима ' + state.transport);
      }
      return msg;
    }
    if (state.manualOffline) { enqueue(msg, r); return msg; }
    try { driverApi.publish(msg, r); } catch (e) { enqueue(msg, r); }
    return msg;
  }

  function receiveControlSignal(msgOrType, join, value) {
    var msg = (typeof msgOrType === 'object' && msgOrType !== null) ? msgOrType : { type: msgOrType, join: join, value: value };
    if (!msg || !msg.type || msg.join == null) return;
    emit('log', { dir: 'RX', msg: msg });
    logSubscribers.forEach(function (fn) { try { fn({ dir: 'RX', msg: msg }); } catch (e) {} });
    var t = String(msg.type).toLowerCase(), j = normJoin(msg.join);
    var v = msg.value !== undefined ? msg.value : (msg.val !== undefined ? msg.val : msg.text);
    if (t === 'digital' || t === 'd' || t === 'b') setDigital(j, v);
    else if (t === 'analog' || t === 'a' || t === 'n') setAnalog(j, v);
    else if (t === 'string' || t === 's' || t === 'text') setString(j, v);
    else if (t === 'smart' || t === 'm') setSmart(j, v, msg);
  }

  /* сбор всех join’ов разметки — нужен драйверам с подпиской */
  function collectJoinRefs() {
    var refs = [];
    var push = function (el, name, type) { if (name && !isEditorNode(el)) refs.push({ name: normJoin(name), type: type }); };
    document.querySelectorAll('[data-join-digital],[data-digital-join],[data-cmd-join],[data-mute-join],[data-power-for],[data-preset-save],[data-enter-join]')
      .forEach(function (el) {
        push(el, getDigitalJoin(el), 'digital');
        push(el, el.getAttribute('data-mute-join'), 'digital');
        push(el, el.getAttribute('data-power-for'), 'digital');
        push(el, el.getAttribute('data-preset-save'), 'digital');
        push(el, el.getAttribute('data-enter-join'), 'digital');
      });
    document.querySelectorAll('[data-join-analog],[data-analog-join],[data-readout-for],[data-meter-for],[data-brightness-for],[data-state-join]')
      .forEach(function (el) {
        push(el, getAnalogJoin(el), 'analog');
        push(el, getAttr(el, ['data-readout-for', 'data-meter-for', 'data-brightness-for', 'data-state-join']), 'analog');
      });
    document.querySelectorAll('[data-join-string],[data-text-join],[data-join-placeholder],[data-char-join]')
      .forEach(function (el) {
        push(el, getStringJoin(el), 'string');
        push(el, el.getAttribute('data-join-placeholder'), 'string');
        push(el, el.getAttribute('data-char-join'), 'string');
      });
    document.querySelectorAll('[data-join-smart],[data-list-join]').forEach(function (el) {
      push(el, el.getAttribute('data-join-smart'), 'smart');
      push(el, el.getAttribute('data-list-join'), 'smart');
    });
    Object.keys(joinMap).forEach(function (name) {
      var t = joinMap[name].t;
      refs.push({ name: name, type: t === 'b' ? 'digital' : t === 'n' ? 'analog' : 'string' });
    });
    return refs;
  }
  function resubscribe() {
    if (driverApi && typeof driverApi.subscribe === 'function') driverApi.subscribe(collectJoinRefs(), resolveOut, onDriverRx);
  }
  function onDriverRx(crType, n, raw) {
    resolveIn(crType, n).forEach(function (t) {
      if (crType === 'b') receiveControlSignal('digital', t.name, raw ? 1 : 0);
      else if (crType === 'n') receiveControlSignal('analog', t.name, Number(raw) / (t.scale || 1));
      else {
        var str = raw == null ? '' : fixUtf8FromLatin1(String(raw));
        var routed = false;
        if (t.smart || state.smartSerial) {
          var s = str.trim();
          if (s.charAt(0) === '{' || s.charAt(0) === '[') {
            try { var o = JSON.parse(s); if (o && typeof o === 'object') { receiveControlSignal('smart', t.name, o); routed = true; } } catch (e) {}
          }
        }
        if (!routed) receiveControlSignal('string', t.name, str);
      }
    });
  }

  /* ---------- ДРАЙВЕР: универсальный JSON WebSocket ---------- */
  function driverWS() {
    var ws = null, retry = null, attempts = 0, manual = false, url = DEFAULT_WS;
    function connect(cfg) {
      cfg = cfg || {};
      var p = urlParams();
      var root = stageRoot() || document.documentElement;
      url = cfg.url || p.get('ws') || root.getAttribute('data-ws-url') || DEFAULT_WS;
      state.wsUrl = url;
      manual = false;
      clearTimeout(retry);
      if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} ws = null; }
      status(false, 'Подключение…');
      try { ws = new WebSocket(url); } catch (e) { status(false, 'Ошибка адреса WS'); schedule(); return; }
      ws.onopen = function () {
        attempts = 0;
        status(true, 'Контроллер · онлайн');
        flushOutbox();
        sendControlSignal('smart', 'panel.hello', { panel: document.title || 'AV-Panel', version: CORE_VERSION, page: state.activePage || '' });
      };
      ws.onmessage = function (ev) {
        try {
          var d = JSON.parse(ev.data);
          (Array.isArray(d) ? d : [d]).forEach(receiveControlSignal);
        } catch (e) { console.warn('[AV] не-JSON от контроллера', ev.data); }
      };
      ws.onerror = function () {};
      ws.onclose = function () { ws = null; status(false, 'Контроллер · офлайн'); if (!manual) schedule(); };
    }
    function schedule() {
      clearTimeout(retry); attempts++;
      retry = setTimeout(function () { connect({ url: url }); }, Math.min(10000, 1500 * Math.pow(1.6, Math.min(attempts, 6))));
    }
    return {
      name: 'ws',
      caps: { named: true, smart: true, analogMax: 100, serialMax: 0, subscription: false },
      connect: connect,
      disconnect: function () {
        manual = true; clearTimeout(retry);
        if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} ws = null; }
        status(false, 'Отключено');
      },
      publish: function (msg) {
        if (!ws || ws.readyState !== 1) throw new Error('ws closed');
        ws.send(JSON.stringify({ type: msg.type, join: msg.join, value: msg.value }));
      },
      subscribe: function () {},
      state: function () { return { open: !!(ws && ws.readyState === 1), url: url }; }
    };
  }

  /* ---------- ДРАЙВЕР: Crestron CrComLib / WebXPanel ---------- */
  function driverCrestron() {
    var subscribed = { b: new Set(), n: new Set(), s: new Set() };
    var wxpInitialized = false;
    function connect(cfg) {
      cfg = cfg || {};
      var p = urlParams();
      var host = cfg.host || p.get('host') || window.location.hostname || '';
      var ipId = cfg.ipId || p.get('ipId') || '0x03';
      var port = Number(cfg.port || p.get('port')) || 49200;
      var roomId = cfg.roomId || p.get('roomId') || '';
      var authToken = cfg.authToken || p.get('authToken') || '';
      state.host = host; state.ipId = ipId;
      state.wsUrl = host ? ('wss://' + host + ':' + port + ' (IP-ID ' + ipId + ')') : 'локальный мост';

      var WXP = window.WebXPanel;
      var inContainer = WXP && typeof WXP.runsInContainerApp === 'function' ? WXP.runsInContainerApp() : false;
      var pkg = WXP && typeof WXP.getWebXPanel === 'function' ? WXP.getWebXPanel(!inContainer) : null;
      var wxp = pkg && (pkg.WebXPanel || pkg.default || pkg);
      var ev = (pkg && pkg.WebXPanelEvents) || {};

      if (inContainer) {
        state.bridgeReady = !!window.CrComLib;
        status(state.bridgeReady, state.bridgeReady ? 'Crestron · панель' : 'Ожидание CrComLib');
      } else if (wxp && typeof wxp.initialize === 'function') {
        if (!wxpInitialized) {
          wxpInitialized = true;
          if (pkg && typeof pkg.enableDebugging === 'function' && p.get('debug') === '1') pkg.enableDebugging();
          var conf = pkg.WebXPanelConfigParams || {};
          conf.host = host; conf.ipId = ipId; conf.port = port;
          conf.tokenUrl = 'https://' + host + '/cws/websocket/getWebSocketToken';
          if (roomId) conf.roomId = roomId;
          if (authToken) conf.authToken = authToken;
          try { wxp.initialize(conf); } catch (e) { console.error('[WebXPanel] initialize', e); }
          wxp.addEventListener(ev.CONNECT_CIP || 'connect-cip', function () {
            state.bridgeReady = true; status(true, 'Crestron · онлайн'); resubscribe(); flushOutbox();
          });
          wxp.addEventListener(ev.DISCONNECT_CIP || 'disconnect-cip', function () { status(false, 'Crestron · офлайн'); });
          wxp.addEventListener(ev.ERROR_WS || 'error-ws', function (e) { console.error('[WebXPanel WS]', e); status(false, 'Ошибка WebXPanel WS'); });
          wxp.addEventListener(ev.NOT_AUTHORIZED || 'not-authorized', function () { status(false, 'Нужен authToken'); });
        }
        state.bridgeReady = !!window.CrComLib;
        if (!state.online) status(state.bridgeReady, state.bridgeReady ? 'Crestron · мост готов' : 'Подключение к процессору…');
      } else {
        state.bridgeReady = !!window.CrComLib;
        status(false, state.bridgeReady ? 'CrComLib без WebXPanel' : 'Ожидание моста CrComLib');
      }
      resubscribe();
    }
    return {
      name: 'crestron',
      caps: { named: false, smart: false, analogMax: 65535, serialMax: 255, subscription: true },
      connect: connect,
      disconnect: function () {
        if (window.CrComLib && typeof window.CrComLib.unsubscribeState === 'function') {
          ['b', 'n', 's'].forEach(function (t) {
            subscribed[t].forEach(function (n) { try { window.CrComLib.unsubscribeState(t, n); } catch (e) {} });
            subscribed[t].clear();
          });
        } else { subscribed.b.clear(); subscribed.n.clear(); subscribed.s.clear(); }
        status(false, 'Crestron · отключено');
      },
      publish: function (msg, r) {
        if (!window.CrComLib) throw new Error('no CrComLib');
        if (r.t === 'b') window.CrComLib.publishEvent('b', r.n, toBool(msg.value));
        else if (r.t === 'n') window.CrComLib.publishEvent('n', r.n, Math.round((Number(msg.value) || 0) * (r.scale || 1)));
        else {
          var payload = (String(msg.type).toLowerCase() === 'smart' && msg.value != null && typeof msg.value === 'object')
            ? JSON.stringify(msg.value) : (msg.value == null ? '' : String(msg.value));
          window.CrComLib.publishEvent('s', r.n, payload);
        }
      },
      subscribe: function (refs, resolve, onRx) {
        if (!window.CrComLib) return;
        var seen = new Set();
        refs.forEach(function (ref) {
          var r = resolve(ref.type, ref.name);
          if (!r) return;
          var key = r.t + ':' + r.n;
          if (seen.has(key) || subscribed[r.t].has(r.n)) return;
          seen.add(key);
          subscribed[r.t].add(r.n);
          var t = r.t, n = r.n;
          try { window.CrComLib.subscribeState(t, n, function (val) { onRx(t, n, val); }); }
          catch (e) { subscribed[t].delete(n); }
        });
      },
      resync: function () { subscribed.b.clear(); subscribed.n.clear(); subscribed.s.clear(); resubscribe(); },
      state: function () { return { open: state.online, url: state.wsUrl, subscribed: { b: subscribed.b.size, n: subscribed.n.size, s: subscribed.s.size } }; }
    };
  }

  /* ---------- ДРАЙВЕР: локальный имитатор ---------- */
  function driverMock() {
    return {
      name: 'mock',
      caps: { named: true, smart: true, analogMax: 100, serialMax: 0, subscription: false },
      connect: function () { state.wsUrl = 'mock://local'; status(true, 'Демо · имитатор'); },
      disconnect: function () { status(false, 'Демо · выключено'); },
      publish: function (msg) { setTimeout(function () { simulateControllerEcho(msg, true); }, 60); },
      subscribe: function () {},
      state: function () { return { open: state.online, url: 'mock://local' }; }
    };
  }

  var DRIVERS = { ws: driverWS, crestron: driverCrestron, mock: driverMock };

  function detectMode() {
    var p = urlParams();
    var forced = p.get('transport') || (stageRoot() || document.documentElement).getAttribute('data-transport');
    if (forced && DRIVERS[forced]) return forced;
    if (window.CrComLib || window.WebXPanel) return 'crestron';
    return 'ws';
  }
  function useTransport(mode, cfg) {
    mode = mode === 'auto' || !mode ? detectMode() : mode;
    if (!DRIVERS[mode]) { console.warn('[AV] неизвестный транспорт', mode); return false; }
    if (driverApi && typeof driverApi.disconnect === 'function') { try { driverApi.disconnect(); } catch (e) {} }
    outbox.length = 0;
    warnedLocal.clear();
    state.transport = mode;
    state.manualOffline = false;
    driver = DRIVERS[mode];
    driverApi = driver();
    driverApi.connect(cfg || {});
    emit('transport', { mode: mode, caps: driverApi.caps });
    return true;
  }

  /* ===================== СЕТТЕРЫ (БЕЗ TX) ===================== */
  function setDigital(join, val) {
    var j = normJoin(join);
    if (!j) return;
    var on = toBool(val);
    state.digital[j] = on ? 1 : 0;
    if (j === 'panel.sound') setSoundEnabled(on);

    var splash = document.querySelector('[data-screensaver], #splash');
    if (splash && getDigitalJoin(splash) === j) { if (on) wakePanel(); else sleepPanel(); }
    if (pageMap.has(j)) {
      var pages = pageMap.get(j);
      if (on && pages.length) activatePageElement(pages[0], false, false);
      else if (!on && pages.some(function (p) { return p.classList.contains('is-active'); })) sleepPanel();
    }
    if (dialogMap.has(j)) {
      dialogMap.get(j).forEach(function (dlg) { if (on) openDialogElement(dlg, false); else closeDialogElement(dlg, false); });
    }

    document.querySelectorAll('[data-join-digital],[data-digital-join],[data-cmd-join]').forEach(function (el) {
      if (isEditorNode(el)) return;
      if (el.matches('[data-screen],.av-page,[data-dialog],.av-modal,[data-screensaver],#splash')) return;
      if (getDigitalJoin(el) !== j) return;
      el.classList.toggle('is-active', on);
      if (el.hasAttribute('aria-pressed')) el.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (el.hasAttribute('aria-checked')) el.setAttribute('aria-checked', on ? 'true' : 'false');
      if (on && el.hasAttribute('data-radio-group') && window.AVRadio) window.AVRadio.apply(el);
      var iOn = el.getAttribute('data-icon-on'), iOff = el.getAttribute('data-icon-off');
      if (iOn || iOff) {
        var use = el.querySelector('use'), target = on ? iOn : iOff;
        if (use && target) { use.setAttribute('href', target); use.setAttribute('xlink:href', target); }
      }
      var lOn = el.getAttribute('data-label-on'), lOff = el.getAttribute('data-label-off');
      if (lOn != null || lOff != null) {
        var lbl = el.querySelector('[data-toggle-label],.av-toggle-label');
        if (lbl && !isLockedText(lbl)) lbl.textContent = on ? (lOn || 'Вкл') : (lOff || 'Выкл');
      }
    });
    document.querySelectorAll('[data-mute-join]').forEach(function (ch) {
      if (!isEditorNode(ch) && normJoin(ch.getAttribute('data-mute-join')) === j) ch.classList.toggle('is-muted', on);
    });


  document.querySelectorAll('[data-visibility],[data-visibility-join]').forEach(function (blk) {
    if (isEditorNode(blk)) return;
    var vj = normJoin(blk.getAttribute('data-visibility-join'));
    if (vj ? vj !== j : getDigitalJoin(blk) !== j) return;
    var mode = blk.getAttribute('data-visibility');
    blk.classList.toggle('hidden', !on);
    blk.toggleAttribute('data-vis-hidden', !on);
    if (mode && mode !== 'block' && mode !== '1' && mode !== 'true') blk.classList.toggle(mode, on);
  });


    document.querySelectorAll('[data-power-for]').forEach(function (el) {
      if (!isEditorNode(el) && normJoin(el.getAttribute('data-power-for')) === j) el.classList.toggle('is-off', !on);
    });
    emit('digital', { join: j, value: on ? 1 : 0 });
  }

  function setAnalog(join, val) {
    var j = normJoin(join);
    if (!j) return;
    var num = Number(val); if (isNaN(num)) num = 0;
    state.analogRaw[j] = num;
    var clamped = clamp(num, 0, 100);
    state.analog[j] = clamped;

    document.querySelectorAll('input[type="range"]').forEach(function (inp) {
      if (isEditorNode(inp) || getAnalogJoin(inp) !== j) return;
      var min = Number(inp.min || 0), max = Number(inp.max || 100);
      var shown = clamp(num, min, max);
      inp.value = String(shown);
      var pct = max > min ? ((shown - min) / (max - min)) * 100 : 0;
      inp.style.setProperty('--fill', clamp(pct, 0, 100) + '%');
    });
    document.querySelectorAll('[data-readout-for]').forEach(function (el) {
      if (isEditorNode(el) || isLockedText(el)) return;
      if (normJoin(el.getAttribute('data-readout-for')) === j) el.textContent = Math.round(num) + (el.getAttribute('data-suffix') || '');
    });
    document.querySelectorAll('[data-meter-for]').forEach(function (el) {
      if (isEditorNode(el) || normJoin(el.getAttribute('data-meter-for')) !== j) return;
      el.style.setProperty('--meter', clamped + '%');
      if (el.dataset.meterAxis === 'y') el.style.height = clamped + '%'; else el.style.width = clamped + '%';
      el.classList.toggle('is-live', clamped > 0);
    });
    document.querySelectorAll('[data-brightness-for]').forEach(function (el) {
      if (isEditorNode(el) || normJoin(el.getAttribute('data-brightness-for')) !== j) return;
      el.style.filter = 'brightness(' + (0.45 + clamped / 100 * 0.75).toFixed(2) + ')';
    });
    if (window.AVStates && typeof window.AVStates.rx === 'function') window.AVStates.rx(j, Math.round(num));
    else document.querySelectorAll('[data-states]').forEach(function (el) {
      if (!isEditorNode(el) && getAttr(el, ['data-state-join', 'data-cmd-join']) === j) applyMultiStateLocal(el, Math.round(num));
    });
    emit('analog', { join: j, value: num });
  }

  function setString(join, text) {
    var j = normJoin(join);
    if (!j) return;
    var str = text == null ? '' : fixUtf8FromLatin1(String(text));
    state.string[j] = str;
    if (/^sys\.(time|date|datetime|weekday|date\.week|date\.long)$/.test(j)) state.clockControlled = true;
    document.querySelectorAll('[data-join-string],[data-text-join]').forEach(function (el) {
      if (isEditorNode(el) || getStringJoin(el) !== j) return;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') { if (el.value !== str) el.value = str; }
      else if (!el.hasAttribute('data-text-lock')) el.textContent = str;
    });
    document.querySelectorAll('[data-join-placeholder]').forEach(function (el) {
      if (!isEditorNode(el) && normJoin(el.getAttribute('data-join-placeholder')) === j) el.setAttribute('placeholder', str);
    });
    emit('string', { join: j, value: str });
  }

  function setSmart(join, payload, rawMsg) {
    var j = normJoin(join);
    if (!j) return;
    var data = payload;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) {} }
    state.smart[j] = data;

    if (j === 'panel.beep') { playFeedbackSound(typeof data === 'string' ? data : (data && data.kind)); return; }

    if (/^cam\.pose\.(\d+)$/i.test(j) && data && typeof data === 'object') {
      state.camPoses[j] = data;
      var sgn = function (v) { var n = Math.round(Number(v) || 0); return (n >= 0 ? '+' : '−') + Math.abs(n); };
      document.querySelectorAll('[data-cam-pose="' + j + '"]').forEach(function (el) {
        if (isEditorNode(el)) return;
        var p = el.querySelector('[data-pose-pan]'), t = el.querySelector('[data-pose-tilt]'), z = el.querySelector('[data-pose-zoom]');
        if (p && data.pan != null && !isLockedText(p)) p.textContent = sgn(data.pan);
        if (t && data.tilt != null && !isLockedText(t)) t.textContent = sgn(data.tilt);
        if (z && data.zoom != null && !isLockedText(z)) z.textContent = Number(data.zoom).toFixed(1);
      });
      document.querySelectorAll('[data-pose-scene="' + j + '"]').forEach(function (sc) {
        if (isEditorNode(sc)) return;
        var pan = Number(data.pan) || 0, tilt = Number(data.tilt) || 0, zoom = Number(data.zoom) || 1;
        sc.style.transform = 'translate(' + (-pan * 1.05).toFixed(1) + 'px,' + (-tilt).toFixed(1) + 'px) scale(' + zoom + ')';
      });
      emit('smart', { join: j, value: data }); return;
    }
    if (j === 'routes' && data && typeof data === 'object') {
      Object.keys(data).forEach(function (d) { state.routes[d] = data[d]; });
      renderRoutes(); emit('smart', { join: j, value: data }); return;
    }
    var rm = j.match(/^route\.([A-Za-z0-9_-]+)$/);
    if (rm) { state.routes[rm[1]] = data; renderRoutes(); emit('smart', { join: j, value: data }); return; }

    var pm = j.match(/^preset\.([A-Za-z0-9_-]+)\.(\d+)$/);
    if (pm && data && typeof data === 'object') {
      if (data.label != null) setString(j + '.label', String(data.label));
      if (data.saved != null) setDigital(j + '.saved', data.saved ? 1 : 0);
      emit('smart', { join: j, value: data }); return;
    }
    var sm = j.match(/^(.+)\.selected$/);
    if (sm) {
      var target = sm[1] === '500' ? 'phonebook' : sm[1];
      var key = (data && typeof data === 'object') ? (data.number || data.id || data.key) : data;
      state.selectedListItem[target] = key != null ? fixUtf8FromLatin1(String(key)).trim() : null;
      highlightSelectedListRow(target);
      emit('smart', { join: j, value: data }); return;
    }
    if (data && typeof data === 'object' && typeof data.action === 'string') {
      handleListSmart(j === '500' ? 'phonebook' : j, data); return;
    }
    emit('smart', { join: j, value: data });
  }

  /* ===================== НАВИГАЦИЯ ===================== */
  function scanScreens() {
    pageMap.clear(); dialogMap.clear();
    document.querySelectorAll('[data-screen],.av-page').forEach(function (el) {
      if (isEditorNode(el)) return;
      var j = getDigitalJoin(el); if (!j) return;
      if (!pageMap.has(j)) pageMap.set(j, []);
      pageMap.get(j).push(el);
    });
    document.querySelectorAll('[data-dialog],.av-modal,#shutdown-overlay').forEach(function (el) {
      if (isEditorNode(el)) return;
      var j = getDigitalJoin(el); if (!j) return;
      if (!dialogMap.has(j)) dialogMap.set(j, []);
      dialogMap.get(j).push(el);
    });
  }
  function findScreen(idOrJoin, selector) {
    if (!idOrJoin) return null;
    var byId = document.getElementById(idOrJoin);
    if (byId && !isEditorNode(byId)) return byId;
    var list = document.querySelectorAll(selector);
    for (var i = 0; i < list.length; i++) {
      if (isEditorNode(list[i])) continue;
      if (list[i].getAttribute('data-screen') === idOrJoin ||
          list[i].getAttribute('data-dialog') === idOrJoin ||
          getDigitalJoin(list[i]) === String(idOrJoin)) return list[i];
    }
    return null;
  }
  function activatePageElement(target, emitTx, pushHistory) {
    if (!target || isEditorNode(target)) return;
    var prev = null;
    document.querySelectorAll('[data-screen],.av-page').forEach(function (pg) {
      if (isEditorNode(pg)) return;
      if (pg !== target && pg.classList.contains('is-active')) {
        prev = pg;
        ACTIVE_TOKENS.forEach(function (c) { pg.classList.remove(c); });
        if (pg.hasAttribute('data-screen') && !pg.classList.contains('av-page')) pg.classList.add('hidden');
      }
    });
    if (pushHistory && prev) {
      var pid = prev.id || prev.getAttribute('data-screen'), nid = target.id || target.getAttribute('data-screen');
      if (pid && pid !== nid) { state.pageHistory.push(pid); if (state.pageHistory.length > 20) state.pageHistory.shift(); }
    }
    target.classList.remove('hidden', 'is-hidden');
    target.classList.add('is-active');
    if (target.classList.contains('page')) target.classList.add('active');
    var splash = document.querySelector('[data-screensaver], #splash');
    if (splash && !splash.classList.contains('is-hidden')) splash.classList.add('is-hidden');
    state.awake = true;
    state.activePage = target.id || target.getAttribute('data-screen') || '';
    var navKey = target.getAttribute('data-nav-key') || target.id;
    document.querySelectorAll('[data-nav]').forEach(function (btn) {
      if (isEditorNode(btn)) return;
      var t = btn.getAttribute('data-nav');
      btn.classList.toggle('is-current', t === target.id || t === navKey);
    });
    updateVerticalSliders(target);
    if (emitTx) {
      if (prev) { var oj = getDigitalJoin(prev); if (oj) sendControlSignal('digital', oj, 0); }
      var nj = getDigitalJoin(target); if (nj) sendControlSignal('digital', nj, 1);
    }
    emit('page', { id: state.activePage });
  }
  function openDialogElement(dlg, emitTx) {
    if (!dlg || isEditorNode(dlg)) return;
    dlg.classList.remove('hidden', 'is-hidden');
    dlg.classList.add('is-active');
    if (dlg.classList.contains('overlay') || dlg.hasAttribute('data-drawer')) dlg.classList.add('is-open');
    updateVerticalSliders(dlg);
    if (emitTx) { var j = getDigitalJoin(dlg); if (j) sendControlSignal('digital', j, 1); }
    emit('dialog', { id: dlg.id || dlg.getAttribute('data-dialog'), open: true });
  }
  function closeDialogElement(dlg, emitTx) {
    if (!dlg || isEditorNode(dlg)) return;
    ACTIVE_TOKENS.forEach(function (c) { dlg.classList.remove(c); });
    if (emitTx) { var j = getDigitalJoin(dlg); if (j) sendControlSignal('digital', j, 0); }
    emit('dialog', { id: dlg.id || dlg.getAttribute('data-dialog'), open: false });
  }
  function showPage(id) { var el = findScreen(id, '[data-screen],.av-page'); if (el) activatePageElement(el, true, true); }
  function goBack() {
    while (state.pageHistory.length) {
      var pid = state.pageHistory.pop(), el = findScreen(pid, '[data-screen],.av-page');
      if (el && !el.classList.contains('is-active')) { activatePageElement(el, true, false); return; }
    }
    var home = document.getElementById('page-home') || document.querySelector('[data-screen],.av-page');
    if (home) activatePageElement(home, true, false);
  }
  function openDialog(id) { var el = findScreen(id, '[data-dialog],.av-modal,#shutdown-overlay'); if (el) openDialogElement(el, true); }
  function closeDialog(id) {
    if (!id) {
      document.querySelectorAll('[data-dialog].is-active,.av-modal.is-active,#shutdown-overlay.is-active').forEach(function (d) {
        if (!isEditorNode(d)) closeDialogElement(d, true);
      });
      return;
    }
    var el = findScreen(id, '[data-dialog],.av-modal,#shutdown-overlay');
    if (el) closeDialogElement(el, true);
  }
  function isDialogActive(id) { var el = findScreen(id, '[data-dialog],.av-modal,#shutdown-overlay'); return !!(el && el.classList.contains('is-active')); }
  function wakePanel() {
    state.awake = true;
    var splash = document.querySelector('[data-screensaver], #splash');
    if (splash) splash.classList.add('is-hidden');
    if (!document.querySelector('[data-screen].is-active,.av-page.is-active')) {
      var first = document.querySelector('[data-screen],.av-page');
      if (first) activatePageElement(first, false, false);
    }
    emit('wake', { awake: true });
  }
  function sleepPanel() {
    state.awake = false;
    var splash = document.querySelector('[data-screensaver], #splash');
    if (splash) splash.classList.remove('is-hidden');
    emit('wake', { awake: false });
  }

  /* ===================== КОМПОНЕНТЫ ===================== */
  function applyMultiStateLocal(el, idx) {
    var list = [];
    try { list = JSON.parse(el.getAttribute('data-states') || '[]'); } catch (e) {}
    if (!list.length) return;
    idx = Math.max(0, Math.min(list.length - 1, idx | 0));
    var st = list[idx] || {};
    el.setAttribute('data-state-index', String(idx));
    var lab = el.querySelector('[data-role="label"]');
    if (lab && st.label != null && !isLockedText(lab)) lab.textContent = st.label;
    var ico = el.querySelector('[data-role="icon"]');
    if (ico) {
      if (st.svg) ico.innerHTML = st.svg;
      else if (st.img) ico.innerHTML = '<img alt="" src="' + escapeHtml(st.img) + '">';
      else ico.innerHTML = '';
    }
    if (st.color) el.style.setProperty('--st-c', st.color);
    if (st.bg) el.style.setProperty('--st-bg', st.bg);
    el.setAttribute('aria-pressed', idx > 0 ? 'true' : 'false');
  }
  function updateVerticalSliders(scope) {
    (scope || document).querySelectorAll('.vslider-wrap').forEach(function (w) {
      if (isEditorNode(w)) return;
      var h = w.clientHeight;
      if (h > 0) w.style.setProperty('--vlen', h + 'px');
    });
  }
  function fitStage() {
    var stage = stageRoot();
    if (!stage) return;
    var w = parseFloat(stage.getAttribute('data-width')) || parseFloat(stage.style.width) || 0;
    var h = parseFloat(stage.getAttribute('data-height')) || parseFloat(stage.style.height) || 0;
    if (!w || !h) {
      var cs = getComputedStyle(stage);
      if (cs.width.endsWith('px') && cs.height.endsWith('px')) {
        var cw = parseFloat(cs.width), ch = parseFloat(cs.height);
        if (cw > 0 && ch > 0 && (Math.abs(cw - window.innerWidth) > 2 || Math.abs(ch - window.innerHeight) > 2)) { w = cw; h = ch; }
      }
    }
    if (!w || !h) { document.documentElement.style.setProperty('--stage-scale', '1'); return; }
    var scale = Math.min(window.innerWidth / w, window.innerHeight / h);
    document.documentElement.style.setProperty('--stage-scale', String(scale));
    stage.style.position = 'fixed';
    stage.style.left = '50%'; stage.style.top = '50%';
    stage.style.width = w + 'px'; stage.style.height = h + 'px';
    stage.style.transformOrigin = 'center center';
    stage.style.transform = 'translate(-50%, -50%) scale(' + scale + ')';
    emit('stage', { scale: scale, width: w, height: h });
  }

  /* ===================== ПРИВЯЗКА ===================== */
  function activateTab(el) {
    var target = el.getAttribute('data-tab-target');
    if (!target) return;
    var scopeSel = el.getAttribute('data-tab-scope');
    var scope = scopeSel ? document.querySelector(scopeSel) : el.closest('[data-screen],.av-page,[data-dialog],.av-modal');
    if (!scope) scope = document;
    var group = scopeSel ? scope.querySelector('[data-tabs]') : (el.closest('[data-tabs]') || el.parentElement);
    if (group) group.querySelectorAll('[data-tab-target]').forEach(function (t) {
      t.classList.toggle('is-current', t.getAttribute('data-tab-target') === target);
    });
    scope.querySelectorAll('[data-tab-panel]').forEach(function (p) {
      p.classList.toggle('hidden', p.getAttribute('data-tab-panel') !== target);
    });
    updateVerticalSliders(scope);
    emit('tab', { target: target });
  }


  function bindButtons() {
    var sel = 'button,[role="button"],[data-join-digital],[data-digital-join],[data-cmd-join],[data-nav],[data-nav-back],[data-nav-dialog],[data-screensaver],#splash';
    document.querySelectorAll(sel).forEach(function (el) {
      if (isEditorNode(el) || el._bound) return;
      if (el.matches('[data-screen],.av-page,[data-dialog],.av-modal,input,textarea,select')) return;
      el._bound = true;
      var digJoin = el.hasAttribute('data-states')
        ? getAttr(el, ['data-join-digital', 'data-digital-join'])
        : getDigitalJoin(el);
      var saveJoin = el.getAttribute('data-preset-save');
      var isLatch = el.hasAttribute('data-latch'), isLocal = el.hasAttribute('data-local');
      var holdTimer = null, holdFired = false;

      function down(e) {
        if (e && e.type === 'pointerdown' && e.button !== 0) return;
        if (el.disabled) return;

        if (e && e.pointerId != null && el.setPointerCapture) {
          try { el.setPointerCapture(e.pointerId); } catch (err) {}
        }
        el.classList.add('is-pressed');
        holdFired = false;
        playFeedbackSound('tick');
        if (saveJoin) {
          el.classList.add('is-holding');
          holdTimer = setTimeout(function () {
            holdFired = true; el.classList.remove('is-holding'); playFeedbackSound('success');
            sendControlSignal('digital', saveJoin, 1);
            setTimeout(function () { sendControlSignal('digital', saveJoin, 0); }, 120);
          }, 3000);
          return;
        }
        if (digJoin) {
          if (isLatch) {
            var next = state.digital[digJoin] ? 0 : 1;
            sendControlSignal('digital', digJoin, next);
            if (isLocal) setDigital(digJoin, next);
          } else sendControlSignal('digital', digJoin, 1);
        }
        var ch = el.getAttribute('data-char') || el.getAttribute('data-pw-char') || el.getAttribute('data-dtmf-char');
        if (ch != null) {
          var t = el.hasAttribute('data-pw-char') ? 'pw.char' : el.hasAttribute('data-dtmf-char') ? 'dtmf.char' : (el.getAttribute('data-char-join') || 'dial.char');
          sendControlSignal('string', t, ch);
        }
      }


      function up(e) {
        // 2. Освобождаем захват указателя
        if (e && e.pointerId != null && el.releasePointerCapture) {
          try {
            if (el.hasPointerCapture && el.hasPointerCapture(e.pointerId)) {
              el.releasePointerCapture(e.pointerId);
            }
          } catch (err) {}
        }

        if (!el.classList.contains('is-pressed')) return;
        el.classList.remove('is-pressed', 'is-holding');
        if (saveJoin) {
          clearTimeout(holdTimer);
          if (!holdFired && digJoin) {
            sendControlSignal('digital', digJoin, 1);
            setTimeout(function () { sendControlSignal('digital', digJoin, 0); }, 100);
          }
          return;
        }
        if (digJoin && !isLatch) sendControlSignal('digital', digJoin, 0);
      }


      el.addEventListener('pointerdown', down);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('lostpointercapture', up);
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { if (e.repeat) return; e.preventDefault(); down(e); } });
      el.addEventListener('keyup', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); up(); } });
      el.addEventListener('click', function () {
        if (el.hasAttribute('data-screensaver') || el.id === 'splash') { wakePanel(); return; }
        if (el.hasAttribute('data-nav-reset')) state.pageHistory.length = 0;
        var nav = el.getAttribute('data-nav'); if (nav) showPage(nav);
        if (el.hasAttribute('data-nav-back')) goBack();
        var nd = el.getAttribute('data-nav-dialog');
        if (nd) { if (el.hasAttribute('data-nav-toggle') && isDialogActive(nd)) closeDialog(nd); else openDialog(nd); }
        if (el.hasAttribute('data-dialog-close')) {
          var host = el.closest('[data-dialog],.av-modal,#shutdown-overlay');
          if (host) closeDialogElement(host, true);
        }
        if (el.hasAttribute('data-sound-toggle')) setSoundEnabled(!state.soundEnabled);
        if (el.getAttribute('data-tab-target')) activateTab(el);
      });
    });
  }




  function bindSliders() {
    document.querySelectorAll('input[type="range"]').forEach(function (inp) {
      if (isEditorNode(inp) || inp._bound) return;
      inp._bound = true;
      var join = getAnalogJoin(inp), last = 0;
      function paint() {
        var v = Number(inp.value || 0), min = Number(inp.min || 0), max = Number(inp.max || 100);
        var pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
        inp.style.setProperty('--fill', clamp(pct, 0, 100) + '%');
        if (join) document.querySelectorAll('[data-readout-for="' + join + '"]').forEach(function (ro) {
          if (!isEditorNode(ro) && !isLockedText(ro)) ro.textContent = Math.round(v) + (ro.getAttribute('data-suffix') || '');
        });
      }
      paint();
      if (join && state.analog[join] == null) state.analog[join] = Number(inp.value || 0);
      inp.addEventListener('input', function () {
        paint(); if (!join) return;
        state.analog[join] = Number(inp.value);
        var now = Date.now();
        if (now - last >= 80) { last = now; sendControlSignal('analog', join, Number(inp.value)); }
      });
      inp.addEventListener('change', function () {
        paint(); if (!join) return;
        last = Date.now(); state.analog[join] = Number(inp.value);
        sendControlSignal('analog', join, Number(inp.value));
      });
    });
  }
  function bindInputsAndSearch() {
    document.querySelectorAll('[data-list-search],[data-book-search]').forEach(function (inp) {
      if (isEditorNode(inp) || inp._bound) return;
      inp._bound = true;
      var target = inp.getAttribute('data-list-search') || 'phonebook';
      inp.addEventListener('input', function () { filterList(target, inp.value); });
    });
    document.querySelectorAll('input[type="text"],textarea').forEach(function (inp) {
      if (isEditorNode(inp) || inp._bound || inp.hasAttribute('data-list-search') || inp.hasAttribute('data-book-search')) return;
      var sj = getStringJoin(inp);
      if (!sj || inp.readOnly) return;
      inp._bound = true;
      var t = null;
      inp.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { sendControlSignal('string', sj, inp.value); }, 220); });
      inp.addEventListener('change', function () { clearTimeout(t); sendControlSignal('string', sj, inp.value); });
    });
  }
  function bindPhysicalKeyboard() {
    if (window._avKeyBound) return;
    window._avKeyBound = true;
    window.addEventListener('keydown', function (e) {
      if (document.body.classList.contains('pe-editing')) return;
      var tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      var scope = document.querySelector('[data-dialog].is-active,.av-modal.is-active') ||
                  document.querySelector('[data-screen].is-active,.av-page.is-active');
      if (!scope) return;
      if (e.key === 'Escape') { closeDialog(); return; }
      if (e.key === 'Enter') {
        var ej = scope.getAttribute('data-enter-join');
        if (ej) {
          e.preventDefault();
          sendControlSignal('digital', ej, 1);
          setTimeout(function () { sendControlSignal('digital', ej, 0); }, 140);
          return;
        }
      }
      var map = { 'Backspace': 'backspace', 'Delete': 'C' };
      var ch = map[e.key] || (/^[0-9*#.]$/.test(e.key) ? e.key : null);
      if (!ch) return;
      var btn = scope.querySelector('[data-char="' + ch + '"],[data-pw-char="' + ch + '"],[data-dtmf-char="' + ch + '"]');
      if (btn) {
        e.preventDefault();
        btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        setTimeout(function () { btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 })); }, 90);
      }
    });
  }

  /* ===================== МУЛЬТИ-СПИСКИ ===================== */
  function getListContainers(j) {
    var arr = Array.from(document.querySelectorAll('[data-list-join="' + j + '"]')).filter(function (el) { return !isEditorNode(el); });
    if (j === 'phonebook') {
      var legacy = document.getElementById('book-list');
      if (legacy && !isEditorNode(legacy) && arr.indexOf(legacy) < 0) arr.push(legacy);
    }
    return arr;
  }
  function normalizeListItem(j, raw, idx) {
    var key = raw.number != null ? fixUtf8FromLatin1(String(raw.number)).trim()
      : (raw.id != null ? fixUtf8FromLatin1(String(raw.id)).trim() : String(idx + 1));
    var def = (j === 'phonebook') ? ('book.' + key) : (j + '.' + key);
    return {
      key: key,
      name: fixUtf8FromLatin1(String(raw.name || raw.title || 'Элемент')),
      desc: fixUtf8FromLatin1(String(raw.desc || raw.subtitle || '')),
      number: raw.number != null ? fixUtf8FromLatin1(String(raw.number)).trim() : key,
      join: (raw.join != null && String(raw.join).trim() !== '') ? String(raw.join).trim() : def
    };
  }
  function cleanupListState(j, keys) {
    var prefix = (j === 'phonebook') ? 'book' : j;
    keys.forEach(function (k) {
      delete state.string[prefix + '.' + k + '.name'];
      delete state.string[prefix + '.' + k + '.desc'];
      delete state.string[prefix + '.' + k + '.number'];
    });
  }
  function handleListSmart(listJoin, payload) {
    var j = normJoin(listJoin) || 'phonebook';
    if (!state.lists[j]) state.lists[j] = [];
    var arr = state.lists[j], act = String(payload.action || '').toLowerCase();
    if (act === 'set' && Array.isArray(payload.items)) {
      cleanupListState(j, arr.map(function (x) { return x.key; }));
      state.lists[j] = payload.items.map(function (raw, i) { return normalizeListItem(j, raw, i); });
    } else if (act === 'clear') {
      cleanupListState(j, arr.map(function (x) { return x.key; }));
      state.lists[j] = []; state.selectedListItem[j] = null;
    } else if (act === 'add') {
      var inc = Array.isArray(payload.items) ? payload.items : (payload.item ? [payload.item] : []);
      inc.forEach(function (raw) {
        var item = normalizeListItem(j, raw, arr.length);
        if (!item.key) return;
        var pos = arr.findIndex(function (x) { return x.key === item.key; });
        if (pos >= 0) arr[pos] = Object.assign({}, arr[pos], item); else arr.push(item);
      });
    } else if (act === 'remove') {
      var key = payload.number != null ? fixUtf8FromLatin1(String(payload.number)).trim()
        : (payload.id != null ? fixUtf8FromLatin1(String(payload.id)).trim() : null);
      if (key != null) {
        cleanupListState(j, [key]);
        state.lists[j] = arr.filter(function (x) { return x.key !== key; });
        if (state.selectedListItem[j] === key) state.selectedListItem[j] = null;
      } else if (payload.index != null) {
        var i = Number(payload.index) - 1;
        if (i >= 0 && i < arr.length) {
          var rem = arr.splice(i, 1)[0];
          if (rem) { cleanupListState(j, [rem.key]); if (state.selectedListItem[j] === rem.key) state.selectedListItem[j] = null; }
        }
      }
    }
    renderList(j);
    rebuild();
    emit('list', { join: j, action: act, count: (state.lists[j] || []).length });
  }
  function getListTemplate(j) {
    var tpl = document.querySelector('template[data-list-template="' + j + '"]');
    return tpl && tpl.content ? tpl.content.firstElementChild : null;
  }
  function buildListRow(j, item, idx, colors) {
    var prefix = (j === 'phonebook') ? 'book' : j;
    var tpl = getListTemplate(j), row;
    if (tpl) row = tpl.cloneNode(true);
    else {
      row = document.createElement('button');
      row.type = 'button';
      row.className = 'book-item list-item';
      row.innerHTML = '<div class="book-info"><span class="book-name" data-field="name"></span><span class="book-desc" data-field="desc"></span></div><span class="book-num" data-field="number"></span>';
    }
    row.setAttribute('data-item-key', item.key);
    row.setAttribute('data-book-number', item.number);
    row.setAttribute('data-join-digital', item.join);
    if (row.tagName === 'BUTTON' && !row.hasAttribute('type')) row.setAttribute('type', 'button');
    var color = colors[idx % colors.length];
    row.style.setProperty('--ava', color);
    row.style.setProperty('--acc', color);
    var fields = { name: item.name, desc: item.desc, number: item.number };
    Object.keys(fields).forEach(function (f) {
      var el = row.querySelector('[data-field="' + f + '"]');
      if (!el) return;
      if (!getStringJoin(el)) el.setAttribute('data-join-string', prefix + '.' + item.key + '.' + f);
      if (!isLockedText(el)) el.textContent = fields[f];
      state.string[prefix + '.' + item.key + '.' + f] = fields[f];
    });
    var ini = row.querySelector('[data-field="initials"],[data-field="avatar"]');
    if (ini) ini.textContent = item.name.split(/\s+/).slice(0, 2).map(function (w) { return w[0] || ''; }).join('').toUpperCase();
    return row;
  }
  function renderList(j) {
    j = normJoin(j);
    var items = state.lists[j] || [], prefix = (j === 'phonebook') ? 'book' : j;
    getListContainers(j).forEach(function (listEl) {
      var colors = (listEl.getAttribute('data-list-colors') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      if (!colors.length) colors = DEFAULT_LIST_COLORS;
      var existing = new Map();
      Array.from(listEl.querySelectorAll('[data-item-key],[data-book-number]')).forEach(function (row) {
        var k = row.getAttribute('data-item-key') || row.getAttribute('data-book-number');
        if (k) existing.set(k, row);
      });
      var frag = document.createDocumentFragment();
      items.forEach(function (item, idx) {
        var row = existing.get(item.key);
        if (!row) row = buildListRow(j, item, idx, colors);
        else {
          row.setAttribute('data-join-digital', item.join);
          row.style.setProperty('--ava', colors[idx % colors.length]);
          row.style.setProperty('--acc', colors[idx % colors.length]);
          ['name', 'desc', 'number'].forEach(function (f) {
            var el = row.querySelector('[data-field="' + f + '"]') || row.querySelector('[data-join-string="' + prefix + '.' + item.key + '.' + f + '"]');
            if (el && !isLockedText(el)) el.textContent = item[f];
            state.string[prefix + '.' + item.key + '.' + f] = item[f];
          });
          var ini = row.querySelector('[data-field="initials"],[data-field="avatar"]');
          if (ini) ini.textContent = item.name.split(/\s+/).slice(0, 2).map(function (w) { return w[0] || ''; }).join('').toUpperCase();
        }
        frag.appendChild(row);
      });
      listEl.innerHTML = '';
      listEl.appendChild(frag);
    });
    highlightSelectedListRow(j);
    setString(prefix + '.count', String(items.length));
    var si = document.querySelector('[data-list-search="' + j + '"]') || (j === 'phonebook' ? document.querySelector('[data-book-search]') : null);
    filterList(j, si ? si.value : '');
  }
  function highlightSelectedListRow(j) {
    var key = state.selectedListItem[j];
    getListContainers(j).forEach(function (listEl) {
      listEl.querySelectorAll('[data-item-key],[data-book-number]').forEach(function (row) {
        var k = row.getAttribute('data-item-key') || row.getAttribute('data-book-number');
        row.classList.toggle('is-active', key != null && k === key);
      });
    });
  }
  function filterList(j, query) {
    var q = String(query || '').trim().toLowerCase(), containers = getListContainers(j);
    if (!containers.length) return;
    var visible = 0;
    containers.forEach(function (listEl) {
      listEl.querySelectorAll('[data-item-key],[data-book-number]').forEach(function (row) {
        var hit = !q || row.textContent.toLowerCase().indexOf(q) >= 0;
        row.classList.toggle('hidden', !hit);
        if (hit) visible++;
      });
    });
    var sel = '[data-list-empty="' + j + '"]' + (j === 'phonebook' ? ',[data-book-empty]' : '');
    document.querySelectorAll(sel).forEach(function (el) { if (!isEditorNode(el)) el.classList.toggle('hidden', visible > 0); });
  }

  /* ===================== КОММУТАЦИЯ ===================== */
  function renderRoutes() {
    Object.keys(state.routes).forEach(function (dest) {
      var src = fixUtf8FromLatin1(String(state.routes[dest] || ''));
      document.querySelectorAll('[data-route-dest="' + dest + '"]').forEach(function (el) {
        if (isEditorNode(el)) return;
        var s = el.getAttribute('data-route-src');
        if (s != null) el.classList.toggle('is-active', s === src);
        var label = el.querySelector('[data-route-current]');
        if (label && !isLockedText(label)) {
          var map = parseJSONAttr(label.closest('[data-route-labels]'), 'data-route-labels');
          label.textContent = (map && map[src]) ? map[src] : (src || '—');
        }
      });
    });
  }

  /* ===================== АВТО-ЧАСЫ ===================== */
  function startLocalClock() {
    clearInterval(clockTimer);
    var WS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
    var WL = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
    var ML = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    function tick() {
      if (state.clockControlled) return;
      var n = new Date(), pad = function (x) { return x < 10 ? '0' + x : String(x); };
      var time = pad(n.getHours()) + ':' + pad(n.getMinutes());
      var date = pad(n.getDate()) + '.' + pad(n.getMonth() + 1) + '.' + n.getFullYear();
      var vals = {
        'sys.time': time, 'sys.date': date, 'sys.datetime': date + ' ' + time,
        'sys.weekday': WS[n.getDay()], 'sys.date.week': date + ' · ' + WS[n.getDay()],
        'sys.date.long': WL[n.getDay()] + ', ' + n.getDate() + ' ' + ML[n.getMonth()] + ' ' + n.getFullYear()
      };
      Object.keys(vals).forEach(function (j) {
        document.querySelectorAll('[data-join-string="' + j + '"],[data-text-join="' + j + '"]').forEach(function (el) {
          if (!isEditorNode(el) && !el.hasAttribute('data-text-lock')) el.textContent = vals[j];
        });
        state.string[j] = vals[j];
      });
    }
    tick();
    clockTimer = setInterval(tick, 15000);
  }

  /* ===================== АВТО-JOIN · REBUILD ===================== */
  function assignAutoJoins() {
    document.querySelectorAll('button,[role="button"]').forEach(function (btn) {
      if (isEditorNode(btn) || btn.closest('[data-no-join]') || btn.hasAttribute('data-no-join')) return;
      if (getDigitalJoin(btn) || btn.hasAttribute('data-states')) return;
      while (document.querySelector('[data-join-digital="' + autoDigCounter + '"]')) autoDigCounter++;
      btn.setAttribute('data-join-digital', String(autoDigCounter++));
    });
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null), node;
    while ((node = walker.nextNode())) {
      if (isEditorNode(node) || node.closest('[data-no-join]') || node.hasAttribute('data-no-join')) continue;
      if (/^(SVG|SCRIPT|STYLE|INPUT|TEXTAREA|SELECT|OPTION|TEMPLATE)$/.test(node.tagName)) continue;
      if (node.closest('svg')) continue;
      if (node.children.length > 0) continue;
      if (!node.textContent || !node.textContent.trim()) continue;
      if (getStringJoin(node) || node.hasAttribute('data-readout-for') || node.hasAttribute('data-text-lock')) continue;
      if (node.getAttribute('data-role') === 'label' && node.closest('[data-states]')) continue;
      while (document.querySelector('[data-join-string="' + autoStrCounter + '"]')) autoStrCounter++;
      node.setAttribute('data-join-string', String(autoStrCounter++));
    }
  }
  function rebuild() {
    Object.keys(state.lists).forEach(function (j) { if (state.lists[j] && state.lists[j].length) renderList(j); });
    assignAutoJoins();
    scanScreens();
    bindButtons();
    bindSliders();
    bindInputsAndSearch();
    bindPhysicalKeyboard();
    updateVerticalSliders();
    renderRoutes();
    resubscribe();
    emit('rebuild', {});
  }
  function seedFromMarkup() {
    document.querySelectorAll('[data-list-join][data-list-seed]').forEach(function (el) {
      if (isEditorNode(el)) return;
      var j = el.getAttribute('data-list-join');
      if (state.lists[j] && state.lists[j].length) return;
      var seed = parseJSONAttr(el, 'data-list-seed');
      if (Array.isArray(seed)) handleListSmart(j, { action: 'set', items: seed });
    });
    var seeded = false;
    document.querySelectorAll('[data-route-default]').forEach(function (el) {
      if (isEditorNode(el)) return;
      var def = parseJSONAttr(el, 'data-route-default');
      if (def && typeof def === 'object') Object.keys(def).forEach(function (d) {
        if (state.routes[d] == null) { state.routes[d] = def[d]; seeded = true; }
      });
    });
    if (seeded) renderRoutes();
  }
  function applyInitialView() {
    seedFromMarkup();
    var splash = document.querySelector('[data-screensaver], #splash');
    if (splash) state.awake = splash.classList.contains('is-hidden');
    var pg = document.querySelector('[data-screen].is-active,.av-page.is-active');
    if (pg) state.activePage = pg.id || pg.getAttribute('data-screen') || '';
    document.querySelectorAll('[data-initial="1"]').forEach(function (el) {
      if (isEditorNode(el)) return;
      var j = getDigitalJoin(el); if (j) setDigital(j, 1);
    });
  }
  function setSoundEnabled(bool) {
    state.soundEnabled = !!bool;
    document.querySelectorAll('[data-sound-toggle]').forEach(function (el) {
      if (isEditorNode(el)) return;
      el.classList.toggle('is-active', state.soundEnabled);
      var use = el.querySelector('use');
      if (use) {
        var href = state.soundEnabled ? '#i-speaker' : '#i-speaker-x';
        use.setAttribute('href', href); use.setAttribute('xlink:href', href);
      }
    });
    emit('sound', { enabled: state.soundEnabled });
  }
  function simulateControllerEcho(msg, force) {
    if (!force && typeof window.AVEcho === 'function') { try { window.AVEcho(msg); return; } catch (e) {} }
    setTimeout(function () {
      var j = normJoin(msg.join), t = String(msg.type).toLowerCase();
      if (t === 'analog') { setAnalog(j, msg.value); return; }
      if (t === 'string') { setString(j, msg.value); return; }
      if (t === 'digital') {
        var els = document.querySelectorAll('[data-join-digital="' + j + '"]');
        var latch = Array.prototype.some.call(els, function (e) {
          return /\b(av-toggle|av-mute|av-check-row)\b/.test(e.className || '') || e.hasAttribute('data-latch');
        });
        if (msg.value === 1) setDigital(j, latch ? (state.digital[j] ? 0 : 1) : 1);
        else if (!latch) setDigital(j, 0);
      }
    }, 60);
  }

  /* ===================== ОТЛАДОЧНЫЕ ХУКИ ===================== */
  function bindings() {
    var out = [];
    document.querySelectorAll('[data-join-digital],[data-digital-join],[data-cmd-join]').forEach(function (el) {
      if (isEditorNode(el) || el.closest('[data-no-join]')) return;
      out.push({ t: 'D', j: getDigitalJoin(el), el: el });
    });
    document.querySelectorAll('[data-join-analog],[data-analog-join],[data-state-join]').forEach(function (el) {
      if (isEditorNode(el) || el.closest('[data-no-join]')) return;
      var aj = getAnalogJoin(el);
      if (aj) out.push({ t: 'A', j: aj, el: el });
      var sj = normJoin(el.getAttribute('data-state-join'));
      if (sj && sj !== aj) out.push({ t: 'A', j: sj, el: el });
    });
    document.querySelectorAll('[data-join-string],[data-text-join]').forEach(function (el) {
      if (isEditorNode(el) || el.closest('[data-no-join]')) return;
      out.push({ t: 'S', j: getStringJoin(el), el: el });
    });
    Object.keys(state.lists).forEach(function (j) { out.push({ t: 'M', j: j, el: null }); });
    out.push({ t: 'M', j: 'routes', el: null });
    out.push({ t: 'M', j: 'cam.pose.1', el: null });
    out.push({ t: 'M', j: 'cam.pose.2', el: null });
    return out;
  }
  function stats() {
    var b = bindings(), uniq = { D: new Set(), A: new Set(), S: new Set(), M: new Set() };
    b.forEach(function (x) { uniq[x.t].add(x.j); });
    var btns = Array.from(document.querySelectorAll('button,[role="button"]')).filter(function (el) {
      return !isEditorNode(el) && !el.closest('[data-no-join]') && !el.hasAttribute('data-no-join');
    });
    var lists = {};
    Object.keys(state.lists).forEach(function (j) { lists[j] = state.lists[j].length; });
    return {
      D: uniq.D.size, A: uniq.A.size, S: uniq.S.size, M: uniq.M.size,
      buttons: btns.length,
      buttonsNoJoin: btns.filter(function (x) { return !getDigitalJoin(x); }).length,
      lists: lists
    };
  }
  function transportInfo() {
    return {
      version: CORE_VERSION,
      mode: state.transport,
      caps: driverApi ? driverApi.caps : null,
      online: state.online,
      bridgeReady: state.bridgeReady,
      endpoint: state.wsUrl,
      host: state.host, ipId: state.ipId,
      crComLib: !!window.CrComLib, webXPanel: !!window.WebXPanel,
      driver: driverApi && driverApi.state ? driverApi.state() : null,
      mapped: Object.keys(joinMap).length,
      outbox: outbox.length,
      analogScaleDefault: state.analogScaleDefault,
      smartSerial: state.smartSerial
    };
  }
  function diagnostics() {
    var refs = collectJoinRefs(), seen = new Set(), local = [], mapped = [], numeric = [];
    refs.forEach(function (ref) {
      var key = ref.type + '|' + ref.name;
      if (seen.has(key)) return;
      seen.add(key);
      var r = resolveOut(ref.type, ref.name);
      if (!r) {
        if (driverApi && driverApi.caps.named) numeric.push(ref.name + ' (имя, OK в ' + state.transport + ')');
        else local.push(ref.name);
        return;
      }
      if (joinMap[ref.name]) mapped.push(ref.name + ' → ' + r.t + ':' + r.n + (r.scale !== 1 ? ' ×' + r.scale : '') + (r.smart ? ' smart' : ''));
      else numeric.push(r.t + ':' + r.n);
    });
    return { transport: transportInfo(), localOnly: local, mapped: mapped, numeric: numeric, stats: stats() };
  }
  function createListApi(j) {
    return {
      get: function () { return (state.lists[j] || []).slice(); },
      add: function (x) { handleListSmart(j, Array.isArray(x) ? { action: 'add', items: x } : { action: 'add', item: x }); },
      remove: function (k) { handleListSmart(j, { action: 'remove', number: k }); },
      removeAt: function (i) { handleListSmart(j, { action: 'remove', index: i }); },
      set: function (items) { handleListSmart(j, { action: 'set', items: items }); },
      clear: function () { handleListSmart(j, { action: 'clear' }); },
      select: function (k) { setSmart(j + '.selected', k); }
    };
  }

  /* ===================== ПУБЛИЧНЫЙ API ===================== */
  window.sendControlSignal = sendControlSignal;
  window.receiveControlSignal = receiveControlSignal;

  window.Panel = {
    version: CORE_VERSION,
    send: sendControlSignal,
    receive: receiveControlSignal,
    setDigital: setDigital, setAnalog: setAnalog, setString: setString, setSmart: setSmart,
    showPage: showPage, back: goBack,
    openDialog: openDialog, closeDialog: closeDialog, isDialogOpen: isDialogActive,
    wake: wakePanel, sleep: sleepPanel,
    list: createListApi,
    phonebook: createListApi('phonebook'),
    lists: function () { return Object.keys(state.lists); },
    use: useTransport,
    modes: function () { return Object.keys(DRIVERS); },
    transport: transportInfo,
    diagnostics: diagnostics,
    connect: function (cfg) { if (driverApi) driverApi.connect(cfg || {}); },
    disconnect: function () { state.manualOffline = true; if (driverApi) driverApi.disconnect(); },
    resync: function () {
      if (driverApi && driverApi.resync) driverApi.resync(); else resubscribe();
      return transportInfo();
    },
    wsState: function () { return driverApi && driverApi.state ? driverApi.state() : { open: state.online, url: state.wsUrl }; },
    setJoinMap: function (obj) { var n = setJoinMap(obj); rebuild(); return n; },
    joinMap: function () { return JSON.parse(JSON.stringify(joinMap)); },
    rebuild: rebuild, fit: fitStage,
    sound: setSoundEnabled,
    echo: function (bool) { state.echo = !!bool; },
    onLog: function (fn) {
      logSubscribers.push(fn);
      return function () { var i = logSubscribers.indexOf(fn); if (i >= 0) logSubscribers.splice(i, 1); };
    },
    bindings: bindings,
    stats: stats,
    state: state
  };
  window.AVPanel = { rebind: rebuild };


/* ===================== ВСТРОЕННЫЕ РАНТАЙМЫ UI (v3.1) =====================
   Всё, что раньше инжектил panel-editor.js, теперь часть ядра:
   AVStates · AVTextLock · AVScreens · AVVisibility · AVRadio · AVStepRepeat.
   Панель самодостаточна сразу после генерации LLM. Редактор только рисует UI.
   Логика на делегировании document → любой скопированный/вставленный узел
   работает мгновенно, без перепривязки.
========================================================================= */

function rtSvg(s) {
  var str = String(s == null ? '' : s);
  str = str.replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, '');
  str = str.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '').replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
  str = str.replace(/(href|xlink:href)\s*=\s*(['"])\s*javascript:[^'"]*\2/gi, '$1=$2#$2');
  return str;
}
function rtAll(sel, root) {
  return Array.prototype.filter.call((root || document).querySelectorAll(sel), function (el) {
    return !isEditorNode(el);
  });
}
/* локальный отклик разрешён: эхо, mock, офлайн или явный data-local */
function rtLocal(el) {
  return (el && el.hasAttribute('data-local')) || state.echo || state.transport === 'mock' || !state.online;
}

/* ---------- многосостоянийные кнопки ---------- */
function rtInstallStates() {
  if (window.AVStates) return;
  function token(v) { return isNum(v) ? +v : String(v); }
  function statesOf(el) { try { return JSON.parse(el.getAttribute('data-states') || '[]'); } catch (e) { return []; } }
  function apply(el, idx) {
    if (!el || el.nodeType !== 1) return;
    var list = statesOf(el); if (!list.length) return;
    idx = Math.max(0, Math.min(list.length - 1, idx | 0));
    var st = list[idx] || {};
    el.setAttribute('data-state-index', String(idx));
    var lab = el.querySelector('[data-role="label"]');
    if (lab && st.label != null && !isLockedText(lab)) lab.textContent = st.label;
    var ico = el.querySelector('[data-role="icon"]');
    if (ico) {
      if (st.svg) ico.innerHTML = rtSvg(st.svg);
      else if (st.img) ico.innerHTML = '<img alt="" src="' + escapeHtml(st.img) + '">';
      else ico.innerHTML = '';
      var ch = ico.firstElementChild;
      if (ch) { ch.style.width = '100%'; ch.style.height = '100%'; ch.style.display = 'block'; ch.style.objectFit = 'contain'; }
    }
    if (st.color) el.style.setProperty('--st-c', st.color);
    if (st.bg) el.style.setProperty('--st-bg', st.bg);
    el.setAttribute('aria-pressed', idx > 0 ? 'true' : 'false');
  }
  function each(fn) { rtAll('[data-states]').forEach(fn); }
  window.AVStates = {
    apply: apply, states: statesOf, token: token,
    refresh: function () { each(function (el) { apply(el, +(el.getAttribute('data-state-index') || 0)); }); },
    bind: function () { this.refresh(); },
    rx: function (join, value) {
      var key = normJoin(join);
      each(function (el) {
        if (normJoin(el.getAttribute('data-state-join') || el.getAttribute('data-cmd-join')) === key) apply(el, value);
      });
    }
  };
  document.addEventListener('click', function (e) {
    if (document.body.classList.contains('pe-editing')) return;
    var el = e.target.closest && e.target.closest('[data-states]');
    if (!el || isEditorNode(el) || el.hasAttribute('data-static')) return;
    var list = statesOf(el); if (!list.length) return;
    var cur = +(el.getAttribute('data-state-index') || 0);
    var next = el.getAttribute('data-cmd-mode') === 'set'
      ? parseInt(el.getAttribute('data-cmd-value') || '0', 10)
      : (cur + 1) % list.length;
    if (rtLocal(el)) apply(el, next);
    var j = el.getAttribute('data-state-join') || el.getAttribute('data-cmd-join');
    if (j) sendControlSignal('analog', token(j), next);
  });
  new MutationObserver(function (recs) {
    recs.forEach(function (r) {
      Array.prototype.forEach.call(r.addedNodes || [], function (n) {
        if (n.nodeType !== 1) return;
        if (n.hasAttribute('data-states')) apply(n, +(n.getAttribute('data-state-index') || 0));
        if (n.querySelectorAll) n.querySelectorAll('[data-states]').forEach(function (x) {
          apply(x, +(x.getAttribute('data-state-index') || 0));
        });
      });
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
}

/* ---------- защита статических надписей ---------- */
function rtInstallTextLock() {
  if (window.AVTextLock) return;
  var ATTR = 'data-text-lock', writing = false;
  function guarded(el) {
    if (!el || el.nodeType !== 1 || el.children.length) return false;
    if (el.hasAttribute('data-text-join') || el.hasAttribute('data-join-string')) return false;
    if (el.closest('[data-text-join]') || el.closest('[data-join-string]')) return false;
    return true;
  }
  function apply(el) {
    if (!guarded(el)) return;
    var want = el.getAttribute(ATTR);
    if (want == null || el.textContent === want) return;
    writing = true; el.textContent = want; writing = false;
  }
  function all(root) {
    var out = [];
    if (!root) return out;
    if (root.nodeType === 1 && root.hasAttribute && root.hasAttribute(ATTR)) out.push(root);
    if (root.querySelectorAll) out = out.concat(Array.prototype.slice.call(root.querySelectorAll('[' + ATTR + ']')));
    return out;
  }
  function refresh() { all(document.documentElement).forEach(apply); }
  window.AVTextLock = {
    attr: ATTR, refresh: refresh, guarded: guarded,
    set: function (el, text) { if (!guarded(el)) return false; el.setAttribute(ATTR, String(text)); apply(el); return true; },
    release: function (el) { if (el && el.removeAttribute) el.removeAttribute(ATTR); },
    list: function () { return all(document.documentElement); }
  };
  refresh();
  new MutationObserver(function (recs) {
    if (writing) return;
    recs.forEach(function (r) {
      if (r.type === 'attributes') { apply(r.target); return; }
      if (r.type === 'characterData') {
        var p = r.target.parentElement;
        if (p && p.hasAttribute && p.hasAttribute(ATTR)) apply(p);
        return;
      }
      if (r.target && r.target.nodeType === 1 && r.target.hasAttribute && r.target.hasAttribute(ATTR)) apply(r.target);
      Array.prototype.forEach.call(r.addedNodes || [], function (n) { all(n).forEach(apply); });
    });
  }).observe(document.documentElement, {
    childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: [ATTR]
  });
}

/* ---------- видимость: data-visibility-join + data-visibility ---------- */
function rtInstallVisibility() {
  if (window.AVVisibility) return;
  function apply(el, val) {
    if (!el || el.nodeType !== 1) return;
    var show = toBool(val);
    el.classList.toggle('hidden', !show);
    el.toggleAttribute('data-vis-hidden', !show);
    var mode = el.getAttribute('data-visibility');
    if (mode && mode !== 'block' && mode !== '1' && mode !== 'true') el.classList.toggle(mode, show);
  }
  function rx(join, value) {
    var key = normJoin(join);
    rtAll('[data-visibility-join]').forEach(function (el) {
      if (normJoin(el.getAttribute('data-visibility-join')) === key) apply(el, value);
    });
  }
  window.AVVisibility = { apply: apply, rx: rx };
}

/* ---------- радио-группы ---------- */
function rtInstallRadio() {
  if (window.AVRadio) return;
  function members(name, scope) {
    return rtAll('[data-radio-group]', scope).filter(function (el) {
      return el.getAttribute('data-radio-group') === name;
    });
  }
  function setActive(el, on) {
    el.classList.toggle('is-active', on);
    if (!on) {
      var j = getDigitalJoin(el);
      if (j && state.digital[j]) state.digital[j] = 0;
    }
    if (el.hasAttribute('data-nav') || /\b(av-nav-item|av-seg-btn|av-tab)\b/.test(el.className || '')) {
      el.classList.toggle('is-current', on);
    }
    if (el.hasAttribute('aria-pressed')) el.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (el.hasAttribute('aria-checked') || el.getAttribute('role') === 'radio') {
      el.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  function apply(el) {
    var name = el && el.getAttribute('data-radio-group');
    if (!name) return;
    var scope = el.closest('[data-radio-scope]') ||
            el.closest('[data-screen],[data-dialog],.av-page,.av-modal') || document;
    members(name, scope).forEach(function (m) { setActive(m, m === el); });
  }
  window.AVRadio = { apply: apply, members: members, setActive: setActive };
  document.addEventListener('click', function (e) {
    if (document.body.classList.contains('pe-editing')) return;
    var el = e.target.closest && e.target.closest('[data-radio-group]');
    if (!el || isEditorNode(el)) return;
    if (el.hasAttribute('data-radio-local') || rtLocal(el)) apply(el);
  });
}

/* ---------- автоповтор шага (.av-step / data-repeat) ---------- */
function rtInstallStepRepeat() {
  if (window.AVStepRepeat) return;
  window.AVStepRepeat = true;
  var timer = null, interval = null, btn = null, lastX = 0, lastY = 0, pulseMs = 60;
  function stop() { clearTimeout(timer); clearInterval(interval); timer = interval = null; btn = null; }
  function inside(el, x, y) {
    var r = el.getBoundingClientRect(), t = 12;
    return x >= r.left - t && x <= r.right + t && y >= r.top - t && y <= r.bottom + t;
  }
  function tick() {
    if (!btn || !btn.isConnected || btn.disabled || document.body.classList.contains('pe-editing')) { stop(); return; }
    if (!inside(btn, lastX, lastY)) { stop(); return; }
    var j = getDigitalJoin(btn);
    var hasStates = btn.hasAttribute('data-states');
    if (j && !hasStates && !btn.hasAttribute('data-latch')) {
      sendControlSignal('digital', j, 1);
      setTimeout(function () { sendControlSignal('digital', j, 0); }, pulseMs);
    }
    if (!hasStates) playFeedbackSound('tick');
    try { btn.click(); } catch (e) {}
  }
  document.addEventListener('pointerdown', function (e) {
    if (document.body.classList.contains('pe-editing')) return;
    if (e.button != null && e.button !== 0) return;
    var el = e.target.closest && e.target.closest('.av-step,[data-repeat]');
    if (!el || isEditorNode(el) || el.getAttribute('data-repeat') === 'off') return;
    stop();
    btn = el; lastX = e.clientX; lastY = e.clientY;
    var delay = parseInt(el.getAttribute('data-repeat-delay'), 10); if (!(delay >= 0)) delay = 450;
    var rate = parseInt(el.getAttribute('data-repeat-rate'), 10); if (!(rate > 0)) rate = 140;
    pulseMs = Math.max(20, Math.min(60, Math.floor(rate / 2)));
    timer = setTimeout(function () { interval = setInterval(tick, rate); }, delay);
  });
  document.addEventListener('pointermove', function (e) { if (btn) { lastX = e.clientX; lastY = e.clientY; } });
  ['pointerup', 'pointercancel', 'blur'].forEach(function (ev) { window.addEventListener(ev, stop); });
  document.addEventListener('visibilitychange', stop);
}


/* ---------- реестр экранов (совместимость с API редактора) ---------- */
function rtInstallScreens() {
  if (window.AVScreens) return;
  var PAGE = '[data-screen],.av-page,.screen,.page,[id^="screen-"],[id^="page-"],[id^="subpage-"]';
  var DLG = '[data-dialog],.av-modal,.overlay,.modal,.dialog,[id^="overlay-"],[id^="modal-"],[id^="dialog-"],#shutdown-overlay';
  var SAVER = '[data-screensaver],#splash,#screensaver';
  function nodes() { return rtAll(PAGE + ',' + DLG + ',' + SAVER); }
  function kind(n) {
    if (!n) return 'page';
    if (n.matches(SAVER) || /screensaver|saver|standby|idle|splash/i.test(n.id || '')) return 'saver';
    return n.matches(PAGE) ? 'page' : 'dialog';
  }
  function on(n) {
    if (kind(n) === 'saver') return !n.classList.contains('is-hidden');
    var cls = String(n.getAttribute('class') || '').split(/\s+/);
    return ACTIVE_TOKENS.some(function (t) { return cls.indexOf(t) >= 0; });
  }
  function byId(x) {
    if (!x) return null;
    if (typeof x !== 'string') return x;
    return document.getElementById(x) || document.querySelector('[data-screen="' + x + '"],[data-dialog="' + x + '"]');
  }
  window.AVScreens = {
    list: function () { return nodes().map(function (n) { return { id: n.id || '', kind: kind(n), active: on(n), el: n }; }); },
    kind: function (x) { return kind(byId(x)); },
    active: function () {
      var l = nodes().filter(on);
      var d = l.filter(function (n) { return kind(n) === 'dialog'; });
      if (d.length) return d[d.length - 1];
      var p = l.filter(function (n) { return kind(n) === 'page'; });
      return p[p.length - 1] || l[l.length - 1] || null;
    },
    show: function (x) {
      var el = byId(x); if (!el) return false;
      var k = kind(el);
      if (k === 'page') activatePageElement(el, true, true);
      else if (k === 'dialog') openDialogElement(el, true);
      else wakePanel();
      return true;
    },
    open: function (x) { return this.show(x); },
    close: function (x) { var el = byId(x); if (!el) return false; closeDialogElement(el, false); return true; },
    refresh: function () {
      if (window.AVStates) window.AVStates.refresh();
      if (window.AVTextLock) window.AVTextLock.refresh();
    }
  };
}

/* ставим сразу, не дожидаясь DOMContentLoaded:
   редактор и LLM-разметка могут обратиться к API раньше init() */
rtInstallStates();
rtInstallTextLock();
rtInstallVisibility();
rtInstallRadio();
rtInstallStepRepeat();
rtInstallScreens();

function refreshRuntime() {
  if (window.AVStates) window.AVStates.refresh();
  if (window.AVTextLock) window.AVTextLock.refresh();
}




  /* ===================== INIT ===================== */


  function init() {
    loadConfigFromMarkup();
    refreshRuntime();
    fitStage();
    rebuild();
    applyInitialView();
    startLocalClock();

    var stage = stageRoot() || document;
    stage.addEventListener('contextmenu', function (e) {
      if (document.body.classList.contains('pe-editing') || isEditorNode(e.target)) return;
      if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      e.preventDefault();
    });

    if (!document.getElementById('av-touch-guard')) {
      var st = document.createElement('style');
      st.id = 'av-touch-guard';
      st.textContent =
        'body:not(.pe-editing) [data-panel-root], body:not(.pe-editing) #panel-stage { touch-action: none; -webkit-touch-callout: none; }' +
        'body:not(.pe-editing) [data-list-join], body:not(.pe-editing) #book-list, body:not(.pe-editing) #jb-log { touch-action: pan-y; }';
      document.head.appendChild(st);
    }

    window.addEventListener('resize', function () { fitStage(); updateVerticalSliders(); });
    window.addEventListener('orientationchange', fitStage);
    useTransport('auto');
    /* мост Crestron может подгрузиться позже ядра — добираем подписки */
    var tries = 0;
    var wait = setInterval(function () {
      tries++;
      if (state.transport === 'crestron' && window.CrComLib && !state.bridgeReady) {
        state.bridgeReady = true;
        resubscribe();
        flushOutbox();
        if (!state.online) status(true, 'Crestron · мост готов');
      }
      if (state.bridgeReady || state.transport !== 'crestron' || tries > 40) clearInterval(wait);
    }, 250);
    console.log('[AV-CORE] v' + CORE_VERSION + ' · режим:', state.transport,
      '· join-привязок:', bindings().length, '· карта:', Object.keys(joinMap).length);
  }


  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();