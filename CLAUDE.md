# 야심한남자 페이지 (GitHub Pages 정적 사이트)

- main에 올라가면 바로 공개된다. 작업은 브랜치 → PR.
- 문구·톤·색·CTA는 `docs/brand-guide.md`를 따른다. 문구는 코치님 원고에서 뽑고 지어내지 않는다. 후기·수치는 실제 근거가 있을 때만.
- 유입 측정: 링크에 `?src=값`(영문 소문자·숫자·_). 쇼츠 `shorts_YYMMDD`, 롱폼 `long_YYMMDD`.
- 결제 링크(payapp.kr)와 Apps Script `ENDPOINT` 주소는 효원님 확인 없이 바꾸지 않는다.
- `backend/apps-script.gs`, `relay/`는 커밋해도 반영되지 않는다. 바꿨으면 Apps Script 편집기에 붙여넣기·재배포(relay는 서버 재시작)가 필요하다고 알린다.
- `ft/*.bin`은 암호화된 유료 원고. 열쇠를 저장소에 넣지 않는다.
- HTML을 고치면 훅(`.claude/hooks/check_html.py`)이 태그 짝·깨진 링크·src 형식·JS 문법을 검사한다. 실패 메시지가 나오면 고친다. 전체 검사: `python3 .claude/hooks/check_html.py`
