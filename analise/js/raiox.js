// ---------- Raio-X do imóvel: cruzamentos automáticos e relatório em PDF ----------
// Usa só os dados já publicados no mapa (CAR, SIGEF, embargos IBAMA, alertas MapBiomas, outorgas, licenças, barragens SNISB/IAT, açudes e represas (ANA),
// microbacias e declividade). Tudo é calculado no navegador; nada é enviado para fora.
const RX = { cache: {}, ultimo: null };
const rxJSON = (arq) => (RX.cache[arq] = RX.cache[arq] || fetch(arq, { cache: 'no-cache' }).then(r => r.json()));
const rxHa = (g) => turf.area(g) / 1e4;
const rxNum = (t) => parseFloat(String(t ?? '').replace(/\./g, '').replace(',', '.')) || 0;
function rxInter(a, b) {
    try { const r = turf.intersect(a, b); if (r !== undefined) return r; } catch (e) { }
    try { return turf.intersect(turf.featureCollection([a, b])); } catch (e) {
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
    ag.forEach(x => { const v = rxData(x.f.properties.Vencimento); if (v && v < em12m) add(v < hoje ? 1 : 2, 'Outorga de água', `${x.f.properties.Interferência || 'Outorga'} nº ${x.f.properties['Portaria / declaração'] || 's/ nº'} – vence${v < hoje ? 'u' : ''} em ${x.f.properties.Vencimento}`, 'Renovação da outorga no SIGARH (IAT)'); });
    if (ag.length) {
        const tipo = x => x.f.properties.Interferência || x.f.properties.grupo || '';
        const capta = ag.filter(x => /capta|subterr|poço/i.test(tipo(x))), lanca = ag.filter(x => /lançamento/i.test(tipo(x)));
        const lst = l => l.slice(0, 6).map(x => `nº ${x.f.properties['Portaria / declaração'] || 's/ nº'} (${(x.f.properties.Interferência || 'outorga').toLowerCase()}, vence ${x.f.properties.Vencimento || '–'})`).join('; ') + (l.length > 6 ? `; e mais ${l.length - 6}` : '');
        if (capta.length) add(2, 'Outorga – monitoramento', `${capta.length} outorga(s) de uso de água no imóvel: ${lst(capta)}`,
            'Verificação in loco: hidrômetro/medidor de vazão instalado e funcionando, leituras registradas e volumes dentro do outorgado; análise da qualidade da água captada; conferir as demais condicionantes da portaria (IAT/SIGARH)');
        if (lanca.length) add(2, 'Outorga – efluentes', `${lanca.length} outorga(s) de lançamento de efluentes no imóvel: ${lst(lanca)}`,
            'Monitoramento do efluente lançado (vazão e análises laboratoriais conforme a portaria) e do corpo receptor; relatórios ao IAT');
    }
    // atividade licenciada que consome água × outorga de captação no imóvel
    const RX_AGUA = /avicult|suinocult|bovinocult|bubalinocult|ovinocult|caprinocult|equinocult|cunicult|piscicult|aquicult|carcinicult|ranicult|cria[çc][ãa]o de (animais|aves|su[íi]nos|bovinos|frangos|peixes)|confinamento|leite|latic|abate|frigor|alimentos|bebida|f[ée]cula|amido|aguardente|cacha[çc]a|destilaria|usina|curtume|irriga|viveiro|hortali|cogumel|lavagem|lavador|beneficiamento/i, RX_CAPTA = /capta|subterr|po[çc]o|insignific|uso independente/i;
    const licAgua = (r.lic?.dentro || []).filter(x => !/substituída|^Vencida$/.test(x.f.properties.situacao || '') && RX_AGUA.test(`${x.f.properties.Atividade || ''} ${x.f.properties['Atividade específica'] || ''}`));
    const captaImovel = ag.filter(x => RX_CAPTA.test(`${x.f.properties.Interferência || ''} ${x.f.properties.Documento || ''} ${x.f.properties.grupo || ''}`));
    if (licAgua.length && !captaImovel.length) add(1, 'Uso da água × licença', `Atividade licenciada com consumo de água (${[...new Set(licAgua.map(x => x.f.properties.Atividade))].slice(0, 3).join(', ')}) e nenhuma outorga de captação localizada no imóvel`,
        'Verificar a fonte de água da atividade (poço, nascente, rio, açude, rede) e regularizar no IAT/SIGARH: outorga de captação ou declaração de uso independente de outorga; instalar hidrômetro');
    else if (!ag.length) add(3, 'Uso da água', 'Nenhuma outorga do SIGARH localizada dentro do imóvel', 'Verificar em campo os usos de água (poço, captação, barragem, irrigação, dessedentação) e regularizar por outorga ou declaração de uso independente');
    r.barr.dentro.forEach(x => { const q = x.f.properties, pnsb = /^sim/i.test(q['Regulada pela PNSB'] || '');
        if (pnsb && /^n[ãa]o/i.test(q['Plano de segurança'] || '')) add(1, 'Segurança de barragem', `${q.nome}: enquadrada na PNSB e sem Plano de Segurança declarado (risco ${q.risco || 'não informado'}, DPA ${q.dpa || 'não informado'})`, 'Elaborar Plano de Segurança da Barragem, inspeções e revisão periódica (Lei 12.334/2010 e normas do IAT)');
    });
    const barrComuns = r.barr.dentro.filter(x => !(/^sim/i.test(x.f.properties['Regulada pela PNSB'] || '') && /^n[ãa]o/i.test(x.f.properties['Plano de segurança'] || '')));
    if (barrComuns.length) add(2, 'Barragem', barrComuns.length === 1 ? `${barrComuns[0].f.properties.nome} (${barrComuns[0].f.properties.Fonte || 'cadastro'}; risco ${barrComuns[0].f.properties.risco || 'não informado'}, DPA ${barrComuns[0].f.properties.dpa || 'não informado'})`
        : `${barrComuns.length} barragens cadastradas no imóvel (${barrComuns.filter(x => x.f.properties.risco === 'Alto').length} de risco alto) – ver tabela de barragens`,
        'Conferir cadastro no SNISB/IAT, outorga do barramento e obrigações de segurança de barragem (Lei 12.334/2010)');
    r.massas.filter(x => /artificial/.test(x.f.properties.grupo) && !x.barr).slice(0, 8).forEach(x => add(2, 'Açude / represa', `Espelho d'água artificial de ${x.f.properties['Área (ha)']} ha sem barragem localizada no SNISB/IAT`,
        'Verificar a regularização do barramento (outorga ou dispensa no IAT/SIGARH e cadastro no SNISB) e a APP do entorno (art. 4º, III, da Lei 12.651/2012; dispensada abaixo de 1 ha, § 4º)'));
    (r.lic?.dentro || []).filter(x => !/substituída/.test(x.f.properties.situacao || '')).forEach(x => { const v = rxData(x.f.properties.Validade); if (v && v < em12m) add(v < hoje ? (hoje - v > 5 * 365 * 864e5 ? 3 : 1) : 2, 'Licença ambiental', `${x.f.properties.Modalidade || 'Licença'} nº ${x.f.properties['Nº do documento'] || 's/ nº'} (${x.f.properties.Atividade || ''}) – ${rxData(x.f.properties.Validade) < hoje ? 'vencida em' : 'vence em'} ${x.f.properties.Validade}`, (v < hoje && hoje - v > 5 * 365 * 864e5) ? 'Verificar se a atividade continua; se sim, regularizar o licenciamento no IAT (SGA)' : 'Renovação da licença ambiental no IAT (SGA)'); });
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
        let [sigef, emb, alertas, outR, outU, lic, barr, mbac, mass] = await Promise.all([C.sigef, C.embargos, C.alertas, (C.outorgas || [])[0], (C.outorgas || [])[1], C.licencas, C.barragens, C.microbacias, C.massas].map(a => a ? rxJSON(a).catch(() => ({ features: [] })) : Promise.resolve({ features: [] })));
        let licV = (C.licencas ? C.licencas.replace('.geojson', '_vencidas.geojson') : null) ? await rxJSON(C.licencas ? C.licencas.replace('.geojson', '_vencidas.geojson') : null).catch(() => ({ features: [] })) : { features: [] };
        let vizinhos = cars.filter(f => f.properties.situacao !== 'Cancelado' && !f.properties.ficticio);
        if (p.ficticio && C.demo) {  // imóvel de exemplo: só as camadas fictícias, nada de dados reais de terceiros
            const dm = await rxJSON(C.demo), so = k => ({ features: dm.features.filter(f => f.properties.camada === k) }), vazio = { features: [] };
            vizinhos = so('car').features; sigef = so('sigef'); emb = vazio; alertas = vazio; outR = so('outorga'); outU = vazio;
            lic = so('licenca'); licV = vazio; barr = so('barragem'); mass = so('massa');
        }
        const r = {
            car: rxSobreposicoes(alvo, vizinhos, 0.05),
            sigef: rxSobreposicoes(alvo, sigef.features, 0.05),
            emb: rxSobreposicoes(alvo, emb.features, 0.0001),
            alertas: Object.values(rxSobreposicoes(alvo, alertas.features, 0.0001).reduce((m, x) => { const k = x.f.properties.nome; if (!m[k] || m[k].ha < x.ha) m[k] = x; return m; }, {})),
            agua: rxPontos(alvo, [...outR.features, ...outU.features]),
            lic: rxPontos(alvo, lic.features.concat(licV.features)),
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
        { const hj = new Date(), dt = v => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v || ''); return m ? new Date(+m[3], m[2] - 1, +m[1]) : null; };
          const no = x => `nº ${x.f.properties['Portaria / declaração'] || 's/ nº'} (${x.f.properties.Vencimento || 'sem data'})`;
          const ags = r.agua.dentro, venc = ags.filter(x => dt(x.f.properties.Vencimento) && dt(x.f.properties.Vencimento) < hj),
                breve = ags.filter(x => { const d = dt(x.f.properties.Vencimento); return d && d >= hj && (d - hj) / 864e5 <= 180; });
          if (venc.length) flags.push(['vermelho', `Outorga(s) vencida(s) no imóvel: ${venc.slice(0, 4).map(no).join('; ')}${venc.length > 4 ? ' …' : ''}`]);
          if (breve.length) flags.push(['amarelo', `Outorga(s) vencendo em até 6 meses: ${breve.slice(0, 4).map(no).join('; ')}${breve.length > 4 ? ' …' : ''}`]);
          const ok = ags.filter(x => !venc.includes(x) && !breve.includes(x));
          if (ok.length) flags.push(['verde', `${ok.length} outorga(s) vigente(s) no imóvel: ${ok.slice(0, 4).map(no).join('; ')}${ok.length > 4 ? ' …' : ''}`]); }
        { const RXA = /avicult|suinocult|bovinocult|bubalinocult|ovinocult|caprinocult|equinocult|cunicult|piscicult|aquicult|carcinicult|ranicult|cria[çc][ãa]o de (animais|aves|su[íi]nos|bovinos|frangos|peixes)|confinamento|leite|latic|abate|frigor|alimentos|bebida|f[ée]cula|amido|aguardente|cacha[çc]a|destilaria|usina|curtume|irriga|viveiro|hortali|cogumel|lavagem|lavador|beneficiamento/i, RXC = /capta|subterr|po[çc]o|insignific|uso independente/i;
          const la = (r.lic?.dentro || []).filter(x => !/substituída|^Vencida$/.test(x.f.properties.situacao || '') && RXA.test(`${x.f.properties.Atividade || ''} ${x.f.properties['Atividade específica'] || ''}`));
          if (la.length && !r.agua.dentro.some(x => RXC.test(`${x.f.properties.Interferência || ''} ${x.f.properties.Documento || ''} ${x.f.properties.grupo || ''}`)))
              flags.push(['amarelo', `Atividade licenciada com consumo de água (${la[0].f.properties.Atividade}) sem outorga de captação localizada no imóvel`]); }
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
        const B = {};
        B.uso = tab(['Classe', '% do imóvel', 'ha (aprox.)'], uso.map(([k, v]) => [esc(k), rxF(v, 1) + '%', rxF(v / 100 * area, 1)]));
        B.usoFonte = esc(((Object.keys(p).find(k => /^(MapBiomas|Uso do solo) \d{4}/.test(k)) || '').match(/^(MapBiomas \d{4}|Uso do solo \d{4})/) || [''])[0].replace('Uso do solo', 'Esri/Impact Observatory'));
        B.decl = tab(['Classe de relevo', '% do imóvel', 'ha (aprox.)'], r.decl.filter(d => d.pct >= 0.05).map(d => [d.nome, rxF(d.pct, 1) + '%', rxF(d.pct / 100 * area, 1)]));
        B.car = tab(['Nº', 'CAR', 'Situação', 'Sobreposição (ha)', '% do imóvel'], r.car.slice(0, 15).map((x, i) => [`<b>${i + 1}</b>`, `<span class="mono">${esc(x.f.properties.nome)}</span>`, esc(x.f.properties.situacao || ''), rxF(x.ha), (x.ha / area * 100 < 0.1 ? '< 0,1%' : rxF(x.ha / area * 100, 1) + '%')]));
        B.sigefCob = (() => { const cob = {}; r.sigef.forEach(x => { const k = rxSigefRot(x.f.properties); cob[k] = (cob[k] || [rxSigefCor(x.f.properties), 0]); cob[k][1] += x.ha; });
                const tot = Math.min(area, r.sigef.reduce((a, x) => a + x.ha, 0));
                return `<div class="rx-cob">${Object.entries(cob).map(([k, [c, ha]]) => `<span><i style="background:${c}"></i>${esc(k)}: <b>${rxF(Math.min(ha, area) / area * 100, 1)}%</b> (${rxF(ha, 1)} ha)</span>`).join('')}
                  <span><i style="background:#fff;border:1px solid #999"></i>Sem SIGEF: <b>${rxF(Math.max(0, area - tot) / area * 100, 1)}%</b></span></div>`; })();
        B.sigef = tab(['Nº', 'Parcela', 'Matrícula', 'Situação no registro', 'Sobre o imóvel (ha)'], r.sigef.slice(0, 15).map((x, i) => [`<b>${i + 1}</b>`, esc(x.f.properties.nome || ''), esc(x.f.properties['Matrícula / registro'] || ''), `<span class="rx-sw" style="background:${rxSigefCor(x.f.properties)}"></span>${esc(rxSigefRot(x.f.properties))}`, rxF(x.ha)]));
        B.emb = tab(['Embargo', 'Situação', 'Data', 'Dentro do imóvel (ha)'], r.emb.map(x => [esc(x.f.properties.nome), esc(x.f.properties['Situação'] || ''), esc(x.f.properties['Data do embargo'] || ''), rxF(x.ha, 3)]));
        B.alertas = tab(['Alerta', 'Detectado em', 'Vetor', 'Dentro do imóvel (ha)'], r.alertas.map(x => [esc(x.f.properties.nome), esc(x.f.properties['Detectado em'] || ''), esc(x.f.properties['Vetor'] || ''), rxF(x.ha, 2)]));
        B.outorgas = (() => { const lista = [...r.agua.dentro, ...r.agua.perto].slice(0, 12), linhas = pts(r.agua, 'Interferência', 'agua'), hoje = new Date();
                const venc = q => { const v = q.Vencimento || q['Validade'] || ''; const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v); if (!v) return '–';
                    if (!m) return esc(v); const d = new Date(+m[3], m[2] - 1, +m[1]), dias = (d - hoje) / 864e5;
                    return dias < 0 ? `<b style="color:#c62828">${esc(v)}<br>vencida</b>` : dias <= 180 ? `<b style="color:#e65100">${esc(v)}<br>vence em ${Math.ceil(dias)} dias</b>` : esc(v); };
                return tab(['Nº', 'Titular (SIGARH)', 'Tipo', 'Nº da outorga / declaração', 'Vencimento', 'Posição', 'Coordenadas (lat, long – SIRGAS 2000)'], linhas.map((l, i) => { const q = lista[i].f.properties;
                    return [l[0], l[1], l[2], `<span class="mono">${esc(q['Portaria / declaração'] || '–')}</span>${q.Documento ? `<br><span class="hint">${esc(q.Documento)}${q['Situação'] ? ' · ' + esc(q['Situação']) : ''}</span>` : ''}`, venc(q), l[3], l[4]]; })); })();
        B.licencas = C.licencas === null ? '' : (() => { if (!r.lic) return '<p class="hint">Camada de licenças não disponível neste município.</p>'; const lista = [...r.lic.dentro, ...r.lic.perto].slice(0, 12), linhas = pts(r.lic, 'Atividade', 'lic'), hoje = new Date();
                const venc = q => { const v = q.Validade || ''; const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v); if (!v) return '–'; if (!m) return esc(v); const d = new Date(+m[3], m[2] - 1, +m[1]), dias = (d - hoje) / 864e5;
                    return dias < 0 ? `<b style="color:#c62828">${esc(v)}<br>vencida</b>` : dias <= 180 ? `<b style="color:#e65100">${esc(v)}<br>vence em ${Math.ceil(dias)} dias</b>` : esc(v); };
                return tab(['Nº', 'Titular (SGA)', 'Atividade', 'Modalidade e nº do documento', 'Validade', 'Posição', 'Coordenadas (lat, long)'], linhas.map((l, i) => { const q = lista[i].f.properties;
                    return [l[0], l[1], l[2] + (q['Atividade específica'] && q['Atividade específica'] !== q.Atividade ? `<br><span class="hint">${esc(q['Atividade específica'])}</span>` : ''),
                        `${esc(q.Modalidade || '')}<br><span class="mono">nº ${esc(q['Nº do documento'] || '–')}</span>${q.link ? `<br><a href="${esc(q.link)}" target="_blank" rel="noopener">licença no SGA (PDF) ↗</a>` : ''}`, venc(q), l[3], l[4]]; })); })();
        B.barragens = (() => { const lista = [...r.barr.dentro, ...r.barr.perto].slice(0, 12); const linhas = pts(r.barr, 'Fonte', 'barr');
                return tab(['Nº', 'Barragem', 'Fonte', 'Risco / DPA', 'Uso · altura · volume', 'Posição', 'Coordenadas (lat, long)'], linhas.map((l, i) => { const q = lista[i].f.properties;
                    return [l[0], l[1] + (q.Empreendedor ? `<br><span class="hint">${esc(q.Empreendedor)}</span>` : ''), l[2], `${esc(q.risco || '–')} / ${esc(q.dpa || '–')}`,
                        esc([q['Uso principal'] || q['Finalidade (IAT)'], q['Altura (m)'] && q['Altura (m)'] + ' m', q['Volume (hm³)'] && q['Volume (hm³)'] + ' hm³'].filter(Boolean).join(' · ') || '–'), l[3], l[4]]; })); })();
        B.massas = tab(['Nº', 'Tipo', 'Espelho d\'água total (ha)', 'Dentro do imóvel (ha)', 'Barragem cadastrada', 'Centro (lat, long)'], r.massas.slice(0, 15).map((x, i) => { const q = x.f.properties, c = turf.pointOnFeature(x.f).geometry.coordinates;
                return [`<b>${i + 1}</b>`, esc(q.grupo), esc(q['Área (ha)']), rxF(Math.min(x.ha, rxNum(q['Área (ha)']) || x.ha), 2), x.barr ? `Sim – ${esc(x.barr.properties.nome)}` : (/artificial/.test(q.grupo) ? '<b>Não localizada</b>' : '–'),
                    `<span class="mono">${c[1].toFixed(5)}, ${c[0].toFixed(5)}</span>`]; }));
        const N = rxNecessidades(p, r, area, uso);
        B.resumo = rxResumoHtml(N);
        const html = `
            <div class="rx-cab"><div><div class="mono rx-cod">${esc(nome)}</div>
              <div class="hint">${esc(p['Status do CAR'] || '')} · ${esc(p.situacao || '')} · ${esc(p.Tipo || '')}</div></div>
              <div class="rx-area"><b>${rxF(area)}</b> ha<br><span class="hint">${esc(p['Módulos fiscais'] || '–')} módulos fiscais</span></div></div>
            ${p.ficticio ? `<p class="rx-ficticio">⚠️ IMÓVEL FICTÍCIO – exemplo criado só para demonstração. Os dados deste relatório não correspondem a nenhum imóvel ou pessoa real.</p>` : ''}<ul class="rx-flags">${flags.map(([c, t]) => `<li class="rx-${c}">${esc(t)}</li>`).join('')}</ul>
            ${pend.length ? `<h3>Pendências apontadas no mapa</h3><ul>${pend.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
            <h3>Uso e cobertura do solo (${B.usoFonte})</h3>${B.uso}
            <h3>Declividade (Copernicus DEM, classes Embrapa)</h3>${B.decl}
            <h3>Sobreposição com outros imóveis do CAR</h3>${B.car}
            <h3>Imóveis certificados no SIGEF/INCRA</h3>${B.sigefCob}${B.sigef}
            <h3>Embargos do IBAMA</h3>${B.emb}
            <h3>Alertas de desmatamento (MapBiomas Alerta)</h3>${B.alertas}
            <h3>Outorgas de água no imóvel ou a até 500 m</h3>${B.outorgas}
            ${C.licencas === null ? '' : `<h3>Licenças ambientais (IAT – SGA/SIA) no imóvel ou a até 500 m</h3>${B.licencas}`}
            <h3>Barragens cadastradas (SNISB/ANA e IAT) no imóvel ou a até 500 m</h3>${B.barragens}
            <h3>Açudes, represas e lagos no imóvel (ANA)</h3>${B.massas}
            ${B.resumo}
            <p class="hint">Microbacia: ${esc(r.mbac[0] || '–')} · Dados do mapa atualizados em ${esc(dadosGerais.atualizado_em || '')}.</p>
            <p class="hint rx-aviso">Análise automática feita sobre bases públicas (SICAR, INCRA/SIGEF, IBAMA, MapBiomas, IAT/SIGARH/SGA, ANA/SNISB, Copernicus). As áreas são aproximadas e não substituem vistoria, levantamento topográfico ou consulta oficial aos órgãos.</p>`;
        corpo.innerHTML = html;
        RX.itr = RX.itr || {};
        RX.ultimo = { nome, html, codigo, quando, alvo, viz: r.car, sigef: r.sigef, pontos: pontosFoto, p, r, area, uso, flags, N, pend, B, C, itr: (RX.itr || {})[nome] || null };
        rxMostrarItr();
        itrPrevia(RX.ultimo).then(pv => { if (RX.ultimo && RX.ultimo.nome === nome) { RX.ultimo.previa = pv; rxMostrarItr(); } }).catch(e => console.error('prévia ITR', e));
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
    if (!u.previa) { try { u.previa = await itrPrevia(u); } catch (e) { console.error(e); } }
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
    map.jumpTo({ center: centro, zoom });
    const janela = { partes: [rxRelatorioHtml(u, { foto, foto2, foto3, foto4 })] };
    const url = URL.createObjectURL(new Blob(janela.partes, { type: 'text/html;charset=utf-8' }));
    const nomeArq = `raio-x_${u.nome}.html`;
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

// ---------- relatório no formato "laudo" (capa, cabeçalho e rodapé fixos, checklist com selos, metodologia) ----------
const RX_ST = { ok: ['✓', 'Em acordo', 'ok'], at: ['!', 'Atenção', 'at'], no: ['✕', 'Em desacordo', 'no'], na: ['–', 'Não se aplica', 'na'] };
function rxChecklist(u) {
    const { p, r, area, uso } = u, G = [], hoje = new Date(), d6 = 180 * 864e5;
    const grupo = (nome) => { const g = { nome, itens: [] }; G.push(g); return (ind, st, det = '') => g.itens.push({ ind, st, det }); };
    const dt = v => rxData(v);
    // AMBIENTAL
    let add = grupo('Ambiental');
    const embAt = r.emb.filter(x => x.f.properties['Situação'] !== 'Desembargado');
    add('Embargos do IBAMA (área)', embAt.length ? 'no' : r.emb.length ? 'at' : 'ok',
        r.emb.map(x => `${x.f.properties.nome} – ${x.f.properties['Situação'] || ''}, ${rxF(x.ha, 2)} ha no imóvel`).join('; '));
    add('Alertas de desmatamento (MapBiomas Alerta)', r.alertas.length ? 'no' : 'ok',
        r.alertas.map(x => `${x.f.properties.nome}: ${rxF(x.ha, 2)} ha, detectado em ${x.f.properties['Detectado em'] || '–'}`).join('; '));
    const nat = uso.find(([k]) => /Vegetação (nativa|arbórea)/.test(k)), pv = nat ? nat[1] : (p.veg_nativa_pct ?? null), mf = rxNum(p['Módulos fiscais']);
    add('Reserva Legal – vegetação nativa ≥ 20% (PR)', pv === null ? 'na' : pv >= 20 ? 'ok' : mf <= 4 ? 'at' : 'no',
        pv === null ? 'Sem dado de cobertura para o imóvel' : `Vegetação ${nat && /arbórea/.test(nat[0]) ? 'arbórea' : 'nativa'}: ${rxF(pv, 1)}% (${rxF(pv / 100 * area, 1)} ha); mínimo de 20% = ${rxF(area * 0.2, 1)} ha` + (pv < 20 && mf <= 4 ? ' – imóvel até 4 módulos fiscais: verificar art. 67 do Código Florestal' : ''));
    const mont = (r.decl[4] || {}).pct || 0, forte = r.decl.slice(3).reduce((a, d) => a + d.pct, 0);
    add('Encostas acima de 45% (APP / uso restrito)', mont >= 0.5 ? 'at' : 'ok', mont >= 0.5 ? `${rxF(mont, 1)}% do imóvel` : '');
    add('Relevo forte ondulado (≥ 20%) – conservação do solo', forte >= 15 ? 'at' : 'ok', forte >= 1 ? `${rxF(forte, 1)}% do imóvel` : '');
    // FUNDIÁRIO / CAR
    add = grupo('CAR e situação fundiária');
    const sit = p.situacao || '';
    add('Situação do CAR', /Cancelado/i.test(sit) || /pendente/i.test(sit) ? 'no' : /Aguardando|Em análise/i.test(sit) ? 'at' : 'ok', [p['Status do CAR'], sit].filter(Boolean).join(' · '));
    const maior = r.car[0];
    add('Sobreposição com outros imóveis do CAR', maior && maior.ha >= Math.max(1, area * 0.02) ? 'no' : 'ok',
        r.car.length ? `${r.car.length} imóvel(is); maior sobreposição ${rxF(maior.ha)} ha (${rxF(maior.ha / area * 100, 1)}%)` : 'Nenhuma');
    const cobS = Math.min(area, r.sigef.reduce((a, x) => a + x.ha, 0)) / area;
    add('Georreferenciamento certificado (SIGEF/INCRA)', cobS >= 0.9 ? 'ok' : cobS >= 0.5 ? 'at' : mf > 4 ? 'no' : 'at', `${rxF(cobS * 100, 0)}% do imóvel coberto por parcelas certificadas`);
    const semReg = r.sigef.filter(x => x.f.properties['Situação'] && x.f.properties['Situação'] !== 'Registrada');
    add('Registro da certificação em cartório', !r.sigef.length ? 'na' : semReg.length ? 'at' : 'ok', semReg.length ? `${semReg.length} parcela(s) sem registro` : '');
    // ÁGUA
    add = grupo('Recursos hídricos');
    const ag = r.agua.dentro, venc = ag.filter(x => dt(x.f.properties.Vencimento) && dt(x.f.properties.Vencimento) < hoje),
          breve = ag.filter(x => { const d = dt(x.f.properties.Vencimento); return d && d >= hoje && d - hoje <= d6; });
    add('Outorgas de uso da água no imóvel (SIGARH)', !ag.length ? 'na' : venc.length ? 'no' : breve.length ? 'at' : 'ok',
        ag.length ? ag.slice(0, 6).map(x => `nº ${x.f.properties['Portaria / declaração'] || 's/ nº'} – ${(x.f.properties.Interferência || 'outorga').toLowerCase()}, vence ${x.f.properties.Vencimento || '–'}`).join('; ') : 'Nenhuma outorga localizada dentro do imóvel');
    const RXA = /avicult|suinocult|bovinocult|bubalinocult|ovinocult|caprinocult|equinocult|cunicult|piscicult|aquicult|carcinicult|ranicult|cria[çc][ãa]o de (animais|aves|su[íi]nos|bovinos|frangos|peixes)|confinamento|leite|latic|abate|frigor|alimentos|bebida|f[ée]cula|amido|aguardente|cacha[çc]a|destilaria|usina|curtume|irriga|viveiro|hortali|cogumel|lavagem|lavador|beneficiamento/i, RXC = /capta|subterr|po[çc]o|insignific|uso independente/i;
    const la = (r.lic?.dentro || []).filter(x => !/substituída|^Vencida$/.test(x.f.properties.situacao || '') && RXA.test(`${x.f.properties.Atividade || ''} ${x.f.properties['Atividade específica'] || ''}`));
    const capta = ag.some(x => RXC.test(`${x.f.properties.Interferência || ''} ${x.f.properties.Documento || ''} ${x.f.properties.grupo || ''}`));
    add('Atividade licenciada com consumo de água × outorga de captação', !la.length ? 'na' : capta ? 'ok' : 'no', la.length ? `${la[0].f.properties.Atividade}${capta ? ' – outorga de captação localizada' : ' – sem outorga de captação no imóvel'}` : '');
    const pnsb = r.barr.dentro.filter(x => /^sim/i.test(x.f.properties['Regulada pela PNSB'] || '') && /^n[ãa]o/i.test(x.f.properties['Plano de segurança'] || '')), alto = r.barr.dentro.filter(x => x.f.properties.risco === 'Alto');
    add('Segurança de barragens (Lei 12.334/2010)', !r.barr.dentro.length ? 'na' : pnsb.length ? 'no' : alto.length ? 'at' : 'ok', r.barr.dentro.length ? `${r.barr.dentro.length} barragem(ns) no imóvel${alto.length ? `, ${alto.length} de risco alto` : ''}${pnsb.length ? `, ${pnsb.length} sem Plano de Segurança` : ''}` : '');
    const art = r.massas.filter(x => /artificial/.test(x.f.properties.grupo)), sem = art.filter(x => !x.barr);
    add('Açudes e represas com barragem cadastrada (SNISB/IAT)', !art.length ? 'na' : sem.length ? 'at' : 'ok', art.length ? `${art.length} espelho(s) d'água artificial(is); ${sem.length} sem barragem localizada` : '');
    // LICENCIAMENTO
    add = grupo('Licenciamento ambiental');
    const lic = (r.lic?.dentro || []).filter(x => !/substituída/.test(x.f.properties.situacao || ''));
    const lv = lic.filter(x => { const v = dt(x.f.properties.Validade); return v && v < hoje && hoje - v <= 5 * 365 * 864e5; }), lb = lic.filter(x => { const v = dt(x.f.properties.Validade); return v && v >= hoje && v - hoje <= d6; });
    add('Licenças ambientais no imóvel (IAT – SGA/SIA)', u.C.licencas === null || !r.lic ? 'na' : !lic.length ? 'na' : lv.length ? 'no' : lb.length ? 'at' : 'ok',
        lic.length ? lic.slice(0, 5).map(x => `${x.f.properties.Modalidade || 'Licença'} nº ${x.f.properties['Nº do documento'] || 's/ nº'} – ${x.f.properties.Atividade || ''}, validade ${x.f.properties.Validade || '–'}`).join('; ') : 'Nenhuma licença localizada dentro do imóvel');
    if (u.itr) G.push(itrChecklist(u));
    const gp = itrPrevChecklist(u); if (gp) G.push(gp);
    return G;
}
function rxRelatorioHtml(u, F) {
    const { p, r, area, uso } = u, G = rxChecklist(u), N = [...u.N.filter(n => n.tema !== 'Vistoria'), ...(u.itr ? itrPendencias(u) : []), ...itrPrevPendencias(u), ...u.N.filter(n => n.tema === 'Vistoria')].sort((a, b) => a.prior - b.prior);
    const dataHora = u.quando.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const mun = (u.C.municipio || ((dadosGerais.cliente || {}).nome || '').replace(/^.*– */, '')) || '–';
    const cod = (String(u.C.car || '').match(/data\/m\/(\d{7})\//) || [])[1];
    const link = `${location.origin}${location.pathname}?${cod ? `m=${cod}&` : ''}car=${encodeURIComponent(u.nome)}`;
    const qr = (txt, px) => { try { const q = qrcode(0, 'M'); q.addData(txt); q.make(); return q.createSvgTag({ cellSize: Math.max(2, Math.round(px / (q.getModuleCount() + 8))), margin: 4, scalable: true }); } catch (e) { return ''; } };
    const todos = G.flatMap(g => g.itens), cont = k => todos.filter(i => i.st === k).length;
    const avaliados = todos.filter(i => i.st !== 'na').length, emAcordo = cont('ok');
    const nat = uso.find(([k]) => /Vegetação (nativa|arbórea)/.test(k)), pv = nat ? nat[1] : (p.veg_nativa_pct ?? null);
    const cobS = Math.min(area, r.sigef.reduce((a, x) => a + x.ha, 0)) / area;
    const decl = rxNum(p['Área (ha)']);
    const card = (rot, val, sub = '') => `<div class="cd"><span>${rot}</span><b>${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
    const selo = st => `<span class="selo ${RX_ST[st][2]}">${RX_ST[st][0]} ${RX_ST[st][1]}</span>`;
    const barras = (lst, cor) => lst.map(([k, v]) => `<div class="br"><span>${esc(k)}</span><i><em style="width:${Math.min(100, v)}%;background:${cor(k)}"></em></i><b>${rxF(v, 1)}%</b></div>`).join('');
    const corUso = k => /arbórea|nativa|Floresta|Vegeta/i.test(k) ? '#2e7d32' : /Agricult|Lavoura|Soja/i.test(k) ? '#f9a825' : /Pastagem|Campo|Pasto/i.test(k) ? '#c0ca33' : /Água|Agua/i.test(k) ? '#1e88e5' : /urban|Constru/i.test(k) ? '#e53935' : '#8d6e63';
    const corDecl = k => ({ 'Plano (0–3%)': '#cfe8c3', 'Suave ondulado (3–8%)': '#d9f0a3', 'Ondulado (8–20%)': '#fed976', 'Forte ondulado (20–45%)': '#f03b20', 'Montanhoso (> 45%)': '#800026' }[k] || '#999');
    const ROT = { 1: ['Alta', '#c62828'], 2: ['Média', '#ef6c00'], 3: ['Baixa', '#558b2f'] };
    const legSob = `<div class="leg"><span style="background:#b9f6ca;border:2px solid #ff1744"></span>imóvel analisado <span style="border:2px dashed #e6c800"></span>vizinhos com sobreposição (nº da tabela) <span style="background:#ff9100"></span>área sobreposta</div>`;
    const legSig = `<div class="leg"><span style="border:3px solid #ff1744"></span>imóvel (CAR) ${Object.values(RX_SIGEF).map(([c, t]) => `<span style="background:${c}"></span>${t}`).join(' ')}</div>`;
    const legPt = `<div class="leg"><span style="background:#b9f6ca;border:2px solid #ff1744"></span>imóvel <span style="background:#1e88e5;border-radius:50%"></span>outorga <span style="background:#8e24aa;border-radius:50%"></span>licença <span style="background:#00897b;border-radius:50%"></span>barragem – nº = linhas das tabelas</div>`;
    const sec = (titulo, sub, corpo, quebra = true) => `<section class="${quebra ? 'pg' : ''}"><div class="st"><i></i><div><h2>${titulo}</h2>${sub ? `<p>${sub}</p>` : ''}</div></div>${corpo}</section>`;
    const tabela = (titulo, corpo) => `<h4>${titulo}</h4>${corpo}`;
    const logo = new URL('logo.png', location.href).href;
    const cs = dadosGerais.cs_contato || {};
    const contato = [cs.site, cs.telefone, cs.email].filter(Boolean).map(esc).join('  ·  ');
    const blocoCS = `<div class="csb"><img src="${logo}" alt="CS Consultoria Ambiental"><div><b>CS Consultoria Ambiental</b><br><span>Diagnóstico Ambiental Rural · regularização ambiental, fundiária e de recursos hídricos</span>${contato ? `<br><span>${contato}</span>` : ''}${cs.responsavel ? `<br><span>Responsável técnico: ${esc(cs.responsavel)}</span>` : ''}</div></div>`;
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Raio-X do imóvel rural – ${esc(u.nome)}</title>
<style>
 @page { size: A4; margin: 22mm 14mm 20mm;
   @top-left { content: "CS Consultoria Ambiental  ·  RAIO-X DO IMÓVEL RURAL"; font: 600 8pt Arial; color: #1f4933; }
   @top-right { content: "${esc(dataHora)}   ·   Página " counter(page) " de " counter(pages); font: 8pt Arial; color: #5f6d66; }
   @bottom-left { content: "Código de conferência ${u.codigo}"; font: 8pt Consolas, monospace; color: #5f6d66; }
   @bottom-right { content: "Análise automática sobre bases públicas – não substitui vistoria"; font: 7.5pt Arial; color: #8a978f; } }
 @page :first { margin: 0; @top-left { content: none } @top-right { content: none } @bottom-left { content: none } @bottom-right { content: none } }
 * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
 body { font-family: Inter, 'Segoe UI', Arial, sans-serif; color: #1d2a24; margin: 0; font-size: 10.5pt; line-height: 1.45; background: #e9eeeb; }
 .folha { max-width: 210mm; margin: 0 auto; background: #fff; }
 .marca { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: 0; }
 .marca img { width: 62%; opacity: .05; }
 section, .capa { position: relative; z-index: 1; }
 .pg { break-before: page; padding: 6mm 0 0; }
 @media screen { .pg { padding: 14mm 14mm 8mm; border-top: 10px solid #e9eeeb; } .marca { display: none; } }
 .capa { height: 297mm; color: #fff; display: flex; flex-direction: column; padding: 18mm 16mm 14mm; overflow: hidden;
   background: linear-gradient(160deg, rgba(20,46,32,.93), rgba(31,73,51,.80) 55%, rgba(20,46,32,.96)), ${F.foto ? `url(${F.foto}) center/cover` : '#1f4933'}; }
 .capa .topo { display: flex; justify-content: space-between; align-items: center; }
 .capa .topo img { height: 52px; background: #fff; border-radius: 10px; padding: 6px 10px; }
 .capa .data { background: rgba(0,0,0,.35); border-radius: 999px; padding: 6px 14px; font-size: 10pt; }
 .capa .meio { margin-top: auto; margin-bottom: auto; }
 .capa .kick { letter-spacing: .3em; font-size: 9.5pt; font-weight: 700; color: #83bb4e; }
 .capa h1 { font-size: 46pt; line-height: 1; margin: 8px 0 6px; font-weight: 800; } .capa h1 span { color: #83bb4e; display: block; }
 .capa .sub { font-size: 13pt; opacity: .9; }
 .capa .faixa { display: grid; grid-template-columns: 1fr 2fr 1fr auto; gap: 14px; align-items: center; background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.25); border-radius: 14px; padding: 12px 16px; }
 .capa .faixa span { display: block; font-size: 8pt; opacity: .75; text-transform: uppercase; letter-spacing: .08em; } .capa .faixa b { font-size: 10.5pt; word-break: break-all; }
 .capa .qr { background: #fff; border-radius: 8px; padding: 4px; width: 92px; height: 92px; } .capa .qr svg { width: 100%; height: 100%; }
 .capa .fict { margin-top: 10px; background: #ff8f00; color: #1d1d1d; font-weight: 700; border-radius: 8px; padding: 8px 12px; text-align: center; }
 .st { display: flex; gap: 10px; align-items: center; margin: 0 0 10px; } .st i { width: 6px; height: 34px; border-radius: 3px; background: linear-gradient(#83bb4e, #1f4933); }
 .st h2 { margin: 0; font-size: 15pt; color: #1f4933; } .st p { margin: 0; color: #5f6d66; font-size: 9pt; }
 h4 { margin: 14px 0 6px; font-size: 10.5pt; color: #1f4933; }
 .cds { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 6px 0 10px; }
 .cd { border: 1px solid #dfe8e2; border-radius: 10px; padding: 8px 10px; background: #fafcfb; } .cd span { display: block; font-size: 7.5pt; text-transform: uppercase; letter-spacing: .06em; color: #6b7a72; }
 .cd b { display: block; font-size: 12.5pt; color: #1d2a24; margin-top: 2px; word-break: break-all; } .cd small { color: #6b7a72; font-size: 8.5pt; }
 .cds.n4 { grid-template-columns: repeat(4, 1fr); } .cds.n4 .cd b { font-size: 16pt; color: #1f4933; }
 .placar { display: grid; grid-template-columns: 1.2fr repeat(3, 1fr); gap: 8px; margin: 6px 0 12px; }
 .placar div { border-radius: 10px; padding: 10px; text-align: center; } .placar b { display: block; font-size: 20pt; } .placar span { font-size: 8.5pt; }
 .placar .g { background: #1f4933; color: #fff; } .placar .ok { background: #e7f5ec; color: #1b6b3a; } .placar .at { background: #fff6dd; color: #8a5a00; } .placar .no { background: #fdecea; color: #b71c1c; }
 .ck { width: 100%; border-collapse: collapse; margin-bottom: 10px; } .ck caption { background: #eef6e6; color: #1f4933; font-weight: 700; font-size: 9pt; letter-spacing: .12em; text-transform: uppercase; padding: 6px; border-radius: 6px; }
 .ck th { font-size: 7.5pt; color: #6b7a72; text-align: left; text-transform: uppercase; letter-spacing: .06em; padding: 6px 4px; border-bottom: 1px solid #dfe8e2; } .ck th:last-child, .ck td:last-child { text-align: right; width: 32%; }
 .ck td { padding: 7px 4px; border-bottom: 1px solid #eef2ef; vertical-align: top; } .ck tr { break-inside: avoid; }
 .ck .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; vertical-align: 1px; }
 .ck .det { display: block; color: #5f6d66; font-size: 8.5pt; margin: 3px 0 0 16px; }
 .selo { display: inline-block; font-size: 8pt; font-weight: 700; border-radius: 999px; padding: 2px 9px; white-space: nowrap; }
 .selo.ok { background: #e7f5ec; color: #1b6b3a; } .selo.at { background: #fff3d6; color: #8a5a00; } .selo.no { background: #fdecea; color: #b71c1c; } .selo.na { background: #eef1ef; color: #7b8781; }
 .dot.ok { background: #2e7d32; } .dot.at { background: #f9a825; } .dot.no { background: #c62828; } .dot.na { background: #b0bab4; }
 .dk { width: 100%; border-collapse: collapse; border-radius: 10px; overflow: hidden; margin: 6px 0; font-size: 9.5pt; } .dk th { background: #1d2a24; color: #fff; text-align: left; padding: 7px 8px; font-size: 8pt; text-transform: uppercase; letter-spacing: .05em; }
 .dk td { padding: 7px 8px; border-bottom: 1px solid #e5ebe7; } .dk .def { color: #c62828; font-weight: 700; } .dk .bom { color: #1b6b3a; font-weight: 700; }
 .br { display: grid; grid-template-columns: 38% 1fr 54px; gap: 8px; align-items: center; margin: 4px 0; font-size: 9pt; } .br i { height: 10px; background: #eef2ef; border-radius: 5px; overflow: hidden; } .br em { display: block; height: 100%; border-radius: 5px; } .br b { text-align: right; }
 .duas { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
 img.mapa { width: 100%; border-radius: 10px; border: 1px solid #cfd8d3; margin: 4px 0 2px; } .leg { font-size: 8pt; color: #5f6d66; margin-bottom: 6px; }
 .leg span { display: inline-block; width: 12px; height: 9px; border-radius: 2px; margin: 0 3px -1px 8px; }
 .rx-tab, table.rx-tab { width: 100%; border-collapse: collapse; font-size: 8.5pt; } .rx-tab th { background: #f3f7f4; text-align: left; padding: 5px; } .rx-tab td { border-bottom: 1px solid #e5ebe7; padding: 4px 5px; vertical-align: top; } .rx-tab tr { break-inside: avoid; }
 .rx-cob { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 4px 0 8px; font-size: 9pt; } .rx-cob i, .rx-sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
 .mono { font-family: Consolas, monospace; } .hint { color: #5f6d66; font-size: 8.5pt; } a { color: #1f4933; }
 .obs { border: 1px solid #dfe8e2; border-left: 4px solid #83bb4e; border-radius: 8px; padding: 8px 10px; margin: 6px 0; font-size: 9pt; background: #fafcfb; }
 .fonte { display: grid; grid-template-columns: 30% 1fr; gap: 4px 12px; font-size: 9pt; } .fonte b { color: #1f4933; }
 .valida { display: flex; gap: 14px; align-items: center; border: 1px solid #dfe8e2; border-radius: 10px; padding: 10px; margin-top: 12px; } .valida .qr { width: 96px; height: 96px; } .valida .qr svg { width: 100%; height: 100%; }
 .csb { display: flex; gap: 14px; align-items: center; border-top: 3px solid #83bb4e; margin-top: 14px; padding-top: 10px; font-size: 9pt; color: #1f4933; } .csb img { height: 46px; } .csb span { color: #5f6d66; }
 .itr-cds { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 6px 0 8px; } .itr-cds div { border: 1px solid #dfe8e2; border-radius: 10px; padding: 8px 10px; background: #fafcfb; }
 .itr-cds span { display: block; font-size: 7.5pt; text-transform: uppercase; letter-spacing: .06em; color: #6b7a72; } .itr-cds b { font-size: 13pt; color: #1f4933; }
 .itr-duas { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
 .dk.rx-tab th { background: #1d2a24; color: #fff; }
 .noprint { text-align: center; padding: 14px; } .noprint button { padding: 10px 20px; font-size: 14px; background: #1f4933; color: #fff; border: 0; border-radius: 8px; cursor: pointer; }
 @media print { body { background: #fff; } .noprint { display: none; } h4 { break-after: avoid; } img.mapa { break-inside: avoid; max-height: 125mm; object-fit: cover; } }
</style></head><body>
<p class="noprint"><button onclick="window.print()">Salvar em PDF / imprimir</button> <span class="hint">Use "Salvar como PDF", papel A4, com "Gráficos de fundo" ligado.</span></p>
<div class="marca"><img src="${logo}" alt=""></div>
<div class="folha">
<div class="capa">
  <div class="topo"><img src="${logo}" alt="CS Consultoria Ambiental"><span class="data">${esc(dataHora)}</span></div>
  <div class="meio"><div class="kick">DIAGNÓSTICO AMBIENTAL RURAL · CONSULTA AUTOMÁTICA</div><h1>Raio-X do<span>Imóvel Rural</span></h1>
    <div class="sub">Consulta automática a ${todos.length} indicadores em bases públicas oficiais · ${esc(mun)}</div></div>
  <div class="faixa"><div><span>Emitido por</span><b>CS Consultoria Ambiental</b></div><div><span>CAR</span><b class="mono">${esc(u.nome)}</b></div>
    <div><span>Área total</span><b>${rxF(area)} ha</b></div><div class="qr">${qr(link, 92)}</div></div>
  ${p.ficticio ? '<div class="fict">IMÓVEL FICTÍCIO – exemplo criado só para demonstração. Não corresponde a nenhum imóvel ou pessoa real.</div>' : ''}
</div>

${sec('Detalhes do imóvel', 'Informações cadastrais e localização', `
  <div class="cds">${card('CAR', `<span class="mono" style="font-size:9pt">${esc(u.nome)}</span>`)}${card('Status do CAR', esc(p['Status do CAR'] || '–'))}${card('Condição', esc(p.situacao || p['Condição'] || '–'))}
  ${card('Data de cadastro / atualização', esc(p['Data de cadastro/atualização'] || '–'))}${card('Área calculada', `${rxF(area)} ha`, decl ? `declarada: ${rxF(decl)} ha` : '')}${card('Módulos fiscais', esc(p['Módulos fiscais'] || '–'), esc(p.Porte || ''))}
  ${card('Município', esc(mun))}${card('Microbacia', esc(r.mbac[0] || '–'))}${card('Tipo', esc(p.Tipo || '–'))}</div>
  ${F.foto ? `<img class="mapa" src="${F.foto}" alt="Localização"><div class="leg">Perímetro do imóvel (vermelho) sobre imagem de satélite (Esri World Imagery).</div>` : ''}`)}

${sec('Resultado da análise', 'Resumo dos indicadores consultados', `
  <div class="placar"><div class="g"><b>${emAcordo}/${avaliados}</b><span>indicadores em acordo</span></div><div class="ok"><b>${cont('ok')}</b><span>✓ em acordo</span></div><div class="at"><b>${cont('at')}</b><span>! atenção</span></div><div class="no"><b>${cont('no')}</b><span>✕ em desacordo</span></div></div>
  <div class="cds n4">${card('Vegetação nativa', pv === null ? '–' : rxF(pv, 1) + '%', pv === null ? '' : `${rxF(pv / 100 * area, 1)} ha`)}${card('Certificação SIGEF', rxF(cobS * 100, 0) + '%', 'da área do imóvel')}${card('Outorgas no imóvel', String(r.agua.dentro.length), 'SIGARH/IAT')}${card('Licenças no imóvel', String((r.lic?.dentro || []).length), 'SGA/SIA – IAT')}</div>
  ${G.map(g => `<table class="ck"><caption>${g.nome}</caption><tr><th>Indicador</th><th>Status</th></tr>${g.itens.map(i => `<tr><td><span class="dot ${RX_ST[i.st][2]}"></span>${esc(i.ind)}${i.det ? `<span class="det">${esc(i.det)}</span>` : ''}</td><td>${selo(i.st)}</td></tr>`).join('')}</table>`).join('')}`)}

${sec('Cobertura do solo e relevo', 'Declarado no CAR × medido por satélite', `
  <table class="dk"><tr><th>Informação</th><th>Declarado / referência</th><th>Medido no perímetro</th><th>Análise automática</th></tr>
   <tr><td>Área do imóvel</td><td>${decl ? rxF(decl) + ' ha' : '–'}</td><td>${rxF(area)} ha</td><td class="${decl && Math.abs(area - decl) / decl > .05 ? 'def' : 'bom'}">${decl ? (Math.abs(area - decl) / decl > .05 ? `Diferença de ${rxF(area - decl)} ha (${rxF((area - decl) / decl * 100, 1)}%)` : 'Compatível') : '–'}</td></tr>
   <tr><td>Reserva Legal (mín. 20%)</td><td>${rxF(area * .2, 1)} ha</td><td>${pv === null ? '–' : rxF(pv / 100 * area, 1) + ' ha de vegetação'}</td><td class="${pv !== null && pv < 20 ? 'def' : 'bom'}">${pv === null ? '–' : pv < 20 ? `Déficit: ${rxF((20 - pv) / 100 * area, 1)} ha` : 'Atende'}</td></tr>
   <tr><td>Sobreposição com outros CAR</td><td>0 ha</td><td>${rxF(r.car.reduce((a, x) => a + x.ha, 0))} ha</td><td class="${r.car[0] && r.car[0].ha >= Math.max(1, area * .02) ? 'def' : 'bom'}">${r.car[0] && r.car[0].ha >= Math.max(1, area * .02) ? 'Sobreposição relevante' : 'Só ajustes de divisa'}</td></tr></table>
  <div class="duas"><div><h4>Uso e cobertura do solo (${u.B.usoFonte})</h4>${barras(uso, corUso)}</div><div><h4>Declividade (Copernicus DEM, classes Embrapa)</h4>${barras(r.decl.filter(d => d.pct >= .05).map(d => [d.nome, d.pct]), corDecl)}</div></div>
  ${(u.pend || []).length ? `<h4>Observações do cadastro</h4>${u.pend.map(t => `<div class="obs">${esc(t)}</div>`).join('')}` : ''}`)}

${u.itr ? sec(`Declaração do ITR${u.itr.exercicio ? ` – exercício ${u.itr.exercicio}` : ''}`, 'Dados quantitativos da DIAC/DIAT (Receita Federal) cruzados com o CAR e o satélite', itrBlocoHtml(u, true) + (u.previa ? `<h4>Declarado × estimado por satélite</h4>${itrComparacaoHtml(u)}` : '')) : ''}
${u.previa ? sec(u.itr ? 'Prévia do ITR – base da comparação' : 'Prévia do ITR (estimativa por satélite)', u.itr ? 'Como cada valor estimado foi calculado' : 'O que o imóvel deveria declarar, estimado sem a declaração oficial', itrPreviaHtml(u)) : ''}

${sec('Situação fundiária', 'Sobreposições com o CAR e certificação no SIGEF/INCRA', `
  ${F.foto2 ? `<img class="mapa" src="${F.foto2}" alt="Sobreposições">${legSob}` : ''}${tabela('Sobreposição com outros imóveis do CAR', u.B.car)}
  ${F.foto3 ? `<img class="mapa" src="${F.foto3}" alt="SIGEF">${legSig}` : ''}${tabela('Parcelas certificadas no SIGEF/INCRA', u.B.sigefCob + u.B.sigef)}
  ${tabela('Embargos do IBAMA', u.B.emb)}${tabela('Alertas de desmatamento (MapBiomas Alerta)', u.B.alertas)}`)}

${sec('Água e licenciamento', 'Outorgas, licenças, barragens e açudes no imóvel ou a até 500 m', `
  ${F.foto4 ? `<img class="mapa" src="${F.foto4}" alt="Outorgas e licenças">${legPt}` : ''}
  ${tabela('Outorgas de uso da água (SIGARH/IAT)', u.B.outorgas)}${u.C.licencas === null ? '' : tabela('Licenças ambientais (IAT – SGA/SIA)', u.B.licencas)}
  ${tabela('Barragens cadastradas (SNISB/ANA e IAT)', u.B.barragens)}${tabela('Açudes, represas e lagos (ANA)', u.B.massas)}`)}

${sec('Pendências e adequações sugeridas', 'Base para o plano de regularização e o orçamento', `
  <div class="placar">${[1, 2, 3].map(k => `<div style="background:${ROT[k][1]}1a;color:${ROT[k][1]}"><b>${N.filter(n => n.prior === k).length}</b><span>prioridade ${ROT[k][0].toLowerCase()}</span></div>`).join('')}<div class="g"><b>${N.length}</b><span>itens no total</span></div></div>
  <table class="rx-tab"><tr><th>Nº</th><th>Prioridade</th><th>Tema</th><th>Situação encontrada</th><th>Adequação / serviço sugerido</th></tr>
  ${N.map((n, i) => `<tr><td><b>${i + 1}</b></td><td><span class="rx-sw" style="background:${ROT[n.prior][1]}"></span>${ROT[n.prior][0]}</td><td>${esc(n.tema)}</td><td>${esc(n.achado)}</td><td>${esc(n.adequacao)}</td></tr>`).join('')}</table>
  <p class="hint">Lista indicativa. Itens e quantidades devem ser confirmados em vistoria de campo e conferência documental (matrícula, CCIR, ITR, CAR).</p>
  <div class="obs"><b>Próximo passo com a CS:</b> vistoria técnica e Diagnóstico Ambiental Rural completo, com plano de adequação priorizado e orçamento por item.</div>${blocoCS}`)}

${sec('Metodologia e fontes', 'Como esta análise foi feita', `
  <p>O perímetro do imóvel declarado no CAR é cruzado automaticamente com as camadas públicas abaixo. Áreas são calculadas sobre o elipsoide (WGS84/SIRGAS 2000) e são aproximadas. Pontos (outorgas, licenças, barragens) são considerados dentro do imóvel ou a até 500 m do perímetro.</p>
  <div class="fonte">
   <b>CAR – SICAR</b><span>Perímetro, situação, módulos fiscais e sobreposições entre imóveis (Serviço Florestal Brasileiro).</span>
   <b>SIGEF / INCRA</b><span>Parcelas georreferenciadas certificadas e situação no registro de imóveis.</span>
   <b>IBAMA</b><span>Áreas embargadas (situação e data do embargo).</span>
   <b>MapBiomas Alerta</b><span>Alertas de desmatamento validados, com data de detecção.</span>
   <b>Uso do solo</b><span>${u.B.usoFonte || 'MapBiomas / Esri'} – percentuais por classe dentro do perímetro.</span>
   <b>Copernicus DEM (30 m)</b><span>Declividade em classes da Embrapa.</span>
   <b>Declaração do ITR</b><span>Quando anexada: DIAC/DIAT da Receita Federal lida no computador do usuário (áreas, VTN, grau de utilização, rebanho). Dados pessoais do contribuinte não são lidos.</span>
   <b>IAT – SIGARH</b><span>Outorgas e declarações de uso da água (tipo, número da portaria e vencimento).</span>
   <b>IAT – SGA/SIA</b><span>Licenças ambientais (modalidade, número, atividade e validade).</span>
   <b>ANA – SNISB e IAT</b><span>Barragens cadastradas (risco, dano potencial, PNSB) e massas d'água (açudes, represas, lagos).</span>
  </div>
  <p class="hint">Legenda dos selos: <b>Em acordo</b> – nada encontrado ou situação regular; <b>Atenção</b> – item a verificar ou que pode exigir adequação; <b>Em desacordo</b> – restrição ou pendência identificada nas bases; <b>Não se aplica</b> – não há o elemento no imóvel ou não há dado.</p>
  <p class="hint">Privacidade: este relatório não exibe CPF, CNPJ nem dados pessoais de proprietários. Titulares de outorgas e licenças aparecem como constam nas consultas públicas do IAT.</p>
  <div class="valida"><div class="qr">${qr(link, 96)}</div><div><b>Conferência do relatório</b><br><span class="mono">${u.codigo}</span><br><span class="hint">Aponte a câmera para o QR code para abrir este imóvel no mapa e refazer a análise com os dados mais recentes. Dados do mapa atualizados em ${esc(dadosGerais.atualizado_em || '')}. Emitido em ${esc(dataHora)}.</span></div></div>${blocoCS}`)}
</div></body></html>`;
}
// abre o Raio-X direto quando o link traz ?car=… (usado pelo QR code do relatório)
(function rxAbrirPeloLink() {
    const car = new URLSearchParams(location.search).get('car');
    if (!car) return;
    const tentar = (n) => {
        if (typeof dadosGerais !== 'undefined' && dadosGerais.raiox && typeof map !== 'undefined' && map.loaded && map.loaded()) analisarImovel(car);
        else if (n < 60) setTimeout(() => tentar(n + 1), 1000);
    };
    setTimeout(() => tentar(0), 2500);
})();

// ---------- ITR anexado pelo usuário ----------
function rxMostrarItr() {
    const u = RX.ultimo, corpo = document.getElementById('raioxCorpo'); if (!u || !corpo) return;
    corpo.querySelector('.itr-box')?.remove();
    if (!u.itr && !u.previa) return;
    const box = document.createElement('div'); box.className = 'itr-box';
    const pend = [...(u.itr ? itrPendencias(u) : []), ...itrPrevPendencias(u)];
    box.innerHTML = u.itr ? `<h3>Declaração do ITR${u.itr.exercicio ? ` – exercício ${u.itr.exercicio}` : ''}</h3>${itrBlocoHtml(u, false)}
        ${u.previa ? `<h4>Declarado × estimado por satélite</h4>${itrComparacaoHtml(u)}<details><summary>Ver a prévia completa (como foi estimado)</summary>${itrPreviaHtml(u)}</details>` : '<p class="hint">Calculando a prévia por satélite para comparar…</p>'}
        ${pend.length ? `<h4>Pendências do ITR</h4><ul>${pend.map(n => `<li>${esc(n.achado)} → ${esc(n.adequacao)}</li>`).join('')}</ul>` : ''}`
      : `<h3>Prévia do ITR (estimativa por satélite)</h3><p class="hint">Sem a declaração: o que o imóvel deveria declarar. Anexe a DITR (botão abaixo) para comparar declarado × estimado.</p>${itrPreviaHtml(u)}`;
    const ancora = corpo.querySelector('.rx-flags'); ancora ? ancora.after(box) : corpo.prepend(box);
}
document.addEventListener('DOMContentLoaded', () => {
    const inp = document.getElementById('raioxItr'); if (!inp) return;
    inp.addEventListener('change', async () => {
        const arq = inp.files[0]; inp.value = ''; const u = RX.ultimo; if (!arq || !u) return;
        const corpo = document.getElementById('raioxCorpo'), st = document.createElement('p'); st.className = 'hint itr-status';
        corpo.querySelector('.itr-status')?.remove(); corpo.prepend(st);
        const btn = document.getElementById('raioxPdf'); btn.disabled = true;
        try {
            st.textContent = 'Lendo a declaração do ITR neste computador…';
            const d = await itrLerArquivo(arq, t => st.textContent = t);
            if (d.lidos < 5) { st.textContent = 'Não consegui ler os quadros da declaração do ITR neste PDF. Use o PDF da DITR (DIAC/DIAT) gerado pela Receita.'; return; }
            u.itr = d; RX.itr[u.nome] = d; st.remove(); rxMostrarItr();
            corpo.querySelector('.itr-box')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (e) { console.error(e); st.textContent = 'Não foi possível ler o PDF do ITR.'; }
        finally { btn.disabled = false; }
    });
});
