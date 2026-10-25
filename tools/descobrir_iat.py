"""Descobre as camadas usadas no painel do IAT (Experience Builder) e lista os serviços de publicação."""
import json, urllib.request, re
P = 'https://geopr.iat.pr.gov.br/portal/sharing/rest'
def get(u):
    return json.load(urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'csambiental-mapa'}), timeout=120))
item = '8cf1eaa023fa40e88549e4f727f1812f'
try:
    info = get(f'{P}/content/items/{item}?f=json'); print('ITEM', info.get('title'), info.get('type'))
    data = get(f'{P}/content/items/{item}/data?f=json')
    txt = json.dumps(data)
    for u in sorted(set(re.findall(r'https?://[^"\\]+/(?:MapServer|FeatureServer)[^"\\]*', txt))): print('URL', u)
    for wid in sorted(set(re.findall(r'"itemId": ?"([0-9a-f]{32})"', txt))):
        try:
            w = get(f'{P}/content/items/{wid}?f=json'); print('SUBITEM', wid, w.get('type'), w.get('title'), w.get('url'))
            if w.get('type') in ('Web Map',):
                d2 = json.dumps(get(f'{P}/content/items/{wid}/data?f=json'))
                for u in sorted(set(re.findall(r'https?://[^"\\]+/(?:MapServer|FeatureServer)[^"\\]*', d2))): print('  URL', u)
                for t in re.findall(r'"title": ?"([^"]+)"', d2)[:60]: print('  TITULO', t)
        except Exception as e: print('erro sub', wid, e)
except Exception as e: print('erro item', e)
try:
    s = get('https://geopr.iat.pr.gov.br/server/rest/services/00_PUBLICACOES?f=json')
    for x in s.get('services', []): print('SERV', x['name'], x['type'])
except Exception as e: print('erro serv', e)
