# Mizou 재고 보충 절차 (행사 중 부족 시)

## 1) 지금 재고 확인
```
https://adjoining-starling-529.convex.site/event/stats
```
`mizouAlert` 값으로 판단 — `ok`(150개 초과) / `low`(150 이하) / `critical`(50 이하)

## 2) 링크 추가 생성 (약 5분에 300개)
mizou.com에 로그인된 크롬에서 https://mizou.com/free-trial-form 을 연 뒤,
개발자도구 콘솔에 아래를 붙여넣는다. `TARGET`과 `DAYS`만 바꿔 쓰면 된다.

```js
(() => {
  const DAYS = 90;      // 60 또는 90
  const TARGET = 300;   // 만들 개수
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const current = () => {
    const m = document.body.innerText.match(/https:\/\/mizou\.com\/activate\?t=[A-Z0-9]+/);
    return m ? m[0] : null;
  };
  window.__L = { links: [], running: true };
  (async () => {
    const sel = document.querySelector('select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, String(DAYS));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(500);
    const btn = [...document.querySelectorAll('button')].find((b) => /generate/i.test(b.textContent));
    while (window.__L.links.length < TARGET && window.__L.running) {
      const before = current();
      btn.click();
      const t = Date.now();
      let now = before;
      while (Date.now() - t < 6000) { await sleep(150); now = current(); if (now && now !== before) break; }
      if (now && now !== before) window.__L.links.push(now);
      else await sleep(1200);
    }
    window.__L.running = false;
    // 콘솔에 JSON을 뿌린다 — 통째로 복사해서 아래 3)에 쓴다.
    console.log(JSON.stringify({ rows: window.__L.links.map((url) => ({ days: DAYS, url, issued: false })) }));
  })();
  return '생성 시작 — window.__L.links.length 로 진행 확인';
})();
```

진행 확인: 콘솔에 `window.__L.links.length` 입력

## 3) Convex에 넣기
콘솔에 찍힌 JSON을 파일로 저장한 뒤(예: `~/Downloads/topup.json`):

```bash
cd /Users/contenjoo/Desktop/04_개발_프로젝트/웹프로젝트/Project/Teameducator && npx convex run --prod eventStars:importMizouLinks "$(cat ~/Downloads/topup.json)"
```

같은 링크는 자동으로 건너뛰므로 두 번 넣어도 안전하다.

## 4) 확인
```
https://adjoining-starling-529.convex.site/event/stats
```
`mizouLeftByDays` 가 늘었는지 본다.

---

## 재고가 바닥나도 게임은 멈추지 않는다
- **다른 기간으로 자동 대체** — 90일이 없으면 60일로 지급하고, 카드에는 실제 받은 기간이 표시된다.
- **양쪽 다 소진되면** Mizou 카드만 "부스 직원에게 문의해 주세요"로 바뀐다.
  Snorkl·Redmenta는 재사용 링크라 영향이 없고, 게임·별자리는 정상 작동한다.
