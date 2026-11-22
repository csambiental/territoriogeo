"""Tabela DERAL/SEAB de preços médios de terras agrícolas (R$/ha) por município e classe de capacidade de uso -> JSON.
Uso: python3 tools/precos_deral.py PASTA_SAIDA [ano]"""
import subprocess, sys, json, urllib.request, io, re, unicodedata
subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', 'pdfplumber'])
import pdfplumber
OUT = sys.argv[1]; ANO = sys.argv[2] if len(sys.argv) > 2 else '2026'
URL = {'2026': 'https://www.agricultura.pr.gov.br/sites/seab/files/documento/2026-04/terras_pdf_publicacao_26_0.pdf'}[ANO]
b = urllib.request.urlopen(urllib.request.Request(URL, headers={'User-Agent': 'Mozilla/5.0'}), timeout=240).read()
CL = ['A-I', 'A-II', 'A-III', 'A-IV', 'B-VI', 'B-VII', 'C-VIII']
norm = lambda s: re.sub(r'[^a-z0-9]', '', unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().lower())
res = {}; ref = None
with pdfplumber.open(io.BytesIO(b)) as pdf:
    for pg in pdf.pages:
        ws = pg.extract_words(keep_blank_chars=False, use_text_flow=True)
        linhas = {}
        for w in ws: linhas.setdefault(round(w['top'] / 3), []).append(w)
        for k in sorted(linhas):
            L = sorted(linhas[k], key=lambda w: w['x0'])
            nums = [w for w in L if re.fullmatch(r'\d{1,3}(\.\d{3})+|\d{1,3}', w['text'])]
            nome = ' '.join(w['text'] for w in L if w not in nums).strip()
            if not nums or not nome or re.search('Munic|PREÇOS|SECRETARIA|DEPARTAMENTO|DIVIS', nome): continue
            if ref is None and len(nums) == 7: ref = [w['x1'] for w in nums]; print('colunas (x1):', [round(x) for x in ref])
            if ref is None: continue
            v = {}
            for w in nums:
                j = min(range(7), key=lambda i: abs(ref[i] - w['x1']))
                v[CL[j]] = int(w['text'].replace('.', ''))
            res[norm(nome)] = {'nome': nome, **v}
print('municípios', len(res))
for n in ('urai', 'tamarana', 'londrina', 'douradina', 'adrianopolis', 'carlopolis'): print(n, res.get(n))
json.dump({'fonte': f'SEAB/DERAL – Preços médios de terras agrícolas {ANO} (R$/ha, por classe de capacidade de uso)', 'url': URL, 'ano': ANO, 'classes': CL, 'municipios': res},
          open(f'{OUT}/precos_deral_{ANO}.json', 'w'), ensure_ascii=False)
