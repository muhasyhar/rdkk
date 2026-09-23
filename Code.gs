/**
 * ============================================================
 * Code.gs - e-RDKK BACKEND (Konsolidasi Seluruh File .gs)
 * Aplikasi Pendataan e-RDKK — Google Apps Script REST API
 * ============================================================
 *
 * File ini merupakan gabungan dari:
 *   Code.gs, Auth.gs, Util.gs, NOP.gs, Transaksi.gs, MasterData.gs,
 *   Resume.gs, Log.gs, Export.gs, Arsip.gs, InitialInstall.gs
 *
 * ARSITEKTUR
 * ----------
 * Frontend kini di-hosting terpisah (Cloudflare Pages) dan berkomunikasi
 * dengan backend ini melalui REST API JSON (bukan lagi HtmlService).
 *
 *   GET  : {WEB_APP_URL}?action=namaAksi&token=SESI&param1=nilai
 *   POST : body JSON { "action": "...", "token": "...", ... }
 *
 * PENTING — CARA DEPLOY
 * ---------------------
 * 1. Deploy sebagai Web App:
 *      Execute as  : Me (pemilik spreadsheet)
 *      Who has access : Anyone
 * 2. Salin URL Web App hasil deploy ke konstanta API_BASE pada file
 *    index.html di sisi frontend.
 * 3. Jalankan `runInitialInstall()` sekali dari editor Apps Script
 *    (atau via action=runInitialInstall dengan confirm=INSTALL) untuk
 *    menyiapkan struktur sheet database.
 *
 * KEAMANAN
 * --------
 * - Hanya aksi yang terdaftar pada objek ROUTES yang boleh dipanggil
 *   (whitelist). Aksi di luar daftar akan ditolak.
 * - Sesi login Superuser disimpan di CacheService (bukan
 *   PropertiesService) sehingga bersifat stateless dan aman untuk
 *   arsitektur REST lintas-origin. Token acak dikembalikan saat login
 *   dan wajib disertakan pada setiap request terproteksi.
 * - Seluruh aksi dengan flag `auth: true` pada ROUTES dilindungi oleh
 *   requireSuperuser().
 *
 * CATATAN SKEMA DATABASE (JANGAN DIUBAH)
 * --------------------------------------
 * - Pendaftar_RDKK : 18 kolom (index 0-17)
 * - dbwp           : 8 kolom  (index 0-7)
 * - dbwp-banding   : 10 kolom (index 0-9)
 * - Format NOP     : [Prefix 10 digit].[Blok 3 digit].[Bidang 4 digit].[Sisa 1 digit]
 * - ID Transaksi   : TRX-[timestamp]
 * ============================================================
 */


/* ============================================================
 * BAGIAN 1 — ROUTER REST API (doGet / doPost)
 * ============================================================ */

/**
 * Entry point HTTP GET.
 * Contoh: ?action=getInitialAppData&token=abc123
 */
function doGet(e) {
  var params = (e && e.parameter) ? e.parameter : {};
  var action = params.action;
  if (!action) return jsonResponse({ error: 'Missing action parameter' });
  return dispatch(action, params, params.token || '', false);
}

/**
 * Entry point HTTP POST (body JSON).
 * Contoh body: { "action": "saveTransaksi", "token": "abc123", "nik": "..." }
 */
function doPost(e) {
  var body = {};
  try {
    var raw = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    body = JSON.parse(raw || '{}');
  } catch (parseErr) {
    return jsonResponse({ error: 'Format body JSON tidak valid.' });
  }

  var action = body ? body.action : '';
  if (!action) return jsonResponse({ error: 'Missing action in POST body' });

  return dispatch(action, body, body.token || '', true);
}

/**
 * Dispatcher terpusat: validasi whitelist route + guard autentikasi.
 */
function dispatch(action, params, token, isPost) {
  try {
    // Clear per-request sheet cache at start of each request
    clearRequestCache();

    var route = ROUTES[action];
    if (!route) {
      return jsonResponse({ error: 'Action tidak dikenal: ' + action });
    }

    // SECURITY: Auth-required endpoints MUST use POST with token in body.
    // Reject tokens passed via GET query string for sensitive endpoints
    // to prevent token leakage in server access logs and browser history.
    if (route.auth && !isPost) {
      return jsonResponse({ error: 'Endpoint ini hanya menerima POST request dengan token di body.' });
    }

    if (route.auth) {
      requireSuperuser(token);
    }

    var result = route.handler(params, token);
    return jsonResponse(result);

  } catch (err) {
    return jsonResponse({ error: (err && err.message) ? err.message : String(err) });
  } finally {
    // Always clear cache after request completes
    clearRequestCache();
  }
}

/**
 * Helper standar respons JSON untuk seluruh endpoint REST.
 */
function jsonResponse(data) {
  if (data === undefined) data = null;
  var text = JSON.stringify(data);
  if (text === undefined) text = 'null';
  return ContentService
    .createTextOutput(text)
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * ============================================================
 * ROUTES — Whitelist aksi REST API
 * ------------------------------------------------------------
 * Format: 'namaAksi': { handler: fungsi, auth: boolean, method: 'GET'|'POST' }
 *   - auth: true  -> wajib token Superuser yang valid
 *   - method      -> dokumentasi konvensi HTTP (tidak dipaksakan router)
 * ============================================================
 */
var ROUTES = {

  /* ---------- Publik: data awal & referensi ---------- */
  'getInitialAppData':      { handler: getInitialAppData,             auth: false, method: 'GET'  },
  'getPrefixNopList':       { handler: getPrefixNopList,              auth: false, method: 'GET'  },
  'getPengaturanBlokData':  { handler: getPengaturanBlokData,         auth: false, method: 'GET'  },
  'getKelompokTaniData':    { handler: getKelompokTaniData,           auth: false, method: 'GET'  },
  'getRecentTransactions':  { handler: handleGetRecentTransactions,   auth: false, method: 'GET'  },
  'getSuperuserSession':    { handler: handleGetSuperuserSession,     auth: false, method: 'GET'  },
  'superuserLogin':         { handler: handleSuperuserLogin,          auth: false, method: 'POST' },
  'superuserLogout':        { handler: handleSuperuserLogout,         auth: false, method: 'POST' },
  'runInitialInstall':      { handler: handleRunInitialInstall,       auth: false, method: 'POST' },

  /* ---------- Transaksi & pencarian lahan ---------- */
  /* BYPASSED: auth semua di-set false karena aplikasi single-user.
     requireSuperuser() sudah jadi no-op. Method tetap POST untuk
     operasi tulis agar body JSON terkirim dengan benar. */
  'getNOPInfoAndSisaLuas':  { handler: handleGetNOPInfoAndSisaLuas,   auth: false, method: 'POST' },
  'lookupPendudukByNIK':    { handler: handleLookupPendudukByNIK,     auth: false, method: 'POST' },
  'lookupNOP':              { handler: handleLookupNOP,               auth: false, method: 'POST' },
  'lookupKoordinatDbwp':    { handler: handleLookupKoordinatDbwp,     auth: false, method: 'POST' },
  'getTransaksiDetails':    { handler: handleGetTransaksiDetails,     auth: false, method: 'POST' },
  'getHistoriNIK':          { handler: handleGetHistoriNIK,           auth: false, method: 'POST' },
  'searchTransaksi':        { handler: handleSearchTransaksi,         auth: false, method: 'POST' },
  'getRekapByKelompok':     { handler: getRekapByKelompok,            auth: false, method: 'POST' },
  'getUnifiedLahanData':    { handler: getUnifiedLahanData,           auth: false, method: 'POST' },
  'generatePrintableHTML':  { handler: handleGeneratePrintableHTML,   auth: false, method: 'POST' },
  'saveTransaksi':          { handler: handleSaveTransaksi,           auth: false, method: 'POST' },
  'editTransaksi':          { handler: handleEditTransaksi,           auth: false, method: 'POST' },
  'softDeleteTransaksi':    { handler: handleSoftDeleteTransaksi,     auth: false, method: 'POST' },
  'syncKoordinatFromDbwp':  { handler: syncKoordinatFromDbwp,         auth: false, method: 'POST' },
  'syncAllDbwpBanding':     { handler: syncAllDbwpBanding,            auth: false, method: 'POST' },

  /* ---------- Master Data ---------- */
  'getDbwpData':            { handler: handleGetDbwpData,             auth: false, method: 'POST' },
  'addDbwpRow':             { handler: handleAddDbwpRow,              auth: false, method: 'POST' },
  'editDbwpRow':            { handler: handleEditDbwpRow,             auth: false, method: 'POST' },
  'addKelompokTani':        { handler: handleAddKelompokTani,         auth: false, method: 'POST' },
  'editKelompokTani':       { handler: handleEditKelompokTani,        auth: false, method: 'POST' },
  'deleteKelompokTani':     { handler: handleDeleteKelompokTani,      auth: false, method: 'POST' },
  'savePengaturanBlok':     { handler: handleSavePengaturanBlok,      auth: false, method: 'POST' },
  'deletePengaturanBlok':   { handler: handleDeletePengaturanBlok,    auth: false, method: 'POST' },
  'getUsersData':           { handler: getUsersData,                  auth: false, method: 'POST' },
  'saveUserData':           { handler: handleSaveUserData,            auth: false, method: 'POST' },
  'getConfigData':          { handler: getConfigData,                 auth: false, method: 'POST' },
  'saveConfigData':         { handler: handleSaveConfigData,          auth: false, method: 'POST' },

  /* ---------- Resume, Log & Arsip ---------- */
  'getResumeData':          { handler: getResumeData,                 auth: false, method: 'POST' },
  'getLogAktivitas':        { handler: handleGetLogAktivitas,         auth: false, method: 'POST' },
  'runArsipTahunan':        { handler: handleRunArsipTahunan,         auth: false, method: 'POST' },
  'searchArsipData':        { handler: handleSearchArsipData,         auth: false, method: 'POST' },

  /* ---------- Dokumentasi Foto Hard-Doc ----------
     Foto disimpan terkait ke ID_Transaksi (bukan NIK), karena satu NIK bisa
     punya banyak Transaksi seiring waktu (pendaftaran lahan bertahap).
     ID_Transaksi = 1 sesi input data = 1 sesi dokumentasi foto, sehingga
     tetap konsisten walau pola NIK-ke-transaksi di lapangan tidak seragam.
     Galeri per-NIK (lintas transaksi) tersedia lewat getDokumenFotoByNik. */
  'uploadDokumenFoto':         { handler: handleUploadDokumenFoto,         auth: false, method: 'POST' },
  'getDokumenFotoByTransaksi': { handler: handleGetDokumenFotoByTransaksi, auth: false, method: 'POST' },
  'getDokumenFotoByNik':       { handler: handleGetDokumenFotoByNik,       auth: false, method: 'POST' },
  'deleteDokumenFoto':         { handler: handleDeleteDokumenFoto,         auth: false, method: 'POST' }
};


/* ============================================================
 * BAGIAN 2 — HANDLER ROUTE (Adapter HTTP -> fungsi bisnis)
 * ============================================================ */

/* ---------- Handler publik ---------- */

/**
 * Endpoint Inisialisasi Data awal untuk Frontend (POS UI).
 * (dari Code.gs — dipakai sebagai handler route 'getInitialAppData')
 */
function getInitialAppData(params, token) {
  const sessionInfo = getSuperuserSession(token);
  const prefixList = getPrefixNopList();
  const recentTrx = getRecentTransactions(30);
  const blokList = getPengaturanBlokData();
  const kelompokList = getKelompokTaniData();

  return {
    isSuperuser: sessionInfo.isLogged,
    superuser: sessionInfo.user,
    prefixList: prefixList,
    recentTransactions: recentTrx,
    blokList: blokList,
    kelompokList: kelompokList
  };
}

function handleGetRecentTransactions(params) {
  var limit = parseInt(params.limit, 10) || 30;
  return getRecentTransactions(limit);
}

function handleGetSuperuserSession(params, token) {
  return getSuperuserSession(token);
}

function handleSuperuserLogin(params) {
  return superuserLogin(params.username, params.password);
}

function handleSuperuserLogout(params, token) {
  return superuserLogout(token);
}

/**
 * Ganti INSTALL_SECRET ini dengan string rahasia yang kuat setelah deploy.
 * Contoh: 'a8f3k2m9x1p4q7w5'
 */
var INSTALL_SECRET = 'CHANGE_ME_TO_A_STRONG_SECRET';

function handleRunInitialInstall(params) {
  if (String(params.confirm || '').toUpperCase() !== 'INSTALL') {
    return {
      success: false,
      message: 'Konfirmasi diperlukan. Kirim parameter confirm=INSTALL untuk menyiapkan struktur sheet database.'
    };
  }
  // Require secondary secret to prevent unauthenticated DB wipe
  if (String(params.installSecret || '') !== INSTALL_SECRET || INSTALL_SECRET === 'CHANGE_ME_TO_A_STRONG_SECRET') {
    return {
      success: false,
      message: 'Akses ditolak. installSecret tidak valid atau belum dikonfigurasi di server.'
    };
  }
  var force = (params.forceReset === true || String(params.forceReset) === 'true');
  return runInitialInstall(force);
}

/* ---------- Handler transaksi & lahan ---------- */

function handleGetNOPInfoAndSisaLuas(params, token) {
  return getNOPInfoAndSisaLuas(params.nop, token);
}

function handleLookupPendudukByNIK(params, token) {
  return lookupPendudukByNIK(params.nik, token);
}

function handleLookupNOP(params) {
  return lookupNOP(params.nop);
}

function handleLookupKoordinatDbwp(params) {
  return lookupKoordinatDbwp(params.blok, params.bidang);
}

function handleGetTransaksiDetails(params, token) {
  return getTransaksiDetails(params.idTransaksi, token);
}

function handleGetHistoriNIK(params) {
  return getHistoriNIK(params.nik);
}

function handleSearchTransaksi(params) {
  var filter = params.filter;
  if (typeof filter === 'string') {
    try {
      filter = JSON.parse(filter);
    } catch (e) {
      filter = null;
    }
  }
  if (!filter || typeof filter !== 'object') {
    filter = {
      keyword: params.keyword || '',
      blok: params.blok || '',
      kelompok: params.kelompok || '',
      status: params.status || ''
    };
  }
  return searchTransaksi(filter);
}

function handleGeneratePrintableHTML(params, token) {
  var sp = params.searchParams;
  if (typeof sp === 'string') {
    try {
      sp = JSON.parse(sp);
    } catch (e) {
      sp = {};
    }
  }
  return generatePrintableHTML(params.exportType, sp || {}, token);
}

function handleSaveTransaksi(params, token) {
  return saveTransaksi(params.formData || params, token);
}

function handleEditTransaksi(params, token) {
  return editTransaksi(params.idTransaksi, params.updateData || params, token);
}

function handleSoftDeleteTransaksi(params, token) {
  return softDeleteTransaksi(params.idTransaksi, params.operatorName, token);
}

/* ---------- Handler Dokumentasi Foto ---------- */

function handleUploadDokumenFoto(params, token) {
  return uploadDokumenFoto(params, token);
}

function handleGetDokumenFotoByTransaksi(params, token) {
  return getDokumenFotoByTransaksi(params.idTransaksi, token);
}

function handleGetDokumenFotoByNik(params, token) {
  return getDokumenFotoByNik(params.nik, token);
}

function handleDeleteDokumenFoto(params, token) {
  return deleteDokumenFoto(params.driveFileId, params.idTransaksi, token);
}

/* ---------- Handler master data ---------- */

function handleGetDbwpData(params, token) {
  var limit = parseInt(params.limit, 10) || 500;
  return getDbwpData(limit, token);
}

function handleAddDbwpRow(params, token) {
  return addDbwpRow(params.formData || params, token);
}

function handleEditDbwpRow(params, token) {
  return editDbwpRow(params.nopKey, params.formData || params, token);
}

function handleAddKelompokTani(params, token) {
  return addKelompokTani(params.formData || params, token);
}

function handleEditKelompokTani(params, token) {
  return editKelompokTani(params.id, params.formData || params, token);
}

function handleDeleteKelompokTani(params, token) {
  return deleteKelompokTani(params.id, token);
}

function handleSavePengaturanBlok(params, token) {
  return savePengaturanBlok(params.blok, params.kelompok, params.keterangan, token);
}

function handleDeletePengaturanBlok(params, token) {
  return deletePengaturanBlok(params.blok, token);
}

function handleSaveUserData(params, token) {
  return saveUserData(params.formData || params, token);
}

function handleSaveConfigData(params, token) {
  return saveConfigData(params.key, params.value, token);
}

/* ---------- Handler resume, log & arsip ---------- */

function handleGetLogAktivitas(params, token) {
  var limit = parseInt(params.limit, 10) || 200;
  return getLogAktivitas(limit, token);
}

function handleRunArsipTahunan(params, token) {
  return runArsipTahunan(params.tahun, token);
}

function handleSearchArsipData(params, token) {
  return searchArsipData(params.tahun, params.keyword, token);
}


/* ============================================================
 * BAGIAN 3 — AUTH (dari Auth.gs)
 * Autentikasi & Pengelolaan Sesi Superuser berbasis CacheService
 * ============================================================
 */

/**
 * Prefix key sesi pada CacheService.
 * Struktur key: RDKK_SES_<token>
 */
var SESSION_CACHE_PREFIX = 'RDKK_SES_';

/**
 * Batas maksimum masa simpan CacheService Apps Script (6 jam = 21600 detik).
 * Nilai SESSION_TIMEOUT_HOURS di Config tetap dipakai sebagai batas logis
 * sesi (disimpan pada field expireTime di dalam payload sesi).
 */
var SESSION_CACHE_MAX_SECONDS = 21600;

/* ============================================================
 * SECURITY UTILITIES — SHA-256, HTML Escape, Rate Limiting
 * ============================================================ */

/**
 * SHA-256 hash menggunakan Utilities.computeDigest (V8).
 * Menghasilkan hex string lowercase.
 */
function sha256Hex(input) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(input));
  return bytes.map(function(b) {
    return ('0' + ((b & 0xff).toString(16))).slice(-2);
  }).join('');
}

/**
 * Escape HTML untuk mencegah XSS pada generatePrintableHTML.
 */
