// ---------- Declaração do ITR (DIAC/DIAT) – leitura no navegador ----------
// O PDF é lido só neste computador (nada é enviado para fora). Se o PDF for digitalizado (imagem), usa OCR.
// Privacidade: extrai APENAS dados do imóvel e números (áreas, valores, rebanho). Nome, CPF, endereço,
// telefone, data de nascimento e condôminos NÃO são lidos nem guardados.
const ITR = {};
function itrCarregarScript(src) {
    return new Promise((ok, erro) => { if ([...document.scripts].some(s => s.src === src)) return ok();
        const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = erro; document.head.appendChild(s); });
}
const ITR_PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const ITR_PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const ITR_TESS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

async function itrTextoDoPdf(arquivo, aviso) {
    await itrCarregarScript(ITR_PDFJS);
    pdfjsLib.GlobalWorkerOptions.workerSrc = ITR_PDFJS_WORKER;
    const pdf = await pdfjsLib.getDocument({ data: await arquivo.arrayBuffer() }).promise;
    let texto = '';
    for (let i = 1; i <= pdf.numPages; i++) {   // 1) texto digital, remontando as linhas pela posição
        const pg = await pdf.getPage(i), tc = await pg.getTextContent(), linhas = {};
        for (const it of tc.items) { const y = Math.round(it.transform[5] / 3); (linhas[y] = linhas[y] || []).push([it.transform[4], it.str]); }
        texto += Object.keys(linhas).sort((a, b) => b - a).map(y => linhas[y].sort((a, b) => a[0] - b[0]).map(x => x[1]).join(' ')).join('\n') + '\n';
    }
    if (texto.replace(/\s/g, '').length > 300) return texto;
    // 2) PDF digitalizado: OCR página a página (português)
    aviso && aviso('PDF digitalizado: lendo o texto da imagem (pode levar ~1 minuto)…');
    await itrCarregarScript(ITR_TESS);
    const w = await Tesseract.createWorker('por');
    texto = '';
    try {
        for (let i = 1; i <= pdf.numPages; i++) {
            aviso && aviso(`Lendo a página ${i} de ${pdf.numPages} (OCR)…`);
            const pg = await pdf.getPage(i), vp = pg.getViewport({ scale: 2.6 }), cv = document.createElement('canvas');
            cv.width = vp.width; cv.height = vp.height;
            await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
            const { data } = await w.recognize(cv);
            texto += data.text + '\n';
        }
    } finally { await w.terminate(); }
    return texto;
}

