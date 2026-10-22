"""Baixa do SNIRH/ANA as bacias (comitês estaduais do PR) e as microbacias da região do programa
e grava GeoJSON simplificado em data/bacias/. Executado pelo GitHub Actions."""
import json, urllib.request, urllib.parse
from shapely.geometry import Polygon, MultiPolygon, mapping, shape
from shapely.geometry.polygon import orient

BASE = 'https://www.snirh.gov.br/arcgis/rest/services/SPR'
ENV = (-51.40, -23.86, -50.80, -23.10)  # município de Londrina + margem

def consulta(url, params):
    feats, offset = [], 0
    while True:
        p = dict(params, f='json', outSR='4326', returnGeometry='true', resultOffset=offset, resultRecordCount=1000)
        req = urllib.request.Request(url + '/query?' + urllib.parse.urlencode(p), headers={'User-Agent': 'csambiental-mapa'})
        for tent in range(6):
            try:
                d = json.load(urllib.request.urlopen(req, timeout=180)); break
            except Exception as e:
                print('tentativa', tent + 1, 'falhou:', e, flush=True)
                if tent == 5: raise
                import time; time.sleep(30 * (tent + 1))
        if 'error' in d: raise SystemExit(json.dumps(d))
        feats += d.get('features', [])
        if not d.get('exceededTransferLimit') or not d.get('features'): return feats
        offset += len(d['features'])

def esri_para_shape(geom):
    exteriores, furos = [], []
    for anel in geom.get('rings', []):
        if len(anel) < 4: continue
        p = Polygon(anel)
        (furos if p.exterior.is_ccw else exteriores).append(p)  # Esri: externo no sentido horário
    polys = []
    for e in exteriores:
        hs = [h.exterior.coords for h in furos if e.contains(h.representative_point())]
        polys.append(Polygon(e.exterior.coords, hs))
    g = MultiPolygon(polys) if len(polys) > 1 else (polys[0] if polys else None)
    return g.buffer(0) if g is not None else None

import re
def nome_bacia(n):
    n = re.sub(r'^CBH\s+', '', n or ''); n = re.sub(r'^(do|dos|da)\s+', '', n)
    return n[:1].upper() + n[1:]

def salvar(feats, campos, arquivo, tol):
    out = []
    for f in feats:
        g = esri_para_shape(f['geometry'])
        if g is None or g.is_empty: continue
        g = g.simplify(tol, preserve_topology=True)
        props = {novo: f['attributes'].get(velho) for novo, velho in campos.items()}
        if 'nome' in props: props['nome'] = nome_bacia(props['nome'])
        out.append({'type': 'Feature', 'properties': props, 'geometry': mapping(g)})
    def arred(o):
        if isinstance(o, float): return round(o, 5)
        if isinstance(o, (list, tuple)): return [arred(x) for x in o]
        if isinstance(o, dict): return {k: arred(v) for k, v in o.items()}
        return o
    json.dump(arred({'type': 'FeatureCollection', 'features': out}), open(arquivo, 'w'), ensure_ascii=False, separators=(',', ':'))
    print(arquivo, len(out))

env = {'geometry': ','.join(map(str, ENV)), 'geometryType': 'esriGeometryEnvelope', 'inSR': '4326', 'spatialRel': 'esriSpatialRelIntersects'}
bacias = consulta(BASE + '/Comites_2021/FeatureServer/1', {'where': "SGUF='PR'", 'outFields': 'NMCBE,SGUF,NMRHI,AREAKM2'})
salvar(bacias, {'nome': 'NMCBE', 'regiao_hidrografica': 'NMRHI', 'area_km2': 'AREAKM2'}, 'data/bacias/bacias_parana.geojson', 0.002)
micro = consulta(BASE + '/Balanco_Hidrico_Quantitativo_Microbacia_2020/FeatureServer/0', dict(env, where='1=1', outFields='NORIOCOMP,COBACIA,UGRH'))
salvar(micro, {'rio': 'NORIOCOMP', 'cobacia': 'COBACIA', 'ugrh': 'UGRH'}, 'data/bacias/microbacias_regiao.geojson', 0.0008)
