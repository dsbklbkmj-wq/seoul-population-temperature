// ===== 서울 인구 + 집값 시각화 (2005 · 2010 · 2015 · 2020 · 2025) =====

const YEARS = [2005, 2010, 2015, 2020, 2025];
const FIRST_YEAR = YEARS[0];
const LAST_YEAR = YEARS[YEARS.length - 1];
const PRICE_BASE_YEAR = 2010;   // 2005년은 실거래 표본이 너무 적어 '증가율' 기준은 2010년으로 사용
const LOW_SAMPLE_N = 10;

// 전역 변수
let map;
let geoLayer;
let dotLayers = {};
let dotCache = {};
let currentYear = FIRST_YEAR;
let isPlaying = false;
let playInterval;
let displayMode = 'dots'; // dots, choropleth, both
let cohortScale = 10000;
let selectedDistrict = null;

const yearIdx = y => YEARS.indexOf(y);
const prevYearOf = y => (yearIdx(y) > 0 ? YEARS[yearIdx(y) - 1] : null);

// 색상 스케일 (평당가: 500 ~ 10,000만원)
function getPriceColor(price) {
  if (price === null || price === undefined) return '#4a5568';
  const min = 500, max = 10000;
  const ratio = Math.min(1, Math.max(0, (price - min) / (max - min)));
  if (ratio < 0.5) {
    const t = ratio * 2;
    return `rgb(${Math.round(49 + (214 - 49) * t)},${Math.round(130 + (158 - 130) * t)},${Math.round(206 + (46 - 206) * t)})`;
  }
  const t = (ratio - 0.5) * 2;
  return `rgb(${Math.round(214 + (229 - 214) * t)},${Math.round(158 + (62 - 158) * t)},${Math.round(46 + (62 - 46) * t)})`;
}

function formatNumber(n) {
  return n.toLocaleString('ko-KR');
}
function pct(a, b) {          // b 대비 a 의 변화율(%)
  return (a - b) / b * 100;
}
function signed(v, digits = 1) {
  return (v >= 0 ? '+' : '') + v.toFixed(digits) + '%';
}

function totalPop(year) {
  const d = POPULATION_DATA[year];
  return d ? Object.values(d).reduce((a, b) => a + b, 0) : null;
}

// ---------- 점 생성 (폴리곤 안쪽에만, 시점이 바뀌어도 같은 위치 유지) ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function pointInGeometry(lng, lat, geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  return polys.some(poly => {
    if (!pointInRing(lng, lat, poly[0])) return false;
    return !poly.slice(1).some(hole => pointInRing(lng, lat, hole));
  });
}

// 구마다 난수 흐름을 하나로 고정 → 점 개수가 늘면 기존 점은 그대로, 새 점만 추가됨
function getDotPoints(layer, name, count) {
  if (!dotCache[name]) {
    const seed = name.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7);
    dotCache[name] = { pts: [], rng: mulberry32(seed) };
  }
  const cache = dotCache[name];
  const b = layer.getBounds();
  const sw = b.getSouthWest(), ne = b.getNorthEast();
  let attempts = 0;
  while (cache.pts.length < count && attempts < count * 200) {
    const lat = sw.lat + cache.rng() * (ne.lat - sw.lat);
    const lng = sw.lng + cache.rng() * (ne.lng - sw.lng);
    if (pointInGeometry(lng, lat, layer.feature.geometry)) cache.pts.push(L.latLng(lat, lng));
    attempts++;
  }
  return cache.pts.slice(0, count);
}

function updateDots() {
  const popData = POPULATION_DATA[currentYear];
  if (!popData) return;

  Object.values(dotLayers).forEach(layer => map.removeLayer(layer));
  dotLayers = {};
  if (displayMode === 'choropleth') return;

  geoLayer.eachLayer(layer => {
    const name = layer.feature.properties.SIG_KOR_NM;
    const pop = popData[name];
    if (!pop) return;
    const points = getDotPoints(layer, name, Math.round(pop / cohortScale));
    const markers = points.map(p => L.circleMarker(p, {
      radius: 3, fillColor: '#4fd1c5', fillOpacity: 0.8, stroke: false, interactive: false
    }));
    if (markers.length > 0) dotLayers[name] = L.layerGroup(markers).addTo(map);
  });
}