const itrNorm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const itrNum = s => { const m = String(s || '').match(/-?[\d.]*\d(?:,\d+)?/); return m ? parseFloat(m[0].replace(/\./g, '').replace(',', '.')) : null; };
// rótulo (sem acento, minúsculo) → campo; os mais específicos primeiro
const ITR_CAMPOS = [
    ['area total nao utiliza', 'naoUtilizadaTotal'], ['area total nao aceita', 'naoAceitaTotal'], ['pastagem nao aceita', 'pastagemNaoAceita'],
    ['extrativa nao aceita', 'extrativaNaoAceita'], ['area nao utiliza', 'naoUtilizada'], ['area utilizada na ativ', 'utilizada'],
    ['utilizada com pastagem aceita', 'pastagemAceita'], ['total da area utilizada com past', 'pastagemTotal'], ['area de pastagem declarada', 'pastagemDeclarada'],
    ['area de pastagem calculada', 'pastagemCalculada'], ['pastagem em forma', 'pastagemFormacao'], ['pastagem nativa', 'pastagemNativa'], ['pastagem plantada', 'pastagemPlantada'],
    ['forrageira de corte', 'forrageira'], ['ndice de lota', 'indiceLotacao'], ['projeto t', 'projetoTecnico'],
    ['area de pastagem', 'pastagem'], ['area total do im', 'areaTotal'], ['preserva', 'app'], ['reserva legal', 'rl'],
    ['rppn', 'rppn'], ['interesse ecol', 'interesseEcologico'], ['servidao ambiental', 'servidao'], ['florestas nativas', 'florestasNativas'],
    ['alagada', 'alagada'], ['area tribut', 'tributavel'], ['benfeitorias uteis', 'benfeitorias'], ['demais benfeitorias', 'demaisBenfeitorias'],
    ['area aproveit', 'aproveitavel'], ['produtos vegetais', 'produtosVegetais'], ['area em descanso', 'descanso'], ['reflorestamento', 'reflorestamento'],
    ['extrativa', 'extrativa'], ['granjeira', 'granjeira'], ['frustra', 'frustracao'], ['grau de utiliza', 'gu'],
    ['minera', 'mineracao'], ['imprest', 'imprestavel'], ['inexplorada', 'inexplorada'], ['outras areas', 'outras'],
    ['valor total do im', 'valorTotal'], ['valor das constru', 'valorBenfeitorias'], ['valor das culturas', 'valorCulturas'],
    ['valor da terra nua tribut', 'vtnTributavel'], ['valor da terra nua', 'vtn'], ['aliquota', 'aliquota'], ['imposto calculado', 'impostoCalculado'],
    ['imposto devido', 'impostoDevido'], ['quantidade de quotas', 'quotas'], ['animais de grande porte', 'animaisGrande'], ['medio porte', 'animaisMedio'],
    ['quantidade total de cab', 'cabecasAjustadas'],
];
function itrInterpretar(texto) {
    const d = { campos: {} }, T = itrNorm(texto);
    // só dados do imóvel (nada de nome, CPF, endereço do contribuinte ou condôminos)
    const g = (re, t = texto) => { const m = t.match(re); return m ? m[1].trim() : null; };
    d.exercicio = g(/EXERC\S*\s*(\d{4})/i);
    d.cib = g(/CIB[:\s]*([\d.]+-?\d)/i) || g(/NIRF[:\s]*([\d.]+-?\d)/i);
    d.incra = g(/Incra[:\s]*([\d.]+-?\d)/i);
    {   // nº do CAR (tolerante a erros de OCR: remove caracteres que não são hexadecimais)
        const m = texto.match(/\b([A-Z]{2})\s*-\s*(\d{7})\s*-\s*([0-9A-Za-z.\s]{30,44})/);
        if (m) { let h = m[3].replace(/[\s.]/g, '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/[^0-9A-F]/g, '');
            if (h.length >= 32) d.car = `${m[1]}-${m[2]}-${h.slice(0, 32)}`; }
        if (!d.car) { const g2 = texto.match(/N\S*mero do CAR\s+([A-Z]{2}-\d{7}-[A-Z0-9-]{6,})/i); if (g2) d.car = g2[1].toUpperCase(); }
    }
    d.ada = g(/Recibo do ADA[^\n]*?(\d{8,})/i);
    d.nomeImovel = g(/Nome do Im\S* Rural:\s*([^\n]+?)\s*(?:\n|$)/i);
    const parteImovel = texto.split(/IDENTIFICA\S* DO CONTRIBUINTE/i)[0];   // endereço do imóvel (antes dos dados do contribuinte)
    d.uf = g(/\bUF:\s*([A-Z]{2})/, parteImovel); d.municipio = g(/Munic[ií]pio:\s*([^\n]+?)\s+CEP/i, parteImovel);
    d.contribuinte = /Pessoa Jur[ií]dica/i.test(g(/contribuinte [eé]:\s*([^\n]+)/i) || '') ? 'Pessoa jurídica' : /Pessoa F[ií]sica/i.test(g(/contribuinte [eé]:\s*([^\n]+)/i) || '') ? 'Pessoa física' : null;
    const sn = re => { const v = g(re); return v == null ? null : /^s/i.test(v) ? 'Sim' : 'Não'; };
    d.condominio = sn(/condom[ií]nio\?\s*(Sim|N[aã]o)/i); d.condominos = itrNum(g(/Total de Cond\S*\s*:?\s*(\d+)/i));
    d.imune = sn(/imune ou isento do ITR\?\s*(Sim|N[aã]o)/i); d.retificadora = sn(/retificadora\?\s*(Sim|N[aã]o)/i);
    // linhas numeradas "NN. Rótulo .... valor"
    for (const linha of texto.split(/\n/)) {
        const m = linha.match(/^\s*\d{1,2}\s*[.,]\s*(.+?)\s+(?:R\$\s*)?(-?[\d.]*\d(?:,\d+)?)(?:\s+[\d.,]+\s+[\d.,]+)?\s*$/);
        if (!m) continue;
        const rot = itrNorm(m[1]).replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ');
        const hit = ITR_CAMPOS.find(([k]) => rot.includes(k));
        if (hit && d.campos[hit[1]] == null) d.campos[hit[1]] = itrNum(m[2]);
    }
    // animais de grande/médio porte: 1º número é a média anual de cabeças
    for (const [k, re] of [['animaisGrande', /grande porte\s+([\d.]+)/i], ['animaisMedio', /m[eé]dio porte\s+([\d.]+)/i]]) { const v = g(re); if (v != null) d.campos[k] = itrNum(v); }
    if (d.campos.areaTotal == null) d.campos.areaTotal = itrNum(g(/rea Total do Im\S*:\s*([\d.,]+)/i));
    d.lidos = Object.values(d.campos).filter(v => v != null).length;
    return d;
}
async function itrLerArquivo(arquivo, aviso) {
    const texto = await itrTextoDoPdf(arquivo, aviso);
    const d = itrInterpretar(texto);
    d.arquivo = arquivo.name;
    return d;
}

// mesmo CAR? (aceita até 2 caracteres diferentes por erro de leitura)
function itrMesmoCar(a, b) {
    a = String(a || '').toUpperCase(); b = String(b || '').toUpperCase(); if (!a || !b) return false; if (a === b) return true;
    if (a.length !== b.length) return false; let dif = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) dif++; return dif <= 2;
}
// ---------- uso no Raio-X ----------
const itrF = (v, c = 1) => v == null ? '–' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c });
const itrRS = v => v == null ? '–' : 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ITR_LINHAS_AREA = [
    ['areaTotal', 'Área total do imóvel'], ['app', 'Área de Preservação Permanente (APP)'], ['rl', 'Área de Reserva Legal'], ['rppn', 'RPPN'],
    ['interesseEcologico', 'Área de interesse ecológico'], ['servidao', 'Área de servidão ambiental'], ['florestasNativas', 'Área coberta por florestas nativas'],
    ['alagada', 'Área alagada de reservatório de hidrelétrica'], ['tributavel', 'Área tributável'], ['benfeitorias', 'Benfeitorias úteis e necessárias'],
    ['aproveitavel', 'Área aproveitável'], ['produtosVegetais', 'Produtos vegetais (lavouras)'], ['descanso', 'Área em descanso'], ['reflorestamento', 'Reflorestamento'],
    ['pastagem', 'Pastagem'], ['extrativa', 'Exploração extrativa'], ['granjeira', 'Atividade granjeira ou aquícola'], ['frustracao', 'Frustração de safra / calamidade'],
    ['utilizada', 'Área utilizada na atividade rural'], ['naoUtilizada', 'Área não utilizada na atividade rural'], ['pastagemNaoAceita', 'Pastagem não aceita (lotação insuficiente)'],
    ['naoAceitaTotal', 'Total de áreas não aceitas'], ['naoUtilizadaTotal', 'Total não utilizado na atividade rural']];
