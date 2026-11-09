// ---------- Raio-X do imóvel: cruzamentos automáticos e relatório em PDF ----------
// Usa só os dados já publicados no mapa (CAR, SIGEF, embargos IBAMA, alertas MapBiomas, outorgas, licenças, barragens SNISB/IAT, açudes e represas (ANA),
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
// barragem cadastrada (ponto) a até 200 m do espelho d'água
function rxBarragemDaMassa(m, barrs) {
    const bb = turf.bbox(m), d = 0.002;
    for (const b of barrs) { const [x, y] = b.geometry.coordinates; if (x < bb[0] - d || x > bb[2] + d || y < bb[1] - d || y > bb[3] + d) continue;
        if (turf.booleanPointInPolygon(b, m)) return b;
        const arr = turf.flatten(turf.polygonToLine(m)).features;
        if (Math.min(...arr.map(l => turf.pointToLineDistance(b, l))) <= 0.2) return b; }
    return null;
}
function rxPontos(alvo, feats, raioKm = 0.5) {
    const bb = turf.bbox(alvo), m = raioKm / 100, dentro = [], perto = [];
    const ls = turf.flatten(turf.polygonToLine(alvo)).features;
    for (const f of feats) {
        if (f.geometry?.type !== 'Point') continue;
        const [x, y] = f.geometry.coordinates;
        if (x < bb[0] - m || x > bb[2] + m || y < bb[1] - m || y > bb[3] + m) continue;
        if (turf.booleanPointInPolygon(f, alvo)) { dentro.push({ f, km: 0 }); continue; }
        const km = Math.min(...ls.map(l => turf.pointToLineDistance(f, l)));
        if (km <= raioKm) perto.push({ f, km });
    }
    return { dentro, perto: perto.sort((a, b) => a.km - b.km) };
}
// declividade: lê a imagem do mapa (classes Embrapa por cor) e conta os pixels dentro do imóvel
async function rxRasterDecliv() {
    if (RX.decl) return RX.decl;
    const cfg = await rxJSON((dadosGerais.raiox || {}).declividade);
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


// ---------- resumo de pendências e adequações (base para orçamento) ----------
const rxData = (t) => { const m = String(t || '').match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null; };
function rxNecessidades(p, r, area, uso) {
    const N = [], add = (prior, tema, achado, adequacao) => N.push({ prior, tema, achado, adequacao });
    const sit = p.situacao || '', mf = rxNum(p['Módulos fiscais']), hoje = new Date(), em12m = new Date(hoje.getTime() + 365 * 864e5);
    // CAR
    if (sit === 'Analisado – regularização ambiental pendente') add(1, 'CAR / PRA', 'CAR analisado com regularização ambiental pendente', 'Adesão ao Programa de Regularização Ambiental (PRA) e termo de compromisso com o órgão ambiental');
    else if (sit === 'Analisado – notificação pendente') add(1, 'CAR', 'Notificação do órgão no SICAR sem resposta', 'Responder a notificação do SICAR (ajustes de perímetro, APP, Reserva Legal ou documentos)');
    else if (sit === 'Aguardando análise' || sit === 'Em análise') add(3, 'CAR', `CAR ${sit.toLowerCase()}`, 'Revisar o CAR antes da análise do órgão (perímetro, APP, Reserva Legal, uso consolidado) e retificar se necessário');
    // embargos e alertas
    r.emb.filter(x => x.f.properties['Situação'] !== 'Desembargado').forEach(x => add(1, 'Embargo IBAMA', `${x.f.properties.nome} (${rxF(x.ha, 2)} ha no imóvel)`, 'Defesa administrativa e/ou regularização do embargo, com Projeto de Recuperação de Área Degradada (PRAD) se aplicável'));
    if (r.alertas.length) add(1, 'Desmatamento', `${r.alertas.length} alerta(s) MapBiomas (${rxF(r.alertas.reduce((a, x) => a + x.ha, 0), 2)} ha)`, 'Laudo técnico do alerta (supressão autorizada, falso positivo ou infração) e, se for o caso, PRAD ou regularização da supressão');
    // Reserva Legal
    const nat = uso.find(([k]) => /Vegetação (nativa|arbórea)/.test(k));
    const pv = nat ? nat[1] : (p.veg_nativa_pct ?? null);
    if (pv !== null && pv < 20) add(mf > 4 ? 1 : 2, 'Reserva Legal', `Vegetação ${nat && /arbórea/.test(nat[0]) ? 'arbórea' : 'nativa'} de ${rxF(pv, 1)}% do imóvel (mínimo legal de 20% no PR)`,
        mf > 4 ? 'Diagnóstico de Reserva Legal: recomposição, regeneração ou compensação (CRA/doação em UC), via PRA' : 'Verificar Reserva Legal: imóveis até 4 módulos podem usar a vegetação existente em 22/07/2008 (art. 67 do Código Florestal)');
    // sobreposições
    const maior = r.car[0];
    if (maior && maior.ha >= Math.max(1, area * 0.02)) add(2, 'Sobreposição de CAR', `${rxF(maior.ha)} ha (${rxF(maior.ha / area * 100, 1)}%) sobre o CAR ${maior.f.properties.nome}`, 'Conferir divisas com o vizinho e retificar o perímetro no CAR (o próprio e/ou o do vizinho)');
    // SIGEF / INCRA
    const cobS = Math.min(area, r.sigef.reduce((a, x) => a + x.ha, 0)) / area;
    if (cobS < 0.5) add(mf > 4 ? 2 : 3, 'Georreferenciamento', r.sigef.length ? `SIGEF cobre só ${rxF(cobS * 100, 0)}% do imóvel` : 'Sem parcela certificada no SIGEF/INCRA',
        'Georreferenciamento e certificação no SIGEF/INCRA (exigido para desmembramento, remembramento e transferência)');
    const semReg = r.sigef.filter(x => x.f.properties['Situação'] && x.f.properties['Situação'] !== 'Registrada');
    if (semReg.length) add(2, 'Registro', `${semReg.length} parcela(s) SIGEF ainda sem registro em cartório`, 'Averbação/registro da certificação SIGEF na matrícula do imóvel');
    // relevo
    const mont = (r.decl[4] || {}).pct || 0;
    if (mont >= 0.5) add(2, 'Relevo / uso restrito', `${rxF(mont, 1)}% do imóvel com declividade acima de 45% (≈ 25°)`, 'Verificar uso restrito em áreas de 25° a 45° (art. 11 do Código Florestal) e APP de encostas acima de 45°; manejo conservacionista');
    else if (r.decl.slice(3).reduce((a, d) => a + d.pct, 0) >= 15) add(3, 'Conservação do solo', 'Parte relevante do imóvel em relevo forte ondulado (≥ 20%)', 'Plano de conservação do solo e da água (terraceamento, plantio em nível, cobertura)');
    // água
    const ag = [...r.agua.dentro];
    ag.forEach(x => { const v = rxData(x.f.properties.Vencimento); if (v && v < em12m) add(v < hoje ? 1 : 2, 'Outorga de água', `${x.f.properties.Interferência || 'Outorga'} – vence${v < hoje ? 'u' : ''} em ${x.f.properties.Vencimento}`, 'Renovação da outorga no SIGARH (IAT)'); });
    if (ag.length) {
        const tipo = x => x.f.properties.Interferência || x.f.properties.grupo || '';
        const capta = ag.filter(x => /capta|subterr|poço/i.test(tipo(x))), lanca = ag.filter(x => /lançamento/i.test(tipo(x)));
        const tipos = {}; capta.forEach(x => { const t = x.f.properties.Interferência || x.f.properties.grupo || 'Outorga'; tipos[t] = (tipos[t] || 0) + 1; });
        const desc = Object.entries(tipos).map(([t, n]) => `${n} ${t.toLowerCase()}`).join(', ');
        if (capta.length) add(2, 'Outorga – monitoramento', `${capta.length} outorga(s) de uso de água no imóvel (${desc})`,
            'Verificação in loco: hidrômetro/medidor de vazão instalado e funcionando, leituras registradas e volumes dentro do outorgado; análise da qualidade da água captada; conferir as demais condicionantes da portaria (IAT/SIGARH)');
        if (lanca.length) add(2, 'Outorga – efluentes', `${lanca.length} outorga(s) de lançamento de efluentes no imóvel`,
            'Monitoramento do efluente lançado (vazão e análises laboratoriais conforme a portaria) e do corpo receptor; relatórios ao IAT');
    }
    if (!ag.length) add(3, 'Uso da água', 'Nenhuma outorga do SIGARH localizada dentro do imóvel', 'Verificar em campo os usos de água (poço, captação, barragem, irrigação, dessedentação) e regularizar por outorga ou declaração de uso independente');
    r.barr.dentro.forEach(x => { const q = x.f.properties, pnsb = /^sim/i.test(q['Regulada pela PNSB'] || '');
        if (pnsb && /^n[ãa]o/i.test(q['Plano de segurança'] || '')) add(1, 'Segurança de barragem', `${q.nome}: enquadrada na PNSB e sem Plano de Segurança declarado (risco ${q.risco || 'não informado'}, DPA ${q.dpa || 'não informado'})`, 'Elaborar Plano de Segurança da Barragem, inspeções e revisão periódica (Lei 12.334/2010 e normas do IAT)');
    });
    const barrComuns = r.barr.dentro.filter(x => !(/^sim/i.test(x.f.properties['Regulada pela PNSB'] || '') && /^n[ãa]o/i.test(x.f.properties['Plano de segurança'] || '')));
    if (barrComuns.length) add(2, 'Barragem', barrComuns.length === 1 ? `${barrComuns[0].f.properties.nome} (${barrComuns[0].f.properties.Fonte || 'cadastro'}; risco ${barrComuns[0].f.properties.risco || 'não informado'}, DPA ${barrComuns[0].f.properties.dpa || 'não informado'})`
        : `${barrComuns.length} barragens cadastradas no imóvel (${barrComuns.filter(x => x.f.properties.risco === 'Alto').length} de risco alto) – ver tabela de barragens`,
        'Conferir cadastro no SNISB/IAT, outorga do barramento e obrigações de segurança de barragem (Lei 12.334/2010)');
    r.massas.filter(x => /artificial/.test(x.f.properties.grupo) && !x.barr).slice(0, 8).forEach(x => add(2, 'Açude / represa', `Espelho d'água artificial de ${x.f.properties['Área (ha)']} ha sem barragem localizada no SNISB/IAT`,
        'Verificar a regularização do barramento (outorga ou dispensa no IAT/SIGARH e cadastro no SNISB) e a APP do entorno (art. 4º, III, da Lei 12.651/2012; dispensada abaixo de 1 ha, § 4º)'));
    (r.lic?.dentro || []).forEach(x => { const v = rxData(x.f.properties.Validade); if (v && v < em12m) add(v < hoje ? 1 : 2, 'Licença ambiental', `${x.f.properties.Modalidade || 'Licença'} – validade ${x.f.properties.Validade}`, 'Renovação da licença ambiental no IAT (SGA)'); });
    add(3, 'Vistoria', 'Análise feita só com bases públicas', 'Vistoria de campo e conferência documental (matrícula, CCIR, ITR, CAR) para confirmar os itens acima');
    return N.sort((a, b) => a.prior - b.prior);
}
function rxResumoHtml(N) {
    const ROT = { 1: ['Alta', '#c62828'], 2: ['Média', '#ef6c00'], 3: ['Baixa / verificar', '#558b2f'] };
    const cont = [1, 2, 3].map(k => N.filter(n => n.prior === k).length);
    return `<h3>Resumo: pendências e adequações sugeridas</h3>
        <div class="rx-cob">${[1, 2, 3].map((k, i) => `<span><i style="background:${ROT[k][1]}"></i>Prioridade ${ROT[k][0].toLowerCase()}: <b>${cont[i]}</b></span>`).join('')}</div>
        <table class="rx-tab"><tr><th>Nº</th><th>Prioridade</th><th>Tema</th><th>Situação encontrada</th><th>Adequação / serviço sugerido</th></tr>
        ${N.map((n, i) => `<tr><td><b>${i + 1}</b></td><td><span class="rx-sw" style="background:${ROT[n.prior][1]}"></span>${ROT[n.prior][0]}</td><td>${esc(n.tema)}</td><td>${esc(n.achado)}</td><td>${esc(n.adequacao)}</td></tr>`).join('')}</table>
        <p class="hint">Lista indicativa para orientar o orçamento de adequação ambiental e fundiária. Itens e quantidades devem ser confirmados em vistoria.</p>`;
}

async function analisarImovel(nome) {
    const dlg = document.getElementById('raioxDialog'), corpo = document.getElementById('raioxCorpo');
    corpo.innerHTML = '<p class="hint">Cruzando o imóvel com as camadas do mapa…</p>'; dlg.showModal();
    try {
        const C = dadosGerais.raiox || {};
        const cars = (camadasData.imoveis || (await rxJSON(C.car))).features;
        const alvo = cars.find(f => f.properties.nome === nome);
        if (!alvo) { corpo.innerHTML = '<p>Imóvel não encontrado.</p>'; return; }
        const p = alvo.properties, area = rxHa(alvo);
        const [sigef, emb, alertas, outR, outU, lic, barr, mbac, mass] = await Promise.all([C.sigef, C.embargos, C.alertas, (C.outorgas || [])[0], (C.outorgas || [])[1], C.licencas, C.barragens, C.microbacias, C.massas].map(a => a ? rxJSON(a).catch(() => ({ features: [] })) : Promise.resolve({ features: [] })));
        const r = {
            car: rxSobreposicoes(alvo, cars.filter(f => f.properties.situacao !== 'Cancelado'), 0.05),
            sigef: rxSobreposicoes(alvo, sigef.features, 0.05),
            emb: rxSobreposicoes(alvo, emb.features, 0.0001),
            alertas: Object.values(rxSobreposicoes(alvo, alertas.features, 0.0001).reduce((m, x) => { const k = x.f.properties.nome; if (!m[k] || m[k].ha < x.ha) m[k] = x; return m; }, {})),
            agua: rxPontos(alvo, [...outR.features, ...outU.features]),
            lic: rxPontos(alvo, lic.features),
            barr: rxPontos(alvo, barr.features),
            massas: rxSobreposicoes(alvo, mass.features, 0.01).map(x => ({ ...x, barr: rxBarragemDaMassa(x.f, barr.features) })),
            decl: await rxDeclividade(alvo).catch(() => []),
            mbac: mbac.features.filter(m => rxCaixasCruzam(turf.bbox(m), turf.bbox(alvo)) && turf.booleanPointInPolygon(turf.pointOnFeature(alvo), m)).map(m => m.properties.nome || m.properties.rio).slice(0, 1)
        };
        const uso = Object.keys(p).filter(k => /^(MapBiomas|Uso do solo) \d{4} – /.test(k)).map(k => [k.replace(/^(MapBiomas|Uso do solo) \d{4} – /, '').replace(' (%)', ''), rxNum(p[k])]).sort((a, b) => b[1] - a[1]);
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
        const barrAlto = r.barr.dentro.filter(x => x.f.properties.risco === 'Alto');
        if (barrAlto.length) flags.push(['amarelo', `${barrAlto.length} barragem(ns) com categoria de risco ALTO dentro do imóvel`]);
        const acSem = r.massas.filter(x => /artificial/.test(x.f.properties.grupo) && !x.barr);
        if (acSem.length) flags.push(['amarelo', `${acSem.length} açude(s)/represa(s) no imóvel sem barragem localizada no SNISB/IAT`]);
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
            <h3>Uso e cobertura do solo (${esc(((Object.keys(p).find(k => /^(MapBiomas|Uso do solo) \d{4}/.test(k)) || '').match(/^(MapBiomas \d{4}|Uso do solo \d{4})/) || [''])[0].replace('Uso do solo', 'Esri/Impact Observatory'))})</h3>
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
            ${C.licencas === null ? '' : `<h3>Licenças ambientais (IAT) no imóvel ou a até 500 m</h3>`}
            ${C.licencas === null ? '' : tab(['Nº', 'Empreendimento (SGA)', 'Atividade', 'Posição', 'Coordenadas (lat, long)'], pts(r.lic, 'Atividade', 'lic'))}
            <h3>Barragens cadastradas (SNISB/ANA e IAT) no imóvel ou a até 500 m</h3>
            ${(() => { const lista = [...r.barr.dentro, ...r.barr.perto].slice(0, 12); const linhas = pts(r.barr, 'Fonte', 'barr');
                return tab(['Nº', 'Barragem', 'Fonte', 'Risco / DPA', 'Uso · altura · volume', 'Posição', 'Coordenadas (lat, long)'], linhas.map((l, i) => { const q = lista[i].f.properties;
                    return [l[0], l[1] + (q.Empreendedor ? `<br><span class="hint">${esc(q.Empreendedor)}</span>` : ''), l[2], `${esc(q.risco || '–')} / ${esc(q.dpa || '–')}`,
                        esc([q['Uso principal'] || q['Finalidade (IAT)'], q['Altura (m)'] && q['Altura (m)'] + ' m', q['Volume (hm³)'] && q['Volume (hm³)'] + ' hm³'].filter(Boolean).join(' · ') || '–'), l[3], l[4]]; })); })()}
            <h3>Açudes, represas e lagos no imóvel (ANA)</h3>
            ${tab(['Nº', 'Tipo', 'Espelho d\'água total (ha)', 'Dentro do imóvel (ha)', 'Barragem cadastrada', 'Centro (lat, long)'], r.massas.slice(0, 15).map((x, i) => { const q = x.f.properties, c = turf.pointOnFeature(x.f).geometry.coordinates;
                return [`<b>${i + 1}</b>`, esc(q.grupo), esc(q['Área (ha)']), rxF(Math.min(x.ha, rxNum(q['Área (ha)']) || x.ha), 2), x.barr ? `Sim – ${esc(x.barr.properties.nome)}` : (/artificial/.test(q.grupo) ? '<b>Não localizada</b>' : '–'),
                    `<span class="mono">${c[1].toFixed(5)}, ${c[0].toFixed(5)}</span>`]; }))}
            ${rxResumoHtml(rxNecessidades(p, r, area, uso))}
            <p class="hint">Microbacia: ${esc(r.mbac[0] || '–')} · Dados do mapa atualizados em ${esc(dadosGerais.atualizado_em || '')}.</p>
            <p class="hint rx-aviso">Análise automática feita sobre bases públicas (SICAR, INCRA/SIGEF, IBAMA, MapBiomas, IAT/SIGARH/SGA, ANA/SNISB, Copernicus). As áreas são aproximadas e não substituem vistoria, levantamento topográfico ou consulta oficial aos órgãos.</p>`;
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
    await new Promise(res => setTimeout(res, 400));
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
    // monta tudo nesta aba (o mapa precisa estar visível para desenhar) e só no fim abre o relatório
    document.getElementById('raioxDialog').close();
    const aviso = document.createElement('div'); aviso.className = 'rx-progresso';
    aviso.innerHTML = '<div><b>Montando o relatório…</b><span id="rxEtapa">mapa de localização (1/4)</span><small>Mantenha esta aba aberta e visível.</small></div>';
    document.body.appendChild(aviso);
    const etapa = (t) => { const e = document.getElementById('rxEtapa'); if (e) e.textContent = t; };
    const centro = map.getCenter(), zoom = map.getZoom();
    const foto = await rxFotoLocalizacao(u.alvo);
    const relevantes = u.viz.filter(x => x.ha >= 0.05).slice(0, 15);
    etapa('mapa de sobreposições (2/4)');
    const foto2 = relevantes.length ? await rxFotoSobreposicao(u.alvo, relevantes) : null;
    const parc = (u.sigef || []).slice(0, 15);
    etapa('mapa do SIGEF (3/4)');
    const foto3 = parc.length ? await rxFotoSigef(u.alvo, parc) : null;
    etapa('mapa de outorgas e licenças (4/4)');
    const foto4 = (u.pontos || []).length ? await rxFotoPontos(u.alvo, u.pontos) : null;
    const janela = { partes: [], document: { open() { }, write(t) { janela.partes.push(t); }, close() { } } };
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
<header><div><h1>Relatório de análise do imóvel rural</h1><div class="hint">${esc(titulo)}</div></div>
<div style="text-align:right"><div class="hint">Gerado em</div><b>${esc(dataHora)}</b></div></header>
${foto ? `<h3>Localização do imóvel</h3><img class="mapa" src="${foto}" alt="Mapa de localização do imóvel"><div class="hint">Imóvel analisado: perímetro em vermelho e interior em verde-claro, sobre imagem de satélite (Esri World Imagery).</div>` : ''}
${u.html.replace('<!--FOTO4-->', foto4 ? `<img class="mapa" src="${foto4}" alt="Mapa das outorgas e licenças"><div class="hint legenda"><span style="background:#b9f6ca;border:2px solid #ff1744"></span>imóvel analisado &nbsp; <span style="background:#1e88e5;border-radius:50%"></span>outorga de água &nbsp; <span style="background:#8e24aa;border-radius:50%"></span>licença ambiental &nbsp; <span style="background:#00897b;border-radius:50%"></span>barragem – números = linhas das tabelas</div>` : '').replace('<!--FOTO3-->', foto3 ? `<img class="mapa" src="${foto3}" alt="Mapa do SIGEF"><div class="hint legenda"><span style="border:3px solid #ff1744;background:none"></span>imóvel analisado (CAR) &nbsp; ${Object.values(RX_SIGEF).map(([c, t]) => `<span style="background:${c}"></span>${t}`).join(' &nbsp; ')} – números = linhas da tabela</div>` : '').replace('<!--FOTO2-->', foto2 ? `<img class="mapa" src="${foto2}" alt="Mapa das sobreposições"><div class="hint legenda"><span style="background:#b9f6ca;border:2px solid #ff1744"></span>imóvel analisado &nbsp; <span style="border:2px dashed #e6c800;background:none"></span>imóveis vizinhos com sobreposição (nº da tabela) &nbsp; <span style="background:#ff9100"></span>área sobreposta</div>` : '')}
<footer><div class="hint">CS Consultoria Ambiental · Relatório gerado automaticamente a partir de bases públicas.<br>Dados do mapa atualizados em ${esc(dadosGerais.atualizado_em || '')}.</div>
<div style="text-align:right"><div class="hint">Código de conferência</div><div class="cod">${u.codigo}</div><div class="hint">identifica esta versão do relatório</div></div></footer>
<p class="noprint" style="text-align:center;margin-top:16px"><button onclick="window.print()" style="padding:9px 18px;font-size:14px;background:#1e5a3c;color:#fff;border:0;border-radius:6px;cursor:pointer">Salvar em PDF / imprimir</button></p>
</body></html>`);
    const url = URL.createObjectURL(new Blob(janela.partes, { type: 'text/html;charset=utf-8' }));
    const nomeArq = `relatorio_${u.nome}.html`;
    aviso.innerHTML = `<div><b>Relatório pronto</b><a class="btn btn-solid" href="${url}" target="_blank" rel="noopener" id="rxAbrir">Abrir relatório</a>
        <a class="btn" href="${url}" download="${nomeArq}">Baixar (HTML)</a><button type="button" class="btn" id="rxFecharAviso">Fechar</button></div>`;
    document.getElementById('rxFecharAviso').onclick = () => aviso.remove();
    document.getElementById('rxAbrir').addEventListener('click', () => setTimeout(() => aviso.remove(), 500));
    const w = window.open(url, '_blank'); if (w) setTimeout(() => aviso.remove(), 800);
}
// baixa em segundo plano, depois que o mapa abre, os dados usados pelo Raio-X (o primeiro clique fica instantâneo)
function rxPrecarregar() {
    if (typeof dadosGerais === 'undefined' || !dadosGerais.camadas) return setTimeout(rxPrecarregar, 2000);
    const C = dadosGerais.raiox;
    const lista = C ? [C.sigef, C.embargos, C.alertas, ...(C.outorgas || []), C.licencas, C.barragens, C.microbacias, C.massas, C.declividade]
        : ['data/fundiario/sigef_londrina.geojson', 'data/ibama/embargos_londrina.geojson', 'data/mapbiomas/alertas_londrina.geojson', 'data/iat/outorgas_rural.geojson',
           'data/iat/outorgas_urbana.geojson', 'data/iat/licencas_localizadas.geojson', 'data/iat/barragens_londrina.geojson', 'data/bacias/microbacias_regiao.geojson', 'data/relevo/declividade.json'];
    const ocioso = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
    ocioso(() => { lista.filter(Boolean).forEach(a => rxJSON(a).catch(() => { delete RX.cache[a]; })); rxRasterDecliv().catch(() => { }); });
}
setTimeout(rxPrecarregar, 4000);
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('raioxFechar')?.addEventListener('click', () => document.getElementById('raioxDialog').close());
    document.getElementById('raioxPdf')?.addEventListener('click', gerarRelatorioRaiox);
});
