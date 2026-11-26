/**
 * 야심한 남자 페이지 백엔드 (Google Apps Script + 솔라피)
 *
 * 처리하는 요청 (index.html, free.html 공용)
 *  - sendCode   : 휴대폰 인증번호 문자 발송 (5분 유효, 번호당 10분에 5회 제한)
 *  - verifyCode : 인증번호 확인 → 30분짜리 토큰 발급
 *  - lead       : 신청 저장 ('신청자' 시트) + E-BOOK 발송 (휴대폰이면 알림톡, 이메일이면 메일)
 *  - booking    : 상담 희망 시간 저장 ('상담예약' 시트)
 *  - event      : 페이지 조회·버튼 클릭 기록 ('이벤트' 시트)
 *
 * 설치
 *  1) 구글 시트 > 확장 프로그램 > Apps Script 에 이 파일 붙여넣기
 *  2) 프로젝트 설정 > 스크립트 속성에 아래 값 저장 (코드에 직접 쓰지 말 것)
 *       SOLAPI_KEY, SOLAPI_SECRET  : 솔라피 API 키
 *       SMS_FROM                   : 솔라피에 등록한 발신번호 (예: 01012345678)
 *       KAKAO_PFID                 : 솔라피에 연동한 카카오 채널 pfId
 *       KAKAO_TEMPLATE_ID          : 승인된 알림톡 템플릿 ID
 *       FREE_PDF_URL               : E-BOOK 링크
 *     솔라피 값이 비어 있으면 '테스트 모드': 인증번호는 000000, 실제 발송 없이 시트에만 기록
 *  3) 배포 > 새 배포 > 웹 앱 (실행: 나 / 액세스: 모든 사용자) → /exec 주소를 두 html 의 ENDPOINT 에 넣기
 */

/* ===== 여기만 바꾸면 됨 ===== */
const SHEET_ID = "1dtGdwYJra7Psu5XZaN1ChAnh8eX8mZ6ndwuiE5hU95M";       // 신청 DB 시트
const FREE_PDF_URL_DEFAULT = "https://drive.google.com/";             // 무료 E-BOOK 링크 (받으면 교체)
const FASTTRACK_URL = "https://www.payapp.kr/L/z4oQj1";
const COUPON_DAYS = 14;         // 신청일부터 쿠폰 유효 기간(일)
const COUPON_PRICE = "";        // 예: "79,000원"  (비어 있으면 쿠폰 숨김)
const COUPON_URL = "";          // 할인가 페이앱 결제 링크 (비어 있으면 쿠폰 숨김)
const MY_PAGE = "https://gydnjs6580-boop.github.io/yanam/my.html";

const P = PropertiesService.getScriptProperties();
const prop = k => P.getProperty(k) || (k === "FREE_PDF_URL" ? FREE_PDF_URL_DEFAULT : "");
const TEST = () => !prop("SOLAPI_KEY");

function sheet_(name, headers) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(headers); sh.setFrozenRows(1); }
  return sh;
}
const LEADS = () => sheet_("신청자", ["신청시각", "이름", "휴대폰", "이메일", "개인정보동의", "마케팅동의", "유입(src)", "방문자ID", "발송결과", "ID", "진단"]);
const BOOK = () => sheet_("상담예약", ["신청시각", "이름", "휴대폰", "1순위", "2순위", "3순위", "고민", "유입(src)", "처리상태"]);
const EVENTS = () => sheet_("이벤트", ["시각", "종류", "대상", "유입(src)", "방문자ID", "브라우저"]);

const out = o => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
const s = (v, n) => String(v == null ? "" : v).slice(0, n);
const phoneOk = p => /^01[016789]\d{7,8}$/.test(p);
const txt = p => p ? "'" + p : ""; // 시트에서 앞자리 0 유지