function escapeHtml(val) {
  if (val === null || val === undefined) return '';
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Login rate limiter via CacheService.
 * Max 5 gagal per IP/username dalam 10 menit.
 */
var RATE_LIMIT_PREFIX = 'RDKK_RL_';
var RATE_LIMIT_WINDOW_SEC = 600; // 10 menit
var RATE_LIMIT_MAX_ATTEMPTS = 5;

function checkRateLimit(identifier) {
  var cache = CacheService.getScriptCache();
  var key = RATE_LIMIT_PREFIX + identifier;
  var raw = cache.get(key);
  var attempts = raw ? parseInt(raw, 10) : 0;
  if (attempts >= RATE_LIMIT_MAX_ATTEMPTS) {
    return false; // blocked
  }
  return true;
}

function incrementRateLimit(identifier) {
  var cache = CacheService.getScriptCache();
  var key = RATE_LIMIT_PREFIX + identifier;
  var raw = cache.get(key);
  var attempts = raw ? parseInt(raw, 10) : 0;
  attempts += 1;
  cache.put(key, String(attempts), RATE_LIMIT_WINDOW_SEC);
}

function clearRateLimit(identifier) {
  var cache = CacheService.getScriptCache();
  cache.remove(RATE_LIMIT_PREFIX + identifier);
}

/**
 * CURRENT_REQUEST_TOKEN removed — eliminated global race condition.
 * Tokens are now passed explicitly through function parameters, end-to-end:
 * dispatch(action, params, token) -> route.handler(params, token) -> fungsi inti(..., token).
 * setCurrentToken/getCurrentToken dihapus karena tidak lagi dipakai di manapun.
 */

/**
 * Membuat token sesi acak yang sulit ditebak.
 */
function generateSessionToken() {
  return Utilities.getUuid().replace(/-/g, '') + String(new Date().getTime());
}

/**
 * Login Superuser.
 * Menghasilkan token sesi acak yang disimpan di CacheService dan
 * dikembalikan ke klien untuk dipakai pada request berikutnya.
 */
function superuserLogin(username, password) {
  const cleanUser = sanitizeInput(username);
  const cleanPass = sanitizeInput(password);

  if (!cleanUser || !cleanPass) {
    return { success: false, message: 'Username dan password wajib diisi!' };
  }

  // Rate limiting per username
  if (!checkRateLimit(cleanUser)) {
    return { success: false, message: 'Terlalu banyak percobaan login gagal. Coba lagi dalam 10 menit.' };
  }

  const passHash = sha256Hex(cleanPass);
  const { data } = getSheetData('Users');
  let foundUser = null;

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const uName = String(row[0]).trim();
    const uPass = String(row[1]).trim();
    const uRole = String(row[2]).trim();
    const uFullName = String(row[3]).trim();
    const uStatus = String(row[4]).trim();

    // Support both hashed (64-char hex) and legacy plain-text passwords
    const isMatch = (uPass.length === 64 && /^[a-f0-9]+$/.test(uPass))
      ? uPass === passHash
      : uPass === cleanPass;

    if (uName === cleanUser && isMatch) {
      if (uStatus !== 'Aktif') {
        incrementRateLimit(cleanUser);
        return { success: false, message: 'Akun Anda sedang nonaktif.' };
      }
      if (uRole !== 'Superuser') {
        incrementRateLimit(cleanUser);
        return { success: false, message: 'Akses terbatas untuk Superuser saja.' };
      }
      foundUser = { username: uName, role: uRole, namaLengkap: uFullName };
      break;
    }
  }

  if (!foundUser) {
    incrementRateLimit(cleanUser);
    return { success: false, message: 'Username atau password salah!' };
  }

  // Login berhasil — reset rate limit
  clearRateLimit(cleanUser);

  // Set Session di CacheService (key = token acak)
  // Catatan: CacheService Apps Script punya batas keras 6 jam (21600 detik).
  // timeoutHours di-clamp ke batas itu agar expireTime "logis" tidak pernah
  // melebihi umur cache sesungguhnya — mencegah user merasa "logout tiba-tiba"
  // sebelum waktu yang tertulis di Config karena entry cache sudah dihapus GAS duluan.
  const maxTimeoutHours = SESSION_CACHE_MAX_SECONDS / 3600;
  const configuredTimeoutHours = parseInt(getConfigValue('SESSION_TIMEOUT_HOURS', String(maxTimeoutHours)), 10) || maxTimeoutHours;
  const timeoutHours = Math.min(configuredTimeoutHours, maxTimeoutHours);
  const expireTime = new Date().getTime() + (timeoutHours * 60 * 60 * 1000);

  const token = generateSessionToken();
  const sessionData = {
    username: foundUser.username,
    role: foundUser.role,
    namaLengkap: foundUser.namaLengkap,
    token: token,
    expireTime: expireTime
  };

  const cacheSeconds = Math.min(Math.ceil(timeoutHours * 3600), SESSION_CACHE_MAX_SECONDS);
  CacheService.getScriptCache().put(
    SESSION_CACHE_PREFIX + token,
    JSON.stringify(sessionData),
    cacheSeconds
  );

  // Tulis log login
  writeLog('SYSTEM', 'Login', '-', `User ${foundUser.username} berhasil login`, foundUser.username, foundUser.role);

  return {
    success: true,
    user: foundUser,
    token: token,
    message: 'Login berhasil!'
  };
}

/**
 * Cek status autentikasi Superuser berdasarkan token.
 * Jika token tidak diberikan, dipakai token request yang sedang aktif.
 */
function getSuperuserSession(token) {
  const tk = (token !== undefined && token !== null && String(token) !== '')
    ? String(token)
    : '';

  if (!tk) return { isLogged: false, user: null };

  const cache = CacheService.getScriptCache();
  const cacheKey = SESSION_CACHE_PREFIX + tk;
  const sessionStr = cache.get(cacheKey);
  if (!sessionStr) return { isLogged: false, user: null };

  try {
    const session = JSON.parse(sessionStr);
    const now = new Date().getTime();

    if (now > session.expireTime) {
      cache.remove(cacheKey);
      return { isLogged: false, user: null, reason: 'Session expired' };
    }

    return {
      isLogged: true,
      token: tk,
      user: {
        username: session.username,
        role: session.role,
        namaLengkap: session.namaLengkap
      }
    };
  } catch (e) {
    cache.remove(cacheKey);
    return { isLogged: false, user: null };
  }
}

/**
 * Logout Superuser — menghapus sesi dari CacheService.
 */
function superuserLogout(token) {
  const sessionInfo = getSuperuserSession(token);
  if (sessionInfo.isLogged) {
    writeLog('SYSTEM', 'Logout', '-', `User ${sessionInfo.user.username} logout`, sessionInfo.user.username, sessionInfo.user.role);
  }

  const tk = (token !== undefined && token !== null && String(token) !== '')
    ? String(token)
    : '';

  if (tk) {
    CacheService.getScriptCache().remove(SESSION_CACHE_PREFIX + tk);
  }

  return { success: true, message: 'Berhasil logout.' };
}

/**
 * Helper untuk memvalidasi hak akses Superuser di backend.
 *
 * PENTING: `token` WAJIB diteruskan secara eksplisit oleh pemanggil.
 * (Sebelumnya fungsi ini bergantung pada flag global `_REQUEST_AUTH_VALIDATED`
 * yang tidak pernah di-set true di manapun, sehingga SETIAP panggilan tanpa
 * token selalu gagal dengan "Akses Ditolak" walau dispatch() sudah memvalidasi
 * token yang benar. Flag global itu sudah dihapus total — token kini mengalir
 * eksplisit dari dispatch() -> handler -> fungsi inti, tanpa state global yang
 * bisa bocor/rancu antar-request.)
 */
function requireSuperuser(token) {
  // BYPASSED: Aplikasi single-user, tidak perlu autentikasi.
  // Fungsi ini sengaja dijadikan no-op agar tidak ada overhead CacheService
  // pada setiap request. Login UI tetap bisa dipakai tapi tidak diwajibkan.
  return { username: 'Admin', role: 'Superuser', namaLengkap: 'Admin' };
}


/* ============================================================
 * BAGIAN 4 — UTIL (dari Util.gs)
 * Helper functions & shared utilities
 * ============================================================
 */

function zeroPad(num, length) {
  let str = String(num || 0).trim();
  while (str.length < length) {
    str = '0' + str;
  }
  return str;
}

function generateTransactionId() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Pendaftar_RDKK');
  if (!sheet) return 'TRX-0001';

  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return 'TRX-0001';

  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
  let maxNum = 0;

  for (let i = 0; i < ids.length; i++) {
    const match = String(ids[i]).match(/^TRX-(\d+)$/i);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }

  const nextNum = maxNum + 1;
  return 'TRX-' + zeroPad(nextNum, 4);
}

/**
 * Request-scoped cache for sheet data and auth state.
 * Eliminates redundant full-sheet reads within a single API request cycle.
 * Cleared automatically at the end of each dispatch() call.
 */
var _REQUEST_SHEET_CACHE = {};

/**
 * OPTIMASI (lintas-request): sheet referensi yang jarang berubah dan TIDAK
 * terlibat langsung dalam kalkulasi konkurensi-sensitif (sisa luas, deteksi
 * duplikasi transaksi) boleh di-cache singkat lewat CacheService.
 * TTL sengaja pendek (60 detik) — cukup untuk memangkas beban baca berulang
 * pada trafik tinggi, tapi tidak membuat perubahan admin terasa "lambat masuk".
 */
var CACHEABLE_REFERENCE_SHEETS = {
  'Pengaturan_Blok': true,
  'Kelompok_Tani': true,
  'Config': true
};
var REFERENCE_CACHE_PREFIX = 'RDKK_SHEET_';
var REFERENCE_CACHE_TTL_SECONDS = 60;

function clearRequestCache() {
  _REQUEST_SHEET_CACHE = {};
}

function getSheetData(sheetName) {
  // Return cached result if available within this request cycle
  if (_REQUEST_SHEET_CACHE[sheetName]) {
    return _REQUEST_SHEET_CACHE[sheetName];
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // OPTIMASI: sheet referensi yang jarang berubah (bukan bagian dari
  // kalkulasi sisa-luas yang sensitif konkurensi) di-cache lintas-request
  // lewat CacheService selama beberapa detik, supaya tidak selalu
  // memicu full-sheet read ke Sheets API pada setiap request.
  // `dbwp` dan `Pendaftar_RDKK` SENGAJA TIDAK di-cache di sini karena
  // menjadi basis perhitungan sisa luas & deteksi duplikasi yang harus
  // selalu membaca data ter-terbaru (real-time) demi konsistensi data.
  if (CACHEABLE_REFERENCE_SHEETS[sheetName]) {
    try {
      const cachedRaw = CacheService.getScriptCache().get(REFERENCE_CACHE_PREFIX + sheetName);
      if (cachedRaw) {
        const cachedParsed = JSON.parse(cachedRaw);
        const result = {
          headers: cachedParsed.headers,
          data: cachedParsed.data,
          sheet: ss.getSheetByName(sheetName)
        };
        _REQUEST_SHEET_CACHE[sheetName] = result;
        return result;
      }
    } catch (e) {
      // Abaikan error cache (mis. entri korup/limit ukuran) — lanjut baca langsung dari Sheets.
    }
  }

  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    const empty = { headers: [], data: [], sheet: null };
    _REQUEST_SHEET_CACHE[sheetName] = empty;
    return empty;
  }

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow === 0 || lastCol === 0) {
    const empty = { headers: [], data: [], sheet: sheet };
    _REQUEST_SHEET_CACHE[sheetName] = empty;
    return empty;
  }

  const rawValues = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = rawValues[0] || [];
  const data = rawValues.slice(1);

  const result = { headers, data, sheet };
  _REQUEST_SHEET_CACHE[sheetName] = result;

  if (CACHEABLE_REFERENCE_SHEETS[sheetName]) {
    try {
      CacheService.getScriptCache().put(
        REFERENCE_CACHE_PREFIX + sheetName,
        JSON.stringify({ headers: headers, data: data }),
        REFERENCE_CACHE_TTL_SECONDS
      );
    } catch (e) {
      // Payload terlalu besar / limit tercapai — abaikan, tidak fatal.
    }
  }

  return result;
}

/**
 * Hapus cache lintas-request untuk sheet referensi tertentu.
 * WAJIB dipanggil setelah setiap operasi tulis ke salah satu
 * CACHEABLE_REFERENCE_SHEETS agar pembaca berikutnya tidak melihat data basi.
 */
function invalidateReferenceCache(sheetName) {
  if (!CACHEABLE_REFERENCE_SHEETS[sheetName]) return;
  try {
    CacheService.getScriptCache().remove(REFERENCE_CACHE_PREFIX + sheetName);
  } catch (e) {
    // no-op
  }
  delete _REQUEST_SHEET_CACHE[sheetName];
}

function invalidateDataSetCache(pattern) {
  try {
    const cache = CacheService.getScriptCache();
    const keys = [
      'RDKK_DATASET_LAHAN',
      'RDKK_DATASET_DBWP',
      'RDKK_DATASET_INITIAL',
      'RDKK_DATASET_ADMIN'
    ];
    keys.forEach(function(key) {
      if (!pattern || key.indexOf(pattern) !== -1) {
        cache.remove(key);
      }
    });
  } catch (e) {
    // ignore cache invalidation errors
  }
}

function getConfigValue(key, defaultValue) {
  const { data } = getSheetData('Config');
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim().toUpperCase() === String(key).trim().toUpperCase()) {
      const val = data[i][1];
      if (val !== null && val !== undefined && val !== '') {
        return String(val).trim();
      }
    }
  }
  return defaultValue !== undefined ? String(defaultValue) : '';
}

function formatDateTime(dateObj) {
  if (!dateObj) return '';
  const d = new Date(dateObj);
  if (isNaN(d.getTime())) return String(dateObj);

  const yyyy = d.getFullYear();
  const mm = zeroPad(d.getMonth() + 1, 2);
  const dd = zeroPad(d.getDate(), 2);
  const hh = zeroPad(d.getHours(), 2);
  const min = zeroPad(d.getMinutes(), 2);
  const ss = zeroPad(d.getSeconds(), 2);

  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

function sanitizeInput(str) {
  if (str === null || str === undefined) return '';
  return String(str).trim();
}


/* ============================================================
 * BAGIAN 5 — NOP (dari NOP.gs)
 * Logika Generate, Lookup NOP & Kalkulasi Sisa Luas
 * ============================================================
 */

/**
 * Mengambil daftar prefix NOP yang tersedia di Config.
 * Default prefix 10 digit: 3510071003 (Propinsi 35, Kota 10, Kecamatan 071, Desa 003)
 */
function getPrefixNopList() {
  const configVal = String(getConfigValue('PREFIX_NOP', '3510071003') || '3510071003');
  const prefixes = configVal.split(',').map(p => p.trim()).filter(p => p.length > 0);
  return prefixes.length > 0 ? prefixes : ['3510071003'];
}

/**
 * Membersihkan string NOP menjadi hanya digit angka (untuk pencocokan fleksibel).
 */
function cleanNOPDigits(nop) {
  return String(nop || '').replace(/[^0-9]/g, '');
}

/**
 * Memformat string 18 digit angka menjadi format baku bertitik:
 * [Prefix 10 digit].[Blok 3 digit].[Bidang 4 digit].[Sisa/Akhiran 1 digit]
 * Contoh: 351007100302000010 => 3510071003.020.0001.0
 */
function formatNOP(rawNop) {
  const digits = cleanNOPDigits(rawNop);
  if (digits.length === 18) {
    return `${digits.substring(0, 10)}.${digits.substring(10, 13)}.${digits.substring(13, 17)}.${digits.substring(17, 18)}`;
  }
  return String(rawNop || '');
}

/**
 * Generate NOP dari Prefix, Blok, Nomor Bidang, dan Sisa/Akhiran.
 * 
 * Struktur Penomoran NOP:
 * 351007100300101300
 * ----------xxx****s
 *      |     |  |  |
 *      |     |  |  +--> s: akhiran/sisa (1 digit, default "0")
 *      |     |  +-----> ****: nomor bidang (4 digit, misal nomor 1 => 0001)
 *      |     +--------> xxx: nomor blok (3 digit, misal blok 20 => 020)
 *      +--------------> ----------: prefix wilayah (10 digit, misal 3510071003)
 * 
 * Hasil: prefix.blok.bidang.sisa (misal: "3510071003.020.0001.0")
 */
function generateNOP(blok, bidang, selectedPrefix, sisa) {
  const prefixList = getPrefixNopList();
  let prefix = selectedPrefix ? String(selectedPrefix).trim() : prefixList[0];

  // Bersihkan prefix dari simbol/titik
  prefix = prefix.replace(/[^0-9]/g, '');
  // Jika prefix sebelumnya terlanjur 11 digit dengan trailing 0 (misal 35100710030), ambil 10 digit
  if (prefix.length === 11 && prefix.endsWith('0')) {
    prefix = prefix.substring(0, 10);
  }

  const cleanBlok = zeroPad(blok, 3);
  const cleanBidang = zeroPad(bidang, 4);
  const cleanSisa = (sisa !== undefined && sisa !== null && String(sisa).trim() !== '')
    ? String(sisa).trim().substring(0, 1)
    : '0';

  return `${prefix}.${cleanBlok}.${cleanBidang}.${cleanSisa}`;
}

/**
 * Lookup data NOP di sheet `dbwp`.
 * Header dbwp: No.(0), NOP(1), Blok(2), Bidang(3), Nama WP(4), Alamat WP(5), Luas pbb(6), Koordinat(7)
 * Mendukung pencarian baik dengan format bertitik maupun raw angka 18 digit.
 */
function lookupNOP(targetNOP) {
  const cleanNOP = sanitizeInput(targetNOP);
  if (!cleanNOP) return null;

  const targetDigits = cleanNOPDigits(cleanNOP);
  const { data } = getSheetData('dbwp');

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const nopInSheet = String(row[1]).trim();
    const sheetDigits = cleanNOPDigits(nopInSheet);

    const isMatch = (nopInSheet === cleanNOP) ||
                    (targetDigits.length >= 15 && sheetDigits === targetDigits);

    if (isMatch) {
      return {
        found: true,
        nop: nopInSheet,
        blok: Number(row[2] || 0),
        bidang: Number(row[3] || 0),
        namaWP: String(row[4] || '').trim(),
        alamatWP: String(row[5] || '').trim(),
        luasPBB: Number(row[6] || 0),
        koordinat: String(row[7] || '').trim()
      };
    }
  }

  return {
    found: false,
    nop: cleanNOP,
    blok: 0,
    bidang: 0,
    namaWP: '-',
    alamatWP: '-',
    luasPBB: 0,
    koordinat: ''
  };
}

/**
 * Menghitung sisa luas PBB dan riwayat pendaftar lain untuk suatu NOP.
 * Membaca data aktif di sheet `Pendaftar_RDKK`.
 * Mendukung pencocokan format bertitik maupun raw 18 digit.
 */
function getNOPInfoAndSisaLuas(targetNOP, token) {
  // Guard: endpoint ini hanya dapat diakses oleh Superuser (token diteruskan pemanggil).
  requireSuperuser(token);

  const cleanNOP = sanitizeInput(targetNOP);
  const targetDigits = cleanNOPDigits(cleanNOP);
  const nopData = lookupNOP(cleanNOP);

  const { data } = getSheetData('Pendaftar_RDKK');
  let totalLuasDidaftarkan = 0;
  const existingRegistrations = [];

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const idTrx = String(row[0]).trim();
    const nik = String(row[3]).trim();
    const namaPetani = String(row[4]).trim();
    const nopInRow = String(row[9]).trim();   // J: NOP
    const rowDigits = cleanNOPDigits(nopInRow);
    const luasDidaftarkan = Number(row[13] || 0); // N: Luas Didaftarkan
    const statusTrx = String(row[15]).trim();    // P: Status Transaksi

    // Hanya hitung transaksi yang 'Aktif' atau 'Melebihi Kapasitas'
    const isMatch = (nopInRow === cleanNOP) ||
                    (targetDigits.length >= 15 && rowDigits === targetDigits);

    if (isMatch && statusTrx !== 'Dibatalkan') {
      totalLuasDidaftarkan += luasDidaftarkan;
      existingRegistrations.push({
        idTransaksi: idTrx,
        nik: nik,
        namaPetani: namaPetani,
        luasDidaftarkan: luasDidaftarkan,
        statusTransaksi: statusTrx
      });
    }
  }

  const sisaLuas = (nopData.luasPBB || 0) - totalLuasDidaftarkan;

  // Ambil koordinat langsung dari data lookupNOP (sudah ada di row[7] dbwp)
  const koordinat = nopData.koordinat || '';

  return {
    nopInfo: nopData,
    totalTerdaftar: totalLuasDidaftarkan,
    sisaLuas: sisaLuas,
    registrations: existingRegistrations,
    koordinat: koordinat
  };
}

/**
 * Mencari titik koordinat di sheet `dbwp` berdasarkan nomor blok dan nomor bidang.
 * Header dbwp: No.(0), NOP(1), Blok(2), Bidang(3), Nama WP(4), Alamat WP(5), Luas pbb(6), Koordinat(7)
 */
