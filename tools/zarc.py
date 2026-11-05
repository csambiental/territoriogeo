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
                if '4113700' in linha or 'LONDRINA' in linha.upper(): out.write(linha); k += 1
        print(safra, 'linhas', n, 'Londrina', k, '| cabeçalho:', cab.strip()[:400], flush=True)
    except Exception as e:
        print(safra, 'ERRO', e, flush=True)
