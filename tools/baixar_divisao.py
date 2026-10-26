"""Divisão territorial oficial de Londrina (IPPUL, Lei 13.718/2023): perímetros urbanos, bairros e regiões -> data/urbano/*.geojson"""
import json, urllib.request, urllib.parse, time
U = 'https://geo.londrina.pr.gov.br/server/rest/services/IPPUL/IppulDivisaoTerritorialLondrinaLei13718/MapServer'
def q(layer):
    d = {'where': '1=1', 'outFields': '*', 'outSR': 4326, 'geometryPrecision': 6, 'f': 'geojson'}
    for t in range(5):
        try:
            r = urllib.request.Request(f'{U}/{layer}/query', data=urllib.parse.urlencode(d).encode(), headers={'User-Agent': 'Mozilla/5.0'})
            return json.load(urllib.request.urlopen(r, timeout=180))
        except Exception as e: print(layer, 'tentativa', t + 1, e); time.sleep(10)
for layer, arq in ((2, 'perimetros_urbanos'), (0, 'bairros'), (1, 'regioes')):
    g = q(layer)
    if not g: continue
    print(arq, len(g['features']), g['features'][0]['properties'] if g['features'] else '')
    for f in g['features']:
        p = f['properties']
        nome = next((p[k] for k in p if k.upper() in ('NOME', 'BAIRRO', 'REGIAO', 'REGIÃO', 'PERIMETRO', 'PERÍMETRO', 'DISTRITO', 'NM_BAIRRO')), None) or next((v for v in p.values() if isinstance(v, str) and v.strip()), '')
        f['properties'] = {'nome': str(nome).strip().title() if nome else '', **{k: v for k, v in p.items() if isinstance(v, str) and v.strip() and not k.upper().startswith(('SHAPE', 'OBJECTID', 'GLOBALID'))}}
    json.dump(g, open(f'data/urbano/{arq}.geojson', 'w'), ensure_ascii=False, separators=(',', ':'))
