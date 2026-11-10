"""Licenças ambientais do IAT (SGA e SIA) de um município, com a localização oficial do empreendimento.

Fontes:
- GeoPR/IAT, camada "Licenciamento Ambiental - Paraná" (licenças do SGA e SIA com coordenadas x/y);
- SGA, consulta pública de licenciamento (atividade específica), quando disponível.
O CPF/CNPJ NUNCA é baixado nem gravado. O titular aparece como consta na consulta pública do SGA.
O PDF da licença fica na consulta pública do SGA (protegido por CAPTCHA): o mapa leva o usuário até a página da licença.

Uso: python3 licencas_iat.py <cod_ibge> <pasta_saida> [prefixo_arquivos]
Gera <pasta>/licencas.geojson (pontos) e <pasta>/licencas.json (lista para o painel).
"""
import json, sys, ssl, re, datetime, urllib.request, urllib.parse, collections, os, unicodedata

CAMADA = 'https://geopr.iat.pr.gov.br/server/rest/services/00_PUBLICACOES/licenciamento_ambiental_pr/FeatureServer/0'
CAMPOS = ['num_protocolo', 'nome_razao_social', 'cod_ibge', 'nome_municipio', 'sigla_modalidade', 'desc_modalidade',
          'desc_grupo_atividade', 'desc_atividade', 'num_documento', 'dt_emissao', 'dt_validade', 'ind_sia', 'x', 'y']  # sem cpf_cnpj
SGA = 'https://www.sga.pr.gov.br/sga-iap/consultarProcessoLicenciamento.do'
GRUPO = {'LO': 'Licença de Operação', 'RLO': 'Licença de Operação', 'LOR': 'Licença de Operação', 'LO-A': 'Licença de Operação', 'LO-C': 'Licença de Operação',
         'LAS': 'Licença Simplificada', 'RLAS': 'Licença Simplificada', 'LASR': 'Licença Simplificada', 'LAS-A': 'Licença Simplificada',
         'LAC': 'Licença por Adesão e Compromisso', 'RLAC': 'Licença por Adesão e Compromisso',
         'LP': 'Licença Prévia / de Instalação', 'LP-A': 'Licença Prévia / de Instalação', 'LI': 'Licença Prévia / de Instalação', 'LI-A': 'Licença Prévia / de Instalação',
         'LPI': 'Licença Prévia / de Instalação', 'RLI': 'Licença Prévia / de Instalação', 'CP': 'Licença Prévia / de Instalação', 'DLAM': 'Dispensa de licenciamento', 'DLAE': 'Dispensa de licenciamento', 'DILA': 'Dispensa de licenciamento', 'DIL': 'Dispensa de licenciamento', 'AA': 'Autorização Ambiental', 'AAP': 'Autorização Ambiental'}
CTX = ssl.create_default_context(); CTX.set_ciphers('DEFAULT@SECLEVEL=0'); CTX.options |= 0x4
HOJE = datetime.date.today()


def http(url, dados=None, txt=False):
    for t in range(4):
        try:
            r = urllib.request.urlopen(urllib.request.Request(url, data=dados, headers={'User-Agent': 'Mozilla/5.0 (csambiental)'}), timeout=120, context=CTX).read()
            return r.decode('utf-8', 'replace') if txt else json.loads(r)
        except Exception as e:
            if t == 3: raise
            print('  nova tentativa', url[:90], e)


def data(ms):
    if not isinstance(ms, (int, float)): return None
    return (datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc) - datetime.timedelta(hours=3)).date()


def proto_fmt(n):
    s = str(n).rjust(9, '0'); return f'{s[:2]}.{s[2:5]}.{s[5:8]}-{s[8:]}'


def doc_fmt(n):
    try: return f'{int(n):,}'.replace(',', '.')
    except Exception: return str(n or '')


def sem_acento(t):
    return unicodedata.normalize('NFD', t or '').encode('ascii', 'ignore').decode().upper()


