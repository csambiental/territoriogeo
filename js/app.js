// =====================================================================
// Mapa interativo de cliente – CS Consultoria Ambiental
// Dados: data/fazendas.json (fazendas, CAR, área, adequações e status)
//        data/<fazenda>.geojson (perímetros)
// Para atualizar o andamento, basta mudar o "status" de cada adequação
// em data/fazendas.json: "Pendente", "Em andamento" ou "Concluída".
// =====================================================================

mapboxgl.accessToken = 'pk.eyJ1IjoiY3NhbWJpZW50YWwiLCJhIjoiY205MWk4eHU4MDE3czJxcHNqamR4emd5aiJ9.e8K-ENRHJwXTz_FGGwYExg';

const STATUS = {
    'Concluída':    { cor: '#2e9e5b', classe: 'ok' },
    'Em andamento': { cor: '#e0a100', classe: 'andamento' },
    'Pendente':     { cor: '#9aa0a6', classe: 'pendente' }
};
const ORDEM_STATUS = ['Concluída', 'Em andamento', 'Pendente'];

// Paleta das fazendas (cores distintas e legíveis sobre o satélite)
const PALETA = ['#ff6b4a', '#4fc3f7', '#ba68c8', '#ffd54f', '#81c784', '#f06292', '#4db6ac', '#ffb74d'];

let fazendas = [];
let geojsons = {};
let camadas = [];       // camadas extras (pivôs, represas...)
const camadasData = {};
let selecionada = null;
let mostrarPreenchimento = true;
const ocultas = new Set(); // camadas base desligadas pelo usuário
const ligada = (id) => !ocultas.has(id);

// Imagem de satélite mais recente: Esri World Imagery (Vantor/Maxar, ago/2025, 0,34 m na região)
const ESTILO_ESRI = {
    version: 8,
    glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf',
    sources: {
        esri: {
            type: 'raster',
            tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
            tileSize: 256,
            maxzoom: 19,
            attribution: 'Imagens © Esri, Vantor, Maxar, Earthstar Geographics'
        }
    },
    layers: [{ id: 'esri', type: 'raster', source: 'esri' }]
};
const ESTILOS = {
    esri: ESTILO_ESRI,
    mapbox: 'mapbox://styles/mapbox/satellite-streets-v12',
    mapa: 'mapbox://styles/mapbox/outdoors-v12'
};

const map = new mapboxgl.Map({
    container: 'map',
    style: ESTILO_ESRI,
    center: [-49.955, -21.75],
    zoom: 11,
    preserveDrawingBuffer: true
});
map.addControl(new mapboxgl.NavigationControl(), 'top-right');
map.addControl(new mapboxgl.FullscreenControl(), 'top-right');
map.addControl(new mapboxgl.ScaleControl({ unit: 'metric' }), 'bottom-left');

// ---------- utilidades ----------
const fmt = (n, casas = 0) => Number(n).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
const esc = (t) => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Rótulo no singular/plural: "1 concluída", "2 concluídas"
function rotulo(status, n) {
    const plural = { 'Concluída': 'concluídas', 'Em andamento': 'em andamento', 'Pendente': 'pendentes' };
    return n === 1 ? status.toLowerCase() : plural[status];
}

function contarStatus(lista) {
    const c = { 'Concluída': 0, 'Em andamento': 0, 'Pendente': 0 };
    lista.forEach(a => { c[a.status in c ? a.status : 'Pendente']++; });
    return c;
}

// Barra empilhada: concluída | em andamento | pendente
function barraProgresso(cont, total) {
    if (!total) return '';
    return ORDEM_STATUS.map(s => {
        const pct = cont[s] / total * 100;
        return pct > 0 ? `<span style="width:${pct}%;background:${STATUS[s].cor}" title="${s}: ${cont[s]}"></span>` : '';
    }).join('');
}

function boundsDe(geojson) {
    const b = turf.bbox(geojson);
    return [[b[0], b[1]], [b[2], b[3]]];
}

// ---------- painel lateral ----------
let dadosGerais = {};
function renderResumo() {
    const todas = fazendas.flatMap(f => f.adequacoes);
    if (dadosGerais.resumo) {
        document.querySelector('.kpis').innerHTML = dadosGerais.resumo.map(k =>
            `<div class="kpi"><span class="kpi-value">${esc(k.valor)}</span><span class="kpi-label">${esc(k.rotulo)}</span></div>`).join('');
    }
    if (!todas.length) {
        document.querySelectorAll('.progress-label, #progressTotal, #statusLegend').forEach(el => el.style.display = 'none');
        return;
    }
    const cont = contarStatus(todas);
    const areaTotal = fazendas.reduce((s, f) => s + f.area_ha, 0);
    document.getElementById('kpiFazendas').textContent = fazendas.length;
    document.getElementById('kpiArea').textContent = fmt(areaTotal);
    document.getElementById('kpiAdequacoes').textContent = todas.length;
    const pct = todas.length ? Math.round(cont['Concluída'] / todas.length * 100) : 0;
    document.getElementById('kpiPct').textContent = `${pct}% concluído`;
    document.getElementById('progressTotal').innerHTML = barraProgresso(cont, todas.length);
    document.getElementById('statusLegend').innerHTML = ORDEM_STATUS.map(s =>
        `<span class="chip"><i style="background:${STATUS[s].cor}"></i>${cont[s]} ${rotulo(s, cont[s])}</span>`).join('');
}

