// Agent Radio v7 — embedded geographic centroids (no external API, ships with the app).
// Used by the relay to resolve lat/lon for stations that only have a country or region,
// so every station with at least a country plots on the map (4-tier resolution).
//
// Coordinates are well-known capital / city / state-centroid approximations.
// Approximate (non-exact) coordinates are flagged via locationTier so the UI can
// render a distinct "approximate" marker style and an honest precision label.

// ISO-3166 alpha-2 -> [lat, lon] (capital / geographic centroid)
const COUNTRY_CENTROIDS = {
  ae:[24.45,54.39], af:[34.53,69.17], at:[48.21,16.37], au:[-35.28,149.13], az:[40.40,49.87],
  ba:[43.85,18.41], bg:[42.70,23.32], br:[-15.78,-47.93], by:[53.90,27.57], ca:[45.42,-75.70],
  ch:[46.95,7.45], cl:[-33.45,-70.67], co:[4.71,-74.07], cz:[50.08,14.44], de:[51.16,10.45],
  dz:[36.75,3.06], eg:[30.04,31.24], es:[40.42,-3.70], et:[9.03,38.74], fi:[60.17,24.94],
  fr:[46.60,2.34], gb:[52.36,-1.26], ge:[41.72,44.83], gr:[39.07,21.82], hn:[14.07,-87.22],
  hr:[45.81,15.98], hu:[47.50,19.04], id:[-6.21,106.85], ie:[53.35,-6.26], il:[31.78,35.22],
  in:[22.59,79.96], iq:[33.31,44.36], ir:[32.43,53.69], it:[42.64,12.67], jm:[17.97,-76.79],
  kz:[48.02,66.92], lt:[54.69,25.28], lu:[49.61,6.13], ma:[34.02,-6.83], mu:[-20.16,57.50],
  mx:[23.63,-102.55], my:[4.21,101.98], nl:[52.13,5.29], no:[64.57,11.49], nz:[-41.29,174.78],
  pe:[-9.19,-75.02], pk:[30.38,69.35], pl:[52.13,19.13], pt:[39.60,-8.59], qa:[25.35,51.18],
  ro:[45.94,24.97], rs:[44.02,21.00], ru:[61.52,105.32], si:[46.15,14.99], sk:[48.67,19.70],
  sn:[14.50,-14.45], sv:[13.74,-88.91], sy:[34.80,38.00], tn:[33.89,9.50], tr:[38.96,35.24],
  tw:[23.69,120.96], tz:[-6.37,34.89], ua:[48.38,31.17], ug:[1.37,32.29], us:[37.09,-95.71],
  uy:[-32.52,-55.77], vn:[16.00,107.84]
};