function updateDistrictStyles() {
  if (!geoLayer) return;
  const priceData = PRICE_DATA[currentYear];

  geoLayer.eachLayer(layer => {
    const name = layer.feature.properties.SIG_KOR_NM;
    const price = priceData ? priceData[name] : null;
    let fillColor = 'transparent', fillOpacity = 0;

    if (displayMode === 'choropleth' || displayMode === 'both') {
      fillColor = getPriceColor(price);
      fillOpacity = price === null || price === undefined ? 0.35 : 0.7;   // 자료 없는 구는 회색
    }
    layer.setStyle({ fillColor, fillOpacity, color: '#4a5568', weight: 1.5, opacity: 0.8 });
  });
}

// ---------- 헤드라인 메시지 (데이터에서 직접 계산) ----------
function updateMessage() {
  const popDrop = totalPop(FIRST_YEAR) - totalPop(LAST_YEAR);
  const popPct = pct(totalPop(LAST_YEAR), totalPop(FIRST_YEAR));
  const ratio = SEOUL_STATS[LAST_YEAR].pyeong / SEOUL_STATS[PRICE_BASE_YEAR].pyeong;

  document.getElementById('msgPop').textContent =
    `약 ${(Math.abs(popDrop) / 10000).toFixed(1)}만 명(${popPct.toFixed(1)}%)`;
  document.getElementById('msgPrice').textContent = `약 ${ratio.toFixed(1)}배`;
  document.getElementById('msgNote').textContent =
    `* 인구는 2005→2025, 집값은 2010→2025 기준 (2005년은 실거래 ${SEOUL_STATS[FIRST_YEAR].n}건뿐)`;
}

// ---------- 통계 ----------
function updateStats() {
  const year = currentYear;
  const prev = prevYearOf(year);

  document.getElementById('currentYear').textContent = year;
  document.querySelector('.map-year').textContent = year;

  // 총인구
  const total = totalPop(year);
  document.getElementById('totalPop').textContent = formatNumber(total);
  const popDeltaEl = document.getElementById('popDelta');
  if (prev) {
    const delta = total - totalPop(prev);
    popDeltaEl.textContent = `${delta >= 0 ? '+' : ''}${formatNumber(delta)} (${prev}년 대비)`;
    popDeltaEl.className = 'stat-delta ' + (delta >= 0 ? 'up' : 'down');
  } else {
    popDeltaEl.textContent = '';
  }

  // 서울 평당가 (모든 거래의 ㎡당 중앙값 기준)
  const st = SEOUL_STATS[year];
  document.getElementById('avgPrice').textContent = formatNumber(st.pyeong) + '만';
  const priceDeltaEl = document.getElementById('priceDelta');
  if (prev && SEOUL_STATS[prev].n >= 1000) {
    const delta = st.pyeong - SEOUL_STATS[prev].pyeong;
    priceDeltaEl.textContent = `${delta >= 0 ? '+' : ''}${formatNumber(delta)}만 (${prev}년 대비)`;
    priceDeltaEl.className = 'stat-delta ' + (delta >= 0 ? 'up' : 'down');
  } else {
    priceDeltaEl.textContent = prev ? `(${prev}년은 거래 ${SEOUL_STATS[prev].n}건뿐 → 비교 제외)` : '';
    priceDeltaEl.className = 'stat-delta';
  }

  // 경고 문구
  const warn = document.getElementById('dataWarning');
  warn.textContent = st.n < 1000
    ? `⚠️ ${year}년 실거래는 ${st.n}건(${st.months.replace(/0(\d)/g, '$1')}월)뿐이라 참고용입니다. 구별 표본이 매우 작습니다.`
    : `✔ ${year}년 실거래 ${formatNumber(st.n)}건 기준`;

  // 슬라이더 · 이벤트 하이라이트
  document.getElementById('yearSlider').value = yearIdx(year);
  document.querySelectorAll('#sliderTicks span').forEach(el =>
    el.classList.toggle('active', parseInt(el.dataset.idx) === yearIdx(year)));
  document.querySelectorAll('.event').forEach(el =>
    el.classList.toggle('active', parseInt(el.dataset.year) === year));
}