let filtroFazendas = '';
let filtroGrupo = '';
let filtroEtapa = '';
// ---------- camadas opcionais (botão liga/desliga): bacias, microbacias ----------
const opcionaisData = {};
const opcionaisAtivas = new Set();
function antesDasFazendas() { return fazendas.map(f => `${f.id}-fill`).find(id => map.getLayer(id)); }
function desenharOpcional(o) {
    const g = opcionaisData[o.id];
    if (!g || map.getSource(`op-${o.id}`)) return;
    const antes = (o.antes && map.getLayer(o.antes)) ? o.antes : antesDasFazendas();
    if (o.tipo === 'imagem') {
        map.addSource(`op-${o.id}`, { type: 'image', url: g.imagem, coordinates: g.cantos });
        map.addLayer({ id: `op-${o.id}`, type: 'raster', source: `op-${o.id}`, paint: { 'raster-opacity': o.opacidade ?? 0.8, 'raster-resampling': 'nearest' } }, antes);
        return;
    }
    map.addSource(`op-${o.id}`, { type: 'geojson', data: g });
    if (o.preenchimento) map.addLayer({ id: `op-${o.id}-fill`, type: 'fill', source: `op-${o.id}`, paint: { 'fill-color': o.cor, 'fill-opacity': o.preenchimento } }, antes);
    if (o.halo) map.addLayer({ id: `op-${o.id}-halo`, type: 'line', source: `op-${o.id}`, paint: { 'line-color': '#000000', 'line-width': (o.largura || 1.5) + 2.5, 'line-opacity': 0.4 } }, antes);
    if (o.clicavel && o.geometria !== 'linha') map.addLayer({ id: `op-${o.id}-hit`, type: 'fill', source: `op-${o.id}`, paint: { 'fill-color': '#000000', 'fill-opacity': 0.01 } }, antes);
    const largura = o.geometria === 'linha'
        ? ['interpolate', ['linear'], ['coalesce', ['get', 'ordem'], 3], 3, 1.2, 5, 2.2, 7, 3.6, 9, 5]
        : (o.largura || 1.5);
    map.addLayer({ id: `op-${o.id}`, type: 'line', source: `op-${o.id}`,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': o.cor, 'line-width': largura, 'line-opacity': o.opacidade ?? 0.95, ...(o.tracejado ? { 'line-dasharray': o.tracejado } : {}) } }, antes);
    if (o.geometria === 'linha' && o.rotulo_campo) try {
        map.addLayer({ id: `op-${o.id}-nome`, type: 'symbol', source: `op-${o.id}`, minzoom: o.rotulo_minzoom || 9,
            layout: { 'symbol-placement': 'line', 'text-field': ['get', o.rotulo_campo], 'text-size': 11.5, 'symbol-spacing': 350,
                      'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'], 'text-letter-spacing': 0.03 },
            paint: { 'text-color': '#e1f5fe', 'text-halo-color': '#01579b', 'text-halo-width': 1.4 } });
    } catch (err) { console.warn('Nomes dos rios indisponíveis', err); }
    else if (o.rotulo_campo) try {
        const pts = { type: 'FeatureCollection', features: g.features.filter(f => f.properties[o.rotulo_campo]).map(f => ({ type: 'Feature', properties: f.properties, geometry: turf.pointOnFeature(f).geometry })) };
        map.addSource(`op-${o.id}-pts`, { type: 'geojson', data: pts });
        map.addLayer({ id: `op-${o.id}-nome`, type: 'symbol', source: `op-${o.id}-pts`, minzoom: o.rotulo_minzoom || 0,
            layout: { 'text-field': ['get', o.rotulo_campo], 'text-size': o.rotulo_tamanho || 12, 'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'], 'text-max-width': 9 },
            paint: { 'text-color': o.cor, 'text-halo-color': '#000000', 'text-halo-width': 1.5 } });
    } catch (err) { console.warn('Rótulos indisponíveis', err); }
}
function removerOpcional(o) {
    [`op-${o.id}-nome`, `op-${o.id}`, `op-${o.id}-halo`, `op-${o.id}-fill`, `op-${o.id}-hit`].forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
    [`op-${o.id}-pts`, `op-${o.id}`].forEach(id => { if (map.getSource(id)) map.removeSource(id); });
}
function camadasBase() {
    const corProp = Object.values(dadosGerais.agrupar_por?.cores || {})[0] || fazendas[0]?.cor || '#ffd54f';
    const base = [];
    if (fazendas.length) base.push({ id: 'propriedades', nome: 'Áreas das propriedades', cor: corProp, icone: 'area' },
                                    { id: 'preenchimento', nome: 'Preenchimento das áreas', cor: corProp, icone: 'fill' });
    camadas.forEach(c => base.push({ id: c.id, nome: c.nome, icone: c.tipo === 'circle' ? 'dot' : (c.tipo === 'fill' ? 'fill' : 'line'),
        cor: c.cores ? Object.values(c.cores)[0] : c.cor }));
    base.push({ id: 'nomes', nome: 'Nomes no mapa', icone: 'texto', cor: '#1d2a22' });
    return base;
}
function iconeCamada(o) {
    if (o.icone === 'dot') return `<i class="ic-dot" style="background:${o.cor}"></i>`;
    if (o.icone === 'fill' || o.icone === 'area') return `<i class="ic-area${o.icone === 'fill' ? ' cheia' : ''}" style="border-color:${o.cor};background:${o.cor}${o.icone === 'fill' ? '88' : '22'}"></i>`;
    if (o.icone === 'texto') return '<i class="ic-texto">Aa</i>';
    return `<i class="ic-line" style="border-color:${o.cor}"></i>`;
}
function renderOpcionais() {
    const lista = dadosGerais.camadas_opcionais || [];
    const el = document.getElementById('camadasOpcionais');
    if (!el) return;
    el.hidden = false;
    const linha = (o, tipo, on) => `<button type="button" class="camada-row${on ? ' ativo' : ''}" data-tipo="${tipo}" data-id="${esc(o.id)}" aria-pressed="${on}" title="${esc(o.fonte ? 'Fonte: ' + o.fonte : '')}">
        ${iconeCamada(o)}<span class="camada-nome">${esc(o.nome)}</span><span class="chave" aria-hidden="true"></span></button>`;
    const soltas = lista.filter(o => !o.grupo);
    const grupos = [...new Set(lista.filter(o => o.grupo).map(o => o.grupo))];
    // categorias de uma camada colorida por atributo (ex.: situação do CAR) com chave própria
    const subcats = (o) => {
        const c = camadas.find(x => x.id === o.id);
        if (!c || !c.categorias_ativaveis || !c.cor_por || !c.cores) return '';
        const ocl = catOcultas[c.id] || new Set();
        const feats = (camadasData[c.id] || {}).features || [];
        const itens = Object.entries(c.cores).map(([k, cor]) => {
            const n = feats.filter(f => f.properties[c.cor_por] === k).length;
            if (!n) return '';
            const on = !ocl.has(k);
            return `<button type="button" class="camada-row cat${on ? ' ativo' : ''}" data-tipo="cat" data-camada="${esc(c.id)}" data-cat="${esc(k)}" aria-pressed="${on}">
                <i class="ic-area cheia" style="border-color:${cor};background:${cor}aa"></i><span class="camada-nome">${esc(k)} <span class="lg-n">${n.toLocaleString('pt-BR')}</span></span><span class="chave" aria-hidden="true"></span></button>`;
        }).join('');
        const vis = Object.keys(c.cores).length - ocl.size;
        return `<details class="camada-grupo cats" open><summary><span class="camada-nome">Categorias</span><span class="lg-n">${ocl.size ? `${vis} de ${Object.keys(c.cores).length} ligadas` : 'todas ligadas'}</span></summary>
            <div class="cats-acoes"><button type="button" data-acao="todas" data-camada="${esc(c.id)}">Ligar todas</button><button type="button" data-acao="nenhuma" data-camada="${esc(c.id)}">Desligar todas</button></div>${itens}</details>`;
    };
    el.innerHTML = camadasBase().map(o => linha(o, 'base', ligada(o.id)) + subcats(o)).join('') +
        [...new Set(lista.map(o => o.secao || 'Hidrografia'))].map(sec => `<div class="camada-sub">${esc(sec)}</div>` +
            soltas.filter(o => (o.secao || 'Hidrografia') === sec).map(o => linha({ ...o, icone: o.icone || 'line' }, 'opc', opcionaisAtivas.has(o.id))).join('') +
            grupos.filter(g => (lista.find(o => o.grupo === g).secao || 'Hidrografia') === sec).map(g => {
                const itens = lista.filter(o => o.grupo === g);
                const ativos = itens.filter(o => opcionaisAtivas.has(o.id)).length;
                return `<details class="camada-grupo"${ativos ? ' open' : ''}><summary>${iconeCamada({ icone: 'line', cor: itens[0].cor })}<span class="camada-nome">${esc(g)}</span><span class="lg-n">${ativos ? `${ativos} ligada${ativos > 1 ? 's' : ''}` : `${itens.length} bacias`}</span></summary>
                    ${itens.map(o => linha({ ...o, icone: 'line' }, 'opc', opcionaisAtivas.has(o.id))).join('')}</details>`;
            }).join('')).join('');
    el.querySelectorAll('.camada-row[data-tipo=cat]').forEach(b => b.addEventListener('click', () => {
        const id = b.dataset.camada, k = b.dataset.cat;
        const ocl = catOcultas[id] = catOcultas[id] || new Set();
        if (ocl.has(k)) ocl.delete(k); else ocl.add(k);
        aplicarCategorias(id); renderOpcionais(); renderLegenda();
    }));
    el.querySelectorAll('.cats-acoes button').forEach(b => b.addEventListener('click', () => {
        const c = camadas.find(x => x.id === b.dataset.camada);
        catOcultas[c.id] = b.dataset.acao === 'todas' ? new Set() : new Set(Object.keys(c.cores));
        aplicarCategorias(c.id); renderOpcionais(); renderLegenda();
    }));
    el.querySelectorAll('.camada-row[data-tipo=base]').forEach(b => b.addEventListener('click', () => {
        const id = b.dataset.id;
        if (ocultas.has(id)) ocultas.delete(id); else ocultas.add(id);
        const on = ligada(id);
        b.classList.toggle('ativo', on); b.setAttribute('aria-pressed', on);
        aplicarFiltroMapa(); aplicarVisibilidadeCamadas(); renderLegenda();
    }));
    el.querySelectorAll('.camada-row[data-tipo=opc]').forEach(b => b.addEventListener('click', async () => {
        const o = lista.find(x => x.id === b.dataset.id);
        if (opcionaisAtivas.has(o.id)) {
            opcionaisAtivas.delete(o.id); removerOpcional(o);
        } else {
            b.classList.add('carregando');
            try {
                if (!opcionaisData[o.id]) opcionaisData[o.id] = await (await fetch(o.arquivo, { cache: 'no-cache' })).json();
                opcionaisAtivas.add(o.id); desenharOpcional(o); aplicarVisibilidadeCamadas();
            } catch (err) { console.error(err); alertaCamada(b); }
            b.classList.remove('carregando');
        }
        const on = opcionaisAtivas.has(o.id);
        b.classList.toggle('ativo', on); b.setAttribute('aria-pressed', on);
        if (on && o.enquadrar && opcionaisData[o.id]) map.fitBounds(boundsDe(opcionaisData[o.id]), { padding: 40, duration: 900 });
        const grp = b.closest('.camada-grupo');
        if (grp) { const n = grp.querySelectorAll('.camada-row.ativo').length; grp.querySelector('summary .lg-n').textContent = n ? `${n} ligada${n > 1 ? 's' : ''}` : `${grp.querySelectorAll('.camada-row').length} bacias`; }
        renderLegenda();
    }));
}
function alertaCamada(b) { b.title = 'Camada indisponível no momento'; b.classList.add('erro'); }

function popupOpcional(e, soPrioritarias) {
    const lista = (dadosGerais.camadas_opcionais || []).filter(o => opcionaisAtivas.has(o.id) && o.clicavel && (!soPrioritarias || o.prioridade));
    const ids = lista.flatMap(o => [`op-${o.id}-hit`, `op-${o.id}`]).filter(id => map.getLayer(id));
    if (!ids.length) return false;
    const caixa = [[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]];
    const hit = map.queryRenderedFeatures(caixa, { layers: ids });
    if (!hit.length) return false;
    // prioriza rios (linhas) sobre áreas
    const h = hit.find(x => lista.some(o => o.prioridade && x.source === `op-${o.id}`)) || hit.find(x => x.layer.type === 'line' && x.source.startsWith('op-rios')) || hit[0];
    const p = h.properties;
    const oc = lista.find(o => h.source === `op-${o.id}`) || {};
    const linhas = oc.campos ? camposDe(oc, p).map(k => [k, p[k]]) : [];
    if (!oc.campos) Object.keys(p).filter(k => k.startsWith('MapBiomas')).forEach(k => linhas.push([k, p[k]]));
    if (p.rio && p.nome !== p.rio) linhas.push(['Curso d’água', p.rio]);
    if (p.bacia) linhas.push(['Bacia hidrográfica', p.bacia]);
    if (p.area_km2) linhas.push(['Área', `${fmt(p.area_km2, 2)} km²`]);
    if (p.ordem) linhas.push(['Ordem (Strahler)', p.ordem]);
    if (p.dominio) linhas.push(['Domínio', p.dominio === 'E' ? 'Estadual' : (p.dominio === 'U' ? 'Federal' : p.dominio)]);
    if (p.cobacia) linhas.push(['Código Otto', p.cobacia]);
    if (p.regiao_hidrografica) linhas.push(['Região hidrográfica', p.regiao_hidrografica]);
    new mapboxgl.Popup({ maxWidth: '300px' }).setLngLat(e.lngLat)
        .setHTML(`<div class="popup"><h3>${esc(p.nome || 'Sem nome')}</h3><dl class="popup-dl">${linhas.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
            ${linkHtml(p)}<p class="popup-hint">Fonte: ${esc(oc.fonte || 'ANA – Base Hidrográfica Ottocodificada')}</p></div>`).addTo(map);
    return true;
}

