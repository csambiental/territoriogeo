// ---------- CAR declarado (base temática do SICAR) × verificado por satélite e bases públicas ----------
// Dados: data/car_declarado/<cód. IBGE>.json  {temas: [...], imoveis: {"PR-...": [[i_tema, área_ha, nº_feições], ...]}}
async function cdDeclarado(nome) {
    const m = /^PR-(\d{7})-/.exec(nome || ''); if (!m) return null;
    const d = await rxJSON(`data/car_declarado/${m[1]}.json`).catch(() => null);
    const l = d && d.imoveis && d.imoveis[nome]; if (!l) return null;
    const T = {}; l.forEach(([i, a, n]) => { T[d.temas[i]] = { ha: a, n }; });
    const s = re => Object.entries(T).filter(([k]) => re.test(k)).reduce((a, [, v]) => ({ ha: a.ha + v.ha, n: a.n + v.n }), { ha: 0, n: 0 });
    const g = k => T[k] || { ha: 0, n: 0 };
    const rlTipo = ['Reserva Legal Averbada', 'Reserva Legal Aprovada e nao Averbada', 'Reserva Legal Proposta'].filter(k => T[k]).map(k => k.replace('Reserva Legal ', '').replace('nao', 'não').toLowerCase());
    return {
        T,
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
    if (vegMed != null) { const dif = D.veg - vegMed, lim = Math.max(2, 0.1 * Math.max(D.veg, vegMed));
        L.push({ rot: 'Remanescente de vegetação nativa', decl: f(D.veg), ver: f(vegMed) + ' (satélite)', st: Math.abs(dif) <= lim ? 'ok' : dif > 0 ? 'no' : 'at',
            txt: Math.abs(dif) <= lim ? 'Compatível' : dif > 0 ? `Declarado ${f(dif)} acima do medido – vegetação declarada onde o satélite não encontra` : `Satélite mede ${f(-dif)} a mais – vegetação não declarada (pode reforçar a RL)` }); }
    // reserva legal
    { const min = 0.2 * area, pct = D.rl / area * 100, def = min - D.rl, mf = rxNum(u.p && u.p['Módulos fiscais']);
      L.push({ rot: `Reserva Legal${D.rlTipo.length ? ' (' + D.rlTipo.join(', ') + ')' : ''}`, decl: `${f(D.rl)} (${rxF(pct, 1)}%)`, ver: `mínimo 20% = ${f(min)}`,
          st: def <= 0.05 * min ? 'ok' : mf && mf <= 4 ? 'at' : 'no', txt: def <= 0.05 * min ? 'Atende o mínimo legal' : `Déficit declarado de ${f(def)}${mf && mf <= 4 ? ' – imóvel até 4 módulos: pode valer a vegetação de 22/07/2008 (art. 67)' : ' – recompor, regenerar ou compensar (PRA)'}` });
      if (vegMed != null && D.rl > vegMed * 1.05 + 1) L.push({ rot: 'Reserva Legal × vegetação existente', decl: f(D.rl), ver: f(vegMed) + ' de vegetação', st: 'at', txt: `RL declarada maior que a vegetação medida em ${f(D.rl - vegMed)} – parte da RL pode estar sem cobertura (recomposição)` }); }
    // APP
    if (P) { const dif = D.app - P.app, lim = Math.max(2, 0.2 * Math.max(D.app, P.app));
        L.push({ rot: 'APP total', decl: f(D.app), ver: f(P.app) + ' (faixas legais estimadas)', st: Math.abs(dif) <= lim ? 'ok' : dif < 0 ? 'no' : 'at',
            txt: Math.abs(dif) <= lim ? 'Compatível' : dif < 0 ? `APP declarada ${f(-dif)} menor que a estimada – conferir rios/nascentes não declarados` : `APP declarada ${f(dif)} maior que a estimada – conferir traçado da hidrografia` }); }
    if (D.appRecompor > 0.01) L.push({ rot: 'APP a recompor (declarada)', decl: f(D.appRecompor, 2), ver: '–', st: 'at', txt: 'Passivo de APP declarado: recomposição via PRA' });
    if (D.appSemDecl > 0.05) L.push({ rot: 'APP antropizada não declarada como consolidada', decl: f(D.appSemDecl, 2), ver: '–', st: 'at', txt: 'Uso em APP sem enquadramento como área consolidada – recompor ou retificar o CAR' });
    // nascentes
    if (P && P.A && P.A.det) { const nm = P.A.det.nascentes || 0;
        L.push({ rot: 'Nascentes', decl: `${D.nasc} APP(s) de nascente`, ver: `${nm} nascente(s) mapeada(s) (FBDS)`, st: nm > D.nasc ? 'no' : 'ok',
            txt: nm > D.nasc ? `${nm - D.nasc} nascente(s) mapeada(s) sem APP declarada – vistoria e retificação do CAR` : 'Compatível' }); }
    // reservatórios
    { const art = (u.r.massas || []).filter(x => /artificial/.test(x.f.properties.grupo)).length;
      if (art || D.reserv) L.push({ rot: 'Açudes e represas', decl: `${D.reserv} APP(s) de reservatório`, ver: `${art} espelho(s) artificial(is) (ANA)`, st: art > D.reserv ? 'at' : 'ok',
          txt: art > D.reserv ? `${art - D.reserv} açude(s) sem APP de reservatório declarada` : 'Compatível' }); }
    // área consolidada
    if (vegMed != null) { const antr = Math.max(0, area - vegMed), exc = D.cons - antr;
        L.push({ rot: 'Área consolidada (uso antes de 22/07/2008)', decl: f(D.cons), ver: f(antr) + ' de área aberta hoje', st: exc > Math.max(2, 0.05 * area) ? 'at' : 'ok',
            txt: exc > Math.max(2, 0.05 * area) ? `Consolidada declarada ${f(exc)} acima da área aberta – possível sobreposição com vegetação` : 'Compatível' }); }
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