function lookupKoordinatDbwp(blok, bidang) {
  try {
    const bNum = parseInt(blok, 10);
    const bdNum = parseInt(bidang, 10);
    if (isNaN(bNum) || isNaN(bdNum)) return '';

    const { data } = getSheetData('dbwp');
    if (!data || data.length === 0) return '';

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rBlok = parseInt(row[2], 10);
      const rBidang = parseInt(row[3], 10);
      if (rBlok === bNum && rBidang === bdNum) {
        return String(row[7] || '').trim();
      }
    }
  } catch (e) {}
  return '';
}


/* ============================================================
 * BAGIAN 6 — TRANSAKSI (dari Transaksi.gs)
 * Core CRUD & Transaksi e-RDKK dengan LockService
 * ============================================================
 */

/**
 * Menyimpan Transaksi Pendaftaran e-RDKK Baru (Multi-Bidang didukung).
 * Menggunakan LockService untuk mencegah Race Condition saat kalkulasi sisa luas.
 */
function saveTransaksi(formData, token) {
  // Guard: endpoint ini hanya dapat diakses oleh Superuser (token diteruskan pemanggil).
  requireSuperuser(token);

  const lock = LockService.getScriptLock();
  const hasLock = lock.tryLock(10000); // Tunggu maks 10 detik

  if (!hasLock) {
    return {
      success: false,
      message: 'Sistem sedang sibuk memproses transaksi lain pada saat bersamaan. Silakan coba klik Simpan lagi.'
    };
  }

  try {
    const nik = sanitizeInput(formData.nik);
    const namaPetani = sanitizeInput(formData.namaPetani);
    const alamatPetani = sanitizeInput(formData.alamatPetani);
    const nomorHp = sanitizeInput(formData.nomorHp || '');
    const operatorName = sanitizeInput(formData.operatorName) || 'Operator Lapangan';

    // 1. Validasi Identitas Petani
    if (!nik || nik.length !== 16 || isNaN(nik)) {
      return { success: false, message: 'NIK wajib 16 digit angka!' };
    }
    if (!namaPetani) {
      return { success: false, message: 'Nama Petani wajib diisi!' };
    }

    // Normalisasi bidangs (Array) atau fallback single bidang
    let bidangs = formData.bidangs;
    if (!Array.isArray(bidangs) || bidangs.length === 0) {
      bidangs = [{
        prefixNop: formData.prefixNop,
        blok: formData.blok,
        nomorBidang: formData.nomorBidang,
        luasDidaftarkan: formData.luasDidaftarkan,
        keterangan: formData.keterangan
      }];
    }

    // 2. Validasi & Kalkulasi seluruh bidang
    const toleransiConfig = getConfigValue('TOLERANSI_LEBIH_LUAS', 'IZINKAN').toUpperCase();
    const validatedBidangs = [];
    const runningNopAllocations = {}; // NOP -> akumulasi luas yang didaftarkan dalam transaksi ini

    for (let i = 0; i < bidangs.length; i++) {
      const b = bidangs[i];
      const blok = parseInt(b.blok, 10) || 0;
      const nomorBidang = parseInt(b.nomorBidang, 10) || 0;
      const prefixNop = sanitizeInput(b.prefixNop);
      const luasDidaftarkan = parseFloat(b.luasDidaftarkan) || 0;
      const keterangan = sanitizeInput(b.keterangan || '');
      const koordinat = sanitizeInput(b.koordinat || '');

      if (blok <= 0 || nomorBidang <= 0) {
        return {
          success: false,
          message: `Bidang #${i + 1}: Nomor Blok dan Nomor Bidang harus angka positif!`
        };
      }
      if (luasDidaftarkan <= 0) {
        return {
          success: false,
          message: `Bidang #${i + 1}: Luas Didaftarkan harus lebih besar dari 0!`
        };
      }
      // Sanity check tambahan: batas atas wajar untuk mencegah salah ketik luas
      // (mis. kelebihan angka nol) — terutama penting untuk NOP yang TIDAK
      // ditemukan di dbwp, karena di kasus itu tidak ada luasPBB pembanding
      // sehingga pengecekan "melebihi sisa kapasitas" di bawah tidak berlaku.
      const maxLuasWajar = parseFloat(getConfigValue('MAX_LUAS_PER_BIDANG_M2', '50000')) || 50000;
      if (luasDidaftarkan > maxLuasWajar) {
        return {
          success: false,
          message: `Bidang #${i + 1}: Luas Didaftarkan (${luasDidaftarkan} m²) melebihi batas wajar (${maxLuasWajar} m²). Periksa kembali kemungkinan salah ketik. Batas ini dapat diubah lewat Pengaturan > Config (key: MAX_LUAS_PER_BIDANG_M2).`
        };
      }

      // Generate NOP & Lookup dbwp
      const generatedNOP = generateNOP(blok, nomorBidang, prefixNop);
      const nopInfo = getNOPInfoAndSisaLuas(generatedNOP, token);
      const lookupData = nopInfo.nopInfo;

      const statusNOP = lookupData.found ? 'Ditemukan' : 'Tidak Ditemukan';
      const namaWP = lookupData.namaWP || '';
      const luasPBB = lookupData.luasPBB || 0;

      // Kalkulasi sisa luas memperhitungkan jika ada bidang lain dalam transaksi ini dengan NOP sama
      const priorInTrx = runningNopAllocations[generatedNOP] || 0;
      const sisaLuasSebelum = nopInfo.sisaLuas - priorInTrx;
      const sisaLuasSesudah = sisaLuasSebelum - luasDidaftarkan;
      runningNopAllocations[generatedNOP] = priorInTrx + luasDidaftarkan;

      let statusTransaksi = 'Aktif';
      if (lookupData.found && sisaLuasSesudah < 0) {
        if (toleransiConfig === 'TOLAK') {
          return {
            success: false,
            message: `Gagal Simpan Bidang #${i + 1} (NOP ${generatedNOP}): Luas didaftarkan (${luasDidaftarkan} m²) melebihi sisa kapasitas PBB (${sisaLuasSebelum} m²). Sistem dikonfigurasi menolak over-alokasi.`
          };
        }
        statusTransaksi = 'Melebihi Kapasitas';
      }

      validatedBidangs.push({
        blok,
        nomorBidang,
        prefixNop,
        generatedNOP,
        statusNOP,
        namaWP,
        luasPBB,
        luasDidaftarkan,
        sisaLuasSesudah,
        statusTransaksi,
        keterangan,
        koordinat
      });
    }

    // 3. Generate 1 ID Transaksi
    const idTransaksi = generateTransactionId();
    const today = new Date();
    const currentYear = today.getFullYear();

    // 4. Siapkan batch baris ke Sheet Pendaftar_RDKK
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName('Pendaftar_RDKK');
    if (!sheet) {
      setupPendaftarRDKK(ss, false);
      sheet = ss.getSheetByName('Pendaftar_RDKK');
    }

    // Pastikan header Kolom R (18) adalah 'Koordinat'
    if (String(sheet.getRange(1, 18).getValue() || '').trim() !== 'Koordinat') {
      sheet.getRange(1, 18).setValue('Koordinat');
    }
    // Pastikan header Kolom G (7) sesuai format yang umum dipakai: 'Nomor_Hp' / 'Nomor Hp'
    const headerG = String(sheet.getRange(1, 7).getValue() || '').trim();
    const normalizedHeaderG = headerG.replace(/[_\s]+/g, '').toLowerCase();
    if (normalizedHeaderG !== 'nomorhp') {
      sheet.getRange(1, 7).setValue('Nomor_Hp');
    }

    const rowsToInsert = validatedBidangs.map(b => [
      idTransaksi,        // A:1  = ID_Transaksi
      currentYear,        // B:2  = Tahun
      today,              // C:3  = Tanggal Input
      nik,                // D:4  = NIK
      namaPetani,         // E:5  = Nama Petani
      alamatPetani,       // F:6  = Alamat Petani
      nomorHp,            // G:7  = Nomor Hp
      b.blok,             // H:8  = Blok
      b.nomorBidang,      // I:9  = Nomor Bidang
      b.generatedNOP,     // J:10 = NOP
      b.statusNOP,        // K:11 = Status NOP
      b.namaWP,           // L:12 = Nama WP (ref)
      b.luasPBB,          // M:13 = Luas PBB (ref)
      b.luasDidaftarkan,  // N:14 = Luas Didaftarkan
      b.sisaLuasSesudah,  // O:15 = Sisa Luas PBB
      b.statusTransaksi,  // P:16 = Status Transaksi
      b.keterangan,       // Q:17 = Keterangan
      b.koordinat || ''   // R:18 = Koordinat
    ]);

    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, rowsToInsert.length, 18).setValues(rowsToInsert);

    // Format tampilan sel
    sheet.getRange(startRow, 3, rowsToInsert.length, 1).setNumberFormat('dd/mm/yyyy hh:mm');
    sheet.getRange(startRow, 13, rowsToInsert.length, 3).setNumberFormat('#,##0');

    // 5. Audit Trail Log
    const sessionInfo = getSuperuserSession(token);
    const roleName = sessionInfo.isLogged ? 'Superuser' : 'User';
    const logUser = sessionInfo.isLogged ? sessionInfo.user.username : operatorName;

    const totalLuas = validatedBidangs.reduce((acc, curr) => acc + curr.luasDidaftarkan, 0);
    const hasWarning = validatedBidangs.some(b => b.statusTransaksi === 'Melebihi Kapasitas');

    writeLog(
      idTransaksi,
      'Tambah',
      '-',
      {
        NIK: nik,
        Nama: namaPetani,
        JumlahBidang: validatedBidangs.length,
        TotalLuas: totalLuas,
        NOPs: validatedBidangs.map(b => b.generatedNOP).join(', ')
      },
      logUser,
      roleName
    );

    // Sinkronisasi status ke sheet dbwp-banding
    try {
      updateDbwpBandingByNOPs(validatedBidangs.map(b => b.generatedNOP));
    } catch (e) {}

    invalidateDataSetCache('LAHAN');
    invalidateDataSetCache('DBWP');
    invalidateDataSetCache('INITIAL');
    invalidateDataSetCache('ADMIN');

    return {
      success: true,
      idTransaksi: idTransaksi,
      totalBidang: validatedBidangs.length,
      totalLuas: totalLuas,
      hasWarning: hasWarning,
      message: hasWarning
        ? `Transaksi ${idTransaksi} (${validatedBidangs.length} Bidang) berhasil disimpan dengan Peringatan: Terdapat bidang melebihi kapasitas PBB.`
        : `Transaksi ${idTransaksi} (${validatedBidangs.length} Bidang, Total ${totalLuas.toLocaleString('id-ID')} m²) berhasil disimpan!`
    };

  } catch (err) {
    return { success: false, message: 'Terjadi kesalahan server: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Mengambil detail lengkap transaksi berdasarkan ID Transaksi (Multi-Bidang didukung).
 */
function getTransaksiDetails(idTransaksi, token) {
  // Guard: endpoint ini hanya dapat diakses oleh Superuser (token diteruskan pemanggil).
  requireSuperuser(token);

  const cleanId = String(idTransaksi || '').trim();
  if (!cleanId) return { success: false, message: 'ID Transaksi tidak valid.' };

  const { data } = getSheetData('Pendaftar_RDKK');
  const matchingRows = [];

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (String(row[0]).trim() === cleanId) {
      matchingRows.push({
        rowNumber: i + 2,
        idTransaksi: String(row[0]),
        tahun: row[1],
        tanggal: formatDateTime(row[2]),
        nik: String(row[3]),
        namaPetani: String(row[4]),
        alamatPetani: String(row[5]),
        nomorHp: String(row[6] || ''),
        blok: row[7],
        nomorBidang: row[8],
        nop: String(row[9]),
        prefixNop: String(row[9]).includes('.') ? String(row[9]).split('.')[0] : (String(row[9]).length >= 10 ? String(row[9]).substring(0, 10) : '3510071003'),
        statusNOP: String(row[10]),
        namaWP: String(row[11]),
        luasPBB: Number(row[12] || 0),
        luasDidaftarkan: Number(row[13] || 0),
        sisaLuasPBB: Number(row[14] || 0),
        statusTransaksi: String(row[15]),
        keterangan: String(row[16] || ''),
        koordinat: String(row[17] || '')  // R:18 = Koordinat
      });
    }
  }

  if (matchingRows.length === 0) {
    return { success: false, message: 'Transaksi tidak ditemukan.' };
  }

  const base = matchingRows[0];
  return {
    success: true,
    transaksi: {
      idTransaksi: base.idTransaksi,
      nik: base.nik,
      namaPetani: base.namaPetani,
      alamatPetani: base.alamatPetani,
      tanggal: base.tanggal,
      inputOleh: base.inputOleh,
      bidangs: matchingRows
    }
  };
}

/**
 * Mengambil histori pendaftaran berdasarkan NIK.
 */
function getHistoriNIK(nik) {
  const cleanNIK = sanitizeInput(nik);
  if (!cleanNIK) return [];

  const { data } = getSheetData('Pendaftar_RDKK');
  const result = [];

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (String(row[3]).trim() === cleanNIK) {
      result.push({
        idTransaksi: String(row[0]),
        tahun: row[1],
        tanggal: formatDateTime(row[2]),
        nik: String(row[3]),
        namaPetani: String(row[4]),
        alamatPetani: String(row[5]),
        nomorHp: String(row[6] || ''),
        blok: row[7],
        nomorBidang: row[8],
        nop: String(row[9]),
        statusNOP: String(row[10]),
        namaWP: String(row[11]),
        luasPBB: row[12],
        luasDidaftarkan: row[13],
        sisaLuasPBB: row[14],
        statusTransaksi: String(row[15]),
        keterangan: String(row[16]),
        koordinat: String(row[17] || '')   // R:18 = Koordinat
      });
    }
  }

  return result;
}

/**
 * Lookup data NIK ke sheet `penduduk`.
 * Jika ditemukan di sheet `penduduk`, kembalikan nama dan alamat.
 * Jika tidak ditemukan, fallback mencari di riwayat transaksi `Pendaftar_RDKK`.
 */
function lookupPendudukByNIK(nik, token) {
  // Guard: endpoint ini hanya dapat diakses oleh Superuser (token diteruskan pemanggil).
  requireSuperuser(token);

  const cleanNIK = sanitizeInput(nik);
  if (!cleanNIK) {
    return { found: false, source: '', nama: '', alamat: '', historyCount: 0 };
  }

  // 1. Cek di sheet `penduduk` (Header: NIK (0), Nama Lengkap (1), Alamat (2))
  const { data: pendudukData } = getSheetData('penduduk');
  for (let i = 0; i < pendudukData.length; i++) {
    const row = pendudukData[i];
    if (String(row[0]).trim() === cleanNIK) {
      const history = getHistoriNIK(cleanNIK);
      return {
        found: true,
        source: 'penduduk',
        nama: String(row[1] || '').trim(),
        alamat: String(row[2] || '').trim(),
        historyCount: history.length
      };
    }
  }

  // 2. Fallback: Cek di histori transaksi `Pendaftar_RDKK`
  const history = getHistoriNIK(cleanNIK);
  if (history && history.length > 0) {
    const last = history[0];
    return {
      found: true,
      source: 'histori',
      nama: last.namaPetani || '',
      alamat: last.alamatPetani || '',
      historyCount: history.length
    };
  }

  return { found: false, source: '', nama: '', alamat: '', historyCount: 0 };
}

/**
 * Mengambil daftar transaksi terbaru (untuk sidebar POS / dashboard).
 */
function getRecentTransactions(limit) {
  const { data } = getSheetData('Pendaftar_RDKK');
  const result = [];
  const maxRows = limit || 50;

  for (let i = data.length - 1; i >= 0 && result.length < maxRows; i--) {
    const row = data[i];
    result.push({
      idTransaksi: String(row[0]),
      tahun: row[1],
      tanggal: formatDateTime(row[2]),
      nik: String(row[3]),
      namaPetani: String(row[4]),
      alamatPetani: String(row[5]),
      nomorHp: String(row[6] || ''),
      blok: row[7],
      nomorBidang: row[8],
      nop: String(row[9]),
      statusNOP: String(row[10]),
      namaWP: String(row[11]),
      luasPBB: row[12],
      luasDidaftarkan: row[13],
      sisaLuasPBB: row[14],
      statusTransaksi: String(row[15]),
      keterangan: String(row[16]),
      koordinat: String(row[17] || '')  // R:18 = Koordinat
    });
  }

  return result;
}

/**
 * Update Transaksi Pendaftaran (Multi-Bidang didukung).
 */
