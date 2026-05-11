@echo off
set /p postno="감시할 글 번호를 입력하세요: "
echo %postno% >> watch-list.tmp
echo [완료] 글 번호 %postno%가 등록 대기열에 추가되었습니다.
echo 서버가 자동으로 이 파일을 읽어들일 것입니다.
pause