function camposDe(c, p) {
    const lista = [...(c.campos || [])];
    (c.campos_prefixos || []).forEach(pre => Object.keys(p).filter(k => k.startsWith(pre) && !lista.includes(k)).forEach(k => lista.push(k)));
    return lista.filter(k => p[k] !== undefined && p[k] !== null && p[k] !== '');
}
function linkHtml(p) { return p.link ? `<a class="btn btn-mini" href="${esc(p.link)}" target="_blank" rel="noopener">${esc(p.link_texto || 'Ver no MapBiomas Alerta ↗')}</a>` : ''; }
// categorias ocultas por camada (ex.: imóveis 'Cancelado' desligados)
const catOcultas = {};
function aplicarCategorias(id) {
    const c = camadas.find(x => x.id === id); if (!c) return;
    const ocl = [...(catOcultas[id] || [])];
    const filtro = ocl.length ? ['!', ['in', ['get', c.cor_por], ['literal', ocl]]] : null;
    [`cam-${id}`, `cam-${id}-line`].forEach(l => { if (map.getLayer(l)) map.setFilter(l, filtro); });
}
// ---------- camada de imóveis: busca por CAR e troca de coloração ----------
function camadaBusca() { return camadas.find(c => c.id === dadosGerais.busca_camada); }
function mostrarFeicao(c, f) {
    map.fitBounds(boundsDe(f), { padding: 80, maxZoom: 15, duration: 900 });
    if (map.getLayer(`cam-${c.id}-sel`)) map.setFilter(`cam-${c.id}-sel`, ['==', ['get', 'nome'], f.properties.nome]);
    const p = f.properties, cor = (c.cores || {})[p[c.cor_por]] || '#777';
    const tabela = camposDe(c, p).map(k => `<dt>${esc(k)}</dt><dd>${esc(p[k])}</dd>`).join('');
    setTimeout(() => new mapboxgl.Popup({ maxWidth: '320px' }).setLngLat(turf.pointOnFeature(f).geometry.coordinates)
        .setHTML(`<div class="popup"><h3 class="mono" style="font-size:.8rem">${esc(p.nome)}</h3><span class="status-badge" style="background:${cor}">${esc(p[c.cor_por])}</span><dl class="popup-dl">${tabela}</dl></div>`).addTo(map), 950);
}
function renderBuscaCamada() {
    const c = camadaBusca(); if (!c) return;
    const busca = document.getElementById('farmSearch'), lista = document.getElementById('farmList');
    busca.hidden = false; busca.placeholder = dadosGerais.busca_placeholder || 'Buscar pelo número do CAR';
    const feats = (camadasData[c.id] || {}).features || [];
    const desenhar = () => {
        const q = busca.value.trim().toUpperCase().replace(/[.\s]/g, '');
        if (q.length < 3) { lista.innerHTML = `<p class="hint">${feats.length.toLocaleString('pt-BR')} imóveis no mapa. Digite parte do número do CAR (ex.: 4113700-2F) ou clique num imóvel no mapa.</p>`; return; }
        const achados = feats.filter(f => f.properties.nome.toUpperCase().replace(/[.\s]/g, '').includes(q)).slice(0, 12);
        lista.innerHTML = achados.length ? achados.map((f, i) => `<button type="button" class="busca-item" data-i="${feats.indexOf(f)}">
            <span class="swatch" style="background:${(c.cores || {})[f.properties[c.cor_por]] || '#777'}"></span><span class="mono">${esc(f.properties.nome)}</span>
            <span class="farm-meta">${esc(f.properties['Área (ha)'] || '')} ha</span></button>`).join('') : '<p class="hint">Nenhum imóvel encontrado.</p>';
        lista.querySelectorAll('.busca-item').forEach(b => b.addEventListener('click', () => mostrarFeicao(c, feats[Number(b.dataset.i)])));
    };
    busca.oninput = desenhar; desenhar();
}
function renderModosCor() {
    const c = camadas.find(x => x.cor_por_opcoes); const el = document.getElementById('modoCor');
    if (!c || !el) return;
    el.hidden = false;
    el.innerHTML = c.cor_por_opcoes.map((o, i) => `<button type="button" data-i="${i}" class="${i === 0 ? 'active' : ''}">${esc(o.rotulo)}</button>`).join('');
    const aplicar = (o) => {
        c.cor_por = o.campo; c.cores = o.cores; c.nome = o.titulo || c.nome;
        catOcultas[c.id] = new Set(); aplicarCategorias(c.id); renderOpcionais();
        if (map.getLayer(`cam-${c.id}`)) map.setPaintProperty(`cam-${c.id}`, 'fill-color', ['match', ['get', o.campo], ...Object.entries(o.cores).flat(), '#777777']);
        renderLegenda(); if (camadaBusca() === c) renderBuscaCamada();
    };
    aplicar(c.cor_por_opcoes[0]);
    el.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
        el.querySelectorAll('button').forEach(o => o.classList.toggle('active', o === b));
        aplicar(c.cor_por_opcoes[Number(b.dataset.i)]);
    }));
}