// ---------- 툴팁 ----------
function priceRowHtml(name, year) {
  const price = PRICE_DATA[year]?.[name];
  const det = PRICE_DETAIL[year]?.[name];
  if (price === null || price === undefined) {
    return `<div class="tt-row"><span class="tt-label">평당가</span>
      <span class="tt-value" style="color:#a0aec0">거래 자료 없음</span></div>`;
  }
  const low = det && det.low
    ? ` <span style="color:#f6ad55">(${det.n}건·참고)</span>`
    : ` <span style="color:#a0aec0">(${formatNumber(det.n)}건)</span>`;
  return `<div class="tt-row"><span class="tt-label">평당가</span>
    <span class="tt-value">${formatNumber(price)}만원${low}</span></div>`;
}

function createTooltipContent(name) {
  const meta = DISTRICT_META[name] || {};
  const pop = POPULATION_DATA[currentYear]?.[name];
  const prev = prevYearOf(currentYear);
  const prevPop = prev ? POPULATION_DATA[prev]?.[name] : null;
  const area = meta.area || 0;

  let html = `<div class="district-tooltip"><h3>${name}</h3>`;

  if (pop) {
    const density = area > 0 ? Math.round(pop / area) : 0;
    const ratio = ((pop / totalPop(currentYear)) * 100).toFixed(1);
    html += `
    <div class="tt-row"><span class="tt-label">인구</span><span class="tt-value">${formatNumber(pop)}명</span></div>
    <div class="tt-row"><span class="tt-label">밀도</span><span class="tt-value">${formatNumber(density)}명/km²</span></div>
    <div class="tt-row"><span class="tt-label">서울 비중</span><span class="tt-value">${ratio}%</span></div>`;
    if (prevPop) {
      const delta = pop - prevPop;
      html += `<div class="tt-row"><span class="tt-label">${prev}년 대비</span>
        <span class="tt-value tt-delta ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '+' : ''}${formatNumber(delta)}</span></div>`;
    }
    html += `<div class="tt-row"><span class="tt-label">표시 점</span>
      <span class="tt-value">${formatNumber(Math.round(pop / cohortScale))}개</span></div>`;
  }

  html += priceRowHtml(name, currentYear);
  html += '</div>';
  return html;
}

// ---------- 상세 패널 ----------
function openDetailPanel(name) {
  selectedDistrict = name;
  const meta = DISTRICT_META[name] || {};
  const panel = document.getElementById('detailPanel');

  document.getElementById('detailTitle').textContent = name;
  document.getElementById('detailPeriod').textContent = meta.period || '';
  document.getElementById('detailStory').textContent = meta.story || '';

  const pop = POPULATION_DATA[currentYear]?.[name] || 0;
  const price = PRICE_DATA[currentYear]?.[name];
  const det = PRICE_DETAIL[currentYear]?.[name];
  const area = meta.area || 1;

  document.getElementById('detailPop').textContent = formatNumber(pop) + '명';
  document.getElementById('detailDensity').textContent = formatNumber(Math.round(pop / area)) + '명/km²';
  document.getElementById('detailPrice').textContent = (price === null || price === undefined)
    ? '거래 자료 없음'
    : `${formatNumber(price)}만원 · ${formatNumber(det.n)}건${det.low ? '(참고)' : ''}`;

  // 변화: 인구는 2005→2025, 집값은 2010→2025 (2005년은 표본 부족)
  const popChange = pct(POPULATION_DATA[LAST_YEAR][name], POPULATION_DATA[FIRST_YEAR][name]);
  const p0 = PRICE_DATA[PRICE_BASE_YEAR][name], p1 = PRICE_DATA[LAST_YEAR][name];
  const priceChange = (p0 && p1) ? pct(p1, p0) : null;
  document.getElementById('detailChange').innerHTML =
    `인구 ${signed(popChange)} <small>(2005→25)</small><br>` +
    (priceChange === null ? '집값 -' : `집값 ${signed(priceChange, 0)} <small>(2010→25)</small>`);

  const naverCode = meta.naver || '1168000000';
  document.getElementById('naverLink').href =
    `https://land.naver.com/article/divisionInfo.naver?rletTypeCd=A01&cortarNo=${naverCode}`;
  document.getElementById('hogang').href = `https://hogangnono.com/region/${naverCode.slice(0, 5)}`;

  // 뉴스 검색: 해당 구 + 아파트 + 현재 시점(해당 연도 1/1~12/31로 기간 제한)
  const q = encodeURIComponent(`${name} 아파트`);
  const ds = `${currentYear}.01.01`, de = `${currentYear}.12.31`;
  document.getElementById('newsLink').href =
    `https://search.naver.com/search.naver?where=news&query=${q}&ds=${ds}&de=${de}` +
    `&nso=so%3Ar%2Cp%3Afrom${currentYear}0101to${currentYear}1231`;
  document.getElementById('newsLabel').textContent = `${currentYear}년 ${name} 아파트 뉴스`;

  document.getElementById('oldPhotoSection').style.display = meta.highlight ? 'block' : 'none';

  drawMiniCharts(name);
  panel.classList.add('open');
}

