/**
 * 에듀테크 체험권 이벤트 — 응모 저장용 Google Apps Script
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
 * 시트 열 구성: 접수시각 | 이름 | 학교 | 이메일 | 선택 툴 | 체험 개월 | 중복여부
 */

var SHEET_NAME = '응모';

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000); // 동시 제출 시 행 겹침 방지

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      sheet.appendRow(['접수시각', '이름', '학교', '이메일', '선택 툴', '체험 개월', '중복여부']);
      sheet.setFrozenRows(1);
    }

    var p = (e && e.parameter) || {};
    var email = String(p.email || '').trim().toLowerCase();

    // 같은 이메일 재응모 여부 표시 (저장은 하되 표시만 — 운영자가 판단)
    var dup = '';
    if (email && sheet.getLastRow() > 1) {
      var emails = sheet.getRange(2, 4, sheet.getLastRow() - 1, 1).getValues();
      for (var i = 0; i < emails.length; i++) {
        if (String(emails[i][0]).trim().toLowerCase() === email) { dup = '중복'; break; }
      }
    }

    sheet.appendRow([
      new Date(),
      String(p.name || '').trim(),
      String(p.school || '').trim(),
      email,
      String(p.tool || '').trim(),
      String(p.months || '').trim(),
      dup,
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

// 배포 확인용: 웹 앱 URL을 브라우저로 열면 "OK" 표시
function doGet() {
  return ContentService.createTextOutput('OK — 에듀테크 응모 엔드포인트 동작 중');
}

// 편집기 테스트용: doPost를 직접 실행하지 말고 이 함수를 ▶ 실행하세요.
// 시트에 테스트 행이 하나 추가되면 정상.
function testDoPost() {
  var fake = { parameter: { name: '테스트', school: '테스트초', email: 'test@example.com', tool: 'Snorkl', months: '3' } };
  var out = doPost(fake);
  Logger.log(out.getContent());
}
