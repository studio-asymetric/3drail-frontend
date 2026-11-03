# Python Installation Guide for Windows

## Quick Install Steps:

1. **Download Python 3.12+**
   - Go to: https://www.python.org/downloads/
   - Click "Download Python 3.x.x" (latest version)
   - Run the installer

2. **IMPORTANT: Check "Add Python to PATH" during installation!**
   - This is crucial - it allows you to run Python from command line

3. **Verify Installation**
   ```powershell
   python --version
   ```

4. **Install Required Packages**
   ```powershell
   pip install rasterio numpy pillow
   ```

5. **Run Conversion**
   ```powershell
   python scripts/convert_dem_simple.py
   ```

## Alternative: Use Microsoft Store

1. Open Microsoft Store
2. Search for "Python 3.12"
3. Click "Install"
4. After installation, open a NEW PowerShell window
5. Run: `pip install rasterio numpy pillow`
6. Run: `python scripts/convert_dem_simple.py`

## Troubleshooting

### "Python not found" after installation
- Close and reopen your terminal/PowerShell
- Or restart your computer
- Make sure "Add Python to PATH" was checked during installation

### "pip is not recognized"
- Try: `python -m pip install rasterio numpy pillow`

### Installation takes too long
- The packages (especially rasterio) can take 5-10 minutes to install
- This is normal - be patient!


