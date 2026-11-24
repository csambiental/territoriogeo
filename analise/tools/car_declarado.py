"""Base temática do CAR (SICAR, PR) → áreas DECLARADAS por imóvel, separadas por município.
Lê só os atributos (cod_imovel, nom_tema, num_area) de cada shapefile, sem geometria.
Saída: data/car_declarado/<cod_ibge>.json  = {"temas": [...], "imoveis": {"PR-...": [[i_tema, area_ha, n], ...]}}
Uso: python3 tools/car_declarado.py   (arquivos no Drive compartilhados por link)"""
import os, sys, json, re, zipfile, subprocess, collections, time
import gdown, pyogrio.raw as raw

ARQ = {  # tema do SICAR → id do arquivo no Drive (pasta "TESTE - BASE CAR 24-11-2026")
    'USO_RESTRITO': '1Zu0pA1pEJ5kYXh2NtzByu-oO6VTqInNx',
    'AREA_POUSIO': '1buJTgY4FJJ_j9tZg6TDVcnMLns5aJ227',
    'SERVIDAO_ADMINISTRATIVA': '1PBd6qQyca2fyi1kVAMTNlXk3tVg5RAXg',
    'RESERVA_LEGAL': '1YfEji6UmXtckXwqnfn_fDu1XeNGK_VUr',
    'AREA_CONSOLIDADA': '1jQwCFkPbGFqr6Uq7-RRGfRCF6G_qD_sb',
    'VEGETACAO_NATIVA': '1syGmyebGKw3drJRz-fEAxlOUNhCGupPP',
    'HIDROGRAFIA': '1j_9y2iGqkdElmxX4aAU7avHCUI5jfGxn',
    'APPS': '18KF8eLSKrc7aN7TMyCgCodDG-o6D4o30',
}
OUT = 'data/car_declarado'; os.makedirs(OUT, exist_ok=True)
temas = []; ti = {}
# acumulado[mun][cod_imovel][i_tema] = [area, n]
acum = collections.defaultdict(lambda: collections.defaultdict(dict))
resumo = {}
for nome, fid in ARQ.items():
    t0 = time.time(); z = f'/tmp/{nome}.zip'
    for tent in range(3):
        try:
            gdown.download(id=fid, output=z, quiet=True)
            if os.path.exists(z) and zipfile.is_zipfile(z): break
        except Exception as e: print('  download', nome, tent, e, flush=True)
        time.sleep(30)
    else:
        print('FALHOU download', nome, flush=True); continue
    with zipfile.ZipFile(z) as zf: shps = [i.filename for i in zf.infolist() if i.filename.lower().endswith('.shp')]
    cont = collections.Counter()
    for shp in shps:
        meta, _, _, campos = raw.read(f'/vsizip/{z}/{shp}', read_geometry=False, columns=['cod_imovel', 'nom_tema', 'num_area'], encoding='ISO-8859-1')
        cod, tem, area = campos
        for c, t, a in zip(cod, tem, area):
            m = re.match(r'^PR-(\d{7})-', c or '')
            if not m: continue
            t = (t or nome).strip()
            if t not in ti: ti[t] = len(temas); temas.append(t)
            i = ti[t]; d = acum[m.group(1)][c]
            v = d.get(i)
            if v: v[0] += float(a or 0); v[1] += 1
            else: d[i] = [float(a or 0), 1]
            cont[t] += 1
    os.remove(z)
    resumo[nome] = dict(cont)
    print(f'{nome}: {len(shps)} shp, {sum(cont.values())} feições, {time.time() - t0:.0f}s', dict(cont), flush=True)
for mun, imv in acum.items():
    json.dump({'temas': temas, 'imoveis': {c: [[i, round(v[0], 4), v[1]] for i, v in sorted(d.items())] for c, d in imv.items()}},
              open(f'{OUT}/{mun}.json', 'w'), ensure_ascii=False, separators=(',', ':'))
json.dump({'fonte': 'SICAR – base de downloads (temas declarados), PR', 'baixado_em': '2026-11-24', 'temas': temas, 'feicoes': resumo,
           'municipios': len(acum)}, open(f'{OUT}/_info.json', 'w'), ensure_ascii=False, indent=1)
print('municípios', len(acum), 'temas', temas)
