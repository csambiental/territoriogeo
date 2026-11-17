/* Painel regional: soma os números (resumo.json) dos municípios escolhidos. Só dados agregados, sem nomes de titulares. */
const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 0) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (a, b, d = 0) => b ? fmt(100 * a / b, d) + '%' : '–';
const ha = v => v >= 10000 ? fmt(v / 1000, 1) + ' mil ha' : fmt(v) + ' ha';
const sa = t => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

let LISTA = [], RES = {}, REG = {}, SEL = new Set(), ORDEM = { col: 'imoveis', desc: true };

async function iniciar() {
    LISTA = await (await fetch('data/municipios.json', { cache: 'no-cache' })).json();
    try { (await (await fetch('data/municipios_pr.json')).json()).forEach(m => { REG[m.cod] = m.meso.replace(' Paranaense', ''); }); } catch (e) { }
    await Promise.all(LISTA.map(async m => {
        try { RES[m.codigo] = await (await fetch(`data/m/${m.codigo}/resumo.json`, { cache: 'no-cache' })).json(); } catch (e) { }
    }));
    LISTA = LISTA.filter(m => RES[m.codigo]);
    const pedido = (new URLSearchParams(location.search).get('m') || '').split(',').filter(c => RES[c]);
    SEL = new Set(pedido.length ? pedido : LISTA.map(m => m.codigo));
    montarLista(); await montarMapa(); atualizar();
}

function montarLista() {
    const grupos = {};
    LISTA.forEach(m => (grupos[REG[m.codigo] || 'Outros'] ||= []).push(m));
    const nomes = Object.keys(grupos).sort((a, b) => a.localeCompare(b, 'pt-BR'));
    document.getElementById('atalhos').innerHTML = `<button type="button" data-a="todos">Todos (${LISTA.length})</button><button type="button" data-a="limpar">Limpar</button>` +
        nomes.map(g => `<button type="button" data-a="reg" data-g="${esc(g)}">${esc(g)} (${grupos[g].length})</button>`).join('');
    document.getElementById('atalhos').onclick = e => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.a === 'todos') SEL = new Set(LISTA.map(m => m.codigo));
        else if (b.dataset.a === 'limpar') SEL.clear();
        else SEL = new Set(grupos[b.dataset.g].map(m => m.codigo));
        atualizar();
    };
    document.getElementById('lista').innerHTML = nomes.map(g => `<div><h4>${esc(g)}</h4>${grupos[g].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')).map(m =>
        `<label><input type="checkbox" value="${m.codigo}" id="ck${m.codigo}"> ${esc(m.nome)} <small>${fmt(RES[m.codigo].car.imoveis_ativos)}</small></label>`).join('')}</div>`).join('');
    document.getElementById('lista').onchange = e => { const c = e.target; if (c.type !== 'checkbox') return; c.checked ? SEL.add(c.value) : SEL.delete(c.value); atualizar(); };
}

async function montarMapa() {
    const svg = document.querySelector('#mapa svg');
    try {
        const g = await (await fetch('data/pr_municipios.geojson')).json();
        const k = Math.cos(-24.6 * Math.PI / 180);
        let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
        const polis = f => f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
        g.features.forEach(f => polis(f).forEach(p => p[0].forEach(([x, y]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); })));
        const W = 600, H = Math.round(W * (y1 - y0) / ((x1 - x0) * k));
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        const px = ([x, y]) => `${((x - x0) / (x1 - x0) * W).toFixed(1)},${((y1 - y) / (y1 - y0) * H).toFixed(1)}`;
        svg.innerHTML = g.features.map(f => `<path d="${polis(f).map(p => p.map(r => 'M' + r.map(px).join('L') + 'Z').join('')).join('')}" data-c="${f.properties.c}"><title>${esc(f.properties.n)}${RES[f.properties.c] ? '' : ' – ainda não processado'}</title></path>`).join('');
        svg.onclick = e => { const p = e.target.closest('path'); if (!p || !RES[p.dataset.c]) return; SEL.has(p.dataset.c) ? SEL.delete(p.dataset.c) : SEL.add(p.dataset.c); atualizar(); };
    } catch (e) { document.getElementById('mapa').hidden = true; }
}

