// Check what tile coordinates should be for Slovakia
function latLngToTile(lat, lng, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x, y };
}

const minLat = 48.0, maxLat = 49.5, minLng = 16.8, maxLng = 22.6;

console.log('Slovakia bounds:', { minLat, maxLat, minLng, maxLng });
console.log('\nExpected tile coordinates:');

for (let z = 0; z <= 4; z++) {
  const minTile = latLngToTile(minLat, minLng, z);
  const maxTile = latLngToTile(maxLat, maxLng, z);
  const tileMinX = Math.min(minTile.x, maxTile.x);
  const tileMaxX = Math.max(minTile.x, maxTile.x);
  const tileMinY = Math.min(minTile.y, maxTile.y);
  const tileMaxY = Math.max(minTile.y, maxTile.y);
  
  console.log(`Z${z}: X[${tileMinX}-${tileMaxX}], Y[${tileMinY}-${tileMaxY}] (${(tileMaxX - tileMinX + 1) * (tileMaxY - tileMinY + 1)} tiles)`);
}

console.log('\nActual tiles generated:');
console.log('Z0: 0/0/0.png');
console.log('Z1: 1/1/0.png');
console.log('Z2: 2/2/1.png');
console.log('Z3: 3/4/2.png');
console.log('Z4: 4/8/5.png, 4/9/5.png');


