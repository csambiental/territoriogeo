"""Áreas embargadas pelo IBAMA em Londrina (dados abertos – Fiscalização: termo de embargo) -> data/ibama/embargos_londrina.geojson
Nomes de pessoas físicas e CPF/CNPJ não são publicados; pessoa jurídica aparece pela razão social."""
import csv, io, json, re, urllib.request, unicodedata
from shapely import wkt
from shapely.geometry import shape, Point, mapping
from shapely.ops import transform
from pyproj import Transformer
csv.field_size_limit(10**9)
URL = 'https://stibamadadosabertosprd.blob.core.windows.net/dados-abertos/dados/TERMOS_DE_EMBARGO/TERMO_EMBARGO/termo_de_embargo.csv'
COD = '4113700'
raw = urllib.request.urlopen(urllib.request.Request(URL, headers={'User-Agent': 'Mozilla/5.0'}), timeout=600).read()
if raw[:3] == b'\xef\xbb\xbf': raw = raw[3:]
try: txt = raw.decode('utf-8')
except UnicodeDecodeError: txt = raw.decode('latin-1')
sep = ';' if txt[:3000].count(';') > txt[:3000].count(',') else ','
rows = list(csv.DictReader(io.StringIO(txt), delimiter=sep))
mun = shape(json.load(open('data/municipio_londrina.geojson'))['features'][0]['geometry']).buffer(0)
utm = Transformer.from_crs(4326, 31982, always_xy=True).transform
geo = Transformer.from_crs(31982, 4326, always_xy=True).transform
PJ = re.compile(r'\b(LTDA|S/?A|S\.A|EIRELI|ME|EPP|CIA|COMPANHIA|MUNICIPIO|PREFEITURA|ASSOCIACAO|COOPERATIVA|CONDOMINIO|EMPREENDIMENTOS?|INDUSTRIA|COMERCIO|AGROPECUARIA|CONSTRUTORA|LOTEADORA|INCORPORADORA)\b')
sa = lambda t: unicodedata.normalize('NFD', str(t or '')).encode('ascii', 'ignore').decode().upper()
num = lambda t: float(str(t or '0').replace(',', '.') or 0) if re.match(r'^-?[\d.,]+$', str(t or '').strip()) else None
def br(d):
    d = str(d or '')[:10]
    return f'{d[8:10]}/{d[5:7]}/{d[:4]}' if re.match(r'\d{4}-\d{2}-\d{2}', d) else d
feats = []; amostra_wkt = None
for r in rows:
    if (r.get('SIT_CANCELADO') or '').upper() == 'S': continue
    g = None; aproximado = False
    w = (r.get('GEOM_AREA_EMBARGADA') or '').strip()
    if w:
        try:
            g = wkt.loads(re.sub(r'^SRID=\d+;', '', w))
            amostra_wkt = amostra_wkt or w[:120]
            if abs(g.bounds[0]) > 180: g = None
        except Exception: g = None
    lon, lat = num(r.get('NUM_LONGITUDE_TAD')), num(r.get('NUM_LATITUDE_TAD'))
    if g is None and lon and lat and abs(lon) <= 180:
        g = transform(geo, transform(utm, Point(lon, lat)).buffer(60)); aproximado = True
    no_mun = str(r.get('COD_MUNICIPIO')) == COD
    if g is None or not (no_mun or g.intersects(mun)): continue
    if not g.is_valid: g = g.buffer(0)
    nome = (r.get('NOME_EMBARGADO') or '').strip()
    desemb = (r.get('SIT_DESEMBARGO') or '').upper() == 'S'
    props = {'nome': f"Embargo IBAMA nº {r.get('NUM_TAD')}{(' ' + r.get('SER_TAD')) if r.get('SER_TAD') else ''}",
             'situacao': 'Desembargado' if desemb else 'Embargo vigente',
             'Data do embargo': br(r.get('DAT_EMBARGO')),
             'Embargado': nome if PJ.search(sa(nome)) else 'Pessoa física (consultar no IBAMA)',
             'Imóvel': (r.get('NOME_IMOVEL') or '').strip(), 'Área embargada (ha)': (r.get('QTD_AREA_EMBARGADA') or '').strip(),
             'Tipo de área': (r.get('TIPO_AREA') or '').strip(), 'Motivo': re.sub(r'\s+', ' ', (r.get('DES_TAD') or '').strip())[:400],
             'Auto de infração': (r.get('NUM_AUTO_INFRACAO') or '').strip(), 'Processo': (r.get('NUM_PROCESSO') or '').strip(),
             'Desembargo': (br(r.get('DAT_DESEMBARGO')) + ' – ' + (r.get('TIPO_DESEMBARGO') or '')).strip(' –') if desemb else '',
             'Localização': 'Aproximada – ponto do termo (raio de 60 m)' if aproximado else 'Polígono da área embargada',
             'link': 'https://servicos.ibama.gov.br/ctf/publico/areasembargadas/ConsultaPublicaAreasEmbargadas.php', 'link_texto': 'Consulta pública de áreas embargadas (IBAMA) ↗'}
    feats.append({'type': 'Feature', 'geometry': mapping(g), 'properties': {k: v for k, v in props.items() if v}})
json.dump({'type': 'FeatureCollection', 'features': feats}, open('data/ibama/embargos_londrina.geojson', 'w'), ensure_ascii=False, separators=(',', ':'))
from collections import Counter
print('linhas Brasil', len(rows), '| Londrina', len(feats), Counter(f['properties']['situacao'] for f in feats), Counter(f['properties']['Localização'][:10] for f in feats))
print('amostra WKT:', amostra_wkt)