// 5개 점을 이은 미니 차트
function drawSeries(canvasId, values, color, hollowFlags) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 280, 120);

  const valid = values.filter(v => v !== null && v !== undefined);
  const max = Math.max(...valid), min = Math.min(...valid);
  const xs = YEARS.map((_, i) => 20 + (i / (YEARS.length - 1)) * 240);
  const ys = values.map(v => (v === null || v === undefined) ? null : 90 - ((v - min) / (max - min || 1)) * 65);

  // 선 (null 은 건너뛰고 이어서)
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
  let started = false;
  ys.forEach((y, i) => {
    if (y === null) return;
    if (!started) { ctx.moveTo(xs[i], y); started = true; } else ctx.lineTo(xs[i], y);
  });
  ctx.stroke();

  // 점 + 라벨
  ctx.font = '10px Pretendard, sans-serif';
  ctx.textAlign = 'center';
  YEARS.forEach((y, i) => {
    const isCur = y === currentYear;
    if (ys[i] !== null) {
      ctx.beginPath();
      ctx.arc(xs[i], ys[i], isCur ? 5 : 3, 0, Math.PI * 2);
      if (hollowFlags && hollowFlags[i]) {
        ctx.fillStyle = '#1a202c'; ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
      } else {
        ctx.fillStyle = color; ctx.fill();
      }
    }
    ctx.fillStyle = isCur ? '#e2e8f0' : '#a0aec0';
    ctx.fillText(String(y), xs[i], 114);
  });
}

function drawMiniCharts(name) {
  drawSeries('popChart', YEARS.map(y => POPULATION_DATA[y][name]), '#4fd1c5');
  drawSeries('priceChart', YEARS.map(y => PRICE_DATA[y][name]), '#f6ad55',
    YEARS.map(y => !!PRICE_DETAIL[y][name].low));
}

// ---------- 시점 이동 ----------
function setYear(year) {
  if (!YEARS.includes(year)) return;
  currentYear = year;
  updateStats();
  updateDistrictStyles();
  updateDots();
  if (selectedDistrict) openDetailPanel(selectedDistrict);
}
function stepYear(dir) {
  const i = Math.max(0, Math.min(YEARS.length - 1, yearIdx(currentYear) + dir));
  setYear(YEARS[i]);
}

function togglePlay() {
  isPlaying = !isPlaying;
  const btn = document.getElementById('playBtn');
  btn.textContent = isPlaying ? '■' : '▶';
  btn.classList.toggle('playing', isPlaying);

  if (isPlaying) {
    const speed = parseInt(document.getElementById('speedSelect').value);
    playInterval = setInterval(() => {
      setYear(currentYear >= LAST_YEAR ? FIRST_YEAR : YEARS[yearIdx(currentYear) + 1]);
    }, speed);
  } else {
    clearInterval(playInterval);
  }
}
function stopPlay() { if (isPlaying) togglePlay(); }

