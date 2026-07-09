/**
 * 2026 쉐어워즈 (with 오늘배움) — 응모 저장용 Google Apps Script
 *
 * 설정 방법:
 * 1. https://sheets.new 에서 새 스프레드시트 생성 (이름 예: "에듀테크 체험 응모")
 * 2. 메뉴 [확장 프로그램] → [Apps Script] 열기
 * 3. 이 파일 내용 전체를 붙여넣고 저장
 * 4. [배포] → [새 배포] → 유형 "웹 앱" 선택
 *    - 실행 계정: 나
 *    - 액세스 권한: "모든 사용자" (익명 POST 허용에 필요)
 * 5. 배포 후 나오는 웹 앱 URL을 복사해서
 *    scratch.html 의 SHEET_ENDPOINT 상수에 붙여넣기
 *
 * 시트 열 구성: 접수시각 | 이름 | 학교 | 이메일 | 선택 툴 | 체험 기간(일) | 특별상 보너스 | 당첨 경품 | 미리받기
 *
 * 중복 참여 차단: 같은 이메일이 이미 있으면 저장하지 않고 { ok:false, dup:true } 반환.
 */

var SHEET_NAME = '응모';
var VERSION = 'bonus-v5'; // 배포 확인용 — GET 하면 이 값이 보임

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000); // 동시 제출 시 행 겹침·중복 통과 방지

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      sheet.appendRow(['접수시각', '이름', '학교', '이메일', '선택 툴', '체험 기간(일)', '특별상 보너스', '당첨 경품', '미리받기']);
      sheet.setFrozenRows(1);
    }

    var p = (e && e.parameter) || {};
    var email = String(p.email || '').trim().toLowerCase();

    // 같은 이메일 재응모 차단 — 이미 있으면 저장 없이 거부
    if (email && sheet.getLastRow() > 1) {
      var emails = sheet.getRange(2, 4, sheet.getLastRow() - 1, 1).getValues();
      for (var i = 0; i < emails.length; i++) {
        if (String(emails[i][0]).trim().toLowerCase() === email) {
          return json({ ok: false, dup: true });
        }
      }
    }

    sheet.appendRow([
      new Date(),
      String(p.name || '').trim(),
      String(p.school || '').trim(),
      email,
      String(p.tools || '').trim(),
      String(p.days || '').trim(),
      String(p.special || '').trim(),
      String(p.prize || '').trim(),
      String(p.early || '').trim(),
    ]);

    return json({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// 배포 확인용: 웹 앱 URL을 브라우저로 열면 현재 배포 버전이 보임
function doGet() {
  return ContentService.createTextOutput('OK — 응모 엔드포인트 동작 중 (' + VERSION + ')');
}

// 편집기 테스트용: doPost를 직접 실행하지 말고 이 함수를 ▶ 실행하세요.
// 시트에 테스트 행이 하나 추가되면 정상.
function testDoPost() {
  var fake = { parameter: { name: '테스트', school: '테스트초', email: 'test@example.com', tools: 'Snorkl, Mizou', days: '60', special: '주이즈 1년 이용권', prize: 'Snorkl · Mizou 60일 무료 체험 + 주이즈 1년 이용권', early: '미리받기' } };
  var out = doPost(fake);
  Logger.log(out.getContent());
}
