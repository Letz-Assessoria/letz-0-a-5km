/* Lógica pura compartilhada (navegador, testes e Cloud Functions). UMD sem dependências. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LetzCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var WEEK_MS = 7 * 864e5;
  var DEFAULT_START_ISO = '2026-11-08T18:00:00-03:00';

  function weekIndex(startMs, tMs) { return Math.max(0, Math.floor((tMs - startMs) / WEEK_MS)); }

  // A semana w (1 a 10) abre em start + (w-1) semanas.
  function weekOpen(startMs, w, nowMs) { return nowMs >= startMs + (w - 1) * WEEK_MS; }

  // Chaves "w-d" -> epoch ms. Pontuam as 3 primeiras de cada semana, em ordem de horário.
  function pointedKeys(marks, startMs) {
    var by = {}, ok = new Set();
    Object.keys(marks).map(function (k) { return [k, marks[k]]; })
      .sort(function (a, b) { return a[1] - b[1]; })
      .forEach(function (e) {
        var w = weekIndex(startMs, e[1]);
        by[w] = (by[w] || 0) + 1;
        if (by[w] <= 3) ok.add(e[0]);
      });
    return ok;
  }

  function pointsFor(marks, startMs) {
    return { points: pointedKeys(marks, startMs).size * 3, done: Object.keys(marks).length };
  }

  function isConcluded(marks) { return !!marks['10-0'] && !!marks['10-1'] && !!marks['10-2'] && Object.keys(marks).length >= 24; }

  function normalizeCpf(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }

  function isValidCpf(s) {
    var d = normalizeCpf(s);
    if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
    for (var n = 9; n < 11; n++) {
      var sum = 0;
      for (var i = 0; i < n; i++) sum += +d[i] * (n + 1 - i);
      var dv = (sum * 10) % 11 % 10;
      if (dv !== +d[n]) return false;
    }
    return true;
  }

  function normalizePhone(s) {
    var d = String(s == null ? '' : s).replace(/\D/g, '');
    return d.length === 10 || d.length === 11 ? d : null;
  }

  function normalizeCep(s) {
    var d = String(s == null ? '' : s).replace(/\D/g, '');
    return d.length === 8 ? d : null;
  }

  // Endereço do cadastro (vai para o checkout do Asaas). Devolve o objeto limpo ou null.
  var UF_RE = /^[A-Z]{2}$/;
  function cleanAddress(a) {
    if (!a || typeof a !== 'object') return null;
    var t = function (v) { return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : ''; };
    var cep = normalizeCep(a.cep);
    var street = t(a.street), number = t(a.number), complement = t(a.complement), district = t(a.district), city = t(a.city);
    var uf = typeof a.uf === 'string' ? a.uf.trim().toUpperCase() : '';
    if (!cep || !street || street.length > 100 || !number || number.length > 10 || complement.length > 40 ||
        !district || district.length > 60 || !city || city.length > 60 || !UF_RE.test(uf)) return null;
    return { cep: cep, street: street, number: number, complement: complement, district: district, city: city, uf: uf };
  }

  function cleanHandle(v) { return v.toLowerCase().replace(/^@+/, '').replace(/[^a-z0-9._]/g, '').slice(0, 30); }

  // Projeto do Firebase por host. Só o site/preview de DEV usa dev; qualquer outro
  // domínio (inclusive previews de prod "letz-0-aos-5km--...") é PROD.
  function projectForHost(host) {
    host = String(host || '');
    if (host === 'localhost' || host === '127.0.0.1') return 'local';
    if (host.indexOf('letz-0-aos-5km-dev.') === 0 || host.indexOf('letz-0-aos-5km-dev--') === 0) return 'dev';
    return 'prod';
  }

  return {
    projectForHost: projectForHost,
    WEEK_MS: WEEK_MS, DEFAULT_START_ISO: DEFAULT_START_ISO,
    weekOpen: weekOpen, weekIndex: weekIndex, pointedKeys: pointedKeys, pointsFor: pointsFor,
    isConcluded: isConcluded, isValidCpf: isValidCpf, normalizeCpf: normalizeCpf,
    normalizePhone: normalizePhone, normalizeCep: normalizeCep, cleanAddress: cleanAddress, cleanHandle: cleanHandle
  };
});
