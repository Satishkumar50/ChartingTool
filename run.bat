@echo off
echo.
echo  Multi-Timeframe Charts
echo  ========================
echo.
echo  Installing / updating dependencies...
pip install -r requirements.txt --quiet
echo.
echo  Starting server at http://localhost:5000
echo  Press Ctrl+C to stop.
echo.
python app.py
pause
