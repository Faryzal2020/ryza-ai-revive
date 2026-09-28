@echo off
setlocal
echo ========================================================
echo   Ryza Chat Desktop Builder
echo ========================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build_desktop.ps1" %*
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Build failed with exit code %ERRORLEVEL%.
    exit /b %ERRORLEVEL%
)
echo.
echo [SUCCESS] Build finished successfully.
exit /b 0
