@echo off
node "%~dp0launcher.mjs" stop
if errorlevel 1 pause
