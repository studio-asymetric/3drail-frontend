/**
 * GTFS Dataset Explorer
 * 
 * This script explores the Slovak Railway GTFS dataset from data.gov.sk
 * to understand what data is available and how to use it.
 * 
 * Dataset: https://data.gov.sk/set/ca4cb74c-7192-4198-b074-34acd9d295e7
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { createWriteStream } from 'fs';

interface GTFSFile {
  name: string;
  url: string;
  size?: number;
  description: string;
}

// Common GTFS file names
const GTFS_FILES = [
  'agency.txt',
  'stops.txt',
  'routes.txt',
  'trips.txt',
  'stop_times.txt',
  'calendar.txt',
  'calendar_dates.txt',
  'shapes.txt',
  'feed_info.txt',
  'frequencies.txt',
  'transfers.txt',
];

// Potential download URLs to try
const POTENTIAL_URLS = [
  'https://data.gov.sk/dataset/ca4cb74c-7192-4198-b074-34acd9d295e7/download',
  'https://data.slovensko.sk/dataset/ca4cb74c-7192-4198-b074-34acd9d295e7/download',
  'https://data.gov.sk/api/3/action/package_show?id=ca4cb74c-7192-4198-b074-34acd9d295e7',
  'https://data.slovensko.sk/api/3/action/package_show?id=ca4cb74c-7192-4198-b074-34acd9d295e7',
];

async function downloadFile(url: string, dest: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;
    
    protocol.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Follow redirect
        file.close();
        fs.unlinkSync(dest);
        return downloadFile(response.headers.location!, dest).then(resolve).catch(reject);
      }
      
      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        resolve(false);
        return;
      }
      
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(true);
      });
    }).on('error', (err) => {
      file.close();
      fs.unlinkSync(dest);
      reject(err);
    });
  });
}

async function fetchJSON(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function exploreDataset() {
  console.log('🔍 Exploring Slovak Railway GTFS Dataset\n');
  console.log('Dataset URL: https://data.gov.sk/set/ca4cb74c-7192-4198-b074-34acd9d295e7\n');
  
  const outputDir = path.join(__dirname, '../data/gtfs-test');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // Try to get dataset metadata from CKAN API
  console.log('📡 Step 1: Fetching dataset metadata from CKAN API...\n');
  
  for (const apiUrl of POTENTIAL_URLS.filter(url => url.includes('/api/'))) {
    try {
      console.log(`  Trying: ${apiUrl}`);
      const data = await fetchJSON(apiUrl);
      
      if (data.result && data.result.resources) {
        console.log(`  ✓ Found ${data.result.resources.length} resources\n`);
        
        for (const resource of data.result.resources) {
          console.log(`  Resource: ${resource.name || resource.id}`);
          console.log(`    Format: ${resource.format}`);
          console.log(`    URL: ${resource.url}`);
          console.log(`    Size: ${resource.size || 'unknown'}\n`);
          
          // Try to download if it's a ZIP or GTFS file
          if (resource.format?.toLowerCase() === 'zip' || 
              resource.url?.endsWith('.zip') ||
              resource.name?.toLowerCase().includes('gtfs')) {
            const filename = path.join(outputDir, 'gtfs.zip');
            console.log(`  📥 Attempting to download...`);
            const success = await downloadFile(resource.url, filename);
            if (success) {
              console.log(`  ✓ Downloaded successfully to ${filename}\n`);
              await analyzeGTFSZip(filename, outputDir);
              return;
            } else {
              console.log(`  ✗ Download failed\n`);
            }
          }
        }
      }
    } catch (error: any) {
      console.log(`  ✗ Failed: ${error.message}\n`);
    }
  }
  
  // Try direct download URLs
  console.log('📡 Step 2: Trying direct download URLs...\n');
  
  for (const url of POTENTIAL_URLS.filter(url => url.includes('/download'))) {
    try {
      console.log(`  Trying: ${url}`);
      const filename = path.join(outputDir, 'gtfs.zip');
      const success = await downloadFile(url, filename);
      if (success) {
        const stats = fs.statSync(filename);
        if (stats.size > 1000) { // Check if file has content
          console.log(`  ✓ Downloaded ${stats.size} bytes\n`);
          await analyzeGTFSZip(filename, outputDir);
          return;
        } else {
          fs.unlinkSync(filename);
          console.log(`  ✗ File too small, likely an error page\n`);
        }
      } else {
        console.log(`  ✗ Download failed\n`);
      }
    } catch (error: any) {
      console.log(`  ✗ Error: ${error.message}\n`);
    }
  }
  
  console.log('❌ Could not automatically download GTFS data.');
  console.log('💡 Please manually download the GTFS ZIP file and place it at:');
  console.log(`   ${path.join(outputDir, 'gtfs.zip')}\n`);
  console.log('Then run this script again to analyze it.');
}

async function analyzeGTFSZip(zipPath: string, outputDir: string) {
  console.log('📦 Step 3: Analyzing GTFS ZIP file...\n');
  
  // Note: In a real implementation, we'd use a ZIP library like 'adm-zip' or 'yauzl'
  // For now, we'll document what we expect to find
  
  console.log('Expected GTFS files:');
  GTFS_FILES.forEach(file => {
    console.log(`  - ${file}`);
  });
  
  console.log('\n📊 GTFS File Descriptions:\n');
  console.log('  agency.txt      - Transit agencies with service represented in this dataset');
  console.log('  stops.txt       - Stops where vehicles pick up or drop off passengers');
  console.log('  routes.txt      - Transit routes');
  console.log('  trips.txt        - Trips for each route');
  console.log('  stop_times.txt   - Times that a vehicle arrives at and departs from stops');
  console.log('  calendar.txt     - Service dates specified using a weekly schedule');
  console.log('  calendar_dates.txt - Exceptions for the service dates');
  console.log('  shapes.txt       - Rules for drawing lines on a map to represent a transit route');
  console.log('  feed_info.txt    - Information about the feed itself');
  
  console.log('\n💡 Next steps:');
  console.log('  1. Extract the ZIP file');
  console.log('  2. Parse the CSV files');
  console.log('  3. Build a data structure for our 3D map');
  console.log('  4. Integrate with real-time delay data from mapa.zsr.sk\n');
}

// Run the explorer
exploreDataset().catch(console.error);


