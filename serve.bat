@echo off
rem Serves the simulator page locally and opens it in the default browser.
rem Pass --port N or --no-isolation through to web\serve.py.
setlocal
cd /d "%~dp0"

if not exist "web\wasm\threads\nbody.wasm" goto missing
if not exist "web\wasm\single\nbody.wasm" goto missing

start "" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:8000/"
python web\serve.py %*
goto :eof

:missing
echo The WebAssembly modules are not built. With emsdk activated, run:
echo     cmake --workflow --preset wasm-threads
echo     cmake --workflow --preset wasm-single
exit /b 1