def baixar_geopr(cod):
    fs, off = [], 0
    while True:
        q = {'where': f'cod_ibge={int(cod)}', 'outFields': ','.join(CAMPOS), 'returnGeometry': 'false', 'f': 'json',
             'resultOffset': off, 'resultRecordCount': 2000, 'orderByFields': 'objectid'}
        d = http(CAMADA + '/query', urllib.parse.urlencode(q).encode())
        if 'error' in d: raise RuntimeError(d['error'])
        lote = [x['attributes'] for x in d.get('features', [])]
        fs += lote; off += len(lote)
        if not lote or not d.get('exceededTransferLimit'): break
    return fs


def _js_para_json(t):
    i = t.index('['); t = t[i:t.rindex(']') + 1]
    t = re.sub(r'([{,])\s*([A-Za-z_]\w*)\s*:', r'\1"\2":', t)
    return json.loads(t)


def lista_sga(nome_mun):
    """Licenças da consulta pública do SGA (as que o SGA mostra como vigentes). O CPF/CNPJ é descartado na leitura."""
    try:
        txt = http(f'{SGA}?action=listaMunicipioPorUFAjax&estadoMunicipioCombo=PR&page=1&start=0&limit=500', txt=True)
        alvo = sem_acento(nome_mun)
        ids = [int(a) for a, b in re.findall(r'"?idMunicipioCorreios"?\s*:\s*(\d+)\s*,\s*"?nomeMunicipio"?\s*:\s*"([^"]+)"', txt) if sem_acento(b) == alvo]
        if not ids: print('  SGA: município não encontrado'); return []
        out, pag = [], 1
        while True:
            t = http(f'{SGA}?action=consultarProcessoLicenciamento&estadoMunicipioCombo=PR&municipioCombo={ids[0]}&page={pag}&start={(pag - 1) * 500}&limit=500', txt=True)
            regs = _js_para_json(t)
            for r in regs: r.pop('cpfCnpj', None)
            out += regs
            if len(regs) < 500: break
            pag += 1
        return out
    except Exception as e:
        print('  SGA indisponível:', e); return []


def chave_nome(t):
    t = sem_acento(t); t = re.sub(r'\b(LTDA|ME|EPP|EIRELI|S/?A|LIMITADA)\b', '', t); return re.sub(r'[^A-Z0-9]', '', t)


