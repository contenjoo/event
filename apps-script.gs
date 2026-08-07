/**
 * 2026 AI 활용 교육 콘퍼런스 (with 오늘배움) — 안전한 응모 저장용 Google Apps Script
 *
 * 배포:
 * 1. Google Sheet의 [확장 프로그램] → [Apps Script]에 이 파일을 붙여넣습니다.
 * 2. [배포] → [새 배포] → 유형 "웹 앱"을 선택합니다.
 * 3. 실행 계정은 소유자, 액세스 권한은 "모든 사용자"로 설정합니다.
 * 4. 배포 URL을 stars.html의 SHEET_ENDPOINT에 설정합니다.
 *    TV 별자리(constellation.html)는 같은 URL에 ?action=count 로 접수 건수를 조회합니다.
 * 5. 반드시 Apps Script를 먼저 배포한 뒤 정적 HTML을 배포합니다.
 *    프론트는 EVENT_API_V2 마커가 확인될 때만 응모 POST를 전송합니다.
 *
 * 브라우저가 보낸 경품 값은 신뢰하지 않습니다.
 * draw 단계에서 서버가 결과와 일회성 토큰을 만들고, submit 단계에서 토큰의 결과만 저장합니다.
 *
 * 시트 열 구성: 접수시각 | 이름 | 학교 | 이메일 | 선택 툴 | 체험 기간(일) | 특별상 보너스 | 당첨 경품 | 미리받기
 */

var SHEET_NAME = '응모';
var TOKEN_SHEET_NAME = '응모_토큰';
var COUNTER_SHEET_NAME = '별_카운트'; // TV 별자리용 익명 참여 카운터 (개인정보 없음)
var MIZOU_SHEET_NAME = 'Mizou_링크'; // Mizou는 1회용 링크라 재고에서 하나씩 꺼내 씁니다.
var MIZOU_HEADERS = ['기간(일)', '링크', '발급시각', '토큰'];
var MIZOU_DAYS_BY_TIER = { 30: 60, 60: 90, 90: 90 }; // 등급 → Mizou 링크 기간(2~3개월)
var VERSION = 'security-v2';
var API_MARKER = 'EVENT_API_V2';
var SHEET_HEADERS = ['접수시각', '이름', '학교', '이메일', '선택 툴', '체험 기간(일)', '특별상 보너스', '당첨 경품', '미리받기'];
var TOKEN_SHEET_HEADERS = ['토큰', '생성시각', '클라이언트ID', '선택 툴(JSON)', '체험 기간(일)', '특별상(JSON)', '당첨 경품', '사용시각', '요청ID'];
var TOOL_IDS = ['Snorkl', 'Redmenta', 'Mizou'];
var MAX_TOOLS = 2; // 선생님 1인당 최대 선택 도구 수
var PERIODS = [
  { days: 30, weight: 50 },
  { days: 60, weight: 30 },
  { days: 90, weight: 20 },
];
var SPECIALS = [
  { full: 'Snorkl 과제 10개 추가', chance: 0.40, requiresTool: 'Snorkl' },
];
var TOKEN_TTL_MILLISECONDS = 30 * 60 * 1000;
var DRAW_COOLDOWN_MILLISECONDS = 15 * 1000;
var CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;
var TOKEN_PATTERN = /^[A-Za-z0-9-]{20,80}$/;
var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function doPost(e) {
  var lock = LockService.getScriptLock();
  var locked = false;

  try {
    lock.waitLock(10000);
    locked = true;

    var p = (e && e.parameter) || {};
    if (String(p.website || '').trim()) return json({ ok: false, error: 'invalid_request' });

    var action = String(p.action || '').trim();
    if (action === 'draw') return handleDraw(p);
    if (action === 'submit') return handleSubmit(p);
    if (action === 'claimMizou') return handleClaimMizou(p);
    return json({ ok: false, error: 'invalid_action' });
  } catch (err) {
    Logger.log(err && err.stack ? err.stack : err);
    return json({ ok: false, error: 'server_error' });
  } finally {
    if (locked) lock.releaseLock();
  }
}

