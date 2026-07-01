// bake-osm.mjs — Offline OpenStreetMap building baker for the Egypt eclipse flight sim.
//
// Fetches real building footprints (OSM, via the Overpass API — open, NO key) for the Luxor
// bbox, projects each footprint into the sim's local-metre frame, estimates a height, flags
// temples / historic landmarks, and writes a compact committed JSON the runtime extrudes into
// real 3D buildings draped on the terrain.
//
//   ../assets/luxor-buildings.json   { center, spans, buildings:[{h, t, p:[x,z,x,z,…]}] }
//
// Run once; output is committed.   cd tools && npm install && npm run osm
//
// Buildings © OpenStreetMap contributors (ODbL) — attribution shown at runtime.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Same bbox/centre as the DEM + imagery bakers.
const CENTER = { lng: 32.6064777, lat: 25.7242244 };
const HALF_LNG = 0.135, HALF_LAT = 0.122;
const BBOX = {
  w: +(CENTER.lng - HALF_LNG).toFixed(6), s: +(CENTER.lat - HALF_LAT).toFixed(6),
  e: +(CENTER.lng + HALF_LNG).toFixed(6), n: +(CENTER.lat + HALF_LAT).toFixed(6),
};

// Local-metre frame (matches the sim: +x = east, +z = south, origin = bbox centre).
const DEG = Math.PI / 180, M_PER_DEG_LAT = 111320;
const centerLat = (BBOX.s + BBOX.n) / 2, centerLng = (BBOX.w + BBOX.e) / 2;
const mPerDegLng = M_PER_DEG_LAT * Math.cos(centerLat * DEG);
const spanMetersX = (BBOX.e - BBOX.w) * mPerDegLng;
const spanMetersZ = (BBOX.n - BBOX.s) * M_PER_DEG_LAT;
const toX = (lng) => Math.round((lng - centerLng) * mPerDegLng);
const toZ = (lat) => Math.round((centerLat - lat) * M_PER_DEG_LAT);

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const query =
  `[out:json][timeout:180];` +
  `( way["building"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e}); );` +
  `out body; >; out skel qt;`;

async function fetchOverpass() {
  for (const url of ENDPOINTS) {
    try {
      console.log(`Querying ${url} …`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'egypt-eclipse-flight/1.0 (dev bake)' },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      console.log(`  failed (${e.message}); trying next endpoint`);
    }
  }
  throw new Error('all Overpass endpoints failed');
}

// Height estimate (metres) from OSM tags, with sensible fallbacks.
function heightOf(tags, landmark) {
  if (tags.height) { const m = parseFloat(String(tags.height).replace(',', '.')); if (isFinite(m) && m > 0) return m; }
  if (tags['building:levels']) { const l = parseFloat(tags['building:levels']); if (isFinite(l) && l > 0) return l * 3.2 + 1.0; }
  return landmark ? 15 : 6.5;
}
// Temple / historic / civic landmarks get a distinct look + a bit more height.
function isLandmark(tags) {
  const b = (tags.building || '').toLowerCase();
  return !!(tags.historic || tags.tourism === 'attraction' || tags.tourism === 'museum'
    || tags.amenity === 'place_of_worship'
    || ['temple', 'mosque', 'church', 'cathedral', 'shrine', 'monument', 'chapel'].includes(b)
    || /temple|karnak|ramesseum|medinet|hatshepsut|memnon|habu|deir|colossi|mortuary/i.test(tags.name || tags['name:en'] || ''));
}
function area(pts) { let a = 0; for (let i = 0, n = pts.length; i < n; i++) { const j = (i + 1) % n; a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]; } return Math.abs(a) / 2; }

const data = await fetchOverpass();
const nodes = new Map();
for (const el of data.elements) if (el.type === 'node') nodes.set(el.id, [el.lon, el.lat]);

const buildings = [];
let skipped = 0, landmarks = 0, maxH = 0;
for (const el of data.elements) {
  if (el.type !== 'way' || !el.nodes || el.nodes.length < 4) continue;
  const tags = el.tags || {};
  // Build the local-metre footprint (drop the closing duplicate + collinear/duplicate points).
  const ring = [];
  for (const nid of el.nodes) { const c = nodes.get(nid); if (!c) continue; ring.push([toX(c[0]), toZ(c[1])]); }
  const uniq = [];
  for (let i = 0; i < ring.length; i++) { const p = ring[i], q = uniq[uniq.length - 1]; if (!q || q[0] !== p[0] || q[1] !== p[1]) uniq.push(p); }
  if (uniq.length > 1 && uniq[0][0] === uniq[uniq.length - 1][0] && uniq[0][1] === uniq[uniq.length - 1][1]) uniq.pop();
  if (uniq.length < 3 || area(uniq) < 10) { skipped++; continue; }   // drop degenerate / tiny footprints
  const lm = isLandmark(tags);
  const h = Math.min(90, Math.round(heightOf(tags, lm)));
  if (lm) landmarks++; if (h > maxH) maxH = h;
  const flat = []; for (const p of uniq) { flat.push(p[0], p[1]); }
  buildings.push({ h, t: lm ? 1 : 0, p: flat });
}

const out = {
  source: 'OpenStreetMap via Overpass API',
  attribution: 'Buildings © OpenStreetMap contributors',
  bbox: BBOX,
  center: { lng: centerLng, lat: centerLat },
  spanMetersX: Math.round(spanMetersX),
  spanMetersZ: Math.round(spanMetersZ),
  count: buildings.length,
  buildings,
};
const here = dirname(fileURLToPath(import.meta.url));
const assets = resolve(here, '..', 'assets');
mkdirSync(assets, { recursive: true });
const path = resolve(assets, 'luxor-buildings.json');
writeFileSync(path, JSON.stringify(out));
console.log(`Wrote assets/luxor-buildings.json — ${buildings.length} buildings (${landmarks} landmarks), ${skipped} skipped, maxH=${maxH} m`);