// ---------- 초기화 ----------
async function init() {
  map = L.map('map', { center: [37.5665, 126.9780], zoom: 11, zoomControl: false, attributionControl: true });
  map.attributionControl.setPrefix(false);

  // 배경지도: Esri 다크 그레이 (API 키 불필요). 타일이 막히면 배경지도 없이 구 경계만 표시
  const baseLayer = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 16, attribution: 'Tiles © Esri' }
  ).addTo(map);
  let tileErrors = 0;
  baseLayer.on('tileerror', () => {
    if (++tileErrors >= 6 && map.hasLayer(baseLayer)) map.removeLayer(baseLayer);
  });

  updateMessage();

  try {
    const response = await fetch(
      'https://cdn.jsdelivr.net/gh/southkorea/seoul-maps@master/juso/2015/json/seoul_municipalities_geo_simple.json'
    );
    const geoData = await response.json();

    geoLayer = L.geoJSON(geoData, {
      style: { fillColor: 'transparent', fillOpacity: 0, color: '#4a5568', weight: 1.5, opacity: 0.8 },
      onEachFeature: (feature, layer) => {
        const name = feature.properties.SIG_KOR_NM;
        layer.bindTooltip(() => createTooltipContent(name), { sticky: true, className: '' });
        layer.on('click', () => openDetailPanel(name));
        layer.on('mouseover', () => layer.setStyle({ weight: 3, color: '#4fd1c5' }));
        layer.on('mouseout', () => layer.setStyle({ weight: 1.5, color: '#4a5568' }));
      }
    }).addTo(map);

    updateStats();
    updateDistrictStyles();
    updateDots();
  } catch (error) {
    console.error('GeoJSON 로드 실패:', error);
    alert('지도 데이터를 불러오지 못했습니다. 인터넷 연결을 확인해주세요.');
  }

  // 슬라이더(0~4) · 눈금 클릭
  document.getElementById('yearSlider').addEventListener('input', e => {
    stopPlay();
    setYear(YEARS[parseInt(e.target.value)]);
  });
  document.querySelectorAll('#sliderTicks span').forEach(el =>
    el.addEventListener('click', () => { stopPlay(); setYear(YEARS[parseInt(el.dataset.idx)]); }));

  document.getElementById('playBtn').addEventListener('click', togglePlay);
  document.getElementById('prevBtn').addEventListener('click', () => { stopPlay(); stepYear(-1); });
  document.getElementById('nextBtn').addEventListener('click', () => { stopPlay(); stepYear(1); });

  document.getElementById('speedSelect').addEventListener('change', () => {
    if (isPlaying) { togglePlay(); togglePlay(); }
  });

  document.getElementById('scaleSelect').addEventListener('change', e => {
    cohortScale = parseInt(e.target.value);
    document.getElementById('scaleLabel').textContent = formatNumber(cohortScale);
    updateDots();
  });

  document.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      displayMode = btn.dataset.mode;
      document.getElementById('dotLegend').style.display =
        (displayMode === 'dots' || displayMode === 'both') ? 'block' : 'none';
      document.getElementById('colorLegend').style.display =
        (displayMode === 'choropleth' || displayMode === 'both') ? 'block' : 'none';
      updateDistrictStyles();
      updateDots();
    });
  });

  document.querySelectorAll('.event').forEach(el =>
    el.addEventListener('click', () => { stopPlay(); setYear(parseInt(el.dataset.year)); }));

  document.getElementById('zoomIn').addEventListener('click', () => map.zoomIn());
  document.getElementById('zoomOut').addEventListener('click', () => map.zoomOut());
  document.getElementById('zoomReset').addEventListener('click', () => map.setView([37.5665, 126.9780], 11));

  document.getElementById('closeDetail').addEventListener('click', () => {
    document.getElementById('detailPanel').classList.remove('open');
    selectedDistrict = null;
  });

  document.addEventListener('keydown', e => {
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'ArrowLeft') { stopPlay(); stepYear(-1); }
    else if (e.code === 'ArrowRight') { stopPlay(); stepYear(1); }
    else if (e.code === 'Escape') {
      document.getElementById('detailPanel').classList.remove('open');
      selectedDistrict = null;
    }
  });
}

init();
