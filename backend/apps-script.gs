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
 *       SMS_RELAY                  : AWS 고정 IP 중계 서버 주소 (예: https://3.35.1.2) — relay/ 폴더 참고
 *     솔라피 값이 비어 있으면 '테스트 모드': 인증번호는 000000, 실제 발송 없이 시트에만 기록
 *  3) 배포 > 새 배포 > 웹 앱 (실행: 나 / 액세스: 모든 사용자) → /exec 주소를 두 html 의 ENDPOINT 에 넣기
 */

/* ===== 여기만 바꾸면 됨 ===== */
const SHEET_ID = "1dtGdwYJra7Psu5XZaN1ChAnh8eX8mZ6ndwuiE5hU95M";       // 신청 DB 시트
const FREE_PDF_URL_DEFAULT = "https://gydnjs6580-boop.github.io/yanam/ebook.html"; // 무료 E-BOOK(웹 원고)
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
const PAYS = () => sheet_("결제", ["통보시각", "결제번호", "상태", "상품", "금액", "휴대폰", "결제수단", "결제일시", "검증", "권한 이메일", "권한 시각"]);
const EVENTS = () => sheet_("이벤트", ["시각", "종류", "대상", "유입(src)", "방문자ID", "브라우저"]);

const out = o => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
const s = (v, n) => String(v == null ? "" : v).slice(0, n);
const phoneOk = p => /^01[016789]\d{7,8}$/.test(p);
const txt = p => p ? "'" + p : ""; // 시트에서 앞자리 0 유지

function doPost(e) {
  // 페이앱 결제 통보(공통 통보 URL)는 JSON이 아니라 form POST로 온다
  if (e.parameter && e.parameter.mul_no && e.parameter.linkval !== undefined) return payappFeedback_(e.parameter);
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
      const vKey = "vsms_" + s(d.vid, 20), vCnt = +(cache.get(vKey) || 0); // 같은 브라우저는 6시간에 3번
      if (d.vid && vCnt >= 3) return out({ ok: false, error: "인증 요청이 너무 많아요. 잠시 후 다시 시도해 주세요." });
      cache.put(cntKey, String(cnt + 1), 600); if (d.vid) cache.put(vKey, String(vCnt + 1), 21600);
      const code = TEST() ? "000000" : String(Math.floor(100000 + Math.random() * 900000));
      cache.put("code_" + p, code, 300);
      if (!TEST()) {
        const r = solapi_({ to: p, from: prop("SMS_FROM"), text: "[야심한 남자] 인증번호 " + code + " (5분 안에 입력해 주세요)" });
        if (r.quota) return out({ ok: false, skip: true }); // 오늘 상한 도달 → 인증 없이 신청만
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
      } else if (d.phone) { // 문자 인증 없이 신청 (free.html SMS_VERIFY=false)
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

    case "ftClaim": return ftClaim_(d, cache);
    case "demoAuth": return demoAuth_(d);
    case "ftStart": case "ftCode": case "ftMailCode": case "ftForgot": case "ftOpen": case "ftPos": return ftReader_(d, cache);

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
  if (TEST() || !prop("KAKAO_PFID")) return "카톡 미연결";
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
      "<p style='font-size:13px;color:#666'>이 메일을 보관해 두면 언제든 다시 읽을 수 있어요.</p>" +
      "<p>읽어보고 혼자서 더 빠르게 바꾸고 싶다면 실전 가이드 <a href='" + FASTTRACK_URL + "'>패스트트랙</a>도 준비되어 있습니다.</p><hr style='border:none;border-top:1px solid #eee'><p style='font-size:12px;color:#888'>무료 E-BOOK 신청에 따라 발송된 메일입니다. <a style='color:#888' href='" + ScriptApp.getService().getUrl() + "?unsub=" + encodeURIComponent(email) + "'>수신 거부</a></p></div>";
    MailApp.sendEmail({ to: email, subject: "[야심한 남자] 신청하신 무료 E-BOOK 보내드립니다", htmlBody: html, name: "야심한 남자" });
    return "메일 발송";
  } catch (err) { return "메일 실패: " + err.message; }
}

