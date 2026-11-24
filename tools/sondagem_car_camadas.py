"""Sondagem: página de geoserviços do SICAR e camadas temáticas (APP, RL, vegetação etc.)."""
import sys, re, json, urllib.request, urllib.parse
OUT = sys.argv[1]
CAR = 'PR-4126009-950975FD4C98483D8147792940690205'
def get(u, t=120):
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=t)
        return r.status, r.read()
    except Exception as e:
        return getattr(e, 'code', 0), str(e).encode()
# 1) página de geoserviços (html via navegador)
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page()
    try:
        pg.goto('https://consultapublica.car.gov.br/publico/geoservicos/index', timeout=90000, wait_until='networkidle')
        txt = pg.inner_text('body'); html = pg.content()
        open(f'{OUT}/geoservicos.html', 'w').write(html); open(f'{OUT}/geoservicos.txt', 'w').write(txt)
        print('PAGINA', len(html)); print(txt[:4000])
        for u in sorted(set(re.findall(r'https?://[^"\'<> ]+', html))):
            if re.search(r'wms|wfs|geoserver|ows|shp|download', u, re.I): print('URL', u)
    except Exception as e: print('PAGINA erro', e)
    b.close()
# 2) capabilities completas: todas as camadas
s, b = get('https://geoserver.car.gov.br/geoserver/ows?service=WFS&version=1.0.0&request=GetCapabilities')
names = [n.decode() for n in re.findall(rb'<Name>([^<]+)</Name>', b)]
print('OWS WFS', s, len(names)); [print('  ', n) for n in names]
s, b = get('https://geoserver.car.gov.br/geoserver/ows?service=WMS&version=1.3.0&request=GetCapabilities')
names = sorted(set(n.decode() for n in re.findall(rb'<Name>([^<]+)</Name>', b)))
print('OWS WMS', s, len(names)); [print('  ', n) for n in names if re.search(r'pr|app|reserv|veg|consol|hidr|nasc|uso|tema', n, re.I)]