function editTransaksi(idTransaksi, updateData, token) {
  // Guard: endpoint ini hanya dapat diakses oleh Superuser (token diteruskan pemanggil).
  requireSuperuser(token);

  const lock = LockService.getScriptLock();
  const hasLock = lock.tryLock(10000);

  if (!hasLock) {
    return {
      success: false,
      message: 'Sistem sedang sibuk. Silakan coba lagi sebentar lagi.'
    };
  }

  try {
    const session = getSuperuserSession(token);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('Pendaftar_RDKK');
    if (!sheet) return { success: false, message: 'Sheet Pendaftar_RDKK tidak ditemukan.' };

    const { data } = getSheetData('Pendaftar_RDKK');
    const existingRows = [];

    for (let i = 0; i < data.length; i++) {
      if (String(data[i][0]).trim() === String(idTransaksi).trim()) {
        existingRows.push({
          rowNumber: i + 2,
          data: data[i]
        });
      }
    }

    if (existingRows.length === 0) {
      return { success: false, message: 'Transaksi tidak ditemukan.' };
    }

    const firstRowData = existingRows[0].data;
    const inputOleh = String(firstRowData[16] || '').trim(); // diambil dari keterangan fallback
    const operatorName = sanitizeInput(updateData.operatorName) || 'Operator Lapangan';

    if (!session.isLogged && inputOleh !== operatorName && inputOleh !== 'Operator Lapangan') {
      return { success: false, message: 'Anda tidak memiliki hak akses untuk mengedit transaksi milik pengguna lain.' };
    }

    const newNamaPetani = sanitizeInput(updateData.namaPetani) || firstRowData[4];
    const newAlamatPetani = sanitizeInput(updateData.alamatPetani) || firstRowData[5];
    const nik = String(firstRowData[3]);
    const updatedBidangs = updateData.bidangs || [];

    const affectedNOPs = new Set();
    existingRows.forEach(r => affectedNOPs.add(String(r.data[9]).trim()));

    // Pastikan header Kolom R (18) adalah 'Koordinat' (sekali saja, bukan di dalam loop)
    var headerR = '';
    try {
      var cachedHeaders = getSheetData('Pendaftar_RDKK');
      if (cachedHeaders.headers && cachedHeaders.headers.length >= 18) {
        headerR = String(cachedHeaders.headers[17] || '').trim();
      }
    } catch(e) {}
    if (headerR !== 'Koordinat') {
      sheet.getRange(1, 18).setValue('Koordinat');
    }

    // BATCH OPTIMIZATION: Collect all row updates into maps, then write in bulk via setValues()
    var batchUpdates = {};
    function queueCell(rowNum, col, value) {
      if (!batchUpdates[rowNum]) batchUpdates[rowNum] = {};
      batchUpdates[rowNum][col] = value;
    }

    // 1. Proses pembaruan bidang
    var newRowsToAppend = [];
    for (let i = 0; i < updatedBidangs.length; i++) {
      const ub = updatedBidangs[i];
      const rowNum = ub.rowNumber;

      if (ub.isDeleted && rowNum) {
        queueCell(rowNum, 15, 'Dibatalkan');
        continue;
      }

      const blok = parseInt(ub.blok, 10) || 0;
      const nomorBidang = parseInt(ub.nomorBidang, 10) || 0;
      const prefixNop = sanitizeInput(ub.prefixNop);
      const luasDidaftarkan = parseFloat(ub.luasDidaftarkan) || 0;
      const keterangan = sanitizeInput(ub.keterangan || '');
      const koordinat = sanitizeInput(ub.koordinat !== undefined ? ub.koordinat : '');

      if (blok <= 0 || nomorBidang <= 0 || luasDidaftarkan <= 0) {
        return { success: false, message: 'Data bidang #' + (i + 1) + ' tidak valid (Blok, Bidang, dan Luas harus > 0).' };
      }
      const maxLuasWajarEdit = parseFloat(getConfigValue('MAX_LUAS_PER_BIDANG_M2', '50000')) || 50000;
      if (luasDidaftarkan > maxLuasWajarEdit) {
        return { success: false, message: `Data bidang #${i + 1}: Luas Didaftarkan (${luasDidaftarkan} m²) melebihi batas wajar (${maxLuasWajarEdit} m²). Periksa kemungkinan salah ketik.` };
      }

      const generatedNOP = generateNOP(blok, nomorBidang, prefixNop);
      affectedNOPs.add(generatedNOP);

      const nopLookup = lookupNOP(generatedNOP);
      const statusNOP = nopLookup.found ? 'Ditemukan' : 'Tidak Ditemukan';
      const namaWP = nopLookup.namaWP || '';
      const luasPBB = nopLookup.luasPBB || 0;

      if (rowNum) {
        // Queue updates instead of individual setValue calls
        queueCell(rowNum, 5, newNamaPetani);
        queueCell(rowNum, 6, newAlamatPetani);
        queueCell(rowNum, 8, blok);
        queueCell(rowNum, 9, nomorBidang);
        queueCell(rowNum, 10, generatedNOP);
        queueCell(rowNum, 11, statusNOP);
        queueCell(rowNum, 12, namaWP);
        queueCell(rowNum, 13, luasPBB);
        queueCell(rowNum, 14, luasDidaftarkan);
        queueCell(rowNum, 17, keterangan);
        if (koordinat !== '') {
          queueCell(rowNum, 18, koordinat);
        }
      } else {
        // Collect new rows for batch append
        const today = new Date();
        const currentYear = today.getFullYear();
        newRowsToAppend.push([
          idTransaksi, currentYear, today, nik, newNamaPetani, newAlamatPetani,
          '', blok, nomorBidang, generatedNOP, statusNOP, namaWP,
          luasPBB, luasDidaftarkan, 0, 'Aktif', keterangan, koordinat
        ]);
      }
    }

    // Queue nama & alamat consistency across all existing rows for this transaction
    existingRows.forEach(r => {
      queueCell(r.rowNumber, 5, newNamaPetani);
      queueCell(r.rowNumber, 6, newAlamatPetani);
    });

    // Execute all queued cell updates in batch operations grouped by contiguous row ranges
    var batchRowNums = Object.keys(batchUpdates).map(Number).sort(function(a, b) { return a - b; });
    if (batchRowNums.length > 0) {
      var groups = [];
      var currentGroup = { startRow: batchRowNums[0], rows: [batchRowNums[0]] };
      for (var g = 1; g < batchRowNums.length; g++) {
        if (batchRowNums[g] === batchRowNums[g - 1] + 1) {
          currentGroup.rows.push(batchRowNums[g]);
        } else {
          groups.push(currentGroup);
          currentGroup = { startRow: batchRowNums[g], rows: [batchRowNums[g]] };
        }
      }
      groups.push(currentGroup);

      var minCol = 5, maxCol = 18, numCols = maxCol - minCol + 1;

      groups.forEach(function(grp) {
        var numRows = grp.rows.length;
        var existingValues = sheet.getRange(grp.startRow, minCol, numRows, numCols).getValues();
        for (var ri = 0; ri < numRows; ri++) {
          var actualRow = grp.rows[ri];
          var cells = batchUpdates[actualRow];
          if (cells) {
            var keys = Object.keys(cells);
            for (var ki = 0; ki < keys.length; ki++) {
              var col = parseInt(keys[ki], 10);
              existingValues[ri][col - minCol] = cells[col];
            }
          }
        }
        sheet.getRange(grp.startRow, minCol, numRows, numCols).setValues(existingValues);
      });
    }

    // Append new rows in batch
    if (newRowsToAppend.length > 0) {
      var startAppendRow = sheet.getLastRow() + 1;
      sheet.getRange(startAppendRow, 1, newRowsToAppend.length, 18).setValues(newRowsToAppend);
      sheet.getRange(startAppendRow, 3, newRowsToAppend.length, 1).setNumberFormat('dd/mm/yyyy hh:mm');
      sheet.getRange(startAppendRow, 13, newRowsToAppend.length, 3).setNumberFormat('#,##0');
    }

    SpreadsheetApp.flush();
    clearRequestCache();

    // 2. Hitung ulang sisa luas untuk semua NOP yang terpengaruh (batched)
    const freshData = getSheetData('Pendaftar_RDKK').data;
    var sisaBatchUpdates = {};
    affectedNOPs.forEach(nop => {
      if (!nop) return;
      const nopInfo = getNOPInfoAndSisaLuas(nop, token);
      const sisa = nopInfo.sisaLuas;

      for (let j = 0; j < freshData.length; j++) {
        const row = freshData[j];
        if (String(row[9]).trim() === nop) {
          const rIndex = j + 2;
          if (!sisaBatchUpdates[rIndex]) sisaBatchUpdates[rIndex] = {};
          sisaBatchUpdates[rIndex][15] = sisa;
          const currentStatus = String(row[15]).trim();
          if (currentStatus !== 'Dibatalkan') {
            sisaBatchUpdates[rIndex][16] = sisa < 0 ? 'Melebihi Kapasitas' : 'Aktif';
          }
        }
      }
    });

    // Execute sisa luas batch writes
    var sisaRowNums = Object.keys(sisaBatchUpdates).map(Number).sort(function(a, b) { return a - b; });
    if (sisaRowNums.length > 0) {
      var sisaGroups = [];
      var curGrp = { startRow: sisaRowNums[0], rows: [sisaRowNums[0]] };
      for (var sg = 1; sg < sisaRowNums.length; sg++) {
        if (sisaRowNums[sg] === sisaRowNums[sg - 1] + 1) {
          curGrp.rows.push(sisaRowNums[sg]);
        } else {
          sisaGroups.push(curGrp);
          curGrp = { startRow: sisaRowNums[sg], rows: [sisaRowNums[sg]] };
        }
      }
      sisaGroups.push(curGrp);

      sisaGroups.forEach(function(grp) {
        var numRows = grp.rows.length;
        var existingValues = sheet.getRange(grp.startRow, 15, numRows, 2).getValues();
        for (var ri = 0; ri < numRows; ri++) {
          var actualRow = grp.rows[ri];
          var cells = sisaBatchUpdates[actualRow];
          if (cells) {
            if (cells[15] !== undefined) existingValues[ri][0] = cells[15];
            if (cells[16] !== undefined) existingValues[ri][1] = cells[16];
          }
        }
        sheet.getRange(grp.startRow, 15, numRows, 2).setValues(existingValues);
      });
    }

    const logUser = session.isLogged ? session.user.username : operatorName;
    const roleName = session.isLogged ? 'Superuser' : 'User';

    writeLog(
      idTransaksi,
      'Edit',
      { NIK: nik, NamaSebelum: firstRowData[4] },
      { NIK: nik, NamaSesudah: newNamaPetani, TotalBidang: updatedBidangs.length },
      logUser,
      roleName
    );

    // Sinkronisasi status ke sheet dbwp-banding
    try {
      updateDbwpBandingByNOPs(affectedNOPs);
    } catch (e) {}

    invalidateDataSetCache('LAHAN');
    invalidateDataSetCache('DBWP');
    invalidateDataSetCache('INITIAL');
    invalidateDataSetCache('ADMIN');

    return { success: true, message: `Transaksi ${idTransaksi} berhasil diperbarui.` };

  } catch (err) {
    return { success: false, message: 'Terjadi kesalahan server: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Soft Delete Transaksi (Set Status = 'Dibatalkan' untuk SEMUA bidang dalam transaksi).
 */
function softDeleteTransaksi(idTransaksi, operatorName, token) {
  // Guard: endpoint ini hanya dapat diakses oleh Superuser (token diteruskan pemanggil).
  requireSuperuser(token);

  const session = getSuperuserSession(token);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Pendaftar_RDKK');
  if (!sheet) return { success: false, message: 'Sheet tidak ditemukan.' };

  const { data } = getSheetData('Pendaftar_RDKK');
  const matchedRows = [];

  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(idTransaksi).trim()) {
      matchedRows.push({
        rowIndex: i + 2,
        data: data[i]
      });
    }
  }

  if (matchedRows.length === 0) {
    return { success: false, message: 'Transaksi tidak ditemukan.' };
  }

  const inputOleh = String(matchedRows[0].data[16] || '').trim();
  const currentOp = sanitizeInput(operatorName) || 'Operator Lapangan';

  if (!session.isLogged && inputOleh !== currentOp && inputOleh !== 'Operator Lapangan') {
    return { success: false, message: 'Anda tidak memiliki hak akses untuk membatalkan transaksi ini.' };
  }

  const affectedNOPs = new Set();
  matchedRows.forEach(r => {
    sheet.getRange(r.rowIndex, 16).setValue('Dibatalkan');
    affectedNOPs.add(String(r.data[9]).trim());
  });

  SpreadsheetApp.flush();

  // Recalculate sisa luas untuk NOP yang terpengaruh
  const freshData = getSheetData('Pendaftar_RDKK').data;
  affectedNOPs.forEach(nop => {
    if (!nop) return;
    const nopInfo = getNOPInfoAndSisaLuas(nop, token);
    const sisa = nopInfo.sisaLuas;

    for (let j = 0; j < freshData.length; j++) {
      const row = freshData[j];
      if (String(row[9]).trim() === nop) {
        const rIndex = j + 2;
        sheet.getRange(rIndex, 15).setValue(sisa);
        const currentStatus = String(row[15]).trim();
        if (currentStatus !== 'Dibatalkan') {
          const newStatus = sisa < 0 ? 'Melebihi Kapasitas' : 'Aktif';
          sheet.getRange(rIndex, 16).setValue(newStatus);
        }
      }
    }
  });

  const logUser = session.isLogged ? session.user.username : currentOp;
  const roleName = session.isLogged ? 'Superuser' : 'User';

    writeLog(
      idTransaksi,
      'Hapus (Batal)',
      { TotalBidangDibatalkan: matchedRows.length },
      { StatusSesudah: 'Dibatalkan' },
      logUser,
      roleName
    );

    // Sinkronisasi status ke sheet dbwp-banding
    try {
      updateDbwpBandingByNOPs(affectedNOPs);
    } catch (e) {}

    invalidateDataSetCache('LAHAN');
    invalidateDataSetCache('DBWP');
    invalidateDataSetCache('INITIAL');
    invalidateDataSetCache('ADMIN');

    return { success: true, message: `Transaksi ${idTransaksi} (${matchedRows.length} bidang) berhasil dibatalkan.` };
}

/**
 * Pencarian & Rekap Transaksi.
 */
function searchTransaksi(queryObj) {
  const { data } = getSheetData('Pendaftar_RDKK');
  const { data: blokData } = getSheetData('Pengaturan_Blok');

  // Mapping Blok -> Kelompok
  const blokMap = {};
  for (let b = 0; b < blokData.length; b++) {
    blokMap[String(blokData[b][0])] = String(blokData[b][1]);
  }

  const keyword = String(queryObj.keyword || '').trim().toLowerCase();
  const filterBlok = String(queryObj.blok || '').trim();
  const filterKelompok = String(queryObj.kelompok || '').trim().toLowerCase();
  const filterStatus = String(queryObj.status || '').trim();

  const results = [];

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const idTrx = String(row[0]);
    const nik = String(row[3]);
    const namaPetani = String(row[4]);
    const blok = String(row[7]);
    const nop = String(row[9]);
    const statusTrx = String(row[15]);
    const kelompok = blokMap[blok] || '-';

    // Filters
    if (filterBlok && blok !== filterBlok) continue;
    if (filterKelompok && kelompok.toLowerCase() !== filterKelompok) continue;
    if (filterStatus && statusTrx !== filterStatus) continue;

    if (keyword) {
      const nomorHp = String(row[6] || '').trim();
      const matchKey = nik.toLowerCase().includes(keyword) ||
                       namaPetani.toLowerCase().includes(keyword) ||
                       nop.toLowerCase().includes(keyword) ||
                       idTrx.toLowerCase().includes(keyword) ||
                       nomorHp.toLowerCase().includes(keyword);
      if (!matchKey) continue;
    }

    results.push({
      idTransaksi: idTrx,
      tahun: row[1],
      tanggal: formatDateTime(row[2]),
      nik: nik,
      namaPetani: namaPetani,
      alamatPetani: String(row[5]),
      nomorHp: String(row[6] || ''),
      blok: blok,
      kelompok: kelompok,
      nomorBidang: row[8],
      nop: nop,
      statusNOP: String(row[10]),
      namaWP: String(row[11]),
      luasPBB: row[12],
      luasDidaftarkan: row[13],
      sisaLuasPBB: row[14],
      statusTransaksi: statusTrx,
      keterangan: String(row[16]),
      koordinat: String(row[17] || '')  // R:18 = Koordinat
    });
  }

  return results;
}

/**
 * Menghitung Rekap Data berdasarkan Kelompok / Blok.
 */
function getRekapByKelompok() {
  const { data } = getSheetData('Pendaftar_RDKK');
  const { data: blokData } = getSheetData('Pengaturan_Blok');

  const blokMap = {};
  for (let b = 0; b < blokData.length; b++) {
    blokMap[String(blokData[b][0])] = String(blokData[b][1]);
  }

  const rekap = {};

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const statusTrx = String(row[15]);
    if (statusTrx === 'Dibatalkan') continue;

    const blok = String(row[7]);
    const kelompok = blokMap[blok] || 'Lain-lain / Tanpa Kelompok';
    const luas = Number(row[13] || 0);

    if (!rekap[kelompok]) {
      rekap[kelompok] = {
        kelompok: kelompok,
        totalPetani: 0,
        totalTransaksi: 0,
        totalLuas: 0,
        nikSet: new Set()
      };
    }

    rekap[kelompok].totalTransaksi += 1;
    rekap[kelompok].totalLuas += luas;
    rekap[kelompok].nikSet.add(String(row[3]));
  }

  // Convert map to array
  const result = [];
  for (const k in rekap) {
    result.push({
      kelompok: rekap[k].kelompok,
      totalPetani: rekap[k].nikSet.size,
      totalTransaksi: rekap[k].totalTransaksi,
      totalLuas: rekap[k].totalLuas
    });
  }

  return result;
}

/**
 * Memperbarui kolom status ('terdaftar' / 'belum') dan Ket. ('Luas Berlebih' / '')
 * pada sheet `dbwp-banding` untuk NOP-NOP yang terdampak.
 */
function updateDbwpBandingByNOPs(affectedNOPs) {
  if (!affectedNOPs) return;
  const rawList = Array.from(affectedNOPs);
  if (rawList.length === 0) return;

  const nopSet = new Set(rawList.map(n => cleanNOPDigits(String(n || ''))));
  if (nopSet.size === 0) return;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('dbwp-banding');
  if (!sheet) return; // Jika belum ada sheet dbwp-banding, abaikan

  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  // Baca seluruh data dbwp-banding
  const range = sheet.getRange(2, 1, lastRow - 1, 10);
  const rows = range.getValues();

  // Dapatkan data transaksi aktif untuk mengecek akumulasi luas & status
  const { data: trxData } = getSheetData('Pendaftar_RDKK');
  const activeTrxMap = {}; // cleanNOP -> { count, totalLuasDaftar, hasOver }

  for (let i = 0; i < trxData.length; i++) {
    const r = trxData[i];
    const statusTrx = String(r[15] || '').trim();
    if (statusTrx === 'Dibatalkan') continue;

    const nopRaw = String(r[9] || '').trim();
    const cleanN = cleanNOPDigits(nopRaw);
    if (!cleanN) continue;

    if (!activeTrxMap[cleanN]) {
      activeTrxMap[cleanN] = { count: 0, totalLuasDaftar: 0, hasOver: false };
    }
    activeTrxMap[cleanN].count++;
    activeTrxMap[cleanN].totalLuasDaftar += Number(r[13] || 0);
    if (statusTrx === 'Melebihi Kapasitas') {
      activeTrxMap[cleanN].hasOver = true;
    }
  }

  // Update baris-baris yang match
  let updatedAny = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const nopInSheet1 = cleanNOPDigits(String(row[1] || ''));
    const nopInSheet2 = cleanNOPDigits(String(row[2] || ''));
    const cleanN = nopInSheet1 || nopInSheet2;

    if (nopSet.has(cleanN)) {
      const activeInfo = activeTrxMap[cleanN];
      const luasPBB = Number(row[7] || 0);

      if (activeInfo && activeInfo.count > 0) {
        row[8] = 'terdaftar';
        if (activeInfo.hasOver || (luasPBB > 0 && activeInfo.totalLuasDaftar > luasPBB)) {
          row[9] = 'Luas Berlebih';
        } else {
          row[9] = '';
        }
      } else {
        row[8] = 'belum';
        row[9] = '';
      }
      updatedAny = true;
    }
  }

  if (updatedAny) {
    const statusKetValues = rows.map(r => [r[8], r[9]]);
    sheet.getRange(2, 9, statusKetValues.length, 2).setValues(statusKetValues);
  }
}

/**
 * Mengambil data terpadu seluruh bidang lahan desa (dari dbwp-banding)
 * dipadukan dengan data transaksi pendaftar aktif (Pendaftar_RDKK)
 * dan nama Kelompok Tani (Pengaturan_Blok).
 */