// 행사 종료 — 새 추첨은 받지 않습니다. 이미 발급된 링크와 집계 조회는 그대로 동작합니다.
var EVENT_CLOSED = true;

function handleDraw(p) {
  if (EVENT_CLOSED) return json({ ok: false, error: 'event_closed' });
  var tools = parseTools(p.tools);
  var clientId = String(p.clientId || '').trim();
  if (!tools || !CLIENT_ID_PATTERN.test(clientId)) {
    return json({ ok: false, error: 'invalid_draw_request' });
  }

  var tokenSheet = ensureTokenSheet();
  var now = new Date();
  var cache = CacheService.getScriptCache();

  // 네트워크 오류로 프론트가 같은 draw를 다시 보낼 수 있습니다.
  // 같은 requestId면 새로 뽑지 않고 이전 결과를 그대로 돌려줍니다(중복 발급·쿨다운 오탐 방지).
  // 첫 시도에는 조회하지 않고, 프론트가 재시도임을 알릴 때(retry=1)나 캐시에 흔적이 있을 때만 시트를 뒤집니다.
  var requestId = String(p.requestId || '').trim();
  var isRetry = String(p.retry || '') === '1';
  if (requestId && CLIENT_ID_PATTERN.test(requestId) && (isRetry || cache.get('req_' + requestId))) {
    var prior = findRequestRecord(tokenSheet, requestId);
    if (prior) {
      try {
        return json({
          ok: true,
          token: prior.token,
          days: Number(prior.days),
          specials: JSON.parse(prior.specialsJson),
          prize: prior.prize,
          replayed: true,
        });
      } catch (err) { /* 기록이 깨졌으면 아래에서 새로 뽑습니다. */ }
    }
  }

  // 연타 방지는 캐시로 — 시트를 훑지 않아 응답이 빨라집니다.
  if (cache.get('cd_' + clientId)) {
    return json({ ok: false, error: 'rate_limited' });
  }
  cache.put('cd_' + clientId, '1', Math.ceil(DRAW_COOLDOWN_MILLISECONDS / 1000));

  var period = pickWeighted(PERIODS);
  var specials = rollSpecials(tools);
  var prize = buildPrize(tools, period.days, specials);
  var token = Utilities.getUuid();
  tokenSheet.appendRow([
    token,
    now,
    clientId,
    JSON.stringify(tools),
    String(period.days),
    JSON.stringify(specials),
    safeCellText(prize),
    '',
    safeCellText(requestId),
  ]);
  // 토큰 저장이 성공한 draw만 집계 (LockService 내부라 동시성 안전)
  incrementStarCount();
  // TV 별자리는 "선생님 한 분 = 별 하나" — 처음 보는 참가자일 때만 별을 켭니다.
  if (REAL_CLIENT_PATTERN.test(clientId) && !cache.get('seen_' + clientId)) {
    cache.put('seen_' + clientId, '1', 21600);   // 6시간(행사 하루) 동안 같은 분은 한 번만
    incrementParticipantCount();
  }
  // 재시도가 오면 시트를 뒤져 같은 결과를 돌려줄 수 있게 흔적을 남깁니다.
  if (requestId) cache.put('req_' + requestId, '1', 1800);
  // Mizou 링크를 받을 때 시트에서 토큰을 다시 찾지 않도록 필요한 값만 캐시에 둡니다.
  cache.put('tok_' + token, JSON.stringify({ days: period.days, tools: tools, at: now.getTime() }),
    Math.ceil(TOKEN_TTL_MILLISECONDS / 1000));

  return json({
    ok: true,
    token: token,
    days: period.days,
    specials: specials,
    prize: prize,
  });
}

