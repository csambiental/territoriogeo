/* Analisar uma área qualquer: desenhada no mapa ou importada (KML, KMZ, Shapefile em .zip, GeoJSON).
   A área passa pelo mesmo Raio-X dos imóveis do CAR; o uso do solo é calculado na hora sobre a imagem de cobertura do município. */
const AREA = { pontos: [], ativo: false };

// cores das classes de cobertura (MapBiomas e, na reserva, Esri/Impact Observatory) → grupo usado no relatório
const AREA_PALETA = [
    ['#1f8d49', 'Vegetação nativa'], ['#7dc975', 'Vegetação nativa'], ['#04381d', 'Vegetação nativa'], ['#026975', 'Vegetação nativa'], ['#519799', 'Vegetação nativa'],
    ['#d6bc74', 'Vegetação nativa'], ['#02d659', 'Vegetação nativa'], ['#ad5100', 'Vegetação nativa'], ['#d89f5c', 'Vegetação nativa'], ['#7a5900', 'Silvicultura'],
    ['#edde8e', 'Pastagem'], ['#e974ed', 'Agricultura'], ['#c27ba0', 'Agricultura'], ['#db7093', 'Agricultura'], ['#f5b3c8', 'Agricultura'], ['#c71585', 'Agricultura'],
    ['#f54ca9', 'Agricultura'], ['#ff69b4', 'Agricultura'], ['#d082de', 'Agricultura'], ['#d68fe2', 'Agricultura'], ['#9932cc', 'Agricultura'], ['#9065d0', 'Agricultura'],
    ['#e6ccff', 'Agricultura'], ['#ffefc3', 'Mosaico de usos'], ['#d4271e', 'Área urbanizada'], ['#db4d4f', 'Outras áreas'], ['#ffa07a', 'Outras áreas'],
    ['#ffaa5f', 'Outras áreas'], ['#9c0027', 'Outras áreas'], ['#091077', 'Água'], ['#2532e4', 'Água'],
    ['#419bdf', 'Água'], ['#397d49', 'Vegetação arbórea'], ['#7a87c6', 'Vegetação arbórea'], ['#e49635', 'Agricultura'], ['#c4281b', 'Área urbanizada'],
    ['#a59b8f', 'Outras áreas'], ['#e3e2c3', 'Pastagem e campos']
].map(([h, g]) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), g]);
const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));