// Cores das áreas: 'municipio' (uma cor por município) ou 'situacao' (cor da situação)
let modoCor = 'situacao';
const corMapa = (f) => (modoCor === 'municipio' && f.cor_municipio) ? f.cor_municipio : f.cor;
function corMunicipios(c) { return (modoCor === 'municipio' || !dadosGerais.cores_por_municipio) ? ['coalesce', ['get', 'cor'], c.cor] : '#ffffff'; }
function aplicarCores() {
    if (!map.style) return;
    fazendas.forEach(f => {
        if (map.getLayer(`${f.id}-fill`)) map.setPaintProperty(`${f.id}-fill`, 'fill-color', corMapa(f));
        if (map.getLayer(`${f.id}-line`)) map.setPaintProperty(`${f.id}-line`, 'line-color', corMapa(f));
    });
    camadas.filter(c => c.destaque).forEach(c => {
        const cor = corMunicipios(c);
        if (map.getLayer(`cam-${c.id}`)) map.setPaintProperty(`cam-${c.id}`, 'line-color', cor);
        if (map.getLayer(`cam-${c.id}-fill`)) map.setPaintProperty(`cam-${c.id}-fill`, 'fill-color', cor);
        if (map.getLayer(`cam-${c.id}-nome`)) map.setPaintProperty(`cam-${c.id}-nome`, 'text-color', cor);
    });
}
const ehPonto = (id) => geojsons[id]?.features?.[0]?.geometry?.type === 'Point';
function naEtapa(f) {
    const cfg = dadosGerais.filtro_etapa;
    return !cfg || !filtroEtapa || f[cfg.campo] === filtroEtapa;
}
function renderFiltroEtapa() {
    const cfg = dadosGerais.filtro_etapa;
    const el = document.getElementById('filtroEtapa');
    if (!cfg || !el) return;
    const rot = cfg.rotulos || cfg.opcoes;
    el.innerHTML = `<button type="button" data-etapa="" class="active">Todas</button>` +
        cfg.opcoes.map((o, i) => `<button type="button" data-etapa="${esc(o)}" title="${esc(o)}">${esc(rot[i])}</button>`).join('');
    el.hidden = false;
    el.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
        el.querySelectorAll('button').forEach(o => o.classList.toggle('active', o === b));
        filtroEtapa = b.dataset.etapa;
        if (selecionada && !naEtapa(fazendas.find(f => f.id === selecionada))) selecionada = null;
        renderFazendas();
        renderLegenda();
        aplicarFiltroMapa();
        enquadrarTodas();
    }));
}
function aplicarFiltroMapa() {
    if (!map.style) return;
    fazendas.forEach(f => {
        const vis = naEtapa(f);
        ['fill', 'halo', 'line'].forEach(t => {
            const id = `${f.id}-${t}`;
            if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis && ligada('propriedades') && (t !== 'fill' || (mostrarPreenchimento && ligada('preenchimento'))) ? 'visible' : 'none');
        });
    });
    const cfg = dadosGerais.filtro_etapa;
    if (!cfg) return;
    const filtro = filtroEtapa ? ['==', ['get', cfg.campo], filtroEtapa] : null;
    camadas.forEach(c => ['', '-label', '-line'].forEach(suf => {
        const id = `cam-${c.id}${suf}`;
        if (map.getLayer(id) && (camadasData[c.id]?.features || []).some(x => x.properties[cfg.campo])) map.setFilter(id, filtro);
    }));
    if (map.getLayer('rotulos')) map.setFilter('rotulos', filtro);
    const curto = filtroEtapa ? (cfg.rotulos || cfg.opcoes)[cfg.opcoes.indexOf(filtroEtapa)] : '';
    camadas.filter(c => c.destaque).forEach(c => {
        const fm = curto ? ['in', curto, ['get', 'etapas']] : null;
        ['', '-fill', '-halo', '-nome'].forEach(suf => { if (map.getLayer(`cam-${c.id}${suf}`)) map.setFilter(`cam-${c.id}${suf}`, fm); });
    });
}
function aplicarVisibilidadeCamadas() {
    if (!map.style) return;
    const vis = (on) => on ? 'visible' : 'none';
    camadas.forEach(c => ['', '-fill', '-halo', '-line', '-label'].forEach(suf => {
        const id = `cam-${c.id}${suf}`;
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis(ligada(c.id)));
    }));
    camadas.forEach(c => { if (map.getLayer(`cam-${c.id}-nome`)) map.setLayoutProperty(`cam-${c.id}-nome`, 'visibility', vis(ligada(c.id) && ligada('nomes'))); });
    if (map.getLayer('rotulos')) map.setLayoutProperty('rotulos', 'visibility', vis(ligada('nomes') && ligada('propriedades')));
    (dadosGerais.camadas_opcionais || []).forEach(o => { if (map.getLayer(`op-${o.id}-nome`)) map.setLayoutProperty(`op-${o.id}-nome`, 'visibility', vis(ligada('nomes'))); });
}
function etapaCurta() {
    const cfg = dadosGerais.filtro_etapa;
    return cfg && filtroEtapa ? (cfg.rotulos || cfg.opcoes)[cfg.opcoes.indexOf(filtroEtapa)] : '';
}
const semAcento = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function renderFazendas() {
    if (dadosGerais.busca_camada && !fazendas.length) return;
    const el = document.getElementById('farmList');
    const busca = document.getElementById('farmSearch');
    if (busca) busca.hidden = fazendas.length <= 8;
    const campoGrupo = dadosGerais.agrupar_por?.campo;
    el.innerHTML = fazendas
        .filter(f => naEtapa(f))
        .filter(f => !filtroGrupo || f[campoGrupo] === filtroGrupo)
        .filter(f => !filtroFazendas || semAcento(f.nome + ' ' + Object.values(f.info || {}).join(' ')).includes(filtroFazendas)).map(f => {
        const cont = contarStatus(f.adequacoes);
        const aberta = selecionada === f.id;
        const itens = f.adequacoes.map(a => {
            const st = STATUS[a.status] || STATUS['Pendente'];
            const quando = a.concluida_em ? ` · ${esc(a.concluida_em)}` : '';
            const nota = a.nota ? `<span class="item-note">${esc(a.nota)}</span>` : '';
            const docs = (a.documentos || []).map(d =>
                `<button type="button" class="doc-btn" data-arquivo="${esc(d.arquivo)}" data-titulo="${esc(d.titulo)}">📄 ${esc(d.titulo)}</button>`).join('');
            const extra = (nota || docs) ? `<span class="item-extra">${nota}${docs ? `<span class="doc-list">${docs}</span>` : ''}</span>` : '';
            return `<li><span class="status-dot" style="background:${st.cor}"></span>
                        <span class="item-text">${esc(a.item)}</span>
                        <span class="status-tag ${st.classe}">${esc(a.status)}${quando}</span>${extra}</li>`;
        }).join('');
        return `
        <article class="farm ${aberta ? 'open' : ''}" data-id="${f.id}">
            <button class="farm-head" type="button" aria-expanded="${aberta}">
                <span class="swatch" style="background:${f.cor}"></span>
                <span class="farm-name">${esc(f.nome)}</span>
                <span class="farm-meta">${f.area_ha ? `${fmt(f.area_ha, 1)} ha` : (f.nascentes ? `${f.nascentes} nasc.` : '')}${f.adequacoes.length ? ` · ${cont['Concluída']}/${f.adequacoes.length}` : ''}</span>
            </button>
            ${f.adequacoes.length ? `<div class="mini-progress">${barraProgresso(cont, f.adequacoes.length)}</div>` : ''}
            <div class="farm-body">
                <dl>
                    <dt>CAR</dt><dd class="mono">${esc(f.car)}</dd>
                    ${f.area_ha ? `<dt>Área declarada</dt><dd>${fmt(f.area_ha, 2)} ha</dd>` : ''}
                    ${f.situacao_car ? `<dt>Situação do CAR</dt><dd>${esc(f.situacao_car)}</dd>` : ''}
                    ${Object.entries(f.info || {}).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
                </dl>
                ${fichaHtml(f)}
                ${indicadoresHtml(f)}
                ${f.adequacoes.length ? `<h3>Adequações (${f.adequacoes.length})</h3><ul class="adeq-list">${itens}</ul>` : ''}
                ${(f.documentos || []).map(d => `<button type="button" class="doc-btn" data-arquivo="${esc(d.arquivo)}" data-titulo="${esc(d.titulo)}">📄 ${esc(d.titulo)}</button>`).join('')}
                ${/^[A-Z]{2}-\d{7}-/.test(f.car || '') ? `<a class="link" href="https://www.registrorural.com.br/car/item/${encodeURIComponent(f.car)}" target="_blank" rel="noopener">Consultar o CAR no Registro Rural ↗</a>` : ''}
            </div>
        </article>`;
    }).join('');

    el.querySelectorAll('.farm-body > .doc-btn').forEach(btn => {
        btn.addEventListener('click', () => abrirDocumento(btn.dataset.titulo, btn.dataset.arquivo));
    });
    el.querySelectorAll('.doc-list .doc-btn').forEach(btn => {
        btn.addEventListener('click', () => abrirDocumento(btn.dataset.titulo, btn.dataset.arquivo));
    });
    el.querySelectorAll('.farm-head').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.closest('.farm').dataset.id;
            selecionarFazenda(selecionada === id ? null : id, true);
        });
    });
}

// ---------- visualizador de documentos ----------
const docDialog = document.getElementById('docDialog');
function abrirDocumento(titulo, arquivo, opcoes = {}) {
    document.getElementById('docTitle').textContent = titulo;
    document.getElementById('docFrame').src = opcoes.embed || arquivo;
    document.getElementById('docOpen').href = arquivo;
    document.getElementById('docOpen').textContent = opcoes.abrirTexto || 'Abrir em nova aba';
    document.getElementById('docDownload').href = arquivo;
    document.getElementById('docDownload').style.display = opcoes.semDownload ? 'none' : '';
    docDialog.classList.toggle('largo', !!opcoes.largo);
    docDialog.showModal();
}
// Painel de indicadores externo (ex.: Looker Studio)
function renderIndicadoresExternos() {
    const ext = dadosGerais.painel_externo;
    const card = document.querySelector('.sidebar .card');
    if (!ext || !card || document.getElementById('btnPainelExterno')) return;
    const b = document.createElement('button');
    b.type = 'button'; b.id = 'btnPainelExterno'; b.className = 'btn btn-externo';
    b.innerHTML = `📊 ${esc(ext.botao || 'Ver painel de indicadores')}`;
    b.addEventListener('click', () => abrirDocumento(ext.titulo || 'Painel de indicadores', ext.url,
        { embed: ext.embed, semDownload: true, largo: true, abrirTexto: ext.abrir_texto || 'Abrir em nova aba' }));
    card.appendChild(b);
}
document.getElementById('docClose').addEventListener('click', () => docDialog.close());
docDialog.addEventListener('click', (e) => { if (e.target === docDialog) docDialog.close(); });
docDialog.addEventListener('close', () => { document.getElementById('docFrame').src = 'about:blank'; });

// Documentos de uma fazenda (sem repetir)
function documentosDa(f) {
    const vistos = new Map();
    f.adequacoes.forEach(a => (a.documentos || []).forEach(d => vistos.set(d.arquivo, d)));
    return [...vistos.values()];
}

