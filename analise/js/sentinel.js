// ---------- Sentinel-2 (imagem mais recente e NDVI) ----------
// Fonte: serviço público Esri "Sentinel-2 Views" (Copernicus/ESA via AWS), atualizado diariamente com os últimos 14 meses, 10 m.
// Mosaico: a cena mais recente com até 10% de nuvens em cada ponto.
const S2_URL = 'https://sentinel.arcgis.com/arcgis/rest/services/Sentinel2/ImageServer';
const S2_MOSAICO = { mosaicMethod: 'esriMosaicAttribute', sortField: 'acquisitiondate', sortValue: '2099/12/31', ascending: true,
    where: 'category = 1 AND cloudcover <= 0.1', mosaicOperation: 'MT_FIRST' };
const S2_REGRAS = { cor: 'Natural Color with DRA', ndvi: 'NDVI Colormap', ndviRaw: 'NDVI Raw' };
const S2_CAMADAS = [
    { id: 's2-cor', tipo: 's2', regra: 'cor', secao: 'Satélite recente (Sentinel-2)', nome: 'Imagem Sentinel-2 mais recente (cor natural, 10 m)', opacidade: 1,
      fonte: 'Copernicus Sentinel-2 (ESA/Comissão Europeia) via Esri/AWS – cena mais recente com até 10% de nuvens em cada ponto, últimos 14 meses.' },
    { id: 's2-ndvi', tipo: 's2', regra: 'ndvi', secao: 'Satélite recente (Sentinel-2)', nome: 'NDVI recente – vigor da vegetação (Sentinel-2)', opacidade: 0.85,
      legenda_itens: [{ rotulo: 'solo exposto / água', cor: '#a50026' }, { rotulo: 'vegetação rala ou seca', cor: '#fdae61' }, { rotulo: 'vegetação moderada', cor: '#d9ef8b' }, { rotulo: 'vegetação densa e vigorosa', cor: '#1a9850' }],
      fonte: 'NDVI do Sentinel-2: quanto mais verde, mais folha viva. Mesma imagem recente da camada em cor natural.' }];
