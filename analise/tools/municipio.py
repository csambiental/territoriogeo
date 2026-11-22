"""Pipeline de um município do Paraná para a Análise Rural (Raio-X do imóvel).
Uso: python3 tools/municipio.py <código IBGE>   (rodar dentro da pasta analise/)
Gera tudo em data/m/<código>/ e o config.json do município. Cada etapa é independente: se uma falhar, as outras seguem.
Fontes: IBGE (limite), SICAR (CAR), IAT/INCRA (SIGEF), IBAMA (embargos), MapBiomas (uso do solo e alertas),
IAT (outorgas SIGARH e barragens), ANA/SNIRH (microbacias), Copernicus DEM (declividade e curvas de nível)."""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
import nomes_rios, ssl_aia
import json, os, sys, re, io, csv, time, datetime, unicodedata, traceback, subprocess, urllib.request, urllib.parse
from collections import Counter, defaultdict
import numpy as np
from shapely.geometry import shape, mapping, Point, Polygon, MultiPolygon
from shapely.ops import unary_union, transform
from shapely.strtree import STRtree
from shapely import wkt

COD = sys.argv[1].strip()
# limites municipais do PR: IBGE (pode bloquear acesso de fora do Brasil) com reserva no geodata-br (malha IBGE)
def _malha_pr():
    cache = '/tmp/pr_municipios.json'
    if os.path.exists(cache): return json.load(open(cache))
    for url in ('https://raw.githubusercontent.com/tbrugz/geodata-br/master/geojson/geojs-41-mun.json',):
        try:
            g = json.load(urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'csambiental'}), timeout=120))
            json.dump(g, open(cache, 'w')); return g
        except Exception as e: print('malha falhou', url, e, flush=True)
    return {'features': []}
_sa = lambda t: unicodedata.normalize('NFD', t).encode('ascii', 'ignore').decode().lower().strip()
MALHA = _malha_pr()
if not COD.isdigit():
    COD = next(str(f['properties']['id']) for f in MALHA['features'] if _sa(f['properties']['name']) == _sa(COD))
D = f'data/m/{COD}'
os.makedirs(D, exist_ok=True)
UA = {'User-Agent': 'csambiental-analise-rural'}
import ssl
SSL_LEGADO = ssl.create_default_context()
SSL_LEGADO.set_ciphers('DEFAULT@SECLEVEL=0')
SSL_LEGADO.options |= getattr(ssl, 'OP_LEGACY_SERVER_CONNECT', 0x4)
SSL_LEGADO.minimum_version = ssl.TLSVersion.TLSv1
def log(*a): print(*a, flush=True)
def http(url, dados=None, tent=5, timeout=180, raw=False):
    for t in range(tent):
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode(dados).encode() if dados else None, headers=UA)
            r = urllib.request.urlopen(req, timeout=timeout, context=SSL_LEGADO if 'car.gov.br' in url else ssl_aia.contexto(url) if 'anm.gov.br' in url else None).read()
            return r if raw else json.loads(r)
        except Exception as e:
            log('  tentativa', t + 1, str(e)[:200]); time.sleep(10 * (t + 1))
    raise RuntimeError('falhou ' + url[:200])
def salvar(nome, feats, **extra):
    json.dump({'type': 'FeatureCollection', **extra, 'features': feats}, open(f'{D}/{nome}', 'w'), ensure_ascii=False, separators=(',', ':'))
def arred(o, n=6):
    if isinstance(o, float): return round(o, n)
    if isinstance(o, (list, tuple)): return [arred(x, n) for x in o]
    if isinstance(o, dict): return {k: arred(v, n) for k, v in o.items()}
    return o
br = lambda v: f'{v:,.2f}'.replace(',', 'X').replace('.', ',').replace('X', '.')
num = lambda t: float(str(t or '0').replace('.', '').replace(',', '.') or 0)
def etapa(nome):
    def dec(fn):
        def run():
            log(f'\n===== {nome} ====='); t0 = time.time()
            try: fn(); log(f'----- {nome} ok ({time.time() - t0:.0f}s)')
            except Exception: traceback.print_exc(); log(f'----- {nome} FALHOU')
        return run
    return dec

# ---------- 0) limite e nome do município ----------
_f = next((f for f in MALHA['features'] if str(f['properties']['id']) == COD), None)
NOME = _f['properties']['name'] if _f else COD
log('Município', COD, NOME)
if not os.path.exists(f'{D}/municipio.geojson'):
    g = None
    try: g = http(f'https://servicodados.ibge.gov.br/api/v3/malhas/municipios/{COD}?formato=application/vnd.geo%2Bjson&qualidade=maxima', tent=2, timeout=40); log('limite: IBGE')
    except Exception: log('limite: IBGE indisponível, usando geodata-br (malha IBGE)')
    if not g: g = {'type': 'FeatureCollection', 'features': [_f]}
    for f in g['features']: f['properties'] = {'nome': NOME, 'codigo_ibge': COD}
    json.dump(g, open(f'{D}/municipio.geojson', 'w'), ensure_ascii=False)
MUN = unary_union([shape(f['geometry']) for f in json.load(open(f'{D}/municipio.geojson'))['features']]).buffer(0)
MINX, MINY, MAXX, MAXY = MUN.bounds
HA = lambda g: g.area * (111320 * np.cos(np.radians(MUN.centroid.y))) * 110574 / 1e4

# ---------- 1) CAR (SICAR, WFS público) ----------
SIT = [('cancel', 'Cancelado'), ('conformidade', 'Analisado – em conformidade'), ('regular', 'Analisado – em conformidade'),
       ('notifica', 'Analisado – notificação pendente'), ('pendente', 'Analisado – regularização ambiental pendente'),
       ('regulariza', 'Analisado – regularização ambiental pendente'), ('em análise', 'Em análise'), ('em analise', 'Em análise'),
       ('aguardando', 'Aguardando análise')]
STATUS = {'AT': 'Ativo', 'PE': 'Pendente', 'SU': 'Suspenso', 'CA': 'Cancelado'}
TIPO = {'IRU': 'Imóvel rural', 'AST': 'Assentamento', 'PCT': 'Povos e comunidades tradicionais'}
@etapa('CAR')
def car():
    base = 'https://geoserver.car.gov.br/geoserver/sicar/wfs'
    q = {'service': 'WFS', 'version': '1.0.0', 'request': 'GetFeature', 'typeName': 'sicar:sicar_imoveis_pr', 'outputFormat': 'application/json',
         'srsName': 'EPSG:4326', 'CQL_FILTER': f'cod_municipio_ibge={COD}'}
    feats = http(base + '?' + urllib.parse.urlencode(q), timeout=600).get('features', [])
    log('  CAR baixados', len(feats))
    out = []
    for f in feats:
        p = f['properties']; g = shape(f['geometry']).buffer(0)
        cond = p.get('condicao') or ''
        sit = 'Cancelado' if p.get('status_imovel') == 'CA' else next((v for k, v in SIT if k in cond.lower()), 'Aguardando análise')
        mf = p.get('m_fiscal') or 0
        dt = (p.get('dat_criacao') or '')[:10]
        out.append({'type': 'Feature', 'geometry': mapping(g.simplify(0.00001, preserve_topology=True)), 'properties': {
            'nome': p.get('cod_imovel'), 'situacao': sit, 'Área (ha)': br(p.get('area') or HA(g)), 'Módulos fiscais': br(mf),
            'Status do CAR': STATUS.get(p.get('status_imovel'), p.get('status_imovel') or ''), 'Condição': cond,
            'Tipo': TIPO.get(p.get('tipo_imovel'), p.get('tipo_imovel') or ''), 'Data de cadastro/atualização': '/'.join(reversed(dt.split('-'))) if dt else '',
            'Porte': 'Pequena (até 4 MF)' if mf <= 4 else 'Média (4 a 15 MF)' if mf <= 15 else 'Grande (acima de 15 MF)'}})
    json.dump(arred({'type': 'FeatureCollection', 'features': out}), open(f'{D}/car.geojson', 'w'), ensure_ascii=False, separators=(',', ':'))
    log('imóveis', len(out), Counter(x['properties']['situacao'] for x in out), Counter(x['properties'].get('Condição') for x in out).most_common(8))

# ---------- 2) SIGEF/INCRA (serviço do IAT) ----------
@etapa('SIGEF')
def sigef():
    URL = 'https://geopr.iat.pr.gov.br/server/rest/services/00_PUBLICACOES/imoveis_certificados_sigef_incra/FeatureServer/0/query'
    feats, off = [], 0
    while True:
        q = {'where': '1=1', 'geometry': f'{MINX},{MINY},{MAXX},{MAXY}', 'geometryType': 'esriGeometryEnvelope', 'inSR': '4326',
             'spatialRel': 'esriSpatialRelIntersects', 'outSR': '4326', 'returnZ': 'false', 'returnM': 'false',
             'outFields': 'parcela_co,codigo_imo,situacao_i,status,nome_area,registro_m,data_submi,data_aprov', 'f': 'geojson', 'resultOffset': off, 'resultRecordCount': 1000}
        d = http(URL, q)
        fs = d.get('features', []); feats += fs
        if len(fs) < 1000 and not d.get('exceededTransferLimit') and not (d.get('properties') or {}).get('exceededTransferLimit'): break
        off += len(fs)
    data = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime('%d/%m/%Y') if isinstance(ms, (int, float)) else (ms or '')
    out = []
    for f in feats:
        if not f.get('geometry'): continue
        g = shape(f['geometry']).buffer(0)
        if not g.intersects(MUN) or g.intersection(MUN).area < 0.5 * g.area: continue
        p = f['properties']
        out.append({'type': 'Feature', 'geometry': mapping(g.simplify(0.00002, preserve_topology=True)), 'properties': {
            'nome': p.get('nome_area') or 'Imóvel certificado', 'Código SNCR (INCRA)': p.get('codigo_imo') or '', 'Parcela SIGEF': p.get('parcela_co') or '',
            'Situação': {'REGISTRADA': 'Registrada', 'NAO_TITULADA': 'Não titulada', 'TITULADA_NAO_REGISTRADA': 'Titulada, não registrada'}.get(p.get('situacao_i'), p.get('situacao_i') or ''),
            'Status': (p.get('status') or '').capitalize(), 'Matrícula / registro': p.get('registro_m') or '',
            'Enviado em': data(p.get('data_submi')), 'Certificado em': data(p.get('data_aprov')), 'Área (ha)': br(HA(g)),
            'link': f"https://sigef.incra.gov.br/geo/parcela/detalhe/{p.get('parcela_co')}/" if p.get('parcela_co') else '', 'link_texto': 'Ver a parcela no SIGEF ↗'}})
    json.dump(arred({'type': 'FeatureCollection', 'features': out}), open(f'{D}/sigef.geojson', 'w'), ensure_ascii=False, separators=(',', ':'))
    log('parcelas', len(out), Counter(x['properties']['Situação'] for x in out))