def gerar(cod, pasta, nome_geo='licencas.geojson', nome_lista='licencas.json'):
    geo = baixar_geopr(cod)
    nome_mun = geo[0]['nome_municipio'] if geo else ''
    sga = lista_sga(nome_mun) if nome_mun else []
    print(f'  GeoPR: {len(geo)} licenças (com histórico); SGA consulta pública: {len(sga)}')
    por_prot = {}
    for r in geo:
        por_prot[int(r['num_protocolo'])] = {'prot': int(r['num_protocolo']), 'nome': (r.get('nome_razao_social') or '').strip(), 'sig': (r.get('sigla_modalidade') or '').strip(),
            'mod': r.get('desc_modalidade') or '', 'grupo_ativ': r.get('desc_grupo_atividade') or '', 'ativ': r.get('desc_atividade') or '', 'esp': '',
            'doc': r.get('num_documento'), 'em': data(r.get('dt_emissao')), 'va': data(r.get('dt_validade')), 'sia': str(r.get('ind_sia')).lower() == 'true', 'x': r.get('x'), 'y': r.get('y')}
    novos = 0
    for r in sga:
        p = int(r['numProtocolo']); d = por_prot.get(p)
        if not d:
            novos += 1
            d = por_prot[p] = {'prot': p, 'nome': (r.get('nomeRazaoSocial') or '').strip(), 'sig': r.get('siglaModalidade') or '', 'mod': '', 'grupo_ativ': '',
                               'ativ': r.get('descAtividade') or '', 'esp': '', 'doc': r.get('numDocumento'), 'em': data(r.get('dtDecisao')), 'va': data(r.get('dtValidade')),
                               'sia': bool(r.get('indSia')), 'x': None, 'y': None}
        d['esp'] = r.get('descAtividadeEspecifica') or d['esp']
        d['no_sga'] = True
    print(f'  {novos} licenças só no SGA (sem coordenada no GeoPR)')
    # pontos genéricos: muitas licenças de titulares diferentes no mesmo ponto (ex.: centro da cidade)
    tit = collections.defaultdict(set)
    for d in por_prot.values():
        if d['x'] and d['y']: tit[(round(d['x'], 4), round(d['y'], 4))].add(chave_nome(d['nome']))
    genericos = {k for k, v in tit.items() if len(v) >= 5}
    # licenças vencidas substituídas por outra mais recente do mesmo titular e atividade
    grupos = collections.defaultdict(list)
    for d in por_prot.values(): grupos[(chave_nome(d['nome']), sem_acento(d['ativ']))].append(d)
    pontos, lista = [], []
    for d in por_prot.values():
        va, em = d['va'], d['em']
        mais_nova = max((o['em'] for o in grupos[(chave_nome(d['nome']), sem_acento(d['ativ']))] if o['em']), default=None)
        if va and va < HOJE:
            situ = 'Vencida (substituída por licença mais recente)' if mais_nova and em and mais_nova > em else 'Vencida'
        else:
            situ = 'Vence em até 6 meses' if va and (va - HOJE).days <= 183 else 'Vigente'
        sig = d['sig']; prot = proto_fmt(d['prot'])
        link = f"{SGA}?action=exibirDadosPublicoLicenca&numProtocolo={d['prot']}&indSia={'true' if d['sia'] else 'false'}&ucsChamador=carregarInterfaceInicial"
        reg = {'protocolo': prot, 'nome': d['nome'], 'atividade': d['ativ'] or d['grupo_ativ'], 'especifica': d['esp'], 'modalidade': sig, 'grupo': GRUPO.get(sig, d['mod'] or sig),
               'documento': doc_fmt(d['doc']), 'emissao': em.strftime('%d/%m/%Y') if em else '', 'validade': va.strftime('%d/%m/%Y') if va else '', 'situacao': situ, 'link': link}
        x, y = d['x'], d['y']
        k = (round(x, 4), round(y, 4)) if x and y else None
        if k and k not in genericos and -27 < y < -22 and -55 < x < -48 and 'substituída' not in situ:
            reg['no_mapa'] = True
            pontos.append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [round(x, 6), round(y, 6)]}, 'properties': {
                'nome': reg['nome'], 'grupo': reg['grupo'], 'situacao': situ, 'Modalidade': f"{sig} – {d['mod']}".strip(' –') if d['mod'] else sig, 'Situação': situ,
                'Atividade': reg['atividade'], 'Atividade específica': reg['especifica'], 'Grupo de atividade': d['grupo_ativ'],
                'Nº do documento': reg['documento'], 'Emissão': reg['emissao'], 'Validade': reg['validade'], 'Protocolo': prot, 'Sistema': 'SIA' if d['sia'] else 'SGA',
                'Localização': 'Coordenada do empreendimento cadastrada no licenciamento (IAT)', 'link': link, 'link_texto': 'Abrir a licença no SGA (PDF) ↗'}})
        elif k in genericos: reg['localizacao'] = 'sem coordenada própria (ponto genérico no cadastro)'
        lista.append(reg)
    ordem = lambda x: datetime.datetime.strptime(x['validade'], '%d/%m/%Y') if x['validade'] else datetime.datetime.max
    peso = {'Vence em até 6 meses': 0, 'Vigente': 1, 'Vencida': 2}
    lista.sort(key=lambda x: (peso.get(x['situacao'], 3), ordem(x)))
    os.makedirs(pasta, exist_ok=True)
    json.dump({'type': 'FeatureCollection', 'features': pontos}, open(os.path.join(pasta, nome_geo), 'w'), ensure_ascii=False, separators=(',', ':'))
    json.dump({'atualizado': HOJE.strftime('%d/%m/%Y'), 'total': len(lista), 'licencas': lista}, open(os.path.join(pasta, nome_lista), 'w'), ensure_ascii=False, separators=(',', ':'))
    C = collections.Counter
    print(f'  {len(lista)} licenças, {len(pontos)} no mapa; pontos genéricos: {len(genericos)};', dict(C(x["situacao"] for x in lista)))
    print('  grupos:', dict(C(x["grupo"] for x in lista).most_common(10)))
    return len(lista), len(pontos)


if __name__ == '__main__':
    gerar(sys.argv[1], sys.argv[2], *(sys.argv[3:5]))
