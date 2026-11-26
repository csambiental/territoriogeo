"""Sondagem: fontes com PERÍMETRO (polígono) de sítios arqueológicos do IPHAN, perto de Piraí do Sul (Fazenda das Cavernas)."""
import json, urllib.request, urllib.parse, sys
UA = {'User-Agent': 'Mozilla/5.0 (csambiental)'}
OUT = sys.argv[1]
BB = (-50.13, -24.52, -50.06, -24.45)
def get(u, n=3000):
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=90).read()
        t = r.decode('utf-8', 'ignore'); print('OK', len(t), u); print('   ', t[:n].replace('\n', ' ')); return t
    except Exception as e:
        print('ERRO', u, e); return ''
# 1) ANM sociedade_cultura: lista de camadas
t = get('https://geo.anm.gov.br/arcgis/rest/services/SIGMINE/sociedade_cultura/MapServer?f=json', 4000)
# 2) Geoservers do IPHAN
for base in ['https://geoserver.iphan.gov.br/geoserver', 'http://portal.iphan.gov.br/geoserver', 'https://portal.iphan.gov.br/geoserver', 'https://sicg.iphan.gov.br/geoserver']:
    t = get(base + '/ows?service=WFS&version=2.0.0&request=GetCapabilities', 400)
    if t:
        import re
        nomes = re.findall(r'<(?:wfs:)?Name>([^<]+)</(?:wfs:)?Name>', t)
        print('   camadas:', nomes[:200])
        for nm in [n for n in nomes if re.search(r'sitio|arque', n, re.I)]:
            q = {'service': 'WFS', 'version': '2.0.0', 'request': 'GetFeature', 'typeNames': nm, 'outputFormat': 'application/json', 'srsName': 'EPSG:4326',
                 'bbox': f'{BB[1]},{BB[0]},{BB[3]},{BB[2]},EPSG:4326', 'count': 50}
            r = get(base + '/ows?' + urllib.parse.urlencode(q), 1500)
            if r:
                open(f'{OUT}/{nm.replace(":", "_")}.json', 'w').write(r)
                try:
                    d = json.loads(r); print('   ', nm, len(d['features']), [f['geometry']['type'] for f in d['features']][:10], [f['properties'] for f in d['features']][:2])
                except Exception as e: print('   json?', e)
# 3) WMS do IPHAN (camadas publicadas no INDE)
get('https://inde.gov.br/api/catalogo/get', 300)
