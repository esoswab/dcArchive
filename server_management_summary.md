# [메모] 오라클 서버 관리 및 업데이트 방법

이 문서는 서버 운영에 필요한 핵심 명령어와 절차를 정리한 것입니다.

---

### 1. 서버 접속 방법 (로컬 PC에서 실행)
윈도우 PowerShell을 켜고 프로젝트 폴더로 이동한 뒤 접속합니다.

```powershell
cd D:\Desktop\server_project
ssh -i "ssh-key-2026-05-08.key" ubuntu@140.245.79.232
```

---

### 2. 코드 업데이트 순서 (수정 사항 반영 시)

**Step 1. 내 컴퓨터에서 수정 후 깃허브에 업로드 (로컬 터미널)**
```powershell
git add .
git commit -m "수정 내용 요약"
git push
```

**Step 2. 서버에 접속하여 최신 코드 반영 (서버 터미널)**
```bash
cd ~/server_project
git pull origin main
pm2 restart dc
```

---

### 3. 서버 관리 핵심 명령어 (서버 터미널)

| 명령어 | 설명 |
| :--- | :--- |
| `pm2 status` | 서버가 잘 돌아가고 있는지 확인 |
| `pm2 logs dc` | 실시간 서버 로그(에러 확인 등) 보기 |
| `pm2 restart dc` | 서버 재시작 (코드 수정 시 필수) |
| `pm2 stop dc` | 서버 잠시 멈춤 |
| `pm2 start dc` | 멈춘 서버 다시 시작 |

*   **상태 확인**: `pm2 status`, `pm2 logs dc`
*   **DB 완전 초기화**: `pm2 stop dc` -> `rm -f archive.db* archive-cache.json` -> `pm2 start dc`

---

### 4. 주의 사항 및 팁
- **보안**: `.env` 파일과 `archive.db`는 깃허브에 올라가지 않으니, 만약 이 파일들을 수정했다면 `scp` 명령어로 따로 보내주어야 합니다.
- **자동 시작**: 서버가 재부팅되어도 자동으로 켜지게 설정되어 있습니다. 상태가 이상하면 `pm2 status`를 먼저 확인하세요.
- **포트**: 외부 접속이 안 된다면 오라클 클라우드의 '수신 규칙'과 서버 내부 'iptables' 설정을 확인하세요.

---
**서버 주소**: http://140.245.79.232:1557
