"""Base temática do CAR (SICAR, PR) → GEOMETRIAS declaradas por imóvel, para os mapas do Raio-X.
Saída: <OUT>/<cod_ibge>/<h>.json  (h = 1º caractere hexadecimal do código do imóvel após o município)
  {"temas": [...], "i": {"PR-...": [[i_tema, tipo, coords], ...]}}
  tipo 0 = ponto [x, y]; 1 = polígono [[anel, ...], ...]; 2 = linha [[linha], ...]
  coordenadas inteiras em 1e-5 grau, cada anel/linha codificado por diferenças: [x0, y0, dx1, dy1, ...]
Uso: python3 tools/car_declarado_geo.py <pasta_saida>"""
import os, sys, json, re, zipfile, collections, time
import numpy as np, gdown, pyogrio, shapely

OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)
ARQ = {
    'USO_RESTRITO': '1Zu0pA1pEJ5kYXh2NtzByu-oO6VTqInNx',
    'AREA_POUSIO': '1buJTgY4FJJ_j9tZg6TDVcnMLns5aJ227',
    'SERVIDAO_ADMINISTRATIVA': '1PBd6qQyca2fyi1kVAMTNlXk3tVg5RAXg',
    'RESERVA_LEGAL': '1YfEji6UmXtckXwqnfn_fDu1XeNGK_VUr',
    'AREA_CONSOLIDADA': '1jQwCFkPbGFqr6Uq7-RRGfRCF6G_qD_sb',
    'VEGETACAO_NATIVA': '1syGmyebGKw3drJRz-fEAxlOUNhCGupPP',
    'HIDROGRAFIA': '1j_9y2iGqkdElmxX4aAU7avHCUI5jfGxn',
    'APPS': '18KF8eLSKrc7aN7TMyCgCodDG-o6D4o30',
}
# só os temas usados nos mapas (os subtipos de APP ficam de fora, exceto os que viram apontamento)
MANTER = re.compile(r"^(APP Total|Area de Preservacao Permanente a Recompor|Area de Preservacao Permanente de Nascentes|Area de Preservacao Permanente em area antropizada"
                    r"|Area Consolidada|Remanescente de Vegetacao Nativa|Reserva Legal|Area de Servidao Administrativa Total|Area de Uso Restrito|Area de Pousio"
                    r"|Curso d'agua|Lago ou lagoa|Reservatorio artificial)")
PONTO = re.compile(r'Nascentes')   # APP de nascente → só o centro (a nascente)
TOL = 1e-5  # ~1 m

def anel(cs):
    a = np.round(np.asarray(cs)[:, :2] * 1e5).astype(np.int64)
    if len(a) < 2: return None
    d = np.vstack([a[:1], np.diff(a, axis=0)])
    return d.ravel().tolist()

def codificar(g):
    t = g.geom_type
    if t == 'Point': return 0, [round(g.x * 1e5), round(g.y * 1e5)]
    if t in ('Polygon', 'MultiPolygon'):
        out = []
        for p in (g.geoms if t == 'MultiPolygon' else [g]):
            if p.is_empty: continue
            r = [anel(p.exterior.coords)] + [anel(i.coords) for i in p.interiors]
            r = [x for x in r if x]
            if r: out.append(r)
        return (1, out) if out else None
    if t in ('LineString', 'MultiLineString'):
        out = [[anel(l.coords)] for l in (g.geoms if t == 'MultiLineString' else [g]) if not l.is_empty]
        out = [x for x in out if x[0]]
        return (2, out) if out else None
    if t == 'GeometryCollection':
        for s in g.geoms:
            r = codificar(s)
            if r: return r
    return None

temas, ti = [], {}
acum = collections.defaultdict(lambda: collections.defaultdict(list))   # acum[mun][cod] = [[i, tipo, coords], ...]
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
        df = pyogrio.read_dataframe(f'/vsizip/{z}/{shp}', columns=['cod_imovel', 'nom_tema'], encoding='ISO-8859-1')
        df = df[df['nom_tema'].fillna('').str.strip().str.match(MANTER) & df.geometry.notna()]
        orig = np.asarray(df.geometry.values, dtype=object)
        geo = shapely.simplify(orig, TOL, preserve_topology=True)
        nt = df['nom_tema'].str.strip().values
        pt = np.array([bool(PONTO.search(x)) for x in nt], dtype=bool)
        if pt.any(): geo[pt] = shapely.point_on_surface(orig[pt])
        for c, t, g in zip(df['cod_imovel'].values, nt, geo):
            m = re.match(r'^\s*PR-?(\d{7})', str(c or ''), re.I)
            if not m or g is None or g.is_empty: continue
            r = codificar(g)
            if not r: continue
            if t not in ti: ti[t] = len(temas); temas.append(t)
            acum[m.group(1)][str(c).strip().upper()].append([ti[t], r[0], r[1]])
            cont[t] += 1
        print(f'  {shp}: {len(df)} feições mantidas, {time.time() - t0:.0f}s', flush=True)
        del df, geo, orig
    os.remove(z)
    resumo[nome] = dict(cont)
    print(f'{nome}: {sum(cont.values())} feições, {time.time() - t0:.0f}s', dict(cont), flush=True)

total = 0
for mun, imv in acum.items():
    os.makedirs(f'{OUT}/{mun}', exist_ok=True)
    grupos = collections.defaultdict(dict)
    for c, l in imv.items():
        h = (c.split('-')[2][:1] if c.count('-') >= 2 else '0').upper()
        grupos[h][c] = l
    for h, d in grupos.items():
        s = json.dumps({'temas': temas, 'i': d}, ensure_ascii=False, separators=(',', ':'))
        open(f'{OUT}/{mun}/{h}.json', 'w').write(s); total += len(s)
json.dump({'fonte': 'SICAR – base de downloads (temas declarados), PR', 'baixado_em': '2026-11-24', 'temas': temas, 'feicoes': resumo,
           'municipios': len(acum), 'bytes': total}, open(f'{OUT}/_info.json', 'w'), ensure_ascii=False, indent=1)
print('municípios', len(acum), 'tamanho total', round(total / 1e6), 'MB')