function handleSubmit(p) {
  var token = String(p.token || '').trim();
  if (!TOKEN_PATTERN.test(token)) return json({ ok: false, error: 'invalid_token' });

  var tokenSheet = ensureTokenSheet();
  var record = findTokenRecord(tokenSheet, token);
  if (!record) return json({ ok: false, error: 'draw_expired' });
  if (record.consumedAt) return json({ ok: false, error: 'invalid_token' });

  var createdAt = record.createdAt instanceof Date ? record.createdAt : new Date(record.createdAt);
  if (!createdAt || isNaN(createdAt.getTime()) || Date.now() - createdAt.getTime() > TOKEN_TTL_MILLISECONDS) {
    consumeToken(tokenSheet, record.rowNumber);
    return json({ ok: false, error: 'draw_expired' });
  }

  var draw;
  try {
    draw = {
      tools: JSON.parse(record.toolsJson),
      days: Number(record.days),
      specials: JSON.parse(record.specialsJson),
      prize: record.prize,
    };
  } catch (err) {
    consumeToken(tokenSheet, record.rowNumber);
    return json({ ok: false, error: 'invalid_token' });
  }
  if (!isValidDrawRecord(draw)) {
    consumeToken(tokenSheet, record.rowNumber);
    return json({ ok: false, error: 'invalid_token' });
  }

  var name = readText(p.name, 80);
  var school = readText(p.school, 120);
  var email = normalizeEmail(p.email);
  var email2 = normalizeEmail(p.email2);
  var early = String(p.early || '').trim();

  if (!name) return json({ ok: false, error: 'invalid_name' });
  if (!school) return json({ ok: false, error: 'invalid_school' });
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    return json({ ok: false, error: 'invalid_email' });
  }
  if (email !== email2) return json({ ok: false, error: 'email_mismatch' });
  if (early !== '' && early !== '미리받기') return json({ ok: false, error: 'invalid_request' });

  var sheet = ensureSheet();
  if (hasEmail(sheet, email)) {
    consumeToken(tokenSheet, record.rowNumber);
    return json({ ok: false, dup: true });
  }

  // 토큰에 저장된 서버 결과만 사용하고, 입력 텍스트는 시트 수식으로 해석되지 않게 정리합니다.
  sheet.appendRow([
    new Date(),
    safeCellText(name),
    safeCellText(school),
    safeCellText(email),
    safeCellText(draw.tools.join(', ')),
    safeCellText(String(draw.days)),
    safeCellText(draw.specials.join(', ')),
    safeCellText(draw.prize),
    safeCellText(early),
  ]);

  // LockService 안에서 사용 시각을 기록해 같은 토큰의 재사용을 차단합니다.
  consumeToken(tokenSheet, record.rowNumber);
  return json({ ok: true });
}

