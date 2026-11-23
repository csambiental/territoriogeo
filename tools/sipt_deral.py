"""Tabela DERAL/SEAB de equivalência para o SIPT (VTN em R$/ha por aptidão agrícola) -> JSON.  Uso: python3 tools/sipt_deral.py PASTA"""
import subprocess, sys, json, urllib.request, io, re, unicodedata
subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', 'pdfplumber'])
import pdfplumber
OUT = sys.argv[1]
URL = 'https://www.agricultura.pr.gov.br/sites/seab/files/documento/2026-04/Equivalencia_SIPT26_0.pdf'
b = urllib.request.urlopen(urllib.request.Request(URL, headers={'User-Agent': 'Mozilla/5.0'}), timeout=240).read()
norm = lambda s: re.sub(r'[^A-Z0-9 ]', '', unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().upper()).strip()
APT = ['lavoura_boa', 'lavoura_regular', 'lavoura_restrita', 'pastagem_plantada', 'silvicultura_pastagem_natural', 'preservacao']
res = {}
with pdfplumber.open(io.BytesIO(b)) as pdf:
    print('páginas', len(pdf.pages))
    for i in (1, 2):
        if i < len(pdf.pages): print(f'--- pág {i+1}'); print('\n'.join((pdf.pages[i].extract_text() or '').split('\n')[:25]))
    for pg in pdf.pages:
        for ln in (pg.extract_text() or '').split('\n'):
            m = re.match(r'^\s*(\d{7})\s+(.+?)\s+((?:\d{1,3}(?:\.\d{3})*(?:,\d{2})?\s+){5}\d{1,3}(?:\.\d{3})*(?:,\d{2})?)\s*$', ln)
            if not m: continue
            v = [float(x.replace('.', '').replace(',', '.')) for x in m.group(3).split()]
            res[norm(m.group(2))] = {'cod': m.group(1), 'nome': m.group(2).strip(), **dict(zip(APT, v))}
print('municípios', len(res)); [print(k, res.get(k)) for k in ('URAI', 'LONDRINA', 'TAMARANA')]
json.dump({'fonte': 'SEAB/DERAL – Equivalência dos preços de terras para o SIPT 2026 (VTN em R$/ha por aptidão agrícola)', 'url': URL, 'aptidoes': APT, 'municipios': res},
          open(f'{OUT}/vtn_deral_sipt_2026.json', 'w'), ensure_ascii=False)
