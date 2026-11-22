/* SurveyPilot AI - shared utilities (UMD: works in pages, service worker, content scripts and Node tests). */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  var SP = (root.SP = root.SP || {});
  Object.keys(api).forEach(function (k) { SP[k] = api[k]; });
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  var Util = {
    sleep: function (ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    },

    /** Wall-clock timestamp (ms since epoch). Used for display and persistence. */
    now: function () { return Date.now(); },

    /** Monotonic timer (ms). Used for every measured duration. */
    mono: function () {
      return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    },

    uid: function (prefix) {
      var r = Math.random().toString(36).slice(2, 8);
      return (prefix || 'id') + '_' + Date.now().toString(36) + r;
    },

    clamp: function (v, lo, hi) { return Math.min(hi, Math.max(lo, v)); },

    clone: function (o) { return o == null ? o : JSON.parse(JSON.stringify(o)); },

    /** Lower-cases, strips punctuation/diacritic-insensitive noise and collapses spaces. */
    normalize: function (s) {
      return String(s == null ? '' : s)
        .toLowerCase()
        .replace(/[‘’ʼ]/g, "'")
        .replace(/[^\p{L}\p{N}\s'+%-]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    },

    /** Removes required-markers and surrounding whitespace from a label. */
    cleanLabel: function (s) {
      return String(s == null ? '' : s)
        .replace(/\(\s*required\s*\)/ig, '')
        .replace(/\brequired question\b/ig, '')
        .replace(/\s*\*+\s*$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    },

    /** djb2 hash returned in base36. Stable across sessions. */
    hash: function (str) {
      var h = 5381; str = String(str);
      for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
      return (h >>> 0).toString(36);
    },

    /** Seeded PRNG helper (mulberry32). */
    rng: function (seed) {
      var a = (typeof seed === 'number' ? seed : parseInt(Util.hash(String(seed)), 36)) >>> 0;
      function next() {
        a = (a + 0x6D2B79F5) >>> 0;
        var t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      }
      var r = {
        next: next,
        int: function (min, max) { return Math.floor(next() * (max - min + 1)) + min; },
        chance: function (p) { return next() < p; },
        pick: function (arr) { return arr[Math.floor(next() * arr.length)]; },
        normal: function (mean, sd) {
          var u = 0, v = 0;
          while (u === 0) u = next();
          while (v === 0) v = next();
          return mean + sd * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
        },
        /** items: array; weightFn(item,index) -> number >= 0. Returns the picked item. */
        weighted: function (items, weightFn) {
          var total = 0, ws = items.map(function (it, i) {
            var w = Math.max(0, weightFn ? weightFn(it, i) : 1); total += w; return w;
          });
          if (total <= 0) return items[Math.floor(next() * items.length)];
          var x = next() * total;
          for (var i = 0; i < items.length; i++) { x -= ws[i]; if (x < 0) return items[i]; }
          return items[items.length - 1];
        },
        shuffle: function (arr) {
          var a2 = arr.slice();
          for (var i = a2.length - 1; i > 0; i--) {
            var j = Math.floor(next() * (i + 1)); var t = a2[i]; a2[i] = a2[j]; a2[j] = t;
          }
          return a2;
        }
      };
      return r;
    },

    formatDuration: function (ms) {
      if (ms == null || isNaN(ms)) return '-';
      if (ms < 1000) return Math.round(ms) + ' ms';
      var s = ms / 1000;
      if (s < 60) return s.toFixed(1) + ' s';
      var m = Math.floor(s / 60), rs = Math.round(s % 60);
      if (m < 60) return m + 'm ' + rs + 's';
      return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
    },

    pad2: function (n) { return (n < 10 ? '0' : '') + n; },

    formatClock: function (ts) {
      var d = new Date(ts);
      return Util.pad2(d.getHours()) + ':' + Util.pad2(d.getMinutes()) + ':' + Util.pad2(d.getSeconds());
    },

    /** Removes secrets (e.g. API keys) from any string before logging or exporting. */
    redact: function (text, secrets) {
      var out = String(text == null ? '' : text);
      (secrets || []).forEach(function (s) {
        if (s && String(s).length >= 6) out = out.split(String(s)).join('[REDACTED]');
      });
      // Generic Google API key shape.
      out = out.replace(/AIza[0-9A-Za-z_\-]{20,}/g, '[REDACTED]');
      return out;
    }
  };

  return { Util: Util };
});
