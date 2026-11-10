"""Pipeline de um município do Paraná para a Análise Rural (Raio-X do imóvel).
Uso: python3 tools/municipio.py <código IBGE>   (rodar dentro da pasta analise/)
Gera tudo em data/m/<código>/ e o config.json do município. Cada etapa é independente: se uma falhar, as outras seguem.
Fontes: IBGE (limite), SICAR (CAR), IAT/INCRA (SIGEF), IBAMA (embargos), MapBiomas (uso do solo e alertas),
IAT (outorgas SIGARH e barragens), ANA/SNIRH (microbacias), Copernicus DEM (declividade e curvas de nível)."""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
import nomes_rios
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
            r = urllib.request.urlopen(req, timeout=timeout, context=SSL_LEGADO if 'car.gov.br' in url else None).read()
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

# ---------- 7) relevo: declividade e curvas de nível (Copernicus DEM) ----------
@etapa('Relevo')
def relevo():
    import rasterio, planetary_computer as pc
    from pystac_client import Client
    from rasterio.merge import merge
    from rasterio.features import geometry_mask
    from scipy import ndimage
    from PIL import Image
    bbox = MUN.buffer(0.01).bounds
    cat = Client.open('https://planetarycomputer.microsoft.com/api/stac/v1', modifier=pc.sign_inplace)
    srcs = [rasterio.open(i.assets['data'].href) for i in cat.search(collections=['cop-dem-glo-30'], bbox=bbox).items()]
    dem, tr = merge(srcs, bounds=bbox); dem = dem[0].astype('float32')
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
    json.dump({'imagem': f'{D}/declividade.png', 'cantos': [[w, n], [e, n], [e, s], [w, s]], 'fonte': 'Copernicus DEM GLO-30 (ESA)'}, open(f'{D}/declividade.json', 'w'))
    # curvas de nível
    sm = ndimage.gaussian_filter(dem, 1.2)
    with rasterio.open('/tmp/dem.tif', 'w', driver='GTiff', height=H, width=W, count=1, dtype='float32', crs=srcs[0].crs, transform=tr) as f: f.write(sm, 1)
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
    classes = Counter()
    for f in imv['features']:
        p = f['properties']
        for k in [k for k in p if k.startswith('Pendência') or k in ('pendencia_nivel', 'pendencias_n', 'Georreferenciamento SIGEF', 'Embargo IBAMA')]: p.pop(k)
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
    c['resumo'] = [{'valor': f'{len(ativos):,}'.replace(',', '.'), 'rotulo': 'imóveis rurais ativos no CAR'},
                   {'valor': f'{area / 1000:,.1f} mil'.replace('.', ',') if area >= 1000 else f'{area:,.0f}'.replace(',', '.'), 'rotulo': 'hectares cadastrados'},
                   {'valor': f'{100 * conf / max(1, len(ativos)):.0f}%', 'rotulo': 'analisados e em conformidade'}]
    c['programa'] = {'titulo': 'Sobre esta análise', 'texto': f'Imóveis rurais do CAR de {NOME} cruzados com SIGEF/INCRA, embargos do IBAMA, alertas de desmatamento, uso do solo (MapBiomas), outorgas e licenças ambientais do IAT, barragens do SNISB/IAT, açudes e represas (ANA), microbacias e relevo. Clique num imóvel e use o Raio-X para gerar o relatório.', 'etapas': []}
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
        elif i == 'declividade': o['arquivo'] = P('declividade.json')
        elif i == 'curvas': o['tiles'] = P('curvas/{z}/{x}/{y}.pbf')
        else: continue
        novo.append(o)
    c['camadas_opcionais'] = novo
    c['raiox'] = {'car': P('car.geojson'), 'sigef': P('sigef.geojson'), 'embargos': P('embargos.geojson'), 'alertas': P('alertas.geojson'),
                  'outorgas': [P('outorgas_rural.geojson'), P('outorgas_urbana.geojson')], 'licencas': P('licencas.geojson') if os.path.exists(P('licencas.geojson')) else None, 'barragens': P('barragens.geojson'), 'massas': P('massas_dagua.geojson'),
                  'microbacias': P('microbacias.geojson'), 'declividade': P('declividade.json'), 'municipio': f'{NOME}/PR'}
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

ETAPAS = os.environ.get('ETAPAS', 'car,sigef,ibama,microbacias,mb_cobertura,mb_alertas,outorgas,licencas,barragens,massas,relevo,pendencias,config').split(',')
for e in ETAPAS: globals()[e.strip()]()