// Mizou 1회용 링크 배부 — 토큰 하나당 링크 하나. 같은 토큰이 다시 오면 같은 링크를 돌려줍니다.
function handleClaimMizou(p) {
  var token = String(p.token || '').trim();
  if (!TOKEN_PATTERN.test(token)) return json({ ok: false, error: 'invalid_token' });

  var cache = CacheService.getScriptCache();
  var tierDays = 0;
  var tools = null;

  // 추첨 때 캐시에 넣어 둔 값이 있으면 시트를 읽지 않습니다(대부분 이 경로).
  var cachedToken = cache.get('tok_' + token);
  if (cachedToken) {
    try {
      var info = JSON.parse(cachedToken);
      if (Date.now() - Number(info.at) > TOKEN_TTL_MILLISECONDS) return json({ ok: false, error: 'draw_expired' });
      tierDays = Number(info.days);
      tools = info.tools;
    } catch (err) { cachedToken = null; }
  }

  if (!cachedToken) {
    var tokenSheet = ensureTokenSheet();
    var record = findTokenRecord(tokenSheet, token);
    if (!record) return json({ ok: false, error: 'draw_expired' });

    var createdAt = record.createdAt instanceof Date ? record.createdAt : new Date(record.createdAt);
    if (!createdAt || isNaN(createdAt.getTime()) || Date.now() - createdAt.getTime() > TOKEN_TTL_MILLISECONDS) {
      return json({ ok: false, error: 'draw_expired' });
    }
    tierDays = Number(record.days);
    try { tools = JSON.parse(record.toolsJson); } catch (err) { return json({ ok: false, error: 'invalid_token' }); }
  }

  // 등급은 서버가 정한 값만 사용합니다(브라우저 값 불신).
  var wantDays = MIZOU_DAYS_BY_TIER[tierDays];
  if (!wantDays) return json({ ok: false, error: 'invalid_token' });
  if (!tools || tools.indexOf('Mizou') < 0) return json({ ok: false, error: 'not_eligible' });

  // 같은 토큰이 다시 오면(새로고침 등) 재고를 더 쓰지 않고 같은 링크를 돌려줍니다.
  var cached = cache.get('mz_' + token);
  if (cached) return json({ ok: true, url: cached, days: wantDays });

  var sheet = ensureMizouSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return json({ ok: false, error: 'sold_out' });

  var found = takeMizouRow(sheet, lastRow, wantDays, token);
  if (!found) return json({ ok: false, error: 'sold_out' });

  cache.put('mz_' + token, found.url, Math.ceil(TOKEN_TTL_MILLISECONDS / 1000));
  return json({ ok: true, url: found.url, days: wantDays });
}

// 660행을 매번 훑지 않도록 기간별로 "다음에 볼 행" 위치를 기억해 두고 조금씩만 읽습니다.
var MIZOU_CHUNK = 60;

function takeMizouRow(sheet, lastRow, wantDays, token) {
  var props = PropertiesService.getScriptProperties();
  var pointerKey = 'mizouPtr_' + wantDays;
  var start = Number(props.getProperty(pointerKey));
  if (!isFinite(start) || start < 2) start = 2;

  for (var pass = 0; pass < 2; pass++) {          // 포인터부터 훑고, 없으면 처음부터 한 번 더
    var row = pass === 0 ? start : 2;
    while (row <= lastRow) {
      var height = Math.min(MIZOU_CHUNK, lastRow - row + 1);
      var chunk = sheet.getRange(row, 1, height, 3).getValues();
      for (var i = 0; i < chunk.length; i++) {
        if (Number(chunk[i][0]) !== wantDays || chunk[i][2]) continue;
        var rowNumber = row + i;
        sheet.getRange(rowNumber, 3, 1, 2).setValues([[new Date(), token]]);
        props.setProperty(pointerKey, String(rowNumber + 1));
        return { url: String(chunk[i][1]), rowNumber: rowNumber };
      }
      row += height;
    }
  }
  return null;
}

function ensureMizouSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(MIZOU_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(MIZOU_SHEET_NAME);
    sheet.appendRow(MIZOU_HEADERS);
    sheet.setFrozenRows(1);
  }
  if (sheet.getLastRow() === 0) sheet.appendRow(MIZOU_HEADERS);
  return sheet;
}

function parseTools(raw) {
  var values = String(raw || '').split(',').map(function (value) {
    return value.trim();
  }).filter(Boolean);

  if (values.length < 1 || values.length > MAX_TOOLS) return null;

  var seen = {};
  for (var i = 0; i < values.length; i++) {
    if (TOOL_IDS.indexOf(values[i]) < 0 || seen[values[i]]) return null;
    seen[values[i]] = true;
  }
  return TOOL_IDS.filter(function (id) { return seen[id]; });
}

function pickWeighted(items) {
  var total = items.reduce(function (sum, item) { return sum + item.weight; }, 0);
  var roll = randomUnit() * total;
  for (var i = 0; i < items.length; i++) {
    roll -= items[i].weight;
    if (roll < 0) return items[i];
  }
  return items[items.length - 1];
}

