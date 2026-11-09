import json, urllib.request, urllib.parse, ssl
UA = {'User-Agent': 'csambiental'}
def get(u, **q):
    q.setdefault('f', 'json'); u = u + '?' + urllib.parse.urlencode(q)
    return json.load(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=90))
for u in ['https://www.snirh.gov.br/arcgis/rest/services/IG/SNISB/FeatureServer/0', 'https://www.snirh.gov.br/arcgis/rest/services/SPR/Massa_dagua/FeatureServer/0']:
    m = get(u); print('##', u, m.get('geometryType'), m.get('maxRecordCount')); print([(f['name'], f.get('alias')) for f in m['fields']])
    d = get(u + '/query', where='1=1', geometry='-50.0,-23.62,-49.8,-23.42', geometryType='esriGeometryEnvelope', inSR=4326, outSR=4326, outFields='*', f='geojson', resultRecordCount=4)
    for f in d['features']: print(json.dumps(f['properties'], ensure_ascii=False)[:1500])
print('## total PR SNISB', get('https://www.snirh.gov.br/arcgis/rest/services/IG/SNISB/FeatureServer/0/query', where="1=1", geometry='-54.7,-26.8,-48.0,-22.5', geometryType='esriGeometryEnvelope', inSR=4326, returnCountOnly='true'))
