// Ferramentas do mapa: abrir KML/KMZ/GeoJSON, régua (distância) e polígono (área e perímetro).
// Tudo roda no navegador: o arquivo aberto não é enviado a nenhum servidor.
(function () {
    'use strict';
    const R_TERRA = 6371008.8;
    const rad = g => g * Math.PI / 180;
    const fmt = (v, d = 0) => v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
    const escT = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const distM = (a, b) => { const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]); const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2; return 2 * R_TERRA * Math.asin(Math.sqrt(h)); };
    const areaM2 = anel => { let s = 0; for (let i = 0; i < anel.length; i++) { const p1 = anel[i], p2 = anel[(i + 1) % anel.length]; s += rad(p2[0] - p1[0]) * (2 + Math.sin(rad(p1[1])) + Math.sin(rad(p2[1]))); } return Math.abs(s * R_TERRA * R_TERRA / 2); };
    const txtDist = m => m >= 1000 ? `${fmt(m / 1000, 2)} km` : `${fmt(m, 0)} m`;
    const txtArea = m2 => `${fmt(m2 / 1e4, 2)} ha (${m2 >= 1e6 ? fmt(m2 / 1e6, 2) + ' km²' : fmt(m2, 0) + ' m²'})`;

    function iniciar() {
        if (typeof map === 'undefined') return setTimeout(iniciar, 300);
        if (!map.isStyleLoaded() || map.getStyle().layers.length < 5) return setTimeout(iniciar, 400);

        // ---------- interface
        const box = document.createElement('div');
        box.className = 'ferr mapboxgl-ctrl mapboxgl-ctrl-group';
        box.innerHTML = `<button type="button" data-a="abrir" title="Abrir KML, KMZ ou GeoJSON no mapa">📂</button>
            <button type="button" data-a="linha" title="Régua: medir distância">📏</button>
            <button type="button" data-a="area" title="Desenhar polígono e medir área">⬠</button>
            <button type="button" data-a="limpar" title="Limpar medições e arquivos abertos">🧹</button>
            <input type="file" accept=".kml,.kmz,.geojson,.json" hidden>`;
        map.addControl({ onAdd: () => box, onRemove: () => box.remove() }, 'top-right');
        const painel = document.createElement('div'); painel.className = 'ferr-painel'; painel.hidden = true;
        map.getContainer().appendChild(painel);
        const inp = box.querySelector('input');

        // ---------- camadas
        const vazio = { type: 'FeatureCollection', features: [] };
        map.addSource('usr-arq', { type: 'geojson', data: vazio });
        map.addLayer({ id: 'usr-arq-fill', type: 'fill', source: 'usr-arq', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#ffeb3b', 'fill-opacity': 0.18 } });
        map.addLayer({ id: 'usr-arq-linha', type: 'line', source: 'usr-arq', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': '#fbc02d', 'line-width': 3 } });
        map.addLayer({ id: 'usr-arq-pt', type: 'circle', source: 'usr-arq', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 6, 'circle-color': '#fbc02d', 'circle-stroke-color': '#000', 'circle-stroke-width': 1.5 } });
        map.addLayer({ id: 'usr-arq-rot', type: 'symbol', source: 'usr-arq', layout: { 'text-field': ['coalesce', ['get', 'name'], ''], 'text-size': 12, 'text-offset': [0, 1.2], 'text-anchor': 'top' },
            paint: { 'text-color': '#212121', 'text-halo-color': '#fff', 'text-halo-width': 1.6 } });
        map.addSource('usr-med', { type: 'geojson', data: vazio });
        map.addLayer({ id: 'usr-med-fill', type: 'fill', source: 'usr-med', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#00b0ff', 'fill-opacity': 0.2 } });
        map.addLayer({ id: 'usr-med-linha', type: 'line', source: 'usr-med', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': '#0091ea', 'line-width': 2.5, 'line-dasharray': [2, 1] } });
        map.addLayer({ id: 'usr-med-pt', type: 'circle', source: 'usr-med', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 4.5, 'circle-color': '#fff', 'circle-stroke-color': '#0091ea', 'circle-stroke-width': 2 } });

        // mantém as camadas do usuário por cima das camadas que o mapa carregar depois
        const USR = ['usr-arq-fill', 'usr-arq-linha', 'usr-arq-pt', 'usr-arq-rot', 'usr-med-fill', 'usr-med-linha', 'usr-med-pt'];
        const topo = () => { const L = map.getStyle().layers; if (L[L.length - 1].id !== 'usr-med-pt') USR.forEach(id => map.getLayer(id) && map.moveLayer(id)); };
        map.on('idle', topo);

        let ultimoPoligono = null;
        // ---------- abrir arquivo
        const lerKML = txt => {
            const doc = new DOMParser().parseFromString(txt, 'application/xml'), F = [];
            const coords = el => (el.textContent || '').trim().split(/\s+/).map(t => t.split(',').map(Number)).filter(p => isFinite(p[0]) && isFinite(p[1])).map(p => [p[0], p[1]]);
            const textoDesc = d => { if (!d) return ''; const t = document.createElement('div'); t.innerHTML = d; return (t.textContent || '').trim().slice(0, 600); };
            for (const pm of doc.getElementsByTagName('Placemark')) {
                const props = { name: (pm.getElementsByTagName('name')[0] || {}).textContent || '', desc: textoDesc((pm.getElementsByTagName('description')[0] || {}).textContent) };
                for (const d of pm.getElementsByTagName('Data')) { const v = d.getElementsByTagName('value')[0]; if (v) props[d.getAttribute('name')] = v.textContent; }
                for (const d of pm.getElementsByTagName('SimpleData')) props[d.getAttribute('name')] = d.textContent;
                for (const pt of pm.getElementsByTagName('Point')) { const c = coords(pt.getElementsByTagName('coordinates')[0] || pt); if (c[0]) F.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: c[0] } }); }
                for (const ls of pm.getElementsByTagName('LineString')) { const c = coords(ls.getElementsByTagName('coordinates')[0] || ls); if (c.length > 1) F.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: c } }); }
                for (const pg of pm.getElementsByTagName('Polygon')) {
                    const ext = pg.getElementsByTagName('outerBoundaryIs')[0], ints = [...pg.getElementsByTagName('innerBoundaryIs')];
                    const an = [coords((ext || pg).getElementsByTagName('coordinates')[0])].concat(ints.map(i => coords(i.getElementsByTagName('coordinates')[0])));
                    if (an[0].length > 2) F.push({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: an } });
                }
            }
            return { type: 'FeatureCollection', features: F };
        };
        async function abrirArquivo(arq) {
            let gj;
            const nome = arq.name.toLowerCase();
            if (nome.endsWith('.kmz')) {
                if (!window.JSZip) await new Promise((ok, erro) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'; s.onload = ok; s.onerror = erro; document.head.appendChild(s); });
                const zip = await JSZip.loadAsync(arq); const k = Object.keys(zip.files).find(n => n.toLowerCase().endsWith('.kml'));
                if (!k) throw new Error('KMZ sem arquivo KML dentro');
                gj = lerKML(await zip.files[k].async('string'));
            } else if (nome.endsWith('.kml')) gj = lerKML(await arq.text());
            else gj = JSON.parse(await arq.text());
            if (gj.type === 'Feature') gj = { type: 'FeatureCollection', features: [gj] };
            // separa MultiPolygon/MultiLineString para os filtros de geometria
            const F = [];
            for (const f of gj.features || []) {
                const g = f.geometry; if (!g) continue;
                if (g.type.startsWith('Multi')) g.coordinates.forEach(c => F.push({ type: 'Feature', properties: f.properties || {}, geometry: { type: g.type.slice(5), coordinates: c } }));
                else F.push({ type: 'Feature', properties: f.properties || {}, geometry: g });
            }
            const amostra = F.flatMap(f => f.geometry.type === 'Point' ? [f.geometry.coordinates] : f.geometry.type === 'LineString' ? f.geometry.coordinates : f.geometry.coordinates[0]);
            if (!amostra.length) throw new Error('nenhuma geometria encontrada');
            if (amostra.some(p => Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90)) throw new Error('coordenadas fora de graus (o arquivo precisa estar em latitude/longitude, WGS84 ou SIRGAS 2000)');
            const atual = map.getSource('usr-arq')._data || vazio;
            map.getSource('usr-arq').setData({ type: 'FeatureCollection', features: (atual.features || []).concat(F) });
            const xs = amostra.map(p => p[0]), ys = amostra.map(p => p[1]);
            map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 60, maxZoom: 16 });
            const polys = F.filter(f => f.geometry.type === 'Polygon'); ultimoPoligono = polys.sort((a, b) => areaM2(b.geometry.coordinates[0]) - areaM2(a.geometry.coordinates[0]))[0] || null;
            const linhas = F.filter(f => f.geometry.type === 'LineString');
            const aTot = polys.reduce((s, f) => s + areaM2(f.geometry.coordinates[0]) - f.geometry.coordinates.slice(1).reduce((t, a) => t + areaM2(a), 0), 0);
            const lTot = linhas.reduce((s, f) => s + f.geometry.coordinates.slice(1).reduce((t, p, i) => t + distM(f.geometry.coordinates[i], p), 0), 0);
            mostrar(`<b>${escT(arq.name)}</b><br>${F.length} feição(ões): ${polys.length} polígono(s), ${linhas.length} linha(s), ${F.length - polys.length - linhas.length} ponto(s)` +
                (polys.length ? `<br>Área total: <b>${txtArea(aTot)}</b>` : '') + (linhas.length ? `<br>Comprimento das linhas: <b>${txtDist(lTot)}</b>` : '') +
                (ultimoPoligono && typeof window.areaAnalisar === 'function' ? `<div class="ferr-acoes"><button type="button" data-f="raiox-arq">Raio-X do maior polígono</button></div>` : '') +
                `<br><span class="dica">Clique numa feição para ver os dados. O arquivo fica só no seu navegador.</span>`);
        }
        inp.addEventListener('change', async () => {
            const arq = inp.files[0]; inp.value = ''; if (!arq) return;
            try { await abrirArquivo(arq); } catch (e) { mostrar(`<b>Não foi possível abrir o arquivo.</b><br>${escT(e.message)}`); }
        });
        ['usr-arq-fill', 'usr-arq-linha', 'usr-arq-pt'].forEach(id => map.on('click', id, e => {
            if (window.modoMedir) return; e.originalEvent._pt = true;
            const p = e.features[0].properties, linhas = Object.entries(p).filter(([k, v]) => v && k !== 'desc' && k !== 'name').slice(0, 12);
            new mapboxgl.Popup({ maxWidth: '340px' }).setLngLat(e.lngLat).setHTML(`<div class="pop"><h4>${escT(p.name || 'Feição do arquivo')}</h4>${p.desc ? `<p>${escT(p.desc)}</p>` : ''}${linhas.length ? `<table>${linhas.map(([k, v]) => `<tr><td>${escT(k)}</td><td>${escT(v)}</td></tr>`).join('')}</table>` : ''}</div>`).addTo(map);
        }));

        // ---------- medir
        let modo = null, pts = [];
        function desenhar(concluido) {
            const F = pts.map(p => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } }));
            if (modo === 'linha' && pts.length > 1) F.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts } });
            if (modo === 'area' && pts.length > 2) F.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...pts, pts[0]]] } });
            else if (modo === 'area' && pts.length === 2) F.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts } });
            map.getSource('usr-med').setData({ type: 'FeatureCollection', features: F });
            const segs = pts.slice(1).map((p, i) => distM(pts[i], p)), tot = segs.reduce((a, b) => a + b, 0);
            if (modo === 'linha') mostrar(`<b>Régua</b> – ${pts.length < 2 ? 'clique no mapa para marcar os pontos' : `distância total: <b>${txtDist(tot)}</b>`}` +
                (segs.length > 1 ? `<br><span class="dica">Trechos: ${segs.map(txtDist).join(' + ')}</span>` : '') + rodape(concluido));
            else {
                const per = pts.length > 2 ? tot + distM(pts[pts.length - 1], pts[0]) : tot;
                mostrar(`<b>Polígono</b> – ${pts.length < 3 ? 'clique no mapa para marcar os vértices (mínimo 3)' : `área: <b>${txtArea(areaM2(pts))}</b><br>perímetro: <b>${txtDist(per)}</b>`}` + rodape(concluido));
            }
        }
        const temRaiox = () => typeof window.areaAnalisar === 'function';
        const rodape = concluido => concluido ? `<div class="ferr-acoes">${modo === 'area' && temRaiox() ? '<button type="button" data-f="raiox">Raio-X desta área</button>' : ''}<button type="button" data-f="kml">Baixar KML</button><button type="button" data-f="nova">Nova medição</button></div>`
            : `<div class="ferr-acoes">${pts.length ? '<button type="button" data-f="desfazer">Desfazer ponto</button>' : ''}${pts.length >= (modo === 'area' ? 3 : 2) ? '<button type="button" data-f="fim">Concluir</button>' : ''}<button type="button" data-f="sair">Sair</button></div><span class="dica">Dica: duplo clique conclui.</span>`;
        function iniciarMedida(m) {
            modo = m; pts = []; window.modoMedir = true; map.doubleClickZoom.disable(); map.getCanvas().style.cursor = 'crosshair';
            box.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.a === m)); desenhar(false);
        }
        function sairMedida(manter) {
            window.modoMedir = false; map.doubleClickZoom.enable(); map.getCanvas().style.cursor = ''; box.querySelectorAll('button').forEach(b => b.classList.remove('on'));
            if (!manter) { modo = null; pts = []; map.getSource('usr-med').setData(vazio); painel.hidden = true; }
        }
        map.on('click', e => { if (!window.modoMedir) return; e.originalEvent._pt = true; pts.push([e.lngLat.lng, e.lngLat.lat]); desenhar(false); });
        map.on('dblclick', e => { if (!window.modoMedir) return; e.preventDefault(); if (pts.length > 1 && pts[pts.length - 1][0] === pts[pts.length - 2][0]) pts.pop(); concluir(); });
        function concluir() { if (pts.length < (modo === 'area' ? 3 : 2)) return; sairMedida(true); desenhar(true); }
        function baixarKML() {
            const c = (modo === 'area' ? [...pts, pts[0]] : pts).map(p => `${p[0].toFixed(7)},${p[1].toFixed(7)},0`).join(' ');
            const geo = modo === 'area' ? `<Polygon><outerBoundaryIs><LinearRing><coordinates>${c}</coordinates></LinearRing></outerBoundaryIs></Polygon>` : `<LineString><coordinates>${c}</coordinates></LineString>`;
            const kml = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Medição CS</name><Placemark><name>${modo === 'area' ? 'Polígono' : 'Linha'} medido(a)</name>${geo}</Placemark></Document></kml>`;
            const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' })); a.download = `medicao_${modo}_${new Date().toISOString().slice(0, 10)}.kml`; a.click();
        }
        painel.addEventListener('click', e => {
            const f = e.target.dataset.f; if (!f) return;
            if (f === 'desfazer') { pts.pop(); desenhar(false); }
            else if (f === 'fim') concluir();
            else if (f === 'sair') sairMedida(false);
            else if (f === 'kml') baixarKML();
            else if (f === 'nova') iniciarMedida(modo);
            else if (f === 'fechar') painel.hidden = true;
            else if (f === 'raiox') { const alvo = { type: 'Feature', properties: { nome: 'Área desenhada' }, geometry: { type: 'Polygon', coordinates: [[...pts, pts[0]]] } }; painel.hidden = true; window.areaAnalisar(alvo); }
            else if (f === 'raiox-arq') { const p = ultimoPoligono; if (p) { painel.hidden = true; window.areaAnalisar({ type: 'Feature', properties: { nome: p.properties.name || 'Área do arquivo' }, geometry: p.geometry }); } }
        });
        box.addEventListener('click', e => {
            const a = e.target.closest('button')?.dataset.a; if (!a) return;
            if (a === 'abrir') inp.click();
            else if (a === 'limpar') { sairMedida(false); map.getSource('usr-arq').setData(vazio); painel.hidden = true; }
            else if (window.modoMedir && modo === a) sairMedida(false);
            else { if (window.modoRaioX && document.getElementById('btnRaioX')) document.getElementById('btnRaioX').click(); iniciarMedida(a); }
        });
        function mostrar(html) { painel.innerHTML = `<button type="button" class="ferr-x" data-f="fechar" title="Fechar">×</button>${html}`; painel.hidden = false; }
    }
    iniciar();
})();
