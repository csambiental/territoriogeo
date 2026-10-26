"""Licenças ambientais vigentes (consulta pública do IAT) em Londrina -> lista para o painel + pontos localizados
pela outorga de água do mesmo empreendimento (SIGARH). Uso: processar_licencas.py planilha.xlsx outorgas.geojson [outorgas2.geojson ...]"""
import openpyxl, sys, json, re, unicodedata, datetime, collections
planilha, outorgas = sys.argv[1], sys.argv[2:]
HOJE = datetime.date.today()
def norm(t):
    t = unicodedata.normalize('NFD', str(t or '')).encode('ascii', 'ignore').decode().upper()
    t = re.sub(r'\b(LTDA|ME|EPP|EIRELI|S/?A|S\.A\.|LIMITADA|SOCIEDADE ANONIMA)\b', '', t)
    return re.sub(r'[^A-Z0-9]', '', t)
GRUPO = {'LO': 'Licença de Operação', 'RLO': 'Licença de Operação', 'LOR': 'Licença de Operação', 'LO-A': 'Licença de Operação', 'LO-C': 'Licença de Operação',
         'LAS': 'Licença Simplificada', 'RLAS': 'Licença Simplificada', 'LASR': 'Licença Simplificada', 'LAS-A': 'Licença Simplificada',
         'LAC': 'Licença por Adesão e Compromisso', 'RLAC': 'Licença por Adesão e Compromisso',
         'LP': 'Licença Prévia / de Instalação', 'LP-A': 'Licença Prévia / de Instalação', 'LI': 'Licença Prévia / de Instalação', 'LI-A': 'Licença Prévia / de Instalação',
         'DLAM': 'Dispensa de licenciamento', 'DLAE': 'Dispensa de licenciamento', 'AA': 'Autorização Ambiental', 'AAP': 'Autorização Ambiental'}
o = [f for arq in outorgas for f in json.load(open(arq))['features']]
idx = collections.defaultdict(list)
for f in o:
    for k in ('nm_requerente', 'nm_empreendimento', 'nome'):
        if f['properties'].get(k): idx[norm(f['properties'][k])].append(f['geometry']['coordinates'])
lista, pontos = [], []
for r in list(openpyxl.load_workbook(planilha, read_only=True).active.iter_rows(values_only=True))[1:]:
    if not r[0]: continue
    doc = str(r[1] or ''); nome = str(r[2] or '').strip()
    nome = re.sub(r'^\d{2}\.\d{3}\.\d{3}\s+', '', nome)  # MEI: tira o prefixo numérico; nome como consta na consulta pública
    try: val = datetime.datetime.strptime(str(r[9]), '%d/%m/%Y').date()
    except Exception: val = None
    situ = 'Vencida' if val and val < HOJE else ('Vence em até 6 meses' if val and (val - HOJE).days <= 183 else 'Vigente')
    reg = {'protocolo': r[0], 'nome': nome, 'atividade': r[3] or '', 'especifica': r[4] or '',
           'modalidade': r[6] or '', 'grupo': GRUPO.get(r[6], r[6] or ''), 'documento': str(r[7] or ''), 'emissao': r[8] or '', 'validade': r[9] or '', 'situacao': situ}
    coords = idx.get(norm(nome))
    if coords:
        reg['no_mapa'] = True
        c = coords[0]
        pontos.append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [round(c[0], 6), round(c[1], 6)]}, 'properties': {
            'nome': reg['nome'], 'grupo': reg['grupo'], 'Atividade': reg['atividade'], 'Atividade específica': reg['especifica'],
            'Modalidade': reg['modalidade'], 'Nº do documento': reg['documento'], 'Emissão': reg['emissao'], 'Validade': reg['validade'],
            'Protocolo': reg['protocolo'], 'Localização': 'Aproximada – ponto da outorga de água do mesmo empreendimento (SIGARH)'}})
    lista.append(reg)
lista.sort(key=lambda x: (datetime.datetime.strptime(x['validade'], '%d/%m/%Y') if x['validade'] else datetime.datetime.max))
json.dump({'atualizado': HOJE.strftime('%d/%m/%Y'), 'total': len(lista), 'licencas': lista}, open('data/iat/licencas_londrina.json', 'w'), ensure_ascii=False, separators=(',', ':'))
json.dump({'type': 'FeatureCollection', 'features': pontos}, open('data/iat/licencas_localizadas.geojson', 'w'), ensure_ascii=False, separators=(',', ':'))
C = collections.Counter
print(len(lista), 'licenças;', len(pontos), 'no mapa;', C(x['grupo'] for x in lista), C(x['situacao'] for x in lista))
