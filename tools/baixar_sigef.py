"""Imóveis certificados no SIGEF/INCRA (serviço público do IAT-PR) dentro de Londrina."""
import json, time, urllib.request, urllib.parse, datetime
from shapely.geometry import shape, mapping

URL = 'https://geopr.iat.pr.gov.br/server/rest/services/00_PUBLICACOES/imoveis_certificados_sigef_incra/FeatureServer/0/query'
mun = shape(json.load(open('data/municipio_londrina.geojson'))['features'][0]['geometry'])
minx, miny, maxx, maxy = mun.bounds
feats, off = [], 0
while True:
    q = {'where': '1=1', 'geometry': f'{minx},{miny},{maxx},{maxy}', 'geometryType': 'esriGeometryEnvelope', 'inSR': '4326',
         'spatialRel': 'esriSpatialRelIntersects', 'outSR': '4326', 'returnZ': 'false', 'returnM': 'false',
         'outFields': 'parcela_co,codigo_imo,situacao_i,status,nome_area,registro_m,data_submi,data_aprov,municipio_',
         'f': 'geojson', 'resultOffset': off, 'resultRecordCount': 1000}
    for t in range(5):
        try:
            d = json.load(urllib.request.urlopen(urllib.request.Request(URL, data=urllib.parse.urlencode(q).encode(), headers={'User-Agent': 'csambiental-mapa'}), timeout=180)); break
        except Exception as e:
            print('tentativa', t + 1, e, flush=True); time.sleep(20 * (t + 1))
            if t == 4: raise
    fs = d.get('features', []); feats += fs
    print('lote', off, len(fs), flush=True)
    if len(fs) < 1000 and not d.get('exceededTransferLimit') and not (d.get('properties') or {}).get('exceededTransferLimit'): break
    off += len(fs)
data = lambda ms: datetime.datetime.utcfromtimestamp(ms / 1000).strftime('%d/%m/%Y') if isinstance(ms, (int, float)) else (ms or '')
out = []
for f in feats:
    if not f.get('geometry'): continue
    g = shape(f['geometry']).buffer(0)
    if not g.intersects(mun) or g.intersection(mun).area < 0.5 * g.area: continue
    p = f['properties']
    out.append({'type': 'Feature', 'geometry': mapping(g.simplify(0.00002, preserve_topology=True)), 'properties': {
        'nome': p.get('nome_area') or 'Imóvel certificado', 'Código SNCR (INCRA)': p.get('codigo_imo') or '',
        'Parcela SIGEF': p.get('parcela_co') or '', 'Situação': p.get('situacao_i') or '', 'Status': p.get('status') or '',
        'Matrícula / registro': p.get('registro_m') or '', 'Enviado em': data(p.get('data_submi')), 'Certificado em': data(p.get('data_aprov')),
        'Área (ha)': f"{g.area * 111320 * 110574 * 0.9168 / 1e4:.2f}".replace('.', ','),
        'link': f"https://sigef.incra.gov.br/geo/parcela/detalhe/{p.get('parcela_co')}/" if p.get('parcela_co') else '',
        'link_texto': 'Ver a parcela no SIGEF ↗'}})
def arred(o):
    if isinstance(o, float): return round(o, 6)
    if isinstance(o, (list, tuple)): return [arred(x) for x in o]
    if isinstance(o, dict): return {k: arred(v) for k, v in o.items()}
    return o
json.dump(arred({'type': 'FeatureCollection', 'features': out}), open('data/fundiario/sigef_londrina.geojson', 'w'), ensure_ascii=False, separators=(',', ':'))
print('baixados', len(feats), '| em Londrina', len(out))
