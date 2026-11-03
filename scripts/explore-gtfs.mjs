/**
 * GTFS Dataset Explorer
 * 
 * Explores the Slovak Railway GTFS dataset to understand available data.
 * 
 * Usage: node scripts/explore-gtfs.mjs
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CKAN API endpoint to get dataset info
const DATASET_ID = 'ca4cb74c-7192-4198-b074-34acd9d295e7';
const CKAN_API_URLS = [
  `https://data.gov.sk/api/3/action/package_show?id=${DATASET_ID}`,
  `https://data.slovensko.sk/api/3/action/package_show?id=${DATASET_ID}`,
];

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;
    
    const request = protocol.get(url, (response) => {
      // Handle redirects
      if (response.statusCode === 302 || response.statusCode === 301) {
        file.close();
        fs.unlinkSync(dest);
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }
      
      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        resolve({ success: false, status: response.statusCode });
        return;
      }
      
      const totalSize = parseInt(response.headers['content-length'] || '0', 10);
      let downloaded = 0;
      
      response.on('data', (chunk) => {
        downloaded += chunk.length;
        if (totalSize > 0) {
          const percent = ((downloaded / totalSize) * 100).toFixed(1);
          process.stdout.write(`\r  Downloading: ${percent}% (${(downloaded / 1024 / 1024).toFixed(2)} MB)`);
        }
      });
      
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log('\n  ✓ Download complete');
        resolve({ success: true, size: downloaded });
      });
    });
    
    request.on('error', (err) => {
      file.close();
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      reject(err);
    });
  });
}

async function exploreDataset() {
  console.log('🔍 Exploring Slovak Railway GTFS Dataset\n');
  console.log(`Dataset ID: ${DATASET_ID}`);
  console.log(`Dataset URL: https://data.gov.sk/set/${DATASET_ID}\n`);
  
  const outputDir = path.join(__dirname, '../data/gtfs-test');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // Step 1: Get dataset metadata from CKAN API
  console.log('📡 Step 1: Fetching dataset metadata from CKAN API...\n');
  
  let datasetInfo = null;
  for (const apiUrl of CKAN_API_URLS) {
    try {
      console.log(`  Trying: ${apiUrl}`);
      const response = await fetchJSON(apiUrl);
      
      if (response.success && response.result) {
        datasetInfo = response.result;
        console.log(`  ✓ Success! Found dataset: "${datasetInfo.title}"\n`);
        break;
      } else {
        console.log(`  ✗ API returned: ${JSON.stringify(response)}\n`);
      }
    } catch (error) {
      console.log(`  ✗ Error: ${error.message}\n`);
    }
  }
  
  if (!datasetInfo) {
    console.log('❌ Could not fetch dataset metadata. Trying direct download URLs...\n');
  } else {
    // Display dataset info
    console.log('📋 Dataset Information:');
    console.log(`  Title: ${datasetInfo.title || 'N/A'}`);
    console.log(`  Description: ${datasetInfo.notes?.substring(0, 100) || 'N/A'}...`);
    console.log(`  Resources: ${datasetInfo.resources?.length || 0}\n`);
    
    // Find downloadable resources
    if (datasetInfo.resources && datasetInfo.resources.length > 0) {
      console.log('📦 Available Resources:\n');
      
      for (const resource of datasetInfo.resources) {
        console.log(`  Resource: ${resource.name || resource.id}`);
        console.log(`    Format: ${resource.format || 'unknown'}`);
        console.log(`    URL: ${resource.url}`);
        console.log(`    Size: ${resource.size ? `${(resource.size / 1024 / 1024).toFixed(2)} MB` : 'unknown'}`);
        console.log(`    Description: ${resource.description?.substring(0, 80) || 'N/A'}...\n`);
        
        // Try to download if it looks like GTFS data
        if (resource.format?.toLowerCase() === 'zip' || 
            resource.url?.toLowerCase().includes('.zip') ||
            resource.name?.toLowerCase().includes('gtfs')) {
          console.log(`  📥 Attempting to download resource...`);
          try {
            const filename = path.join(outputDir, 'gtfs.zip');
            const result = await downloadFile(resource.url, filename);
            
            if (result.success && result.size > 1000) {
              console.log(`  ✓ Successfully downloaded ${(result.size / 1024 / 1024).toFixed(2)} MB\n`);
              await analyzeGTFS(filename, outputDir);
              return;
            } else {
              console.log(`  ✗ Download failed or file too small\n`);
            }
          } catch (error) {
            console.log(`  ✗ Download error: ${error.message}\n`);
          }
        }
      }
    }
  }
  
  // Step 2: Try direct download URLs
  console.log('📡 Step 2: Trying direct download URLs...\n');
  
  const directUrls = [
    `https://data.gov.sk/dataset/${DATASET_ID}/download`,
    `https://data.slovensko.sk/dataset/${DATASET_ID}/download`,
  ];
  
  for (const url of directUrls) {
    try {
      console.log(`  Trying: ${url}`);
      const filename = path.join(outputDir, 'gtfs.zip');
      const result = await downloadFile(url, filename);
      
      if (result.success && result.size > 1000) {
        console.log(`  ✓ Successfully downloaded ${(result.size / 1024 / 1024).toFixed(2)} MB\n`);
        await analyzeGTFS(filename, outputDir);
        return;
      } else {
        if (fs.existsSync(filename)) fs.unlinkSync(filename);
        console.log(`  ✗ Download failed (status: ${result.status || 'unknown'})\n`);
      }
    } catch (error) {
      console.log(`  ✗ Error: ${error.message}\n`);
    }
  }
  
  console.log('❌ Could not automatically download GTFS data.\n');
  console.log('💡 Manual steps:');
  console.log('  1. Visit: https://data.gov.sk/set/' + DATASET_ID);
  console.log('  2. Download the GTFS ZIP file manually');
  console.log(`  3. Place it at: ${path.join(outputDir, 'gtfs.zip')}`);
  console.log('  4. Run this script again to analyze it.\n');
}

async function analyzeGTFS(zipPath, outputDir) {
  console.log('📦 Step 3: Analyzing GTFS ZIP file...\n');
  
  // Check if file exists and get size
  if (!fs.existsSync(zipPath)) {
    console.log('  ✗ ZIP file not found\n');
    return;
  }
  
  const stats = fs.statSync(zipPath);
  console.log(`  File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB\n`);
  
  // Note: To actually extract and parse, we'd need a ZIP library
  // For now, we'll document what we expect
  
  console.log('📊 Expected GTFS Files:\n');
  
  const gtfsFiles = [
    { name: 'agency.txt', desc: 'Transit agencies' },
    { name: 'stops.txt', desc: 'Stops where vehicles pick up/drop off passengers' },
    { name: 'routes.txt', desc: 'Transit routes' },
    { name: 'trips.txt', desc: 'Trips for each route' },
    { name: 'stop_times.txt', desc: 'Arrival/departure times at stops' },
    { name: 'calendar.txt', desc: 'Service dates (weekly schedule)' },
    { name: 'calendar_dates.txt', desc: 'Exceptions for service dates' },
    { name: 'shapes.txt', desc: 'Shape points for drawing routes on map' },
    { name: 'feed_info.txt', desc: 'Feed metadata' },
  ];
  
  gtfsFiles.forEach(file => {
    console.log(`  ✓ ${file.name.padEnd(20)} - ${file.desc}`);
  });
  
  console.log('\n💡 Key Data for 3D Map:\n');
  console.log('  • shapes.txt    → Route coordinates (lat/lng) for drawing tracks');
  console.log('  • stops.txt     → Station locations (lat/lng)');
  console.log('  • trips.txt     → Train trips with route and schedule');
  console.log('  • stop_times.txt → When trains arrive/depart at each station');
  console.log('  • routes.txt    → Route names and types\n');
  
  console.log('📝 Next Steps:\n');
  console.log('  1. Extract ZIP file (need to add ZIP extraction)');
  console.log('  2. Parse CSV files (shapes.txt, stops.txt, trips.txt, stop_times.txt)');
  console.log('  3. Build data structures for 3D visualization');
  console.log('  4. Combine with real-time delay data from mapa.zsr.sk');
  console.log('  5. Update trainService.ts to use GTFS data\n');
}

// Run the explorer
exploreDataset().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});