const s2q = o => encodeURIComponent(JSON.stringify(o));
const s2Tiles = regra => `${S2_URL}/exportImage?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=jpgpng&f=image&renderingRule=${s2q({ rasterFunction: S2_REGRAS[regra] })}&mosaicRule=${s2q(S2_MOSAICO)}`;
function s2AdicionarCamadas(dados) {   // acrescenta as camadas Sentinel-2 em qualquer município
    dados.camadas_opcionais = dados.camadas_opcionais || [];
    for (const c of S2_CAMADAS) if (!dados.camadas_opcionais.some(o => o.id === c.id)) dados.camadas_opcionais.push({ ...c });
}
function s2Desenhar(o, antes) {
    map.addSource(`op-${o.id}`, { type: 'raster', tiles: [s2Tiles(o.regra)], tileSize: 256, minzoom: 8, maxzoom: 17,
        attribution: 'Sentinel-2 © Copernicus/ESA · Esri' });
    map.addLayer({ id: `op-${o.id}`, type: 'raster', source: `op-${o.id}`, paint: { 'raster-opacity': o.opacidade ?? 1 } }, antes);
    s2DataRecente(map.getBounds().toArray().flat()).then(d => { if (!d) return; const el = document.querySelector(`.camada-row[data-id="${o.id}"] .camada-nome`);
        if (el && !/até \d/.test(el.textContent)) el.textContent += ` – até ${d.toLocaleDateString('pt-BR')}`; }).catch(() => { });
}
async function s2Cenas(bbox4326, n = 5) {   // cenas sem nuvem mais recentes na área
    const [w, s, e, nn] = bbox4326;
    const p = new URLSearchParams({ where: S2_MOSAICO.where, geometry: JSON.stringify({ xmin: w, ymin: s, xmax: e, ymax: nn, spatialReference: { wkid: 4326 } }), geometryType: 'esriGeometryEnvelope',
        inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: 'acquisitiondate,cloudcover,name', orderByFields: 'acquisitiondate DESC', resultRecordCount: n, returnGeometry: 'false', f: 'json' });
    const r = await (await fetch(`${S2_URL}/query?${p}`)).json();
    return (r.features || []).map(f => ({ data: new Date(f.attributes.acquisitiondate), nuvens: f.attributes.cloudcover, nome: f.attributes.name }));
}
async function s2DataRecente(bbox) { const c = await s2Cenas(bbox, 1); return c[0]?.data || null; }
function s2LinkCopernicus(lng, lat, data, ndvi) {   // abre o Copernicus Browser no imóvel (Sentinel-2 L2A)
    const d = data || new Date(), ini = new Date(d - 30 * 864e5), iso = x => x.toISOString().slice(0, 10);
    const p = new URLSearchParams({ zoom: '14', lat: lat.toFixed(5), lng: lng.toFixed(5), themeId: 'DEFAULT-THEME', datasetId: 'S2_L2A_CDAS',
        fromTime: `${iso(ini)}T00:00:00.000Z`, toTime: `${iso(d)}T23:59:59.999Z`, layerId: ndvi ? '3_NDVI' : '1_TRUE_COLOR' });
    return `https://browser.dataspace.copernicus.eu/?${p}`;
}
// imagem do imóvel para o relatório: Sentinel-2 + perímetro em vermelho
async function s2Foto(alvo, regra, px = 900) {
    const bb = turf.bbox(alvo), m = Math.max(bb[2] - bb[0], bb[3] - bb[1]) * 0.12;
    const merc = ([x, y]) => [x * 20037508.34 / 180, Math.log(Math.tan((90 + y) * Math.PI / 360)) * 6378137];
    let [x0, y0] = merc([bb[0] - m, bb[1] - m]), [x1, y1] = merc([bb[2] + m, bb[3] + m]);
    const wM = x1 - x0, hM = y1 - y0, W = px, H = Math.round(px * Math.min(1.2, Math.max(0.55, hM / wM)));
    // ajusta a caixa à proporção da imagem
    const esc = Math.max(wM / W, hM / H), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2; x0 = cx - W * esc / 2; x1 = cx + W * esc / 2; y0 = cy - H * esc / 2; y1 = cy + H * esc / 2;
    const url = `${S2_URL}/exportImage?bbox=${x0},${y0},${x1},${y1}&bboxSR=3857&imageSR=3857&size=${W},${H}&format=jpgpng&f=image&renderingRule=${s2q({ rasterFunction: S2_REGRAS[regra] })}&mosaicRule=${s2q(S2_MOSAICO)}`;
    const blob = await (await fetch(url)).blob(), img = await createImageBitmap(blob);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
    g.drawImage(img, 0, 0, W, H);
    const pt = c => { const [x, y] = merc(c); return [(x - x0) / (x1 - x0) * W, (y1 - y) / (y1 - y0) * H]; };
    g.lineJoin = 'round';
    for (const f of turf.flatten(alvo).features) for (const anel of f.geometry.coordinates) {
        g.beginPath(); anel.forEach((c, i) => { const [x, y] = pt(c); i ? g.lineTo(x, y) : g.moveTo(x, y); });
        g.closePath(); g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 6; g.stroke(); g.strokeStyle = '#ff1744'; g.lineWidth = 3; g.stroke();
    }
    return cv.toDataURL('image/jpeg', 0.88);
}
async function s2EstatNdvi(alvo) {   // NDVI médio e distribuição por classes dentro do perímetro
    const f = turf.flatten(alvo).features.sort((a, b) => turf.area(b) - turf.area(a))[0];
    const merc = ([x, y]) => [x * 20037508.34 / 180, Math.log(Math.tan((90 + y) * Math.PI / 360)) * 6378137];
    const geom = { rings: f.geometry.coordinates.map(an => an.map(merc)), spatialReference: { wkid: 3857 } };
    const p = new URLSearchParams({ geometry: JSON.stringify(geom), geometryType: 'esriGeometryPolygon', renderingRule: JSON.stringify({ rasterFunction: S2_REGRAS.ndviRaw }),
        mosaicRule: JSON.stringify(S2_MOSAICO), pixelSize: '10', f: 'json' });
    const r = await (await fetch(`${S2_URL}/computeStatisticsHistograms`, { method: 'POST', body: p })).json();
    const st = r.statistics?.[0], h = r.histograms?.[0]; if (!st || !h) return null;
    const passo = (h.max - h.min) / h.size, cls = [[-1, 0.2, 'Solo exposto, palha ou água'], [0.2, 0.4, 'Vegetação rala ou seca'], [0.4, 0.6, 'Vegetação moderada'], [0.6, 1.01, 'Vegetação densa e vigorosa']];
    const tot = h.counts.reduce((a, b) => a + b, 0) || 1;
    const dist = cls.map(([a, b, nome]) => ({ nome, pct: 100 * h.counts.reduce((s, c, i) => { const v = h.min + (i + 0.5) * passo; return s + (v >= a && v < b ? c : 0); }, 0) / tot }));
    return { media: st.mean, mediana: st.median, min: st.min, max: st.max, dist };
}
async function s2DadosRelatorio(alvo) {
    const bb = turf.bbox(alvo), [lng, lat] = turf.centroid(alvo).geometry.coordinates;
    const [cenas, cor, ndvi, est] = await Promise.all([s2Cenas(bb, 6).catch(() => []), s2Foto(alvo, 'cor').catch(() => null), s2Foto(alvo, 'ndvi').catch(() => null), s2EstatNdvi(alvo).catch(() => null)]);
    const data = cenas[0]?.data || null;
    return { cenas, data, cor, ndvi, est, link: s2LinkCopernicus(lng, lat, data, false), linkNdvi: s2LinkCopernicus(lng, lat, data, true) };
}
function s2Html(s) {
    if (!s || (!s.cor && !s.ndvi)) return '<p class="hint">Imagem Sentinel-2 indisponível no momento.</p>';
    const d = s.data ? s.data.toLocaleDateString('pt-BR') : '–', cores = ['#a50026', '#fdae61', '#d9ef8b', '#1a9850'];
    const leitura = !s.est ? '' : s.est.media >= 0.6 ? 'vegetação densa e vigorosa na maior parte do imóvel' : s.est.media >= 0.4 ? 'cobertura vegetal moderada (lavoura em desenvolvimento, pastagem ou mata mista)' : s.est.media >= 0.2 ? 'vegetação rala ou seca em boa parte do imóvel (entressafra, pasto degradado ou palhada)' : 'predomínio de solo exposto, palhada ou água';
    return `<div class="s2-cds"><div><span>Cena mais recente sem nuvens</span><b>${d}</b></div><div><span>NDVI médio do imóvel</span><b>${s.est ? s.est.media.toFixed(2).replace('.', ',') : '–'}</b></div>
        <div><span>Leitura</span><b class="s2-leit">${leitura || '–'}</b></div></div>
      <div class="s2-duas">${s.cor ? `<figure><img class="mapa" src="${s.cor}" alt="Sentinel-2 cor natural"><figcaption>Cor natural (Sentinel-2, 10 m)</figcaption></figure>` : ''}${s.ndvi ? `<figure><img class="mapa" src="${s.ndvi}" alt="NDVI"><figcaption>NDVI – vigor da vegetação</figcaption></figure>` : ''}</div>
      ${s.est ? `<h4>Vegetação dentro do perímetro (NDVI)</h4>${s.est.dist.map((c, i) => `<div class="br"><span>${c.nome}</span><i><em style="width:${Math.min(100, c.pct)}%;background:${cores[i]}"></em></i><b>${c.pct.toFixed(1).replace('.', ',')}%</b></div>`).join('')}` : ''}
      ${s.cenas.length > 1 ? `<p class="hint">Outras cenas sem nuvens recentes: ${s.cenas.slice(1).map(c => c.data.toLocaleDateString('pt-BR')).filter((v, i, a) => a.indexOf(v) === i).join(' · ')}.</p>` : ''}
      <p class="hint">Mosaico da cena mais recente com até 10% de nuvens em cada ponto (Copernicus Sentinel-2, via Esri). Para comparar outras datas: <a href="${s.link}">abrir no Copernicus Browser (cor natural)</a> · <a href="${s.linkNdvi}">NDVI</a>.</p>`;
}