function itrComparativo(u) {
    const it = u.itr, c = it.campos, area = u.area, uso = u.uso || [], p = u.p;
    const pctUso = re => uso.filter(([k]) => re.test(k)).reduce((a, [, v]) => a + v, 0);
    const vegMed = pctUso(/Vegetação (nativa|arbórea)|Floresta|Formação/i) / 100 * area;
    const prodMed = pctUso(/Agricult|Lavoura|Pastagem|Campo|Silvicult|Mosaico/i) / 100 * area;
    const decl = rxNum(p['Área (ha)']);
    const dif = (a, b) => a && b ? (a - b) / b : null;
    const L = [];
    const linha = (info, itr, car, med, aval, ruim) => L.push({ info, itr, car, med, aval, ruim });
    const dA = dif(c.areaTotal, area);
    linha('Área total do imóvel', itrF(c.areaTotal) + ' ha', decl ? itrF(decl, 2) + ' ha' : '–', itrF(area, 2) + ' ha',
        dA == null ? '–' : Math.abs(dA) <= .05 ? 'Compatível' : `ITR ${dA > 0 ? 'maior' : 'menor'} que o perímetro em ${itrF(Math.abs(c.areaTotal - area))} ha (${itrF(Math.abs(dA) * 100)}%)`, dA != null && Math.abs(dA) > .05);
    if (c.rl != null) linha('Reserva Legal', itrF(c.rl) + ' ha', `mín. 20% = ${itrF(area * .2)} ha`, itrF(vegMed) + ' ha de vegetação',
        c.rl > vegMed * 1.05 ? `RL declarada maior que a vegetação medida (${itrF(c.rl - vegMed)} ha)` : c.areaTotal && c.rl < c.areaTotal * .2 ? `Abaixo de 20% da área do ITR` : 'Coerente', c.rl > vegMed * 1.05 || (c.areaTotal && c.rl < c.areaTotal * .2));
    if (c.florestasNativas != null) linha('Florestas / vegetação nativa', itrF(c.florestasNativas) + ' ha', '–', itrF(vegMed) + ' ha',
        Math.abs(c.florestasNativas - vegMed) <= Math.max(2, vegMed * .15) ? 'Coerente' : `Diferença de ${itrF(c.florestasNativas - vegMed)} ha entre ITR e satélite`, Math.abs(c.florestasNativas - vegMed) > Math.max(2, vegMed * .15));
    if (c.utilizada != null) linha('Área em produção (lavoura + pastagem)', itrF(c.utilizada) + ' ha', '–', itrF(prodMed) + ' ha',
        Math.abs(c.utilizada - prodMed) <= Math.max(2, prodMed * .15) ? 'Coerente' : `Diferença de ${itrF(c.utilizada - prodMed)} ha entre ITR e satélite`, Math.abs(c.utilizada - prodMed) > Math.max(2, prodMed * .15));
    linha('Nº do CAR informado', it.car ? `<span class="mono">${esc(it.car)}</span>` : 'não informado', `<span class="mono">${esc(u.nome)}</span>`, '–',
        !it.car ? 'CAR não informado no ITR' : itrMesmoCar(it.car, u.nome) ? 'Mesmo CAR' : 'CAR diferente do analisado', !it.car || !itrMesmoCar(it.car, u.nome));
    return L;
}
function itrChecklist(u) {
    const it = u.itr, c = it.campos, itens = [], add = (ind, st, det = '') => itens.push({ ind, st, det });
    const dA = c.areaTotal && u.area ? (c.areaTotal - u.area) / u.area : null;
    add('CAR informado no ITR é o imóvel analisado', !it.car ? 'at' : itrMesmoCar(it.car, u.nome) ? 'ok' : 'no', it.car || 'CAR não localizado na declaração');
    add('Área total do ITR × perímetro do CAR', dA == null ? 'na' : Math.abs(dA) <= .05 ? 'ok' : Math.abs(dA) <= .15 ? 'at' : 'no', dA == null ? '' : `ITR ${itrF(c.areaTotal)} ha × CAR ${itrF(u.area, 2)} ha`);
    add('Ato Declaratório Ambiental (ADA/IBAMA) informado', it.ada ? 'ok' : (c.app || c.rl) ? 'at' : 'na', it.ada ? `Recibo ${it.ada}` : (c.app || c.rl) ? 'APP/RL excluídas da área tributável sem recibo do ADA identificado' : '');
    add('Grau de utilização (GU) ≥ 80%', c.gu == null ? 'na' : c.gu >= 80 ? 'ok' : c.gu >= 65 ? 'at' : 'no', c.gu == null ? '' : `GU ${itrF(c.gu)}%${c.aliquota != null ? ` · alíquota ${itrF(c.aliquota, 2)}%` : ''}`);
    add('Pastagem aceita pela lotação mínima', !c.pastagem && !c.pastagemDeclarada ? 'na' : (c.pastagemNaoAceita || 0) > 0 ? 'at' : 'ok', (c.pastagemNaoAceita || 0) > 0 ? `${itrF(c.pastagemNaoAceita)} ha de pastagem não aceita (rebanho abaixo do índice de lotação ${itrF(c.indiceLotacao, 2)} UA/ha)` : '');
    const L = itrComparativo(u).filter(l => /Reserva Legal|Florestas|produção/.test(l.info));
    L.forEach(l => add(`ITR × satélite – ${l.info.toLowerCase()}`, l.ruim ? 'at' : 'ok', `${l.itr} declarados · ${l.med} medidos`));
    return { nome: `ITR – Receita Federal${it.exercicio ? ` (exercício ${it.exercicio})` : ''}`, itens };
}
function itrPendencias(u) {
    const it = u.itr, c = it.campos, N = [], add = (prior, tema, achado, adequacao) => N.push({ prior, tema, achado, adequacao });
    if (it.car && !itrMesmoCar(it.car, u.nome)) add(1, 'ITR × CAR', `ITR ${it.exercicio || ''} informa outro CAR (${it.car})`, 'Conferir a vinculação imóvel–CAR e retificar o ITR ou o CAR');
    if (!it.car) add(2, 'ITR × CAR', 'Nº do CAR não identificado na declaração do ITR', 'Informar o CAR na próxima DITR (obrigatório)');
    const dA = c.areaTotal && u.area ? (c.areaTotal - u.area) / u.area : null;
    if (dA != null && Math.abs(dA) > .05) add(Math.abs(dA) > .15 ? 1 : 2, 'ITR × CAR – área', `Área do ITR (${itrF(c.areaTotal)} ha) difere do perímetro do CAR (${itrF(u.area, 2)} ha) em ${itrF(Math.abs(dA) * 100)}%`, 'Harmonizar áreas entre matrícula, CCIR/SNCR, CAR e ITR (retificação da DITR e/ou do CAR)');
    if (!it.ada && (c.app || c.rl)) add(2, 'ADA / IBAMA', 'APP/Reserva Legal declaradas no ITR sem recibo do ADA identificado', 'Entregar o Ato Declaratório Ambiental (ADA) no IBAMA no prazo, para manter a exclusão de APP/RL da área tributável');
    if (c.gu != null && c.gu < 80) add(2, 'ITR – grau de utilização', `GU de ${itrF(c.gu)}% (abaixo de 80% eleva a alíquota)`, 'Revisar o uso declarado (lavoura, pastagem, rebanho) e o planejamento produtivo; avaliar projeto técnico');
    if ((c.pastagemNaoAceita || 0) > 0) add(2, 'ITR – pastagem', `${itrF(c.pastagemNaoAceita)} ha de pastagem não aceita (rebanho de ${itrF(c.cabecasAjustadas ?? c.animaisGrande, 0)} cabeças abaixo da lotação mínima)`, 'Ajustar a declaração do rebanho/pastagem ou o manejo (lotação, reforma de pastagem); documentar com notas e GTA');
    const L = itrComparativo(u);
    L.filter(l => l.ruim && /Reserva Legal|Florestas/.test(l.info)).forEach(l => add(2, 'ITR × satélite', `${l.info}: ${l.itr} no ITR × ${l.med} medidos`, 'Conferir a vegetação declarada no ITR/ADA com o CAR e a imagem de satélite; retificar a declaração se necessário'));
    return N;
}
function itrBlocoHtml(u, completo) {
    const it = u.itr, c = it.campos;
    const cards = [['Área total (ITR)', itrF(c.areaTotal) + ' ha'], ['Grau de utilização', c.gu == null ? '–' : itrF(c.gu) + '%'], ['Valor da terra nua', itrRS(c.vtn)],
        ['VTN por hectare', c.vtn && c.areaTotal ? itrRS(c.vtn / c.areaTotal) : '–'], ['Imposto devido', itrRS(c.impostoDevido)], ['Rebanho (cabeças)', c.cabecasAjustadas ?? c.animaisGrande ?? '–']];
    const L = itrComparativo(u);
    const area = ITR_LINHAS_AREA.filter(([k]) => c[k] != null && (completo || c[k] !== 0));
    return `<div class="itr-cds">${cards.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div>
      <p class="hint">${[it.exercicio && `Exercício ${it.exercicio}`, it.cib && `CIB/NIRF ${esc(it.cib)}`, it.incra && `Código INCRA ${esc(it.incra)}`, it.municipio && `${esc(it.municipio)}/${esc(it.uf || '')}`,
        it.contribuinte, it.condominio === 'Sim' && `condomínio de ${it.condominos || '?'} pessoas`, it.retificadora === 'Sim' && 'declaração retificadora', it.ada && `ADA ${esc(it.ada)}`].filter(Boolean).join(' · ')}</p>
      <h4>ITR × CAR × satélite</h4>
      <table class="dk rx-tab"><tr><th>Informação</th><th>Declarado no ITR</th><th>CAR / referência</th><th>Medido no perímetro</th><th>Análise automática</th></tr>
      ${L.map(l => `<tr><td>${l.info}</td><td>${l.itr}</td><td>${l.car}</td><td>${l.med}</td><td class="${l.ruim ? 'def' : 'bom'}">${l.aval}</td></tr>`).join('')}</table>
      <div class="itr-duas"><div><h4>Distribuição da área (DIAT, ha)</h4><table class="rx-tab">${area.map(([k, n]) => `<tr><td>${n}</td><td style="text-align:right"><b>${itrF(c[k])}</b></td></tr>`).join('')}</table></div>
      <div><h4>Valores e pecuária</h4><table class="rx-tab">${[['Valor total do imóvel', itrRS(c.valorTotal)], ['Construções e benfeitorias', itrRS(c.valorBenfeitorias)], ['Culturas, pastagens e florestas plantadas', itrRS(c.valorCulturas)],
        ['Valor da terra nua (VTN)', itrRS(c.vtn)], ['VTN tributável', itrRS(c.vtnTributavel)], ['Alíquota', c.aliquota == null ? '–' : itrF(c.aliquota, 2) + '%'], ['Imposto devido', itrRS(c.impostoDevido)],
        ['Animais de grande porte (média anual)', c.animaisGrande ?? '–'], ['Animais de médio porte', c.animaisMedio ?? '–'], ['Rebanho ajustado (cabeças)', c.cabecasAjustadas ?? '–'],
        ['Pastagem declarada', c.pastagemDeclarada == null ? '–' : itrF(c.pastagemDeclarada) + ' ha'], ['Índice de lotação mínimo', c.indiceLotacao == null ? '–' : itrF(c.indiceLotacao, 2) + ' UA/ha'],
        ['Pastagem aceita', c.pastagemAceita == null ? '–' : itrF(c.pastagemAceita) + ' ha'], ['Lotação declarada', (c.cabecasAjustadas ?? c.animaisGrande) && c.pastagemDeclarada ? itrF((c.cabecasAjustadas ?? c.animaisGrande) / c.pastagemDeclarada, 2) + ' cab/ha' : '–']]
        .map(([k, v]) => `<tr><td>${k}</td><td style="text-align:right"><b>${v}</b></td></tr>`).join('')}</table></div></div>
      <p class="hint">Dados lidos do PDF da declaração ${esc(it.arquivo || '')} neste computador (${it.lidos} campos). Nome, CPF e endereço do contribuinte não são lidos nem exibidos. Confira os números com a declaração original.</p>`;
}