// Indicadores do CAR (ha). "Saldo" negativo = déficit
// ---------- ficha da propriedade: dados do CAR, relato da visita e fotos ----------
function galeriaHtml(f, max) {
    const fotos = f.fotos || [];
    if (!fotos.length) return '';
    const mostrar = max ? fotos.slice(0, max) : fotos;
    const resto = fotos.length - mostrar.length;
    return `<div class="galeria">${mostrar.map((ft, i) =>
        `<button type="button" class="foto-mini${ft.tipo === 'mapa' ? ' mapa' : ''}" data-fazenda="${esc(f.id)}" data-idx="${i}" title="${esc(ft.legenda)}">
            <img src="${esc(ft.mini)}" alt="${esc(ft.legenda)}" loading="lazy">${i === mostrar.length - 1 && resto > 0 ? `<span class="foto-mais">+${resto}</span>` : ''}</button>`).join('')}</div>`;
}
function fichaHtml(f) {
    let h = '';
    if (f.data_visita) h += `<p class="ficha-linha"><strong>Visita técnica:</strong> ${esc(f.data_visita)}</p>`;
    const cad = f.cadastro || [];
    if (cad.length) {
        h += `<h3>Dados cadastrais (CAR)</h3>` + cad.map((im, i) => `${cad.length > 1 ? `<p class="ficha-sub">Imóvel ${i + 1}</p>` : ''}
            <dl class="ficha-dl">${Object.entries(im).filter(([k, v]) => !(k === 'CAR' && cad.length === 1 && v === f.car)).map(([k, v]) => `<dt>${esc(k)}</dt><dd${k === 'CAR' ? ' class="mono"' : ''}>${esc(v)}</dd>`).join('')}</dl>`).join('');
    }
    const rel = f.relato || {};
    const chaves = Object.keys(rel);
    if (chaves.length) h += `<h3>Relatório da visita</h3>` + chaves.map((k, i) =>
        `<details class="relato"${i === 0 ? ' open' : ''}><summary>${esc(k)}</summary><p>${esc(rel[k])}</p></details>`).join('');
    if ((f.fotos || []).length) h += `<h3>Fotos e mapas (${f.fotos.length})</h3>${galeriaHtml(f)}`;
    return h;
}
// visualizador de fotos
let fotoAtual = { f: null, i: 0 };
function abrirFoto(id, idx) {
    const f = fazendas.find(x => x.id === id);
    if (!f || !(f.fotos || []).length) return;
    fotoAtual = { f, i: idx };
    mostrarFoto();
    const dlg = document.getElementById('fotoDialog');
    if (!dlg.open) dlg.showModal();
}
function mostrarFoto() {
    const { f, i } = fotoAtual, ft = f.fotos[i];
    document.getElementById('fotoImg').src = ft.arquivo;
    document.getElementById('fotoImg').alt = ft.legenda;
    document.getElementById('fotoLegenda').textContent = ft.legenda;
    document.getElementById('fotoTitulo').textContent = f.nome;
    document.getElementById('fotoContador').textContent = `${i + 1} / ${f.fotos.length}`;
    document.getElementById('fotoAbrir').href = ft.arquivo;
}
function passarFoto(d) {
    const n = fotoAtual.f.fotos.length;
    fotoAtual.i = (fotoAtual.i + d + n) % n;
    mostrarFoto();
}
document.addEventListener('click', (e) => {
    const b = e.target.closest('.foto-mini');
    if (b) { e.preventDefault(); abrirFoto(b.dataset.fazenda, Number(b.dataset.idx)); }
    const v = e.target.closest('.ver-ficha');
    if (v) { selecionarFazenda(v.dataset.fazenda, false); document.body.classList.remove('panel-closed'); }
});
(function prepararFotoDialog() {
    const dlg = document.getElementById('fotoDialog');
    if (!dlg) return;
    document.getElementById('fotoFechar').onclick = () => dlg.close();
    document.getElementById('fotoAnt').onclick = () => passarFoto(-1);
    document.getElementById('fotoProx').onclick = () => passarFoto(1);
    dlg.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') passarFoto(-1); if (e.key === 'ArrowRight') passarFoto(1); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
})();

function indicadoresHtml(f) {
    if (!f.indicadores) return '';
    const linhas = Object.entries(f.indicadores).map(([k, v]) => {
        const saldo = /saldo/i.test(k);
        const recompor = /recompor/i.test(k);
        const cls = saldo ? (v < 0 ? 'neg' : 'pos') : (recompor && v > 0 ? 'neg' : '');
        const txt = saldo && v < 0 ? `déficit de ${fmt(-v, 2)} ha` : (saldo ? `excedente de ${fmt(v, 2)} ha` : `${fmt(v, 2)} ha`);
        const pct = !saldo && !recompor && f.area_ha ? `<small>${fmt(v / f.area_ha * 100, 1)}%</small>` : '';
        return `<tr class="${cls}"><th>${esc(k)}</th><td>${txt} ${pct}</td></tr>`;
    }).join('');
    return `<h3>Indicadores do CAR</h3><table class="ind">${linhas}</table>`;
}

function docBotao(titulo, arquivo) {
    if (!arquivo) return '';
    return `<button type="button" class="doc-btn" onclick="abrirDocumento('${esc(titulo)}', '${esc(arquivo)}')">📄 ${esc(titulo)}</button>`;
}