# ---------- 3) embargos do IBAMA ----------
@etapa('IBAMA')
def ibama():
    from pyproj import Transformer
    csv.field_size_limit(10**9)
    cache = '/tmp/termo_de_embargo.csv'
    if not os.path.exists(cache):
        open(cache, 'wb').write(http('https://stibamadadosabertosprd.blob.core.windows.net/dados-abertos/dados/TERMOS_DE_EMBARGO/TERMO_EMBARGO/termo_de_embargo.csv', raw=True, timeout=900))
    raw = open(cache, 'rb').read()
    if raw[:3] == b'\xef\xbb\xbf': raw = raw[3:]
    try: txt = raw.decode('utf-8')
    except UnicodeDecodeError: txt = raw.decode('latin-1')
    sep = ';' if txt[:3000].count(';') > txt[:3000].count(',') else ','
    utm = Transformer.from_crs(4326, 31982, always_xy=True).transform; geo = Transformer.from_crs(31982, 4326, always_xy=True).transform
    PJ = re.compile(r'\b(LTDA|S/?A|S\.A|EIRELI|ME|EPP|CIA|COMPANHIA|MUNICIPIO|PREFEITURA|ASSOCIACAO|COOPERATIVA|CONDOMINIO|EMPREENDIMENTOS?|INDUSTRIA|COMERCIO|AGROPECUARIA|CONSTRUTORA|LOTEADORA|INCORPORADORA)\b')
    sa = lambda t: unicodedata.normalize('NFD', str(t or '')).encode('ascii', 'ignore').decode().upper()
    nm = lambda t: float(str(t or '0').replace(',', '.') or 0) if re.match(r'^-?[\d.,]+$', str(t or '').strip()) else None
    bd = lambda d: (lambda s: f'{s[8:10]}/{s[5:7]}/{s[:4]}' if re.match(r'\d{4}-\d{2}-\d{2}', s) else s)(str(d or '')[:10])
    feats = []
    for r in csv.DictReader(io.StringIO(txt), delimiter=sep):
        if (r.get('SIT_CANCELADO') or '').upper() == 'S': continue
        g = None; aprox = False
        w = (r.get('GEOM_AREA_EMBARGADA') or '').strip()
        if w:
            try:
                g = wkt.loads(re.sub(r'^SRID=\d+;', '', w))
                if abs(g.bounds[0]) > 180: g = None
            except Exception: g = None
        lon, lat = nm(r.get('NUM_LONGITUDE_TAD')), nm(r.get('NUM_LATITUDE_TAD'))
        if g is None and lon and lat and abs(lon) <= 180:
            g = transform(geo, transform(utm, Point(lon, lat)).buffer(60)); aprox = True
        if g is None or not (str(r.get('COD_MUNICIPIO')) == COD or g.intersects(MUN)): continue
        if not g.is_valid: g = g.buffer(0)
        nome = (r.get('NOME_EMBARGADO') or '').strip(); pj = bool(PJ.search(sa(nome)))
        if not pj and aprox: continue   # pessoa física sem polígono (ponto de endereço): não publica
        desemb = (r.get('SIT_DESEMBARGO') or '').upper() == 'S'
        mot = re.sub(r'\s+', ' ', (r.get('DES_TAD') or '').strip())
        if not pj and nome: mot = re.sub(re.escape(nome), '[embargado]', mot, flags=re.I)
        p = {'nome': f"Embargo IBAMA nº {r.get('NUM_TAD')}{(' ' + r.get('SER_TAD')) if r.get('SER_TAD') else ''}", 'Situação': 'Desembargado' if desemb else 'Embargo vigente',
             'Data do embargo': bd(r.get('DAT_EMBARGO')), 'Embargado': nome if pj else 'Pessoa física (consultar no IBAMA)', 'Imóvel': (r.get('NOME_IMOVEL') or '').strip(),
             'Área embargada (ha)': (r.get('QTD_AREA_EMBARGADA') or '').strip(), 'Tipo de área': (r.get('TIPO_AREA') or '').strip(), 'Motivo': mot[:400],
             'Auto de infração': (r.get('NUM_AUTO_INFRACAO') or '').strip(), 'Processo': (r.get('NUM_PROCESSO') or '').strip(),
             'Desembargo': (bd(r.get('DAT_DESEMBARGO')) + ' – ' + (r.get('TIPO_DESEMBARGO') or '')).strip(' –') if desemb else '',
             'Localização': 'Aproximada – ponto do termo (raio de 60 m)' if aprox else 'Polígono da área embargada',
             'link': 'https://servicos.ibama.gov.br/ctf/publico/areasembargadas/ConsultaPublicaAreasEmbargadas.php', 'link_texto': 'Consulta pública de áreas embargadas (IBAMA) ↗'}
        feats.append({'type': 'Feature', 'geometry': mapping(g), 'properties': {k: v for k, v in p.items() if v}})
    salvar('embargos.geojson', feats); log('embargos', len(feats), Counter(f['properties']['Situação'] for f in feats))

# ---------- 4) microbacias (ANA/SNIRH) ----------
@etapa('Microbacias')
def microbacias():
    url = 'https://www.snirh.gov.br/arcgis/rest/services/SPR/Balanco_Hidrico_Quantitativo_Microbacia_2020/FeatureServer/0/query'
    feats, off = [], 0
    while True:
        q = {'where': '1=1', 'geometry': f'{MINX},{MINY},{MAXX},{MAXY}', 'geometryType': 'esriGeometryEnvelope', 'inSR': '4326', 'spatialRel': 'esriSpatialRelIntersects',
             'outFields': 'NORIOCOMP,COBACIA,UGRH', 'f': 'json', 'outSR': '4326', 'returnGeometry': 'true', 'resultOffset': off, 'resultRecordCount': 1000}
        d = http(url + '?' + urllib.parse.urlencode(q)); feats += d.get('features', [])
        if not d.get('exceededTransferLimit') or not d.get('features'): break
        off += len(d['features'])
    out = []
    for f in feats:
        ext, furos = [], []
        for anel in f['geometry'].get('rings', []):
            if len(anel) < 4: continue
            p = Polygon(anel); (furos if p.exterior.is_ccw else ext).append(p)
        polys = [Polygon(e.exterior.coords, [h.exterior.coords for h in furos if e.contains(h.representative_point())]) for e in ext]
        if not polys: continue
        g = (MultiPolygon(polys) if len(polys) > 1 else polys[0]).buffer(0)
        if not g.intersects(MUN): continue
        a = f['attributes']
        out.append({'type': 'Feature', 'geometry': mapping(g.simplify(0.0008, preserve_topology=True)),
                    'properties': {'rio': nomes_rios.rio(a.get('NORIOCOMP')), 'nome': nomes_rios.microbacia(a.get('NORIOCOMP')), 'cobacia': a.get('COBACIA'), 'ugrh': a.get('UGRH')}})
    json.dump(arred({'type': 'FeatureCollection', 'features': out}, 5), open(f'{D}/microbacias.geojson', 'w'), ensure_ascii=False, separators=(',', ':'))
    log('microbacias', len(out))

# ---------- 5) MapBiomas: cobertura (imagem, % por imóvel e microbacia) e alertas ----------
CLASSES = {3: ('#1f8d49', 'Vegetação nativa'), 4: ('#7dc975', 'Vegetação nativa'), 5: ('#04381d', 'Vegetação nativa'), 6: ('#026975', 'Vegetação nativa'),
           11: ('#519799', 'Vegetação nativa'), 12: ('#d6bc74', 'Vegetação nativa'), 49: ('#02d659', 'Vegetação nativa'), 50: ('#ad5100', 'Vegetação nativa'),
           13: ('#d89f5c', 'Vegetação nativa'), 9: ('#7a5900', 'Silvicultura'), 15: ('#edde8e', 'Pastagem'), 18: ('#e974ed', 'Agricultura'),
           19: ('#c27ba0', 'Agricultura'), 20: ('#db7093', 'Agricultura'), 39: ('#f5b3c8', 'Agricultura'), 40: ('#c71585', 'Agricultura'),
           41: ('#f54ca9', 'Agricultura'), 62: ('#ff69b4', 'Agricultura'), 36: ('#d082de', 'Agricultura'), 46: ('#d68fe2', 'Agricultura'),
           47: ('#9932cc', 'Agricultura'), 35: ('#9065d0', 'Agricultura'), 48: ('#e6ccff', 'Agricultura'), 21: ('#ffefc3', 'Mosaico de usos'),
           24: ('#d4271e', 'Área urbanizada'), 25: ('#db4d4f', 'Outras áreas'), 23: ('#ffa07a', 'Outras áreas'), 29: ('#ffaa5f', 'Outras áreas'),
           30: ('#9c0027', 'Outras áreas'), 31: ('#091077', 'Água'), 33: ('#2532e4', 'Água'), 26: ('#2532e4', 'Água')}
GRUPOS = ['Vegetação nativa', 'Agricultura', 'Pastagem', 'Silvicultura', 'Mosaico de usos', 'Área urbanizada', 'Água', 'Outras áreas']
CORES_GRUPO = {'Vegetação nativa': '#1f8d49', 'Agricultura': '#e974ed', 'Pastagem': '#edde8e', 'Silvicultura': '#7a5900',
               'Mosaico de usos': '#ffefc3', 'Área urbanizada': '#d4271e', 'Água': '#2532e4', 'Outras áreas': '#db4d4f'}
