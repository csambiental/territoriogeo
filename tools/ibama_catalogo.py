"""Catálogo de dados abertos do IBAMA (CKAN) + amostra dos conjuntos úteis. Saída: data/_diag/ibama.txt"""
import json, urllib.request, csv, io, zipfile, re, sys
B = 'https://dadosabertos.ibama.gov.br'
def get(u, n=None, t=120):
    r = urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=t)
    return r.read(n) if n else r.read()
pk = json.loads(get(B + '/api/3/action/package_search?fq=organization:ibama&rows=200'))['result']['results']
print('TOTAL', len(pk))
uteis = []
for p in sorted(pk, key=lambda x: x['title']):
    print(f"\n## {p['title']} | {p['name']} | modificado {p.get('metadata_modified','')[:10]} | {(p.get('notes') or '')[:300].replace(chr(10),' ')}")
    for r in p['resources']:
        print(f"   - {r.get('format')} | {r.get('name')} | {r.get('url')} | {r.get('size')} | {str(r.get('last_modified') or '')[:10]}")
    if re.search(r'embargo|auto de infra|notifica|ctf|cadastro t[ée]cnico|licen|agrot[óo]xico|sinaflor - empreend|multa|apreens', p['title'], re.I):
        uteis.append(p)
print('\n\n==== AMOSTRAS ====')
for p in uteis:
    for r in p['resources']:
        if (r.get('format') or '').upper() not in ('CSV', 'ZIP'): continue
        u = r['url']
        try:
            raw = get(u, 3_000_000 if not u.lower().endswith('.zip') else None, 300)
            if u.lower().endswith('.zip') or raw[:2] == b'PK':
                z = zipfile.ZipFile(io.BytesIO(raw)); nm = z.namelist(); print('ZIP', u, nm[:10]); raw = z.read(nm[0])[:3_000_000]
            txt = raw.decode('utf-8', 'ignore') if raw[:3] != b'\xef\xbb\xbf' else raw[3:].decode('utf-8', 'ignore')
            if txt.count('�') > 10: txt = raw.decode('latin-1')
            sep = ';' if txt[:2000].count(';') > txt[:2000].count(',') else ','
            rows = list(csv.reader(io.StringIO(txt), delimiter=sep))
            print(f"\n### {p['title']} / {r.get('name')} ({u})\n colunas: {rows[0]}")
            for x in rows[1:3]: print('  ex:', x[:60])
            uf = [i for i, c in enumerate(rows[0]) if re.search(r'^(UF|SG_UF|UF_.*|sig_uf.*)$', c, re.I)]
            mun = [i for i, c in enumerate(rows[0]) if re.search(r'munic', c, re.I)]
            if uf:
                pr = [x for x in rows[1:] if len(x) > uf[0] and x[uf[0]].strip().upper() == 'PR']
                print('  linhas na amostra:', len(rows) - 1, '| PR:', len(pr))
                if mun:
                    from collections import Counter
                    print('  municípios PR (amostra):', Counter(x[mun[0]] for x in pr if len(x) > mun[0]).most_common(15))
            geo = [c for c in rows[0] if re.search(r'lat|lon|geom|wkt|coord|shape', c, re.I)]
            print('  colunas geográficas:', geo)
        except Exception as e:
            print('  ERRO', u, e)
        break
