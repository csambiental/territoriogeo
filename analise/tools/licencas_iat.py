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
         'LPI': 'Licença Prévia / de Instalação', 'DLAM': 'Dispensa de licenciamento', 'DLAE': 'Dispensa de licenciamento', 'AA': 'Autorização Ambiental', 'AAP': 'Autorização Ambiental'}
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


def especificas_sga(nome_mun):
    """protocolo -> atividade específica, pela consulta pública do SGA (o CPF/CNPJ que vem junto é descartado)."""
    try:
        txt = http(f'{SGA}?action=listaMunicipioPorUFAjax&estadoMunicipioCombo=PR&page=1&start=0&limit=500', txt=True)
        alvo = sem_acento(nome_mun)
        ids = [int(m.group(1)) for m in re.finditer(r'idMunicipioCorreios:(\d+),nomeMunicipio:"([^"]+)"', txt) if sem_acento(m.group(2)) == alvo]
        if not ids:
            ids = [int(a) for a, b in re.findall(r'"?idMunicipioCorreios"?\s*:\s*(\d+)\s*,\s*"?nomeMunicipio"?\s*:\s*"([^"]+)"', txt) if sem_acento(b) == alvo]
        if not ids: print('  SGA: município não encontrado'); return {}
        out, pag = {}, 1
        while True:
            t = http(f'{SGA}?action=consultarProcessoLicenciamento&estadoMunicipioCombo=PR&municipioCombo={ids[0]}&page={pag}&start={(pag - 1) * 500}&limit=500', txt=True)
            reg = re.findall(r'descAtividadeEspecifica:"((?:[^"\\]|\\.)*)".*?numProtocolo:(\d+)', t)
            for esp, prot in reg: out[int(prot)] = esp.replace('\\"', '"')
            if len(reg) < 500: break
            pag += 1
        return out
    except Exception as e:
        print('  SGA indisponível:', e); return {}


def gerar(cod, pasta, nome_geo='licencas.geojson', nome_lista='licencas.json'):
    regs = baixar_geopr(cod)
    nome_mun = (regs[0]['nome_municipio'] if regs else '')
    esp = especificas_sga(nome_mun) if regs else {}
    print(f'  GeoPR: {len(regs)} licenças; SGA: {len(esp)} com atividade específica')
    pontos, lista, coords = [], [], collections.Counter()
    for r in regs:
        if r.get('x') and r.get('y'): coords[(round(r['x'], 4), round(r['y'], 4))] += 1
    for r in regs:
        sig = (r.get('sigla_modalidade') or '').strip()
        em, va = data(r.get('dt_emissao')), data(r.get('dt_validade'))
        situ = 'Vencida' if va and va < HOJE else ('Vence em até 6 meses' if va and (va - HOJE).days <= 183 else 'Vigente')
        prot = proto_fmt(r['num_protocolo']); sia = str(r.get('ind_sia')).lower() == 'true'
        link = f"{SGA}?action=exibirDadosPublicoLicenca&numProtocolo={r['num_protocolo']}&indSia={'true' if sia else 'false'}&ucsChamador=carregarInterfaceInicial"
        reg = {'protocolo': prot, 'nome': (r.get('nome_razao_social') or '').strip(), 'atividade': r.get('desc_atividade') or r.get('desc_grupo_atividade') or '',
               'especifica': esp.get(int(r['num_protocolo']), ''), 'modalidade': sig, 'grupo': GRUPO.get(sig, r.get('desc_modalidade') or sig),
               'documento': doc_fmt(r.get('num_documento')), 'emissao': em.strftime('%d/%m/%Y') if em else '', 'validade': va.strftime('%d/%m/%Y') if va else '',
               'situacao': situ, 'link': link}
        x, y = r.get('x'), r.get('y')
        if x and y and -27 < y < -22 and -55 < x < -48:
            reg['no_mapa'] = True
            repetido = coords[(round(x, 4), round(y, 4))]
            pontos.append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [round(x, 6), round(y, 6)]}, 'properties': {
                'nome': reg['nome'], 'grupo': reg['grupo'], 'situacao': situ, 'Atividade': reg['atividade'], 'Atividade específica': reg['especifica'],
                'Grupo de atividade': r.get('desc_grupo_atividade') or '', 'Modalidade': f"{sig} – {r.get('desc_modalidade') or ''}".strip(' –'),
                'Nº do documento': reg['documento'], 'Emissão': reg['emissao'], 'Validade': reg['validade'], 'Situação': situ, 'Protocolo': prot,
                'Sistema': 'SIA' if sia else 'SGA',
                'Localização': 'Coordenada do empreendimento cadastrada no licenciamento (IAT)' + (f' – ponto compartilhado por {repetido} licenças' if repetido > 3 else ''),
                'link': link, 'link_texto': 'Abrir a licença no SGA (PDF) ↗'}})
        lista.append(reg)
    ordem = lambda x: datetime.datetime.strptime(x['validade'], '%d/%m/%Y') if x['validade'] else datetime.datetime.max
    lista.sort(key=lambda x: (x['situacao'] == 'Vencida', ordem(x)))
    os.makedirs(pasta, exist_ok=True)
    json.dump({'type': 'FeatureCollection', 'features': pontos}, open(os.path.join(pasta, nome_geo), 'w'), ensure_ascii=False, separators=(',', ':'))
    json.dump({'atualizado': HOJE.strftime('%d/%m/%Y'), 'total': len(lista), 'licencas': lista}, open(os.path.join(pasta, nome_lista), 'w'), ensure_ascii=False, separators=(',', ':'))
    C = collections.Counter
    print(f'  {len(lista)} licenças, {len(pontos)} no mapa;', dict(C(x["situacao"] for x in lista)), dict(C(x["grupo"] for x in lista).most_common(8)))
    print('  pontos mais repetidos:', coords.most_common(3))
    return len(lista), len(pontos)


if __name__ == '__main__':
    gerar(sys.argv[1], sys.argv[2], *(sys.argv[3:5]))
