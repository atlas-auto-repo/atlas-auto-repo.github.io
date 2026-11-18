// 사무실 재고 스캔 화면 연결부 (OFC-F17).
// The static scan page is the unchanged web app screen (webapp/index.html). This file stands in for
// google.script.run so that screen talks to the scan API (scanapi/Api.gs) instead of the Apps Script
// frame. The API deployment id and token arrive only in the link fragment (#a=…&k=…), which browsers
// never send to the page host; they are kept in this device's storage and wiped from the address bar.
(function (root) {
  'use strict';

  var STORAGE_KEY = 'officeStockScanApi.v1';
  var DEPLOYMENT_PATTERN = /^AKfyc[A-Za-z0-9_-]{20,200}$/;
  var TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
  var OPERATIONS = ['listInventoryAdjustmentData', 'lookupInventoryItem', 'submitInventoryOperation', 'updateInventoryLocation', 'createOfficeStockRow'];
  // Calls that write. Each carries the screen's requestId and the server answers a repeat of the same
  // requestId without writing again, so a write whose answer never arrived is reported as "result unknown":
  // the screen keeps the row and its requestId, reloads the ledger, and a resend cannot double-record.
  var WRITE_OPERATIONS = ['submitInventoryOperation', 'updateInventoryLocation', 'createOfficeStockRow'];
  var TIMEOUT_MS = 90000;
  var REFUSED_CODES = ['OPERATION', 'BAD_REQUEST', 'METHOD'];
  var MESSAGES = {
    NO_LINK: '텔레그램으로 받은 재고 스캔 링크로 다시 열어 주세요.',
    AUTH: '링크가 바뀌었습니다. 텔레그램의 새 재고 스캔 링크로 다시 열어 주세요.',
    NETWORK: '서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.',
    TIMEOUT: '서버 응답이 늦어 기다리기를 멈췄습니다. 잠시 뒤 다시 시도해 주세요.',
    BAD_RESPONSE: '서버 응답을 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
    WRITE_UNKNOWN: '응답을 받지 못해 반영됐는지 확인하지 못했습니다. 장부를 다시 받아 확인해 주세요. 남은 항목은 같은 요청번호로 남아 있어 다시 보내도 두 번 기록되지 않습니다.',
    FRAMED: '이 화면은 다른 페이지 안에서는 동작하지 않습니다. 재고 스캔 링크를 브라우저에서 직접 열어 주세요.',
    WRONG_PLACE: '이 화면은 정해진 전용 주소에서만 동작합니다. 텔레그램의 재고 스캔 링크로 열어 주세요.',
    LINK_CLEAR: '주소창에서 열쇠를 지우지 못해 연결하지 않았습니다. Safari나 Chrome 최신 버전으로 다시 열어 주세요.'
  };
  // The token lives in this origin's storage, so the page must own its whole origin: it runs only at the
  // root of a dedicated host (a GitHub user/organization site with no other Pages, or its own domain).
  // A project page (https://owner.github.io/repo/) shares the owner's origin with every other project page.
  var SITE_PATHS = ['/', '/index.html'];

  function validConfig(value) {
    return Boolean(value) && DEPLOYMENT_PATTERN.test(String(value.a || '')) && TOKEN_PATTERN.test(String(value.k || ''));
  }

  function parseFragment(hash) {
    var text = String(hash || '').replace(/^#/, '');
    if (!text) return null;
    var result = {};
    text.split('&').forEach(function (part) {
      var at = part.indexOf('=');
      if (at <= 0) return;
      var key = part.slice(0, at);
      if (key !== 'a' && key !== 'k') return;
      try { result[key] = decodeURIComponent(part.slice(at + 1)); } catch (error) { /* ignore a broken part */ }
    });
    return validConfig(result) ? { a: result.a, k: result.k } : null;
  }

  function storage(win) {
    try { return win.localStorage || null; } catch (error) { return null; }
  }

  function readStored(win) {
    var store = storage(win);
    if (!store) return null;
    try {
      var value = JSON.parse(store.getItem(STORAGE_KEY) || 'null');
      return validConfig(value) ? { a: value.a, k: value.k } : null;
    } catch (error) {
      return null;
    }
  }

  function writeStored(win, config) {
    var store = storage(win);
    if (!store) return;
    try {
      if (config) store.setItem(STORAGE_KEY, JSON.stringify(config));
      else store.removeItem(STORAGE_KEY);
    } catch (error) { /* private mode: the link still works for this visit */ }
  }

  // Replaces the current history entry so the link with the token is not left behind. Setting
  // location.hash instead would add a new entry and keep the old one, so there is no such fallback:
  // when the replacement fails the token is not kept at all.
  function clearFragment(win) {
    if (!win.location || !win.location.hash) return true;
    try {
      win.history.replaceState(null, '', win.location.pathname + win.location.search);
    } catch (error) {
      return false;
    }
    return !win.location.hash;
  }

  function framed(win) {
    try { return win.top !== win.self; } catch (error) { return true; }
  }

  function createBridge(win, fetchImpl, options) {
    var timeoutMs = options && options.timeoutMs > 0 ? options.timeoutMs : TIMEOUT_MS;
    var blocked = null;
    var current = null;
    if (framed(win)) {
      // Inside someone else's page (clickjacking): read nothing, store nothing, call nothing.
      blocked = MESSAGES.FRAMED;
    } else {
      var fromLink = parseFragment(win.location && win.location.hash);
      var cleared = clearFragment(win);
      if (SITE_PATHS.indexOf(String(win.location && win.location.pathname || '')) < 0) blocked = MESSAGES.WRONG_PLACE;
      else if (!cleared) blocked = MESSAGES.LINK_CLEAR;
      else if (fromLink) { current = fromLink; writeStored(win, current); }
      else current = readStored(win);
    }

    function send(config, operation, argument) {
      var request;
      var controller = typeof win.AbortController === 'function' ? new win.AbortController() : null;
      try {
        request = fetchImpl('https://script.google.com/macros/s/' + config.a + '/exec', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ k: config.k, op: operation, arg: argument }),
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'follow',
          referrerPolicy: 'no-referrer',
          signal: controller ? controller.signal : undefined
        });
      } catch (error) {
        return Promise.reject(new Error(MESSAGES.NETWORK));
      }
      var answer = Promise.resolve(request).then(function (response) {
        if (!response || !response.ok) throw new Error(MESSAGES.NETWORK);
        return response.json().catch(function () { throw new Error(MESSAGES.BAD_RESPONSE); });
      }, function () {
        throw new Error(MESSAGES.NETWORK);
      });
      // The timer covers the whole exchange (headers and body). A late answer after it fires is ignored.
      return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = win.setTimeout(function () {
          if (settled) return;
          settled = true;
          if (controller) { try { controller.abort(); } catch (ignored) { /* already finished */ } }
          reject(new Error(MESSAGES.TIMEOUT));
        }, timeoutMs);
        answer.then(function (data) {
          if (settled) return;
          settled = true;
          win.clearTimeout(timer);
          resolve(data);
        }, function (error) {
          if (settled) return;
          settled = true;
          win.clearTimeout(timer);
          reject(error);
        });
      });
    }

    function call(operation, argument) {
      if (blocked) return Promise.reject(new Error(blocked));
      if (!current) return Promise.reject(new Error(MESSAGES.NO_LINK));
      var config = current;
      var writes = WRITE_OPERATIONS.indexOf(operation) >= 0;
      return send(config, operation, argument).then(function (data) {
        if (data && data.ok === true) return data.result;
        if (data && data.code === 'AUTH') {
          if (current === config) {
            current = null;
            writeStored(win, null);
          }
          throw new Error(MESSAGES.AUTH);
        }
        if (data && data.code === 'FAILED' && typeof data.error === 'string' && data.error) throw new Error(data.error);
        // The API refused the request before calling the screen's function: nothing was written.
        if (data && REFUSED_CODES.indexOf(data.code) >= 0) throw new Error(MESSAGES.BAD_RESPONSE);
        throw new Error(writes ? MESSAGES.WRITE_UNKNOWN : MESSAGES.BAD_RESPONSE);
      }, function (error) {
        // No answer (connection lost, timeout, unreadable body): a write may already be in the ledger.
        throw writes ? new Error(MESSAGES.WRITE_UNKNOWN) : error;
      });
    }

    // Same call shape as google.script.run: run.withSuccessHandler(f).withFailureHandler(g).name(argument).
    function runner(onSuccess, onFailure) {
      var run = {
        withSuccessHandler: function (handler) { return runner(handler, onFailure); },
        withFailureHandler: function (handler) { return runner(onSuccess, handler); }
      };
      OPERATIONS.forEach(function (operation) {
        run[operation] = function (argument) {
          call(operation, argument).then(function (result) {
            if (onSuccess) onSuccess(result);
          }, function (error) {
            if (onFailure) onFailure(error);
          });
        };
      });
      return run;
    }

    return { run: runner(null, null), hasLink: function () { return Boolean(current); } };
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { createBridge: createBridge, parseFragment: parseFragment, OPERATIONS: OPERATIONS, WRITE_OPERATIONS: WRITE_OPERATIONS, TIMEOUT_MS: TIMEOUT_MS, SITE_PATHS: SITE_PATHS, STORAGE_KEY: STORAGE_KEY, MESSAGES: MESSAGES };
  } else {
    var bridge = createBridge(root, root.fetch.bind(root));
    root.google = { script: { run: bridge.run } };
  }
})(typeof window !== 'undefined' ? window : this);
