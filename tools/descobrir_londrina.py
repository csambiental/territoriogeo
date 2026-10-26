"""Descobre as camadas do GeoLondrina (web app de lotes) e seus campos. Saída em data/_diag/geolondrina.txt"""
import json, urllib.request, urllib.parse, sys
P = 'https://geo.londrina.pr.gov.br/portal'
def get(u, **q):
    q.setdefault('f', 'json')
    u = u + ('&' if '?' in u else '?') + urllib.parse.urlencode(q)
    try:
        return json.load(urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=60))
    except Exception as e:
        return {'_erro': str(e)}
app = get(f'{P}/sharing/rest/content/items/5360a454d15146a3bcf4ebdbe8e49e03/data')
print('APP', json.dumps(app)[:1500])
wm = app.get('map', {}).get('itemId') if isinstance(app.get('map'), dict) else None
print('WEBMAP', wm)
urls = set()
if wm:
    d = get(f'{P}/sharing/rest/content/items/{wm}/data')
    def walk(ls, pre=''):
        for l in ls or []:
            print('CAMADA', pre + str(l.get('title')), l.get('url'), l.get('itemId'))
            if l.get('url'): urls.add(l['url'])
            walk(l.get('layers'), pre + str(l.get('title')) + ' / ')
    walk(d.get('operationalLayers'))
    walk(d.get('baseMap', {}).get('baseMapLayers'), 'BASE ')
for s in ('https://geo.londrina.pr.gov.br/server/rest/services', 'https://geo.londrina.pr.gov.br/arcgis/rest/services'):
    r = get(s); print('DIR', s, json.dumps(r)[:3000])
for u in sorted(urls):
    m = get(u)
    lays = m.get('layers') or []
    alvos = [f"{u.rstrip('/')}/{l['id']}" for l in lays] if lays else [u]
    for a in alvos:
        mm = get(a)
        n = get(a + '/query', where='1=1', returnCountOnly='true')
        print('\n###', a, '|', mm.get('name'), '|', mm.get('geometryType'), '| total', n.get('count', n), '| maxRecord', mm.get('maxRecordCount'), '| caps', mm.get('capabilities'))
        print('  campos:', [(f['name'], f.get('alias')) for f in mm.get('fields') or []])
        if 'count' in n:
            s = get(a + '/query', where='1=1', outFields='*', returnGeometry='false', resultRecordCount=2)
            for f in s.get('features', [])[:2]: print('  ex:', json.dumps(f.get('attributes'), ensure_ascii=False)[:1500])
