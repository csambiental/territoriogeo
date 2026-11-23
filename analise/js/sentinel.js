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
      legenda_itens: [{ rotulo: 'solo exposto, palha ou água', cor: '#b5651d' }, { rotulo: 'vegetação rala ou seca', cor: '#e8d84a' }, { rotulo: 'vegetação moderada', cor: '#a6c93a' }, { rotulo: 'vegetação densa e vigorosa', cor: '#2f8f2f' }],
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
const HR_TILE = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile';
// monta a imagem de alta resolução com as telhas do Esri World Imagery (mesmas do mapa) e recorta a caixa pedida
async function hrMosaico(g, x0, y0, x1, y1, W, H) {
    const R = 20037508.342789244, res = (x1 - x0) / W;
    const z = Math.max(1, Math.min(17, Math.ceil(Math.log2(2 * R / 256 / res))));   // no interior, acima do zoom 17 o Esri costuma não ter imagem
    const t = 2 * R / 2 ** z, c0 = Math.floor((x0 + R) / t), c1 = Math.floor((x1 + R) / t), l0 = Math.floor((R - y1) / t), l1 = Math.floor((R - y0) / t);
    const sx = W / (x1 - x0), sy = H / (y1 - y0), jobs = [];
    for (let l = l0; l <= l1; l++) for (let c = c0; c <= c1; c++) jobs.push((async () => {
        try { const im = await createImageBitmap(await (await fetch(`${HR_TILE}/${z}/${l}/${c}`)).blob());
            const tx = c * t - R, ty = R - l * t; g.drawImage(im, (tx - x0) * sx, (y1 - ty) * sy, t * sx + 0.5, t * sy + 0.5); } catch (e) { }
    })());
    await Promise.all(jobs);
}
// realce de contraste (corta 2% de cada ponta em cada canal) – a cor natural do Sentinel sai escura em áreas pequenas
function s2Realce(g, W, H) {
    const d = g.getImageData(0, 0, W, H), px = d.data, lim = [];
    for (let c = 0; c < 3; c++) { const h = new Array(256).fill(0); let n = 0; for (let i = c; i < px.length; i += 4) if (px[i + 3]) { h[px[i]]++; n++; }
        let a = 0, lo = 0, hi = 255; for (let v = 0; v < 256; v++) { a += h[v]; if (a <= n * 0.02) lo = v; if (a <= n * 0.98) hi = v; } lim.push([lo, Math.max(lo + 1, hi)]); }
    for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) { const [lo, hi] = lim[c]; px[i + c] = Math.max(0, Math.min(255, (px[i + c] - lo) / (hi - lo) * 255)); }
    g.putImageData(d, 0, 0);
}
// base: 'hr' desenha a imagem de alta resolução (Esri World Imagery) por baixo; alfa: transparência do Sentinel sobre ela
async function s2Foto(alvo, regra, px = 900, base = null, alfa = 1, realce = false) {
    const bb = turf.bbox(alvo), m = Math.max(bb[2] - bb[0], bb[3] - bb[1]) * 0.12;
    const merc = ([x, y]) => [x * 20037508.34 / 180, Math.log(Math.tan((90 + y) * Math.PI / 360)) * 6378137];
    let [x0, y0] = merc([bb[0] - m, bb[1] - m]), [x1, y1] = merc([bb[2] + m, bb[3] + m]);
    const wM = x1 - x0, hM = y1 - y0, W = px, H = Math.round(px * Math.min(1.2, Math.max(0.55, hM / wM)));
    // ajusta a caixa à proporção da imagem
    const esc = Math.max(wM / W, hM / H), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2; x0 = cx - W * esc / 2; x1 = cx + W * esc / 2; y0 = cy - H * esc / 2; y1 = cy + H * esc / 2;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
    if (base === 'hr') await hrMosaico(g, x0, y0, x1, y1, W, H);
    if (regra) {
        const url = `${S2_URL}/exportImage?bbox=${x0},${y0},${x1},${y1}&bboxSR=3857&imageSR=3857&size=${W},${H}&format=jpgpng&f=image&renderingRule=${s2q({ rasterFunction: S2_REGRAS[regra] })}&mosaicRule=${s2q(S2_MOSAICO)}`;
        const img = await createImageBitmap(await (await fetch(url)).blob());
        g.globalAlpha = alfa; g.drawImage(img, 0, 0, W, H); g.globalAlpha = 1;
        if (realce) s2Realce(g, W, H);
    }
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
    const passo = (h.max - h.min) / h.size, cls = [[-1, 0.15, 'Solo exposto, palha ou água'], [0.15, 0.3, 'Vegetação rala ou seca'], [0.3, 0.45, 'Vegetação moderada'], [0.45, 1.01, 'Vegetação densa e vigorosa']];   // limites ajustados ao NDVI deste serviço (reflectância de topo da atmosfera)
    const tot = h.counts.reduce((a, b) => a + b, 0) || 1;
    const dist = cls.map(([a, b, nome]) => ({ nome, pct: 100 * h.counts.reduce((s, c, i) => { const v = h.min + (i + 0.5) * passo; return s + (v >= a && v < b ? c : 0); }, 0) / tot }));
    return { media: st.mean, mediana: st.median, min: st.min, max: st.max, dist };
}
async function s2DadosRelatorio(alvo) {
    const bb = turf.bbox(alvo), [lng, lat] = turf.centroid(alvo).geometry.coordinates;
    const ha = turf.area(alvo) / 1e4, peq = ha < 50;
    const [cenas, hr, cor, ndvi, est] = await Promise.all([s2Cenas(bb, 6).catch(() => []), s2Foto(alvo, null, 900, 'hr').catch(() => null), s2Foto(alvo, 'cor', 600, null, 1, true).catch(() => null),
        (peq ? s2Foto(alvo, 'ndvi', 900, 'hr', 0.55) : s2Foto(alvo, 'ndvi')).catch(() => null), s2EstatNdvi(alvo).catch(() => null)]);
    const data = cenas[0]?.data || null;
    return { cenas, data, hr, cor, ndvi, est, ndviSobre: peq, link: s2LinkCopernicus(lng, lat, data, false), linkNdvi: s2LinkCopernicus(lng, lat, data, true) };
}
function s2Html(s) {
    if (!s || (!s.cor && !s.ndvi)) return '<p class="hint">Imagem Sentinel-2 indisponível no momento.</p>';
    const d = s.data ? s.data.toLocaleDateString('pt-BR') : '–', cores = ['#b5651d', '#e8d84a', '#a6c93a', '#2f8f2f'];
    const leitura = !s.est ? '' : s.est.media >= 0.45 ? 'vegetação densa e vigorosa na maior parte do imóvel' : s.est.media >= 0.3 ? 'cobertura vegetal moderada (lavoura em desenvolvimento, pastagem ou mata mista)' : s.est.media >= 0.15 ? 'vegetação rala ou seca em boa parte do imóvel (entressafra, pasto degradado ou palhada)' : 'predomínio de solo exposto, palhada ou água';
    return `<div class="s2-cds"><div><span>Cena mais recente sem nuvens</span><b>${d}</b></div><div><span>NDVI médio do imóvel</span><b>${s.est ? s.est.media.toFixed(2).replace('.', ',') : '–'}</b></div>
        <div><span>Leitura</span><b class="s2-leit">${leitura || '–'}</b></div></div>
      <div class="s2-duas">${s.hr ? `<figure><img class="mapa" src="${s.hr}" alt="Imagem de alta resolução"><figcaption>Alta resolução (Esri World Imagery, menos de 1 m) – a data da foto varia e pode ter meses ou anos</figcaption></figure>` : s.cor ? `<figure><img class="mapa" src="${s.cor}" alt="Sentinel-2 cor natural"><figcaption>Cor natural (Sentinel-2, 10 m)</figcaption></figure>` : ''}${s.ndvi ? `<figure><img class="mapa" src="${s.ndvi}" alt="NDVI"><figcaption>NDVI em ${d} – vigor da vegetação${s.ndviSobre ? ', sobre a imagem de alta resolução' : ''}</figcaption></figure>` : ''}</div>
      ${s.hr && s.cor ? `<div class="s2-hoje"><img src="${s.cor}" alt="Sentinel-2 cor natural"><div><b>Como estava em ${d}</b><span>Sentinel-2 em cor natural (10 m por pixel, contraste realçado). Menos nítida, mas é a foto mais recente: serve para conferir se houve mudança em relação à imagem de alta resolução – colheita, plantio, abertura de área, obras.</span></div></div>` : ''}
      ${s.est ? `<h4>Vegetação dentro do perímetro (NDVI)</h4>${s.est.dist.map((c, i) => `<div class="br"><span>${c.nome}</span><i><em style="width:${Math.min(100, c.pct)}%;background:${cores[i]}"></em></i><b>${c.pct.toFixed(1).replace('.', ',')}%</b></div>`).join('')}` : ''}
      ${s.cenas.length > 1 ? `<p class="hint">Outras cenas sem nuvens recentes: ${s.cenas.slice(1).map(c => c.data.toLocaleDateString('pt-BR')).filter((v, i, a) => a.indexOf(v) === i).join(' · ')}.</p>` : ''}
      <p class="hint">Mosaico da cena mais recente com até 10% de nuvens em cada ponto (Copernicus Sentinel-2, via Esri). Para comparar outras datas: <a href="${s.link}">abrir no Copernicus Browser (cor natural)</a> · <a href="${s.linkNdvi}">NDVI</a>.</p>`;
}

