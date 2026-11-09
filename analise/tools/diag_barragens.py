"""Procura fontes de barragens (IAT, SNISB/ANA, ANEEL) e conta o que há em Grandes Rios e Joaquim Távora."""
import json, urllib.request, urllib.parse, ssl
UA = {'User-Agent': 'csambiental'}
ctx = ssl.create_default_context(); ctx.set_ciphers('DEFAULT@SECLEVEL=0'); ctx.options |= 0x4
def get(u, **q):
    q.setdefault('f', 'json'); u = u + ('&' if '?' in u else '?') + urllib.parse.urlencode(q)
    return json.load(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=60, context=ctx))
CAIXAS = {'Grandes Rios': '-51.62,-24.25,-51.38,-24.05', 'Joaquim Távora': '-50.0,-23.62,-49.8,-23.42'}
def varrer(raiz, chaves, prof=0):
    try: d = get(raiz)
    except Exception as e: print('ERRO', raiz, str(e)[:100]); return
    for s in d.get('services', []):
        nome = s['name']
        if any(k in nome.lower() for k in chaves):
            u = f"{raiz.split('/rest/services')[0]}/rest/services/{nome}/{s['type']}"
            try:
                m = get(u)
                for l in m.get('layers', []):
                    lu = f"{u}/{l['id']}"
                    linha = [lu, l['name']]
                    for mun, bb in CAIXAS.items():
                        try:
                            n = get(lu + '/query', where='1=1', geometry=bb, geometryType='esriGeometryEnvelope', inSR=4326, spatialRel='esriSpatialRelIntersects', returnCountOnly='true').get('count')
                        except Exception as e: n = 'erro'
                        linha.append(f'{mun}={n}')
                    print('  ', ' | '.join(map(str, linha)))
            except Exception as e: print('ERRO svc', u, str(e)[:100])
    if prof < 1:
        for f in d.get('folders', []): varrer(raiz.rstrip('/') + '/' + f, chaves, prof + 1)
print('== IAT GeoPR'); varrer('https://geopr.iat.pr.gov.br/server/rest/services', ['barrag', 'reserv', 'represa', 'acude', 'açude', 'seguran'])
print('== SNIRH/ANA'); varrer('https://www.snirh.gov.br/arcgis/rest/services', ['barrag', 'snisb', 'reserv', 'massa'])
print('== ANA geoservicos'); varrer('https://www.snirh.gov.br/arcgis/rest/services/SNISB', ['', ])