function getUnifiedLahanData(params, token) {
  // Guard: endpoint ini hanya dapat diakses oleh Superuser (token diteruskan pemanggil).
  requireSuperuser(token);

  try {
    let dbwpRows = [];
    let isBandingSheet = false;
    
    // Cek apakah sheet dbwp-banding tersedia dan memiliki baris
    const bandingObj = getSheetData('dbwp-banding');
    if (bandingObj.data && bandingObj.data.length > 0) {
      dbwpRows = bandingObj.data;
      isBandingSheet = true;
    } else {
      // Fallback ke sheet dbwp standar jika dbwp-banding belum ada
      const fallbackObj = getSheetData('dbwp');
      dbwpRows = fallbackObj.data || [];
      isBandingSheet = false;
    }

    const trxSheet = getSheetData('Pendaftar_RDKK');
    const trxRows = trxSheet.data || [];
    const blokSheet = getSheetData('Pengaturan_Blok');
    const blokRows = blokSheet.data || [];

    // Pemetaan Koordinat dari sheet dbwp
    // Header dbwp: No.(0), NOP(1), Blok(2), Bidang(3), Nama WP(4), Alamat WP(5), Luas pbb(6), Koordinat(7)
    // key: "blokInt_bidangInt" -> koordinat string
    const coordMap = {};
    try {
      const dbwpCoordObj = getSheetData('dbwp');
      const dbwpCoordRows = dbwpCoordObj.data || [];
      for (let dc = 0; dc < dbwpCoordRows.length; dc++) {
        const dcRow = dbwpCoordRows[dc];
        const dcBlok = parseInt(dcRow[2], 10); // Kolom C = Blok
        const dcBidang = parseInt(dcRow[3], 10); // Kolom D = Bidang
        const dcCoord = String(dcRow[7] || '').trim(); // Kolom H = Koordinat
        if (!isNaN(dcBlok) && !isNaN(dcBidang) && dcCoord) {
          coordMap[`${dcBlok}_${dcBidang}`] = dcCoord;
        }
      }
    } catch (e) {
      // Jika terjadi error, coordMap tetap kosong
    }

    // Pemetaan Blok -> Kelompok Tani
    const blokKelompokMap = {};
    for (let b = 0; b < blokRows.length; b++) {
      const bNomor = String(blokRows[b][0] || '').trim();
      const bNamaKelompok = String(blokRows[b][1] || '').trim();
      if (bNomor) {
        blokKelompokMap[bNomor] = bNamaKelompok;
        const bInt = parseInt(bNomor, 10);
        if (!isNaN(bInt)) {
          blokKelompokMap[String(bInt)] = bNamaKelompok;
          blokKelompokMap[zeroPad(bInt, 3)] = bNamaKelompok;
        }
      }
    }

    // Pemetaan Transaksi Aktif per NOP (Clean Digits)
    // Skema Pendaftar_RDKK (A-S, 19 kolom):
    // [0]=ID_Transaksi, [1]=Tahun, [2]=Tanggal, [3]=NIK, [4]=Nama Petani,
    // [5]=Alamat Petani, [6]=Nomor Hp, [7]=Blok, [8]=Nomor Bidang,
    // [9]=NOP, [10]=Status NOP, [11]=Nama WP, [12]=Luas PBB,
    // [13]=Luas Didaftarkan, [14]=Sisa Luas PBB, [15]=Status Transaksi,
    // [16]=Keterangan, [17]=Input Oleh (atau Koordinat-R), [18]=Koordinat-S
    const trxByNopMap = {};
    for (let t = 0; t < trxRows.length; t++) {
      const tr = trxRows[t];
      const statusTrx = String(tr[15] || '').trim(); // P = Status Transaksi
      if (statusTrx === 'Dibatalkan') continue;

      const nopRaw = String(tr[9] || '').trim(); // J = NOP
      const cleanN = cleanNOPDigits(nopRaw);
      if (!cleanN) continue;

      if (!trxByNopMap[cleanN]) {
        trxByNopMap[cleanN] = {
          count: 0,
          totalLuasDaftar: 0,
          hasOver: false,
          petaniList: []
        };
      }

      const luasDaftar = Number(tr[13]) || 0; // N = Luas Didaftarkan
      trxByNopMap[cleanN].count++;
      trxByNopMap[cleanN].totalLuasDaftar += luasDaftar;
      if (statusTrx === 'Melebihi Kapasitas') {
        trxByNopMap[cleanN].hasOver = true;
      }

      trxByNopMap[cleanN].petaniList.push({
        id: String(tr[0] || ''),
        nik: String(tr[3] || ''),
        nama: String(tr[4] || ''),
        nomorHp: String(tr[6] || '').trim(),
        luas: luasDaftar
      });
    }

    const items = [];
    let totalLuasPBB = 0;
    let totalLuasTerdaftar = 0;
    let totalTerdaftarCount = 0;
    let totalBelumCount = 0;
    let totalGandaCount = 0;
    let totalBerlebihCount = 0;

    for (let i = 0; i < dbwpRows.length; i++) {
      const row = dbwpRows[i];
      let nopIn1 = '';
      let nopIn2 = '';
      let cleanN = '';
      let blokRaw = '';
      let bidangRaw = '';
      let namaWP = '';
      let alamatWP = '';
      let luasPBB = 0;
      let blokNum = 0;
      let bidangNum = 0;

      if (isBandingSheet) {
        // Header dbwp-banding: No.(0), NOP(1), Nop-dot(2), Blok(3), Bidang(4), Nama WP(5), Alamat WP(6), Luas pbb(7), status(8), Ket.(9)
        nopIn1 = String(row[1] || '').trim();
        nopIn2 = String(row[2] || '').trim();
        cleanN = cleanNOPDigits(nopIn1) || cleanNOPDigits(nopIn2);
        blokRaw = String(row[3] || '').trim();
        bidangRaw = String(row[4] || '').trim();
        namaWP = String(row[5] || '').trim() || '-';
        alamatWP = String(row[6] || '').trim() || '-';
        luasPBB = Number(row[7]) || 0;
        blokNum = parseInt(blokRaw, 10) || 0;
        bidangNum = parseInt(bidangRaw, 10) || 0;
      } else {
        // Header dbwp standar baru: No.(0), NOP(1), Blok(2), Bidang(3), Nama WP(4), Alamat WP(5), Luas pbb(6), Koordinat(7)
        nopIn1 = String(row[1] || '').trim();
        cleanN = cleanNOPDigits(nopIn1);
        blokNum = parseInt(row[2], 10) || 0;
        bidangNum = parseInt(row[3], 10) || 0;
        namaWP = String(row[4] || '').trim() || '-';
        alamatWP = String(row[5] || '').trim() || '-';
        luasPBB = Number(row[6]) || 0;
        // Jika blok/bidang tidak terisi di sheet, ekstrak dari NOP
        if (!blokNum && !bidangNum && cleanN.length >= 17) {
          blokNum = parseInt(cleanN.substring(10, 13), 10) || 0;
          bidangNum = parseInt(cleanN.substring(13, 17), 10) || 0;
        }
        nopIn2 = formatNOP(cleanN);
      }

      if (!blokNum && !bidangNum && !cleanN) continue;

      const bPad = zeroPad(blokNum, 3);
      const bidangPad = zeroPad(bidangNum, 4);
      const kelompok = blokKelompokMap[bPad] || blokKelompokMap[String(blokNum)] || 'Tanpa Kelompok';

      const activeInfo = cleanN ? trxByNopMap[cleanN] : null;
      const countPendaftar = activeInfo ? activeInfo.count : 0;
      const isTerdaftar = countPendaftar > 0;
      const totalLuasDaftar = activeInfo ? activeInfo.totalLuasDaftar : 0;
      const isMultiPendaftar = countPendaftar > 1;
      const isLuasBerlebih = activeInfo ? (activeInfo.hasOver || (luasPBB > 0 && totalLuasDaftar > luasPBB)) : false;

      let status = 'belum';
      if (isTerdaftar) {
        if (isMultiPendaftar) {
          status = 'ganda';
          totalGandaCount++;
        } else {
          status = 'terdaftar';
        }
        totalTerdaftarCount++;
      } else {
        totalBelumCount++;
      }

      if (isLuasBerlebih) {
        totalBerlebihCount++;
      }

      totalLuasPBB += luasPBB;
      totalLuasTerdaftar += totalLuasDaftar;

      let petaniStr = '-';
      let nikStr = '-';
      let nomorHpStr = '-';
      if (activeInfo && activeInfo.petaniList && activeInfo.petaniList.length > 0) {
        petaniStr = activeInfo.petaniList.map(p => p.nama).join(', ');
        nikStr = activeInfo.petaniList.map(p => p.nik).join(', ');
        nomorHpStr = activeInfo.petaniList
          .map(p => p.nomorHp || '')
          .filter(Boolean)
          .join(', ');
        if (!nomorHpStr) nomorHpStr = '-';
      }

      // Lookup koordinat dari coordMap
      const coordKey = `${blokNum}_${bidangNum}`;
      const koordinat = coordMap[coordKey] || '';

      items.push({
        id: cleanN || ('row-' + (i + 1)),
        no: i + 1,
        nop: nopIn2 || nopIn1 || ('Blok ' + bPad + ' Bid ' + bidangPad),
        nopRaw: cleanN,
        blok: bPad,
        blokNum: blokNum,
        kelompok: kelompok,
        bidang: bidangPad,
        bidangNum: bidangNum,
        namaWP: namaWP,
        alamatWP: alamatWP,
        luasPBB: luasPBB,
        totalLuasDaftar: totalLuasDaftar,
        sisaLuasPBB: Math.max(0, luasPBB - totalLuasDaftar),
        status: status,
        isTerdaftar: isTerdaftar,
        isMultiPendaftar: isMultiPendaftar,
        countPendaftar: countPendaftar,
        isLuasBerlebih: isLuasBerlebih,
        petani: petaniStr,
        nik: nikStr,
        nomorHp: nomorHpStr,
        petaniList: activeInfo ? activeInfo.petaniList : [],
        koordinat: koordinat
      });
    }

    const resultObj = {
      success: true,
      summary: {
        totalBidang: items.length,
        totalLuasPBB: totalLuasPBB,
        totalLuasTerdaftar: totalLuasTerdaftar,
        totalLuasBelumTerdaftar: Math.max(0, totalLuasPBB - totalLuasTerdaftar),
        totalTerdaftarCount: totalTerdaftarCount,
        totalBelumCount: totalBelumCount,
        totalGandaCount: totalGandaCount,
        totalBerlebihCount: totalBerlebihCount
      },
      items: items
    };

    try {
      CacheService.getScriptCache().put(
        'RDKK_DATASET_LAHAN',
        JSON.stringify(resultObj),
        60
      );
    } catch (e) {
      // ignore cache size / quota issues; data is still returned
    }

    // Return as serialized JSON string to bypass Google Apps Script postMessage deserialization limits
    return JSON.stringify(resultObj);
  } catch (err) {
    return JSON.stringify({
      success: false,
      message: 'Gagal memuat data terpadu lahan: ' + (err && err.message ? err.message : String(err)),
      summary: {},
      items: []
    });
  }
}

/**
 * Sinkronisasi otomatis titik koordinat dari sheet `dbwp` (kolom Koordinat) ke sheet `Pendaftar_RDKK` (Kolom R).
 * Sumber: Sheet `dbwp` kolom Blok(2), Bidang(3), Koordinat(7)
 * Target: Sheet `Pendaftar_RDKK` Kolom 18 (R) dengan header 'Koordinat'
 */
function syncKoordinatFromDbwp() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return { success: false, message: 'Server sedang sibuk, silakan coba lagi beberapa saat.' };
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    const { data: dbwpRows } = getSheetData('dbwp');
    if (!dbwpRows || dbwpRows.length === 0) {
      return { success: false, message: 'Sheet "dbwp" masih kosong atau belum memiliki data koordinat.' };
    }

    // Buat pemetaan: `${bNum}_${bdNum}` -> koordinat
    const coordMap = {};
    for (let i = 0; i < dbwpRows.length; i++) {
      const row = dbwpRows[i];
      const bNum = parseInt(row[2], 10);
      const bdNum = parseInt(row[3], 10);
      const coord = String(row[7] || '').trim();
      if (!isNaN(bNum) && !isNaN(bdNum) && coord) {
        coordMap[`${bNum}_${bdNum}`] = coord;
      }
    }

    const rdkkSheet = ss.getSheetByName('Pendaftar_RDKK');
    if (!rdkkSheet) {
      return { success: false, message: 'Sheet "Pendaftar_RDKK" tidak ditemukan!' };
    }

    const lastRow = rdkkSheet.getLastRow();
    if (lastRow <= 1) {
      return { success: false, message: 'Sheet "Pendaftar_RDKK" masih kosong.' };
    }

    // Pastikan header Kolom R (18) adalah 'Koordinat'
    if (String(rdkkSheet.getRange(1, 18).getValue() || '').trim() !== 'Koordinat') {
      rdkkSheet.getRange(1, 18).setValue('Koordinat');
    }

    // Skema Pendaftar_RDKK setelah update Nomor Hp:
    //   Kolom H (8) = Blok, Kolom I (9) = Nomor Bidang, Kolom R (18) = Koordinat
    const numDataRows = lastRow - 1;
    const blokBidangValues = rdkkSheet.getRange(2, 8, numDataRows, 2).getValues(); // H & I
    const existingCoords = rdkkSheet.getRange(2, 18, numDataRows, 1).getValues();  // R

    let updatedCount = 0;
    const newCoordValues = [];


    for (let i = 0; i < numDataRows; i++) {
      const bVal = parseInt(blokBidangValues[i][0], 10);
      const bdVal = parseInt(blokBidangValues[i][1], 10);
      const currentCoord = String(existingCoords[i][0] || '').trim();
      const key = `${bVal}_${bdVal}`;

      if (coordMap[key]) {
        newCoordValues.push([coordMap[key]]);
        if (currentCoord !== coordMap[key]) {
          updatedCount++;
        }
      } else {
        newCoordValues.push([currentCoord]); // Pertahankan jika sudah ada atau kosong
      }
    }

    // Tulis secara massal (batch) ke Kolom 18
    rdkkSheet.getRange(2, 18, numDataRows, 1).setValues(newCoordValues);

    return {
      success: true,
      message: `Sinkronisasi selesai! ${updatedCount} baris data pendaftar diperbarui dengan koordinat dari sheet dbwp.`
    };
  } catch (err) {
    return { success: false, message: 'Gagal sinkronisasi koordinat: ' + (err.message || String(err)) };
  } finally {
    lock.releaseLock();
  }
}


/* ============================================================
 * BAGIAN 7 — MASTER DATA (dari MasterData.gs)
 * Management Master Data (Superuser Only)
 * ============================================================
 */

/* ============================================================
 * 1. CRUD Master Tanah (sheet: dbwp)
 * Header dbwp: No., NOP, Blok, Bidang, Nama WP, Alamat WP, Luas pbb, Koordinat
 * ============================================================ */
function getDbwpData(limit, token) {
  requireSuperuser(token);
  const { data } = getSheetData('dbwp');
  const result = [];
  const maxRows = limit || 500;

  for (let i = 0; i < data.length && i < maxRows; i++) {
    const row = data[i];
    result.push({
      no: row[0],
      nop: String(row[1] || ''),
      blok: Number(row[2] || 0),
      bidang: Number(row[3] || 0),
      namaWP: String(row[4] || ''),
      alamatWP: String(row[5] || ''),
      luasPBB: Number(row[6] || 0),
      koordinat: String(row[7] || '')
    });
  }
  return result;
}

function addDbwpRow(formData, token) {
  const session = requireSuperuser(token);
  const nop = sanitizeInput(formData.nop);
  const blok = parseInt(formData.blok, 10) || 0;
  const bidang = parseInt(formData.bidang, 10) || 0;
  const namaWP = sanitizeInput(formData.namaWP);
  const alamatWP = sanitizeInput(formData.alamatWP);
  const luasPBB = Number(formData.luasPBB) || 0;
  const koordinat = sanitizeInput(formData.koordinat || '');

  if (!nop || !namaWP) {
    return { success: false, message: 'NOP dan Nama WP wajib diisi!' };
  }

  const existing = lookupNOP(nop);
  if (existing.found) {
    return { success: false, message: `NOP ${nop} sudah terdaftar di dbwp atas nama ${existing.namaWP}!` };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('dbwp');
  const lastRow = sheet.getLastRow();
  const newNo = lastRow;

  sheet.appendRow([newNo, nop, blok, bidang, namaWP, alamatWP, luasPBB, koordinat]);
  sheet.getRange(lastRow + 1, 7).setNumberFormat('#,##0');

  invalidateDataSetCache('DBWP');
  writeLog('MASTER', 'Tambah NOP', '-', { NOP: nop, Blok: blok, Bidang: bidang, NamaWP: namaWP, LuasPBB: luasPBB }, session.username, 'Superuser');

  return {
    success: true,
    message: `NOP ${nop} berhasil ditambahkan ke dbwp.`
  };
}

function editDbwpRow(nopKey, formData, token) {
  const session = requireSuperuser(token);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('dbwp');
  const { data } = getSheetData('dbwp');

  let rowIndex = -1;
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][1]).trim() === String(nopKey).trim()) {
      rowIndex = i + 2;
      break;
    }
  }

  if (rowIndex === -1) {
    return { success: false, message: 'NOP tidak ditemukan di dbwp.' };
  }

  const newNama = sanitizeInput(formData.namaWP);
  const newAlamat = sanitizeInput(formData.alamatWP);
  const newLuas = Number(formData.luasPBB) || 0;
  const newKoordinat = sanitizeInput(formData.koordinat || '');

  // Kolom: No.(1), NOP(2), Blok(3), Bidang(4), NamaWP(5), AlamatWP(6), LuasPBB(7), Koordinat(8)
  sheet.getRange(rowIndex, 5).setValue(newNama);
  sheet.getRange(rowIndex, 6).setValue(newAlamat);
  sheet.getRange(rowIndex, 7).setValue(newLuas);
  sheet.getRange(rowIndex, 8).setValue(newKoordinat);

  invalidateDataSetCache('DBWP');
  writeLog('MASTER', 'Edit NOP', { NOP: nopKey }, { NamaWP: newNama, Luas: newLuas, Koordinat: newKoordinat }, session.username, 'Superuser');
  return { success: true, message: `Berhasil memperbarui data NOP ${nopKey}.` };
}

/* ============================================================
 * 2. CRUD Kelompok Tani (sheet: Kelompok_Tani)
 * ============================================================ */
function ensureKelompokTaniSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Kelompok_Tani');
  if (!sheet) {
    sheet = ss.insertSheet('Kelompok_Tani');
    const headers = ['ID_Kelompok', 'Nama Kelompok', 'Ketua', 'Kontak', 'Keterangan'];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    const mockData = [
      ['KT-01', 'Cisedane', 'Warsito', '08123456789', 'Wilayah Blok 5, 6, 14'],
      ['KT-02', 'Cilosari', 'Dedi Kurniawan', '08198765432', 'Wilayah Blok 3, 4, 7, 13']
    ];
    sheet.getRange(2, 1, mockData.length, headers.length).setValues(mockData);
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#1e293b');
    headerRange.setFontColor('#ffffff');
  }
  return sheet;
}

function getKelompokTaniData() {
  ensureKelompokTaniSheet();
  const { data } = getSheetData('Kelompok_Tani');
  const { data: blokData } = getSheetData('Pengaturan_Blok');

  // Hitung jumlah blok yang terpasang pada kelompok ini
  const blokCountMap = {};
  for (let b = 0; b < blokData.length; b++) {
    const kName = String(blokData[b][1] || '').trim().toLowerCase();
    if (kName) {
      blokCountMap[kName] = (blokCountMap[kName] || 0) + 1;
    }
  }

  return data.map((row, idx) => {
    const id = String(row[0] || ('KT-' + zeroPad(idx + 1, 2)));
    const nama = String(row[1] || '').trim();
    return {
      id: id,
      nama: nama,
      ketua: String(row[2] || ''),
      kontak: String(row[3] || ''),
      keterangan: String(row[4] || ''),
      jumlahBlok: blokCountMap[nama.toLowerCase()] || 0
    };
  });
}

function addKelompokTani(formData, token) {
  const session = requireSuperuser(token);
  const nama = sanitizeInput(formData.nama);
  const ketua = sanitizeInput(formData.ketua || '');
  const kontak = sanitizeInput(formData.kontak || '');
  const keterangan = sanitizeInput(formData.keterangan || '');

  if (!nama) {
    return { success: false, message: 'Nama Kelompok Tani wajib diisi!' };
  }

  ensureKelompokTaniSheet();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Kelompok_Tani');
  const { data } = getSheetData('Kelompok_Tani');

  // Cek duplikasi nama kelompok tani
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][1] || '').trim().toLowerCase() === nama.toLowerCase()) {
      return { success: false, message: `Kelompok Tani '${nama}' sudah ada!` };
    }
  }

  // Generate ID baru
  let maxIdNum = 0;
  for (let i = 0; i < data.length; i++) {
    const m = String(data[i][0] || '').match(/^KT-(\d+)$/i);
    if (m) {
      const val = parseInt(m[1], 10);
      if (val > maxIdNum) maxIdNum = val;
    }
  }
  const newId = 'KT-' + zeroPad(maxIdNum + 1, 2);

  sheet.appendRow([newId, nama, ketua, kontak, keterangan]);
  invalidateReferenceCache('Kelompok_Tani');
  invalidateDataSetCache('LAHAN');
  writeLog('MASTER', 'Tambah Kelompok Tani', '-', { ID: newId, Nama: nama, Ketua: ketua }, session.username, 'Superuser');
  return { success: true, message: `Kelompok Tani '${nama}' (${newId}) berhasil ditambahkan.` };
}