function somar(cods) {
    const T = { n: cods.length, area_mun: 0, imoveis: 0, area_car: 0, sig_area: 0, sig_n: 0, conf: 0, aguard: 0, alta: 0, rl: 0, sem_out: 0, alertas: 0, alertas_ha: 0, emb: 0, emb_vig: 0, outorgas: 0, lic: 0, lic_venc: 0, nasc: 0, rios: 0, barr: 0, c_alerta: 0,
        porte: {}, porte_ha: {}, condicao: {}, veg: {}, pend: {}, geo: {}, uso: {}, out_tipo: {}, lic_tipo: {} };
    const add = (o, src) => Object.entries(src || {}).forEach(([k, v]) => { o[k] = (o[k] || 0) + v; });
    cods.forEach(c => {
        const r = RES[c], car = r.car;
        T.area_mun += r.area_municipio_ha || 0; T.imoveis += car.imoveis_ativos; T.area_car += car.area_ativos_ha;
        T.sig_area += r.sigef.area_ha; T.sig_n += r.sigef.parcelas;
        Object.entries(car.condicao).forEach(([k, v]) => { if (/em conformidade/.test(k)) T.conf += v; if (/^Aguardando análise/.test(k)) T.aguard += v; });
        T.alta += car.pendencia_nivel['Prioridade alta'] || 0; T.rl += car.possivel_deficit_rl; T.sem_out += car.atividade_sem_outorga; T.c_alerta += car.com_alerta;
        T.alertas += r.alertas.n; T.alertas_ha += r.alertas.area_ha; T.emb += r.embargos.n; T.emb_vig += Object.entries(r.embargos.situacao).filter(([k]) => /vigente/i.test(k)).reduce((a, [, v]) => a + v, 0);
        T.outorgas += r.outorgas_rurais.n; T.lic += r.licencas.n; T.lic_venc += r.licencas.vencidas_sem_renovacao;
        T.nasc += r.nascentes; T.rios += r.rios_km; T.barr += r.barragens;
        add(T.porte, car.porte); add(T.porte_ha, car.porte_area_ha); add(T.condicao, car.condicao); add(T.veg, car.faixa_vegetacao); add(T.pend, car.pendencia_nivel);
        add(T.geo, car.georreferenciamento); add(T.uso, r.uso_solo.grupos); add(T.out_tipo, r.outorgas_rurais.tipo); add(T.lic_tipo, r.licencas.tipo);
    });
    return T;
}

function barras(titulo, obj, ordem, un = 'imóveis', total) {
    let itens = Object.entries(obj).filter(([, v]) => v > 0);
    if (ordem) itens.sort((a, b) => (ordem.indexOf(a[0]) + 99 * (ordem.indexOf(a[0]) < 0)) - (ordem.indexOf(b[0]) + 99 * (ordem.indexOf(b[0]) < 0)));
    else itens.sort((a, b) => b[1] - a[1]);
    const tot = total || itens.reduce((a, [, v]) => a + v, 0), max = Math.max(...itens.map(([, v]) => v), 1);
    return `<div class="caixa"><h3>${titulo}</h3><div class="barras">${itens.map(([k, v]) => `<div class="barra"><span>${esc(k)}</span><em>${un === 'ha' ? ha(v) : fmt(v) + ' ' + un} · ${pct(v, tot)}</em><div class="tr"><i style="width:${(100 * v / max).toFixed(1)}%"></i></div></div>`).join('') || '<p class="nota">Sem registros.</p>'}</div></div>`;
}

