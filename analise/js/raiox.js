// ---------- Raio-X do imóvel: cruzamentos automáticos e relatório em PDF ----------
// Usa só os dados já publicados no mapa (CAR, SIGEF, embargos IBAMA, alertas MapBiomas, outorgas, licenças, barragens,
// microbacias e declividade). Tudo é calculado no navegador; nada é enviado para fora.
const RX = { cache: {}, ultimo: null };
const rxJSON = (arq) => (RX.cache[arq] = RX.cache[arq] || fetch(arq, { cache: 'no-cache' }).then(r => r.json()));
const rxHa = (g) => turf.area(g) / 1e4;
const rxNum = (t) => parseFloat(String(t ?? '').replace(/\./g, '').replace(',', '.')) || 0;
function rxInter(a, b) {
    try { return turf.intersect(a, b); } catch (e) {
        try { return turf.intersect(turf.buffer(a, 0), turf.buffer(b, 0)); } catch (e2) { return null; }
    }
}
const rxCaixasCruzam = (a, b) => !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
function rxSobreposicoes(alvo, feats, minHa = 0.01) {
    const bb = turf.bbox(alvo), out = [];
    for (const f of feats) {
        if (!f.geometry || f.geometry.type === 'Point') continue;
        if (f === alvo) continue;
        if (!rxCaixasCruzam(bb, turf.bbox(f))) continue;
        const i = rxInter(alvo, f);
        if (!i) continue;
        const ha = rxHa(i);
        if (ha >= minHa) out.push({ f, ha });
    }
    return out.sort((a, b) => b.ha - a.ha);
}
function rxPontos(alvo, feats, raioKm = 0.5) {
    const bb = turf.bbox(alvo), m = raioKm / 100, dentro = [], perto = [];
    const linhas = turf.polygonToLine(alvo);
    for (const f of feats) {
        if (f.geometry?.type !== 'Point') continue;
        const [x, y] = f.geometry.coordinates;
        if (x < bb[0] - m || x > bb[2] + m || y < bb[1] - m || y > bb[3] + m) continue;
        if (turf.booleanPointInPolygon(f, alvo)) { dentro.push({ f, km: 0 }); continue; }
        const ls = linhas.type === 'FeatureCollection' ? linhas.features : [linhas];
        const km = Math.min(...ls.map(l => turf.pointToLineDistance(f, l)));
        if (km <= raioKm) perto.push({ f, km });
    }
    return { dentro, perto: perto.sort((a, b) => a.km - b.km) };
}
// declividade: lê a imagem do mapa (classes Embrapa por cor) e conta os pixels dentro do imóvel
async function rxRasterDecliv() {
    if (RX.decl) return RX.decl;
    const cfg = await rxJSON('data/relevo/declividade.json');
    const img = new Image(); img.src = cfg.imagem; await img.decode();
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
    const [[w, n], , [e, s]] = cfg.cantos;
    RX.decl = { px: ctx.getImageData(0, 0, img.width, img.height).data, W: img.width, H: img.height, w, n, e, s };
    return RX.decl;
}
const RX_CLASSES = [['Plano (0–3%)', null], ['Suave ondulado (3–8%)', [217, 240, 163]], ['Ondulado (8–20%)', [254, 217, 118]],
    ['Forte ondulado (20–45%)', [240, 59, 32]], ['Montanhoso (> 45%)', [128, 0, 38]]];