/* 솔라피 API (HMAC-SHA256 인증) */
// 문자 폭탄(번호 바꿔 가며 인증 요청) 대비: 하루 총 발송 상한. 넘으면 보내지 않고 효원님께 메일 1통
function smsQuota_() {
  const max = +(prop("SMS_DAILY_MAX") || 300), k = "sms_" + Utilities.formatDate(new Date(), "Asia/Seoul", "yyyyMMdd");
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const n = +(P.getProperty(k) || 0);
    if (n >= max) {
      if (!P.getProperty(k + "_mail")) { P.setProperty(k + "_mail", "1");
        try { MailApp.sendEmail(Session.getEffectiveUser().getEmail(), "[야심한 남자] 오늘 문자 상한(" + max + "건) 도달",
          "오늘 문자 인증 발송이 상한에 닿았어요. 오늘은 문자 인증 없이 신청만 받습니다.\n평소보다 많다면 누가 일부러 반복 요청하는 것일 수 있어요. 신청자 시트를 확인해 주세요.\n상한은 스크립트 속성 SMS_DAILY_MAX 로 바꿀 수 있어요."); } catch (e) {} }
      return false;
    }
    P.setProperty(k, String(n + 1)); return true;
  } finally { lock.releaseLock(); }
}

function solapi_(message) {
  if (!smsQuota_()) return { ok: false, quota: true, error: "daily cap" };
  const date = new Date().toISOString();
  const salt = Utilities.getUuid().replace(/-/g, "");
  const sig = Utilities.computeHmacSha256Signature(date + salt, prop("SOLAPI_SECRET"))
    .map(b => ("0" + (b & 0xff).toString(16)).slice(-2)).join("");
  // 솔라피는 고정 IP에서 온 요청만 받으므로 AWS 중계 서버(SMS_RELAY, 예: https://1.2.3.4)를 거친다. 키는 중계 서버에 두지 않음
  const relay = prop("SMS_RELAY").replace(/\/$/, "");
  const res = UrlFetchApp.fetch((relay || "https://api.solapi.com") + "/messages/v4/send", {
    method: "post", contentType: "application/json", muteHttpExceptions: true, validateHttpsCertificates: !relay,
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
  if (q.demo) return demoGet_(q);
  if (q.pos) { // 무료 E-BOOK 이어 읽기: 이 사람의 마지막 읽은 위치(이벤트 시트 'pos' 기록 중 최신)
    const id = String(q.pos).slice(0, 20), sh = EVENTS(), last = sh.getLastRow(), n = Math.min(last - 1, 5000);
    if (n > 0) { const v = sh.getRange(last - n + 1, 2, n, 4).getValues();
      for (let i = v.length - 1; i >= 0; i--) if (v[i][0] === "pos" && String(v[i][3]) === id) return out({ ok: true, pos: String(v[i][1]) }); }
    return out({ ok: false });
  }
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


/* ===== 패스트트랙 구매자 전용 열람 =====
 * 1) 페이앱 '설정 > 연동정보 > 공통 통보 URL'에 이 웹앱 /exec 주소를 넣으면 결제 때마다 '결제' 시트에 기록
 * 2) 구매자가 ft.html 에서 결제 휴대폰 번호 + 구글 이메일 입력 → 결제 확인되면 그 이메일에만 폴더 보기 권한
 * 스크립트 속성 PAYAPP_LINKVAL = 페이앱 '연동 VALUE' (효원님이 직접 입력, 코드에 쓰지 않음)
 */
const PAYAPP_USERID = "yerpgigi";
const FT_FOLDER_ID = "1iIKSR3tUUK9A1G5FTA2QmiynKj-WPu4t"; // 드라이브 "패스트트랙 (구매자용)"
const FT_MATCH = /패스트/; // 결제 상품명에 이 글자가 있으면 패스트트랙

function payappFeedback_(p) {
  const ok = !!prop("PAYAPP_LINKVAL") && p.linkval === prop("PAYAPP_LINKVAL") && p.userid === PAYAPP_USERID;
  const now = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd HH:mm:ss");
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const sh = PAYS(), last = sh.getLastRow();
    const nos = last > 1 ? sh.getRange(2, 2, last - 1, 1).getValues().map(r => String(r[0])) : [];
    const i = nos.indexOf(String(p.mul_no));
    const row = [now, String(p.mul_no), String(p.pay_state), s(p.goodname, 60), Number(p.price) || 0, txt(s(p.recvphone, 11).replace(/[^0-9]/g, "")), String(p.pay_type || ""), s(p.pay_date, 20), ok ? "Y" : "N"];
    if (i < 0) sh.appendRow(row.concat(["", ""]));
    if (ok && String(p.pay_state) === "4" && FT_MATCH.test(String(p.goodname)) && (i < 0 || !String(sh.getRange(i + 2, 10).getValue()))) {
      const ph = s(p.recvphone, 11).replace(/[^0-9]/g, ""), r = i < 0 ? sh.getLastRow() : i + 2;
      if (phoneOk(ph) && !TEST()) { const m = solapi_({ to: ph, from: prop("SMS_FROM"), text: "[야심한남자] 패스트트랙 구매 감사합니다.\n\n바로 읽기: " + FT_READ_URL + "\n\n이 문자를 보관해 두면 언제든 이어서 읽을 수 있어요." }); sh.getRange(r, 10).setValue(m.ok ? "읽기 문자 발송" : "문자 실패"); }
    }
    else sh.getRange(i + 2, 1, 1, 9).setValues([row]); // 상태 갱신(결제완료·취소), 권한 칸은 유지
  } finally { lock.releaseLock(); }
  return ContentService.createTextOutput("SUCCESS");
}

function ftClaim_(d, cache) {
  const phone = s(d.phone, 11).replace(/[^0-9]/g, "");
  const email = s(d.email, 100).trim().toLowerCase();
  if (!phoneOk(phone)) return out({ ok: false, error: "결제하신 휴대전화 번호를 확인해 주세요." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return out({ ok: false, error: "이메일 주소를 확인해 주세요." });
  const key = "claim_" + phone, n = +(cache.get(key) || 0);
  if (n >= 5) return out({ ok: false, error: "잠시 후 다시 시도해 주세요. (10분 제한)" });
  cache.put(key, String(n + 1), 600);

  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const sh = PAYS(), last = sh.getLastRow();
    const rows = last > 1 ? sh.getRange(2, 1, last - 1, 11).getValues() : [];
    const paid = rows.map((r, i) => ({ r, i })).filter(x => String(x.r[5]).replace(/'/g, "") === phone && String(x.r[2]) === "4" && x.r[8] === "Y" && FT_MATCH.test(String(x.r[3])));
    if (!paid.length) return out({ ok: false, error: "이 번호로 확인된 패스트트랙 결제가 없어요. 결제 직후라면 1~2분 뒤 다시 시도해 주세요." });
    const free = paid.find(x => !x.r[9]) || paid.find(x => String(x.r[9]).toLowerCase() === email);
    if (!free) return out({ ok: false, error: "이 결제는 이미 다른 이메일로 등록됐어요. 바꾸려면 카페로 문의해 주세요." });
    try { DriveApp.getFolderById(FT_FOLDER_ID).addViewer(email); }
    catch (err) { return out({ ok: false, error: "구글 계정 이메일(gmail 등)만 등록할 수 있어요." }); }
    sh.getRange(free.i + 2, 10, 1, 2).setValues([[email, Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd HH:mm:ss")]]);
    const url = "https://drive.google.com/drive/folders/" + FT_FOLDER_ID;
    try {
      MailApp.sendEmail({ to: email, name: "야심한 남자", subject: "[야심한 남자] 패스트트랙 열람 안내",
        body: "패스트트랙을 구매해 주셔서 감사합니다.\n\n아래 링크는 이 구글 계정(" + email + ")으로 로그인했을 때만 열립니다.\n\n패스트트랙 1·2부 열기:\n" + url + "\n\n링크를 다른 사람에게 보내도 열리지 않습니다.",
        htmlBody: "<div style='font-family:sans-serif;line-height:1.7'><p>패스트트랙을 구매해 주셔서 감사합니다.</p><p>아래 링크는 <b>이 구글 계정(" + email + ")으로 로그인했을 때만</b> 열립니다.</p><p><a href='" + url + "'><b>▶ 패스트트랙 1·2부 열기</b></a></p><p>위 링크가 안 눌리면 이 주소를 누르세요:<br><a href='" + url + "'>" + url + "</a></p><p style='color:#888;font-size:12px'>링크를 다른 사람에게 보내도 열리지 않습니다.</p></div>" });
    } catch (err) {}
    return out({ ok: true, url });
  } finally { lock.releaseLock(); }
}

/* 한 번만 편집기에서 실행: 폴더·파일을 '링크 있는 누구나'에서 '제한됨'으로, 뷰어 다운로드 막기 */
function lockFastTrack() {
  const f = DriveApp.getFolderById(FT_FOLDER_ID);
  f.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  const it = f.getFiles();
  while (it.hasNext()) { const x = it.next(); x.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE); x.setShareableByEditors(false); Logger.log("잠금: " + x.getName()); }
}

/** 한 번만 실행: 드라이브 권한 승인용(아무것도 바꾸지 않고 폴더 이름만 읽음) */
function authorizeDrive() {
  Logger.log("폴더 확인: " + DriveApp.getFolderById(FT_FOLDER_ID).getName());
  Logger.log("PAYAPP_LINKVAL 설정됨: " + !!prop("PAYAPP_LINKVAL"));
}

/* ===== 패스트트랙 전달 방식 데모(효원 테스트용) — 실제 판매 흐름과 무관 =====
 * 샘플: 1부 앞 10쪽(구매자 표시 새김) — 드라이브 '패스트트랙 전달 방식 데모' 폴더(공유 안 함)
 * 열쇠: 스크립트 속성 DEMO_KEY (setupDemo() 한 번 실행하면 만들어지고 실행 로그에 나옴). 없으면 데모 꺼짐.
 */
const DEMO_FOLDER_ID = "1Ax9L88BN5WK6SX-JF5ou1JwWJAmipYXn", DEMO_PHONE = "01000001234", DEMO_PAGES = 10;
function setupDemo() {
  let k = prop("DEMO_KEY");
  if (!k) { k = Utilities.getUuid().replace(/-/g, "").slice(0, 16); P.setProperty("DEMO_KEY", k); }
  Logger.log("DEMO_KEY: " + k + " / 폴더: " + DriveApp.getFolderById(DEMO_FOLDER_ID).getName());
}
function demoFile_(name) { const it = DriveApp.getFolderById(DEMO_FOLDER_ID).getFilesByName(name); return it.hasNext() ? it.next() : null; }
function demoGet_(q) {
  const key = prop("DEMO_KEY"), cache = CacheService.getScriptCache();
  if (!key) return out({ ok: false, error: "데모가 아직 켜지지 않았어요." });
  if (q.demo === "pdf") {
    if (q.k !== key) return out({ ok: false, error: "데모 링크가 올바르지 않아요." });
    const f = demoFile_("demo_wm.pdf");
    return out({ ok: true, name: "패스트트랙_1부_샘플(구매자표시).pdf", b64: Utilities.base64Encode(f.getBlob().getBytes()) });
  }
  if (q.demo === "page") {
    if (!q.t || cache.get("demo_t_" + q.t) !== "1") return out({ ok: false, error: "다시 인증해 주세요." });
    const n = Math.max(1, Math.min(DEMO_PAGES, parseInt(q.n, 10) || 1)), f = demoFile_("p" + ("0" + n).slice(-2) + ".jpg");
    return out({ ok: true, n, total: DEMO_PAGES, b64: Utilities.base64Encode(f.getBlob().getBytes()) });
  }
  return out({ ok: false });
}
function demoAuth_(d) {
  const key = prop("DEMO_KEY");
  if (!key || d.k !== key) return out({ ok: false, error: "데모 링크가 올바르지 않아요." });
  if (String(d.phone || "").replace(/\D/g, "") !== DEMO_PHONE) return out({ ok: false, error: "결제 내역이 없는 번호예요. (데모: 01000001234)" });
  const t = Utilities.getUuid();
  CacheService.getScriptCache().put("demo_t_" + t, "1", 6 * 3600);
  return out({ ok: true, token: t, total: DEMO_PAGES, label: "010-****-1234" });
}


/* ===== 패스트트랙 ③ 사이트에서 읽기 (ft-read.html) =====
 * - 처음 열 때: 결제 번호만 넣으면 바로 열림 + 6자리 '열람 코드' 발급(화면에 보여 주고 원하면 메일로)
 * - 새 기기: 결제 번호 + 열람 코드 → 출입증(토큰) 발급, 기기 FT_MAX_DEVICES대 초과 시 가장 오래된 기기 자동 로그아웃
 * - 문자 인증은 안 씀: 솔라피 문자 API는 고정 IP 등록 필수라 Apps Script에서 보낼 수 없음
 * - 출입증 FT_TOKEN_DAYS일 유효. 읽은 위치는 '열람' 시트에 저장(기기 바뀌어도 이어 읽기)
 * - 페이지 이미지는 사이트(ft/)에 암호화돼 올라가 있고, 열쇠는 비공개 드라이브 파일(FT_KEY_FILE_ID)에서 읽어 인증된 기기에만 줌
 * - 테스트 번호: 스크립트 속성 FT_TEST_PHONES(쉼표 구분, 기본 01000001234)는 결제 없이 구매자로 취급
 */
const FT_READ_URL = "https://gydnjs6580-boop.github.io/yanam/ft-read.html";
const FT_MAX_DEVICES = 3, FT_TOKEN_DAYS = 90;
const FT_KEY_FILE_ID = "1Ut6se732VAlTFg5RdGojTkqBOhky8gt2"; // 비공개 드라이브의 열쇠 파일 ID (파일 내용은 코드에 쓰지 않음)
const DEVICES = () => sheet_("열람기기", ["발급시각", "휴대폰", "출입증", "마지막 사용", "브라우저", "상태", "방법"]);
const READS = () => sheet_("열람", ["휴대폰", "마지막 부", "1부 마지막 쪽", "2부 마지막 쪽", "1부 최대 쪽", "2부 최대 쪽", "갱신시각", "처음 연 시각"]);
const KST = () => Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd HH:mm:ss");
const mask_ = p => p.slice(0, 3) + "-****-" + p.slice(-4);

function ftBuyer_(phone) { // → {paidAt(ms)} 또는 null
  const tests = (prop("FT_TEST_PHONES") || "01000001234").split(",").map(x => x.trim());
  if (tests.indexOf(phone) >= 0) return { paidAt: Date.now(), test: true };
  const sh = PAYS(), last = sh.getLastRow();
  if (last < 2) return null;
  const hit = sh.getRange(2, 1, last - 1, 9).getValues().filter(r => String(r[5]).replace(/'/g, "") === phone && String(r[2]) === "4" && r[8] === "Y" && FT_MATCH.test(String(r[3]))).pop();
  if (!hit) return null;
  const t = hit[0] instanceof Date ? hit[0].getTime() : new Date(String(hit[0]).replace(" ", "T") + "+09:00").getTime();
  return { paidAt: t };
}
function ftDevices_(phone) {
  const sh = DEVICES(), last = sh.getLastRow();
  return (last > 1 ? sh.getRange(2, 1, last - 1, 7).getValues() : []).map((r, i) => ({ r, row: i + 2 })).filter(x => String(x.r[1]).replace(/'/g, "") === phone && x.r[5] === "사용");
}
function ftIssue_(phone, ua, how) {
  const token = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "").slice(0, 8);
  const sh = DEVICES(), now = KST();
  sh.appendRow([now, txt(phone), token, now, s(ua, 120), "사용", how]);
  const act = ftDevices_(phone);
  act.slice(0, Math.max(0, act.length - FT_MAX_DEVICES)).forEach(x => { sh.getRange(x.row, 6).setValue("만료(기기 " + FT_MAX_DEVICES + "대 초과)"); CacheService.getScriptCache().remove("ftt_" + x.r[2]); });
  CacheService.getScriptCache().put("ftt_" + token, phone, 21600);
  return token;
}
function ftWho_(token) { // 출입증 → 휴대폰
  if (!token || String(token).length < 30) return "";
  const c = CacheService.getScriptCache(), hit = c.get("ftt_" + token);
  if (hit) return hit;
  const sh = DEVICES(), last = sh.getLastRow();
  if (last < 2) return "";
  const v = sh.getRange(2, 1, last - 1, 6).getValues();
  for (let i = v.length - 1; i >= 0; i--) if (String(v[i][2]) === String(token)) {
    if (v[i][5] !== "사용") return "";
    const t = v[i][0] instanceof Date ? v[i][0].getTime() : new Date(String(v[i][0]).replace(" ", "T") + "+09:00").getTime();
    if (Date.now() - t > FT_TOKEN_DAYS * 864e5) { sh.getRange(i + 2, 6).setValue("만료(기간)"); return ""; }
    const ph = String(v[i][1]).replace(/'/g, "");
    sh.getRange(i + 2, 4).setValue(KST()); c.put("ftt_" + token, ph, 21600);
    return ph;
  }
  return "";
}
function ftKey_() {
  const c = CacheService.getScriptCache(), k = c.get("ft_key");
  if (k) return k;
  if (!FT_KEY_FILE_ID) return "";
  const v = DriveApp.getFileById(FT_KEY_FILE_ID).getBlob().getDataAsString().trim();
  c.put("ft_key", v, 21600); return v;
}
function ftReadRow_(phone) {
  const sh = READS(), last = sh.getLastRow();
  const v = last > 1 ? sh.getRange(2, 1, last - 1, 8).getValues() : [];
  const i = v.findIndex(r => String(r[0]).replace(/'/g, "") === phone);
  return { sh, i, r: i >= 0 ? v[i] : null };
}
function ftCodeRow_(phone) {
  const sh = sheet_("열람코드", ["휴대폰", "열람 코드", "발급시각", "메일"]), last = sh.getLastRow();
  const v = last > 1 ? sh.getRange(2, 1, last - 1, 4).getValues() : [];
  const i = v.findIndex(r => String(r[0]).replace(/'/g, "") === phone);
  return { sh, i, code: i >= 0 ? String(v[i][1]).replace(/'/g, "") : "", mail: i >= 0 ? String(v[i][3] || "") : "" };
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const maskMail_ = m => { const [a, b] = m.split("@"); return a.slice(0, Math.min(2, a.length)) + "***@" + b; };
function ftEmailFor_(phone) { // 열람코드 탭 메일 → 신청자 시트(무료 E-BOOK 신청 메일) → 결제 시트 권한 이메일
  const x = ftCodeRow_(phone); if (EMAIL_RE.test(x.mail)) return x.mail;
  const find = (sh, pc, ec) => { const last = sh.getLastRow(); if (last < 2) return "";
    const v = sh.getRange(2, 1, last - 1, Math.max(pc, ec)).getValues();
    for (let k = v.length - 1; k >= 0; k--) if (String(v[k][pc - 1]).replace(/[^0-9]/g, "") === phone && EMAIL_RE.test(String(v[k][ec - 1]).trim())) return String(v[k][ec - 1]).trim().toLowerCase();
    return ""; };
  return find(LEADS(), 3, 4) || find(PAYS(), 6, 10);
}
function ftSendCodeMail_(email, code) {
  try {
    MailApp.sendEmail({ to: email, name: "야심한 남자", subject: "[야심한 남자] 패스트트랙 열람 코드",
      body: "패스트트랙 열람 코드: " + code + "\n\n새 휴대폰이나 PC에서 열 때 결제하신 휴대폰 번호와 이 코드를 넣으면 이어서 읽을 수 있어요.\n\n바로 읽기: " + FT_READ_URL + "\n\n이 메일을 보관해 주세요. 코드는 다른 사람에게 알려 주지 마세요." });
    return true;
  } catch (err) { return false; }
}
function ftCodeFor_(phone) { // 없으면 새로 만듦
  const x = ftCodeRow_(phone);
  if (x.code) return x.code;
  const code = String(Math.floor(100000 + Math.random() * 900000));
  x.sh.appendRow([txt(phone), "'" + code, KST(), ""]);
  return code;
}
function ftReader_(d, cache) {
  const phone = s(d.phone, 11).replace(/[^0-9]/g, "");
  switch (d.kind) {
    case "ftStart": { // 이 번호로 처음 여는 거면(등록 기기 0대, 열람 코드 없음) 바로 열기 + 열람 코드 발급. 아니면 열람 코드 필요
      if (!phoneOk(phone)) return out({ ok: false, error: "결제하신 휴대폰 번호를 확인해 주세요." });
      const b = ftBuyer_(phone);
      if (!b) return out({ ok: false, error: "이 번호로 확인된 패스트트랙 결제가 없어요. 결제 직후라면 1~2분 뒤 다시 시도해 주세요." });
      const lock = LockService.getScriptLock(); lock.waitLock(20000);
      try {
        if (!ftCodeRow_(phone).code && (b.test || ftDevices_(phone).length === 0)) {
          const code = ftCodeFor_(phone), token = ftIssue_(phone, d.ua, "첫 열람");
          const email = ftEmailFor_(phone); let mailed = "";
          if (email && ftSendCodeMail_(email, code)) { const x = ftCodeRow_(phone); x.sh.getRange(x.i + 2, 4).setValue(email); mailed = maskMail_(email); }
          return out({ ok: true, first: true, code, token, mailed });
        }
      } finally { lock.releaseLock(); }
      return out({ ok: false, need: "code" });
    }
    case "ftCode": {
      if (!phoneOk(phone)) return out({ ok: false, error: "휴대폰 번호를 확인해 주세요." });
      const k = "ftc_n_" + phone, n = +(cache.get(k) || 0);
      if (n >= 5) return out({ ok: false, error: "여러 번 틀렸어요. 10분 뒤 다시 시도해 주세요." });
      cache.put(k, String(n + 1), 600);
      const x = ftCodeRow_(phone);
      if (!x.code || x.code !== s(d.code, 6)) return out({ ok: false, error: "열람 코드가 맞지 않아요. 잊으셨다면 아래 「코드를 잊었어요」를 눌러 주세요." });
      cache.remove(k);
      const lock = LockService.getScriptLock(); lock.waitLock(20000);
      try { return out({ ok: true, token: ftIssue_(phone, d.ua, "열람 코드") }); } finally { lock.releaseLock(); }
    }
    case "ftMailCode": {
      const ph = ftWho_(d.token); if (!ph) return out({ ok: false, error: "다시 열어 주세요." });
      const email = s(d.email, 100).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return out({ ok: false, error: "이메일 주소를 확인해 주세요." });
      const x = ftCodeRow_(ph); if (!x.code) return out({ ok: false });
      if (!ftSendCodeMail_(email, x.code)) return out({ ok: false, error: "지금은 메일을 보낼 수 없어요. 화면을 캡처해 두세요." });
      x.sh.getRange(x.i + 2, 4).setValue(email);
      return out({ ok: true });
    }
    case "ftForgot": { // 코드 분실: 등록된 메일로 다시 보내기 (번호당 1시간에 3번)
      if (!phoneOk(phone)) return out({ ok: false, error: "결제하신 휴대폰 번호를 확인해 주세요." });
      if (!ftBuyer_(phone)) return out({ ok: false, error: "이 번호로 확인된 패스트트랙 결제가 없어요." });
      const k = "ftf_n_" + phone, n = +(cache.get(k) || 0);
      if (n >= 3) return out({ ok: false, error: "방금 메일을 보냈어요. 메일함(스팸함 포함)을 확인해 주세요." });
      const x = ftCodeRow_(phone); if (!x.code) return out({ ok: false, error: "아직 열람 코드가 없어요. 처음 결제한 휴대폰에서 먼저 열어 주세요." });
      const email = ftEmailFor_(phone);
      if (!email) return out({ ok: false, nomail: true, error: "등록된 메일이 없어요. 이미 열려 있는 기기가 있다면 🔑 버튼에서 코드를 볼 수 있어요. 없다면 카카오톡 채널 「야심한남자」로 결제 번호를 보내 주세요." });
      cache.put(k, String(n + 1), 3600);
      if (!ftSendCodeMail_(email, x.code)) return out({ ok: false, error: "지금은 메일을 보낼 수 없어요. 잠시 후 다시 눌러 주세요." });
      if (!x.mail) x.sh.getRange(x.i + 2, 4).setValue(email);
      return out({ ok: true, to: maskMail_(email) });
    }
    case "ftOpen": {
      const ph = ftWho_(d.token);
      if (!ph) return out({ ok: false, relogin: true });
      const key = ftKey_(); if (!key) return out({ ok: false, error: "준비 중이에요. 잠시 후 다시 열어 주세요." });
      const x = ftReadRow_(ph), r = x.r;
      if (!r) x.sh.appendRow([txt(ph), 1, 1, 1, 1, 1, KST(), KST()]);
      return out({ ok: true, key, label: mask_(ph), code: ftCodeRow_(ph).code, pos: r ? { part: +r[1] || 1, p1: +r[2] || 1, p2: +r[3] || 1 } : null });
    }
    case "ftPos": {
      const ph = ftWho_(d.token); if (!ph) return out({ ok: false });
      const part = d.part === 2 ? 2 : 1, pg = Math.max(1, Math.min(400, parseInt(d.page, 10) || 1));
      const x = ftReadRow_(ph); if (!x.r) return out({ ok: false });
      const row = x.r.slice(); row[1] = part; row[part === 1 ? 2 : 3] = pg; row[part === 1 ? 4 : 5] = Math.max(+row[part === 1 ? 4 : 5] || 1, pg); row[6] = KST();
      x.sh.getRange(x.i + 2, 2, 1, 6).setValues([row.slice(1, 7)]);
      return out({ ok: true });
    }
  }
}
