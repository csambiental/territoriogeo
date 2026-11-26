"""Sondagem: perímetros (polígonos) de sítios arqueológicos no geoserver do IPHAN – PR."""
import json, urllib.request, urllib.parse, sys
UA = {'User-Agent': 'Mozilla/5.0 (csambiental)'}
OUT = sys.argv[1]; B = 'https://geoserver.iphan.gov.br/geoserver/ows?'
def get(q):
    u = B + urllib.parse.urlencode(q)
    try: t = urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=180).read().decode('utf-8', 'ignore'); return t
    except Exception as e: print('ERRO', u, e); return ''
for nm in ['SICG:sitios_pol', 'SICG:sitios']:
    print('\n=====', nm)
    print(get({'service': 'WFS', 'version': '2.0.0', 'request': 'DescribeFeatureType', 'typeNames': nm})[:2500])
    base = {'service': 'WFS', 'version': '1.1.0', 'request': 'GetFeature', 'typeName': nm, 'outputFormat': 'application/json', 'maxFeatures': 3}
    t = get(base); print('sem filtro:', t[:1500])
    for bb in ['-50.13,-24.52,-50.06,-24.45', '-24.52,-50.13,-24.45,-50.06']:
        t = get({**base, 'maxFeatures': 50, 'bbox': bb + ',EPSG:4326'})
        try: d = json.loads(t); print('bbox', bb, len(d['features']), [f['properties'] for f in d['features']][:3])
        except Exception: print('bbox', bb, t[:300])
    for cql in ["cd_municipio=4119400", "co_ibge=4119400", "uf='PR'", "sg_uf='PR'"]:
        t = get({**base, 'maxFeatures': 2000, 'CQL_FILTER': cql})
        try:
            d = json.loads(t); print('cql', cql, len(d['features']))
            if d['features']:
                json.dump(d, open(f'{OUT}/{nm.replace(":", "_")}_{cql.split("=")[0]}.json', 'w')); print([f['properties'] for f in d['features']][:2])
        except Exception: print('cql', cql, t[:200])