async function areaUsoSolo(alvo) {
    const arq = ((dadosGerais.raiox || {}).car || '').replace('car.geojson', 'cobertura.json');
    if (!RX.cob) {
        const cfg = await rxJSON(arq), img = new Image(); img.crossOrigin = 'anonymous'; img.src = cfg.imagem; await img.decode();
        const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
        const ctx = cv.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
        const [[w, n], , [e, s]] = cfg.cantos;
        RX.cob = { px: ctx.getImageData(0, 0, img.width, img.height).data, W: img.width, H: img.height, w, e, yn: mercY(n), ys: mercY(s), ano: cfg.ano };
    }
    const r = RX.cob, bb = turf.bbox(alvo);
    const col = lon => (lon - r.w) / (r.e - r.w) * r.W, lin = lat => (r.yn - mercY(lat)) / (r.yn - r.ys) * r.H;
    const c0 = Math.max(0, Math.floor(col(bb[0]))), c1 = Math.min(r.W - 1, Math.ceil(col(bb[2])));
    const l0 = Math.max(0, Math.floor(lin(bb[3]))), l1 = Math.min(r.H - 1, Math.ceil(lin(bb[1])));
    const passo = Math.max(1, Math.round(Math.sqrt((c1 - c0 + 1) * (l1 - l0 + 1) / 40000)));
    const cont = {}; let tot = 0;
    for (let l = l0; l <= l1; l += passo) for (let c = c0; c <= c1; c += passo) {
        const lon = r.w + (c + 0.5) / r.W * (r.e - r.w);
        const y = r.yn - (l + 0.5) / r.H * (r.yn - r.ys), lat = (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;
        if (!turf.booleanPointInPolygon([lon, lat], alvo)) continue;
        const i = (l * r.W + c) * 4; if (r.px[i + 3] < 128) continue;
        let g = null, melhor = 1e9;
        for (const [R, G, B, grupo] of AREA_PALETA) { const d = (r.px[i] - R) ** 2 + (r.px[i + 1] - G) ** 2 + (r.px[i + 2] - B) ** 2; if (d < melhor) { melhor = d; g = grupo; } }
        cont[g] = (cont[g] || 0) + 1; tot++;
    }
    return { ano: r.ano, uso: tot ? Object.entries(cont).map(([k, v]) => [k, v / tot * 100]).filter(([, v]) => v >= 0.5).sort((a, b) => b[1] - a[1]) : [] };
}

// ---------- desenho no mapa ----------
function areaFonte(geo) {
    const src = map.getSource('area-usuario');
    if (src) src.setData(geo); else {
        map.addSource('area-usuario', { type: 'geojson', data: geo });
        map.addLayer({ id: 'area-usuario-fill', type: 'fill', source: 'area-usuario', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#ffca28', 'fill-opacity': 0.25 } });
        map.addLayer({ id: 'area-usuario-linha', type: 'line', source: 'area-usuario', paint: { 'line-color': '#ffca28', 'line-width': 3, 'line-dasharray': [2, 1] } });
        map.addLayer({ id: 'area-usuario-pontos', type: 'circle', source: 'area-usuario', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#ffca28', 'circle-stroke-color': '#000', 'circle-stroke-width': 1 } });
    }
}
function areaRedesenhar() {
    const p = AREA.pontos, fs = p.map(c => turf.point(c));
    if (p.length >= 3) fs.unshift(turf.polygon([[...p, p[0]]])); else if (p.length === 2) fs.unshift(turf.lineString(p));
    areaFonte(turf.featureCollection(fs));
    const s = document.getElementById('areaStatus');
    if (s) s.textContent = p.length < 3 ? `Clique no mapa para marcar os cantos da área (${p.length} ponto${p.length === 1 ? '' : 's'}).` : `${p.length} pontos · ${(turf.area(turf.polygon([[...p, p[0]]])) / 1e4).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} ha. Clique em "Concluir e analisar".`;
}
const areaClique = e => { AREA.pontos.push([e.lngLat.lng, e.lngLat.lat]); areaRedesenhar(); };
function areaIniciarDesenho() {
    AREA.pontos = []; AREA.ativo = true; map.doubleClickZoom.disable(); map.getCanvas().style.cursor = 'crosshair';
    map.on('click', areaClique); areaRedesenhar();
    document.getElementById('areaDesenho').hidden = false; document.getElementById('areaBotoes').hidden = true;
}
function areaParar() {
    AREA.ativo = false; map.off('click', areaClique); map.doubleClickZoom.enable(); map.getCanvas().style.cursor = '';
    document.getElementById('areaDesenho').hidden = true; document.getElementById('areaBotoes').hidden = false;
}
function areaConcluir() {
    if (AREA.pontos.length < 3) { document.getElementById('areaStatus').textContent = 'Marque pelo menos 3 pontos.'; return; }
    const alvo = turf.polygon([[...AREA.pontos, AREA.pontos[0]]], { nome: 'Área desenhada no mapa' });
    areaParar(); areaAnalisar(alvo);
}

// ---------- importação ----------
const areaScript = src => new Promise((ok, erro) => { if ([...document.scripts].some(s => s.src === src)) return ok(); const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = erro; document.head.appendChild(s); });
function areaKml(texto) {
    const xml = new DOMParser().parseFromString(texto, 'text/xml'), polis = [];
    const anel = el => (el?.textContent || '').trim().split(/\s+/).map(t => t.split(',').map(Number)).filter(c => c.length >= 2 && !isNaN(c[0]) && !isNaN(c[1])).map(c => [c[0], c[1]]);
    xml.querySelectorAll('Polygon').forEach(pg => {
        const ext = anel(pg.querySelector('outerBoundaryIs coordinates'));
        const furos = [...pg.querySelectorAll('innerBoundaryIs coordinates')].map(anel).filter(a => a.length >= 4);
        if (ext.length >= 4) polis.push([ext, ...furos]);
    });
    return polis;
}
async function areaLerArquivo(arq) {
    const nome = arq.name.toLowerCase();
    let geo = null;
    if (nome.endsWith('.geojson') || nome.endsWith('.json')) geo = JSON.parse(await arq.text());
    else if (nome.endsWith('.kml')) geo = { polis: areaKml(await arq.text()) };
    else if (nome.endsWith('.kmz')) {
        await areaScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
        const z = await JSZip.loadAsync(arq), k = Object.keys(z.files).find(f => f.toLowerCase().endsWith('.kml'));
        if (!k) throw new Error('O KMZ não tem arquivo KML dentro.');
        geo = { polis: areaKml(await z.file(k).async('text')) };
    } else if (nome.endsWith('.zip') || nome.endsWith('.shp')) {
        if (nome.endsWith('.shp')) throw new Error('Envie o Shapefile compactado em .zip (com os arquivos .shp, .shx, .dbf e .prj juntos).');
        await areaScript('https://unpkg.com/shpjs@4.0.4/dist/shp.min.js');
        geo = await shp(await arq.arrayBuffer());
        if (Array.isArray(geo)) geo = { type: 'FeatureCollection', features: geo.flatMap(g => g.features) };
    } else throw new Error('Formato não reconhecido. Use KML, KMZ, Shapefile (.zip) ou GeoJSON.');
    let polis = geo.polis || [];
    if (!geo.polis) turf.flattenEach(geo, f => { if (f.geometry && f.geometry.type === 'Polygon') polis.push(f.geometry.coordinates); });
    if (!polis.length) throw new Error('Nenhum polígono encontrado no arquivo. Pontos e linhas não servem para a análise.');
    const g = polis.length === 1 ? turf.polygon(polis[0]) : turf.multiPolygon(polis);
    const [x0, y0, x1, y1] = turf.bbox(g);
    if (x0 < -75 || x1 > -30 || y0 < -35 || y1 > 6) throw new Error('As coordenadas não estão em graus (WGS 84/SIRGAS 2000). Exporte o arquivo em latitude e longitude.');
    g.properties = { nome: `Área importada (${arq.name})` };
    return g;
}

// ---------- análise ----------
async function areaAnalisar(alvo) {
    if (window.rxGarantirMotor && !(await window.rxGarantirMotor())) return;
    areaFonte(turf.featureCollection([alvo]));
    map.fitBounds(turf.bbox(alvo), { padding: 80, duration: 900 });
    const mun = (dadosGerais.raiox || {}).municipio || 'o município';
    const lim = await rxJSON(((dadosGerais.raiox || {}).car || '').replace('car.geojson', 'municipio.geojson')).catch(() => null);
    if (lim && lim.features && lim.features[0] && !turf.booleanIntersects(alvo, lim.features[0])) {
        alert(`A área fica fora de ${mun}. Troque o município no topo da página e analise de novo.`); return;
    }
    analisarImovel(null, alvo);
}
function areaMontarCard() {
    const ref = document.getElementById('cardCamadas'); if (!ref || document.getElementById('cardArea')) return;
    ref.insertAdjacentHTML('afterend', `<section class="card" id="cardArea">
        <h2>Analisar uma área</h2>
        <p class="hint">Faça o Raio-X de qualquer área, mesmo sem CAR: desenhe no mapa ou importe um arquivo.</p>
        <div id="areaBotoes" class="area-botoes">
          <button type="button" class="btn" id="areaDesenhar">✏️ Desenhar no mapa</button>
          <label class="btn" id="areaImportarBtn">📂 Importar KML, KMZ, SHP (.zip) ou GeoJSON<input type="file" id="areaArquivo" accept=".kml,.kmz,.zip,.geojson,.json" hidden></label>
        </div>
        <div id="areaDesenho" hidden>
          <p class="hint" id="areaStatus"></p>
          <div class="area-botoes"><button type="button" class="btn btn-solid" id="areaConcluir">Concluir e analisar</button>
          <button type="button" class="btn" id="areaDesfazer">Desfazer ponto</button><button type="button" class="btn" id="areaCancelar">Cancelar</button></div>
        </div>
        <p class="hint" id="areaErro" role="alert"></p>
      </section>`);
    document.getElementById('areaDesenhar').onclick = areaIniciarDesenho;
    document.getElementById('areaConcluir').onclick = areaConcluir;
    document.getElementById('areaDesfazer').onclick = () => { AREA.pontos.pop(); areaRedesenhar(); };
    document.getElementById('areaCancelar').onclick = () => { areaParar(); areaFonte(turf.featureCollection([])); };
    document.getElementById('areaArquivo').onchange = async e => {
        const f = e.target.files[0], erro = document.getElementById('areaErro'); erro.textContent = ''; e.target.value = '';
        if (!f) return;
        try { areaAnalisar(await areaLerArquivo(f)); } catch (x) { console.error(x); erro.textContent = x.message || 'Não foi possível ler o arquivo.'; }
    };
}
