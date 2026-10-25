"""Baixa camadas públicas do GeoPR/IAT dentro de Londrina (todas as subcamadas de cada serviço)."""
import json, time, urllib.request, urllib.parse, os, sys
from shapely.geometry import shape, mapping
SERVICOS = {
    'barragens': 'https://geopr.iat.pr.gov.br/server/rest/services/Hosted/barragens_dashboard_publico/FeatureServer',
}
def get(u, dados=None):
    for t in range(4):
        try:
            req = urllib.request.Request(u, data=urllib.parse.urlencode(dados).encode() if dados else None, headers={'User-Agent': 'csambiental-mapa'})
            return json.load(urllib.request.urlopen(req, timeout=180))
        except Exception as e:
            print('  tentativa', t + 1, e, flush=True); time.sleep(15 * (t + 1))
    raise SystemExit('falhou ' + u)
mun = shape(json.load(open('data/municipio_londrina.geojson'))['features'][0]['geometry'])
minx, miny, maxx, maxy = mun.buffer(0.005).bounds
for nome, url in SERVICOS.items():
    sv = get(url + '?f=json')
    camadas = sv.get('layers', []) + sv.get('tables', [])
    print('SERVIÇO', nome, [(c['id'], c['name']) for c in camadas], flush=True)
    for c in sv.get('layers', []):
        info = get(f"{url}/{c['id']}?f=json")
        print(' CAMADA', c['id'], c['name'], info.get('geometryType'), [f['name'] + ':' + (f.get('alias') or '') for f in info.get('fields', [])], flush=True)
        feats, off = [], 0
        while True:
            d = get(f"{url}/{c['id']}/query", {'where': '1=1', 'geometry': f'{minx},{miny},{maxx},{maxy}', 'geometryType': 'esriGeometryEnvelope',
                    'inSR': '4326', 'spatialRel': 'esriSpatialRelIntersects', 'outSR': '4326', 'outFields': '*', 'returnZ': 'false', 'returnM': 'false',
                    'f': 'geojson', 'resultOffset': off, 'resultRecordCount': 1000})
            fs = d.get('features', []); feats += fs
            if len(fs) < 1000: break
            off += len(fs)
        dentro = [f for f in feats if f.get('geometry') and shape(f['geometry']).intersects(mun)]
        print('  ', len(feats), 'no retângulo,', len(dentro), 'em Londrina', flush=True)
        if dentro: print('   exemplo', json.dumps(dentro[0]['properties'], ensure_ascii=False)[:900], flush=True)
        json.dump({'type': 'FeatureCollection', 'features': dentro}, open(f"data/iat/{nome}_{c['id']}.geojson", 'w'), ensure_ascii=False, separators=(',', ':'))