ANO = '2023'
@etapa('MapBiomas cobertura')
def mb_cobertura():
    global ANO
    import rasterio
    from rasterio.windows import from_bounds
    from rasterio.features import rasterize
    from rasterio.warp import reproject, Resampling, calculate_default_transform
    from PIL import Image
    from pyproj import Transformer
    env = {'GDAL_DISABLE_READDIR_ON_OPEN': 'EMPTY_DIR', 'CPL_VSIL_CURL_ALLOWED_EXTENSIONS': '.tif', 'GDAL_HTTP_MAX_RETRY': '5', 'GDAL_HTTP_RETRY_DELAY': '5'}
    G = 'https://storage.googleapis.com/mapbiomas-public/initiatives/brasil/'
    CAND = [G + f'lulc_10m/collection_2/integration/mapbiomas_10m_collection2_integration_v1-classification_{ANO}.tif',
            G + 'collection_10/lulc/coverage/brazil_coverage_2024.tif', G + 'collection_10/lulc/coverage/brasil_coverage_2024.tif',
            G + 'collection_10/lclu/coverage/brazil_coverage_2024.tif', G + 'collection_10/lclu/coverage/brasil_coverage_2024.tif',
            G + 'collection_10/lulc/coverage/brazil_coverage_2023.tif', G + 'collection_9/lclu/coverage/brasil_coverage_2023.tif',
            G + 'collection_9/lulc/coverage/brasil_coverage_2023.tif', G + 'collection_8/lclu/coverage/brasil_coverage_2022.tif']
    TIF = None
    for u in CAND:
        try:
            with rasterio.Env(**env), rasterio.open('/vsicurl/' + u) as t: TIF = u; log('MapBiomas fonte:', u, t.res); break
        except Exception as e: log('  indisponível:', u.replace(G, ''), str(e)[:60])
    minx, miny, maxx, maxy = MUN.buffer(0.01).bounds
    global CLASSES, GRUPOS, CORES_GRUPO, FONTE_USO
    if TIF:
        ANO = re.search(r'(20\d\d)\.tif', TIF).group(1)
        FONTE_USO = ('MapBiomas 10 m – Coleção 2 (beta), ' if 'lulc_10m' in TIF else 'MapBiomas 30 m – ') + ANO
        with rasterio.Env(**env), rasterio.open('/vsicurl/' + TIF) as src:
            win = from_bounds(minx, miny, maxx, maxy, src.transform).round_offsets().round_lengths()
            dado = src.read(1, window=win); tr = src.window_transform(win); crs = src.crs
    else:
        # reserva: Esri/Impact Observatory 10 m (Planetary Computer, aberto, CC BY 4.0)
        import planetary_computer as pc
        from pystac_client import Client
        from rasterio.merge import merge
        cat = Client.open('https://planetarycomputer.microsoft.com/api/stac/v1', modifier=pc.sign_inplace)
        itens = list(cat.search(collections=['io-lulc-annual-v02'], bbox=[minx, miny, maxx, maxy]).items())
        ANO = max(i.datetime.year if i.datetime else int(str(i.properties.get('start_datetime'))[:4]) for i in itens)
        itens = [i for i in itens if (i.datetime.year if i.datetime else int(str(i.properties.get('start_datetime'))[:4])) == ANO]
        srcs = [rasterio.open(i.assets['data'].href) for i in itens]
        from rasterio.warp import transform_bounds
        b = transform_bounds('EPSG:4326', srcs[0].crs, minx, miny, maxx, maxy)
        dado, tr = merge(srcs, bounds=b); dado = dado[0]; crs = srcs[0].crs
        if str(crs) != 'EPSG:4326':
            from rasterio.warp import calculate_default_transform
            t4, w4, h4 = calculate_default_transform(crs, 'EPSG:4326', dado.shape[1], dado.shape[0], *rasterio.transform.array_bounds(dado.shape[0], dado.shape[1], tr))
            d4 = np.zeros((h4, w4), 'uint8')
            reproject(dado, d4, src_transform=tr, src_crs=crs, dst_transform=t4, dst_crs='EPSG:4326', resampling=Resampling.nearest)
            dado, tr, crs = d4, t4, 'EPSG:4326'
        CLASSES = {1: ('#419bdf', 'Água'), 2: ('#397d49', 'Vegetação arbórea'), 4: ('#7a87c6', 'Vegetação arbórea'), 5: ('#e49635', 'Agricultura'),
                   7: ('#c4281b', 'Área urbanizada'), 8: ('#a59b8f', 'Outras áreas'), 11: ('#e3e2c3', 'Pastagem e campos')}
        GRUPOS = ['Vegetação arbórea', 'Agricultura', 'Pastagem e campos', 'Área urbanizada', 'Água', 'Outras áreas']
        CORES_GRUPO = {'Vegetação arbórea': '#397d49', 'Agricultura': '#e49635', 'Pastagem e campos': '#e3e2c3', 'Área urbanizada': '#c4281b', 'Água': '#419bdf', 'Outras áreas': '#a59b8f'}
        FONTE_USO = f'Esri/Impact Observatory 10 m, {ANO} (MapBiomas indisponível para download)'
        log('uso do solo: reserva Impact Observatory', ANO, dado.shape)
    dentro = rasterize([(mapping(MUN), 1)], out_shape=dado.shape, transform=tr, fill=0, dtype='uint8')
    lat = tr.f + tr.e * (np.arange(dado.shape[0]) + 0.5)
    area_ha = np.broadcast_to((abs(tr.a) * 111320 * np.cos(np.radians(lat)))[:, None] * (abs(tr.e) * 110574), dado.shape) / 1e4
    grp = np.zeros_like(dado, dtype='int8')
    for cod, (c, gr) in CLASSES.items(): grp[dado == cod] = GRUPOS.index(gr) + 1
    tot = {g: float(area_ha[(grp == i + 1) & (dentro == 1)].sum()) for i, g in enumerate(GRUPOS)}
    T = sum(tot.values())
    json.dump({'ano': ANO, 'fonte': FONTE_USO, 'area_total_ha': round(T, 1), 'grupos': [{'grupo': g, 'cor': CORES_GRUPO[g], 'area_ha': round(a, 1), 'pct': round(100 * a / T, 2)} for g, a in tot.items() if a > 0]},
              open(f'{D}/mapbiomas_estatisticas.json', 'w'), ensure_ascii=False, indent=1)
    def por_poligono(arquivo):
        if not os.path.exists(arquivo): return
        g = json.load(open(arquivo))
        rot = rasterize([(mapping(shape(f['geometry'])), i + 1) for i, f in enumerate(g['features'])], out_shape=dado.shape, transform=tr, fill=0, dtype='int32')
        mat = np.zeros((len(g['features']) + 1, len(GRUPOS) + 1))
        np.add.at(mat, (rot.ravel(), grp.ravel()), area_ha.ravel())
        for i, f in enumerate(g['features']):
            linha = mat[i + 1]; t = linha[1:].sum(); p = f['properties']
            for k in [k for k in p if k.startswith('MapBiomas') or k.startswith('Uso do solo ')]: p.pop(k)
            if t <= 0: continue
            for j, gr in enumerate(GRUPOS):
                v = 100 * linha[j + 1] / t
                if v >= 0.5: p[f'{"MapBiomas" if TIF else "Uso do solo"} {ANO} – {gr} (%)'] = f'{v:.1f}'.replace('.', ',')
            p['veg_nativa_pct'] = round(100 * linha[1] / t, 1)
            v = p['veg_nativa_pct']; p['faixa_veg'] = 'Menos de 5%' if v < 5 else '5% a 10%' if v < 10 else '10% a 20%' if v < 20 else '20% ou mais'
        json.dump(g, open(arquivo, 'w'), ensure_ascii=False, separators=(',', ':'))
    por_poligono(f'{D}/car.geojson'); por_poligono(f'{D}/microbacias.geojson')
    lut = np.zeros((256, 4), dtype='uint8')
    for cod, (c, g) in CLASSES.items(): lut[cod] = [int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16), 255]
    dm = np.where(dentro == 1, dado, 0).astype('uint8')
    b = rasterio.transform.array_bounds(dado.shape[0], dado.shape[1], tr)
    t2, w2, h2 = calculate_default_transform(crs, 'EPSG:3857', dado.shape[1], dado.shape[0], *b, resolution=20)
    dst = np.zeros((h2, w2), dtype='uint8')
    reproject(dm, dst, src_transform=tr, src_crs=crs, dst_transform=t2, dst_crs='EPSG:3857', resampling=Resampling.mode)
    Image.fromarray(lut[dst], 'RGBA').save(f'{D}/cobertura.png', optimize=True)
    tf = Transformer.from_crs('EPSG:3857', 'EPSG:4326', always_xy=True)
    x0, y0 = t2.c, t2.f; x1, y1 = x0 + t2.a * w2, y0 + t2.e * h2
    json.dump({'imagem': f'{D}/cobertura.png', 'cantos': [[round(a, 6), round(b_, 6)] for a, b_ in [tf.transform(x0, y0), tf.transform(x1, y0), tf.transform(x1, y1), tf.transform(x0, y1)]], 'ano': ANO},
              open(f'{D}/cobertura.json', 'w'))
    log('grupos (%)', {g: round(100 * a / T, 1) for g, a in tot.items()})

DRIVER = {'agriculture': 'Agropecuária', 'urban_expansion': 'Expansão urbana', 'mining': 'Mineração', 'other': 'Outros', 'river_lake_ocean': 'Rio/lago',
          'natural_cause': 'Causa natural', 'reservoir': 'Reservatório', 'road': 'Estrada'}
@etapa('MapBiomas alertas')
def mb_alertas():
    base = 'https://geoserver.alerta.mapbiomas.org/geoserver/ows'
    cap = http(base + '?service=WFS&version=2.0.0&request=GetCapabilities', raw=True).decode('utf-8', 'ignore')
    nomes = [n for n in re.findall(r'<(?:wfs:)?Name>([^<]+)</(?:wfs:)?Name>', cap) if re.search(r'alert', n, re.I)]
    nomes = [n for n in nomes if n.startswith('mapbiomas-alertas:') and 'staging' not in n] or nomes
    limpa = lambda t: (t or '').strip('{}').replace('"', '').replace(',', ', ')
    fs = []
    for nome in nomes:
        for caixa in (f'{MINY},{MINX},{MAXY},{MAXX},urn:ogc:def:crs:EPSG::4326', f'{MINX},{MINY},{MAXX},{MAXY},EPSG:4326'):
            q = {'service': 'WFS', 'version': '2.0.0', 'request': 'GetFeature', 'typeNames': nome, 'outputFormat': 'application/json', 'srsName': 'EPSG:4326', 'bbox': caixa, 'count': 5000}
            try: d = http(base + '?' + urllib.parse.urlencode(q), tent=2, timeout=240)
            except Exception: continue
            fs = [f for f in d.get('features', []) if f.get('geometry') and shape(f['geometry']).intersects(MUN)]
            if d.get('features'): break
        if fs: log('camada', nome); break
    grupos = defaultdict(list); meta = {}
    for f in fs:
        p = f['properties']
        k = (str(p.get('alert_code')), p.get('rural_property_code') or '')
        grupos[k].append(shape(f['geometry']).buffer(0))
        meta[k] = {'nome': f"Alerta {p.get('alert_code')}", 'Código do alerta': str(p.get('alert_code')),
                   'Detectado em': '/'.join(reversed((p.get('detected_at') or '').split('-'))), 'Publicado em': '/'.join(reversed((p.get('published_at') or '').split('-'))),
                   'Área do alerta (ha)': f"{p.get('area_ha') or 0:.2f}".replace('.', ','), 'Área no imóvel (ha)': f"{p.get('alert_car_area') or 0:.2f}".replace('.', ','),
                   'Vetor': DRIVER.get(p.get('deforestation_driver'), p.get('deforestation_driver') or ''), 'Fonte': limpa(p.get('sources')), 'Bioma': limpa(p.get('biomes')),
                   'Áreas especiais': limpa(p.get('crossed_special_territories')), 'Imóvel (CAR)': p.get('rural_property_code') or '', 'ano': (p.get('detected_at') or '')[:4],
                   'area_car': p.get('alert_car_area') or 0, 'link': f"https://plataforma.alerta.mapbiomas.org/alerta/{p.get('alert_code')}"}
    out = [{'type': 'Feature', 'properties': meta[k], 'geometry': mapping(unary_union(gs).buffer(0))} for k, gs in grupos.items()]
    salvar('alertas.geojson', out); log('alertas', len(out))
    # marca no CAR
    por = defaultdict(lambda: [set(), 0.0])
    for x in out:
        c = x['properties']['Imóvel (CAR)']
        if c: por[c][0].add(x['properties']['Código do alerta']); por[c][1] += float(x['properties']['area_car'])
    imv = json.load(open(f'{D}/car.geojson'))
    for f in imv['features']:
        p = f['properties']; p.pop('Alertas MapBiomas', None); p.pop('Área de alertas (ha)', None)
        if p['nome'] in por: p['Alertas MapBiomas'] = str(len(por[p['nome']][0])); p['Área de alertas (ha)'] = f"{por[p['nome']][1]:.2f}".replace('.', ',')
    json.dump(imv, open(f'{D}/car.geojson', 'w'), ensure_ascii=False, separators=(',', ':'))

