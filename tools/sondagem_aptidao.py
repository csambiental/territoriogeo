"""Sondagem das fontes do bloco 'aptidão' do Raio-X: clima, solos, calcário, áreas protegidas, relevo."""
import json, re, urllib.request, sys, os
sys.path.insert(0, 'analise/tools')
try: import ssl_aia
except Exception as e: print('ssl_aia', e)
UA = {'User-Agent': 'Mozilla/5.0 (csambiental)'}
def get(u, n=600, raw=False):
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=120); b = r.read()
        print('OK', r.status, len(b), u[:150]); return b if raw else b.decode('utf-8', 'ignore')
    except Exception as e: print('ERRO', type(e).__name__, str(e)[:200], u[:150]); return ''
t = get('https://power.larc.nasa.gov/api/temporal/climatology/point?parameters=PRECTOTCORR,T2M,T2M_MAX,T2M_MIN&community=AG&longitude=-50.79&latitude=-23.17&format=JSON')
if t: print(json.dumps(json.loads(t)['properties']['parameter'])[:900])
t = get('https://geoservicos.ibge.gov.br/geoserver/wfs?service=WFS&version=1.0.0&request=GetCapabilities')
print('IBGE camadas pedo/solo/geomorf/vegeta:', sorted(set(re.findall(r'<Name>([^<]*(?:pedo|Pedo|solo|Solo|geomorf|clima|Clima|bioma|Bioma)[^<]*)</Name>', t)))[:40])
for s in ['', 'SIGMINE']:
    t = get(f'https://geo.anm.gov.br/arcgis/rest/services/{s}?f=json')
    if t: print('ANM', s, json.loads(t).get('services'), json.loads(t).get('folders'))
for s in ['SIGMINE/sociedade_cultura/MapServer', 'SIGMINE/meio_ambiente/MapServer', 'SIGMINE/areas_restricao/MapServer']:
    t = get(f'https://geo.anm.gov.br/arcgis/rest/services/{s}?f=json')
    if t:
        try: print(s, [(l['id'], l['name']) for l in json.loads(t).get('layers', [])])
        except Exception: print(t[:300])
t = get('https://acervofundiario.incra.gov.br/i3geo/ogc.php?service=WFS&version=1.0.0&request=GetCapabilities')
print('INCRA temas:', re.findall(r'<Name>([^<]*)</Name>', t)[:60])
t = get('http://mapas.mma.gov.br/i3geo/ogc.php?service=WFS&version=1.0.0&request=GetCapabilities')
print('MMA temas:', [x for x in re.findall(r'<Name>([^<]*)</Name>', t) if re.search('uc|flor|embar|conserv', x, re.I)][:40])
get('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/1468/2338.png', raw=True)
get('https://planetarycomputer.microsoft.com/api/sas/v1/token/cop-dem-glo-30')
t = get('https://geoservicos.inde.gov.br/geoserver/ows?service=WFS&version=1.0.0&request=GetCapabilities')
print('INDE temas uc/flor/embargo:', [x for x in re.findall(r'<Name>([^<]*)</Name>', t) if re.search('uc_|unidade|conserva|florest|embarg|assenta', x, re.I)][:40])
