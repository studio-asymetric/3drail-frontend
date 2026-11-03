/**
 * Convert SRTM HGT files to Terrarium-format terrain tiles
 * 
 * This script finds all HGT files in public/L33, L34, M33, M34 folders
 * and converts them to terrain tiles in public/terrain/{z}/{x}/{y}.png
 * 
 * Requirements:
 *   - Python 3 with GDAL: pip install gdal
 *   - OR use the Python script: scripts/convert_dem_simple.py (requires: pip install rasterio numpy pillow)
 * 
 * Usage:
 *   node scripts/convert_dem_to_tiles.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(BASE_DIR, 'public');
const TERRAIN_DIR = path.join(PUBLIC_DIR, 'terrain');
const TEMP_DIR = path.join(BASE_DIR, 'temp_dem');

function findHgtFiles() {
  const demFolders = ['L33', 'L34', 'M33', 'M34'];
  const hgtFiles = [];
  
  for (const folder of demFolders) {
    const folderPath = path.join(PUBLIC_DIR, folder, folder);
    if (fs.existsSync(folderPath)) {
      const files = fs.readdirSync(folderPath)
        .filter(f => f.endsWith('.hgt'))
        .map(f => path.join(folderPath, f));
      hgtFiles.push(...files);
      console.log(`📁 Found ${files.length} HGT files in ${folder}/`);
    }
  }
  
  return hgtFiles;
}

function checkPython() {
  const commands = ['py', 'python', 'python3'];
  for (const cmd of commands) {
    try {
      execSync(`${cmd} --version`, { stdio: 'ignore' });
      return cmd;
    } catch {
      // Try next command
    }
  }
  return null;
}

function checkGDAL() {
  try {
    execSync('gdalinfo --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function main() {
  console.log('🗻 SRTM HGT to Terrain Tiles Converter');
  console.log('='.repeat(50));
  
  // Find HGT files
  const hgtFiles = findHgtFiles();
  
  if (hgtFiles.length === 0) {
    console.error('❌ No HGT files found!');
    console.error('   Expected structure: public/{L33,L34,M33,M34}/{L33,L34,M33,M34}/*.hgt');
    process.exit(1);
  }
  
  console.log(`\n✅ Found ${hgtFiles.length} HGT files total`);
  
  // Check for Python
  const pythonCmd = checkPython();
  if (!pythonCmd) {
    console.error('\n❌ Python not found!');
    console.error('   Please install Python 3 from https://www.python.org/');
    console.error('   Then install dependencies: pip install rasterio numpy pillow');
    console.error('   Or install GDAL: pip install gdal');
    process.exit(1);
  }
  
  console.log(`\n✅ Python found: ${pythonCmd}`);
  
  // Check if v2 script exists (preferred)
  const v2Script = path.join(__dirname, 'convert_dem_to_tiles_v2.py');
  if (fs.existsSync(v2Script)) {
    console.log('\n🔄 Running Python conversion script v2 (5 zoom levels)...');
    try {
      execSync(`${pythonCmd} "${v2Script}"`, { 
        stdio: 'inherit',
        cwd: BASE_DIR 
      });
      console.log('\n✅ Conversion complete!');
      console.log(`📁 Terrain tiles saved to: ${TERRAIN_DIR}`);
      return;
    } catch (error) {
      console.error('\n❌ Python script v2 failed.');
      console.error('   Please check the error above and fix the script.');
      process.exit(1);
    }
  }
  
  // Check for GDAL
  if (checkGDAL()) {
    console.log('\n✅ GDAL found - using GDAL tools');
    const gdalScript = path.join(__dirname, 'convert_dem_to_tiles.py');
    if (fs.existsSync(gdalScript)) {
      try {
        execSync(`${pythonCmd} "${gdalScript}"`, { 
          stdio: 'inherit',
          cwd: BASE_DIR 
        });
        console.log('\n✅ Conversion complete!');
        return;
      } catch (error) {
        console.error('❌ GDAL script failed:', error.message);
      }
    }
  } else {
    console.log('\n⚠️  GDAL not found');
    console.log('   Install GDAL for better tile generation:');
    console.log('   Windows: Download OSGeo4W from https://trac.osgeo.org/osgeo4w/');
    console.log('   Or: conda install -c conda-forge gdal');
  }
  
  console.error('\n❌ No working conversion method found.');
  console.error('   Please install Python dependencies: pip install rasterio numpy pillow');
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { findHgtFiles, checkPython, checkGDAL };

