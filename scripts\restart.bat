@echo off
setlocal
call "%~dp0stop.bat"
if errorlevel 1 exit /b 1
call "%~dp0start.bat"
exit /b %errorlevel%
