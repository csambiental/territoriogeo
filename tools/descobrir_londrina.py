"""Descobre as camadas do GeoLondrina (web app de lotes) e seus campos. Saída em data/_diag/geolondrina.txt"""
import json, urllib.request, urllib.parse, sys
P = 'https://geo.londrina.pr.gov.br/portal'
def get(u, **q):
    q.setdefault('f', 'json')
    u = u + ('&' if '?' in u else '?') + urllib.parse.urlencode(q)
    try:
        return json.load(urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=25))
    except Exception as e:
        return {'_erro': str(e)}
import re
ITENS = sys.argv[1:] or ['5360a454d15146a3bcf4ebdbe8e49e03', '2ebe100e9751469995f67324b75bcf01']
urls = set(); vistos = set(); fila = list(ITENS); webmaps = []
while fila:
    i = fila.pop(0)
    if i in vistos or len(vistos) > 25: continue
    vistos.add(i)
    info = get(f'{P}/sharing/rest/content/items/{i}')
    print('\nITEM', i, info.get('type'), '|', info.get('title'), '|', info.get('url'), '|', (info.get('snippet') or '')[:200], info.get('_erro', ''))
    if info.get('url') and 'rest/services' in str(info.get('url')): urls.add(info['url'])
    if info.get('type') == 'Web Map': webmaps.append(i); continue
    d = get(f'{P}/sharing/rest/content/items/{i}/data')
    txt = json.dumps(d)
    print('  data:', txt[:1200])
    for u in re.findall(r'https?://[^"\\ ]+/rest/services/[^"\\ ]+', txt): urls.add(u)
    for j in set(re.findall(r'\b[0-9a-f]{32}\b', txt)): fila.append(j)
for wm in webmaps:
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