// =====================================================================
// PRÉVIA DO ITR (sem declaração): estimativa por satélite, CAR e tabelas oficiais
// =====================================================================
const ITR_ALIQ = [ // Lei 9.393/1996, anexo – área total (ha) × grau de utilização
    [50, [0.03, 0.20, 0.40, 0.70, 1.00]], [200, [0.07, 0.40, 0.80, 1.40, 2.00]], [500, [0.10, 0.60, 1.30, 2.30, 3.30]],
    [1000, [0.15, 0.85, 1.90, 3.30, 4.70]], [5000, [0.30, 1.60, 3.40, 6.00, 8.60]], [Infinity, [0.45, 3.00, 6.40, 12.00, 20.00]]];
function itrAliquota(areaTotal, gu) {
    const faixa = ITR_ALIQ.find(([lim]) => areaTotal <= lim)[1];
    return faixa[gu > 80 ? 0 : gu > 65 ? 1 : gu > 50 ? 2 : gu >= 30 ? 3 : 4];
}
const ITR_CLS = {
    veg: /arbórea|Floresta|Formação|nativa|Restinga|Mangue|Campo alagado|Área úmida|Várzea/i,
    lav: /Agricult|Lavoura|Soja|Cana|Arroz|Algod|Café|Citrus|Temporária|Perene|Cultura/i,
    pas: /Pastagem|Pasto/i, mos: /Mosaico/i, sil: /Silvicult|plantada|Eucalip|Pinus/i,
    con: /urbaniz|Constru|Infraestrutura|edifica/i, agua: /Água|Agua|Rio|lago|Reservat/i };