function editKelompokTani(idKelompok, formData, token) {
  const session = requireSuperuser(token);
  const id = sanitizeInput(idKelompok);
  const newNama = sanitizeInput(formData.nama);
  const newKetua = sanitizeInput(formData.ketua || '');
  const newKontak = sanitizeInput(formData.kontak || '');
  const newKeterangan = sanitizeInput(formData.keterangan || '');

  if (!id || !newNama) {
    return { success: false, message: 'ID dan Nama Kelompok Tani wajib diisi!' };
  }

  ensureKelompokTaniSheet();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Kelompok_Tani');
  const { data } = getSheetData('Kelompok_Tani');

  let rowIndex = -1;
  let oldNama = '';
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() === id) {
      rowIndex = i + 2;
      oldNama = String(data[i][1] || '').trim();
      break;
    }
  }

  if (rowIndex === -1) {
    return { success: false, message: `Kelompok Tani dengan ID '${id}' tidak ditemukan!` };
  }

  // Cek duplikasi nama jika nama diganti
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() !== id && String(data[i][1] || '').trim().toLowerCase() === newNama.toLowerCase()) {
      return { success: false, message: `Nama Kelompok Tani '${newNama}' sudah digunakan oleh ID lain!` };
    }
  }

  sheet.getRange(rowIndex, 2).setValue(newNama);
  sheet.getRange(rowIndex, 3).setValue(newKetua);
  sheet.getRange(rowIndex, 4).setValue(newKontak);
  sheet.getRange(rowIndex, 5).setValue(newKeterangan);

  // Jika nama kelompok berubah, perbarui juga di sheet Pengaturan_Blok
  if (oldNama && oldNama.toLowerCase() !== newNama.toLowerCase()) {
    const blokSheet = ss.getSheetByName('Pengaturan_Blok');
    if (blokSheet) {
      const { data: blokData } = getSheetData('Pengaturan_Blok');
      for (let b = 0; b < blokData.length; b++) {
        if (String(blokData[b][1] || '').trim().toLowerCase() === oldNama.toLowerCase()) {
          blokSheet.getRange(b + 2, 2).setValue(newNama);
        }
      }
    }
  }

  invalidateReferenceCache('Kelompok_Tani');
  invalidateReferenceCache('Pengaturan_Blok'); // nama kelompok bisa ikut berubah di Pengaturan_Blok
  invalidateDataSetCache('LAHAN');
  writeLog('MASTER', 'Edit Kelompok Tani', { ID: id, NamaLama: oldNama }, { NamaBaru: newNama, Ketua: newKetua }, session.username, 'Superuser');
  return { success: true, message: `Data Kelompok Tani '${newNama}' berhasil diperbarui.` };
}

function deleteKelompokTani(idKelompok, token) {
  const session = requireSuperuser(token);
  const id = sanitizeInput(idKelompok);

  ensureKelompokTaniSheet();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Kelompok_Tani');
  const { data } = getSheetData('Kelompok_Tani');

  let rowIndex = -1;
  let targetNama = '';
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() === id) {
      rowIndex = i + 2;
      targetNama = String(data[i][1] || '').trim();
      break;
    }
  }

  if (rowIndex === -1) {
    return { success: false, message: `Kelompok Tani '${id}' tidak ditemukan!` };
  }

  // Validasi: Cegah hapus jika masih ada blok yang terpasang pada kelompok ini
  const { data: blokData } = getSheetData('Pengaturan_Blok');
  const linkedBloks = [];
  for (let b = 0; b < blokData.length; b++) {
    if (String(blokData[b][1] || '').trim().toLowerCase() === targetNama.toLowerCase()) {
      linkedBloks.push(blokData[b][0]);
    }
  }

  if (linkedBloks.length > 0) {
    return {
      success: false,
      message: `Kelompok Tani '${targetNama}' tidak dapat dihapus karena masih terpasang pada Blok ${linkedBloks.join(', ')}. Silakan ubah atau hapus pemetaan blok tersebut terlebih dahulu!`
    };
  }

  sheet.deleteRow(rowIndex);
  invalidateReferenceCache('Kelompok_Tani');
  invalidateDataSetCache('LAHAN');
  writeLog('MASTER', 'Hapus Kelompok Tani', { ID: id, Nama: targetNama }, '-', session.username, 'Superuser');
  return { success: true, message: `Kelompok Tani '${targetNama}' berhasil dihapus.` };
}

/* ============================================================
 * 3. CRUD Pengaturan Blok (sheet: Pengaturan_Blok)
 * ============================================================ */
function getPengaturanBlokData() {
  const { data } = getSheetData('Pengaturan_Blok');
  const result = data.map(row => ({
    blok: row[0],
    kelompok: String(row[1] || ''),
    keterangan: String(row[2] || '')
  }));
  result.sort((a, b) => (Number(a.blok) || 0) - (Number(b.blok) || 0));
  return result;
}

function savePengaturanBlok(blokNum, kelompokName, keterangan, token) {
  const session = requireSuperuser(token);
  const blok = parseInt(blokNum, 10);
  const kelompok = sanitizeInput(kelompokName);
  const ket = sanitizeInput(keterangan || '');

  if (isNaN(blok) || !kelompok) {
    return { success: false, message: 'Nomor Blok dan Nama Kelompok wajib diisi!' };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Pengaturan_Blok');
  if (!sheet) {
    setupPengaturanBlok(ss, false);
  }
  const { data } = getSheetData('Pengaturan_Blok');

  let rowIndex = -1;
  for (let i = 0; i < data.length; i++) {
    if (parseInt(data[i][0], 10) === blok) {
      rowIndex = i + 2;
      break;
    }
  }

  if (rowIndex !== -1) {
    sheet.getRange(rowIndex, 2).setValue(kelompok);
    if (sheet.getLastColumn() >= 3) {
      sheet.getRange(rowIndex, 3).setValue(ket);
    } else {
      sheet.getRange(1, 3).setValue('Keterangan');
      sheet.getRange(rowIndex, 3).setValue(ket);
    }
  } else {
    sheet.appendRow([blok, kelompok, ket]);
  }

  invalidateReferenceCache('Pengaturan_Blok');
  invalidateDataSetCache('LAHAN');
  writeLog('MASTER', 'Pengaturan Blok', '-', { Blok: blok, Kelompok: kelompok, Keterangan: ket }, session.username, 'Superuser');
  return { success: true, message: `Mapping Blok ${blok} -> Kelompok '${kelompok}' disimpan.` };
}

function deletePengaturanBlok(blokNum, token) {
  const session = requireSuperuser(token);
  const blok = parseInt(blokNum, 10);
  if (isNaN(blok)) {
    return { success: false, message: 'Nomor blok tidak valid!' };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Pengaturan_Blok');
  if (!sheet) {
    return { success: false, message: 'Sheet Pengaturan_Blok tidak ditemukan!' };
  }
  const { data } = getSheetData('Pengaturan_Blok');

  let rowIndex = -1;
  for (let i = 0; i < data.length; i++) {
    if (parseInt(data[i][0], 10) === blok) {
      rowIndex = i + 2;
      break;
    }
  }

  if (rowIndex === -1) {
    return { success: false, message: `Blok ${blok} tidak ditemukan!` };
  }

  sheet.deleteRow(rowIndex);
  invalidateReferenceCache('Pengaturan_Blok');
  invalidateDataSetCache('LAHAN');
  writeLog('MASTER', 'Hapus Blok', { Blok: blok }, '-', session.username, 'Superuser');
  return { success: true, message: `Blok ${blok} berhasil dihapus dari pengaturan.` };
}

/* ============================================================
 * 4. CRUD Users (sheet: Users)
 * ============================================================ */
function getUsersData(params, token) {
  requireSuperuser(token);
  const { data } = getSheetData('Users');
  return data.map(row => ({
    username: String(row[0]),
    role: String(row[2]),
    namaLengkap: String(row[3]),
    status: String(row[4])
  }));
}

function saveUserData(formData, token) {
  const session = requireSuperuser(token);
  const uName = sanitizeInput(formData.username);
  const uPassRaw = sanitizeInput(formData.password);
  const uRole = sanitizeInput(formData.role) || 'Superuser';
  const uFullName = sanitizeInput(formData.namaLengkap);
  const uStatus = sanitizeInput(formData.status) || 'Aktif';

  if (!uName || !uFullName) {
    return { success: false, message: 'Username dan Nama Lengkap wajib diisi!' };
  }

  // SECURITY: password selalu di-hash (SHA-256) sebelum disimpan ke sheet Users.
  // Jangan pernah menulis password mentah/plaintext ke spreadsheet.
  const uPassHash = uPassRaw ? sha256Hex(uPassRaw) : '';

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Users');
  const { data } = getSheetData('Users');

  let rowIndex = -1;
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() === uName) {
      rowIndex = i + 2;
      break;
    }
  }

  if (rowIndex !== -1) {
    // Update existing user
    if (uPassHash) sheet.getRange(rowIndex, 2).setValue(uPassHash);
    sheet.getRange(rowIndex, 3).setValue(uRole);
    sheet.getRange(rowIndex, 4).setValue(uFullName);
    sheet.getRange(rowIndex, 5).setValue(uStatus);
  } else {
    // New user
    if (!uPassHash) return { success: false, message: 'Password wajib diisi untuk user baru!' };
    sheet.appendRow([uName, uPassHash, uRole, uFullName, uStatus]);
  }

  writeLog('MASTER', 'Save User', '-', { Username: uName, Role: uRole, Status: uStatus }, session.username, 'Superuser');
  return { success: true, message: `Data user '${uName}' berhasil disimpan.` };
}

/* ============================================================
 * 5. CRUD Config (sheet: Config)
 * ============================================================ */
function getConfigData(params, token) {
  requireSuperuser(token);
  const { data } = getSheetData('Config');
  return data.map(row => ({
    key: String(row[0]),
    value: String(row[1]),
    keterangan: String(row[2])
  }));
}

function saveConfigData(keyStr, valueStr, token) {
  const session = requireSuperuser(token);
  const key = sanitizeInput(keyStr);
  const val = sanitizeInput(valueStr);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Config');
  const { data } = getSheetData('Config');

  let rowIndex = -1;
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim().toUpperCase() === key.toUpperCase()) {
      rowIndex = i + 2;
      break;
    }
  }

  if (rowIndex !== -1) {
    sheet.getRange(rowIndex, 2).setValue(val);
  } else {
    sheet.appendRow([key, val, 'Custom Config']);
  }

  invalidateReferenceCache('Config');
  invalidateDataSetCache('CONFIG');
  writeLog('CONFIG', 'Save Config', '-', { Key: key, Value: val }, session.username, 'Superuser');
  return { success: true, message: `Pengaturan '${key}' disimpan.` };
}


/* ============================================================
 * BAGIAN 8 — RESUME (dari Resume.gs)
 * Resume NOP & Rekap Kelompok Tani via dbwp-banding
 * ============================================================
 */

/**
 * Menghasilkan data resume status pendaftaran NOP berbasis sheet `dbwp-banding`.
 * Menyajikan rekap berbasis Kelompok Tani (acuan) dan rincian per Blok yang diisi
 * beserta nomor-nomor bidang yang belum terisi dan status luas berlebih.
 */
function getResumeData(params, token) {
  requireSuperuser(token);

  const { data: bandingData, sheet: bandingSheet } = getSheetData('dbwp-banding');
  const { data: blokData } = getSheetData('Pengaturan_Blok');

  // Mapping blok -> kelompok
  const blokKelompokMap = {};
  for (let b = 0; b < blokData.length; b++) {
    const bKey = String(blokData[b][0]).trim();
    if (bKey) {
      const kelName = String(blokData[b][1] || '').trim();
      blokKelompokMap[bKey] = kelName;
      const bInt = parseInt(bKey, 10);
      if (!isNaN(bInt)) {
        blokKelompokMap[String(bInt)] = kelName;
        blokKelompokMap[zeroPad(bInt, 3)] = kelName;
      }
    }
  }

  // Jika sheet dbwp-banding ada dan memiliki data
  if (bandingSheet && bandingData && bandingData.length > 0) {
    return parseResumeFromDbwpBanding(bandingData, blokKelompokMap);
  }

  // Fallback: jika belum ada dbwp-banding, gunakan logika dbwp lama
  return parseResumeFallback(blokKelompokMap);
}

/**
 * Memproses data resume langsung dari sheet `dbwp-banding` (Super Cepat).
 * Header: No.(0), NOP(1), Nop-dot(2), Blok(3), Bidang(4), Nama WP(5), Alamat WP(6), Luas pbb(7), status(8), Ket.(9)
 */
function parseResumeFromDbwpBanding(rows, blokKelompokMap) {
  const blokMap = {}; // blokNum -> { blok, blokPadded, namaBlok, kelompok, fields: [] }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const blokRaw = String(r[3] || '').trim();
    const bidangRaw = String(r[4] || '').trim();
    if (!blokRaw || !bidangRaw) continue;

    const blokNum = parseInt(blokRaw, 10);
    const bidangNum = parseInt(bidangRaw, 10);
    if (isNaN(blokNum) || isNaN(bidangNum)) continue;

    const nopRaw = String(r[1] || '').trim();
    const nopDot = String(r[2] || '').trim();
    const namaWP = String(r[5] || '').trim();
    const alamatWP = String(r[6] || '').trim();
    const luasPBB = Number(r[7] || 0);
    const status = String(r[8] || '').trim().toLowerCase(); // 'terdaftar' atau 'belum'
    const ket = String(r[9] || '').trim(); // 'Luas Berlebih' atau ''

    if (!blokMap[blokNum]) {
      const bPad = zeroPad(blokNum, 3);
      blokMap[blokNum] = {
        blok: blokNum,
        blokPadded: bPad,
        namaBlok: 'Blok ' + bPad,
        kelompok: blokKelompokMap[String(blokNum)] || blokKelompokMap[bPad] || 'Tanpa Kelompok',
        totalBidang: 0,
        totalLuasPBB: 0,
        totalLuasTerdaftar: 0,
        terdaftarCount: 0,
        belumTerisiCount: 0,
        luasBerlebihCount: 0,
        nomorBidangBelumTerisi: [],
        bidangBelumTerisi: []
      };
    }

    const bEntry = blokMap[blokNum];
    bEntry.totalBidang++;
    bEntry.totalLuasPBB += luasPBB;

    if (status === 'terdaftar') {
      bEntry.terdaftarCount++;
      bEntry.totalLuasTerdaftar += luasPBB;
      if (ket.toLowerCase().includes('berlebih')) {
        bEntry.luasBerlebihCount++;
      }
    } else {
      bEntry.belumTerisiCount++;
      const bidangPad = zeroPad(bidangNum, 4);
      bEntry.nomorBidangBelumTerisi.push(bidangPad);
      bEntry.bidangBelumTerisi.push({
        nomorBidang: bidangNum,
        nomorBidangFormatted: bidangPad,
        nop: nopDot || nopRaw,
        namaWP: namaWP || '-',
        alamatWP: alamatWP || '-',
        luasPBB: luasPBB,
        ket: ket
      });
    }
  }

  // Filter hanya blok-blok yang SUDAH diisi (terdaftarCount > 0)
  const allBlokNums = Object.keys(blokMap).map(Number).sort((a, b) => a - b);
  const activeBlocks = [];

  for (let i = 0; i < allBlokNums.length; i++) {
    const b = blokMap[allBlokNums[i]];
    if (b.terdaftarCount > 0) {
      b.isLengkap = b.belumTerisiCount === 0;
      b.persentase = b.totalBidang > 0 ? Math.round((b.terdaftarCount / b.totalBidang) * 100) + '%' : '100%';
      // Urutkan nomor bidang kosong
      b.nomorBidangBelumTerisi.sort();
      b.bidangBelumTerisi.sort((x, y) => x.nomorBidang - y.nomorBidang);
      activeBlocks.push(b);
    }
  }

  // Agregasi Acuan Kelompok Tani
  const kelompokMap = {};
  let totalBidangBelumTerisiGlobal = 0;
  let totalBidangTerisiGlobal = 0;
  let totalLuasPBBGlobal = 0;
  let totalLuasTerdaftarGlobal = 0;
  let totalLuasBerlebihGlobal = 0;
  let blokLengkapCount = 0;
  let blokBelumLengkapCount = 0;

  for (let i = 0; i < activeBlocks.length; i++) {
    const b = activeBlocks[i];
    const kelName = b.kelompok || 'Tanpa Kelompok';

    if (!kelompokMap[kelName]) {
      kelompokMap[kelName] = {
        namaKelompok: kelName,
        blokList: [],
        totalBidang: 0,
        terdaftarCount: 0,
        kurangBidangCount: 0,
        totalLuasPBB: 0,
        totalLuasTerdaftar: 0,
        luasBerlebihCount: 0,
        blokDetails: []
      };
    }

    const kel = kelompokMap[kelName];
    kel.blokList.push(b.namaBlok);
    kel.totalBidang += b.totalBidang;
    kel.terdaftarCount += b.terdaftarCount;
    kel.kurangBidangCount += b.belumTerisiCount;
    kel.totalLuasPBB += b.totalLuasPBB;
    kel.totalLuasTerdaftar += b.totalLuasTerdaftar;
    kel.luasBerlebihCount += b.luasBerlebihCount;
    kel.blokDetails.push({
      blok: b.blok,
      namaBlok: b.namaBlok,
      totalBidang: b.totalBidang,
      terdaftarCount: b.terdaftarCount,
      belumTerisiCount: b.belumTerisiCount,
      isLengkap: b.isLengkap,
      persentase: b.persentase,
      nomorBidangBelumTerisi: b.nomorBidangBelumTerisi,
      bidangBelumTerisi: b.bidangBelumTerisi
    });

    totalBidangBelumTerisiGlobal += b.belumTerisiCount;
    totalBidangTerisiGlobal += b.terdaftarCount;
    totalLuasPBBGlobal += b.totalLuasPBB;
    totalLuasTerdaftarGlobal += b.totalLuasTerdaftar;
    totalLuasBerlebihGlobal += b.luasBerlebihCount;

    if (b.isLengkap) blokLengkapCount++;
    else blokBelumLengkapCount++;
  }

  const kelompoks = Object.keys(kelompokMap).map(kName => {
    const k = kelompokMap[kName];
    k.isLengkap = k.kurangBidangCount === 0;
    k.persentase = k.totalBidang > 0 ? Math.round((k.terdaftarCount / k.totalBidang) * 100) + '%' : '100%';
    return k;
  });

  return {
    isUsingBanding: true,
    summary: {
      totalKelompokDiisi: kelompoks.length,
      totalBlokDiisi: activeBlocks.length,
      blokLengkap: blokLengkapCount,
      blokBelumLengkap: blokBelumLengkapCount,
      totalBidangBelumTerisi: totalBidangBelumTerisiGlobal,
      totalBidangTerisi: totalBidangTerisiGlobal,
      totalLuasPBB: totalLuasPBBGlobal,
      totalLuasTerdaftar: totalLuasTerdaftarGlobal,
      totalLuasBerlebih: totalLuasBerlebihGlobal
    },
    kelompoks: kelompoks,
    blocks: activeBlocks
  };
}

/**
 * Fallback jika sheet dbwp-banding belum dibuat/kosong.
 */