function rollSpecials(tools) {
  return SPECIALS.filter(function (special) {
    var eligible = special.always || tools.indexOf(special.requiresTool) >= 0;
    return eligible && randomUnit() < special.chance;
  }).map(function (special) { return special.full; });
}

// Apps Script에는 브라우저 crypto를 사용할 수 없으므로 UUID의 52비트 값을 추첨에 사용합니다.
function randomUnit() {
  var hex = Utilities.getUuid().replace(/-/g, '').slice(0, 13);
  return parseInt(hex, 16) / 4503599627370496;
}

function buildPrize(tools, days, specials) {
  var base = tools.join(' · ') + ' ' + days + '일 무료 체험';
  return specials.length ? base + ' + ' + specials.join(' + ') : base;
}

function ensureTokenSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TOKEN_SHEET_NAME);
  var created = false;
  if (!sheet) {
    sheet = ss.insertSheet(TOKEN_SHEET_NAME);
    created = true;
  }

  if (sheet.getLastRow() === 0) sheet.appendRow(TOKEN_SHEET_HEADERS);
  if (sheet.getFrozenRows() < 1) sheet.setFrozenRows(1);
  if (created) {
    try { sheet.hideSheet(); } catch (_) {}
  }
  return sheet;
}

function hasRecentDraw(sheet, clientId, now) {
  if (sheet.getLastRow() <= 1) return false;
  var startRow = Math.max(2, sheet.getLastRow() - TOKEN_SCAN_LIMIT + 1);
  var rows = sheet.getRange(startRow, 2, sheet.getLastRow() - startRow + 1, 2).getValues();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][1]) !== clientId) continue;
    var createdAt = rows[i][0] instanceof Date ? rows[i][0] : new Date(rows[i][0]);
    if (!createdAt || isNaN(createdAt.getTime())) continue;
    var age = now.getTime() - createdAt.getTime();
    return age >= 0 && age < DRAW_COOLDOWN_MILLISECONDS;
  }
  return false;
}

function findTokenRecord(sheet, token) {
  return findRecordBy(sheet, 0, token);
}

// 같은 요청이 재전송됐는지 확인용 (요청ID 열)
function findRequestRecord(sheet, requestId) {
  return findRecordBy(sheet, 8, requestId);
}

// 토큰은 30분이면 만료되므로 최근 행만 훑어도 충분합니다(행이 쌓여도 느려지지 않게).
var TOKEN_SCAN_LIMIT = 400;

function findRecordBy(sheet, columnIndex, value) {
  if (sheet.getLastRow() <= 1) return null;
  var startRow = Math.max(2, sheet.getLastRow() - TOKEN_SCAN_LIMIT + 1);
  var rows = sheet.getRange(startRow, 1, sheet.getLastRow() - startRow + 1, TOKEN_SHEET_HEADERS.length).getValues();
  var rowOffset = startRow;
  for (var i = rows.length - 1; i >= 0; i--) {
    if (!value || String(rows[i][columnIndex]) !== value) continue;
    return {
      rowNumber: i + rowOffset,
      token: String(rows[i][0]),
      createdAt: rows[i][1],
      clientId: String(rows[i][2]),
      toolsJson: String(rows[i][3]),
      days: rows[i][4],
      specialsJson: String(rows[i][5]),
      prize: String(rows[i][6]),
      consumedAt: rows[i][7],
      requestId: String(rows[i][8] || ''),
    };
  }
  return null;
}