function itrUsoHa(uso, area) {
    const s = { veg: 0, lav: 0, pas: 0, sil: 0, con: 0, agua: 0, outros: 0 };
    for (const [k, pct] of uso) {
        const ha = pct / 100 * area;
        if (ITR_CLS.sil.test(k) && !/nativa/i.test(k)) s.sil += ha;
        else if (ITR_CLS.veg.test(k)) s.veg += ha;
        else if (ITR_CLS.mos.test(k)) { s.lav += ha / 2; s.pas += ha / 2; }
        else if (ITR_CLS.lav.test(k)) s.lav += ha;
        else if (ITR_CLS.pas.test(k)) s.pas += ha;
        else if (ITR_CLS.con.test(k)) s.con += ha;
        else if (ITR_CLS.agua.test(k)) s.agua += ha;
        else s.outros += ha;
    }
    return s;
}
const itrNormMun = s => itrNorm(s).toUpperCase().replace(/\/PR$/i, '').replace(/'/g, '').trim();
async function itrAppEstimada(u) {   // APP pelas faixas do Código Florestal (Lei 12.651/2012, art. 4º) sobre a hidrografia FBDS e as massas d'água
    const alvo = u.alvo, bb = turf.bbox(alvo), m = 0.0015, caixa = [bb[0] - m, bb[1] - m, bb[2] + m, bb[3] + m];
    const dentro = f => { try { return rxCaixasCruzam(turf.bbox(f), caixa); } catch (e) { return false; } };
    const faixas = [], det = { rios: 0, nascentes: 0, lagos: 0, represas: 0 };
    const [rios, nasc] = await Promise.all([u.C.rios, u.C.nascentes].map(a => a ? rxJSON(a).catch(() => ({ features: [] })) : Promise.resolve(null)));
    if (rios) rios.features.filter(dentro).forEach(f => { faixas.push(turf.buffer(f, 0.030, { units: 'kilometers', steps: 6 })); det.rios++; });
    if (nasc) nasc.features.filter(dentro).forEach(f => { faixas.push(turf.buffer(f, 0.050, { units: 'kilometers', steps: 12 })); det.nascentes++; });
    (u.r.massas || []).forEach(x => { const art = /artificial/.test(x.f.properties.grupo || ''), ha = rxNum(x.f.properties['Área (ha)']);
        if (art && ha < 1) return;  // dispensada abaixo de 1 ha (§ 4º)
        const larg = art ? 0.015 : ha > 20 ? 0.100 : 0.050; faixas.push(turf.buffer(x.f, larg, { units: 'kilometers', steps: 6 })); art ? det.represas++ : det.lagos++; });
    let app = 0;
    if (faixas.length) {
        let uni = faixas[0];
        const unir = (a, b) => { try { return turf.union(a, b) || a; } catch (e) { try { return turf.union(turf.featureCollection([a, b])) || a; } catch (e2) { return a; } } };  // turf 6 e 7
        for (let i = 1; i < faixas.length; i++) uni = unir(uni, faixas[i]);
        const it = rxInter(alvo, uni); app = it ? rxHa(it) : 0;
        if (it) (u.r.massas || []).forEach(x => { const w = rxInter(it, x.f); if (w) app -= Math.min(app, rxHa(w)); });  // espelho d'água dentro da faixa não é APP
    }
    const encosta = ((u.r.decl[4] || {}).pct || 0) / 100 * u.area;   // relevo > 45% de declividade: conferir encostas > 45° (APP) em campo
    return { app: Math.min(u.area, Math.max(0, app)), det, encosta, temHidro: !!(rios || nasc) };
}
let ITR_VTN = null;
async function itrPrevia(u) {
    const area = u.area, U = itrUsoHa(u.uso || [], area), notas = [];
    const A = await itrAppEstimada(u).catch(e => (console.error(e), { app: 0, det: {}, encosta: 0, temHidro: false }));
    if (A.encosta >= 0.1) notas.push(`${itrF(A.encosta)} ha com declividade acima de 45%: encostas acima de 45° também são APP – conferir em campo (não somadas à estimativa).`);
    if (!A.temHidro) notas.push('Hidrografia FBDS ainda não carregada para este município: APP estimada só por açudes, lagos e encostas.');
    const app = A.app, rl = Math.min(0.2 * area, Math.max(0, U.veg - app)), flor = Math.max(0, U.veg - app - rl);
    const naoTrib = Math.min(area, app + rl + flor), trib = Math.max(0, area - naoTrib), benf = Math.min(trib, U.con);
    const aprov = Math.max(0, trib - benf);
    let veg = U.lav, pas = U.pas, refl = U.sil, soma = veg + pas + refl;
    if (soma > aprov && soma > 0) { const k = aprov / soma; veg *= k; pas *= k; refl *= k; soma = aprov; notas.push('Parte da lavoura/pastagem medida está em APP ou Reserva Legal: área utilizada limitada à área aproveitável.'); }
    const util = soma, gu = aprov > 0 ? Math.min(100, util / aprov * 100) : 0;
    // VTN pela tabela da Receita (SIPT) do município e pela aptidão (relevo do imóvel)
    ITR_VTN = ITR_VTN || await rxJSON('data/itr/vtn_pr_2026.json').catch(() => null);
    const tab = ITR_VTN && ITR_VTN.municipios[itrNormMun(u.C.municipio || '')];
    let vtn = null, vtnDet = [];
    if (tab) {
        const v = i => tab[i] ?? tab[1] ?? tab[3];
        const d = u.r.decl.map(x => x.pct / 100), boa = (d[0] || 0) + (d[1] || 0), reg = d[2] || 0, res = (d[3] || 0) + (d[4] || 0), tot = boa + reg + res || 1;
        const partes = [['Lavoura – aptidão boa (0–8%)', veg * boa / tot, v(0)], ['Lavoura – aptidão regular (8–20%)', veg * reg / tot, v(1)], ['Lavoura – aptidão restrita (> 20%)', veg * res / tot, v(2)],
            ['Pastagem plantada', pas, v(3)], ['Silvicultura', refl, v(4)], ['Preservação (APP, RL, vegetação nativa, água)', naoTrib + U.agua, v(5)],
            ['Benfeitorias e demais áreas', Math.max(0, area - naoTrib - U.agua - veg - pas - refl), v(1)]];
        vtnDet = partes.filter(p => p[1] > 0.005); vtn = vtnDet.reduce((a, [, ha, val]) => a + ha * val, 0);
    } else notas.push('Município sem tabela de VTN carregada: valor da terra nua não estimado.');
    const aliq = itrAliquota(area, gu), vtnTrib = vtn != null ? vtn * trib / area : null, imposto = vtnTrib != null ? Math.max(10, vtnTrib * aliq / 100) : null;
    if (area <= 30) notas.push('Imóvel de até 30 ha: pode ser isento do ITR (pequena gleba, art. 3º da Lei 9.393/96) se o proprietário o explorar e não tiver outro imóvel.');
    if (area < 200) notas.push('Imóvel com menos de 200 ha: dispensado dos índices de lotação da pecuária (IN SRF 256/2002, art. 24, § 3º) – toda a pastagem efetivamente usada é aceita.');
    else notas.push('Imóvel com 200 ha ou mais: a pastagem só é aceita se o rebanho atingir o índice de lotação da zona de pecuária do município (confirmar o índice antes de declarar).');
    return { area, app, rl, flor, naoTrib, trib, benf, aprov, veg, pas, refl, util, gu, vtn, vtnTrib, aliq, imposto, vtnDet, uso: U, A, notas, tabela: ITR_VTN && ITR_VTN.fonte };
}
const ITR_COMP = [ // [campo da declaração, campo da prévia, rótulo, tolerância relativa]
    ['areaTotal', 'area', 'Área total'], ['app', 'app', 'APP'], ['rl', 'rl', 'Reserva Legal'], ['florestasNativas', 'flor', 'Florestas nativas (fora de APP/RL)'],
    ['tributavel', 'trib', 'Área tributável'], ['benfeitorias', 'benf', 'Benfeitorias'], ['aproveitavel', 'aprov', 'Área aproveitável'],
    ['produtosVegetais', 'veg', 'Produtos vegetais (lavouras)'], ['pastagem', 'pas', 'Pastagem'], ['reflorestamento', 'refl', 'Reflorestamento'],
    ['utilizada', 'util', 'Área utilizada'], ['gu', 'gu', 'Grau de utilização (%)'], ['vtn', 'vtn', 'Valor da terra nua (R$)'], ['aliquota', 'aliq', 'Alíquota (%)'], ['impostoDevido', 'imposto', 'Imposto (R$)']];
function itrComparar(u) {
    const c = u.itr.campos, P = u.previa;
    return ITR_COMP.map(([kd, kp, rot]) => {
        const d = c[kd], e = P[kp]; if (d == null && e == null) return null;
        const din = /R\$/.test(rot), pct = /%/.test(rot), dif = d != null && e != null ? d - e : null;
        const tol = din ? Math.max(1000, Math.abs(e || 0) * .2) : pct ? 10 : Math.max(1, Math.abs(e || 0) * .15);
        const ruim = dif != null && Math.abs(dif) > tol;
        const f = v => v == null ? '–' : din ? itrRS(v) : pct ? itrF(v, kd === 'aliquota' ? 2 : 1) : itrF(v, 1) + ' ha';
        return { rot, decl: f(d), est: f(e), dif: dif == null ? '–' : (dif > 0 ? '+' : '') + (din ? itrRS(dif).replace('R$ -', '-R$ ') : itrF(dif, kd === 'aliquota' ? 2 : 1) + (pct ? ' p.p.' : ' ha')), ruim, kd, d, e };
    }).filter(Boolean);
}
function itrPreviaHtml(u) {
    const P = u.previa; if (!P) return '';
    const L = [['Área total do imóvel (perímetro do CAR)', P.area, 'CAR'], ['Área de Preservação Permanente – APP', P.app, `faixas legais: ${P.A.det.rios || 0} trecho(s) de rio, ${P.A.det.nascentes || 0} nascente(s), ${(P.A.det.lagos || 0) + (P.A.det.represas || 0)} lago(s)/represa(s)`],
        ['Reserva Legal (até 20%, sobre vegetação existente)', P.rl, 'vegetação nativa medida'], ['Florestas nativas fora de APP/RL', P.flor, 'satélite'], ['Área tributável', P.trib, 'calculada'],
        ['Benfeitorias (área construída)', P.benf, 'satélite'], ['Área aproveitável', P.aprov, 'calculada'], ['Produtos vegetais (lavouras)', P.veg, 'satélite'], ['Pastagem', P.pas, 'satélite'],
        ['Reflorestamento (silvicultura)', P.refl, 'satélite'], ['Área utilizada na atividade rural', P.util, 'calculada']];
    return `<div class="itr-cds"><div><span>Área tributável</span><b>${itrF(P.trib)} ha</b></div><div><span>Grau de utilização</span><b>${itrF(P.gu)}%</b></div><div><span>APP + RL + florestas</span><b>${itrF(P.naoTrib)} ha</b></div>
        <div><span>Valor da terra nua</span><b>${P.vtn == null ? '–' : itrRS(P.vtn)}</b></div><div><span>Alíquota</span><b>${itrF(P.aliq, 2)}%</b></div><div><span>Imposto estimado</span><b>${P.imposto == null ? '–' : itrRS(P.imposto)}</b></div></div>
      <div class="itr-duas"><div><h4>Distribuição da área estimada (ha)</h4><table class="rx-tab">${L.map(([n, v, b]) => `<tr><td>${n}<br><span class="hint">${b}</span></td><td style="text-align:right"><b>${itrF(v)}</b></td></tr>`).join('')}</table></div>
      <div><h4>Valor da terra nua por aptidão</h4><table class="rx-tab"><tr><th>Aptidão (tabela da Receita)</th><th>ha</th><th>R$/ha</th></tr>${P.vtnDet.map(([n, ha, v]) => `<tr><td>${n}</td><td>${itrF(ha)}</td><td style="white-space:nowrap">${itrRS(v)}</td></tr>`).join('')}</table>
      <p class="hint">${esc(P.tabela || '')}. Aptidão da lavoura pela declividade do imóvel.</p></div></div>
      ${P.notas.length ? `<ul class="hint">${P.notas.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      <p class="hint">Prévia estimada por satélite, CAR e tabelas oficiais – serve para orientar a declaração e conferir inconsistências. Não substitui a DITR nem o levantamento de campo; rebanho, benfeitorias e situação do proprietário precisam ser informados pelo produtor.</p>`;
}
function itrComparacaoHtml(u) {
    const L = itrComparar(u);
    return `<table class="dk rx-tab"><tr><th>Item</th><th>Declarado no ITR</th><th>Estimado (prévia)</th><th>Diferença</th></tr>${L.map(l => `<tr><td>${l.rot}</td><td>${l.decl}</td><td>${l.est}</td><td class="${l.ruim ? 'def' : 'bom'}">${l.dif}${l.ruim ? ' ⚠' : ''}</td></tr>`).join('')}</table>
      <p class="hint">⚠ = diferença acima da tolerância (15% das áreas, 10 pontos no grau de utilização, 20% dos valores). Pode indicar erro na declaração, mudança de uso ou limitação da estimativa – conferir antes de retificar.</p>`;
}
function itrPrevChecklist(u) {   // indicadores da prévia (sem declaração) ou da comparação (com declaração)
    const P = u.previa, itens = [], add = (ind, st, det = '') => itens.push({ ind, st, det });
    if (!P) return null;
    if (!u.itr) {
        add('Grau de utilização estimado ≥ 80%', P.gu >= 80 ? 'ok' : P.gu >= 65 ? 'at' : 'no', `${itrF(P.gu)}% → alíquota ${itrF(P.aliq, 2)}%`);
        add('Vegetação suficiente para a Reserva Legal (20%)', P.rl >= 0.2 * P.area - 0.05 ? 'ok' : 'at', `${itrF(P.rl)} ha possíveis de ${itrF(0.2 * P.area)} ha`);
        add('Declaração do ITR anexada para conferência', 'at', 'Anexe a DITR para comparar declarado × estimado');
        return { nome: 'Prévia do ITR (estimativa por satélite)', itens };
    }
    const L = itrComparar(u), ach = k => L.find(l => l.kd === k);
    for (const [k, rot] of [['areaTotal', 'Área total'], ['app', 'APP'], ['rl', 'Reserva Legal'], ['utilizada', 'Área utilizada'], ['gu', 'Grau de utilização'], ['vtn', 'Valor da terra nua']]) {
        const l = ach(k); if (!l || l.d == null) continue;
        let st = l.ruim ? 'at' : 'ok';
        if (k === 'vtn' && l.d < (l.e || 0) * 0.7) st = 'no';   // VTN muito abaixo da tabela: risco de arbitramento pela Receita
        if (k === 'gu' && l.d - (l.e || 0) > 15) st = 'no';
        add(`Declarado × estimado – ${rot}`, st, `${l.decl} declarados · ${l.est} estimados`);
    }
    return { nome: 'ITR declarado × prévia por satélite', itens };
}
function itrPrevPendencias(u) {
    const P = u.previa, N = [], add = (prior, tema, achado, adequacao) => N.push({ prior, tema, achado, adequacao });
    if (!P) return N;
    if (!u.itr) {
        if (P.gu < 80) add(2, 'ITR – prévia', `Grau de utilização estimado de ${itrF(P.gu)}% (alíquota ${itrF(P.aliq, 2)}%)`, 'Planejar uso produtivo e documentar áreas em uso antes da DITR; avaliar áreas em descanso ou projeto técnico');
        add(3, 'ITR – prévia', `Prévia: área tributável ${itrF(P.trib)} ha, VTN ${P.vtn == null ? '–' : itrRS(P.vtn)}, imposto estimado ${P.imposto == null ? '–' : itrRS(P.imposto)}`, 'Conferir com a última DITR entregue e com o ADA (IBAMA); preparar a próxima declaração com base no CAR e no uso real');
        return N;
    }
    const L = itrComparar(u), ach = k => L.find(l => l.kd === k);
    const v = ach('vtn'); if (v && v.d != null && v.e && v.d < v.e * 0.7) add(1, 'ITR – valor da terra nua', `VTN declarado (${v.decl}) abaixo de 70% do valor da tabela da Receita para o município (${v.est})`, 'Revisar o VTN com laudo de avaliação (NBR 14.653-3) ou ajustar à tabela; VTN subavaliado pode ser arbitrado pela Receita com multa');
    const g = ach('gu'); if (g && g.d != null && g.e != null && g.d - g.e > 15) add(1, 'ITR – grau de utilização', `GU declarado (${g.decl}) bem acima do estimado por satélite (${g.est})`, 'Documentar o uso declarado (notas, GTA, contratos) ou retificar a DITR');
    for (const k of ['app', 'rl', 'utilizada', 'areaTotal']) { const l = ach(k); if (l && l.ruim) add(2, 'ITR declarado × satélite', `${l.rot}: ${l.decl} declarados × ${l.est} estimados`, 'Conferir a área com o CAR, o ADA e a imagem de satélite; retificar a DITR se a declaração estiver errada'); }
    return N;
}