function parseResumeFallback(blokKelompokMap) {
  const { data: dbwpData } = getSheetData('dbwp');
  const { data: trxData } = getSheetData('Pendaftar_RDKK');

  const filledBlokMap = {};
  for (let i = 0; i < trxData.length; i++) {
    const row = trxData[i];
    if (String(row[14] || '').trim() === 'Dibatalkan') continue;

    let blokNum = parseInt(row[7], 10);
    let bidangNum = parseInt(row[8], 10);
    const nopTrx = String(row[9] || '').trim().replace(/[^0-9]/g, '');

    if (isNaN(blokNum) && nopTrx.length >= 17) blokNum = parseInt(nopTrx.substring(10, 13), 10);
    if (isNaN(bidangNum) && nopTrx.length >= 17) bidangNum = parseInt(nopTrx.substring(13, 17), 10);
    if (isNaN(blokNum) || isNaN(bidangNum)) continue;

    if (!filledBlokMap[blokNum]) filledBlokMap[blokNum] = new Set();
    filledBlokMap[blokNum].add(bidangNum);
  }

  const filledBlokNumbers = Object.keys(filledBlokMap).map(Number).sort((a, b) => a - b);
  const dbwpByBlok = {};
  filledBlokNumbers.forEach(num => { dbwpByBlok[num] = []; });

  for (let i = 0; i < dbwpData.length; i++) {
    const row = dbwpData[i];
    const nopRaw = String(row[1] || '').trim();
    // Ambil blok/bidang dari kolom eksplisit jika tersedia, fallback ke NOP string
    let bNum = parseInt(row[2], 10);
    let bdNum = parseInt(row[3], 10);
    if (isNaN(bNum) || isNaN(bdNum)) {
      const cleanN = nopRaw.replace(/[^0-9]/g, '');
      if (cleanN.length < 17) continue;
      bNum = parseInt(cleanN.substring(10, 13), 10);
      bdNum = parseInt(cleanN.substring(13, 17), 10);
    }
    if (isNaN(bNum) || isNaN(bdNum)) continue;

    if (dbwpByBlok[bNum]) {
      dbwpByBlok[bNum].push({
        nomorBidang: bdNum,
        nomorBidangFormatted: zeroPad(bdNum, 4),
        nop: nopRaw,
        namaWP: String(row[4] || '-'),
        alamatWP: String(row[5] || '-'),
        luasPBB: Number(row[6] || 0)
      });
    }
  }

  const blocks = [];
  const kelompokMap = {};
  let totalBelumGlobal = 0;
  let totalTerdaftarGlobal = 0;
  let totalLuasPBBGlobal = 0;
  let blokLengkap = 0;
  let blokBelum = 0;

  for (let i = 0; i < filledBlokNumbers.length; i++) {
    const bNum = filledBlokNumbers[i];
    const regSet = filledBlokMap[bNum] || new Set();
    const bidangs = dbwpByBlok[bNum] || [];
    bidangs.sort((x, y) => x.nomorBidang - y.nomorBidang);

    const belumList = [];
    const belumObj = [];
    let terdaftarCount = 0;
    let blokLuasPBB = 0;

    for (let j = 0; j < bidangs.length; j++) {
      const b = bidangs[j];
      blokLuasPBB += b.luasPBB;
      if (regSet.has(b.nomorBidang)) {
        terdaftarCount++;
      } else {
        belumList.push(b.nomorBidangFormatted);
        belumObj.push(b);
      }
    }

    const total = bidangs.length > 0 ? bidangs.length : terdaftarCount;
    const isLengkap = belumList.length === 0;
    if (isLengkap) blokLengkap++;
    else blokBelum++;

    totalBelumGlobal += belumList.length;
    totalTerdaftarGlobal += terdaftarCount;
    totalLuasPBBGlobal += blokLuasPBB;

    const kelName = blokKelompokMap[String(bNum)] || 'Tanpa Kelompok';
    const bEntry = {
      blok: bNum,
      blokPadded: zeroPad(bNum, 3),
      namaBlok: 'Blok ' + zeroPad(bNum, 3),
      kelompok: kelName,
      totalBidang: total,
      totalLuasPBB: blokLuasPBB,
      totalLuasTerdaftar: 0,
      terdaftarCount: terdaftarCount,
      belumTerisiCount: belumList.length,
      luasBerlebihCount: 0,
      isLengkap: isLengkap,
      persentase: total > 0 ? Math.round((terdaftarCount / total) * 100) + '%' : '100%',
      nomorBidangBelumTerisi: belumList,
      bidangBelumTerisi: belumObj
    };
    blocks.push(bEntry);

    if (!kelompokMap[kelName]) {
      kelompokMap[kelName] = {
        namaKelompok: kelName,
        blokList: [],
        totalBidang: 0,
        terdaftarCount: 0,
        kurangBidangCount: 0,
        totalLuasPBB: 0,
        totalLuasTerdaftar: 0,
        luasBerlebihCount: 0,
        blokDetails: []
      };
    }
    const kel = kelompokMap[kelName];
    kel.blokList.push(bEntry.namaBlok);
    kel.totalBidang += total;
    kel.terdaftarCount += terdaftarCount;
    kel.kurangBidangCount += belumList.length;
    kel.totalLuasPBB += blokLuasPBB;
    kel.blokDetails.push({
      blok: bEntry.blok,
      namaBlok: bEntry.namaBlok,
      totalBidang: total,
      terdaftarCount: terdaftarCount,
      belumTerisiCount: belumList.length,
      isLengkap: isLengkap,
      persentase: bEntry.persentase,
      nomorBidangBelumTerisi: belumList,
      bidangBelumTerisi: belumObj
    });
  }

  const kelompoks = Object.keys(kelompokMap).map(kName => {
    const k = kelompokMap[kName];
    k.isLengkap = k.kurangBidangCount === 0;
    k.persentase = k.totalBidang > 0 ? Math.round((k.terdaftarCount / k.totalBidang) * 100) + '%' : '100%';
    return k;
  });

  return {
    isUsingBanding: false,
    summary: {
      totalKelompokDiisi: kelompoks.length,
      totalBlokDiisi: blocks.length,
      blokLengkap: blokLengkap,
      blokBelumLengkap: blokBelum,
      totalBidangBelumTerisi: totalBelumGlobal,
      totalBidangTerisi: totalTerdaftarGlobal,
      totalLuasPBB: totalLuasPBBGlobal,
      totalLuasTerdaftar: 0,
      totalLuasBerlebih: 0
    },
    kelompoks: kelompoks,
    blocks: blocks
  };
}

/**
 * Sinkronisasi Massal seluruh baris sheet `dbwp-banding` berdasarkan data aktif Pendaftar_RDKK.
 * Dijalankan cepat dengan batch read & write.
 */
function syncAllDbwpBanding(params, token) {
  requireSuperuser(token);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('dbwp-banding');
  if (!sheet) {
    return { success: false, message: 'Sheet dbwp-banding tidak ditemukan!' };
  }

  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return { success: false, message: 'Sheet dbwp-banding masih kosong!' };
  }

  const { data: trxData } = getSheetData('Pendaftar_RDKK');
  const activeTrxMap = {};

  for (let i = 0; i < trxData.length; i++) {
    const r = trxData[i];
    if (String(r[14] || '').trim() === 'Dibatalkan') continue;

    const cleanN = cleanNOPDigits(String(r[9] || ''));
    if (!cleanN) continue;

    if (!activeTrxMap[cleanN]) {
      activeTrxMap[cleanN] = { count: 0, totalLuas: 0, hasOver: false };
    }
    activeTrxMap[cleanN].count++;
    activeTrxMap[cleanN].totalLuas += Number(r[12] || 0);
    if (String(r[14] || '').trim() === 'Melebihi Kapasitas') {
      activeTrxMap[cleanN].hasOver = true;
    }
  }

  const range = sheet.getRange(2, 1, lastRow - 1, 10);
  const rows = range.getValues();

  let terdaftarCount = 0;
  let overCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const n1 = cleanNOPDigits(String(row[1] || ''));
    const n2 = cleanNOPDigits(String(row[2] || ''));
    const cleanN = n1 || n2;
    const luasPBB = Number(row[7] || 0);

    const info = activeTrxMap[cleanN];
    if (info && info.count > 0) {
      row[8] = 'terdaftar';
      terdaftarCount++;
      if (info.hasOver || (luasPBB > 0 && info.totalLuas > luasPBB)) {
        row[9] = 'Luas Berlebih';
        overCount++;
      } else {
        row[9] = '';
      }
    } else {
      row[8] = 'belum';
      row[9] = '';
    }
  }

  const statusKetValues = rows.map(r => [r[8], r[9]]);
  sheet.getRange(2, 9, statusKetValues.length, 2).setValues(statusKetValues);

  return {
    success: true,
    message: `Sinkronisasi dbwp-banding selesai! Total ${rows.length} baris diproses: ${terdaftarCount} terdaftar (${overCount} luas berlebih), ${rows.length - terdaftarCount} belum.`
  };
}


/* ============================================================
 * BAGIAN 9 — LOG (dari Log.gs)
 * Audit Trail (Log Aktivitas)
 * ============================================================
 */

/**
 * Mencatat aktivitas ke sheet Log_Aktivitas.
 */
function writeLog(idTransaksi, aksi, dataSebelum, dataSesudah, operatorName, roleName) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName('Log_Aktivitas');

    if (!sheet) {
      sheet = ss.insertSheet('Log_Aktivitas');
      sheet.getRange(1, 1, 1, 7).setValues([
        ['Timestamp', 'ID_Transaksi', 'Aksi', 'Data Sebelum', 'Data Sesudah', 'User/Operator', 'Role']
      ]);
    }

    const now = new Date();
    const row = [
      now,
      idTransaksi || '-',
      aksi || '-',
      typeof dataSebelum === 'object' ? JSON.stringify(dataSebelum) : (dataSebelum || '-'),
      typeof dataSesudah === 'object' ? JSON.stringify(dataSesudah) : (dataSesudah || '-'),
      operatorName || 'Operator Lapangan',
      roleName || 'User'
    ];

    sheet.appendRow(row);
    const lastRow = sheet.getLastRow();
    sheet.getRange(lastRow, 1).setNumberFormat('dd/mm/yyyy hh:mm:ss');
  } catch (e) {
    Logger.log('Gagal menulis log: ' + e.toString());
  }
}

/* ============================================================
 * BAGIAN — DOKUMENTASI FOTO HARD-DOC (Google Drive)
 * ------------------------------------------------------------
 * Setiap foto dikaitkan ke ID_Transaksi (bukan NIK), karena satu sesi
 * dokumentasi (buka kamera sekali, ambil beberapa foto) selalu terjadi
 * dalam konteks satu sesi input data (= satu ID_Transaksi), meskipun
 * satu NIK di lapangan bisa punya lebih dari satu Transaksi seiring waktu
 * (pendaftaran lahan bertahap). Struktur Drive: folder induk
 * "Dokumentasi_RDKK" > sub-folder per ID_Transaksi > file-file foto.
 * Metadata dicatat di sheet "DokumenFoto" agar bisa dikueri tanpa
 * memanggil Drive API berulang kali.
 * ============================================================ */

function getOrCreateRootDokumentasiFolder_() {
  const props = PropertiesService.getScriptProperties();
  const cachedId = props.getProperty('DOKUMENTASI_ROOT_FOLDER_ID');
  if (cachedId) {
    try {
      return DriveApp.getFolderById(cachedId);
    } catch (e) {
      // Folder mungkin sudah dihapus manual dari Drive — buat ulang di bawah.
    }
  }
  const rootName = 'Dokumentasi_RDKK';
  const existing = DriveApp.getFoldersByName(rootName);
  const folder = existing.hasNext() ? existing.next() : DriveApp.createFolder(rootName);
  props.setProperty('DOKUMENTASI_ROOT_FOLDER_ID', folder.getId());
  return folder;
}

function getOrCreateTransaksiFolder_(idTransaksi) {
  const root = getOrCreateRootDokumentasiFolder_();
  const existing = root.getFoldersByName(idTransaksi);
  if (existing.hasNext()) return existing.next();
  return root.createFolder(idTransaksi);
}

function ensureDokumenFotoSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('DokumenFoto');
  if (!sheet) {
    sheet = ss.insertSheet('DokumenFoto');
    sheet.getRange(1, 1, 1, 8).setValues([
      ['Timestamp', 'ID_Transaksi', 'NIK', 'Nama File', 'Drive File ID', 'Drive URL', 'Operator', 'Role']
    ]);
  }
  return sheet;
}

/**
 * Menyimpan satu foto dokumentasi (dipanggil berulang dari frontend,
 * satu request per foto, agar tahan terhadap koneksi lapangan yang tidak stabil
 * dan tidak menabrak batas waktu eksekusi Apps Script).
 * params: { idTransaksi, base64, mimeType, namaFile? }
 */
function uploadDokumenFoto(params, token) {
  requireSuperuser(token);

  const idTransaksi = sanitizeInput(params.idTransaksi);
  const base64Data = params.base64;
  const mimeType = sanitizeInput(params.mimeType || 'image/jpeg');
  const namaFileInput = sanitizeInput(params.namaFile || '');

  if (!idTransaksi) return { success: false, message: 'ID Transaksi wajib diisi.' };
  if (!base64Data) return { success: false, message: 'Data foto kosong, gagal diunggah.' };

  // Validasi ID Transaksi benar-benar ada, sekaligus ambil NIK pemiliknya
  const { data } = getSheetData('Pendaftar_RDKK');
  let nik = '';
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() === idTransaksi) {
      nik = String(data[i][3]);
      break;
    }
  }
  if (!nik) {
    return { success: false, message: 'ID Transaksi "' + idTransaksi + '" tidak ditemukan. Foto tidak dapat disimpan.' };
  }

  try {
    const bytes = Utilities.base64Decode(base64Data);

    // Batas wajar per foto (setelah kompresi di sisi klien seharusnya jauh di bawah ini)
    const MAX_BYTES = 8 * 1024 * 1024;
    if (bytes.length > MAX_BYTES) {
      return { success: false, message: 'Ukuran foto terlalu besar (maks 8MB). Coba ambil ulang.' };
    }

    const folder = getOrCreateTransaksiFolder_(idTransaksi);
    const seqNumber = countFilesInFolder_(folder) + 1;
    const namaFile = namaFileInput || (idTransaksi + '_' + zeroPad(seqNumber, 3) + '.jpg');

    const blob = Utilities.newBlob(bytes, mimeType, namaFile);
    const file = folder.createFile(blob);
    // Supaya bisa ditampilkan langsung via <img> di frontend (Cloudflare Pages)
    // tanpa perlu login Google di sisi pengguna yang melihat.
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    const fileId = file.getId();
    const driveUrl = 'https://drive.google.com/uc?export=view&id=' + fileId;
    const thumbUrl = 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w400';

    const sheet = ensureDokumenFotoSheet_();
    const sessionInfo = getSuperuserSession(token);
    const roleName = sessionInfo.isLogged ? 'Superuser' : 'User';
    const operatorName = sessionInfo.isLogged ? sessionInfo.user.username : (sanitizeInput(params.operatorName) || 'Operator Lapangan');

    sheet.appendRow([new Date(), idTransaksi, nik, namaFile, fileId, driveUrl, operatorName, roleName]);
    sheet.getRange(sheet.getLastRow(), 1).setNumberFormat('dd/mm/yyyy hh:mm:ss');

    writeLog(idTransaksi, 'Upload Foto Dokumentasi', '-', namaFile, operatorName, roleName);

    return { success: true, driveFileId: fileId, driveUrl: driveUrl, thumbUrl: thumbUrl, namaFile: namaFile };
  } catch (e) {
    return { success: false, message: 'Gagal menyimpan foto: ' + e.toString() };
  }
}

function countFilesInFolder_(folder) {
  let count = 0;
  const it = folder.getFiles();
  while (it.hasNext()) {
    it.next();
    count++;
  }
  return count;
}

/**
 * Ambil seluruh foto dokumentasi milik satu ID Transaksi.
 */
function getDokumenFotoByTransaksi(idTransaksi, token) {
  requireSuperuser(token);

  const cleanId = sanitizeInput(idTransaksi);
  if (!cleanId) return { success: false, message: 'ID Transaksi tidak valid.', photos: [] };

  const { data } = getSheetData('DokumenFoto');
  const photos = [];
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (String(row[1]).trim() === cleanId) {
      photos.push({
        timestamp: formatDateTime(row[0]),
        idTransaksi: String(row[1]),
        nik: String(row[2]),
        namaFile: String(row[3]),
        driveFileId: String(row[4]),
        driveUrl: String(row[5]),
        thumbUrl: 'https://drive.google.com/thumbnail?id=' + String(row[4]) + '&sz=w400',
        operator: String(row[6]),
        role: String(row[7])
      });
    }
  }
  return { success: true, photos: photos };
}

/**
 * Ambil seluruh foto dokumentasi milik satu NIK, dikelompokkan per ID Transaksi
 * (karena satu NIK bisa punya beberapa Transaksi/sesi pendaftaran bertahap).
 */
function getDokumenFotoByNik(nik, token) {
  requireSuperuser(token);

  const cleanNIK = sanitizeInput(nik);
  if (!cleanNIK) return { success: false, message: 'NIK tidak valid.', groups: [] };

  const historiList = getHistoriNIK(cleanNIK);
  const idSet = {};
  historiList.forEach(function(h) { idSet[h.idTransaksi] = true; });

  const { data } = getSheetData('DokumenFoto');
  const grouped = {};
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const idTrx = String(row[1]).trim();
    if (idSet[idTrx]) {
      if (!grouped[idTrx]) grouped[idTrx] = [];
      grouped[idTrx].push({
        timestamp: formatDateTime(row[0]),
        namaFile: String(row[3]),
        driveFileId: String(row[4]),
        driveUrl: String(row[5]),
        thumbUrl: 'https://drive.google.com/thumbnail?id=' + String(row[4]) + '&sz=w400',
        operator: String(row[6])
      });
    }
  }

  const groups = Object.keys(grouped).map(function(idTrx) {
    return { idTransaksi: idTrx, photos: grouped[idTrx] };
  });

  return { success: true, nik: cleanNIK, groups: groups };
}

/**
 * Hapus satu foto dokumentasi (Drive file di-trash + baris metadata dihapus).
 */
function deleteDokumenFoto(driveFileId, idTransaksi, token) {
  const user = requireSuperuser(token);

  const cleanFileId = sanitizeInput(driveFileId);
  if (!cleanFileId) return { success: false, message: 'File ID tidak valid.' };

  try {
    const file = DriveApp.getFileById(cleanFileId);
    file.setTrashed(true);
  } catch (e) {
    // Lanjutkan menghapus metadata walau file Drive sudah tidak ada/sudah terhapus manual.
  }

  const { data, sheet } = getSheetData('DokumenFoto');
  if (!sheet) return { success: false, message: 'Data dokumentasi foto tidak ditemukan.' };

  for (let i = 0; i < data.length; i++) {
    if (String(data[i][4]).trim() === cleanFileId) {
      sheet.deleteRow(i + 2); // +2: offset header row + index 0-based
      writeLog(sanitizeInput(idTransaksi), 'Hapus Foto Dokumentasi', String(data[i][3]), '-', user.username, 'Superuser');
      return { success: true, message: 'Foto berhasil dihapus.' };
    }
  }
  return { success: false, message: 'Data foto tidak ditemukan di sheet.' };
}

/**
 * Membaca data log aktivitas (Superuser only).
 */