function isValidDrawRecord(draw) {
  if (!Array.isArray(draw.tools) || !Array.isArray(draw.specials)) return false;

  var canonicalTools = parseTools(draw.tools.join(', '));
  if (!canonicalTools || JSON.stringify(canonicalTools) !== JSON.stringify(draw.tools)) return false;
  if (!PERIODS.some(function (period) { return period.days === draw.days; })) return false;

  var seen = {};
  for (var i = 0; i < draw.specials.length; i++) {
    var name = draw.specials[i];
    if (seen[name]) return false;
    seen[name] = true;
    var config = SPECIALS.filter(function (special) { return special.full === name; })[0];
    if (!config) return false;
    if (config.requiresTool && draw.tools.indexOf(config.requiresTool) < 0) return false;
  }

  return draw.prize === buildPrize(draw.tools, draw.days, draw.specials);
}

function consumeToken(sheet, rowNumber) {
  sheet.getRange(rowNumber, 8).setValue(new Date());
}

function ensureSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);

  if (sheet.getLastRow() === 0) sheet.appendRow(SHEET_HEADERS);
  if (sheet.getFrozenRows() < 1) sheet.setFrozenRows(1);
  return sheet;
}

function hasEmail(sheet, email) {
  if (sheet.getLastRow() <= 1) return false;
  var emails = sheet.getRange(2, 4, sheet.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < emails.length; i++) {
    if (normalizeEmail(emails[i][0]) === email) return true;
  }
  return false;
}

function normalizeEmail(value) {
  return String(value || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().toLowerCase();
}

function readText(value, maxLength) {
  var text = String(value || '').replace(/[\u0000-\u001F\u007F]/g, '').trim();
  return text && text.length <= maxLength ? text : '';
}

function safeCellText(value) {
  var text = String(value == null ? '' : value).replace(/[\u0000-\u001F\u007F]/g, '').trim();
  return /^\s*[=+\-@]/.test(text) ? "'" + text : text;
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// 상태 확인용 응답에는 배포 버전이나 내부 정보를 노출하지 않습니다.
// ?action=count 는 TV 별자리 화면용으로 접수 건수만 반환합니다(개인정보 없음).
function doGet(e) {
  var p = (e && e.parameter) || {};
  var action = String(p.action || '').trim();
  // TV 별자리용 — 참가한 선생님 수(중복 참여·테스트 제외)
  if (action === 'count') return json({ ok: true, count: getParticipantCount() });
  if (action === 'toolStats') return json(buildToolStats());   // 도구별 선택 인원(개인정보 없음)
  if (action === 'dailyStats') return json(buildDailyStats()); // 날짜별 참여·도구 인원
  if (action === 'stats') {
    var stats = buildStats();
    if (String(p.detail || '') === '1') addMizouPeopleStats(stats);  // 무거운 조인이라 요청할 때만
    return json(stats);
  }
  return ContentService.createTextOutput(API_MARKER);
}

var COUNTER_PROPERTY = 'starCount';

// TV 별자리 카운트 — 스크립트 속성에 두어 시트 왕복 없이 읽고 씁니다.
function countEntries() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(COUNTER_PROPERTY);
  if (raw === null) {                       // 예전에 쓰던 시트 값이 있으면 한 번만 옮겨옵니다.
    var migrated = readCounterSheetValue();
    props.setProperty(COUNTER_PROPERTY, String(migrated));
    return migrated;
  }
  var value = Number(raw);
  return isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function readCounterSheetValue() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(COUNTER_SHEET_NAME);
  if (!sheet) return 0;
  var value = Number(sheet.getRange(1, 2).getValue());
  return isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

// handleDraw의 LockService 안에서만 호출 — 동시 증가 유실 없음.
function incrementStarCount() {
  var next = countEntries() + 1;
  PropertiesService.getScriptProperties().setProperty(COUNTER_PROPERTY, String(next));
  return next;
}

var PARTICIPANT_PROPERTY = 'participantCount';

// 참가 선생님 수 — 처음 조회할 때만 시트에서 세고, 이후에는 속성값을 씁니다.
function getParticipantCount() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(PARTICIPANT_PROPERTY);
  if (raw === null) {
    var counted = countParticipantsFromSheet();
    props.setProperty(PARTICIPANT_PROPERTY, String(counted));
    return counted;
  }
  var value = Number(raw);
  return isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function incrementParticipantCount() {
  var next = getParticipantCount() + 1;
  PropertiesService.getScriptProperties().setProperty(PARTICIPANT_PROPERTY, String(next));
  return next;
}

// 날짜(한국시간)별 참여 인원과 도구별 인원 — 같은 분이 여러 번 돌려도 하루에 한 번만 센다.
function buildDailyStats() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TOKEN_SHEET_NAME);
  var out = { ok: true, days: {} };
  if (!sheet || sheet.getLastRow() <= 1) return out;

  var rows = sheet.getRange(2, 2, sheet.getLastRow() - 1, 3).getValues(); // 생성시각, 클라이언트ID, 툴JSON
  var byDay = {};

  for (var i = 0; i < rows.length; i++) {
    var when = rows[i][0] instanceof Date ? rows[i][0] : new Date(rows[i][0]);
    if (!when || isNaN(when.getTime())) continue;
    var cid = String(rows[i][1] || '');
    if (!REAL_CLIENT_PATTERN.test(cid)) continue;

    var day = Utilities.formatDate(when, 'Asia/Seoul', 'yyyy-MM-dd');
    if (!byDay[day]) {
      byDay[day] = { everyone: {}, tools: {} };
      TOOL_IDS.forEach(function (id) { byDay[day].tools[id] = {}; });
    }
    byDay[day].everyone[cid] = true;

    var tools;
    try { tools = JSON.parse(String(rows[i][2])); } catch (err) { continue; }
    if (!tools) continue;
    for (var t = 0; t < tools.length; t++) {
      if (byDay[day].tools[tools[t]]) byDay[day].tools[tools[t]][cid] = true;
    }
  }

  Object.keys(byDay).sort().forEach(function (day) {
    var entry = { participants: Object.keys(byDay[day].everyone).length, tools: {} };
    TOOL_IDS.forEach(function (id) { entry.tools[id] = Object.keys(byDay[day].tools[id]).length; });
    out.days[day] = entry;
  });
  return out;
}