// ---------- série histórica do NDVI (Landsat 8/9, via Esri; sem conta) ----------
const LS_URL = 'https://landsat2.arcgis.com/arcgis/rest/services/Landsat/MS/ImageServer';
async function lsNdviAno(alvo, ano) {
    const g = turf.simplify(alvo, { tolerance: 0.0002, highQuality: false });
    const rings = g.geometry.type === 'Polygon' ? g.geometry.coordinates : g.geometry.coordinates.flat();
    // mesma estação todo ano (maio a setembro, mais seca e com menos nuvens no PR) e a cena menos nublada
    const where = `Category = 1 AND CloudCover >= 0 AND CloudCover < 0.2 AND AcquisitionDate >= date '${ano}-05-01' AND AcquisitionDate <= date '${ano}-09-30'`;
    const p = new URLSearchParams({ geometry: JSON.stringify({ rings, spatialReference: { wkid: 4326 } }), geometryType: 'esriGeometryPolygon',
        mosaicRule: JSON.stringify({ mosaicMethod: 'esriMosaicAttribute', sortField: 'CloudCover', sortValue: '0', ascending: true, where }),
        renderingRule: JSON.stringify({ rasterFunction: 'NDVI Raw' }), pixelSize: JSON.stringify({ x: 30, y: 30, spatialReference: { wkid: 102100 } }), f: 'json' });
    const r = await (await fetch(`${LS_URL}/computeStatisticsHistograms?${p}`)).json();
    const m = r && r.statistics && r.statistics[0] && r.statistics[0].mean;
    return typeof m === 'number' && m !== 0 ? { ano, ndvi: m } : null;
}
async function lsSerieNdvi(alvo) {
    const fim = new Date().getFullYear(), anos = []; for (let a = 2013; a <= fim; a++) anos.push(a);
    const out = [];
    for (let i = 0; i < anos.length; i += 4) out.push(...await Promise.all(anos.slice(i, i + 4).map(a => lsNdviAno(alvo, a).catch(() => null))));
    return out.filter(Boolean);
}
function lsSerieSvg(s, larg = 640, alt = 190) {
    if (!s || s.length < 2) return '';
    const x0 = 44, x1 = larg - 16, y0 = 16, y1 = alt - 34, a0 = s[0].ano, a1 = s[s.length - 1].ano;
    const X = a => x0 + (a - a0) / Math.max(1, a1 - a0) * (x1 - x0), Y = v => y1 - Math.max(0, Math.min(0.9, v)) / 0.9 * (y1 - y0);
    const pts = s.map(p => `${X(p.ano).toFixed(1)},${Y(p.ndvi).toFixed(1)}`).join(' ');
    const faixas = [[0.45, 0.9, '#2f8f2f'], [0.3, 0.45, '#a6c93a'], [0.15, 0.3, '#e8d84a'], [0, 0.15, '#b5651d']];
    return `<svg viewBox="0 0 ${larg} ${alt}" width="100%" role="img" aria-label="Série histórica do NDVI do imóvel" style="font:11px Arial">
      ${faixas.map(([a, b, c]) => `<rect x="${x0}" y="${Y(b)}" width="${x1 - x0}" height="${Y(a) - Y(b)}" fill="${c}" opacity=".12"/>`).join('')}
      ${[0, 0.3, 0.6, 0.9].map(v => `<line x1="${x0}" x2="${x1}" y1="${Y(v)}" y2="${Y(v)}" stroke="#d6dbd7"/><text x="${x0 - 6}" y="${Y(v) + 4}" text-anchor="end" fill="#5f6d66">${v.toFixed(1).replace('.', ',')}</text>`).join('')}
      <polyline points="${pts}" fill="none" stroke="#1f4933" stroke-width="2.2"/>
      ${s.map(p => `<circle cx="${X(p.ano)}" cy="${Y(p.ndvi)}" r="3.2" fill="#1f4933"/><text x="${X(p.ano)}" y="${alt - 16}" text-anchor="middle" fill="#5f6d66">${String(p.ano).slice(2)}</text>`).join('')}
      <text x="${x0}" y="${alt - 2}" fill="#5f6d66">ano (20xx) · NDVI médio do imóvel entre maio e setembro</text></svg>`;
}
function lsSerieHtml(s) {
    if (!s || s.length < 2) return '<p class="hint">Série histórica do NDVI indisponível no momento.</p>';
    const ini = s[0], fim = s[s.length - 1], dif = fim.ndvi - ini.ndvi, min = s.reduce((a, b) => b.ndvi < a.ndvi ? b : a);
    const leitura = Math.abs(dif) < 0.05 ? 'vigor da vegetação estável no período' : dif > 0 ? 'aumento do vigor da vegetação no período (regeneração ou lavoura mais vigorosa)' : 'queda do vigor da vegetação no período (supressão, degradação ou mudança de uso) – vale conferir nas imagens';
    return `${lsSerieSvg(s)}<p class="hint">NDVI médio de ${ini.ano} a ${fim.ano}: de ${ini.ndvi.toFixed(2).replace('.', ',')} para ${fim.ndvi.toFixed(2).replace('.', ',')} – ${leitura}. Menor valor em ${min.ano} (${min.ndvi.toFixed(2).replace('.', ',')}). Fonte: Landsat 8 e 9 (USGS/NASA, via Esri), cena com menos nuvens de maio a setembro de cada ano.</p>`;
}