function linha(c) {
    const r = RES[c], car = r.car, conf = Object.entries(car.condicao).filter(([k]) => /em conformidade/.test(k)).reduce((a, [, v]) => a + v, 0);
    return { cod: c, nome: r.nome, regiao: REG[c] || '', imoveis: car.imoveis_ativos, area: car.area_ativos_ha, terr: r.area_municipio_ha ? 100 * car.area_ativos_ha / r.area_municipio_ha : 0,
        sigef: car.area_ativos_ha ? 100 * Math.min(r.sigef.area_ha, car.area_ativos_ha) / car.area_ativos_ha : 0, conf: car.imoveis_ativos ? 100 * conf / car.imoveis_ativos : 0,
        alta: car.pendencia_nivel['Prioridade alta'] || 0, rl: car.possivel_deficit_rl, semout: car.atividade_sem_outorga, alertas: r.alertas.n,
        outorgas: r.outorgas_rurais.n, lic: r.licencas.n, nasc: r.nascentes };
}
const COLS = [['nome', 'Município', v => v], ['imoveis', 'Imóveis CAR', v => fmt(v)], ['area', 'Área CAR (ha)', v => fmt(v)], ['terr', '% do território', v => fmt(v, 0) + '%'],
    ['sigef', 'Área no SIGEF', v => fmt(v, 0) + '%'], ['conf', 'Em conformidade', v => fmt(v, 0) + '%'], ['alta', 'Prioridade alta', v => fmt(v)], ['rl', 'Possível déficit de RL', v => fmt(v)],
    ['semout', 'Atividade sem outorga', v => fmt(v)], ['alertas', 'Alertas de desmate', v => fmt(v)], ['outorgas', 'Outorgas rurais', v => fmt(v)], ['lic', 'Licenças', v => fmt(v)], ['nasc', 'Nascentes', v => fmt(v)]];