// 도구별로 몇 분이 골랐는지 — 같은 분이 여러 번 돌려도 한 번만 센다.
function buildToolStats() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TOKEN_SHEET_NAME);
  var out = { ok: true, participants: 0, tools: {}, combos: {} };
  if (!sheet || sheet.getLastRow() <= 1) return out;

  var rows = sheet.getRange(2, 3, sheet.getLastRow() - 1, 2).getValues(); // 클라이언트ID, 툴JSON
  var seenByTool = {}, everyone = {}, comboSeen = {};
  TOOL_IDS.forEach(function (id) { seenByTool[id] = {}; });

  for (var i = 0; i < rows.length; i++) {
    var cid = String(rows[i][0] || '');
    if (!REAL_CLIENT_PATTERN.test(cid)) continue;
    everyone[cid] = true;
    var tools;
    try { tools = JSON.parse(String(rows[i][1])); } catch (err) { continue; }
    if (!tools || !tools.length) continue;
    for (var t = 0; t < tools.length; t++) {
      if (seenByTool[tools[t]]) seenByTool[tools[t]][cid] = true;
    }
    var key = tools.slice().sort().join('+');
    if (!comboSeen[key]) comboSeen[key] = {};
    comboSeen[key][cid] = true;
  }

  out.participants = Object.keys(everyone).length;
  TOOL_IDS.forEach(function (id) { out.tools[id] = Object.keys(seenByTool[id]).length; });
  Object.keys(comboSeen).forEach(function (k) { out.combos[k] = Object.keys(comboSeen[k]).length; });
  return out;
}