function doPost(e) {
  let d; try { d = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: "bad json" }); }
  const cache = CacheService.getScriptCache();
  const now = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd HH:mm:ss");

  switch (d.kind) {
    case "event":
      EVENTS().appendRow([now, s(d.type, 20), s(d.target, 40), s(d.src, 60), s(d.vid, 20), s(d.ua, 120)]);
      return out({ ok: true });

    case "sendCode": {
      const p = s(d.phone, 11);
      if (!phoneOk(p)) return out({ ok: false, error: "휴대전화 번호를 확인해 주세요." });
      const cntKey = "cnt_" + p, cnt = +(cache.get(cntKey) || 0);
      if (cnt >= 5) return out({ ok: false, error: "잠시 후 다시 시도해 주세요. (10분 제한)" });
      cache.put(cntKey, String(cnt + 1), 600);
      const code = TEST() ? "000000" : String(Math.floor(100000 + Math.random() * 900000));
      cache.put("code_" + p, code, 300);
      if (!TEST()) {
        const r = solapi_({ to: p, from: prop("SMS_FROM"), text: "[야심한 남자] 인증번호 " + code + " (5분 안에 입력해 주세요)" });
        if (!r.ok) return out({ ok: false, error: "문자 발송에 실패했습니다." });
      }
      return out({ ok: true });
    }

    case "verifyCode": {
      const p = s(d.phone, 11), c = s(d.code, 6);
      const saved = cache.get("code_" + p);
      if (!saved || saved !== c) return out({ ok: false, error: "인증번호가 맞지 않습니다." });
      cache.remove("code_" + p);
      const token = Utilities.getUuid();
      cache.put("tok_" + token, p, 1800);
      return out({ ok: true, token });
    }

    case "lead": {
      const name = s(d.name, 20).trim();
      const email = s(d.email, 100).trim().toLowerCase();
      let phone = "";
      if (d.token) { // 휴대폰 인증 신청 (free.html)
        phone = cache.get("tok_" + d.token) || "";
        if (!phone || phone !== s(d.phone, 11)) return out({ ok: false, error: "휴대전화 인증을 다시 해 주세요." });
      } else if (d.phone && TEST()) { // 문자 인증 없이 (솔라피 연결 전)
        phone = s(d.phone, 11);
        if (!phoneOk(phone)) return out({ ok: false, error: "휴대전화 번호를 확인해 주세요." });
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        return out({ ok: false, error: "invalid" });
      }
      if (!d.agreePrivacy) return out({ ok: false, error: "필수 동의가 필요합니다." });

      const lock = LockService.getScriptLock(); lock.waitLock(20000);
      try {
        const sh = LEADS(), last = sh.getLastRow();
        const rows = last > 1 ? sh.getRange(2, 1, last - 1, 10).getValues() : [];
        const hit = rows.find(r => (phone && String(r[2]).replace(/'/g, "") === phone) || (email && String(r[3]) === email));
        const dup = !!hit;
        const id = hit && hit[9] ? String(hit[9]) : Utilities.getUuid().slice(0, 12);
        let result = "중복(재발송 안 함)";
        if (!dup) {
          const res = [];
          if (phone) res.push(sendKakao_(phone, name));
          if (email) res.push(sendMail_(email, name, id));
          result = res.join(" / ");
        }
        sh.appendRow([now, name, txt(phone), email, "Y", d.agreeMarketing ? "Y" : "N", s(d.src, 60), s(d.vid, 20), result, id, s(d.quiz, 800)]);
        const token = Utilities.getUuid();
        if (phone) cache.put("tok_" + token, phone, 1800);
        return out({ ok: true, dup, token, id, my: MY_PAGE + "?id=" + id, pdf: prop("FREE_PDF_URL"), fasttrack: FASTTRACK_URL });
      } finally { lock.releaseLock(); }
    }

    case "booking": {
      let phone = d.token ? (cache.get("tok_" + d.token) || "") : "";
      if (!phone && d.id) { // 전용 페이지에서 예약
        const sh = LEADS(), last = sh.getLastRow();
        const r = (last > 1 ? sh.getRange(2, 1, last - 1, 10).getValues() : []).find(x => String(x[9]) === String(d.id));
        if (r) { phone = String(r[2]).replace(/'/g, ""); if (!d.name) d.name = r[1]; }
      }
      if (!phone) return out({ ok: false, error: "세션이 만료되었습니다." });
      const sl = (Array.isArray(d.slots) ? d.slots : []).slice(0, 3).map(x => s(x, 30));
      BOOK().appendRow([now, s(d.name, 20), txt(phone), sl[0] || "", sl[1] || "", sl[2] || "", s(d.memo, 300), s(d.src, 60), "대기"]);
      return out({ ok: true });
    }
  }
  return out({ ok: false, error: "unknown kind" });
}

/* ===== 발송 ===== */
function sendKakao_(phone, name) {
  if (TEST()) return "카톡 미연결";
  const msg = {
    to: phone, from: prop("SMS_FROM"),
    kakaoOptions: { pfId: prop("KAKAO_PFID"), templateId: prop("KAKAO_TEMPLATE_ID"), variables: { "#{이름}": name || "고객", "#{링크}": prop("FREE_PDF_URL") } },
  };
  const r = solapi_(msg);
  return r.ok ? "알림톡 발송" : "알림톡 실패: " + r.error;
}

function sendMail_(email, name, id) {
  try {
    const html = "<div style='font-family:sans-serif;max-width:520px;line-height:1.7;color:#222'>" +
      "<p>" + (name ? name + "님, " : "") + "안녕하세요, 야심한 남자입니다.</p><p>신청하신 무료 E-BOOK을 보내드립니다.</p>" +
      "<p><a href='" + MY_PAGE + "?id=" + id + "' style='display:inline-block;background:#d9b15f;color:#1a1407;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold'>내 E-BOOK 페이지 열기</a></p>" +
      "<p style='font-size:13px;color:#666'>신청일부터 " + COUPON_DAYS + "일 동안 페이지에서 E-BOOK과 혜택을 확인할 수 있어요.</p>" +
      "<p>읽어보고 혼자서 더 빠르게 바꾸고 싶다면 실전 가이드 <a href='" + FASTTRACK_URL + "'>패스트트랙</a>도 준비되어 있습니다.</p><hr style='border:none;border-top:1px solid #eee'><p style='font-size:12px;color:#888'>무료 E-BOOK 신청에 따라 발송된 메일입니다. <a style='color:#888' href='" + ScriptApp.getService().getUrl() + "?unsub=" + encodeURIComponent(email) + "'>수신 거부</a></p></div>";
    MailApp.sendEmail({ to: email, subject: "[야심한 남자] 신청하신 무료 E-BOOK 보내드립니다", htmlBody: html, name: "야심한 남자" });
    return "메일 발송";
  } catch (err) { return "메일 실패: " + err.message; }
}

/* 솔라피 API (HMAC-SHA256 인증) */
function solapi_(message) {
  const date = new Date().toISOString();
  const salt = Utilities.getUuid().replace(/-/g, "");
  const sig = Utilities.computeHmacSha256Signature(date + salt, prop("SOLAPI_SECRET"))
    .map(b => ("0" + (b & 0xff).toString(16)).slice(-2)).join("");
  const res = UrlFetchApp.fetch("https://api.solapi.com/messages/v4/send", {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    headers: { Authorization: "HMAC-SHA256 apiKey=" + prop("SOLAPI_KEY") + ", date=" + date + ", salt=" + salt + ", signature=" + sig },
    payload: JSON.stringify({ message }),
  });
  const code = res.getResponseCode();
  return code < 300 ? { ok: true } : { ok: false, error: code + " " + res.getContentText().slice(0, 150) };
}

/* 알림톡 템플릿 예시 (솔라피에서 등록, 카카오 심사용)
 * #{이름}님, 야심한 남자 무료 E-BOOK 신청이 완료되었습니다.
 * 신청하신 E-BOOK은 아래 버튼에서 확인하실 수 있습니다.
 * [버튼: E-BOOK 보기 → #{링크}]
 * ※ 이 메시지는 고객님이 홈페이지에서 무료 E-BOOK을 신청하여 발송되었습니다.
 */


/* GET: ?my=ID → 신청자 전용 페이지 데이터 / ?unsub=이메일 → 마케팅 수신 거부 */
function doGet(e) {
  const q = e.parameter || {};
  if (q.my) return myPage_(String(q.my));
  if (q.unsub) {
    const email = String(q.unsub).trim().toLowerCase();
    const sh = LEADS(), last = sh.getLastRow();
    if (last > 1) sh.getRange(2, 4, last - 1, 1).getValues().forEach((r, i) => {
      if (String(r[0]) === email) sh.getRange(i + 2, 6).setValue("N(거부 " + Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd") + ")");
    });
    return HtmlService.createHtmlOutput("<meta name='viewport' content='width=device-width'><p style='font-family:sans-serif;padding:24px'>수신 거부 처리되었습니다.</p>");
  }
  return out({ ok: true });
}

function myPage_(id) {
  const sh = LEADS(), last = sh.getLastRow();
  const rows = last > 1 ? sh.getRange(2, 1, last - 1, 11).getValues() : [];
  const r = rows.find(x => String(x[9]) === id);
  const q = rows.filter(x => String(x[9]) === id && x[10]).map(x => String(x[10])).pop() || ""; // 가장 최근 진단
  if (!r) return out({ ok: false, error: "not found" });
  const t = r[0] instanceof Date ? r[0].getTime() : new Date(String(r[0]).replace(" ", "T") + "+09:00").getTime();
  return out({
    ok: true, name: String(r[1]), created: t, diag: q.split(" | ")[0].replace(/^유형:\s*/, ""), deadline: t + COUPON_DAYS * 864e5,
    pdf: prop("FREE_PDF_URL"), fasttrack: FASTTRACK_URL,
    coupon: COUPON_URL && COUPON_PRICE ? { url: COUPON_URL, price: COUPON_PRICE } : null,
  });
}
