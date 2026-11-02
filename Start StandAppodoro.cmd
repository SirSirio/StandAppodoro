@echo off
rem Launches StandAppodoro in the tray without a console window.
set ELECTRON_RUN_AS_NODE=
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