function getLogAktivitas(limit, token) {
  requireSuperuser(token);

  const { data } = getSheetData('Log_Aktivitas');
  const logs = [];
  const maxRows = limit || 200;

  // Baca dari bawah (paling baru)
  for (let i = data.length - 1; i >= 0 && logs.length < maxRows; i--) {
    const row = data[i];
    logs.push({
      timestamp: formatDateTime(row[0]),
      idTransaksi: String(row[1] || ''),
      aksi: String(row[2] || ''),
      dataSebelum: String(row[3] || ''),
      dataSesudah: String(row[4] || ''),
      operator: String(row[5] || ''),
      role: String(row[6] || '')
    });
  }

  return logs;
}


/* ============================================================
 * BAGIAN 10 — EXPORT (dari Export.gs)
 * Export Data ke CSV / HTML Printable (PDF Polos)
 * ============================================================
 */

/**
 * Generates plain HTML table printable format (yang dapat di-print / Save as PDF oleh browser)
 * sesuai dengan header spreadsheet polos.
 */
function generatePrintableHTML(exportType, searchParams, token) {
  // Guard: endpoint ini hanya dapat diakses oleh Superuser (token diteruskan pemanggil).
  requireSuperuser(token);

  let title = 'Laporan Transaksi e-RDKK';
  let headers = [];
  let rows = [];

  if (exportType === 'rekap_kelompok') {
    title = 'Rekapitulasi Pendataan e-RDKK per Kelompok';
    headers = ['No.', 'Nama Kelompok', 'Jumlah Petani (NIK Unik)', 'Total Transaksi', 'Total Luas Didaftarkan (m²)'];
    const rekapData = getRekapByKelompok();
    rows = rekapData.map((item, idx) => [
      idx + 1,
      item.kelompok,
      item.totalPetani,
      item.totalTransaksi,
      item.totalLuas.toLocaleString('id-ID')
    ]);
  } else if (exportType === 'log') {
    title = 'Log Aktivitas / Audit Trail e-RDKK';
    headers = ['Timestamp', 'ID Transaksi', 'Aksi', 'Data Sebelum', 'Data Sesudah', 'User/Operator', 'Role'];
    const logs = getLogAktivitas(500, token);
    rows = logs.map(l => [
      l.timestamp, l.idTransaksi, l.aksi, l.dataSebelum, l.dataSesudah, l.operator, l.role
    ]);
  } else {
    // Default: transaksi
    title = 'Data Transaksi Pendataan e-RDKK';
    headers = [
      'ID Transaksi', 'Tahun', 'Tanggal Input', 'NIK', 'Nama Petani', 'Alamat Petani',
      'Nomor HP', 'Blok', 'No Bidang', 'NOP', 'Status NOP', 'Nama WP (PBB)', 'Luas PBB',
      'Luas Didaftarkan', 'Sisa Luas', 'Status Transaksi', 'Keterangan', 'Input Oleh'
    ];
    const dataTrx = searchTransaksi(searchParams || {});
    rows = dataTrx.map(t => [
      t.idTransaksi, t.tahun, t.tanggal, t.nik, t.namaPetani, t.alamatPetani,
      t.nomorHp || t.nomorHP || '', t.blok, t.nomorBidang, t.nop, t.statusNOP, t.namaWP,
      (t.luasPBB || 0).toLocaleString('id-ID'), (t.luasDidaftarkan || 0).toLocaleString('id-ID'),
      (t.sisaLuasPBB || 0).toLocaleString('id-ID'), t.statusTransaksi, t.keterangan, t.inputOleh
    ]);
  }

  let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    body { font-family: Arial, sans-serif; font-size: 11px; margin: 20px; color: #111; }
    h2 { font-size: 16px; text-align: center; margin-bottom: 5px; }
    p.meta { text-align: center; font-size: 10px; color: #666; margin-bottom: 15px; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th { background-color: #4a86e8; color: #ffffff; font-weight: bold; border: 1px solid #333; padding: 6px 4px; text-align: center; }
    td { border: 1px solid #ccc; padding: 5px 4px; }
    tr:nth-child(even) { background-color: #f9f9f9; }
    .text-center { text-align: center; }
    .text-right { text-align: right; }
    @media print {
      body { margin: 0; }
      th { background-color: #4a86e8 !important; -webkit-print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  <h2>${title}</h2>
  <p class="meta">Tanggal Cetak: ${formatDateTime(new Date())}</p>
  <table>
    <thead>
      <tr>`;

  headers.forEach(h => {
    html += `<th>${h}</th>`;
  });

  html += `</tr>
    </thead>
    <tbody>`;

  rows.forEach(r => {
    html += `<tr>`;
    r.forEach(val => {
      html += `<td>${escapeHtml(val)}</td>`;
    });
    html += `</tr>`;
  });

  html += `</tbody>
  </table>
</body>
</html>`;

  return html;
}


/* ============================================================
 * BAGIAN 11 — ARSIP (dari Arsip.gs)
 * Mechanism Arsip Data Tahunan (F10)
 * ============================================================
 */

/**
 * Memindahkan transaksi dari Pendaftar_RDKK ke sheet Arsip_YYYY.
 */
function runArsipTahunan(tahunTarget, token) {
  const session = requireSuperuser(token);
  const targetYear = parseInt(tahunTarget, 10);

  if (isNaN(targetYear) || targetYear < 2020 || targetYear > 2100) {
    return { success: false, message: 'Tahun arsip tidak valid!' };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const mainSheet = ss.getSheetByName('Pendaftar_RDKK');
  if (!mainSheet) return { success: false, message: 'Sheet Pendaftar_RDKK tidak ditemukan.' };

  const { headers, data } = getSheetData('Pendaftar_RDKK');
  const archiveSheetName = `Arsip_${targetYear}`;
  let archiveSheet = ss.getSheetByName(archiveSheetName);

  if (!archiveSheet) {
    archiveSheet = ss.insertSheet(archiveSheetName);
    archiveSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    styleHeader(archiveSheet, headers.length);
  }

  const rowsToMove = [];
  const rowIndicesToDelete = [];

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const rowTahun = parseInt(row[1], 10);

    if (rowTahun === targetYear) {
      rowsToMove.push(row);
      rowIndicesToDelete.push(i + 2); // 1-based index + 1 header row
    }
  }

  if (rowsToMove.length === 0) {
    return { success: false, message: `Tidak ada data transaksi untuk tahun ${targetYear} yang perlu diarsip.` };
  }

  // Write rows to archive sheet
  const startRowArchive = archiveSheet.getLastRow() + 1;
  archiveSheet.getRange(startRowArchive, 1, rowsToMove.length, headers.length).setValues(rowsToMove);

  // Delete from main sheet in reverse order to preserve indices
  for (let d = rowIndicesToDelete.length - 1; d >= 0; d--) {
    mainSheet.deleteRow(rowIndicesToDelete[d]);
  }

  // Update Config LAST_ARSIP
  saveConfigData('LAST_ARSIP', `${targetYear} (Diarisipkan oleh ${session.username} pada ${formatDateTime(new Date())})`, token);

  // Write log
  writeLog('ARSIP', 'Arsip Tahunan', '-', `Memindahkan ${rowsToMove.length} baris ke sheet ${archiveSheetName}`, session.username, 'Superuser');

  return {
    success: true,
    message: `Berhasil mengarsipkan ${rowsToMove.length} transaksi tahun ${targetYear} ke sheet '${archiveSheetName}'.`
  };
}

/**
 * Mencari data dari Sheet Arsip.
 */
function searchArsipData(tahunTarget, keyword, token) {
  requireSuperuser(token);
  const archiveSheetName = `Arsip_${tahunTarget}`;
  const { data } = getSheetData(archiveSheetName);

  if (!data || data.length === 0) return [];

  const cleanKw = String(keyword || '').trim().toLowerCase();
  const results = [];

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const nik = String(row[3] || '');
    const nama = String(row[4] || '');
    const nop = String(row[8] || '');
    const idTrx = String(row[0] || '');

    if (!cleanKw || nik.toLowerCase().includes(cleanKw) || nama.toLowerCase().includes(cleanKw) || nop.toLowerCase().includes(cleanKw) || idTrx.toLowerCase().includes(cleanKw)) {
      results.push({
        idTransaksi: idTrx,
        tahun: row[1],
        tanggal: formatDateTime(row[2]),
        nik: nik,
        namaPetani: nama,
        alamatPetani: String(row[5]),
        blok: row[6],
        nomorBidang: row[7],
        nop: nop,
        luasDidaftarkan: row[12],
        statusTransaksi: String(row[14]),
        inputOleh: String(row[16])
      });
    }
  }

  return results;
}


/* ============================================================
 * BAGIAN 12 — INITIAL INSTALL (dari InitialInstall.gs)
 * ------------------------------------------------------------
 * Menyiapkan struktur sheet database Google Sheets.
 * Aman dijalankan berulang kali (idempotent).
 * Sheet `dbwp` (Master Tanah) tidak akan ditimpa jika sudah ada.
 * ============================================================
 */

function runInitialInstall(forceReset) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  setupDbwp(ss, forceReset);
  setupPendaftarRDKK(ss, forceReset);
  setupLogAktivitas(ss, forceReset);
  setupKelompokTani(ss, forceReset);
  setupPengaturanBlok(ss, forceReset);
  setupUsers(ss, forceReset);
  setupConfig(ss, forceReset);

  // Hapus sheet default "Sheet1" jika masih ada & ada sheet lain
  const defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && ss.getSheets().length > 1) {
    try {
      ss.deleteSheet(defaultSheet);
    } catch (e) {
      // Ignore if cannot delete
    }
  }

  const summary =
    'Instalasi Aplikasi e-RDKK Selesai!\n\n' +
    'Semua sheet pendukung telah disiapkan.\n' +
    'Data master tanah pada sheet `dbwp` dipertahankan.\n\n' +
    'Login Superuser:\n' +
    '- Username: admin\n' +
    '- Password: admin123\n\n' +
    '(User biasa tidak memerlukan login).';

  // SpreadsheetApp.getUi() tidak tersedia pada konteks Web App REST API.
  // Alert tetap ditampilkan saat dijalankan dari editor Apps Script.
  try {
    SpreadsheetApp.getUi().alert(summary);
  } catch (uiErr) {
    Logger.log(summary);
  }

  return { success: true, message: summary };
}

function getOrCreateSheet(ss, name, forceReset) {
  let sheet = ss.getSheetByName(name);
  if (forceReset && sheet && name !== 'dbwp') {
    // dbwp dilindungi agar tidak tidak sengaja terhapus meski forceReset
    ss.deleteSheet(sheet);
    sheet = null;
  }
  const isNew = !sheet;
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  return { sheet, isNew };
}

function styleHeader(sheet, numCols) {
  const headerRange = sheet.getRange(1, 1, 1, numCols);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#1e293b'); // Dark slate header
  headerRange.setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  try {
    sheet.autoResizeColumns(1, numCols);
  } catch (e) {}
}

/* ============================================================
 * SHEET 1: dbwp (master data PBB / Data Tanah)
 * Header wajib: No., NOP, Blok, Bidang, Nama WP, Alamat WP, Luas pbb, Koordinat
 * ============================================================ */
function setupDbwp(ss, forceReset) {
  const name = 'dbwp';
  const { sheet, isNew } = getOrCreateSheet(ss, name, false); // forceReset selalu false untuk dbwp
  if (!isNew) return;

  const headers = ['No.', 'NOP', 'Blok', 'Bidang', 'Nama WP', 'Alamat WP', 'Luas pbb', 'Koordinat'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  // Mockup data jika sheet baru dibuat dari nol
  const mockData = [
    [1, '3510071003.005.0001.0', 5, 1, 'Warsito', 'Kp. Cisedane RT01/02', 1500, ''],
    [2, '3510071003.006.0002.0', 6, 2, 'Suparjo', 'Kp. Cisedane RT02/03', 2000, ''],
    [3, '3510071003.014.0025.0', 14, 25, 'Ny. Aminah', 'Kp. Cisedane RT03/01', 1200, ''],
    [4, '3510071003.003.0001.0', 3, 1, 'Dedi Kurniawan', 'Kp. Cilosari RT01/04', 3000, ''],
    [5, '3510071003.004.0007.0', 4, 7, 'Hj. Sumiati', 'Kp. Cilosari RT02/01', 1800, ''],
  ];
  sheet.getRange(2, 1, mockData.length, headers.length).setValues(mockData);
  sheet.getRange(2, 7, mockData.length, 1).setNumberFormat('#,##0');
  styleHeader(sheet, headers.length);
}

/* ============================================================
 * SHEET 2: Pendaftar_RDKK (transaksional)
 * ============================================================ */
function setupPendaftarRDKK(ss, forceReset) {
  const name = 'Pendaftar_RDKK';
  const { sheet, isNew } = getOrCreateSheet(ss, name, forceReset);
  if (!isNew) return;

  const headers = [
    'ID_Transaksi', 'Tahun', 'Tanggal Input', 'NIK', 'Nama Petani', 'Alamat Petani',
    'Nomor_Hp',
    'Blok', 'Nomor Bidang', 'NOP', 'Status NOP', 'Nama WP (ref)',
    'Luas PBB (ref)', 'Luas Didaftarkan', 'Sisa Luas PBB',
    'Status Transaksi', 'Keterangan', 'Input Oleh', 'Koordinat'
  ];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  const today = new Date();
  const currentYear = today.getFullYear();
  const mockData = [
    [
      'TRX-0001', currentYear, today, '3201010101010001', 'Budi Santoso', 'Kp. Cisedane RT01/02',
      '', 5, 1, '3510071003.005.0001.0', 'Ditemukan', 'Warsito',
      1500, 800, 700, 'Aktif', '', 'Operator Lapangan', ''
    ],
    [
      'TRX-0002', currentYear, today, '3201010101010002', 'Siti Aisyah', 'Kp. Cisedane RT01/02',
      '', 5, 1, '3510071003.005.0001.0', 'Ditemukan', 'Warsito',
      1500, 700, 0, 'Aktif', 'Dua petani menggarap 1 NOP yang sama', 'Operator Lapangan', ''
    ],
    [
      'TRX-0003', currentYear, today, '3201010101010003', 'Joko Prasetyo', 'Kp. Cilosari RT01/04',
      '', 3, 1, '3510071003.003.0001.0', 'Ditemukan', 'Dedi Kurniawan',
      3000, 3000, 0, 'Aktif', '', 'admin', ''
    ]
  ];
  sheet.getRange(2, 1, mockData.length, headers.length).setValues(mockData);
  sheet.getRange(2, 3, mockData.length, 1).setNumberFormat('dd/mm/yyyy hh:mm');
  sheet.getRange(2, 13, mockData.length, 3).setNumberFormat('#,##0');
  styleHeader(sheet, headers.length);

  // Validation: Status Transaksi di kolom 16
  const statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['Aktif', 'Melebihi Kapasitas', 'Dibatalkan'], true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(2, 16, 1000, 1).setDataValidation(statusRule);
}

/* ============================================================
 * SHEET 3: Log_Aktivitas (audit trail)
 * ============================================================ */
function setupLogAktivitas(ss, forceReset) {
  const name = 'Log_Aktivitas';
  const { sheet, isNew } = getOrCreateSheet(ss, name, forceReset);
  if (!isNew) return;

  const headers = [
    'Timestamp', 'ID_Transaksi', 'Aksi', 'Data Sebelum',
    'Data Sesudah', 'User/Operator', 'Role'
  ];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  const now = new Date();
  const mockData = [
    [now, 'TRX-0001', 'Tambah', '-', 'NIK:3201010101010001, Luas:800', 'Operator Lapangan', 'User'],
    [now, 'TRX-0002', 'Tambah', '-', 'NIK:3201010101010002, Luas:700', 'Operator Lapangan', 'User'],
    [now, 'TRX-0003', 'Tambah', '-', 'NIK:3201010101010003, Luas:3000', 'admin', 'Superuser']
  ];
  sheet.getRange(2, 1, mockData.length, headers.length).setValues(mockData);
  sheet.getRange(2, 1, mockData.length, 1).setNumberFormat('dd/mm/yyyy hh:mm:ss');
  styleHeader(sheet, headers.length);
}

/* ============================================================
 * SHEET 4: Kelompok_Tani (Master Data Kelompok Tani)
 * ============================================================ */
function setupKelompokTani(ss, forceReset) {
  const name = 'Kelompok_Tani';
  const { sheet, isNew } = getOrCreateSheet(ss, name, forceReset);
  if (!isNew) return;

  const headers = ['ID_Kelompok', 'Nama Kelompok', 'Ketua', 'Kontak', 'Keterangan'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  const mockData = [
    ['KT-01', 'Cisedane', 'Warsito', '08123456789', 'Wilayah Blok 5, 6, 14'],
    ['KT-02', 'Cilosari', 'Dedi Kurniawan', '08198765432', 'Wilayah Blok 3, 4, 7, 13']
  ];
  sheet.getRange(2, 1, mockData.length, headers.length).setValues(mockData);
  styleHeader(sheet, headers.length);
}

/* ============================================================
 * SHEET 5: Pengaturan_Blok (mapping kelompok blok)
 * ============================================================ */
function setupPengaturanBlok(ss, forceReset) {
  const name = 'Pengaturan_Blok';
  const { sheet, isNew } = getOrCreateSheet(ss, name, forceReset);
  if (!isNew) return;

  const headers = ['Blok', 'Kelompok', 'Keterangan'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  const mockData = [
    [5, 'Cisedane', 'Blok pemukiman timur'],
    [6, 'Cisedane', 'Blok persawahan utama'],
    [14, 'Cisedane', 'Blok perkebunan'],
    [3, 'Cilosari', 'Blok persawahan barat'],
    [4, 'Cilosari', 'Blok irigasi hilir'],
    [7, 'Cilosari', 'Blok tegalan'],
    [13, 'Cilosari', 'Blok perbatasan utara']
  ];
  sheet.getRange(2, 1, mockData.length, headers.length).setValues(mockData);
  styleHeader(sheet, headers.length);
}

/* ============================================================
 * SHEET 6: Users (akun login Superuser)
 * ============================================================ */
function setupUsers(ss, forceReset) {
  const name = 'Users';
  const { sheet, isNew } = getOrCreateSheet(ss, name, forceReset);
  if (!isNew) return;

  const headers = ['Username', 'Password', 'Role', 'Nama Lengkap', 'Status'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  const mockData = [
    ['admin', 'admin123', 'Superuser', 'Administrator Desa', 'Aktif']
  ];
  sheet.getRange(2, 1, mockData.length, headers.length).setValues(mockData);
  styleHeader(sheet, headers.length);
}

/* ============================================================
 * SHEET 7: Config (pengaturan umum)
 * ============================================================ */
function setupConfig(ss, forceReset) {
  const name = 'Config';
  const { sheet, isNew } = getOrCreateSheet(ss, name, forceReset);
  if (!isNew) return;

  const headers = ['Key', 'Value', 'Keterangan'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  const mockData = [
    ['PREFIX_NOP', '3510071003', 'Prefix tetap NOP (bisa dipisah koma untuk multi-prefix)'],
    ['TOLERANSI_LEBIH_LUAS', 'IZINKAN', 'IZINKAN = boleh simpan dengan status Melebihi Kapasitas; TOLAK = blokir simpan'],
    ['SESSION_TIMEOUT_HOURS', '6', 'Masa berlaku login Superuser dalam jam (max 6h karena batas CacheService GAS)'],
    ['MAX_LUAS_PER_BIDANG_M2', '50000', 'Batas atas wajar Luas Didaftarkan per bidang (m²) untuk mencegah salah ketik; sesuaikan bila perlu'],
    ['LAST_ARSIP', '', 'Tanggal & tahun arsip terakhir']
  ];
  sheet.getRange(2, 1, mockData.length, headers.length).setValues(mockData);
  styleHeader(sheet, headers.length);
}
