"""Baixa os PERÍMETROS (polígonos) de sítios arqueológicos do IPHAN (SICG) no Paraná → sitios_pol_pr.geojson"""
import json, urllib.request, urllib.parse, sys
OUT = sys.argv[1]; UA = {'User-Agent': 'Mozilla/5.0 (csambiental)'}
BB = (-54.7, -26.8, -47.9, -22.4)
feats, start = [], 0
while True:
    q = {'service': 'WFS', 'version': '2.0.0', 'request': 'GetFeature', 'typeNames': 'SICG:sitios_pol', 'outputFormat': 'application/json',
         'srsName': 'urn:ogc:def:crs:EPSG::4326', 'count': 1000, 'startIndex': start, 'sortBy': 'id_bem',
         'bbox': f'{BB[1]},{BB[0]},{BB[3]},{BB[2]},urn:ogc:def:crs:EPSG::4326'}
    u = 'https://geoserver.iphan.gov.br/geoserver/ows?' + urllib.parse.urlencode(q)
    d = json.loads(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=300).read())
    fs = d.get('features', []); print('página', start, len(fs), d.get('numberMatched'), flush=True)
    for f in fs:
        a = f['properties']
        if not (a.get('co_iphan') or '').startswith('PR'): continue
        if not f.get('geometry'): continue
        def r(o): return ([round(o[0], 6), round(o[1], 6)] if o and not isinstance(o[0], list) else [r(x) for x in o])
        m = {'type': f['geometry']['type'], 'coordinates': r(f['geometry']['coordinates'])}
        feats.append({'type': 'Feature', 'geometry': m, 'properties': {k: v for k, v in {
            'nome': f"Sítio arqueológico {(a.get('identificacao_bem') or '').strip()}".strip(), 'grupo': 'Sítio arqueológico (perímetro)',
            'Código IPHAN (CNSA)': a.get('co_iphan') or '', 'Classificação': a.get('ds_classificacao') or '', 'Localidade': a.get('no_logradouro') or '',
            'Cadastro': (a.get('dt_cadastro') or '')[:10]}.items() if v}})
    if len(fs) < 1000: break
    start += 1000
json.dump({'type': 'FeatureCollection', 'fonte': 'IPHAN – SICG (geoserver.iphan.gov.br, camada SICG:sitios_pol)', 'features': feats}, open(f'{OUT}/sitios_pol_pr.geojson', 'w'), ensure_ascii=False, separators=(',', ':'))
print('polígonos PR', len(feats))
