"""Sondagem: tabela de preços de terras do DERAL/SEAB (PDF) e Overpass (OSM) para logística."""
import subprocess, sys, json, urllib.request, urllib.parse, re
subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', 'pdfplumber'])
import pdfplumber, io
UA = {'User-Agent': 'Mozilla/5.0 (csambiental)'}
def get(u, dados=None):
    r = urllib.request.urlopen(urllib.request.Request(u, data=dados, headers=UA), timeout=240); return r.read()
for u in ['https://www.agricultura.pr.gov.br/sites/seab/files/documento/2026-04/terras_pdf_publicacao_26_0.pdf', 'https://www.agricultura.pr.gov.br/sites/seab/files/documento/2026-04/Equivalencia_SIPT26_0.pdf']:
    try:
        b = get(u); print('\n#####', u, len(b))
        with pdfplumber.open(io.BytesIO(b)) as pdf:
            print('páginas', len(pdf.pages))
            for i in (0, 1, 2):
                if i < len(pdf.pages): print(f'--- pág {i+1}\n', (pdf.pages[i].extract_text() or '')[:2500])
            for i, pg in enumerate(pdf.pages):
                t = pg.extract_text() or ''
                for ln in t.split('\n'):
                    if re.search(r'Ura[íi]|Tamarana|Londrina', ln): print(f'p{i+1}:', ln)
            tb = pdf.pages[min(3, len(pdf.pages)-1)].extract_tables()
            print('tabelas pág 4:', json.dumps(tb[:1], ensure_ascii=False)[:1500])
    except Exception as e: print('ERRO', u, e)
q = '[out:json][timeout:120];(node["man_made"="silo"](-23.6,-51.2,-22.8,-50.4);way["man_made"="silo"](-23.6,-51.2,-22.8,-50.4);node["industrial"="slaughterhouse"](-24,-51.6,-22.4,-50);way["industrial"="slaughterhouse"](-24,-51.6,-22.4,-50);nwr["aeroway"="aerodrome"]["iata"](-24.5,-52,-22,-49);nwr["name"~"Cooperativa|Cocamar|Coamo|Integrada|Coopavel|Copacol|C\\\\.Vale|Lar "](-23.6,-51.2,-22.8,-50.4);nwr["industrial"~"sugar|ethanol"](-24,-51.6,-22.4,-50);nwr["product"~"sugar|ethanol|açúcar|etanol"](-24,-51.6,-22.4,-50););out center tags;'
for ep in ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']:
    try:
        d = json.loads(get(ep, urllib.parse.urlencode({'data': q}).encode()))
        print('\nOverpass', ep, len(d['elements']))
        from collections import Counter
        print(Counter((e['tags'].get('man_made') or e['tags'].get('industrial') or e['tags'].get('aeroway') or 'nome') for e in d['elements']))
        for e in d['elements'][:25]: print(' ', {k: v for k, v in e['tags'].items() if k in ('name', 'man_made', 'industrial', 'iata', 'operator', 'product', 'amenity', 'shop', 'office', 'landuse', 'building')})
        break
    except Exception as e: print('ERRO overpass', ep, e)