// Legenda sobre o mapa: fazendas, camadas extras e pontos (com documento clicável)
function renderLegenda() {
    const el = document.getElementById('legend');
    if (!el) return;
    const itens = [];
    if (dadosGerais.agrupar_por && !ligada('propriedades')) {
        // propriedades ocultas: nada a mostrar desse grupo
    } else if (dadosGerais.agrupar_por) {
        const g = dadosGerais.agrupar_por;
        itens.push(`<div class="lg-group">${esc(g.titulo)}${modoCor === 'municipio' ? ' <span class="lg-n">(cor na lista · clique p/ filtrar)</span>' : ''}</div>`);
        Object.entries(g.cores).forEach(([k, cor]) => {
            const n = fazendas.filter(f => naEtapa(f) && f[g.campo] === k).length;
            if (n) itens.push(`<button type="button" class="lg-item lg-filtro" data-grupo="${esc(k)}"><i class="lg-area" style="border-color:${cor};background:${cor}55"></i>${esc(k)} (${n})</button>`);
        });
    } else if (dadosGerais.legenda_agrupada) {
        const cor = fazendas[0]?.cor || '#ffd54f';
        itens.push(`<div class="lg-item"><i class="lg-area" style="border-color:${cor};background:${cor}33"></i>${esc(dadosGerais.legenda_agrupada)} (${fazendas.length})</div>`);
    } else {
        fazendas.forEach(f => itens.push(`<div class="lg-item"><i class="lg-area" style="border-color:${f.cor};background:${f.cor}33"></i>${esc(f.nome)}</div>`));
    }
    camadas.filter(c => ligada(c.id)).forEach(c => {
        if (c.cor_por && c.cores) {
            const feats = (camadasData[c.id] || {}).features || [];
            const sub = Object.entries(c.cores).map(([k, cor]) => {
                const ce = dadosGerais.filtro_etapa?.campo;
                const grupo = feats.filter(f => f.properties[c.cor_por] === k && (!filtroEtapa || !ce || !f.properties[ce] || f.properties[ce] === filtroEtapa));
                if (!grupo.length) return '';
                const lista = c.listar ? grupo.map(f => f.properties.doc_arquivo
                    ? `<button type="button" class="lg-item lg-doc lg-leaf" data-titulo="${esc(f.properties.nome)} – ${esc(f.properties.Portaria || '')}" data-arquivo="${esc(f.properties.doc_arquivo)}">${esc(f.properties.nome)} 📄</button>`
                    : `<div class="lg-item lg-leaf">${esc(f.properties.nome)}</div>`).join('') : '';
                const off = (catOcultas[c.id] || new Set()).has(k);
                return `<div class="lg-item lg-sub${off ? ' lg-off' : ''}"><i class="${c.tipo === 'fill' ? 'lg-sq' : 'lg-dot'}" style="background:${cor}"></i>${esc(k)} (${grupo.length})</div>${lista}`;
            }).join('');
            itens.push(`<div class="lg-group">${esc(c.nome)}</div>${sub}`);
        } else if (c.destaque) {
            const curto = etapaCurta();
            const feats = ((camadasData[c.id] || {}).features || []).filter(f => !curto || String(f.properties.etapas).includes(curto))
                .sort((a, b) => a.properties.nome.localeCompare(b.properties.nome, 'pt-BR'));
            const porMun = modoCor === 'municipio' || !dadosGerais.cores_por_municipio;
            itens.push(`<div class="lg-group">${porMun ? '' : '<i class="lg-line" style="border-color:#ffffff"></i>'}${esc(c.nome)} (${feats.length})</div>` +
                `<div class="lg-muns">${feats.map(f => `<button type="button" class="lg-item lg-leaf lg-mun" data-mun="${esc(f.properties.nome)}" title="Aproximar em ${esc(f.properties.nome)}">${porMun ? `<i class="lg-area" style="border-color:${f.properties.cor};background:${f.properties.cor}55"></i>` : ''}<span class="lg-mun-nome">${esc(f.properties.nome)}</span> ${f.properties.propriedades ? `<span class="lg-n">${f.properties.propriedades}</span>` : ''}</button>`).join('')}</div>`);
        } else {
            itens.push(`<div class="lg-item"><i class="${c.tipo === 'fill' ? 'lg-sq' : 'lg-dot'}" style="background:${c.cor}"></i>${esc(c.nome)}</div>`);
        }
    });
    const opsAtivas = (dadosGerais.camadas_opcionais || []).filter(o => opcionaisAtivas.has(o.id));
    const gruposAtivos = [...new Set(opsAtivas.filter(o => o.grupo).map(o => o.grupo))];
    gruposAtivos.forEach(g => { const it = opsAtivas.filter(o => o.grupo === g);
        itens.push(`<div class="lg-item"><i class="lg-line" style="border-color:${it[0].cor}"></i>${esc(g)}: ${it.map(o => esc(o.nome)).join(', ')}</div>`); });
    opsAtivas.filter(o => !o.grupo && o.legenda_itens).forEach(o => itens.push(`<div class="lg-group">${esc(o.nome)}</div>` +
        o.legenda_itens.map(i => `<div class="lg-item lg-sub"><i class="lg-sq" style="background:${i.cor}"></i>${esc(i.rotulo)}</div>`).join('')));
    opsAtivas.filter(o => !o.grupo && !o.legenda_itens).forEach(o =>
        itens.push(`<div class="lg-item" title="Fonte: ${esc(o.fonte || '')}"><i class="lg-line" style="border-color:${o.cor}"></i>${esc(o.nome)}</div>`));
    fazendas.forEach(f => (f.pontos || []).forEach(p => {
        const conteudo = `<i class="lg-ring" style="border-color:${f.cor}"></i>${esc(p.nome)}`;
        itens.push(p.documento
            ? `<button type="button" class="lg-item lg-doc" data-titulo="${esc(p.documento.titulo)}" data-arquivo="${esc(p.documento.arquivo)}" title="Ver ${esc(p.documento.titulo)}">${conteudo} 📄</button>`
            : `<div class="lg-item">${conteudo}</div>`);
    }));
    const aberta = window.matchMedia('(min-width: 801px)').matches ? ' open' : '';
    el.innerHTML = `<details${aberta}><summary>Legenda</summary>${itens.join('')}</details>`;
    el.querySelectorAll('.lg-doc').forEach(b => b.addEventListener('click', () => abrirDocumento(b.dataset.titulo, b.dataset.arquivo)));
    el.querySelectorAll('.lg-mun').forEach(b => b.addEventListener('click', () => {
        const c = camadas.find(x => x.destaque);
        const f = (camadasData[c.id]?.features || []).find(x => x.properties.nome === b.dataset.mun);
        if (f) map.fitBounds(boundsDe(f), { padding: 40, duration: 900 });
    }));
    // Clique num grupo da legenda filtra a lista de propriedades
    el.querySelectorAll('.lg-filtro').forEach(b => b.addEventListener('click', () => {
        const ativo = b.classList.toggle('ativo');
        el.querySelectorAll('.lg-filtro').forEach(o => { if (o !== b) o.classList.remove('ativo'); });
        filtroGrupo = ativo ? b.dataset.grupo : '';
        renderFazendas();
        document.getElementById('farmList').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
}

// ---------- informações do programa ----------
function renderPrograma(pg) {
    const card = document.getElementById('cardPrograma');
    if (!pg || !card) return;
    card.hidden = false;
    const graficos = (pg.graficos || []).map(g => `
        <h3>${esc(g.titulo)}</h3>
        ${g.itens.map(i => `<div class="uso"><span>${esc(i.rotulo)}</span><span class="uso-bar"><i style="width:${i.pct}%"></i></span><strong>${fmt(i.pct, 1)}%</strong></div>`).join('')}
        ${g.fonte ? `<small class="fonte">${esc(g.fonte)}</small>` : ''}`).join('');
    const etapas = (pg.etapas || []).map(e => `<li class="${e.classe || ''}"><strong>${esc(e.nome)}</strong> ${esc(e.texto)}</li>`).join('');
    card.innerHTML = `<h2>${esc(pg.titulo || 'O programa')}</h2>
        ${pg.texto ? `<p class="prog-txt">${esc(pg.texto)}</p>` : ''}
        ${etapas ? `<ul class="etapas">${etapas}</ul>` : ''}
        ${(pg.documentos || []).map(d => `<button type="button" class="doc-btn" data-arquivo="${esc(d.arquivo)}" data-titulo="${esc(d.titulo)}">📄 ${esc(d.titulo)}</button>`).join('')}
        ${graficos}`;
    card.querySelectorAll('.doc-btn').forEach(b => b.addEventListener('click', () => abrirDocumento(b.dataset.titulo, b.dataset.arquivo)));
}

// ---------- próximos vencimentos ----------
// Regras de cor: vencido sem providência = vermelho; vencido com providência em andamento = laranja;
// vence em até 90 dias = amarelo; mais de 90 dias = verde.
function renderPrazos(prazos) {
    const card = document.getElementById('cardPrazos');
    if (!prazos || !prazos.length) return;
    card.hidden = false;
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const dia = 86400000;
    const itens = prazos.map(p => {
        const [a, m, d] = p.data.split('-').map(Number);
        const data = new Date(a, m - 1, d);
        const dias = Math.round((data - hoje) / dia);
        let classe, rotuloPrazo;
        if (dias < 0) {
            classe = p.andamento ? 'andamento' : 'vencido';
            const meses = Math.round(-dias / 30.4);
            rotuloPrazo = meses >= 2 ? `vencido há ${meses} meses` : `vencido há ${-dias} dias`;
        } else {
            classe = dias <= 90 ? 'proximo' : 'ok';
            const meses = Math.round(dias / 30.4);
            rotuloPrazo = dias === 0 ? 'vence hoje' : (dias <= 60 ? `em ${dias} dias` : `em ${meses} meses`);
        }
        return { ...p, dataTxt: `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${a}`, dias, classe, rotuloPrazo };
    });
    // Ordem: vencidos sem providência, próximos (por data), vencidos em andamento
    const peso = { vencido: 0, proximo: 1, ok: 1, andamento: 2 };
    itens.sort((x, y) => peso[x.classe] - peso[y.classe] || (x.classe === 'andamento' ? y.dias - x.dias : x.dias - y.dias));
    const LIMITE = 6;
    const lista = document.getElementById('listaPrazos');
    const desenhar = (todos) => {
        lista.innerHTML = (todos ? itens : itens.slice(0, LIMITE)).map(p => `
            <li class="prazo ${p.classe}">
                <div class="prazo-data"><strong>${p.dataTxt}</strong><span>${p.rotuloPrazo}</span></div>
                <div class="prazo-txt">
                    ${esc(p.titulo)}
                    ${p.andamento ? `<small class="prazo-and">${esc(p.andamento)}</small>` : ''}
                    ${p.nota ? `<small>${esc(p.nota)}</small>` : ''}
                    ${p.documento ? `<button type="button" class="doc-btn" data-titulo="${esc(p.documento.titulo)}" data-arquivo="${esc(p.documento.arquivo)}">📄 ${esc(p.documento.titulo)}</button>` : ''}
                </div>
            </li>`).join('');
        lista.querySelectorAll('.doc-btn').forEach(b => b.addEventListener('click', () => abrirDocumento(b.dataset.titulo, b.dataset.arquivo)));
    };
    desenhar(false);
    const btn = document.getElementById('verTodosPrazos');
    if (itens.length > LIMITE) {
        btn.hidden = false;
        btn.textContent = `Ver todos (${itens.length})`;
        let todos = false;
        btn.onclick = () => { todos = !todos; desenhar(todos); btn.textContent = todos ? 'Mostrar menos' : `Ver todos (${itens.length})`; };
    }
}

// ---------- mapa ----------
function adicionarCamadas() {
    fazendas.forEach(f => {
        const g = geojsons[f.id];
        if (!g || map.getSource(f.id) || ehPonto(f.id)) return;
        map.addSource(f.id, { type: 'geojson', data: g });
        map.addLayer({
            id: `${f.id}-fill`, type: 'fill', source: f.id,
            layout: { visibility: mostrarPreenchimento ? 'visible' : 'none' },
            paint: { 'fill-color': corMapa(f), 'fill-opacity': 0.18 }
        });
        map.addLayer({
            id: `${f.id}-halo`, type: 'line', source: f.id,
            paint: { 'line-color': '#000000', 'line-width': 5, 'line-opacity': 0.35 }
        });
        map.addLayer({
            id: `${f.id}-line`, type: 'line', source: f.id,
            paint: { 'line-color': corMapa(f), 'line-width': 2.5 }
        });
    });
    // Camadas extras definidas em data/fazendas.json -> "camadas"
    camadas.forEach(c => {
        const g = camadasData[c.id];
        if (!g || map.getSource(`cam-${c.id}`)) return;
        map.addSource(`cam-${c.id}`, { type: 'geojson', data: g });
        if (c.tipo === 'line' && c.destaque) {
            // Municípios em destaque: preenchimento leve, contorno com halo e nome no centro
            const antes = fazendas.map(f => `${f.id}-fill`).find(id => map.getLayer(id));
            map.addLayer({ id: `cam-${c.id}-fill`, type: 'fill', source: `cam-${c.id}`, paint: { 'fill-color': corMunicipios(c), 'fill-opacity': 0.08 } }, antes);
            map.addLayer({ id: `cam-${c.id}-halo`, type: 'line', source: `cam-${c.id}`, paint: { 'line-color': '#000000', 'line-width': 5, 'line-opacity': 0.45 } }, antes);
            map.addLayer({ id: `cam-${c.id}`, type: 'line', source: `cam-${c.id}`, paint: { 'line-color': corMunicipios(c), 'line-width': 2.4 } }, antes);
            const centros = { type: 'FeatureCollection', features: g.features.map(f => ({ type: 'Feature', properties: f.properties, geometry: turf.pointOnFeature(f).geometry })) };
            map.addSource(`cam-${c.id}-centros`, { type: 'geojson', data: centros });
            try {
                map.addLayer({ id: `cam-${c.id}-nome`, type: 'symbol', source: `cam-${c.id}-centros`, maxzoom: 13,
                    layout: { 'text-field': ['upcase', ['get', 'nome']], 'text-size': ['interpolate', ['linear'], ['zoom'], 8, 11, 12, 15], 'text-letter-spacing': 0.08,
                              'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'], 'text-max-width': 8 },
                    paint: { 'text-color': corMunicipios(c), 'text-halo-color': '#000000', 'text-halo-width': 1.6 } });
            } catch (err) { console.warn('Nomes dos municípios indisponíveis', err); }
            return;
        }
        if (c.tipo === 'line') {
            map.addLayer({ id: `cam-${c.id}`, type: 'line', source: `cam-${c.id}`, paint: { 'line-color': c.cor, 'line-width': 1.5, 'line-opacity': 0.8, 'line-dasharray': [3, 2] } });
            return;
        }
        if (c.tipo === 'fill') {
            const corFill = c.cor_por && c.cores ? ['match', ['get', c.cor_por], ...Object.entries(c.cores).flat(), '#777777'] : c.cor;
            map.addLayer({ id: `cam-${c.id}`, type: 'fill', source: `cam-${c.id}`, paint: { 'fill-color': corFill, 'fill-opacity': c.opacidade ?? (c.cor_por ? 0.85 : 0.45) } });
            map.addLayer({ id: `cam-${c.id}-line`, type: 'line', source: `cam-${c.id}`,
                paint: { 'line-color': c.linha_cor || (c.cor_por ? '#ffffff' : corFill), 'line-width': c.linha_largura ?? (c.cor_por ? 1.5 : 1), 'line-opacity': 0.9 } });
            if (c.destacar_selecao) map.addLayer({ id: `cam-${c.id}-sel`, type: 'line', source: `cam-${c.id}`, filter: ['==', ['get', 'nome'], ''],
                paint: { 'line-color': '#ffeb3b', 'line-width': 3.5 } });
        } else {
            const cor = c.cor_por && c.cores
                ? ['match', ['get', c.cor_por], ...Object.entries(c.cores).flat(), '#777777']
                : c.cor;
            map.addLayer({ id: `cam-${c.id}`, type: 'circle', source: `cam-${c.id}`,
                paint: { 'circle-radius': c.cor_por ? 7 : 8, 'circle-color': cor, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } });
        }
        if (c.rotulo !== false) try {
            map.addLayer({
                id: `cam-${c.id}-label`, type: 'symbol', source: `cam-${c.id}`, minzoom: 12.5,
                layout: { 'text-field': ['get', 'nome'], 'text-size': 12, 'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
                          ...(c.tipo === 'fill' ? {} : { 'text-offset': [0, 1.2], 'text-anchor': 'top' }) },
                paint: { 'text-color': '#ffffff', 'text-halo-color': '#000000', 'text-halo-width': 1.3 }
            });
        } catch (err) { console.warn('Rótulos indisponíveis', err); }
    });

    // Pontos de interesse (estruturas, represas, pivôs)
    const pontos = fazendas.flatMap(f => (f.pontos || []).map(p => ({
        type: 'Feature',
        properties: { nome: p.nome, descricao: p.descricao || '', fazenda: f.id, cor: f.cor,
                      doc_titulo: p.documento ? p.documento.titulo : '', doc_arquivo: p.documento ? p.documento.arquivo : '' },
        geometry: { type: 'Point', coordinates: p.coord }
    })));
    if (pontos.length && !map.getSource('pontos')) {
        map.addSource('pontos', { type: 'geojson', data: { type: 'FeatureCollection', features: pontos } });
        map.addLayer({
            id: 'pontos', type: 'circle', source: 'pontos',
            paint: { 'circle-radius': 7, 'circle-color': '#ffffff', 'circle-stroke-color': ['get', 'cor'], 'circle-stroke-width': 3 }
        });
        try {
            map.addLayer({
                id: 'pontos-rotulo', type: 'symbol', source: 'pontos', minzoom: 13,
                layout: { 'text-field': ['get', 'nome'], 'text-size': 12, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'] },
                paint: { 'text-color': '#ffffff', 'text-halo-color': '#000000', 'text-halo-width': 1.3 }
            });
        } catch (err) { console.warn('Rótulos dos pontos indisponíveis', err); }
    }

    // Rótulos com o nome das fazendas
    if (!map.getSource('rotulos')) try {
        map.addSource('rotulos', {
            type: 'geojson',
            data: {
                type: 'FeatureCollection',
                features: fazendas.filter(f => geojsons[f.id] && !ehPonto(f.id)).map(f => ({
                    type: 'Feature',
                    properties: { nome: f.nome.replace('Fazenda ', ''), ...(dadosGerais.filtro_etapa ? { [dadosGerais.filtro_etapa.campo]: f[dadosGerais.filtro_etapa.campo] } : {}) },
                    geometry: turf.pointOnFeature(geojsons[f.id]).geometry
                }))
            }
        });
        map.addLayer({
            id: 'rotulos', type: 'symbol', source: 'rotulos', minzoom: fazendas.length > 8 ? 12 : 0,
            layout: { 'text-field': ['get', 'nome'], 'text-size': 13, 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'], 'text-max-width': 10 },
            paint: { 'text-color': '#ffffff', 'text-halo-color': '#000000', 'text-halo-width': 1.5 }
        });
    } catch (err) {
        console.warn('Rótulos não disponíveis neste estilo de mapa', err);
    }
    (dadosGerais.camadas_opcionais || []).filter(o => opcionaisAtivas.has(o.id)).forEach(desenharOpcional);
    destacarSelecionada();
    aplicarFiltroMapa();
    aplicarVisibilidadeCamadas();
    Object.keys(catOcultas).forEach(aplicarCategorias);
}

function destacarSelecionada() {
    fazendas.forEach(f => {
        if (!map.getLayer(`${f.id}-line`)) return;
        const ativa = selecionada === f.id;
        const apagada = selecionada && !ativa;
        map.setPaintProperty(`${f.id}-line`, 'line-width', ativa ? 4.5 : 2.5);
        map.setPaintProperty(`${f.id}-line`, 'line-opacity', apagada ? 0.5 : 1);
        map.setPaintProperty(`${f.id}-fill`, 'fill-opacity', ativa ? 0.3 : (apagada ? 0.08 : 0.18));
    });
}

function enquadrarTodas() {
    const todas = { type: 'FeatureCollection', features: fazendas.filter(f => geojsons[f.id] && naEtapa(f)).flatMap(f => geojsons[f.id].features) };
    if (!todas.features.length) {
        const c = camadas.find(x => x.destaque) || camadas[0];
        if (c && camadasData[c.id]) todas.features = camadasData[c.id].features;
    }
    if (todas.features.length) map.fitBounds(boundsDe(todas), { padding: 50, duration: 800, maxZoom: 14 });
}

function selecionarFazenda(id, voar) {
    selecionada = id;
    renderFazendas();
    destacarSelecionada();
    if (id && voar && geojsons[id]) {
        map.fitBounds(boundsDe(geojsons[id]), { padding: 60, duration: 900, maxZoom: 15 });
    }
    if (id) {
        const card = document.querySelector(`.farm[data-id="${id}"]`);
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

function popupHtml(f) {
    const cont = contarStatus(f.adequacoes);
    const inf = f.info || {};
    return `<div class="popup">
        <h3><span class="swatch" style="background:${f.cor}"></span>${esc(f.nome)}</h3>
        ${f.situacao ? `<span class="status-badge" style="background:${f.cor}">${esc(f.situacao)}</span>` : ''}
        ${inf['Etapa'] ? `<p><strong>Etapa:</strong> ${esc(inf['Etapa'])}${f.data_visita ? ` · visita em ${esc(f.data_visita)}` : ''}</p>` : ''}
        ${f.area_ha ? `<p><strong>Área declarada:</strong> ${fmt(f.area_ha, 2)} ha</p>` : ''}
        ${f.car ? `<p><strong>CAR:</strong> <span class="mono">${esc(f.car)}</span></p>` : ''}
        ${(inf['Resultado da visita'] || inf['Andamento'] || inf['Obra']) ? `<p>${esc(inf['Resultado da visita'] || inf['Andamento'] || inf['Obra'])}</p>` : ''}
        ${galeriaHtml(f, 4)}
        ${f.adequacoes.length ? `<p><strong>Adequações:</strong> ${f.adequacoes.length}
           (${cont['Concluída']} concluídas, ${cont['Em andamento']} em andamento, ${cont['Pendente']} pendentes)</p>
        <div class="mini-progress">${barraProgresso(cont, f.adequacoes.length)}</div>` : ''}
        ${documentosDa(f).map(d => `<button type="button" class="doc-btn" onclick="abrirDocumento('${esc(d.titulo)}', '${esc(d.arquivo)}')">📄 ${esc(d.titulo)}</button>`).join('')}
        <button type="button" class="btn btn-mini ver-ficha" data-fazenda="${esc(f.id)}">Ver ficha completa no painel</button>
    </div>`;
}

map.on('click', (e) => {
    if ((dadosGerais.camadas_opcionais || []).some(o => o.prioridade && opcionaisAtivas.has(o.id)) && popupOpcional(e, true)) return;
    if (map.getLayer('pontos')) {
        const pt = map.queryRenderedFeatures(e.point, { layers: ['pontos'] });
        if (pt.length) {
            const p = pt[0].properties;
            new mapboxgl.Popup({ maxWidth: '280px' }).setLngLat(pt[0].geometry.coordinates)
                .setHTML(`<div class="popup"><h3>${esc(p.nome)}</h3><p>${esc(p.descricao)}</p>${docBotao(p.doc_titulo, p.doc_arquivo)}</div>`).addTo(map);
            selecionarFazenda(p.fazenda, false);
            return;
        }
    }
    const camIds = (window.camadasExtras || []).filter(id => map.getLayer(id));
    if (camIds.length) {
        const hit = map.queryRenderedFeatures(e.point, { layers: camIds });
        if (hit.length) {
            const p = hit[0].properties;
            const c = (window.camadasCfg || []).find(x => `cam-${x.id}` === hit[0].layer.id) || {};
            const badge = c.cor_por && p[c.cor_por]
                ? `<span class="status-badge" style="background:${(c.cores || {})[p[c.cor_por]] || '#777'}">${esc(p[c.cor_por])}</span>` : '';
            // Resumo em texto (portaria, validade e finalidade) + demais campos em lista
            const resumo = p.Portaria
                ? `<p class="popup-resumo"><strong>Portaria ${esc(p.Portaria)}</strong><br>
                   ${p.Validade ? `Validade: <strong>${esc(p.Validade)}</strong><br>` : ''}
                   ${p.Finalidade ? `Finalidade: ${esc(p.Finalidade)}` : ''}</p>` : '';
            const jaNoResumo = p.Portaria ? ['Portaria', 'Validade', 'Finalidade'] : [];
            const tabela = camposDe(c, p).filter(k => !jaNoResumo.includes(k))
                .map(k => `<dt>${esc(k)}</dt><dd>${esc(p[k])}</dd>`).join('');
            new mapboxgl.Popup({ maxWidth: '320px' }).setLngLat(hit[0].geometry.type === 'Point' ? hit[0].geometry.coordinates : e.lngLat)
                .setHTML(`<div class="popup"><h3>${esc(p.nome)}</h3>${badge}
                    ${resumo}
                    ${p.descricao ? `<p>${esc(p.descricao)}</p>` : ''}
                    ${tabela ? `<dl class="popup-dl">${tabela}</dl>` : ''}
                    ${(() => { const fz = p.doc_arquivo && fazendas.find(x => (x.documentos || []).some(d => d.arquivo === p.doc_arquivo)); return fz ? galeriaHtml(fz, 4) : ''; })()}
                    ${docBotao(p.doc_titulo, p.doc_arquivo)}${docBotao(p.hist_titulo, p.hist_arquivo)}</div>`).addTo(map);
            return;
        }
    }
    const camadas = fazendas.map(f => `${f.id}-fill`).filter(id => map.getLayer(id));
    const hits = camadas.length ? map.queryRenderedFeatures(e.point, { layers: camadas }) : [];
    // Com o preenchimento oculto, ainda permite clicar dentro do perímetro
    let id = hits.length ? hits[0].properties.id : null;
    if (!id) {
        const pt = turf.point([e.lngLat.lng, e.lngLat.lat]);
        const f = fazendas.find(f => geojsons[f.id] && !ehPonto(f.id) && naEtapa(f) && turf.booleanPointInPolygon(pt, geojsons[f.id].features[0]));
        id = f ? f.id : null;
    }
    if (!id || !ligada('propriedades')) { popupOpcional(e); return; }
    const f = fazendas.find(x => x.id === id);
    new mapboxgl.Popup({ maxWidth: '300px' }).setLngLat(e.lngLat).setHTML(popupHtml(f)).addTo(map);
    selecionarFazenda(id, false);
});

map.on('mousemove', (e) => {
    const camadas = fazendas.map(f => `${f.id}-fill`).filter(id => map.getLayer(id));
    if (map.getLayer('pontos')) camadas.push('pontos');
    window.camadasExtras?.forEach(id => { if (map.getLayer(id)) camadas.push(id); });
    const over = camadas.length && map.queryRenderedFeatures(e.point, { layers: camadas }).length > 0;
    map.getCanvas().style.cursor = over ? 'pointer' : '';
});

// Recoloca as camadas sempre que o estilo do mapa muda
map.on('style.load', () => { if (fazendas.length) adicionarCamadas(); });

// ---------- controles ----------
document.querySelectorAll('button[data-style]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('[data-style]').forEach(b => b.classList.toggle('active', b === btn));
        map.setStyle(ESTILOS[btn.dataset.style] || btn.dataset.style);
    });
});
document.getElementById('toggleFill')?.addEventListener('change', (e) => {
    mostrarPreenchimento = e.target.checked;
    fazendas.forEach(f => {
        if (map.getLayer(`${f.id}-fill`)) map.setLayoutProperty(`${f.id}-fill`, 'visibility', mostrarPreenchimento && naEtapa(f) ? 'visible' : 'none');
    });
});
document.getElementById('centerMap').addEventListener('click', () => { selecionarFazenda(null, false); enquadrarTodas(); });

const toggle = document.getElementById('panelToggle');
toggle.addEventListener('click', () => {
    const fechado = document.body.classList.toggle('panel-closed');
    toggle.setAttribute('aria-expanded', String(!fechado));
    setTimeout(() => map.resize(), 250);
});

// ---------- carregamento ----------
async function iniciar() {
    const resp = await fetch('data/fazendas.json', { cache: 'no-cache' });
    const dados = await resp.json();
    const cliente = dados.cliente || {};
    document.getElementById('clienteNome').textContent = cliente.nome || 'Mapa interativo';
    document.getElementById('clienteSub').textContent = cliente.subtitulo || '';
    if (cliente.selo) {
        const selo = document.createElement('span');
        selo.className = 'demo-badge';
        selo.textContent = cliente.selo;
        document.getElementById('clienteSub').after(selo);
    }
    if (cliente.nome) document.title = `${cliente.nome} – Mapa Interativo`;
    if (cliente.centro) map.jumpTo({ center: cliente.centro, zoom: cliente.zoom || 12 });
    fazendas = dados.fazendas.map((f, i) => ({ ...f, cor: f.cor || PALETA[i % PALETA.length] }));
    if (!fazendas.length) {
        if (!dados.busca_camada) document.getElementById('farmList').innerHTML = '<p class="hint">Mapa em preparação. Os dados das propriedades serão incluídos em breve.</p>';
    }
    if (dados.atualizado_em) {
        const [a, m, d] = dados.atualizado_em.split('-');
        document.getElementById('updatedAt').textContent = `${d}/${m}/${a}`;
    }
    await Promise.all(fazendas.map(async f => {
        if (!f.arquivo) return;
        try {
            const r = await fetch(f.arquivo, { cache: 'no-cache' });
            geojsons[f.id] = await r.json();
        } catch (err) {
            console.error(`Não foi possível carregar ${f.arquivo}`, err);
        }
    }));
    dadosGerais = dados;
    renderPrograma(dados.programa);
    if (dados.lista_titulo) document.getElementById('listaTitulo').textContent = dados.lista_titulo;
    camadas = dados.camadas || [];
    window.camadasExtras = camadas.map(c => `cam-${c.id}`);
    window.camadasCfg = camadas;
    await Promise.all(camadas.map(async c => {
        try { camadasData[c.id] = await (await fetch(c.arquivo, { cache: 'no-cache' })).json(); }
        catch (err) { console.error(`Não foi possível carregar ${c.arquivo}`, err); }
    }));
    renderResumo();
    renderFiltroEtapa();
    renderModosCor();
    renderIndicadoresExternos();
    renderOpcionais();
    if (dados.cores_por_municipio) {
        modoCor = 'municipio';
        const seg = document.getElementById('modoCor');
        if (seg) {
            seg.hidden = false;
            seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
                modoCor = b.dataset.modo;
                seg.querySelectorAll('button').forEach(o => o.classList.toggle('active', o === b));
                aplicarCores();
                renderLegenda();
            }));
        }
    }
    renderFazendas();
    renderLegenda();
    renderBuscaCamada();
    renderPrazos(dados.prazos);
    prepararCartoes();
    const pronto = () => { adicionarCamadas(); enquadrarTodas(); };
    if (map.isStyleLoaded()) pronto(); else map.once('load', pronto);
}
iniciar();

