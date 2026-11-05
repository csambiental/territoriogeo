"""Levanta fontes para o projeto clima de Londrina. Saída: data/_diag/fontes_clima.txt"""
import json, urllib.request, urllib.parse, re, sys
def get(u, t=60):
    try: return json.load(urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=t))
    except Exception as e: return {'_erro': str(e)[:200]}
S = 'https://geo.londrina.pr.gov.br/server/rest/services'
raiz = get(S + '?f=json'); pastas = [''] + raiz.get('folders', [])
print('PASTAS', pastas)
KW = re.compile(r'alag|inund|enchent|risco|drenag|galeria|boca|lobo|arbor|[áa]rvore|clima|calor|defesa|chuva|pluvi|eros|fundo|vale|h[íi]dri|c[óo]rrego|nascente|app|vegeta|verde|parque|bosque|temperat|vento|esta[cç][aã]o|meteor|sa[uú]de|dengue|vulner|social|favela|ocupa|declivi|topo|curva|relevo|bacia|rio|lago|represa', re.I)
for p in pastas:
    d = get(f'{S}/{p}?f=json' if p else f'{S}?f=json')
    for s in d.get('services', []):
        u = f"{S}/{s['name']}/{s['type']}"
        m = get(u + '?f=json')
        lays = m.get('layers', []) or []
        nomes = [l.get('name', '') for l in lays]
        if KW.search(s['name']) or any(KW.search(n) for n in nomes):
            print(f"\n### {s['name']} ({s['type']}) | {u}")
            for l in lays[:40]:
                if KW.search(l.get('name', '')) or KW.search(s['name']):
                    n = get(f"{u}/{l['id']}/query?where=1%3D1&returnCountOnly=true&f=json")
                    mm = get(f"{u}/{l['id']}?f=json")
                    print(f"   {l['id']} {l['name']} | {mm.get('geometryType')} | total {n.get('count', n.get('_erro', n.get('error', {}).get('message', '?')))} | campos {[f.get('alias') or f['name'] for f in (mm.get('fields') or [])][:25]}")
print('\n\n=== OPEN-METEO (ERA5) ===')
om = get('https://archive-api.open-meteo.com/v1/archive?latitude=-23.31&longitude=-51.16&start_date=1990-01-01&end_date=1990-01-03&daily=temperature_2m_max,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max&timezone=America%2FSao_Paulo')
print(json.dumps(om)[:800])
print('\n=== PLANETARY COMPUTER (Landsat C2 L2) ===')
st = get('https://planetarycomputer.microsoft.com/api/stac/v1/search?collections=landsat-c2-l2&bbox=-51.25,-23.40,-51.05,-23.23&datetime=2024-01-01/2024-03-31&limit=3')
print([ (f['id'], f['properties'].get('eo:cloud_cover')) for f in st.get('features', [])], st.get('_erro'))
print('\n=== INMET estações ===')
est = get('https://apitempo.inmet.gov.br/estacoes/T')
if isinstance(est, list): print([ (e.get('CD_ESTACAO'), e.get('DC_NOME'), e.get('DT_INICIO_OPERACAO')) for e in est if 'LONDRINA' in str(e.get('DC_NOME', '')).upper()])
else: print(est)
