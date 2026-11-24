"""Sondagem: camadas declaradas do CAR (APP, RL, consolidada, vegetação, hidrografia, nascentes) disponíveis publicamente."""
import sys, re, json, urllib.request, urllib.parse
OUT = sys.argv[1]
CAR = 'PR-4126009-950975FD4C98483D8147792940690205'
def get(u, t=90):
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=t)
        return r.status, r.read()
    except Exception as e:
        return getattr(e, 'code', 0), str(e).encode()
base = 'https://geoserver.car.gov.br/geoserver'
for ws in ('sicar', ''):
    u = f'{base}/{ws + "/" if ws else ""}wfs?service=WFS&version=1.0.0&request=GetCapabilities'
    s, b = get(u, 120)
    names = re.findall(rb'<Name>([^<]+)</Name>', b)
    print('CAP', ws or '(raiz)', s, len(b), 'camadas:', len(names))
    open(f'{OUT}/cap_{ws or "raiz"}.xml', 'wb').write(b)
    for n in names:
        n = n.decode()
        if re.search(r'pr|app|reserva|rl|veget|consol|hidro|nasc|uso|servid', n, re.I): print('   ', n)
# tentar atributos/consulta por código do CAR nas camadas candidatas
for camada in ('sicar:sicar_imoveis_pr', 'sicar:sicar_app_pr', 'sicar:sicar_reserva_legal_pr', 'sicar:sicar_vegetacao_nativa_pr',
               'sicar:sicar_area_consolidada_pr', 'sicar:sicar_hidrografia_pr', 'sicar:sicar_nascentes_pr'):
    q = {'service': 'WFS', 'version': '1.0.0', 'request': 'GetFeature', 'typeName': camada, 'outputFormat': 'application/json',
         'maxFeatures': 3, 'CQL_FILTER': f"cod_imovel='{CAR}'"}
    s, b = get(f'{base}/sicar/wfs?' + urllib.parse.urlencode(q))
    print('Q', camada, s, b[:300])
# consulta pública SICAR (demonstrativo)
for u in (f'https://consultapublica.car.gov.br/publico/imoveis/index',
          f'https://car.gov.br/publico/imoveis/index'):
    s, b = get(u); print('PUB', u, s, len(b), b[:200])