// Normalized place name -> [lat, lon]. Covers regions/states/cities that appear in the catalog.
// Aliases collapse to the same key after normalization (e.g. Bayern/Bavaria, Москва/Moscow).
const PLACE_CENTROIDS = {
  'addis ababa':[9.03,38.74], 'antioquia':[6.25,-75.57], 'athens':[37.98,23.73], 'attica':[38.04,23.73],
  'auckland':[-36.85,174.76], 'baden wurttemberg':[48.54,9.16], 'baku':[40.40,49.87],
  'bavaria':[48.79,11.49], 'bayern':[48.79,11.49], 'belgrade':[44.79,20.46], 'berlin':[52.52,13.40],
  'berlin brandenburg':[52.52,13.40], 'bern':[46.95,7.45], 'bogota':[4.71,-74.07], 'budapest':[47.50,19.04],
  'california':[36.78,-119.42], 'camden':[51.54,-0.16], 'chernivtsi':[48.29,25.94],
  'ciudad de mexico':[19.43,-99.13], 'deutschland':[51.16,10.45], 'deutschland und nrw':[51.43,7.66],
  'england':[52.36,-1.26], 'estoril':[38.71,-9.40], 'france':[46.60,2.34], 'grad zagreb':[45.81,15.98],
  'hellas':[39.07,21.82], 'ibiza':[38.91,1.42], 'isle of man':[54.24,-4.55], 'istanbul':[41.01,28.98],
  'kansas':[38.49,-98.32], 'kaohsiung':[22.63,120.33], 'key west florida':[24.56,-81.78],
  'kingston':[17.97,-76.79], 'kyiv':[50.45,30.52], 'lazio':[41.90,12.50], 'leiria':[39.74,-8.81],
  'liguria':[44.41,8.93], 'lima peru':[-12.05,-77.04], 'lisboa':[38.72,-9.14], 'lombardia':[45.46,9.19],
  'london':[51.51,-0.13], 'luxembourg':[49.61,6.13], 'madrid':[40.42,-3.70], 'minnesota':[46.73,-94.69],
  'missouri':[38.57,-92.60], 'montevideo':[-34.87,-56.17], 'moscow':[55.76,37.62], 'nrw':[51.43,7.66],
  'new york':[40.71,-74.01], 'new york ny':[40.71,-74.01], 'normandie':[49.44,0.10], 'ohio':[40.42,-82.91],
  'north rhine westphalia':[51.43,7.66], 'ontario':[43.65,-79.38], 'oslo':[59.91,10.75],
  'palma de mallorca':[39.57,2.65], 'pennsylvania':[40.59,-77.20], 'pernik':[42.60,23.04],
  'prague':[50.08,14.44], 'rio de janeiro':[-22.91,-43.17], 'san francisco ca':[37.77,-122.42],
  'san salvador':[13.69,-89.19], 'sao paulo':[-23.55,-46.63], 'sarawak':[1.55,110.36],
  'sindh':[25.89,68.52], 'sisacko moslavacka zupanija':[45.48,16.38], 'slovakia':[48.15,17.11],
  'spain':[40.42,-3.70], 'splitsko dalmatinska':[43.51,16.44], 'sao paulo brazil':[-23.55,-46.63],
  'tacoma washington':[47.25,-122.44], 'tegucigalpa':[14.07,-87.22], 'tel aviv':[32.08,34.78],
  'toronto':[43.65,-79.38], 'vienna':[48.21,16.37], 'virginia':[37.77,-78.87],
  'washington':[47.41,-122.90], 'wieliczka':[49.99,20.06], 'wisconsin':[44.27,-89.61],
  'world':null, 'moskva':[55.76,37.62]
};

const STRIP = /[\u0300-\u036f]/g;
function norm(s){
  return (s||'').toString().toLowerCase().normalize('NFD').replace(STRIP,'')
    .replace(/[^a-z0-9]+/g,' ').trim();
}

// Resolve a station to {lat, lon, tier}. tier: 'exact' | 'region' | 'country' | 'unknown'.
// Does NOT mutate the station's original latitude/longitude — callers add resolved fields.
function resolveLocation(st){
  const lat = st.latitude, lon = st.longitude;
  if (typeof lat==='number' && typeof lon==='number' && !Number.isNaN(lat) && !Number.isNaN(lon)
      && (lat!==0 || lon!==0)){
    return {lat, lon, tier:'exact'};
  }
  // accept string numeric coords too
  const la = parseFloat(lat), lo = parseFloat(lon);
  if (!Number.isNaN(la) && !Number.isNaN(lo) && (la!==0 || lo!==0) && Math.abs(la)<=90 && Math.abs(lo)<=180){
    return {lat:la, lon:lo, tier:'exact'};
  }
  const reg = norm(st.region || st.state);
  if (reg && reg!=='world' && PLACE_CENTROIDS[reg]){
    const [r1,r2]=PLACE_CENTROIDS[reg]; return {lat:r1, lon:r2, tier:'region'};
  }
  const cc = (st.country_code||'').toString().toLowerCase().trim();
  if (cc && COUNTRY_CENTROIDS[cc]){
    const [c1,c2]=COUNTRY_CENTROIDS[cc]; return {lat:c1, lon:c2, tier:'country'};
  }
  return {lat:null, lon:null, tier:'unknown'};
}

module.exports = { COUNTRY_CENTROIDS, PLACE_CENTROIDS, resolveLocation, norm };
