/* Escolha do município: botão no topo que abre um painel com busca, lista por região (IBGE) e mapa do Paraná.
   Só os municípios já processados (data/municipios.json) podem ser abertos; os demais aparecem em cinza no mapa. */
function munSeletor(lista, atual) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.id = 'munBtn'; btn.className = 'mun-btn';
    btn.innerHTML = `<span class="mun-btn-nome">${esc(atual.nome)}/PR</span><span class="mun-btn-acao">trocar município</span>`;
    btn.title = 'Trocar município';
    let dlg = null;
    btn.addEventListener('click', async () => {
        if (!dlg) dlg = await munMontarPainel(lista, atual);
        dlg.showModal();
        const q = dlg.querySelector('#munBusca'); q.value = ''; q.dispatchEvent(new Event('input')); q.focus();
    });
    return btn;
}

function munAbrir(cod) { location.search = '?m=' + cod; }

async function munMontarPainel(lista, atual) {
    const sa = t => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    let regioes = {};
    try { (await (await fetch('data/municipios_pr.json')).json()).forEach(m => { regioes[m.cod] = m.meso.replace(' Paranaense', ''); }); } catch (e) { }
    const prontos = new Map(lista.map(m => [m.codigo, m]));
    const dlg = document.createElement('dialog');
    dlg.className = 'mun-dialog';
    dlg.innerHTML = `
      <header><h2>Escolher município</h2><button type="button" class="mun-fechar" aria-label="Fechar">✕</button></header>
      <div class="mun-corpo">
        <div class="mun-esq">
          <input type="search" id="munBusca" placeholder="Digite o nome do município" autocomplete="off" aria-label="Buscar município">
          <p class="mun-cont">${lista.length} municípios disponíveis de 399 no Paraná</p>
          <a class="mun-regional" href="regiao.html">Σ Somar vários municípios (painel regional)</a>
          <div class="mun-lista" id="munLista"></div>
        </div>
        <div class="mun-mapa"><svg id="munSvg" role="img" aria-label="Mapa do Paraná com os municípios disponíveis"></svg>
          <p class="mun-leg"><i class="l-ok"></i>disponível <i class="l-at"></i>aberto agora <i class="l-no"></i>ainda não processado</p>
          <p class="mun-dica" id="munDica">Toque num município verde para abrir.</p></div>
      </div>`;
    document.body.appendChild(dlg);
    dlg.querySelector('.mun-fechar').addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });

    // lista agrupada por região
    const elL = dlg.querySelector('#munLista');
    const desenharLista = filtro => {
        const grupos = {};
        lista.filter(m => !filtro || sa(m.nome).includes(filtro)).forEach(m => (grupos[regioes[m.codigo] || 'Outros'] ||= []).push(m));
        const nomes = Object.keys(grupos).sort((a, b) => a.localeCompare(b, 'pt-BR'));
        elL.innerHTML = nomes.length ? nomes.map(g => `<div class="mun-grupo"><h3>${esc(g)}</h3>${grupos[g].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')).map(m =>
            `<button type="button" data-c="${m.codigo}" class="${m.codigo === atual.codigo ? 'atual' : ''}"><span>${esc(m.nome)}</span><small>${Number(m.imoveis).toLocaleString('pt-BR')} imóveis</small></button>`).join('')}</div>`).join('')
            : '<p class="mun-vazio">Nenhum município disponível com esse nome. Peça o processamento à equipe.</p>';
    };
    elL.addEventListener('click', e => { const b = e.target.closest('button[data-c]'); if (b) munAbrir(b.dataset.c); });
    const busca = dlg.querySelector('#munBusca');
    busca.addEventListener('input', () => { desenharLista(sa(busca.value.trim())); munRealcar(svg, sa(busca.value.trim())); });
    busca.addEventListener('keydown', e => { if (e.key === 'Enter') { const b = elL.querySelector('button[data-c]'); if (b) munAbrir(b.dataset.c); } });
    desenharLista('');

    // mapa do Paraná
    const svg = dlg.querySelector('#munSvg');
    try {
        const g = await (await fetch('data/pr_municipios.geojson')).json();
        const k = Math.cos(-24.6 * Math.PI / 180);
        let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
        const anel = c => c.forEach(([x, y]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); });
        const polis = f => f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
        g.features.forEach(f => polis(f).forEach(p => anel(p[0])));
        const W = 600, H = Math.round(W * (y1 - y0) / ((x1 - x0) * k));
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        const px = ([x, y]) => `${((x - x0) / (x1 - x0) * W).toFixed(1)},${((y1 - y) / (y1 - y0) * H).toFixed(1)}`;
        svg.innerHTML = g.features.map(f => {
            const c = f.properties.c, ok = prontos.has(c);
            const d = polis(f).map(p => p.map(r => 'M' + r.map(px).join('L') + 'Z').join('')).join('');
            return `<path d="${d}" data-c="${c}" data-n="${esc(f.properties.n)}" data-s="${sa(f.properties.n)}" class="${c === atual.codigo ? 'at' : ok ? 'ok' : 'no'}"><title>${esc(f.properties.n)}${ok ? '' : ' – ainda não processado'}</title></path>`;
        }).join('');
        const dica = dlg.querySelector('#munDica');
        svg.addEventListener('click', e => {
            const p = e.target.closest('path'); if (!p) return;
            if (prontos.has(p.dataset.c)) munAbrir(p.dataset.c);
            else dica.textContent = `${p.dataset.n} ainda não foi processado. Peça a inclusão à equipe da CS.`;
        });
    } catch (e) { svg.closest('.mun-mapa').hidden = true; }
    return dlg;
}

function munRealcar(svg, filtro) {
    svg.querySelectorAll('path').forEach(p => p.classList.toggle('busca', !!filtro && p.dataset.s.includes(filtro)));
}
