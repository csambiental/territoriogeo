"""Outorgas oficiais do SIGARH (IAT) em Londrina -> duas camadas: área rural (dentro de imóvel do CAR) e urbana/fora do CAR.
Uso: processar_outorgas.py outorgas_brutas.geojson"""
import json, sys, re, datetime, unicodedata
from collections import Counter
from shapely.geometry import shape, Point
from shapely.strtree import STRtree
bruto = json.load(open(sys.argv[1]))['features']
VALIDAS = {'DEFERIDA', 'EM RENOVAÇÃO', 'EM REGULARIZAÇÃO'}
GRUPO = {'CSUB': 'Poço (água subterrânea)', 'CSUP': 'Captação superficial', 'LANC': 'Lançamento de efluentes'}
def grupo(p):
    t = (p.get('nm_tipo_interferencia') or '').lower()
    if 'subterr' in t: return 'Poço (água subterrânea)'
    if 'captação superficial' in t: return 'Captação superficial'
    if 'lançamento' in t: return 'Lançamento de efluentes'
    if 'barragem' in t: return 'Barragem / soleira'
    return 'Obras e intervenções em rios'
EMPRESA = re.compile(r'\b(LTDA|S/?A|S\.A|CIA|COMPANHIA|CONDOMINIO|EDIFICIO|RESIDENCIAL|ASSOCIACAO|PREFEITURA|MUNICIPIO|UNIVERSIDADE|INSTITUTO|IGREJA|PAROQUIA|EMPREENDIMENTOS?|INDUSTRIA|COMERCIO|COOPERATIVA|FUNDACAO|HOSPITAL|ESCOLA|COLEGIO|CLUBE|SANEAMENTO|SANEPAR|AUTARQUIA|EIRELI|EPP|ME|MINERACAO|ENERGIA|CONSTRUTORA|INCORPORADORA|LOTEAMENTO|SHOPPING|SUPERMERCADO|POSTO|FRIGORIFICO|AGROPECUARIA|AGRICOLA|AGROINDUSTRIAL|LATICINIO|TRANSPORTES?|LOGISTICA|SERVICOS|ENGENHARIA|HOTEL|ESTADO|SECRETARIA|DEPARTAMENTO|CENTRO|SOCIEDADE|MITRA|SINDICATO|GRUPO|HOLDING|PARTICIPACOES)\b')
def sem_acento(t): return unicodedata.normalize('NFD', t or '').encode('ascii', 'ignore').decode().upper()
def nome(p):
    r = (p.get('nm_requerente') or '').strip()
    return r or 'Titular não informado'  # nome como consta na consulta pública do SIGARH
dt = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime('%d/%m/%Y') if isinstance(ms, (int, float)) else ''
def vazao(p):
    v = [p.get(k) for k in p if k.startswith('vlr_vazao_capt_lanc_') and isinstance(p.get(k), (int, float))]
    return max(v) if v else None
import os
# área urbana = dentro dos perímetros urbanos oficiais (IPPUL, Lei 13.718/2023); sem o arquivo, usa os imóveis do CAR
PERIM = 'data/urbano/perimetros_urbanos.geojson'
if os.path.exists(PERIM):
    per = [shape(f['geometry']).buffer(0) for f in json.load(open(PERIM))['features']]
    parv = STRtree(per)
    def rural_pt(pt): return not any(per[i].contains(pt) for i in parv.query(pt))
    ROT = ('Rural – fora do perímetro urbano', 'Urbana – dentro do perímetro urbano (IPPUL)')
else:
    imv = [shape(f['geometry']) for f in json.load(open('data/car/imoveis_londrina.geojson'))['features']]
    arv = STRtree(imv)
    def rural_pt(pt): return any(imv[i].contains(pt) for i in arv.query(pt))
    ROT = ('Rural – dentro de imóvel do CAR', 'Urbana / fora de imóvel do CAR')
rural, urbana = [], []
for f in bruto:
    p = f['properties']
    if p.get('st_portaria') not in VALIDAS or (p.get('nm_tipo_solicitacao') or '').startswith('Desativa'): continue
    pt = Point(f['geometry']['coordinates'][:2])
    dentro = rural_pt(pt)
    vz = vazao(p)
    corpo = p.get('nm_corpo_hidrico_popular') or p.get('nm_tipo_corpo_hidrico') or (p.get('nm_aquifero') if 'subterr' in (p.get('nm_tipo_interferencia') or '').lower() else '')
    props = {'nome': nome(p), 'grupo': grupo(p),
             'Interferência': p.get('nm_tipo_interferencia') or '', 'Documento': p.get('nm_tipo_documento') or '', 'Portaria / declaração': p.get('nr_portaria') or '',
             'Situação': (p.get('st_portaria') or '').capitalize(), 'Setor do usuário': p.get('nm_tipo_usuario') or '',
             'Finalidade': (p.get('desc_finalidades') or '').replace(',', ', '), 'Corpo hídrico / aquífero': corpo or '',
             'Vazão máxima (m³/h)': f'{vz:.2f}'.replace('.', ',') if vz else '', 'Publicação': dt(p.get('dt_publicacao')), 'Vencimento': dt(p.get('dt_vencimento')),
             'Bacia (comitê)': p.get('nm_comite') or '', 'Área': ROT[0] if dentro else ROT[1]}
    feat = {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [round(c, 6) for c in f['geometry']['coordinates'][:2]]}, 'properties': props}
    (rural if dentro else urbana).append(feat)
for nome_arq, fs in (('outorgas_rural', rural), ('outorgas_urbana', urbana)):
    json.dump({'type': 'FeatureCollection', 'features': fs}, open(f'data/iat/{nome_arq}.geojson', 'w'), ensure_ascii=False, separators=(',', ':'))
print('rural', len(rural), Counter(x['properties']['grupo'] for x in rural))
print('urbana', len(urbana), Counter(x['properties']['grupo'] for x in urbana))
print('pessoa física', sum(1 for x in rural + urbana if not EMPRESA.search(sem_acento(x['properties']['nome']))))
