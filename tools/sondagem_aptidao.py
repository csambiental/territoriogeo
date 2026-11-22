"""Sondagem das fontes do bloco 'aptidão' do Raio-X: clima, solos, calcário, áreas protegidas, relevo."""
import json, re, urllib.request, sys, os
import subprocess; subprocess.run([sys.executable,'-m','pip','install','-q','cryptography','shapely'])
sys.path.insert(0, 'analise/tools')
try: import ssl_aia
except Exception as e: print('ssl_aia', e)
UA = {'User-Agent': 'Mozilla/5.0 (csambiental)'}
def get(u, n=600, raw=False):
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=120); b = r.read()
        print('OK', r.status, len(b), u[:150]); return b if raw else b.decode('utf-8', 'ignore')
    except Exception as e: print('ERRO', type(e).__name__, str(e)[:200], u[:150]); return ''
t = get('https://geoservicos.ibge.gov.br/geoserver/wfs?service=WFS&version=1.0.0&request=GetCapabilities')
print('IBGE UC/assent/TI/florest:', sorted(set(x for x in re.findall(r'<Name>([^<]*)</Name>', t) if re.search('conserv|_uc|assenta|florest|indigen|quilomb', x, re.I)))[:60])
t = get('https://geoservicos.ibge.gov.br/geoserver/wfs?service=WFS&version=1.0.0&request=GetFeature&typeName=BDIA:pedo_area&maxFeatures=1&outputFormat=application/json&bbox=-50.85,-23.22,-50.75,-23.12,EPSG:4326')
print(t[:1500])
for s in ['', 'SIGMINE']:
    t = get(f'https://geo.anm.gov.br/arcgis/rest/services/{s}?f=json')
    if t: print('ANM', s, json.loads(t).get('services'), json.loads(t).get('folders'))
for s in ['SIGMINE/sociedade_cultura/MapServer']+[x+'/MapServer' for x in ['SIGMINE/'+y for y in ['meio_ambiente','areas_restricao','dados_anm','infraestrutura','limites']]]:
    t = get(f'https://geo.anm.gov.br/arcgis/rest/services/{s}?f=json')
    if t:
        try: print(s, [(l['id'], l['name']) for l in json.loads(t).get('layers', [])])
        except Exception: print(t[:300])
for u in ['https://certificacao.incra.gov.br/csv_shp/zip/Assentamento%20Brasil_PR.zip','https://certificacao.incra.gov.br/csv_shp/export_shp.py']: get(u)
t = get('https://acervofundiario.incra.gov.br/i3geo/ogc.php?service=WFS&version=1.0.0&request=GetCapabilities')
print('INCRA temas:', re.findall(r'<Name>([^<]*)</Name>', t)[:60])
t = get('http://mapas.mma.gov.br/i3geo/ogc.php?service=WFS&version=1.0.0&request=GetCapabilities')
print('MMA temas:', [x for x in re.findall(r'<Name>([^<]*)</Name>', t) if re.search('uc|flor|embar|conserv', x, re.I)][:40])
get('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/1468/2338.png', raw=True)
get('https://planetarycomputer.microsoft.com/api/sas/v1/token/cop-dem-glo-30')
t = get('https://geoservicos.inde.gov.br/geoserver/ows?service=WFS&version=1.0.0&request=GetCapabilities')
print('INDE temas uc/flor/embargo:', [x for x in re.findall(r'<Name>([^<]*)</Name>', t) if re.search('uc_|unidade|conserva|florest|embarg|assenta', x, re.I)][:40])

for u in ['https://dados.mma.gov.br/dataset/unidadesdeconservacao','https://www.gov.br/icmbio/pt-br/assuntos/dados_geoespaciais/mapa-tematico-e-dados-geoestatisticos-das-unidades-de-conservacao-federais',
          'https://cnuc.mma.gov.br/','https://dadosabertos.icmbio.gov.br/','https://www.gov.br/florestal/pt-br/assuntos/cadastro-nacional-de-florestas-publicas']:
    t=get(u); print('  links zip/shp:', sorted(set(re.findall(r'href="([^"]+\.(?:zip|shp|csv|geojson|kml)[^"]*)"', t)))[:15])