document.getElementById('farmSearch')?.addEventListener('input', (e) => {
    filtroFazendas = semAcento(e.target.value.trim());
    renderFazendas();
});

// ---------- cartões do painel recolhíveis ----------
function prepararCartoes() {
    let salvos = {};
    try { salvos = JSON.parse(localStorage.getItem('cartoesFechados') || '{}'); } catch (e) {}
    document.querySelectorAll('.sidebar .card').forEach((card, i) => {
        const h = card.querySelector(':scope > h2');
        if (!h || h.dataset.recolhe) return;
        const chave = card.id || h.textContent.trim();
        h.dataset.recolhe = '1';
        h.classList.add('card-titulo');
        h.setAttribute('role', 'button'); h.tabIndex = 0;
        const alternar = () => {
            const fechado = card.classList.toggle('fechado');
            h.setAttribute('aria-expanded', !fechado);
            salvos[chave] = fechado;
            try { localStorage.setItem('cartoesFechados', JSON.stringify(salvos)); } catch (e) {}
        };
        h.addEventListener('click', alternar);
        h.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); alternar(); } });
        if (salvos[chave]) card.classList.add('fechado');
        h.setAttribute('aria-expanded', !card.classList.contains('fechado'));
    });
}
setTimeout(prepararCartoes, 0);
window.addEventListener('load', () => setTimeout(prepararCartoes, 500));