async function rxDeclividade(alvo) {
    const r = await rxRasterDecliv(), bb = turf.bbox(alvo);
    const c0 = Math.max(0, Math.floor((bb[0] - r.w) / (r.e - r.w) * r.W)), c1 = Math.min(r.W - 1, Math.ceil((bb[2] - r.w) / (r.e - r.w) * r.W));
    const l0 = Math.max(0, Math.floor((r.n - bb[3]) / (r.n - r.s) * r.H)), l1 = Math.min(r.H - 1, Math.ceil((r.n - bb[1]) / (r.n - r.s) * r.H));
    const passo = Math.max(1, Math.round(Math.sqrt((c1 - c0 + 1) * (l1 - l0 + 1) / 40000)));
    const cont = new Array(RX_CLASSES.length).fill(0); let tot = 0;
    for (let l = l0; l <= l1; l += passo) for (let c = c0; c <= c1; c += passo) {
        const lon = r.w + (c + 0.5) / r.W * (r.e - r.w), lat = r.n - (l + 0.5) / r.H * (r.n - r.s);
        if (!turf.booleanPointInPolygon([lon, lat], alvo)) continue;
        const i = (l * r.W + c) * 4, a = r.px[i + 3];
        let k = 0;
        if (a > 0) { let melhor = 1e9; RX_CLASSES.forEach(([, cor], j) => { if (!cor) return; const d = (r.px[i] - cor[0]) ** 2 + (r.px[i + 1] - cor[1]) ** 2 + (r.px[i + 2] - cor[2]) ** 2; if (d < melhor) { melhor = d; k = j; } }); }
        cont[k]++; tot++;
    }
    return tot ? RX_CLASSES.map(([nome], j) => ({ nome, pct: cont[j] / tot * 100 })) : [];
}
async function rxCodigo(obj) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(obj)));
    const h = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`;
}
const RX_SIGEF = { 'Registrada': ['#2e7d32', 'Registrada em cartório'], 'Titulada, não registrada': ['#29b6f6', 'Titulada, aguardando registro'], 'Não titulada': ['#ff9800', 'Certificada no INCRA, sem registro (em processo)'] };
const rxSigefCor = (p) => (RX_SIGEF[p['Situação']] || ['#9e9e9e', p['Situação'] || 'Outra'])[0];
const rxSigefRot = (p) => (RX_SIGEF[p['Situação']] || ['#9e9e9e', p['Situação'] || 'Outra'])[1];
const rxF = (n, c = 2) => Number(n).toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c });

async function analisarImovel(nome) {
    const dlg = document.getElementById('raioxDialog'), corpo = document.getElementById('raioxCorpo');
    corpo.innerHTML = '<p class="hint">Cruzando o imóvel com as camadas do mapa…</p>'; dlg.showModal();
    try {
        const cars = (camadasData.imoveis || (await rxJSON('data/car/imoveis_londrina.geojson'))).features;
        const alvo = cars.find(f => f.properties.nome === nome);
        if (!alvo) { corpo.innerHTML = '<p>Imóvel não encontrado.</p>'; return; }
        const p = alvo.properties, area = rxHa(alvo);
        const [sigef, emb, alertas, outR, outU, lic, barr, mbac] = await Promise.all(['data/fundiario/sigef_londrina.geojson', 'data/ibama/embargos_londrina.geojson',
            'data/mapbiomas/alertas_londrina.geojson', 'data/iat/outorgas_rural.geojson', 'data/iat/outorgas_urbana.geojson', 'data/iat/licencas_localizadas.geojson',
            'data/iat/barragens_londrina.geojson', 'data/bacias/microbacias_regiao.geojson'].map(a => rxJSON(a).catch(() => ({ features: [] }))));
        const r = {
            car: rxSobreposicoes(alvo, cars.filter(f => f.properties.situacao !== 'Cancelado'), 0.05),
            sigef: rxSobreposicoes(alvo, sigef.features, 0.05),
            emb: rxSobreposicoes(alvo, emb.features, 0.0001),
            alertas: Object.values(rxSobreposicoes(alvo, alertas.features, 0.0001).reduce((m, x) => { const k = x.f.properties.nome; if (!m[k] || m[k].ha < x.ha) m[k] = x; return m; }, {})),
            agua: rxPontos(alvo, [...outR.features, ...outU.features]),
            lic: rxPontos(alvo, lic.features),
            barr: rxPontos(alvo, barr.features),
            decl: await rxDeclividade(alvo).catch(() => []),
            mbac: mbac.features.filter(m => rxCaixasCruzam(turf.bbox(m), turf.bbox(alvo)) && turf.booleanPointInPolygon(turf.pointOnFeature(alvo), m)).map(m => m.properties.nome || m.properties.rio).slice(0, 1)
        };
        const uso = Object.keys(p).filter(k => k.startsWith('MapBiomas 2023 – ')).map(k => [k.replace('MapBiomas 2023 – ', '').replace(' (%)', ''), rxNum(p[k])]).sort((a, b) => b[1] - a[1]);
        const pend = Object.keys(p).filter(k => /^Pendência \d+$/.test(k)).map(k => p[k]);
        const sobreCar = r.car.reduce((s, x) => s + x.ha, 0), sobreSigef = r.sigef.reduce((s, x) => s + x.ha, 0);
        const quando = new Date();
        const codigo = await rxCodigo({ nome, r: { car: r.car.map(x => [x.f.properties.nome, x.ha.toFixed(3)]), sigef: r.sigef.map(x => [x.f.properties['Parcela SIGEF'], x.ha.toFixed(3)]), emb: r.emb.length, al: r.alertas.length, decl: r.decl.map(d => d.pct.toFixed(1)) }, dados: dadosGerais.atualizado_em, quando: quando.toISOString() });
        // alertas resumidos em semáforo
        const flags = [];
        if (r.emb.length) flags.push(['vermelho', `${r.emb.length} área(s) embargada(s) pelo IBAMA dentro do imóvel`]);
        if (r.alertas.length) flags.push(['vermelho', `${r.alertas.length} alerta(s) de desmatamento MapBiomas dentro do imóvel`]);
        const maiorCar = r.car.length ? r.car[0].ha : 0;
        if (maiorCar >= Math.max(1, area * 0.02)) flags.push(['amarelo', `Sobreposição relevante com outro CAR: ${rxF(maiorCar)} ha (${rxF(maiorCar / area * 100, 1)}% do imóvel)`]);
        else if (r.car.length) flags.push(['verde', `Só pequenas sobreposições nas divisas (${rxF(sobreCar)} ha com ${r.car.length} CAR vizinho(s)) – provável diferença de traçado`]);
        if (r.sigef.length && sobreSigef < area * 0.5) flags.push(['amarelo', `Parcelas SIGEF cobrem só ${rxF(sobreSigef / area * 100, 0)}% do imóvel`]);
        if (!r.sigef.length) flags.push(['amarelo', 'Nenhuma parcela SIGEF/INCRA sobre o imóvel']);
        const forte = r.decl.slice(3).reduce((s, d) => s + d.pct, 0);
        if (forte >= 10) flags.push(['amarelo', `${rxF(forte, 0)}% do imóvel em relevo forte ondulado ou mais (≥ 20%)`]);
        if (!flags.some(f => f[0] !== 'verde')) flags.unshift(['verde', 'Nenhuma restrição encontrada nas camadas consultadas']);
        const tab = (cab, linhas) => linhas.length ? `<table class="rx-tab"><tr>${cab.map(c => `<th>${c}</th>`).join('')}</tr>${linhas.map(l => `<tr>${l.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>` : '<p class="hint">Nada encontrado.</p>';
        const coord = (f) => { const [lo, la] = f.geometry.coordinates; return `<span class="mono">${la.toFixed(5)}, ${lo.toFixed(5)}</span><br><a href="https://www.google.com/maps?q=${la.toFixed(6)},${lo.toFixed(6)}" target="_blank" rel="noopener">ver no Google Maps ↗</a>`; };
        let nPt = 0; const pontosFoto = [];
        const pts = (o, campo, tipo) => [...o.dentro, ...o.perto].slice(0, 12).map(x => { nPt++; pontosFoto.push({ n: nPt, tipo, c: x.f.geometry.coordinates });
            return [`<b>${nPt}</b>`, esc(x.f.properties.nome || ''), esc(x.f.properties[campo] || x.f.properties.grupo || ''), x.km ? `a ${rxF(x.km * 1000, 0)} m` : 'dentro', coord(x.f)]; });
        const html = `
            <div class="rx-cab"><div><div class="mono rx-cod">${esc(nome)}</div>
              <div class="hint">${esc(p['Status do CAR'] || '')} · ${esc(p.situacao || '')} · ${esc(p.Tipo || '')}</div></div>
              <div class="rx-area"><b>${rxF(area)}</b> ha<br><span class="hint">${esc(p['Módulos fiscais'] || '–')} módulos fiscais</span></div></div>
            <ul class="rx-flags">${flags.map(([c, t]) => `<li class="rx-${c}">${esc(t)}</li>`).join('')}</ul>
            ${pend.length ? `<h3>Pendências apontadas no mapa</h3><ul>${pend.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
            <h3>Uso e cobertura do solo (MapBiomas 2023)</h3>
            ${tab(['Classe', '% do imóvel', 'ha (aprox.)'], uso.map(([k, v]) => [esc(k), rxF(v, 1) + '%', rxF(v / 100 * area, 1)]))}
            <h3>Declividade (Copernicus DEM, classes Embrapa)</h3>
            ${tab(['Classe de relevo', '% do imóvel', 'ha (aprox.)'], r.decl.filter(d => d.pct >= 0.05).map(d => [d.nome, rxF(d.pct, 1) + '%', rxF(d.pct / 100 * area, 1)]))}
            <h3>Sobreposição com outros imóveis do CAR</h3>
            <!--FOTO2-->
            ${tab(['Nº', 'CAR', 'Situação', 'Sobreposição (ha)', '% do imóvel'], r.car.slice(0, 15).map((x, i) => [`<b>${i + 1}</b>`, `<span class="mono">${esc(x.f.properties.nome)}</span>`, esc(x.f.properties.situacao || ''), rxF(x.ha), (x.ha / area * 100 < 0.1 ? '< 0,1%' : rxF(x.ha / area * 100, 1) + '%')]))}
            <h3>Imóveis certificados no SIGEF/INCRA</h3>
            ${(() => { const cob = {}; r.sigef.forEach(x => { const k = rxSigefRot(x.f.properties); cob[k] = (cob[k] || [rxSigefCor(x.f.properties), 0]); cob[k][1] += x.ha; });
                const tot = Math.min(area, r.sigef.reduce((a, x) => a + x.ha, 0));
                return `<div class="rx-cob">${Object.entries(cob).map(([k, [c, ha]]) => `<span><i style="background:${c}"></i>${esc(k)}: <b>${rxF(Math.min(ha, area) / area * 100, 1)}%</b> (${rxF(ha, 1)} ha)</span>`).join('')}
                  <span><i style="background:#fff;border:1px solid #999"></i>Sem SIGEF: <b>${rxF(Math.max(0, area - tot) / area * 100, 1)}%</b></span></div>`; })()}
            <!--FOTO3-->
            ${tab(['Nº', 'Parcela', 'Matrícula', 'Situação no registro', 'Sobre o imóvel (ha)'], r.sigef.slice(0, 15).map((x, i) => [`<b>${i + 1}</b>`, esc(x.f.properties.nome || ''), esc(x.f.properties['Matrícula / registro'] || ''), `<span class="rx-sw" style="background:${rxSigefCor(x.f.properties)}"></span>${esc(rxSigefRot(x.f.properties))}`, rxF(x.ha)]))}
            <h3>Embargos do IBAMA</h3>
            ${tab(['Embargo', 'Situação', 'Data', 'Dentro do imóvel (ha)'], r.emb.map(x => [esc(x.f.properties.nome), esc(x.f.properties['Situação'] || ''), esc(x.f.properties['Data do embargo'] || ''), rxF(x.ha, 3)]))}
            <h3>Alertas de desmatamento (MapBiomas Alerta)</h3>
            ${tab(['Alerta', 'Detectado em', 'Vetor', 'Dentro do imóvel (ha)'], r.alertas.map(x => [esc(x.f.properties.nome), esc(x.f.properties['Detectado em'] || ''), esc(x.f.properties['Vetor'] || ''), rxF(x.ha, 2)]))}
            <h3>Outorgas de água no imóvel ou a até 500 m</h3>
            <!--FOTO4-->
            ${tab(['Nº', 'Titular (SIGARH)', 'Tipo', 'Posição', 'Coordenadas (lat, long – SIRGAS 2000)'], pts(r.agua, 'Interferência', 'agua'))}
            <h3>Licenças ambientais (IAT) no imóvel ou a até 500 m</h3>
            ${tab(['Nº', 'Empreendimento (SGA)', 'Atividade', 'Posição', 'Coordenadas (lat, long)'], pts(r.lic, 'Atividade', 'lic'))}
            ${r.barr.dentro.length || r.barr.perto.length ? `<h3>Barragens cadastradas</h3>${tab(['Nº', 'Barragem', 'Tipo', 'Posição', 'Coordenadas (lat, long)'], pts(r.barr, 'grupo', 'barr'))}` : ''}
            <p class="hint">Microbacia: ${esc(r.mbac[0] || '–')} · Dados do mapa atualizados em ${esc(dadosGerais.atualizado_em || '')}.</p>
            <p class="hint rx-aviso">Análise automática feita sobre bases públicas (SICAR, INCRA/SIGEF, IBAMA, MapBiomas, IAT/SIGARH/SGA, Copernicus). As áreas são aproximadas e não substituem vistoria, levantamento topográfico ou consulta oficial aos órgãos.</p>`;
        corpo.innerHTML = html;
        RX.ultimo = { nome, html, codigo, quando, alvo, viz: r.car, sigef: r.sigef, pontos: pontosFoto };
        document.getElementById('raioxPdf').disabled = false;
    } catch (e) {
        console.error(e); corpo.innerHTML = '<p>Não foi possível concluir a análise. Tente novamente.</p>';
    }
}
// ---------- fotos do mapa para o relatório ----------
const RX_FONTES_BASE = ['esri', 'composite', 'mapbox', 'mapbox-satellite'];
function rxEsconderCamadas() {
    const estado = [];
    for (const l of map.getStyle().layers) {
        if (!l.source || RX_FONTES_BASE.includes(l.source) || l.id.startsWith('rx-')) continue;
        estado.push([l.id, map.getLayoutProperty(l.id, 'visibility') || 'visible']);
        map.setLayoutProperty(l.id, 'visibility', 'none');
    }
    document.querySelectorAll('.mapboxgl-popup').forEach(p => p.remove());
    return estado;
}
function rxRestaurar(estado) {
    for (const [id, v] of estado) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
    ['rx-viz-rot', 'rx-inter', 'rx-viz', 'rx-alvo-linha', 'rx-alvo'].forEach(id => map.getLayer(id) && map.removeLayer(id));
    ['rx-alvo', 'rx-viz', 'rx-inter', 'rx-rot'].forEach(id => map.getSource(id) && map.removeSource(id));
}
async function rxCapturar(alvo) {
    await new Promise(res => { map.once('idle', res); setTimeout(res, 8000); });
    await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
    try {
        // copia o mapa e redesenha o perímetro do imóvel por cima (garante o contorno vermelho na imagem)
        const src = map.getCanvas(), cv = document.createElement('canvas');
        cv.width = src.width; cv.height = src.height;
        const ctx = cv.getContext('2d'); ctx.drawImage(src, 0, 0);
        if (alvo) {
            const k = src.width / src.clientWidth, g = alvo.geometry;
            const polis = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
            ctx.beginPath();
            for (const pol of polis) for (const anel of pol) anel.forEach(([x, y], i) => { const p = map.project([x, y]); i ? ctx.lineTo(p.x * k, p.y * k) : ctx.moveTo(p.x * k, p.y * k); });
            ctx.lineJoin = 'round'; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 7 * k; ctx.stroke();
            ctx.strokeStyle = '#ff1744'; ctx.lineWidth = 4 * k; ctx.stroke();
        }
        return cv.toDataURL('image/jpeg', 0.9);
    } catch (e) { return null; }
}
function rxDesenharAlvo(alvo, preenchido) {
    map.addSource('rx-alvo', { type: 'geojson', data: alvo });
    map.addLayer({ id: 'rx-alvo', type: 'fill', source: 'rx-alvo', paint: { 'fill-color': '#b9f6ca', 'fill-opacity': preenchido ? 0.45 : 0.3 } });
    map.addLayer({ id: 'rx-alvo-linha', type: 'line', source: 'rx-alvo', paint: { 'line-color': '#ff1744', 'line-width': 3.5 } });
}
// imagem 1: localização – só o imóvel, contorno forte sobre o satélite
async function rxFotoLocalizacao(alvo) {
    const estado = rxEsconderCamadas();
    try {
        rxDesenharAlvo(alvo, false);
        map.fitBounds(boundsDe(alvo), { padding: 120, maxZoom: 15.5, duration: 0 });
        return await rxCapturar(alvo);
    } finally { rxRestaurar(estado); }
}
// imagem 2: sobreposições – imóvel preenchido; vizinhos sobrepostos só com contorno (numerados) e áreas sobrepostas em vermelho
async function rxFotoSobreposicao(alvo, viz) {
    const estado = rxEsconderCamadas();
    try {
        const fc = turf.featureCollection(viz.map((x, i) => ({ type: 'Feature', geometry: x.f.geometry, properties: { n: String(i + 1) } })));
        const inter = turf.featureCollection(viz.map(x => rxInter(alvo, x.f)).filter(Boolean));
        rxDesenharAlvo(alvo, true);
        map.addSource('rx-viz', { type: 'geojson', data: fc });
        map.addSource('rx-inter', { type: 'geojson', data: inter });
        map.addLayer({ id: 'rx-viz', type: 'line', source: 'rx-viz', paint: { 'line-color': '#ffea00', 'line-width': 2.5, 'line-dasharray': [2, 1.2] } });
        map.addLayer({ id: 'rx-inter', type: 'fill', source: 'rx-inter', paint: { 'fill-color': '#ff9100', 'fill-opacity': 0.8, 'fill-outline-color': '#ffffff' } });
        map.addSource('rx-rot', { type: 'geojson', data: turf.featureCollection(viz.map((x, i) => { const it = rxInter(alvo, x.f); return turf.point(turf.pointOnFeature(it || x.f).geometry.coordinates, { n: String(i + 1) }); })) });
        map.addLayer({ id: 'rx-viz-rot', type: 'symbol', source: 'rx-rot', layout: { 'text-field': ['get', 'n'], 'text-size': 15, 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'], 'text-allow-overlap': true, 'text-offset': [0, -1.1] },
            paint: { 'text-color': '#1a1a1a', 'text-halo-color': '#ffea00', 'text-halo-width': 2.5 } });
        map.moveLayer('rx-alvo-linha', 'rx-viz-rot');
        const caixa = turf.bbox(turf.featureCollection([alvo, ...inter.features]));
        map.fitBounds([[caixa[0], caixa[1]], [caixa[2], caixa[3]]], { padding: 90, maxZoom: 16, duration: 0 });
        return await rxCapturar(alvo);
    } finally { rxRestaurar(estado); }
}
// imagem 3: SIGEF – parcelas sobre o imóvel coloridas pela situação no registro, imóvel só com contorno
async function rxFotoSigef(alvo, parc) {
    const estado = rxEsconderCamadas();
    try {
        const fc = turf.featureCollection(parc.map((x, i) => ({ type: 'Feature', geometry: x.f.geometry, properties: { n: String(i + 1), cor: rxSigefCor(x.f.properties) } })));
        map.addSource('rx-sig', { type: 'geojson', data: fc });
        map.addLayer({ id: 'rx-sig', type: 'fill', source: 'rx-sig', paint: { 'fill-color': ['get', 'cor'], 'fill-opacity': 0.45 } });
        map.addLayer({ id: 'rx-sig-linha', type: 'line', source: 'rx-sig', paint: { 'line-color': ['get', 'cor'], 'line-width': 2.2 } });
        map.addSource('rx-alvo', { type: 'geojson', data: alvo });
        map.addLayer({ id: 'rx-alvo-linha', type: 'line', source: 'rx-alvo', paint: { 'line-color': '#ff1744', 'line-width': 3.5 } });
        map.addSource('rx-rot', { type: 'geojson', data: turf.featureCollection(parc.map((x, i) => { const it = rxInter(alvo, x.f); return turf.point(turf.pointOnFeature(it || x.f).geometry.coordinates, { n: String(i + 1) }); })) });
        map.addLayer({ id: 'rx-viz-rot', type: 'symbol', source: 'rx-rot', layout: { 'text-field': ['get', 'n'], 'text-size': 14, 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'], 'text-allow-overlap': true },
            paint: { 'text-color': '#ffffff', 'text-halo-color': '#1b3a2a', 'text-halo-width': 2.2 } });
        map.fitBounds(boundsDe(alvo), { padding: 90, maxZoom: 16, duration: 0 });
        return await rxCapturar(alvo);
    } finally {
        ['rx-sig', 'rx-sig-linha'].forEach(id => map.getLayer(id) && map.removeLayer(id));
        rxRestaurar(estado); map.getSource('rx-sig') && map.removeSource('rx-sig');
    }
}
// imagem 4: outorgas, licenças e barragens numeradas em volta do imóvel
const RX_PT_COR = { agua: '#1e88e5', lic: '#8e24aa', barr: '#00897b' };
async function rxFotoPontos(alvo, pontos) {
    const estado = rxEsconderCamadas();
    try {
        rxDesenharAlvo(alvo, false);
        const fc = turf.featureCollection(pontos.map(p => turf.point(p.c, { n: String(p.n), cor: RX_PT_COR[p.tipo] })));
        map.addSource('rx-pt', { type: 'geojson', data: fc });
        map.addLayer({ id: 'rx-pt', type: 'circle', source: 'rx-pt', paint: { 'circle-radius': 9, 'circle-color': ['get', 'cor'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
        map.addSource('rx-rot', { type: 'geojson', data: fc });
        map.addLayer({ id: 'rx-viz-rot', type: 'symbol', source: 'rx-rot', layout: { 'text-field': ['get', 'n'], 'text-size': 11, 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'], 'text-allow-overlap': true }, paint: { 'text-color': '#ffffff' } });
        const caixa = turf.bbox(turf.featureCollection([alvo, ...fc.features]));
        map.fitBounds([[caixa[0], caixa[1]], [caixa[2], caixa[3]]], { padding: 90, maxZoom: 16, duration: 0 });
        return await rxCapturar(alvo);
    } finally {
        map.getLayer('rx-pt') && map.removeLayer('rx-pt');
        rxRestaurar(estado); map.getSource('rx-pt') && map.removeSource('rx-pt');
    }
}
async function gerarRelatorioRaiox() {
    const u = RX.ultimo; if (!u) return;
    const janela = window.open('', '_blank');
    if (!janela) { alert('Permita a abertura de janelas para gerar o relatório.'); return; }
    janela.document.write('<p style="font-family:sans-serif;padding:20px">Montando o relatório…</p>');
    document.getElementById('raioxDialog').close();
    const centro = map.getCenter(), zoom = map.getZoom();
    const foto = await rxFotoLocalizacao(u.alvo);
    const relevantes = u.viz.filter(x => x.ha >= 0.05).slice(0, 15);
    const foto2 = relevantes.length ? await rxFotoSobreposicao(u.alvo, relevantes) : null;
    const parc = (u.sigef || []).slice(0, 15);
    const foto3 = parc.length ? await rxFotoSigef(u.alvo, parc) : null;
    const foto4 = (u.pontos || []).length ? await rxFotoPontos(u.alvo, u.pontos) : null;
    map.jumpTo({ center: centro, zoom });
    const dataHora = u.quando.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const titulo = (dadosGerais.cliente || {}).nome || 'Mapa';
    janela.document.open();
    janela.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório do imóvel ${esc(u.nome)}</title>
<style>
 body{font-family:Inter,Arial,sans-serif;color:#1d2a24;margin:28px;font-size:12.5px;line-height:1.45}
 header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1e5a3c;padding-bottom:10px;margin-bottom:14px}
 h1{font-size:18px;margin:0 0 3px;color:#1e5a3c} h3{font-size:13.5px;margin:16px 0 6px;color:#1e5a3c;border-bottom:1px solid #dfe8e2;padding-bottom:3px}
 .mono{font-family:Consolas,monospace} .hint{color:#5f6d66;font-size:11.5px}
 .rx-cab{display:flex;justify-content:space-between;gap:12px;background:#f3f7f4;border-radius:8px;padding:10px 12px}
 .rx-cod{font-size:12.5px;font-weight:700;word-break:break-all} .rx-area{text-align:right;font-size:14px}
 .rx-flags{list-style:none;padding:0;margin:10px 0} .rx-flags li{padding:5px 9px;border-radius:6px;margin:3px 0;font-weight:600}
 .rx-vermelho{background:#fdecea;color:#b71c1c} .rx-amarelo{background:#fff6dd;color:#8a5a00} .rx-verde{background:#e7f5ec;color:#1b6b3a}
 table{width:100%;border-collapse:collapse;font-size:11.5px} th,td{border-bottom:1px solid #e5ebe7;padding:4px 6px;text-align:left;vertical-align:top} th{background:#f3f7f4}
 .rx-cob{display:flex;flex-wrap:wrap;gap:6px 14px;margin:4px 0 8px} .rx-cob i,.rx-sw{display:inline-block;width:11px;height:11px;border-radius:2px;margin-right:4px;vertical-align:-1px} .legenda span{display:inline-block;width:14px;height:10px;border-radius:2px;margin:0 4px -1px 0} img.mapa{width:100%;border-radius:8px;border:1px solid #cfd8d3;margin:6px 0 2px}
 footer{margin-top:18px;border-top:1px solid #cfd8d3;padding-top:8px;display:flex;justify-content:space-between;gap:10px}
 .cod{font-family:Consolas,monospace;font-size:14px;font-weight:700;letter-spacing:.05em}
 @media print{body{margin:12mm} .noprint{display:none} h3{break-after:avoid} table{break-inside:auto} tr{break-inside:avoid}}
</style></head><body>
<header><div><h1>Relatório de análise do imóvel rural</h1><div class="hint">${esc(titulo)} · Londrina/PR</div></div>
<div style="text-align:right"><div class="hint">Gerado em</div><b>${esc(dataHora)}</b></div></header>
${foto ? `<h3>Localização do imóvel</h3><img class="mapa" src="${foto}" alt="Mapa de localização do imóvel"><div class="hint">Imóvel analisado: perímetro em vermelho e interior em verde-claro, sobre imagem de satélite (Esri World Imagery).</div>` : ''}
${u.html.replace('<!--FOTO4-->', foto4 ? `<img class="mapa" src="${foto4}" alt="Mapa das outorgas e licenças"><div class="hint legenda"><span style="background:#b9f6ca;border:2px solid #ff1744"></span>imóvel analisado &nbsp; <span style="background:#1e88e5;border-radius:50%"></span>outorga de água &nbsp; <span style="background:#8e24aa;border-radius:50%"></span>licença ambiental &nbsp; <span style="background:#00897b;border-radius:50%"></span>barragem – números = linhas das tabelas</div>` : '').replace('<!--FOTO3-->', foto3 ? `<img class="mapa" src="${foto3}" alt="Mapa do SIGEF"><div class="hint legenda"><span style="border:3px solid #ff1744;background:none"></span>imóvel analisado (CAR) &nbsp; ${Object.values(RX_SIGEF).map(([c, t]) => `<span style="background:${c}"></span>${t}`).join(' &nbsp; ')} – números = linhas da tabela</div>` : '').replace('<!--FOTO2-->', foto2 ? `<img class="mapa" src="${foto2}" alt="Mapa das sobreposições"><div class="hint legenda"><span style="background:#b9f6ca;border:2px solid #ff1744"></span>imóvel analisado &nbsp; <span style="border:2px dashed #e6c800;background:none"></span>imóveis vizinhos com sobreposição (nº da tabela) &nbsp; <span style="background:#ff9100"></span>área sobreposta</div>` : '')}
<footer><div class="hint">CS Consultoria Ambiental · Relatório gerado automaticamente a partir de bases públicas.<br>Dados do mapa atualizados em ${esc(dadosGerais.atualizado_em || '')}.</div>
<div style="text-align:right"><div class="hint">Código de conferência</div><div class="cod">${u.codigo}</div><div class="hint">identifica esta versão do relatório</div></div></footer>
<p class="noprint" style="text-align:center;margin-top:16px"><button onclick="window.print()" style="padding:9px 18px;font-size:14px;background:#1e5a3c;color:#fff;border:0;border-radius:6px;cursor:pointer">Salvar em PDF / imprimir</button></p>
</body></html>`);
    janela.document.close();
}
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('raioxFechar')?.addEventListener('click', () => document.getElementById('raioxDialog').close());
    document.getElementById('raioxPdf')?.addEventListener('click', gerarRelatorioRaiox);
});