// Mizou는 /r/ 추적을 거치지 않으므로, 발급된 링크의 토큰을 참가자와 이어 사람 수를 셉니다.
// mizouOnly = 그 추첨에서 Mizou만 고른 분 → Snorkl·Redmenta 집계와 절대 겹치지 않는 인원.
function addMizouPeopleStats(stats) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var pool = ss.getSheetByName(MIZOU_SHEET_NAME);
  var tokens = ss.getSheetByName(TOKEN_SHEET_NAME);
  if (!pool || !tokens || pool.getLastRow() <= 1 || tokens.getLastRow() <= 1) return;

  var issued = {};
  var poolRows = pool.getRange(2, 3, pool.getLastRow() - 1, 2).getValues();  // 발급시각, 토큰
  for (var i = 0; i < poolRows.length; i++) {
    if (poolRows[i][0] && poolRows[i][1]) issued[String(poolRows[i][1])] = true;
  }

  var tokenRows = tokens.getRange(2, 1, tokens.getLastRow() - 1, 4).getValues(); // 토큰, 생성시각, 클라이언트ID, 툴JSON
  var people = {}, onlyMizou = {};
  for (var j = 0; j < tokenRows.length; j++) {
    var tk = String(tokenRows[j][0]);
    if (!issued[tk]) continue;
    var cid = String(tokenRows[j][2]);
    if (!REAL_CLIENT_PATTERN.test(cid)) continue;
    people[cid] = true;
    try {
      var tools = JSON.parse(String(tokenRows[j][3]));
      if (tools && tools.length === 1 && tools[0] === 'Mizou') onlyMizou[cid] = true;
    } catch (err) { /* 깨진 기록은 건너뜁니다 */ }
  }
  stats.mizouPeople = Object.keys(people).length;
  stats.mizouOnlyPeople = Object.keys(onlyMizou).length;
}

function countParticipantsFromSheet() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TOKEN_SHEET_NAME);
  if (!sheet || sheet.getLastRow() <= 1) return 0;
  var ids = sheet.getRange(2, 3, sheet.getLastRow() - 1, 1).getValues();
  var seen = {};
  for (var i = 0; i < ids.length; i++) {
    var id = String(ids[i][0] || '');
    if (id && REAL_CLIENT_PATTERN.test(id)) seen[id] = true;
  }
  return Object.keys(seen).length;
}

// 참가자 브라우저는 clientId를 UUID(또는 client-... 폴백)로 만듭니다.
// 개발 중 손으로 넣은 테스트 요청과 구분하는 기준입니다.
var REAL_CLIENT_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|client-)/i;

// 지금까지 나간 수량 — 추첨 수와 Mizou 링크 재고 현황.
function buildStats() {
  var stats = { ok: true, draws: countEntries(), mizouIssued: 0, mizouLeft: 0 };

  // 참가 선생님 수 — TV 별자리에 뜨는 값과 동일
  stats.participants = getParticipantCount();

  var tokenSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TOKEN_SHEET_NAME);
  if (tokenSheet && tokenSheet.getLastRow() > 1) {
    var ids = tokenSheet.getRange(2, 3, tokenSheet.getLastRow() - 1, 1).getValues();
    var test = 0;
    for (var k = 0; k < ids.length; k++) {
      var id = String(ids[k][0] || '');
      if (id && !REAL_CLIENT_PATTERN.test(id)) test++;
    }
    stats.participantDraws = ids.length - test;
    stats.testDraws = test;
  }
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MIZOU_SHEET_NAME);
  if (sheet && sheet.getLastRow() > 1) {
    var rows = sheet.getRange(2, 3, sheet.getLastRow() - 1, 1).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][0]) stats.mizouIssued++; else stats.mizouLeft++;
    }
  }
  return stats;
}

// Apps Script 편집기에서 실행할 수 있는 추첨 테스트입니다. 토큰 시트에 테스트 행이 추가됩니다.
function testDoPost() {
  var out = doPost({ parameter: {
    action: 'draw',
    tools: 'Snorkl, Mizou',
    clientId: 'test-client-1234567890',
    website: '',
  } });
  Logger.log(out.getContent());
}