function atualizar() {
    document.querySelectorAll('#lista input').forEach(c => { c.checked = SEL.has(c.value); });
    document.querySelectorAll('#mapa path').forEach(p => { p.setAttribute('class', SEL.has(p.dataset.c) ? 'sel' : RES[p.dataset.c] ? 'ok' : 'no'); });
    const cods = [...SEL];
    history.replaceState(null, '', '?m=' + cods.join(','));
    const el = document.getElementById('res');
    if (!cods.length) { el.innerHTML = '<div class="caixa vazio">Escolha pelo menos um município no mapa ou na lista.</div>'; return; }
    const T = somar(cods);
    const k = (v, r, c = '') => `<div class="kpi ${c}"><b>${v}</b><span>${r}</span></div>`;
    const linhas = cods.map(linha).sort((a, b) => { const x = a[ORDEM.col], y = b[ORDEM.col]; return (typeof x === 'string' ? x.localeCompare(y, 'pt-BR') : x - y) * (ORDEM.desc ? -1 : 1); });
    const nomes = cods.map(c => RES[c].nome).sort((a, b) => a.localeCompare(b, 'pt-BR'));
    el.innerHTML = `
      <div class="cab"><div><h2>${T.n === 1 ? nomes[0] : T.n + ' municípios somados'}</h2><p>${esc(nomes.join(', '))}</p></div>
        <button type="button" class="btn" id="csv">Baixar planilha (CSV)</button></div>
      <div class="kpis">
        ${k(fmt(T.imoveis), 'imóveis rurais no CAR (ativos)')}
        ${k(ha(T.area_car), `área cadastrada no CAR · ${pct(T.area_car, T.area_mun)} do território`)}
        ${k(fmt(T.imoveis ? T.area_car / T.imoveis : 0, 1) + ' ha', 'área média por imóvel')}
        ${k(pct(Math.min(T.sig_area, T.area_car), T.area_car), `da área do CAR certificada no SIGEF · ${fmt(T.sig_n)} parcelas`)}
        ${k(pct(T.conf, T.imoveis), `analisados e em conformidade · ${fmt(T.conf)} imóveis`)}
        ${k(pct(T.aguard, T.imoveis), `aguardando análise do órgão · ${fmt(T.aguard)} imóveis`, 'at')}
        ${k(fmt(T.alta), 'imóveis com pendência de prioridade alta', 'cr')}
        ${k(fmt(T.rl), 'imóveis com possível déficit de Reserva Legal', 'at')}
        ${k(fmt(T.sem_out), 'atividades licenciadas sem outorga de captação localizada', 'at')}
        ${k(fmt(T.alertas), `alertas de desmatamento (MapBiomas) · ${fmt(T.alertas_ha, 1)} ha dentro de imóveis`, T.alertas ? 'cr' : '')}
        ${k(fmt(T.emb), `embargos IBAMA · ${fmt(T.emb_vig)} vigentes`, T.emb_vig ? 'cr' : '')}
        ${k(fmt(T.outorgas), 'outorgas de água em área rural')}
        ${k(fmt(T.lic), `licenças ambientais · ${fmt(T.lic_venc)} vencidas sem renovação`)}
        ${k(fmt(T.nasc), 'nascentes mapeadas (FBDS)')}
        ${k(fmt(T.rios) + ' km', 'de rios até 10 m de largura (FBDS)')}
        ${k(fmt(T.barr), 'barragens cadastradas (SNISB/IAT)')}
      </div>
      <div class="grade2">
        ${barras('Porte dos imóveis (módulos fiscais)', T.porte, ['Pequena (até 4 MF)', 'Média (4 a 15 MF)', 'Grande (acima de 15 MF)'])}
        ${barras('Área por porte', T.porte_ha, ['Pequena (até 4 MF)', 'Média (4 a 15 MF)', 'Grande (acima de 15 MF)'], 'ha')}
        ${barras('Situação do CAR no órgão', T.condicao)}
        ${barras('Pendências identificadas', T.pend, ['Prioridade alta', 'Prioridade média', 'Atenção', 'Sem pendência identificada'])}
        ${barras('Vegetação arbórea dentro do imóvel', T.veg, ['Menos de 5%', '5% a 10%', '10% a 20%', '20% ou mais', 'Sem informação'])}
        ${barras('Georreferenciamento (SIGEF/INCRA)', T.geo, ['Certificado (≥ 50% da área)', 'Parcial', 'Não localizado no SIGEF'])}
        ${barras('Uso do solo nos municípios', T.uso, null, 'ha')}
        ${barras('Outorgas rurais por tipo', T.out_tipo, null, 'outorgas')}
      </div>
      <div class="caixa"><h3>Comparação entre municípios</h3><p class="dica">Toque no título de uma coluna para ordenar.</p>
        <div class="tab"><table><thead><tr>${COLS.map(([c, t]) => `<th data-c="${c}">${t}${ORDEM.col === c ? (ORDEM.desc ? ' ▼' : ' ▲') : ''}</th>`).join('')}<th></th></tr></thead>
        <tbody>${linhas.map(l => `<tr>${COLS.map(([c, , f]) => `<td>${esc(f(l[c]))}</td>`).join('')}<td><a href="index.html?m=${l.cod}">abrir</a></td></tr>`).join('')}</tbody>
        <tfoot><tr><td>Total</td><td>${fmt(T.imoveis)}</td><td>${fmt(T.area_car)}</td><td>${pct(T.area_car, T.area_mun)}</td><td>${pct(Math.min(T.sig_area, T.area_car), T.area_car)}</td><td>${pct(T.conf, T.imoveis)}</td><td>${fmt(T.alta)}</td><td>${fmt(T.rl)}</td><td>${fmt(T.sem_out)}</td><td>${fmt(T.alertas)}</td><td>${fmt(T.outorgas)}</td><td>${fmt(T.lic)}</td><td>${fmt(T.nasc)}</td><td></td></tr></tfoot></table></div></div>
      <p class="nota">Fontes: SICAR (CAR), INCRA/SIGEF, IBAMA, MapBiomas Alerta, IAT (SIGARH, SGA, FBDS), SNISB/ANA, uso do solo ${esc(Object.values(RES)[0]?.uso_solo?.fonte || '')}. A área do CAR pode passar de 100% do território por sobreposição entre cadastros e por imóveis que se estendem a municípios vizinhos. Números calculados automaticamente para triagem; não substituem a análise técnica do imóvel.</p>`;
    el.querySelectorAll('th[data-c]').forEach(th => th.onclick = () => { ORDEM = { col: th.dataset.c, desc: ORDEM.col === th.dataset.c ? !ORDEM.desc : th.dataset.c !== 'nome' }; atualizar(); });
    document.getElementById('csv').onclick = () => {
        const cab = ['Código IBGE', 'Região', ...COLS.map(c => c[1])];
        const csv = [cab, ...linhas.map(l => [l.cod, l.regiao, ...COLS.map(([c]) => typeof l[c] === 'number' ? l[c].toFixed(c === 'area' ? 1 : c === 'terr' || c === 'sigef' || c === 'conf' ? 1 : 0).replace('.', ',') : l[c])])]
            .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
        a.download = `painel_regional_${T.n}_municipios.csv`; a.click();
    };
}
iniciar();
