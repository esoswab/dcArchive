@echo off
:menu
cls
echo.
echo  =========================================
echo           서버 관리 시스템 (VR)
echo  =========================================
echo   [1] 서버 시작
echo   [2] 서버 중지
echo   [3] 서버 상태 확인
echo   [4] 서버 로그 확인
echo   [5] 개념글 즉시 갱신 (수동)
echo   [6] 특정 페이지 범위 갱신 (수동)
echo   [7] 프로그램 종료
echo  =========================================
echo.
set /p choice="  원하는 작업을 선택하세요 (1-7): "

if "%choice%" == "1" goto start
if "%choice%" == "2" goto stop
if "%choice%" == "3" goto status
if "%choice%" == "4" goto logs
if "%choice%" == "5" goto refresh_best
if "%choice%" == "6" goto refresh_pages
if "%choice%" == "7" exit
goto menu

:start
node server-manager.js start
goto menu

:stop
node server-manager.js stop
goto menu

:status
node server-manager.js status
timeout /t 3 > nul
goto menu

:logs
node server-manager.js logs
pause
goto menu

:refresh_best
echo.
echo  [동작] 개념글 갱신 요청 중...
powershell -Command "$r = Invoke-WebRequest -Uri 'http://localhost:8787/api/refresh?mode=best' -UseBasicParsing -ErrorAction SilentlyContinue; if ($r) { Write-Host '  >> 성공: 갱신이 시작되었습니다.' } else { Write-Host '  >> 실패: 서버가 꺼져 있습니다.' }"
timeout /t 2 > nul
goto menu

:refresh_pages
echo.
set /p pcount="  갱신할 최근 페이지 수를 입력하세요 (1-30): "
echo.
echo  [동작] 최근 %pcount%페이지 갱신 요청 중...
powershell -Command "$r = Invoke-WebRequest -Uri 'http://localhost:8787/api/refresh?mode=pages&count=%pcount%' -UseBasicParsing -ErrorAction SilentlyContinue; if ($r) { Write-Host '  >> 성공: %pcount%페이지 갱신이 시작되었습니다.' } else { Write-Host '  >> 실패: 서버가 꺼져 있습니다.' }"
timeout /t 3 > nul
goto menu
