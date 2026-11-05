"""ZARC – Zoneamento Agrícola de Risco Climático (MAPA, dados abertos): baixa as tábuas de risco de todas as safras
e guarda só as linhas de Londrina (IBGE 4113700) em data/zarc/bruto/<safra>.csv. Depois resume em data/zarc/zarc_londrina.json."""
import json, os, re, csv, io, urllib.request, gzip, sys
os.makedirs('data/zarc/bruto', exist_ok=True)
UA = {'User-Agent': 'clima-londrina-biosimos'}
API = 'https://dados.agricultura.gov.br/api/3/action/package_show?id=6d3d141c-885e-41a4-ab7f-dc8ff323b96f'
pkg = json.load(urllib.request.urlopen(urllib.request.Request(API, headers=UA), timeout=120))['result']
for r in pkg['resources']:
    print(r['name'], '|', r.get('format'), '|', r['url'], flush=True)
for r in pkg['resources']:
    m = re.search(r'(\d{4})[/-](\d{4})', r['name'] + ' ' + r['url'])
    if not m or 'csv' not in (r.get('format') or '').lower() + r['url'].lower(): continue
    safra = f'{m.group(1)}-{m.group(2)}'; dest = f'data/zarc/bruto/{safra}.csv'
    if os.path.exists(dest) and os.path.getsize(dest) > 1000 and safra < '2026': continue
    try:
        resp = urllib.request.urlopen(urllib.request.Request(r['url'], headers=UA), timeout=600)
        txt = io.TextIOWrapper(resp, encoding='latin-1' if 'latin' in (resp.headers.get_content_charset() or '') else 'utf-8', errors='replace', newline='')
        cab = txt.readline(); sep = ';' if cab.count(';') > cab.count(',') else ','
        n = k = 0
        with open(dest, 'w', encoding='utf-8') as out:
            out.write(cab)
            for linha in txt:
                n += 1
                if ';4113700;' in linha: out.write(linha); k += 1
        print(safra, 'linhas', n, 'Londrina', k, '| cabeçalho:', cab.strip()[:400], flush=True)
    except Exception as e:
        print(safra, 'ERRO', e, flush=True)

# ---------- resumo para o painel ----------
import glob
CULT = ['Soja', 'Milho 1ª Safra', 'Milho 2ª Safra', 'Trigo', 'Feijão', 'Feijão 2ª Safra', 'Aveia']
def norm(n):
    n = n.replace(' Sequeiro', '').strip()
    return {'Milho': 'Milho 1ª Safra', 'Feijão 1ª Safra': 'Feijão', 'Arroz Sequeiro': 'Arroz'}.get(n, n)
SOLO = {'1': 'Arenoso', '2': 'Textura média', '3': 'Argiloso', **{str(10 + i): f'AD{i}' for i in range(1, 7)}}
CICLO = {'20': 'Grupo I (precoce)', '21': 'Grupo II (médio)', '22': 'Grupo III (tardio)', '24': 'Grupo IV', '25': 'Grupo V', '26': 'Grupo VI'}
atual, hist = {}, {c: [] for c in CULT}
for f in sorted(glob.glob('data/zarc/bruto/*.csv')):
    safra = os.path.basename(f)[:9].replace('-', '/')
    R = [r for r in csv.DictReader(open(f, encoding='utf-8-sig'), delimiter=';') if r['geocodigo'] == '4113700']
    for c in CULT:
        rr = [r for r in R if norm(r['Nome_cultura']) == c]
        if not rr: continue
        dec = lambda r: [int(r[f'dec{i}'] or 0) for i in range(1, 37)]
        hist[c].append({'safra': safra, 'dec20': max(sum(1 for v in dec(r) if v == 20) for r in rr),
                        'decs': max(sum(1 for v in dec(r) if v) for r in rr)})
        atual[c] = {'safra': safra, 'portaria': rr[0]['Portaria'].replace('_', ' '),
                    'linhas': [{'ciclo': CICLO.get(r['Cod_Ciclo'], r['Cod_Ciclo']), 'solo': SOLO.get(r['Cod_Solo'], r['Cod_Solo']),
                                'nm': f"NM{r['Cod_NM']}" if r['Cod_NM'] not in ('', '0') else '', 'dec': dec(r)} for r in rr]}
json.dump({'municipio': 'Londrina (PR)', 'fonte': 'MAPA – Zoneamento Agrícola de Risco Climático (ZARC), tábuas de risco – dados abertos',
           'culturas': atual, 'historico': hist}, open('data/zarc/zarc_londrina.json', 'w'), ensure_ascii=False, separators=(',', ':'))
print('resumo', {c: v['safra'] for c, v in atual.items()})