# ---------- 6) IAT: outorgas (SIGARH) e barragens ----------
def iat_camada(url):
    sv = http(url + '?f=json'); fs = []
    for c in sv.get('layers', []):
        off = 0
        while True:
            d = http(f"{url}/{c['id']}/query", {'where': '1=1', 'geometry': f'{MINX},{MINY},{MAXX},{MAXY}', 'geometryType': 'esriGeometryEnvelope', 'inSR': '4326',
                     'spatialRel': 'esriSpatialRelIntersects', 'outSR': '4326', 'outFields': '*', 'returnZ': 'false', 'returnM': 'false', 'f': 'geojson',
                     'resultOffset': off, 'resultRecordCount': 1000})
            if 'error' in d or 'features' not in d:  # alguns servidores (ANA) só aceitam GET
                log('  POST recusado, tentando GET', str(d.get('error', ''))[:150])
                d = http(f"{url}/{c['id']}/query?" + urllib.parse.urlencode({'where': '1=1', 'geometry': f'{MINX},{MINY},{MAXX},{MAXY}', 'geometryType': 'esriGeometryEnvelope', 'inSR': '4326',
                         'spatialRel': 'esriSpatialRelIntersects', 'outSR': '4326', 'outFields': '*', 'f': 'geojson', 'resultOffset': off, 'resultRecordCount': 1000}))
            lote = d.get('features', []); fs += lote
            log('  ', url.split('/services/')[-1], 'camada', c['id'], 'lote', len(lote))
            if len(lote) < 1000: break
            off += len(lote)
    return [f for f in fs if f.get('geometry') and shape(f['geometry']).intersects(MUN)]
@etapa('Outorgas SIGARH')
def outorgas():
    bruto = iat_camada('https://geopr.iat.pr.gov.br/server/rest/services/00_PUBLICACOES/outorgas_sigarh/FeatureServer')
    VALIDAS = {'DEFERIDA', 'EM RENOVAÇÃO', 'EM REGULARIZAÇÃO'}
    def grupo(p):
        t = (p.get('nm_tipo_interferencia') or '').lower()
        return 'Poço (água subterrânea)' if 'subterr' in t else 'Captação superficial' if 'captação superficial' in t else 'Lançamento de efluentes' if 'lançamento' in t else 'Barragem / soleira' if 'barragem' in t else 'Obras e intervenções em rios'
    dt = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime('%d/%m/%Y') if isinstance(ms, (int, float)) else ''
    imv = [shape(f['geometry']) for f in json.load(open(f'{D}/car.geojson'))['features']]
    arv = STRtree(imv)
    rural, urbana = [], []
    for f in bruto:
        p = f['properties']
        if p.get('st_portaria') not in VALIDAS or (p.get('nm_tipo_solicitacao') or '').startswith('Desativa'): continue
        pt = Point(f['geometry']['coordinates'][:2]); dentro = any(imv[i].contains(pt) for i in arv.query(pt))
        vz = [p.get(k) for k in p if k.startswith('vlr_vazao_capt_lanc_') and isinstance(p.get(k), (int, float))]
        corpo = p.get('nm_corpo_hidrico_popular') or p.get('nm_tipo_corpo_hidrico') or (p.get('nm_aquifero') if 'subterr' in (p.get('nm_tipo_interferencia') or '').lower() else '')
        props = {'nome': (p.get('nm_requerente') or '').strip() or 'Titular não informado', 'grupo': grupo(p), 'Interferência': p.get('nm_tipo_interferencia') or '',
                 'Documento': p.get('nm_tipo_documento') or '', 'Portaria / declaração': p.get('nr_portaria') or '', 'Situação': (p.get('st_portaria') or '').capitalize(),
                 'Setor do usuário': p.get('nm_tipo_usuario') or '', 'Finalidade': (p.get('desc_finalidades') or '').replace(',', ', '), 'Corpo hídrico / aquífero': corpo or '',
                 'Vazão máxima (m³/h)': f'{max(vz):.2f}'.replace('.', ',') if vz else '', 'Publicação': dt(p.get('dt_publicacao')), 'Vencimento': dt(p.get('dt_vencimento')),
                 'Bacia (comitê)': p.get('nm_comite') or '', 'Área': 'Rural – dentro de imóvel do CAR' if dentro else 'Fora de imóvel do CAR (urbana ou sem CAR)'}
        (rural if dentro else urbana).append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [round(c, 6) for c in f['geometry']['coordinates'][:2]]}, 'properties': props})
    salvar('outorgas_rural.geojson', rural); salvar('outorgas_urbana.geojson', urbana)
    log('outorgas rural', len(rural), 'fora do CAR', len(urbana))
PJ_BAR = re.compile(r'\b(LTDA|S/?A|S\.A|EIRELI|ME|EPP|CIA|COMPANHIA|MUNICIPIO|PREFEITURA|ASSOCIACAO|COOPERATIVA|COOP|CONDOMINIO|EMPREENDIMENTOS?|INDUSTRIA|COMERCIO|AGROPECUARIA|AGRICOLA|CONSTRUTORA|LOTEADORA|INCORPORADORA|SANEPAR|COPEL|ESTADO|GOVERNO|SECRETARIA|DEPARTAMENTO|INSTITUTO|UNIVERSIDADE|ENERGIA|USINA|HOLDING|PARTICIPACOES|IGREJA|SAAE|FUNDACAO)\b')
def empreendedor(n):
    n = (n or '').strip()
    return n if n and PJ_BAR.search(unicodedata.normalize('NFD', n).encode('ascii', 'ignore').decode().upper()) else ('Pessoa física (nome omitido)' if n else '')
@etapa('Barragens IAT + SNISB')
def barragens():
    nb = lambda v, c=2: '' if v in (None, '') or float(v) == 0 else f"{float(v):,.{c}f}".replace(',', 'X').replace('.', ',').replace('X', '.')
    nc = lambda v: (str(v).strip() if v not in (None, '') else '') or 'Não classificado'
    norm = lambda v: 'Não classificado' if v.lower().startswith(('não', 'nao', 'sem')) else v
    dt = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime('%d/%m/%Y') if isinstance(ms, (int, float)) else ''
    out = []
    # 1) SNISB (ANA) – cadastro nacional, inclui as barragens fiscalizadas pelo IAT
    try:
        sn = iat_camada('https://www.snirh.gov.br/arcgis/rest/services/IG/SNISB/FeatureServer')
    except Exception as e:
        log('SNISB indisponível', e); sn = []
    for f in sn:
        p = f['properties']; risco = norm(nc(p.get('CATEGORIA_RISCO'))); dpa = norm(nc(p.get('DANO_POTENCIAL')))
        nome = (p.get('BAR_NM_NOME') or '').strip(); sec = (p.get('BAR_NM_SECUNDARIO') or '').strip()
        if (not nome or 'sem nome' in nome.lower()) and sec: nome = sec
        out.append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': f['geometry']['coordinates'][:2]}, 'properties': {
            'nome': nome or 'Barragem sem nome', 'risco': risco, 'dpa': dpa, 'grupo': 'Barragem (SNISB)', 'Fonte': 'SNISB/ANA',
            'Código SNISB': p.get('BAR_CD_SNISB') or '', 'Código no órgão fiscalizador': p.get('BAR_CD_BAR_ENT_FISCALIZADORA') or '',
            'Empreendedor': empreendedor(p.get('NM_EMPREENDEDOR')), 'Órgão fiscalizador': p.get('ORG_NM_ORGANIZACAO') or '',
            'Autorização / outorga': p.get('AUT_NU_AUTORIZACAO') or '', 'Data da autorização': dt(p.get('AUT_DT_EMISSAO_PUB')),
            'Categoria de risco': risco, 'Dano potencial associado (DPA)': dpa, 'Classe': p.get('BAR_DS_CLASSE') or '',
            'Regulada pela PNSB': p.get('REGULADA_PELO_PNSB') or '', 'Fase': p.get('FASE_DE_VIDA') or '',
            'Uso principal': p.get('USO_PRINCIPAL') or '', 'Curso d\'água': p.get('ING_NM_TRECHO') or '', 'Tipo (material)': p.get('TIPO_MATERIAL') or '',
            'Altura (m)': nb(p.get('BAR_NU_ALT_MAX_NIVEL_TERRENO') or p.get('BAR_NU_ALT_MAX_BASE_FUNDACAO'), 1), 'Volume (hm³)': nb(p.get('BAR_NU_CAP_TOTAL_RESERV'), 4),
            'Plano de segurança': p.get('POSSUI_PLANO_SEGURANCA') or '', 'PAE (plano de emergência)': p.get('POSSUI_PAE') or '',
            'Revisão periódica': p.get('POSSUI_REVISAO_PERIODICA') or '', 'Última inspeção': dt(p.get('INS_DT_INSPECAO')), 'Autuada': p.get('BARRAGEM_AUTUADA') or ''}})
    # 2) IAT – painel de vistorias técnicas (junta com a do SNISB quando é a mesma barragem, até 300 m)
    iat = iat_camada('https://geopr.iat.pr.gov.br/server/rest/services/Hosted/barragens_dashboard_publico/FeatureServer')
    for f in iat:
        p = f['properties']; pt = Point(f['geometry']['coordinates'][:2])
        extra = {'Código IAT': p.get('codigo_barragem') or '', 'Classificação IAT': p.get('classificacao') or '',
                 'Finalidade (IAT)': (p.get('finalidade_recurso') or '').replace('_', ' ').replace(',', ', '), 'Área do reservatório (m²)': nb(p.get('area_reservatorio_m2'), 0)}
        perto = sorted(((pt.distance(Point(o['geometry']['coordinates'])) * 111000, o) for o in out if o['properties']['Fonte'].startswith('SNISB')), key=lambda t: t[0])
        if perto and perto[0][0] <= 300:
            o = perto[0][1]['properties']; o.update({k: v for k, v in extra.items() if v}); o['Fonte'] = 'SNISB/ANA + vistoria IAT'; o['grupo'] = 'Barragem (SNISB + vistoria IAT)'
            continue
        risco = norm(nc(p.get('categoria_risco'))); dpa = norm(nc(p.get('dpa')))
        out.append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': f['geometry']['coordinates'][:2]}, 'properties': {
            'nome': (lambda n: n if n and 'sem nome' not in n.lower() else 'Barragem sem nome')((p.get('nome_barragem') or '').strip()), 'risco': risco, 'dpa': dpa, 'grupo': 'Barragem (vistoria IAT)', 'Fonte': 'Vistoria IAT',
            'Categoria de risco': risco, 'Dano potencial associado (DPA)': dpa, 'Fase': p.get('fase_vida') or '', 'Tipo (material)': p.get('tipo_barragem_material') or '',
            'Altura (m)': nb(p.get('altura_m'), 1), 'Volume (hm³)': nb(p.get('volume_reservatorio_hm3'), 4), **extra}})
    salvar('barragens.geojson', out); log('barragens', len(out), 'SNISB', len(sn), 'IAT', len(iat))

@etapa('Licenças ambientais IAT (SGA/SIA)')
def licencas():
    import licencas_iat
    licencas_iat.gerar(COD, D)

@etapa('Massas d\'água (ANA)')
def massas():
    fs = iat_camada('https://www.snirh.gov.br/arcgis/rest/services/SPR/Massa_dagua/FeatureServer')
    out = []
    for f in fs:
        p = f['properties']; g = shape(f['geometry']).buffer(0)
        art = (p.get('detipomass') or '').strip().lower().startswith('artif')
        nome = next((p.get(k).strip() for k in ('nmoriginal', 'nmalternat', 'nmgenerico') if (p.get(k) or '').strip()), '')
        out.append({'type': 'Feature', 'geometry': mapping(g.simplify(0.00002)), 'properties': {
            'nome': nome or ('Açude / represa' if art else 'Lago / lagoa'), 'grupo': 'Açude / represa (artificial)' if art else 'Lago / lagoa (natural)',
            'Tipo': 'Artificial (açude, represa, reservatório)' if art else 'Natural', 'Área (ha)': f"{(p.get('nuareaha') or 0):.2f}".replace('.', ','),
            'Código SNISB': p.get('cod_snisb') or '', 'Dominialidade': (p.get('dedominial') or '').strip(), 'Uso principal': (p.get('usoprinc') or '').strip(),
            'Base': (p.get('deversao') or '').strip() + (f" – {p.get('desatelite').strip()}" if (p.get('desatelite') or '').strip() else '')}})
    salvar('massas_dagua.geojson', out); log('massas d\'água', len(out))

