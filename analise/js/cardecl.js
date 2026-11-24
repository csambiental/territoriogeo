// ---------- CAR declarado (base temática do SICAR) × verificado por satélite e bases públicas ----------
// Dados: data/car_declarado/<cód. IBGE>.json  {temas: [...], imoveis: {"PR-...": [[i_tema, área_ha, nº_feições], ...]}}
async function cdDeclarado(nome) {
    const m = /^PR-(\d{7})-/.exec(nome || ''); if (!m) return null;
    const d = await rxJSON(`data/car_declarado/${m[1]}.json`).catch(() => null);
    if (!d || !d.imoveis) return null;
    const l = d.imoveis[nome] || [];   // imóvel ausente da base temática = nenhum tema georreferenciado declarado
    const T = {}; l.forEach(([i, a, n]) => { T[d.temas[i]] = { ha: a, n }; });
    const s = re => Object.entries(T).filter(([k]) => re.test(k)).reduce((a, [, v]) => ({ ha: a.ha + v.ha, n: a.n + v.n }), { ha: 0, n: 0 });
    const g = k => T[k] || { ha: 0, n: 0 };
    const rlTipo = ['Reserva Legal Averbada', 'Reserva Legal Aprovada e nao Averbada', 'Reserva Legal Proposta'].filter(k => T[k]).map(k => k.replace('Reserva Legal ', '').replace('nao', 'não').toLowerCase());
    return {
        T, vazio: !l.length,
        app: T['APP Total'] ? T['APP Total'].ha : s(/^Area de Preservacao Permanente (de|em) /).ha,
        appVeg: g('Area de Preservacao Permanente em area de Vegetacao Nativa').ha,
        appRecompor: s(/a Recompor/).ha,
        appSemDecl: g('Area de Preservacao Permanente em area antropizada nao declarada como area consolidada').ha,
        nasc: g("Area de Preservacao Permanente de Nascentes ou Olhos D'agua Perenes").n,
        rios: s(/^Curso d'agua natural/).n,
        reserv: g("Area de Preservacao Permanente de Reservatorio artificial decorrente de barramento de curs").n
            || g('Area de Preservacao Permanente de Reservatorio artificial decorrente de barramento de cursos dagua').n
            || g("Reservatorio artificial decorrente de barramento ou represamento de cursos d'agua naturais").n,
        rl: s(/^Reserva Legal/).ha, rlTipo,
        veg: g('Remanescente de Vegetacao Nativa').ha,
        cons: g('Area Consolidada').ha,
        restrito: s(/^Area de Uso Restrito/).ha,
        pousio: g('Area de Pousio').ha,
        servidao: g('Area de Servidao Administrativa Total').ha,
    };
}
// comparação: linhas {rot, decl, ver, st ('ok'|'at'|'no'|'na'), txt}
function cdComparar(u) {
    const D = u.decl; if (!D) return [];
    const area = u.area, P = u.previa || null, L = [], f = (v, c = 1) => rxF(v, c) + ' ha';
    const nat = (u.uso || []).find(([k]) => /Vegetação (nativa|arbórea)/.test(k));
    const vegMed = P && P.uso && P.uso.veg != null ? P.uso.veg : nat ? nat[1] / 100 * area : null; // vegetação nativa medida (P.veg = lavouras!)
    // vegetação nativa
    if (vegMed != null) { const dif = D.veg - vegMed, lim = Math.max(Math.min(2, 0.05 * area), 0.1 * Math.max(D.veg, vegMed));
        L.push({ rot: 'Remanescente de vegetação nativa', decl: f(D.veg), ver: f(vegMed) + ' (satélite)', st: Math.abs(dif) <= lim ? 'ok' : dif > 0 ? 'no' : 'at',
            txt: Math.abs(dif) <= lim ? 'Compatível' : dif > 0 ? `Declarado ${f(dif)} acima do medido – vegetação declarada onde o satélite não encontra` : `Satélite mede ${f(-dif)} a mais – vegetação não declarada (pode reforçar a RL)` }); }
    // reserva legal
    { const min = 0.2 * area, pct = D.rl / area * 100, def = min - D.rl, mf = rxNum(u.p && u.p['Módulos fiscais']);
      L.push({ rot: `Reserva Legal${D.rlTipo.length ? ' (' + D.rlTipo.join(', ') + ')' : ''}`, decl: `${f(D.rl)} (${rxF(pct, 1)}%)`, ver: `mínimo 20% = ${f(min)}`,
          st: def <= 0.05 * min ? 'ok' : mf && mf <= 4 ? 'at' : 'no', txt: def <= 0.05 * min ? 'Atende o mínimo legal' : `Déficit declarado de ${f(def)}${mf && mf <= 4 ? ' – imóvel até 4 módulos: pode valer a vegetação de 22/07/2008 (art. 67)' : ' – recompor, regenerar ou compensar (PRA)'}` });
      if (vegMed != null && D.rl > vegMed * 1.05 + 1) L.push({ rot: 'Reserva Legal × vegetação existente', decl: f(D.rl), ver: f(vegMed) + ' de vegetação', st: 'at', txt: `RL declarada maior que a vegetação medida em ${f(D.rl - vegMed)} – parte da RL pode estar sem cobertura (recomposição)` }); }
    // APP
    if (P) { const dif = D.app - P.app, lim = Math.max(Math.min(2, 0.05 * area), 0.2 * Math.max(D.app, P.app));
        L.push({ rot: 'APP total', decl: f(D.app), ver: f(P.app) + ' (faixas legais estimadas)', st: Math.abs(dif) <= lim ? 'ok' : dif < 0 ? 'no' : 'at',
            txt: Math.abs(dif) <= lim ? 'Compatível' : dif < 0 ? `APP declarada ${f(-dif)} menor que a estimada – conferir rios/nascentes não declarados` : `APP declarada ${f(dif)} maior que a estimada – conferir traçado da hidrografia` }); }
    if (D.appRecompor > 0.01) L.push({ rot: 'APP a recompor (declarada)', decl: f(D.appRecompor, 2), ver: '–', st: 'at', txt: 'Passivo de APP declarado: recomposição via PRA' });
    if (D.appSemDecl > 0.05) L.push({ rot: 'APP antropizada não declarada como consolidada', decl: f(D.appSemDecl, 2), ver: '–', st: 'at', txt: 'Uso em APP sem enquadramento como área consolidada – recompor ou retificar o CAR' });
    // nascentes
    const X = u.cdX;
    if (X && X.nascSem) { const nm = X.nascFbds.length, sem = X.nascSem.length;
        L.push({ rot: 'Nascentes', decl: `${D.nasc} nascente(s) declarada(s)`, ver: `${nm} nascente(s) de referência no imóvel (FBDS)`, st: sem ? 'no' : 'ok',
            txt: sem ? `${sem} nascente(s) de referência sem nascente declarada a até 100 m – vistoria e retificação do CAR` : 'Compatível' }); }
    else if (P && P.A && P.A.det) { const nm = P.A.det.nascentes || 0;
        L.push({ rot: 'Nascentes', decl: `${D.nasc} APP(s) de nascente`, ver: `${nm} nascente(s) mapeada(s) (FBDS)`, st: nm > D.nasc ? 'no' : 'ok',
            txt: nm > D.nasc ? `${nm - D.nasc} nascente(s) mapeada(s) sem APP declarada – vistoria e retificação do CAR` : 'Compatível' }); }
    // reservatórios
    { const art = (u.r.massas || []).filter(x => /artificial/.test(x.f.properties.grupo)).length;
      if (art || D.reserv) L.push({ rot: 'Açudes e represas', decl: `${D.reserv} APP(s) de reservatório`, ver: `${art} espelho(s) artificial(is) (ANA)`, st: art > D.reserv ? 'at' : 'ok',
          txt: art > D.reserv ? `${art - D.reserv} açude(s) sem APP de reservatório declarada` : 'Compatível' }); }
    // área consolidada
    if (vegMed != null) { const antr = Math.max(0, area - vegMed), exc = D.cons - antr;
        L.push({ rot: 'Área consolidada (uso antes de 22/07/2008)', decl: f(D.cons), ver: f(antr) + ' de área aberta hoje', st: exc > Math.max(Math.min(2, 0.1 * area), 0.05 * area) ? 'at' : 'ok',
            txt: exc > Math.max(Math.min(2, 0.1 * area), 0.05 * area) ? `Consolidada declarada ${f(exc)} acima da área aberta – possível sobreposição com vegetação` : 'Compatível' }); }
    if (D.restrito > 0.01) L.push({ rot: 'Uso restrito (25–45° / pantanal)', decl: f(D.restrito, 2), ver: '–', st: 'na', txt: 'Manejo sustentável; vedada conversão de vegetação' });
    if (D.pousio > 0.01) L.push({ rot: 'Área de pousio', decl: f(D.pousio, 2), ver: '–', st: 'na', txt: 'Conferir se o pousio não ultrapassa 5 anos' });
    if (D.servidao > 0.01) L.push({ rot: 'Servidão administrativa', decl: f(D.servidao, 2), ver: '–', st: 'na', txt: 'Excluída da área líquida do imóvel' });
    return L;
}
function cdQuadroHtml(u, cls = 'dk') {
    const L = cdComparar(u); if (!L.length) return '';
    const cor = { ok: 'bom', at: 'at', no: 'def', na: '' };
    return `<table class="${cls}"><tr><th>Tema</th><th>Declarado no CAR</th><th>Verificado</th><th>Análise automática</th></tr>${L.map(l => `<tr><td>${esc(l.rot)}</td><td>${esc(l.decl)}</td><td>${esc(l.ver)}</td><td class="${cor[l.st]}">${esc(l.txt)}</td></tr>`).join('')}</table>
      <p class="hint">Declarado: base de downloads do SICAR (temas do CAR, Paraná, ${esc((u.declInfo || {}).baixado_em || '2026')}). Verificado: cobertura por satélite, hidrografia FBDS (escala 1:25.000) e espelhos d'água da ANA.</p>`;
}
function cdChecklist(u) {
    const L = cdComparar(u).filter(l => l.st !== 'na'); if (!L.length) return null;
    return { nome: 'CAR declarado × verificado', itens: L.map(l => ({ ind: l.rot, st: l.st, det: `Declarado: ${l.decl} · Verificado: ${l.ver}${l.st !== 'ok' ? ' – ' + l.txt : ''}` })) };
}
function cdPendencias(u) {
    return cdComparar(u).filter(l => l.st === 'no' || l.st === 'at').map(l => ({ prior: l.st === 'no' ? 1 : 2, tema: 'CAR declarado × verificado', achado: `${l.rot}: declarado ${l.decl}; verificado ${l.ver}`, adequacao: l.txt }));
}

// ======================= Análise da declaração do CAR – mapas por tema (modelo "Diagnóstico Ambiental Integrado") =======================
const CD_GEO_URL = 'https://raw.githubusercontent.com/csambiental/territoriogeo/car-geo/';
const CD_G = [['nasc', /Nascentes/], ['recompor', /a Recompor/], ['antrop', /antropizada/], ['app', /^APP Total/], ['rl', /^Reserva Legal/], ['veg', /^Remanescente/],
    ['cons', /^Area Consolidada/], ['serv', /Servidao Administrativa Total/], ['restrito', /Uso Restrito/], ['pousio', /Pousio/], ['reserv', /^Reservatorio artificial/],
    ['lago', /^Lago/], ['rio', /^Curso d'agua/]];
const cdGrupo = t => (CD_G.find(([, re]) => re.test(t)) || ['outro'])[0];
const cdNome = t => String(t).replace(/\bArea\b/g, 'Área').replace(/Preservacao/g, 'Preservação').replace(/Vegetacao/g, 'Vegetação').replace(/Servidao/g, 'Servidão')
    .replace(/Reservatorio/g, 'Reservatório').replace(/d'agua|D'agua|dagua/g, "d'água").replace(/\bate\b/g, 'até').replace(/\bnao\b/g, 'não').replace(/Publica/g, 'Pública')
    .replace(/regioes/g, 'regiões').replace(/Geracao/g, 'Geração').replace(/declaracao/g, 'declaração').replace(/Lei n /g, 'Lei nº ').replace(/Infraestrutura Pública/g, 'Infraestrutura pública');
function cdDecAnel(r) { const o = []; let x = 0, y = 0; for (let i = 0; i < r.length; i += 2) { x += r[i]; y += r[i + 1]; o.push([x / 1e5, y / 1e5]); } return o; }
function cdDecGeom(k, c) {
    if (k === 0) return { type: 'Point', coordinates: [c[0] / 1e5, c[1] / 1e5] };
    if (k === 1) return { type: 'MultiPolygon', coordinates: c.map(p => p.map(cdDecAnel)) };
    return { type: 'MultiLineString', coordinates: c.map(l => cdDecAnel(l[0])) };
}
async function cdGeo(nome) {
    const m = /^PR-(\d{7})-([0-9A-F])/i.exec(nome || ''); if (!m) return null;
    const d = await rxJSON(`${CD_GEO_URL}${m[1]}/${m[2].toUpperCase()}.json`).catch(() => null);
    const l = d && d.i && d.i[nome]; if (!l) return null;
    return turf.featureCollection(l.map(([i, k, c]) => ({ type: 'Feature', geometry: cdDecGeom(k, c), properties: { tema: d.temas[i], g: cdGrupo(d.temas[i]) } })));
}
const cdDoGrupo = (fc, ...gs) => turf.featureCollection(((fc && fc.features) || []).filter(f => gs.includes(f.properties.g)));
const cdHaGeo = fc => fc.features.reduce((a, f) => { try { return a + turf.area(f) / 1e4; } catch (e) { return a; } }, 0);
const cdKm = fc => fc.features.reduce((a, f) => { try { return a + (/Line/.test(f.geometry.type) ? turf.length(f) : 0); } catch (e) { return a; } }, 0);
// cruzamentos geométricos: nascentes FBDS × nascentes declaradas e drenagem FBDS × cursos d'água declarados
async function cdPrepararGeo(u) {
    if (u.declGeo === undefined) u.declGeo = await cdGeo(u.nome).catch(() => null);
    const G = u.declGeo, alvo = u.alvo, X = {};
    const dentro = f => { try { return turf.booleanPointInPolygon(f.geometry.type === 'Point' ? f : turf.pointOnFeature(f), alvo); } catch (e) { return false; } };
    if (u.C && u.C.nascentes) {
        const fb = ((await rxJSON(u.C.nascentes).catch(() => null)) || { features: [] }).features.filter(f => f.geometry && f.geometry.type === 'Point' && dentro(f));
        const dec = G ? cdDoGrupo(G, 'nasc').features : [];
        X.nascFbds = fb; X.nascDecl = dec;
        X.nascSem = G ? fb.filter(f => !dec.some(d => turf.distance(f, d) <= 0.1)) : null;   // sem nascente declarada a até 100 m
    }
    if (u.C && u.C.rios) {
        const rios = ((await rxJSON(u.C.rios).catch(() => null)) || { features: [] }).features.filter(f => f.geometry && /Line/.test(f.geometry.type));
        let km = 0; const sel = [];
        rios.forEach(f => { try { const segs = turf.lineSegment(f).features; let n = 0;
            segs.forEach(s => { if (turf.booleanPointInPolygon(turf.midpoint(s.geometry.coordinates[0], s.geometry.coordinates[1]), alvo)) { km += turf.length(s); n++; } });
            if (n) sel.push(f); } catch (e) { } });
        X.riosFbdsKm = km; X.riosFbds = sel;
    }
    if (G) { const r = cdDoGrupo(G, 'rio'); X.riosDeclKm = cdKm(r); X.riosDeclPol = r.features.some(f => /Polygon/.test(f.geometry.type)); X.reservHa = cdHaGeo(cdDoGrupo(G, 'reserv')); X.lagoHa = cdHaGeo(cdDoGrupo(G, 'lago')); }
    u.cdX = X; return X;
}
// estilos dos temas no mapa
const CD_EST = {
    cons: { fill: '#ffd54f', op: .55, line: '#ffb300' }, veg: { fill: '#1b5e20', op: .65, line: '#a5d6a7' }, rl: { fill: '#00e676', op: .35, line: '#00e676', dash: true },
    app: { fill: '#b2ff59', op: .5, line: '#76ff03' }, recompor: { fill: '#ff6d00', op: .85, line: '#ffffff' }, antrop: { fill: '#d50000', op: .85, line: '#ffffff' },
    rio: { fill: '#00b0ff', op: .9, line: '#00b0ff', w: 3 }, lago: { fill: '#0277bd', op: .85, line: '#4fc3f7' }, reserv: { fill: '#0d47a1', op: .85, line: '#4fc3f7' },
    serv: { fill: '#9e9e9e', op: .6, line: '#e0e0e0' }, restrito: { fill: '#8d6e63', op: .6, line: '#d7ccc8' }, pousio: { fill: '#ce93d8', op: .6, line: '#f3e5f5' },
    nasc: { circle: '#00e5ff' },
};
const CD_LEG = { cons: 'área consolidada', veg: 'remanescente de vegetação nativa', rl: 'reserva legal', app: 'APP', recompor: 'APP a recompor', antrop: 'APP antropizada não declarada como consolidada',
    rio: "curso d'água declarado", lago: 'lago/lagoa natural', reserv: 'reservatório artificial', serv: 'servidão administrativa', restrito: 'uso restrito', pousio: 'pousio', nasc: 'nascente declarada' };
function cdLegenda(gs, extra = '') {
    return `<div class="leg"><span style="border:3px solid #ff1744"></span>perímetro do imóvel ${gs.map(g => { const e = CD_EST[g];
        return e.circle ? `<span style="background:${e.circle};border-radius:50%"></span>${CD_LEG[g]}` : `<span style="background:${e.fill};opacity:${Math.max(.6, e.op)}${e.dash ? ';border:1px dashed #00a152' : ''}"></span>${CD_LEG[g]}`; }).join(' ')}${extra}</div>`;
}
async function cdFoto(u, gs, extra) {
    const estado = rxEsconderCamadas(), ids = [], src = [];
    const addSrc = (id, data) => { map.addSource(id, { type: 'geojson', data }); src.push(id); };
    const addLay = (o) => { map.addLayer(o); ids.push(o.id); };
    const pol = ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false], lin = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];
    try {
        for (const g of gs) {
            const fc = cdDoGrupo(u.declGeo, g); if (!fc.features.length) continue;
            const e = CD_EST[g], id = 'cd-' + g; addSrc(id, fc);
            if (e.circle) { addLay({ id, type: 'circle', source: id, paint: { 'circle-radius': 7, 'circle-color': e.circle, 'circle-stroke-color': '#003b46', 'circle-stroke-width': 2 } }); continue; }
            addLay({ id: id + '-f', type: 'fill', source: id, filter: pol, paint: { 'fill-color': e.fill, 'fill-opacity': e.op } });
            addLay({ id: id + '-l', type: 'line', source: id, filter: pol, paint: Object.assign({ 'line-color': e.line, 'line-width': 1.6 }, e.dash ? { 'line-dasharray': [2, 1.5], 'line-width': 2.4 } : {}) });
            addLay({ id: id + '-r', type: 'line', source: id, filter: lin, paint: { 'line-color': e.line, 'line-width': e.w || 3 } });
        }
        if (extra) extra.forEach(x => { addSrc(x.id, x.data); addLay(Object.assign({ source: x.id }, x.layer, { id: x.id })); });
        map.fitBounds(boundsDe(u.alvo), { padding: 70, maxZoom: 16, duration: 0 });
        return await rxCapturar(u.alvo);
    } finally {
        ids.reverse().forEach(id => map.getLayer(id) && map.removeLayer(id));
        rxRestaurar(estado); src.forEach(id => map.getSource(id) && map.removeSource(id));
    }
}
// as frentes de análise (uma página-mapa por tema)
function cdFrentes(u) {
    const D = u.decl, X = u.cdX || {}, area = u.area, f = (v, c = 2) => rxF(v, c) + ' ha', pct = v => rxF(v / area * 100, 2) + '%', T = D.T;
    const rows = cdComparar(u), linha = re => rows.filter(r => re.test(r.rot));
    const nRios = Object.entries(T).filter(([k]) => /^Curso d'agua/.test(k)), nLago = (T['Lago ou lagoa natural'] || {}).n || 0;
    const nRes = (T["Reservatorio artificial decorrente de barramento ou represamento de cursos d'agua naturais"] || {}).n || 0;
    const appSub = Object.entries(T).filter(([k]) => /^Area de Preservacao Permanente (de|em)|^APP segundo/.test(k) && !/a Recompor/.test(k)).sort((a, b) => b[1].ha - a[1].ha);
    const F = [];
    // cursos d'água
    { const ap = [];
      if (X.riosFbdsKm != null && X.riosDeclKm != null && !X.riosDeclPol) { const dif = X.riosFbdsKm - X.riosDeclKm;
          ap.push(dif > Math.max(0.3, 0.3 * X.riosDeclKm) ? { st: 'at', rot: "Cursos d'água", txt: `A hidrografia de referência (FBDS) mostra ${rxF(X.riosFbdsKm, 1)} km de drenagem dentro do imóvel, contra ${rxF(X.riosDeclKm, 1)} km declarados – conferir em campo cursos d'água não declarados (cada um gera APP)` }
            : { st: 'ok', rot: "Cursos d'água", txt: `Extensão declarada (${rxF(X.riosDeclKm, 1)} km) compatível com a hidrografia de referência (${rxF(X.riosFbdsKm, 1)} km)` }); }
      F.push({ id: 'rio', titulo: "Cursos d'água", gs: ['rio', 'lago'], fbdsRios: true,
        texto: `Foram declarados no CAR ${nRios.reduce((a, [, v]) => a + v.n, 0)} trecho(s) de curso d'água natural${nRios.length ? ' (' + nRios.map(([k, v]) => `${v.n} ${cdNome(k).replace("Curso d'água natural ", '').replace(/^de /, '')}`).join('; ') + ')' : ''}${X.riosDeclKm ? `, somando cerca de ${rxF(X.riosDeclKm, 1)} km` : ''}${nLago ? `, e ${nLago} lago(s) ou lagoa(s) natural(is)${X.lagoHa ? ` (${f(X.lagoHa)})` : ''}` : ''}. Os cursos d'água e suas faixas marginais são Áreas de Preservação Permanente (Lei nº 12.651/2012, art. 4º), essenciais para a qualidade da água e a prevenção de erosão. No mapa, a drenagem da base de referência (FBDS, escala 1:25.000) aparece tracejada em branco para comparação.`,
        ap, leg: ' <span style="border-top:2px dashed #fff;background:#555;height:4px"></span>drenagem de referência (FBDS)' }); }
    // reservatórios
    F.push({ id: 'reserv', titulo: "Reservatórios artificiais (açudes e represas)", gs: ['reserv'], ana: true,
        texto: nRes ? `Foram declarados ${nRes} reservatório(s) artificial(is) formados por barramento ou represamento de curso d'água natural${X.reservHa ? `, com cerca de ${f(X.reservHa)} de espelho d'água no desenho do CAR` : ''}. O entorno desses reservatórios é Área de Preservação Permanente na faixa definida na licença ambiental (Lei nº 12.651/2012, art. 4º, III e art. 5º); reservatórios com menos de 1 ha estão dispensados da faixa (§ 4º). No mapa, os espelhos d'água da ANA aparecem com contorno amarelo.`
            : `Nenhum reservatório artificial foi declarado no CAR. No mapa, os espelhos d'água artificiais mapeados pela ANA aparecem com contorno amarelo, quando existem.`,
        ap: linha(/^Açudes/), leg: ' <span style="border:2px solid #ffea00"></span>espelho d\'água (ANA)' });
    // nascentes
    { const ap = [];
      if (X.nascSem) ap.push(X.nascSem.length ? { st: 'no', rot: 'Nascentes', txt: `${X.nascSem.length} nascente(s) da base de referência sem nascente declarada a até 100 m (em vermelho no mapa) – vistoria para confirmar e retificar o CAR, com APP de 50 m de raio` }
          : { st: 'ok', rot: 'Nascentes', txt: 'Todas as nascentes da base de referência dentro do imóvel têm nascente declarada próxima' });
      else ap.push(...linha(/^Nascentes/));
      F.push({ id: 'nasc', titulo: "Nascentes e olhos d'água", gs: ['app', 'nasc'], nascFbds: true,
        texto: `O CAR traz ${D.nasc} nascente(s) ou olho(s) d'água perene(s) declarados, com ${f(((T["Area de Preservacao Permanente de Nascentes ou Olhos D'agua Perenes"] || {}).ha) || 0)} de APP no raio de 50 m (Lei nº 12.651/2012, art. 4º, IV). ${X.nascFbds ? `A base de referência (FBDS, 1:25.000) mapeia ${X.nascFbds.length} nascente(s) dentro do perímetro.` : ''} Nascentes não declaradas são uma das causas mais comuns de notificação na análise do CAR.`,
        ap, leg: ` <span style="background:#ff1744;border-radius:50%"></span>nascente de referência sem declaração <span style="background:#fff;border:2px solid #00e5ff;border-radius:50%"></span>nascente de referência com declaração próxima` }); }
    // APP
    F.push({ id: 'app', titulo: 'Área de Preservação Permanente (APP)', gs: ['app', 'recompor', 'antrop'],
        texto: `A APP declarada soma ${f(D.app)} (${pct(D.app)} do imóvel)${appSub.length ? `: ${appSub.slice(0, 6).map(([k, v]) => `${cdNome(k).replace('Área de Preservação Permanente ', '').replace(/^de /, '').replace(/^em /, 'em ')} ${f(v.ha)}`).join('; ')}` : ''}. ${D.appRecompor > 0.01 ? `Do total, ${f(D.appRecompor)} foram declarados como APP a recompor (laranja no mapa).` : 'Não há APP declarada como a recompor.'} A APP protege recursos hídricos, solo e biodiversidade (Lei nº 12.651/2012, art. 4º); em área rural consolidada vale a recomposição escalonada do art. 61-A.`,
        ap: linha(/^APP/) });
    // consolidada
    F.push({ id: 'cons', titulo: 'Área consolidada', gs: ['cons'],
        texto: `As áreas consolidadas declaradas somam ${f(D.cons)} (${pct(D.cons)} do imóvel). São áreas com ocupação agropecuária ou benfeitorias anteriores a 22/07/2008 (Lei nº 12.651/2012, art. 3º, IV), que podem continuar em uso, inclusive em parte da APP, segundo as regras dos arts. 61-A a 65.`,
        ap: linha(/^Área consolidada/) });
    // vegetação
    F.push({ id: 'veg', titulo: 'Remanescente de vegetação nativa', gs: ['veg'],
        texto: `O remanescente de vegetação nativa declarado ocupa ${f(D.veg)} (${pct(D.veg)} do imóvel), no bioma Mata Atlântica. Essas áreas contribuem para a biodiversidade e podem compor a Reserva Legal (Lei nº 12.651/2012, art. 12 e art. 15), desde que bem conservadas. A comparação usa a cobertura medida por satélite dentro do perímetro.`,
        ap: linha(/^Remanescente/) });
    // reserva legal
    F.push({ id: 'rl', titulo: 'Reserva Legal', gs: ['veg', 'rl'],
        texto: `A Reserva Legal declarada${D.rlTipo.length ? ` (${D.rlTipo.join(', ')})` : ''} ocupa ${f(D.rl)}, ou ${pct(D.rl)} da área total (${f(area)}). No bioma Mata Atlântica o mínimo é de 20% (Lei nº 12.651/2012, art. 12), ou seja, ${f(0.2 * area)}. No mapa, a Reserva Legal aparece com contorno tracejado sobre a vegetação nativa declarada.`,
        ap: linha(/^Reserva Legal/) });
    // uso geral
    { const outros = [['restrito', D.restrito], ['pousio', D.pousio], ['serv', D.servidao]].filter(([, v]) => v > 0.01);
      F.push({ id: 'uso', titulo: 'Uso e ocupação do solo declarados no CAR', gs: ['cons', 'veg', 'rl', 'app', 'recompor', 'antrop', 'rio', 'lago', 'reserv', 'serv', 'restrito', 'pousio', 'nasc'],
        texto: `Mapa com todas as feições declaradas: APP (${f(D.app)}), Reserva Legal (${f(D.rl)}), áreas consolidadas (${f(D.cons)}), remanescente de vegetação nativa (${f(D.veg)})${outros.map(([g, v]) => `, ${CD_LEG[g]} (${f(v)})`).join('')} e ${D.nasc} nascente(s). O mapeamento é o declarado pelo responsável pelo cadastro e deve ser confirmado em campo.`,
        ap: linha(/^Uso restrito|^Área de pousio|^Servidão/) }); }
    return F;
}
async function cdFotos(u, etapa) {
    if (!u.decl || u.decl.vazio) { if (u.decl) await cdPrepararGeo(u).catch(() => null); return null; }
    await cdPrepararGeo(u).catch(e => console.error('CAR declarado – geometrias', e));
    const F = cdFrentes(u); if (!u.declGeo) return { F, fotos: {} };
    const fotos = {}, X = u.cdX || {};
    for (let i = 0; i < F.length; i++) {
        const fr = F[i]; etapa && etapa(`CAR declarado: ${fr.titulo.toLowerCase()} (${i + 1}/${F.length})`);
        const extra = [];
        if (fr.fbdsRios && X.riosFbds && X.riosFbds.length) extra.push({ id: 'cdx-rios', data: turf.featureCollection(X.riosFbds), layer: { type: 'line', paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-dasharray': [2, 2] } } });
        if (fr.ana) { const m = (u.r.massas || []).filter(x => /artificial/.test(x.f.properties.grupo || '')).map(x => x.f);
            if (m.length) extra.push({ id: 'cdx-ana', data: turf.featureCollection(m), layer: { type: 'line', paint: { 'line-color': '#ffea00', 'line-width': 2.5 } } }); }
        if (fr.nascFbds && X.nascFbds && X.nascFbds.length) {
            const sem = new Set(X.nascSem || []);
            extra.push({ id: 'cdx-nasc', data: turf.featureCollection(X.nascFbds.map(p => ({ type: 'Feature', geometry: p.geometry, properties: { s: sem.has(p) ? 1 : 0 } }))),
                layer: { type: 'circle', paint: { 'circle-radius': ['case', ['==', ['get', 's'], 1], 7, 10], 'circle-color': ['case', ['==', ['get', 's'], 1], '#ff1744', 'rgba(0,0,0,0)'], 'circle-stroke-color': ['case', ['==', ['get', 's'], 1], '#ffffff', '#00e5ff'], 'circle-stroke-width': 2.5 } } });
        }
        fotos[fr.id] = await cdFoto(u, fr.gs, extra).catch(e => (console.error(e), null));
    }
    return { F, fotos };
}
function cdResumoTabela(u) {
    const D = u.decl, area = u.area, ordem = [['APP', /^APP|^Area de Preservacao/], ['Hidrografia', /^Curso|^Lago|^Reservatorio artificial/], ['Nascentes', /Nascentes/], ['Reserva Legal', /^Reserva Legal/],
        ['Cobertura do solo', /^Remanescente|^Area Consolidada|^Area de Pousio/], ['Uso restrito', /Uso Restrito/], ['Servidão administrativa', /Servidao|Utilidade|Infraestrutura|para Abastecimento/]];
    const tipo = k => (ordem.find(([, re]) => re.test(k)) || ['Outros'])[0];
    const L = Object.entries(D.T).map(([k, v]) => ({ tipo: tipo(k), nome: cdNome(k), v, hid: /^Curso|^Lago|^Reservatorio artificial decorrente de barramento ou/.test(k) }))
        .sort((a, b) => ordem.findIndex(o => o[0] === a.tipo) - ordem.findIndex(o => o[0] === b.tipo) || b.v.ha - a.v.ha);
    return `<table class="rx-tab"><tr><th>Tipo</th><th>Subfeição declarada</th><th style="text-align:right">Área (ha)</th><th style="text-align:right">Feições</th><th style="text-align:right">% do imóvel</th></tr>
      <tr><td>Área do imóvel</td><td>Perímetro do CAR (área calculada)</td><td style="text-align:right">${rxF(area, 2)}</td><td style="text-align:right">1</td><td style="text-align:right">100,00%</td></tr>
      ${L.map(l => `<tr><td>${esc(l.tipo)}</td><td>${esc(l.nome)}</td><td style="text-align:right">${l.hid ? '–' : rxF(l.v.ha, 2)}</td><td style="text-align:right">${l.v.n}</td><td style="text-align:right">${l.hid ? '–' : rxF(l.v.ha / area * 100, 2) + '%'}</td></tr>`).join('')}</table>
      <p class="hint">Áreas como declaradas no SICAR (base de downloads do Paraná). Hidrografia é declarada como linhas e polígonos, sem área no cadastro.</p>`;
}
function cdConsideracoes(u) {
    const D = u.decl, rows = cdComparar(u), area = u.area, X = u.cdX || {};
    const prob = rows.filter(r => r.st === 'no' || r.st === 'at').map(r => `${r.rot}: ${r.txt}`);
    return `<p>A análise da declaração do CAR <span class="mono">${esc(u.nome)}</span>, com ${rxF(area, 2)} ha, mostra APP de ${rxF(D.app, 2)} ha, Reserva Legal de ${rxF(D.rl, 2)} ha (${rxF(D.rl / area * 100, 2)}% da área, ${D.rl >= 0.2 * area * 0.95 ? 'atendendo' : 'abaixo d'}o mínimo de 20% da Mata Atlântica), áreas consolidadas de ${rxF(D.cons, 2)} ha, remanescente de vegetação nativa de ${rxF(D.veg, 2)} ha e ${D.nasc} nascente(s) declarada(s).</p>
      ${prob.length ? `<p>Pontos que merecem atenção na declaração:</p><ul>${prob.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : '<p>Não foram encontradas divergências relevantes entre o declarado e as bases de referência.</p>'}
      <p>Os dados foram declarados pelo responsável pelo cadastro e comparados automaticamente com imagens de satélite, a hidrografia de referência (FBDS) e os espelhos d'água da ANA, conforme o Código Florestal (Lei nº 12.651/2012). Recomenda-se a vistoria de campo para validar as feições — em especial APP, nascentes e Reserva Legal — e, se for o caso, a retificação do CAR antes da análise pelo órgão ambiental.</p>`;
}
function cdSecoesHtml(u, R, sec, fotoImovel) {
    if (!u.decl) return '';
    if (u.decl.vazio) return sec('Análise da declaração do CAR', 'Temas declarados no SICAR comparados com o satélite e as bases públicas',
        `<div class="cd-ap" style="border-left:4px solid #8a5a00;background:#fff6dd;border-radius:6px;padding:8px 10px;font-size:9.5pt"><b style="color:#8a5a00">! Nenhum tema georreferenciado declarado</b><br>O CAR <span class="mono">${esc(u.nome)}</span> não traz, na base do SICAR, desenho de APP, Reserva Legal, vegetação nativa, área consolidada, cursos d'água ou nascentes – só o perímetro. Informações apenas documentais (como Reserva Legal averbada em matrícula) não aparecem no mapa do cadastro e precisam ser desenhadas na retificação do CAR.</div>`
        + '<h4>Declarado × verificado</h4>' + cdQuadroHtml(u) + '<h4>Considerações</h4>' + cdConsideracoes(u));
    const { F, fotos } = R || { F: cdFrentes(u), fotos: {} };
    const ST = { ok: ['✓', 'Compatível', '#1b6b3a', '#e7f5ec'], at: ['!', 'Atenção', '#8a5a00', '#fff6dd'], no: ['✕', 'Divergência', '#b71c1c', '#fdecea'], na: ['•', 'Informação', '#5f6d66', '#eef1ef'] };
    const ap = l => l.length ? l.map(a => { const s = ST[a.st] || ST.na; return `<div class="cd-ap" style="border-left-color:${s[2]};background:${s[3]}"><b style="color:${s[2]}">${s[0]} ${s[1]} – ${esc(a.rot)}</b><span>${esc(a.txt)}</span></div>`; }).join('')
        : `<div class="cd-ap" style="border-left-color:#1b6b3a;background:#e7f5ec"><b style="color:#1b6b3a">✓ Sem apontamentos</b><span>Nada a destacar na comparação automática.</span></div>`;
    const css = `<style>.cd-fr{break-inside:avoid;margin:0 0 12px}.cd-fr h4{margin:10px 0 4px}.cd-fr p{margin:4px 0 6px;text-align:justify}.cd-fr img.mapa{max-height:100mm;object-fit:cover}
      .cd-ap{border-left:4px solid;border-radius:6px;padding:6px 10px;margin:4px 0;font-size:9pt}.cd-ap b{display:block;font-size:9pt}.cd-ap span{color:#33413a}</style>`;
    const D = u.decl, decl = rxNum(u.p && u.p['Área (ha)']);
    const imovel = `<div class="cd-fr"><h4>Área do imóvel</h4>${fotoImovel ? `<img class="mapa" src="${fotoImovel}" alt="Perímetro">` : ''}
      <p>Perímetro declarado no CAR <span class="mono">${esc(u.nome)}</span>, com ${rxF(u.area, 2)} ha calculados${decl ? ` (${rxF(decl, 2)} ha declarados)` : ''}. O perímetro é informado pelo responsável pelo cadastro; recomenda-se conferir as divisas com a matrícula e, quando houver, com a certificação no SIGEF.</p>
      ${ap(decl && Math.abs(u.area - decl) / decl > .05 ? [{ st: 'at', rot: 'Área do imóvel', txt: `Diferença de ${rxF(u.area - decl, 2)} ha entre a área calculada e a declarada` }] : [])}</div>`;
    const blocos = F.map(fr => `<div class="cd-fr"><h4>${esc(fr.titulo)}</h4>${fotos[fr.id] ? `<img class="mapa" src="${fotos[fr.id]}" alt="${esc(fr.titulo)}">${cdLegenda(fr.gs.filter(g => cdDoGrupo(u.declGeo, g).features.length), fr.leg || '')}` : ''}
      <p>${fr.texto}</p>${ap(fr.ap)}</div>`).join('');
    return css + sec('Análise da declaração do CAR', `Temas declarados no SICAR, um a um, com os apontamentos da comparação automática${u.declGeo ? '' : ' (mapas por tema indisponíveis para este imóvel)'}`, imovel + blocos)
        + sec('Resumo das feições declaradas', 'Quadro de áreas do CAR e comparação com as bases de referência', cdResumoTabela(u) + '<h4>Declarado × verificado</h4>' + cdQuadroHtml(u))
        + sec('Considerações finais sobre a declaração do CAR', '', cdConsideracoes(u), false);
}
