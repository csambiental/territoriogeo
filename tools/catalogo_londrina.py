"""Lista o catálogo público de dados do GeoLondrina (Hub 'aplicativospublicossiglon') e camadas/campos dos serviços. Saída: data/_diag/catalogo_londrina.txt"""
import json, urllib.request, urllib.parse
P = 'https://geo.londrina.pr.gov.br/portal/sharing/rest'
def get(u, **q):
    q.setdefault('f', 'json')
    try: return json.load(urllib.request.urlopen(urllib.request.Request(u + '?' + urllib.parse.urlencode(q), headers={'User-Agent': 'Mozilla/5.0'}), timeout=30))
    except Exception as e: return {'_erro': str(e)}
itens, start = [], 1
while start > 0 and len(itens) < 2000:
    r = get(f'{P}/search', q='-type:"Code Attachment"', num=100, start=start, sortField='title')
    itens += r.get('results', []); start = r.get('nextStart', -1)
    if '_erro' in r: print('ERRO busca', r); break
print('TOTAL itens públicos:', len(itens))
for t in sorted({i['type'] for i in itens}): print('  tipo', t, sum(1 for i in itens if i['type'] == t))
for i in itens:
    print(f"\nITEM {i['id']} | {i['type']} | {i['title']} | {i.get('url') or ''} | {(i.get('snippet') or '')[:250]} | tags={i.get('tags')}")
    u = i.get('url') or ''
    if i['type'] in ('Feature Service', 'Map Service') and '/rest/services/' in u:
        m = get(u)
        for l in (m.get('layers') or [])[:30]:
            mm = get(f"{u.rstrip('/')}/{l['id']}")
            n = get(f"{u.rstrip('/')}/{l['id']}/query", where='1=1', returnCountOnly='true')
            print(f"   camada {l['id']} {l.get('name')} | {mm.get('geometryType')} | total {n.get('count', '?')} | campos {[f['alias'] or f['name'] for f in mm.get('fields') or []][:40]}")