# ---------- 6b) hidrografia FBDS (base usada no CAR: rios até 10 m e nascentes) – estimativa de APP ----------
@etapa('Hidrografia FBDS (IAT)')
def hidrografia():
    for camada, arq in (('fbds_rio_ate10m_larg', 'rios_fbds.geojson'), ('fbds_nascentes', 'nascentes_fbds.geojson')):
        fs = iat_camada(f'https://geopr.iat.pr.gov.br/server/rest/services/00_PUBLICACOES/{camada}/FeatureServer')
        out = []
        for f in fs:
            g = shape(f['geometry'])
            if g.geom_type.startswith('Multi') or g.geom_type == 'LineString': g = g.simplify(0.00003)
            out.append({'type': 'Feature', 'geometry': arred(mapping(g), 6), 'properties': {}})
        salvar(arq, out); log(camada, len(out))

# ---------- 7) relevo: declividade e curvas de nível (Copernicus DEM) ----------
def dem_terrarium(bbox, z=13):
    """Mosaico das telhas de elevação Terrarium (AWS, públicas) reprojetado para graus (EPSG:4326)."""
    import math, rasterio
    from rasterio.warp import reproject, Resampling
    from rasterio.transform import from_bounds
    from PIL import Image
    def til(lon, lat):
        n = 2 ** z; x = (lon + 180) / 360 * n; y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n; return x, y
    x0, y1 = til(bbox[0], bbox[1]); x1, y0 = til(bbox[2], bbox[3])
    xs, ys = range(int(x0), int(x1) + 1), range(int(y0), int(y1) + 1)
    mos = np.zeros((len(ys) * 256, len(xs) * 256), 'float32')
    for j, ty in enumerate(ys):
        for i, tx in enumerate(xs):
            im = np.asarray(Image.open(io.BytesIO(http(f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{tx}/{ty}.png', raw=True))).convert('RGB')).astype('float32')
            mos[j * 256:(j + 1) * 256, i * 256:(i + 1) * 256] = im[..., 0] * 256 + im[..., 1] + im[..., 2] / 256 - 32768
    R = 6378137.0; tam = 2 * math.pi * R / 2 ** z
    mx0 = xs[0] * tam - math.pi * R; my0 = math.pi * R - ys[0] * tam
    tr_m = rasterio.transform.from_origin(mx0, my0, tam, tam)
    res = 1 / 3600  # ~30 m
    W = int((bbox[2] - bbox[0]) / res); H = int((bbox[3] - bbox[1]) / res)
    tr = from_bounds(*bbox, W, H); dst = np.zeros((H, W), 'float32')
    reproject(mos, dst, src_transform=tr_m, src_crs='EPSG:3857', dst_transform=tr, dst_crs='EPSG:4326', resampling=Resampling.bilinear)
    return dst, tr, rasterio.crs.CRS.from_epsg(4326)

@etapa('Relevo')
def relevo():
    import rasterio, planetary_computer as pc
    from pystac_client import Client
    from rasterio.merge import merge
    from rasterio.features import geometry_mask
    from scipy import ndimage
    from PIL import Image
    bbox = MUN.buffer(0.01).bounds
    fonte = 'Copernicus DEM GLO-30 (ESA)'
    try:
        cat = Client.open('https://planetarycomputer.microsoft.com/api/stac/v1', modifier=pc.sign_inplace)
        srcs = [rasterio.open(i.assets['data'].href) for i in cat.search(collections=['cop-dem-glo-30'], bbox=bbox).items()]
        dem, tr = merge(srcs, bounds=bbox); dem = dem[0].astype('float32'); crs = srcs[0].crs
    except Exception as e:
        log('Copernicus DEM indisponível, usando o modelo de terreno público da AWS (Terrarium):', str(e)[:150])
        dem, tr, crs = dem_terrarium(bbox); fonte = 'Modelo digital de terreno – AWS Terrain Tiles (SRTM/ALOS), ~20 m'
    falta = dem <= 1
    if falta.any():
        idx = ndimage.distance_transform_edt(falta, return_distances=False, return_indices=True)
        dem = dem[tuple(idx)]
    H, W = dem.shape
    fora = geometry_mask([mapping(MUN)], (H, W), tr, invert=False)
    lat0 = (bbox[1] + bbox[3]) / 2; dx = abs(tr.a) * 111320 * np.cos(np.radians(lat0)); dy = abs(tr.e) * 110540
    gy, gx = np.gradient(dem, dy, dx); decl = np.hypot(gx, gy) * 100
    CL = [(3, 8, (217, 240, 163, 150)), (8, 20, (254, 217, 118, 175)), (20, 45, (240, 59, 32, 195)), (45, 999, (128, 0, 38, 215))]
    im = np.zeros((H, W, 4), 'uint8')
    for lo, hi, cor in CL: im[(decl >= lo) & (decl < hi) & ~fora] = cor
    Image.fromarray(im, 'RGBA').save(f'{D}/declividade.png', optimize=True)
    w, s, e, n = rasterio.transform.array_bounds(H, W, tr)
    json.dump({'imagem': f'{D}/declividade.png', 'cantos': [[w, n], [e, n], [e, s], [w, s]], 'fonte': fonte}, open(f'{D}/declividade.json', 'w'))
    # curvas de nível
    sm = ndimage.gaussian_filter(dem, 1.2)
    with rasterio.open('/tmp/dem.tif', 'w', driver='GTiff', height=H, width=W, count=1, dtype='float32', crs=crs, transform=tr) as f: f.write(sm, 1)
    subprocess.run(['gdal_contour', '-q', '-i', '10', '-a', 'cota', '-f', 'GeoJSON', '/tmp/dem.tif', '/tmp/curvas.geojson'], check=True)
    with open('/tmp/curvas.ndjson', 'w') as out:
        for f in json.load(open('/tmp/curvas.geojson'))['features']:
            g = shape(f['geometry'])
            if not g.intersects(MUN): continue
            g = g.intersection(MUN).simplify(0.00004)
            if g.is_empty or g.length < 0.002: continue
            c = int(round(f['properties']['cota']))
            out.write(json.dumps({'type': 'Feature', 'geometry': mapping(g), 'properties': {'cota': c, 'mestra': 1 if c % 50 == 0 else 0}}) + '\n')
    subprocess.run(f'rm -rf {D}/curvas && tippecanoe -q -e {D}/curvas -l curvas -Z10 -z15 --no-tile-compression --drop-densest-as-needed --simplification=2 /tmp/curvas.ndjson', shell=True, check=True)
    log('relevo: cotas', float(dem.min()), float(dem.max()))

# ---------- 8) pendências por imóvel (indicativo) ----------
@etapa('Pendências')
def pendencias():
    imv = json.load(open(f'{D}/car.geojson'))
    sig = [shape(f['geometry']).buffer(0) for f in json.load(open(f'{D}/sigef.geojson'))['features']] if os.path.exists(f'{D}/sigef.geojson') else []
    arv = STRtree(sig) if sig else None
    emb = [f for f in json.load(open(f'{D}/embargos.geojson'))['features'] if f['properties'].get('Situação') == 'Embargo vigente'] if os.path.exists(f'{D}/embargos.geojson') else []
    embg = [shape(f['geometry']).buffer(0) for f in emb]; earv = STRtree(embg) if embg else None
    RX_AGUA = re.compile(r'avicult|suinocult|bovinocult|bubalinocult|ovinocult|caprinocult|equinocult|cunicult|piscicult|aquicult|carcinicult|ranicult|cria[çc][ãa]o de (animais|aves|su[íi]nos|bovinos|frangos|peixes)|confinamento|leite|latic|abate|frigor|alimentos|bebida|f[ée]cula|amido|aguardente|cacha[çc]a|destilaria|usina|curtume|irriga|viveiro|hortali|cogumel|lavagem|lavador|beneficiamento', re.I); RX_CAPTA = re.compile(r'capta|subterr|po[çc]o|insignific|uso independente', re.I)
    licp = [f for f in (json.load(open(f'{D}/licencas.geojson'))['features'] if os.path.exists(f'{D}/licencas.geojson') else [])
            if RX_AGUA.search(f"{f['properties'].get('Atividade', '')} {f['properties'].get('Atividade específica', '')}")]
    outc = [f for a in ('outorgas_rural.geojson', 'outorgas_urbana.geojson') if os.path.exists(f'{D}/{a}') for f in json.load(open(f'{D}/{a}'))['features']
            if RX_CAPTA.search(f"{f['properties'].get('Interferência', '')} {f['properties'].get('Documento', '')} {f['properties'].get('grupo', '')}")]
    licg = [Point(f['geometry']['coordinates'][:2]) for f in licp]; outg = [Point(f['geometry']['coordinates'][:2]) for f in outc]
    larv = STRtree(licg) if licg else None; oarv = STRtree(outg) if outg else None
    ler_fs = lambda a: json.load(open(f'{D}/{a}'))['features'] if os.path.exists(f'{D}/{a}') else []
    minf = [f for f in ler_fs('mineracao.geojson') if f['properties'].get('grupo') != 'Disponibilidade']; ming = [shape(f['geometry']).buffer(0) for f in minf]; marv = STRtree(ming) if ming else None
    rskf = [f for f in ler_fs('risco_sgb.geojson') if re.search(r'alto', f['properties'].get('Grau de risco', ''), re.I)]; rskg = [shape(f['geometry']).buffer(0) for f in rskf]; rarv = STRtree(rskg) if rskg else None
    sitf = ler_fs('sitios_arqueologicos.geojson'); sitg = [Point(f['geometry']['coordinates'][:2]) for f in sitf]; sarv = STRtree(sitg) if sitg else None
    comf = ler_fs('comunidades_tradicionais.geojson'); comg = [shape(f['geometry']).buffer(0) for f in comf]
    classes = Counter()
    for f in imv['features']:
        p = f['properties']
        for k in [k for k in p if k.startswith('Pendência') or k in ('pendencia_nivel', 'pendencias_n', 'Georreferenciamento SIGEF', 'Embargo IBAMA', 'Uso da água × licença', 'Mineração (ANM)', 'Risco geológico (SGB)', 'Patrimônio arqueológico (IPHAN)', 'Terra indígena / quilombola')]: p.pop(k)
        if p.get('situacao') == 'Cancelado': p['pendencia_nivel'] = 'Cancelado'; classes['Cancelado'] += 1; continue
        g = shape(f['geometry']).buffer(0); a = g.area or 1
        cob = sum(g.intersection(sig[i]).area for i in arv.query(g)) / a if arv is not None else 0
        p['Georreferenciamento SIGEF'] = 'Certificado (≥ 50% da área)' if cob >= 0.5 else ('Parcial' if cob >= 0.1 else 'Não localizado no SIGEF')
        mf = num(p.get('Módulos fiscais')); veg = p.get('veg_nativa_pct'); sit = p.get('situacao', '')
        pend = []; pts = 0
        if sit == 'Analisado – regularização ambiental pendente': pend.append('CAR analisado: regularização ambiental pendente (PRA)'); pts += 3
        elif sit == 'Analisado – notificação pendente': pend.append('CAR analisado: notificação do órgão sem resposta'); pts += 2
        elif sit in ('Aguardando análise', 'Em análise'): pend.append('CAR ainda sem análise do órgão'); pts += 0.5
        if earv is not None:
            tem = [emb[i]['properties']['nome'].replace('Embargo IBAMA ', '') for i in earv.query(g) if g.intersection(embg[i]).area > 0.02 * embg[i].area]
            if tem: p['Embargo IBAMA'] = 'Vigente: ' + ', '.join(tem[:3]); pend.append(f"Área embargada pelo IBAMA ({', '.join(tem[:3])})"); pts += 4
        if larv is not None:
            la = [licp[i]['properties'].get('Atividade', '') for i in larv.query(g) if g.contains(licg[i])]
            tem_capta = oarv is not None and any(g.contains(outg[i]) for i in oarv.query(g))
            if la and not tem_capta:
                p['Uso da água × licença'] = f"Atividade licenciada ({', '.join(sorted(set(la))[:2])}) sem outorga de captação localizada"
                pend.append(f"Atividade licenciada com consumo de água ({', '.join(sorted(set(la))[:2])}) sem outorga de captação no imóvel"); pts += 2
        if marv is not None:
            mm = [minf[i]['properties'] for i in marv.query(g) if g.intersection(ming[i]).area > 0.01 * min(a, ming[i].area)]
            if mm:
                lav = [m for m in mm if m.get('grupo') == 'Lavra / extração']
                p['Mineração (ANM)'] = f"{len(mm)} processo(s): " + '; '.join(sorted({f"{m.get('Fase', '')} – {m.get('Substância', '')}".lower() for m in mm})[:3])
                pend.append(f"Direito minerário ANM sobre o imóvel ({p['Mineração (ANM)']})"); pts += 1.5 if lav else 1
        if rarv is not None:
            rr = [rskf[i]['properties'] for i in rarv.query(g) if g.intersects(rskg[i])]
            if rr:
                p['Risco geológico (SGB)'] = f"{len(rr)} setor(es) de risco {', '.join(sorted({x.get('Grau de risco', '').lower() for x in rr}))} ({', '.join(sorted({x.get('Processo', '') for x in rr})[:2])})"
                pend.append(f"Setor de risco geológico mapeado pelo SGB no imóvel: {p['Risco geológico (SGB)']}"); pts += 2
        if sarv is not None:
            km_lat = 1 / 111.32
            ss = [sitf[i]['properties'] for i in sarv.query(g.buffer(km_lat)) if g.distance(sitg[i]) <= km_lat]
            if ss:
                p['Patrimônio arqueológico (IPHAN)'] = f"{len(ss)} sítio(s) arqueológico(s) no imóvel ou a até 1 km: " + ', '.join(x['nome'].replace('Sítio arqueológico ', '') for x in ss[:3])
                pend.append(p['Patrimônio arqueológico (IPHAN)'] + ' – avaliar FCA/estudo arqueológico no IPHAN antes de obras'); pts += 1
        if comg:
            cc = [(comf[i]['properties'], g.distance(comg[i]) * 111.32) for i in range(len(comg))]
            cc = [(x, d) for x, d in cc if d <= 10]
            if cc: p['Terra indígena / quilombola'] = '; '.join(f"{x['nome']} a {d:.1f} km".replace('.', ',') if d > 0 else f"{x['nome']} (sobreposição)" for x, d in sorted(cc, key=lambda t: t[1])[:2]); pend.append(f"Comunidade tradicional a menos de 10 km ({p['Terra indígena / quilombola']}) – verificar consulta à Funai/Incra no licenciamento"); pts += 0.5
        if p.get('Alertas MapBiomas'): pend.append(f"{p['Alertas MapBiomas']} alerta(s) de desmatamento MapBiomas"); pts += 3
        rot_veg = 'Vegetação nativa' if any(k.startswith('MapBiomas') for k in p) else 'Cobertura arbórea (inclui silvicultura)'
        if veg is not None and mf > 4 and veg < 20: pend.append(f'{rot_veg} de {veg:.1f}% (abaixo de 20%) em imóvel acima de 4 módulos – possível déficit de Reserva Legal'.replace('.', ',')); pts += 2
        if mf > 4 and cob < 0.1: pend.append('Imóvel acima de 4 módulos sem georreferenciamento certificado no SIGEF'); pts += 1
        nivel = 'Prioridade alta' if pts >= 4 else 'Prioridade média' if pts >= 2 else 'Atenção' if pts > 0 else 'Sem pendência identificada'
        p['pendencia_nivel'] = nivel; p['pendencias_n'] = len(pend)
        for i, t in enumerate(pend, 1): p[f'Pendência {i}'] = t
        classes[nivel] += 1
    json.dump(imv, open(f'{D}/car.geojson', 'w'), ensure_ascii=False, separators=(',', ':'))
    log(classes)

# ---------- 8b) mineração (ANM/SIGMINE) e setores de risco (SGB) ----------
def arcgis_geojson(base, extra=None, pagina=1000, margem=0.0):
    """Consulta um serviço ArcGIS pela caixa do município (+ margem em graus), em páginas, e devolve feições GeoJSON (WGS84)."""
    env = json.dumps({'xmin': MINX - margem, 'ymin': MINY - margem, 'xmax': MAXX + margem, 'ymax': MAXY + margem, 'spatialReference': {'wkid': 4326}})
    feats, off = [], 0
    while True:
        q = {'geometry': env, 'geometryType': 'esriGeometryEnvelope', 'spatialRel': 'esriSpatialRelIntersects', 'outFields': '*',
             'returnGeometry': 'true', 'outSR': '4326', 'resultOffset': off, 'resultRecordCount': pagina, 'f': 'geojson', **(extra or {})}
        r = http(base + '/query?' + urllib.parse.urlencode(q), timeout=240)
        fs = r.get('features', []); feats += fs
        if len(fs) < pagina and not r.get('exceededTransferLimit') and not (r.get('properties') or {}).get('exceededTransferLimit'): break
        if not fs: break
        off += len(fs)
    zona = MUN.buffer(margem) if margem else MUN
    def geo(f):
        g = shape(f['geometry'])
        return g if g.geom_type in ('Point', 'MultiPoint') else g.buffer(0)   # buffer(0) apaga pontos
    return [f for f in feats if f.get('geometry') and geo(f).intersects(zona)]

PJ_RX = re.compile(r'\b(LTDA|S/?A|S\.A|EIRELI|ME|EPP|CIA|COMPANHIA|MUNICIPIO|MUNICÍPIO|PREFEITURA|ASSOCIACAO|ASSOCIAÇÃO|COOPERATIVA|MINERA[CÇ][AÃ]O|MINERADORA|PEDREIRA|CER[AÂ]MICA|AREAL|INDUSTRIA|INDÚSTRIA|COMERCIO|COMÉRCIO|CONSTRUTORA|ENGENHARIA|EMPREENDIMENTOS?|INCORPORADORA|AGROPECU[AÁ]RIA|TRANSPORTES?|EXTRA[CÇ][AÃ]O|SANEAMENTO|DEPARTAMENTO|ESTADO)\b', re.I)
def grupo_fase(f):
    f = (f or '').upper()
    return 'Pesquisa mineral' if 'PESQUISA' in f else 'Disponibilidade' if 'DISPONIBILIDADE' in f else 'Lavra / extração'

@etapa('Mineração (ANM/SIGMINE)')
def mineracao():
    fs = arcgis_geojson('https://geo.anm.gov.br/arcgis/rest/services/SIGMINE/dados_anm/FeatureServer/0')
    feats = []
    for f in fs:
        a = f['properties']; tit = (a.get('NOME') or '').strip(); pj = bool(PJ_RX.search(tit))
        proc = a.get('DSProcesso') or a.get('PROCESSO') or ''
        p = {'nome': f'Processo ANM {proc}', 'grupo': grupo_fase(a.get('FASE')), 'Processo': proc, 'Fase': (a.get('FASE') or '').capitalize(),
             'Substância': (a.get('SUBS') or '').capitalize(), 'Uso': a.get('USO') or '', 'Área (ha)': br(float(a.get('AREA_HA') or 0)),
             'Ano': str(a.get('ANO') or ''), 'Titular': tit if pj else 'Pessoa física (consultar na ANM)', 'Último evento': (a.get('ULT_EVENTO') or '').strip(),
             'link': 'https://sistemas.anm.gov.br/SCM/Extra/site/admin/pesquisarProcessos.aspx', 'link_texto': 'Consultar o processo no Cadastro Mineiro (ANM) ↗'}
        g = shape(f['geometry']).buffer(0)
        feats.append({'type': 'Feature', 'geometry': arred(mapping(g)), 'properties': {k: v for k, v in p.items() if v}})
    salvar('mineracao.geojson', feats); log('processos minerários', len(feats), Counter(f['properties']['grupo'] for f in feats))

@etapa('Setores de risco (SGB)')
def risco_sgb():
    fs = arcgis_geojson('https://geoportal.sgb.gov.br/server/rest/services/gestaoterritorial/risco/FeatureServer/0')
    feats = []
    for f in fs:
        a = f['properties']
        tip = '; '.join(dict.fromkeys(t.strip() for t in [a.get(f'tipolo_e{i}') or a.get(f'tipolo_g{i}') or '' for i in range(1, 6)] if t and t.strip()))
        d = str(a.get('data_setor') or '')
        m = re.match(r'(\d{4})-(\d{2})-(\d{2})', d) or None
        if m: d = f'{m.group(3)}/{m.group(2)}/{m.group(1)}'
        elif re.match(r'^\d{12,}$', d): d = datetime.datetime.utcfromtimestamp(int(d) / 1000).strftime('%d/%m/%Y')
        n = lambda k: f"{int(a[k]):,}".replace(',', '.') if isinstance(a.get(k), (int, float)) and a.get(k) else ''
        p = {'nome': f"Setor de risco {a.get('num_setor') or ''}".strip(), 'Grau de risco': (a.get('grau_risco') or '').strip(), 'Processo': tip,
             'Local': (a.get('local') or '').strip(), 'Mapeado em': d, 'Edificações': n('num_edif'), 'Pessoas (estimativa)': n('num_pess'),
             'Descrição': re.sub(r'\s+', ' ', (a.get('descricao') or '')).strip()[:400], 'Intervenção sugerida': re.sub(r'\s+', ' ', (a.get('sug_interv') or '')).strip()[:300],
             'link': 'https://geoportal.sgb.gov.br/desastres/', 'link_texto': 'Mapa para Prevenção de Desastres (SGB) ↗'}
        feats.append({'type': 'Feature', 'geometry': arred(mapping(shape(f['geometry']).buffer(0))), 'properties': {k: v for k, v in p.items() if v}})
    salvar('risco_sgb.geojson', feats, mapeado=bool(feats)); log('setores de risco SGB', len(feats))

SC = 'https://geo.anm.gov.br/arcgis/rest/services/SIGMINE/sociedade_cultura/MapServer'
@etapa('Patrimônio arqueológico (IPHAN), terras indígenas e quilombolas')
def patrimonio():
    sit = []
    for f in arcgis_geojson(SC + '/1', margem=0.012):
        a = f['properties']; nm = re.sub(r'\s+', ' ', a.get('NMSitioArqueologico') or '').strip()
        sit.append({'type': 'Feature', 'geometry': arred(f['geometry']), 'properties': {'nome': f'Sítio arqueológico {nm}'.strip(), 'grupo': 'Sítio arqueológico',
            'Código IPHAN (CNSA)': a.get('CDSitioArqueologico') or '', 'link': 'https://www.gov.br/iphan/pt-br/patrimonio-cultural/patrimonio-arqueologico', 'link_texto': 'Patrimônio arqueológico (IPHAN) ↗'}})
    salvar('sitios_arqueologicos.geojson', sit); log('sítios arqueológicos', len(sit))
    com = []
    for f in arcgis_geojson(SC + '/2', margem=0.1):
        a = f['properties']
        com.append({'type': 'Feature', 'geometry': arred(mapping(shape(f['geometry']).buffer(0))), 'properties': {k: v for k, v in {'nome': f"Terra indígena {a.get('NMTerraIndigena') or ''}".strip(), 'grupo': 'Terra indígena',
            'Situação': a.get('DSSituacao') or '', 'Área (ha)': br(float(a.get('QTAreaHA') or 0)), 'link': 'https://www.gov.br/funai/pt-br/atuacao/terras-indigenas/geoprocessamento-e-mapas', 'link_texto': 'Terras indígenas (Funai) ↗'}.items() if v}})
    for f in arcgis_geojson(SC + '/3', margem=0.1):
        a = f['properties']
        com.append({'type': 'Feature', 'geometry': arred(mapping(shape(f['geometry']).buffer(0))), 'properties': {k: v for k, v in {'nome': f"Território quilombola {a.get('NMTerritorioQuilombola') or ''}".strip(), 'grupo': 'Território quilombola',
            'Processo': a.get('DSProcesso') or '', 'Domínio': (a.get('DSDominio') or '').capitalize(), 'Responsável': a.get('NMResponsavel') or '', 'Área (ha)': br(float(a.get('QTAreaHA') or 0)),
            'link': 'https://www.gov.br/incra/pt-br/assuntos/governanca-fundiaria/quilombolas', 'link_texto': 'Territórios quilombolas (Incra) ↗'}.items() if v}})
    salvar('comunidades_tradicionais.geojson', com); log('terras indígenas e quilombolas (até 10 km)', len(com), Counter(f['properties']['grupo'] for f in com))


# ---------- 8c) aptidão: clima (NASA POWER), solos (IBGE), calcário (ANM), unidades de conservação (MMA/CNUC) ----------
MESES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
DIAS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
NOMES_MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
def koppen(T, P):
    Pa, Ta = sum(P), sum(T) / 12; tf, tq = min(T), max(T)
    ver = [9, 10, 11, 0, 1, 2]; inv = [3, 4, 5, 6, 7, 8]          # hemisfério sul: verão out–mar
    pv = sum(P[i] for i in ver)
    lim = 20 * Ta + (280 if pv >= 0.7 * Pa else 140 if pv >= 0.3 * Pa else 0)
    if Pa < lim: return ('BW' if Pa < lim / 2 else 'BS') + ('h' if Ta >= 18 else 'k')
    pseco = min(P)
    if tf >= 18:
        if pseco >= 60: return 'Af'
        if pseco >= 100 - Pa / 25: return 'Am'
        return 'Aw' if min(P[i] for i in inv) == pseco else 'As'
    if tq >= 10:
        k = 'C' if tf > -3 else 'D'
        if min(P[i] for i in inv) < max(P[i] for i in ver) / 10: s = 'w'
        elif min(P[i] for i in ver) < 40 and min(P[i] for i in ver) < max(P[i] for i in inv) / 3: s = 's'
        else: s = 'f'
        t = 'a' if tq >= 22 else 'b' if sum(1 for x in T if x >= 10) >= 4 else 'c'
        return k + s + t
    return 'E'
KOPPEN = {'Cfa': 'subtropical úmido, verão quente, sem estação seca definida', 'Cfb': 'subtropical úmido, verão ameno, sem estação seca definida',
          'Cwa': 'subtropical, inverno seco e verão quente', 'Cwb': 'subtropical de altitude, inverno seco e verão ameno', 'Aw': 'tropical com inverno seco',
          'Am': 'tropical de monção', 'Af': 'tropical úmido sem estação seca', 'As': 'tropical com verão seco'}

@etapa('Aptidão: clima, solos, calcário e unidades de conservação')
def aptidao():
    apt = {'fontes': {}}
    # clima – normais climatológicas por ponto (NASA POWER, série de longo prazo)
    try:
        c = MUN.representative_point()
        r = http(f'https://power.larc.nasa.gov/api/temporal/climatology/point?parameters=PRECTOTCORR,T2M,T2M_MAX,T2M_MIN&community=AG&longitude={c.x:.4f}&latitude={c.y:.4f}&format=JSON')
        pr = r['properties']['parameter']
        z_grade = (r.get('geometry', {}).get('coordinates') or [0, 0, None])[2]
        try:
            import math
            from PIL import Image
            zz = 12; n = 2 ** zz; fx = (c.x + 180) / 360 * n; fy = (1 - math.asinh(math.tan(math.radians(c.y))) / math.pi) / 2 * n
            im = np.asarray(Image.open(io.BytesIO(http(f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{zz}/{int(fx)}/{int(fy)}.png', raw=True))).convert('RGB')).astype('float32')
            px = im[int((fy % 1) * 256), int((fx % 1) * 256)]; z_local = float(px[0] * 256 + px[1] + px[2] / 256 - 32768)
        except Exception as e: z_local = None; log('  altitude local indisponível', e)
        dz = (z_local - z_grade) if (z_local is not None and z_grade not in (None, -999)) else 0
        P = [round(pr['PRECTOTCORR'][m] * d) for m, d in zip(MESES, DIAS)]; T = [round(pr['T2M'][m] - 0.0065 * dz, 1) for m in MESES]
        log('  altitude: grade NASA', z_grade, 'm, local', z_local, 'm, correção', round(-0.0065 * dz, 2), '°C')
        k = koppen(T, P)
        apt['clima'] = {'chuva_mensal_mm': P, 'temp_media_c': T, 'chuva_anual_mm': sum(P), 'temp_media_anual_c': round(sum(T) / 12, 1),
                        'temp_max_abs_c': pr['T2M_MAX']['ANN'], 'temp_min_abs_c': pr['T2M_MIN']['ANN'], 'koppen': k, 'koppen_desc': KOPPEN.get(k, ''),
                        'meses_secos': [NOMES_MES[i] for i, p in enumerate(P) if p < 60], 'ponto': [round(c.x, 4), round(c.y, 4)], 'altitude_m': round(z_local) if z_local is not None else None,
                        'transicao': abs(min(T) - 18) < 0.7}
        apt['fontes']['clima'] = 'NASA POWER (normais climatológicas por ponto; classificação de Köppen calculada a partir das médias mensais)'
        log('clima', k, sum(P), 'mm', apt['clima']['meses_secos'])
    except Exception as e: log('clima falhou', e)
    # solos – mapa de pedologia do IBGE (BDiA, 1:250.000)
    try:
        u = ('https://geoservicos.ibge.gov.br/geoserver/wfs?service=WFS&version=1.0.0&request=GetFeature&typeName=BDIA:pedo_area&outputFormat=application/json'
             f'&bbox={MINX - 0.01},{MINY - 0.01},{MAXX + 0.01},{MAXY + 0.01},EPSG:4326')
        fs = http(u, timeout=400)['features']; out = []
        for f in fs:
            g = shape(f['geometry']).buffer(0)
            if not g.intersects(MUN): continue
            p = {k: v for k, v in f['properties'].items() if isinstance(v, (str, int, float)) and v not in ('', None) and len(str(v)) < 400}
            out.append({'type': 'Feature', 'geometry': arred(mapping(g.intersection(MUN.buffer(0.005)).simplify(0.0002))), 'properties': p})
        salvar('solos.geojson', out); apt['fontes']['solos'] = 'IBGE – Banco de Dados de Informações Ambientais (BDiA), pedologia 1:250.000'
        log('solos', len(out), list(out[0]['properties'].keys()) if out else '')
    except Exception as e: log('solos falhou', e)
    # calcário – jazidas com título de lavra/licenciamento no PR (ANM/SIGMINE)
    try:
        fs = arcgis_geojson('https://geo.anm.gov.br/arcgis/rest/services/SIGMINE/dados_anm/FeatureServer/0', {'where': "UF='PR' AND (SUBS LIKE '%CALC%' OR SUBS LIKE '%DOLOM%')"}, margem=3.5)
        out = []
        for f in fs:
            a = f['properties']; fase = (a.get('FASE') or '').upper()
            if not re.search('LAVRA|LICENCIAMENTO|EXTRA', fase) or 'GARIMP' in fase: continue
            if not re.search(r'CALC[ÁA]RIO|DOLOM|CALCITA', (a.get('SUBS') or '').upper()): continue   # exclui calcedônia etc.
            pt = shape(f['geometry']).buffer(0).representative_point()
            out.append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [round(pt.x, 5), round(pt.y, 5)]},
                        'properties': {'Processo': a.get('DSProcesso') or a.get('PROCESSO') or '', 'Fase': (a.get('FASE') or '').capitalize(), 'Substância': (a.get('SUBS') or '').capitalize(), 'Uso': a.get('USO') or ''}})
        salvar('calcario.geojson', out); apt['fontes']['calcario'] = 'ANM/SIGMINE – processos de calcário em fase de lavra ou licenciamento no Paraná'
        log('jazidas de calcário (PR, lavra/licenciamento)', len(out))
    except Exception as e: log('calcário falhou', e)
    # unidades de conservação – CNUC/MMA (até 10 km)
    try:
        pag = http('https://dados.mma.gov.br/dataset/unidadesdeconservacao', raw=True).decode('utf-8', 'ignore')
        zips = sorted(set(re.findall(r'href="(https://dados\.mma\.gov\.br/[^"]+/shp_cnuc_(\d{4})_(\d{2})[^"]*\.zip)"', pag)), key=lambda x: (x[1], x[2]))
        url = zips[-1][0]; cache = '/tmp/cnuc.zip'
        if not os.path.exists(cache): open(cache, 'wb').write(http(url, raw=True, timeout=900))
        info = subprocess.run(['ogrinfo', '-ro', '-q', '/vsizip/' + cache], capture_output=True, text=True).stdout
        camadas = re.findall(r'^\d+: (\S+)', info, re.M); cam = [c for c in camadas if not re.search('ponto|point', c, re.I)] or camadas
        log('  camadas CNUC:', camadas, '-> usando', cam[0])
        if os.path.exists('/tmp/ucs.geojson'): os.remove('/tmp/ucs.geojson')
        subprocess.run(['ogr2ogr', '-q', '-f', 'GeoJSON', '-t_srs', 'EPSG:4326', '-spat', str(MINX - 0.1), str(MINY - 0.1), str(MAXX + 0.1), str(MAXY + 0.1), '-spat_srs', 'EPSG:4326',
                        '/tmp/ucs.geojson', '/vsizip/' + cache, cam[0]], check=True)
        out = []
        for f in json.load(open('/tmp/ucs.geojson'))['features']:
            g = shape(f['geometry']).buffer(0)
            if g.distance(MUN) > 0.1: continue
            a = {k.lower(): v for k, v in f['properties'].items()}
            pega = lambda *ks: next((str(a[k]) for k in ks if a.get(k) not in (None, '')), '')
            out.append({'type': 'Feature', 'geometry': arred(mapping(g.simplify(0.0003))), 'properties': {k: v for k, v in {
                'nome': pega('nome_uc', 'nome', 'nm_uc'), 'Categoria': pega('categoria', 'categori3', 'cat_manejo'), 'Grupo': pega('grupo', 'grupo_uc'),
                'Esfera': pega('esfera', 'esfera5', 'esfera_adm'), 'Ano de criação': pega('ano_cria6', 'ano_criacao', 'cria_ano'), 'Ato legal': pega('ato_legal', 'ato_lega9')}.items() if v}})
        salvar('ucs.geojson', out); apt['fontes']['ucs'] = 'MMA – Cadastro Nacional de Unidades de Conservação (CNUC), ' + re.sub(r'.*shp_cnuc_(\d{4})_(\d{2}).*', r'\2/\1', url)
        log('unidades de conservação até 10 km', len(out), [f['properties'].get('nome') for f in out][:5])
    except Exception as e: log('UCs falharam', e)
    json.dump(apt, open(f'{D}/aptidao.json', 'w'), ensure_ascii=False)

# ---------- 9) config do município ----------
@etapa('Config')
def config():
    c = json.load(open('tools/modelo_config.json'))
    imv = json.load(open(f'{D}/car.geojson'))['features']
    ativos = [f for f in imv if f['properties'].get('situacao') != 'Cancelado']
    area = sum(num(f['properties']['Área (ha)']) for f in ativos)
    conf = sum(1 for f in ativos if f['properties']['situacao'] == 'Analisado – em conformidade')
    cnt = lambda a: len(json.load(open(f'{D}/{a}'))['features']) if os.path.exists(f'{D}/{a}') else 0
    est = json.load(open(f'{D}/mapbiomas_estatisticas.json')) if os.path.exists(f'{D}/mapbiomas_estatisticas.json') else {'grupos': []}
    c['cliente'] = {'nome': f'Análise Rural – {NOME}/PR', 'subtitulo': 'Imóveis rurais, restrições e Raio-X do imóvel · CS Consultoria Ambiental', 'selo': 'Uso interno',
                    'centro': [MUN.centroid.x, MUN.centroid.y], 'zoom': 10.5}
    c['atualizado_em'] = datetime.date.today().isoformat()
    try: c['cliente']['selo'] = json.load(open(f'{D}/config.json'))['cliente'].get('selo', c['cliente'].get('selo'))  # mantém o selo escolhido
    except Exception: pass
    c['resumo'] = [{'valor': f'{len(ativos):,}'.replace(',', '.'), 'rotulo': 'imóveis rurais ativos no CAR'},
                   {'valor': f'{area / 1000:,.1f} mil'.replace('.', ',') if area >= 1000 else f'{area:,.0f}'.replace(',', '.'), 'rotulo': 'hectares cadastrados'},
                   {'valor': f'{100 * conf / max(1, len(ativos)):.0f}%', 'rotulo': 'analisados e em conformidade'}]
    c['programa'] = {'titulo': 'Sobre esta análise', 'texto': f'Imóveis rurais do CAR de {NOME} cruzados com SIGEF/INCRA, embargos do IBAMA, alertas de desmatamento, uso do solo (MapBiomas), outorgas e licenças ambientais do IAT, barragens do SNISB/IAT, açudes e represas (ANA), processos minerários da ANM, setores de risco geológico do SGB, sítios arqueológicos do IPHAN, terras indígenas e quilombolas, microbacias e relevo. Clique num imóvel e use o Raio-X para gerar o relatório.', 'etapas': []}
    c['termos']['texto'] = c['termos']['texto'].replace('do município de Londrina', f'do município de {NOME}')
    if os.path.exists(P0 := f'{D}/licencas.json'):
        c['licencas'].update({'arquivo': P0, 'titulo': f'Licenças ambientais em {NOME}',
            'subtitulo': 'Licenças, dispensas e autorizações emitidas pelo IAT (SGA e SIA), com a localização cadastrada no licenciamento. Titular conforme consta na consulta pública do SGA.'})
    else: c.pop('licencas', None)
    P = lambda a: f'{D}/{a}'
    for cam in c['camadas']:
        if cam['id'] == 'municipio': cam['arquivo'] = P('municipio.geojson')
        if cam['id'] == 'imoveis': cam['arquivo'] = P('car.geojson'); cam['campos_prefixos'] = ['Pendência', 'MapBiomas', 'Uso do solo']; cam['campos'] = [k.replace('Inscrição', 'Data de cadastro/atualização') for k in cam['campos'] if k != 'Última atualização']
    novo = []
    for o in c['camadas_opcionais']:
        i = o['id']
        if i == 'mb-cobertura':
            o['nome'] = f"Uso e cobertura do solo {est.get('ano', '')}"; o['fonte'] = est.get('fonte', o.get('fonte')); o['secao'] = 'Uso do solo'
            o['arquivo'] = P('cobertura.json'); o['legenda_itens'] = [{'rotulo': f"{g['grupo']} ({g['pct']:.1f}%)".replace('.', ','), 'cor': g['cor']} for g in est['grupos']]
        elif i == 'mb-alertas': o['arquivo'] = P('alertas.geojson')
        elif i == 'sigef': o['arquivo'] = P('sigef.geojson')
        elif i == 'embargos-ibama': o['arquivo'] = P('embargos.geojson')
        elif i == 'outorgas-rural': o['arquivo'] = P('outorgas_rural.geojson'); o['nome'] = f"Outorgas em imóveis do CAR ({cnt('outorgas_rural.geojson')})"
        elif i == 'outorgas-urbana': o['arquivo'] = P('outorgas_urbana.geojson'); o['nome'] = f"Outorgas fora do CAR ({cnt('outorgas_urbana.geojson')})"
        elif i == 'barragens': o['arquivo'] = P('barragens.geojson'); o['nome'] = f"Barragens cadastradas – SNISB/IAT ({cnt('barragens.geojson')})"
        elif i == 'massas-dagua': o['arquivo'] = P('massas_dagua.geojson'); o['nome'] = f"Açudes, represas e lagos – ANA ({cnt('massas_dagua.geojson')})"
        elif i == 'microbacias': o['arquivo'] = P('microbacias.geojson')
        elif i == 'licencas' and os.path.exists(P('licencas.geojson')):
            o.update({'arquivo': P('licencas.geojson'), 'nome': f"Licenças ambientais IAT – vigentes ({cnt('licencas.geojson')})"})
        elif i == 'licencas-vencidas' and os.path.exists(P('licencas_vencidas.geojson')):
            o.update({'arquivo': P('licencas_vencidas.geojson'), 'nome': f"Licenças ambientais IAT – vencidas sem renovação ({cnt('licencas_vencidas.geojson')})"})
        elif i == 'mineracao' and os.path.exists(P('mineracao.geojson')):
            o.update({'arquivo': P('mineracao.geojson'), 'nome': f"Processos minerários – ANM ({cnt('mineracao.geojson')})"})
        elif i == 'risco-sgb' and os.path.exists(P('risco_sgb.geojson')):
            n = cnt('risco_sgb.geojson')
            o.update({'arquivo': P('risco_sgb.geojson'), 'nome': f"Setores de risco geológico – SGB ({n})" if n else 'Setores de risco – SGB (município ainda não mapeado)'})
        elif i == 'sitios-arqueologicos' and os.path.exists(P('sitios_arqueologicos.geojson')):
            o.update({'arquivo': P('sitios_arqueologicos.geojson'), 'nome': f"Sítios arqueológicos – IPHAN ({cnt('sitios_arqueologicos.geojson')})"})
        elif i == 'comunidades' and os.path.exists(P('comunidades_tradicionais.geojson')):
            o.update({'arquivo': P('comunidades_tradicionais.geojson'), 'nome': f"Terras indígenas e quilombolas até 10 km ({cnt('comunidades_tradicionais.geojson')})"})
        elif i == 'declividade': o['arquivo'] = P('declividade.json')
        elif i == 'curvas': o['tiles'] = P('curvas/{z}/{x}/{y}.pbf')
        else: continue
        novo.append(o)
    c['camadas_opcionais'] = novo
    c['raiox'] = {'car': P('car.geojson'), 'sigef': P('sigef.geojson'), 'embargos': P('embargos.geojson'), 'alertas': P('alertas.geojson'),
                  'outorgas': [P('outorgas_rural.geojson'), P('outorgas_urbana.geojson')], 'licencas': P('licencas.geojson') if os.path.exists(P('licencas.geojson')) else None, 'barragens': P('barragens.geojson'), 'massas': P('massas_dagua.geojson'),
                  'microbacias': P('microbacias.geojson'), 'declividade': P('declividade.json'), 'municipio': f'{NOME}/PR'}
    for k, a in (('aptidao', 'aptidao.json'), ('solos', 'solos.geojson'), ('calcario', 'calcario.geojson'), ('ucs', 'ucs.geojson'), ('rios', 'rios_fbds.geojson'), ('nascentes', 'nascentes_fbds.geojson'), ('mineracao', 'mineracao.geojson'), ('risco', 'risco_sgb.geojson'), ('sitios', 'sitios_arqueologicos.geojson'), ('comunidades', 'comunidades_tradicionais.geojson')):
        if os.path.exists(P(a)): c['raiox'][k] = P(a)
    if os.path.exists(P('demo.geojson')):  # imóvel fictício de demonstração
        c['raiox']['demo'] = P('demo.geojson')
        for cam in c['camadas']:
            if cam['id'] == 'imoveis' and 'Imóvel de exemplo' not in cam['campos']: cam['campos'].insert(0, 'Imóvel de exemplo')
    try:  # % da área georreferenciada (SIGEF) e situação do CAR no painel
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import estat_geo
        c = estat_geo.aplicar(c, estat_geo.calcular(*(json.load(open(P(a))) for a in ('municipio.geojson', 'car.geojson', 'sigef.geojson'))))
    except Exception as e: log('estatística SIGEF falhou', e)
    json.dump(c, open(P('config.json'), 'w'), ensure_ascii=False, indent=1)
    # lista de municípios do site
    L = 'data/municipios.json'
    lista = json.load(open(L)) if os.path.exists(L) else []
    lista = [m for m in lista if m['codigo'] != COD] + [{'codigo': COD, 'nome': NOME, 'imoveis': len(ativos), 'atualizado_em': c['atualizado_em']}]
    json.dump(sorted(lista, key=lambda m: m['nome']), open(L, 'w'), ensure_ascii=False, indent=1)
    log('config ok', NOME, len(ativos), 'imóveis')
    try:  # resumo quantitativo para o painel regional
        import resumo_regional; resumo_regional.gerar(D)
    except Exception as e: log('resumo regional falhou', e)

ETAPAS = os.environ.get('ETAPAS', 'car,sigef,ibama,microbacias,mb_cobertura,mb_alertas,outorgas,licencas,barragens,massas,hidrografia,relevo,mineracao,risco_sgb,patrimonio,aptidao,pendencias,config').split(',')
for e in ETAPAS: globals()[e.strip()]()
