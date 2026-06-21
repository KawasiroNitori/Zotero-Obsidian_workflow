# 연구실 장부 대체 사이트

원본 사이트가 브라우저에서 빈 화면으로 보일 때 쓸 수 있는 로컬 대체본입니다.

## 실행

PowerShell에서 이 폴더로 이동한 뒤 실행합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\serve.ps1 -Port 4177
```

브라우저에서 아래 주소를 엽니다.

```text
http://127.0.0.1:4177/
```

## 원본 사이트 오류

원본 GitHub Pages HTML은 `https://unpkg.com/@babel/standalone/babel.min.js`를 버전 고정 없이 불러와 `type="text/babel"` 스크립트를 브라우저에서 즉석 변환합니다. 현재 변환 결과에 `import` 문이 들어가는데, 이 스크립트가 일반 스크립트로 실행되어 `Cannot use import statement outside a module` 오류가 나고 React 앱이 마운트되지 않습니다.

## 데이터

데이터는 아래 Google Apps Script 엔드포인트에서 가져옵니다.

```text
https://script.google.com/macros/s/AKfycbwPzshs-qmMlPCsBIIW6VLUyqgkD3F3nPI96hAm7QbXigVZueCVo4a2wZlXlCwikCg/exec
```

로컬 서버는 `/api/ledger`, `/api/save`를 통해 이 엔드포인트를 프록시합니다.

## GitHub Pages

이 저장소의 GitHub Pages 배포 주소는 아래와 같습니다.

```text
https://kawasiroNitori.github.io/Zotero-Obsidian_workflow/
```

GitHub Pages로 열 때는 브라우저가 Google Apps Script 엔드포인트에 직접 연결합니다.

## 수정 권한

이 앱에는 별도 로그인이나 사용자 구분이 없습니다. Google Apps Script가 현재처럼 공개 요청을 받아 저장하도록 설정되어 있다면, 사이트에 접속한 사람은 거래 추가, 삭제, 멤버 수정 같은 변경을 할 수 있습니다. 즉, URL을 아는 사람에게는 사실상 장부 수정 권한이 열린 상태입니다.
