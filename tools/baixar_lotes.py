"""Lotes urbanos, loteamentos e zoneamento do GeoLondrina (SIGLON, Prefeitura de Londrina) -> tiles vetoriais em data/urbano/tiles.
Roda no GitHub Actions (precisa de tippecanoe, shapely e pyproj)."""
import json, urllib.request, urllib.parse, time, subprocess, os, shutil, sys
from shapely.geometry import shape, mapping
from shapely.strtree import STRtree
from shapely.ops import transform
from pyproj import Transformer
S = 'https://geo.londrina.pr.gov.br/server/rest/services'
LOTES = f'{S}/Gerais/BCarSiglon/MapServer/0'
LOTEAM = f'{S}/Publico/Loteamentos/MapServer/0'
ZONA = f'{S}/Publico/IPPULLeisUsoOcupacaoSoloRevisado2023/MapServer/6'
GLEBAS = f'{S}/Publico/LotesGlebasSimbologia/MapServer/4'
def req(url, dados, tent=6):
    for t in range(tent):
        try:
            r = urllib.request.Request(url, data=urllib.parse.urlencode(dados).encode(), headers={'User-Agent': 'Mozilla/5.0'})
            return json.load(urllib.request.urlopen(r, timeout=120))
        except Exception as e:
            print('  tentativa', t + 1, e, flush=True); time.sleep(5 * (t + 1))
    raise SystemExit(f'falhou {url}')
def baixar(url, lote=1000):
    ids = sorted(req(url + '/query', {'where': '1=1', 'returnIdsOnly': 'true', 'f': 'json'})['objectIds'])
    print(url, len(ids), 'feições', flush=True)
    out = []
    for i in range(0, len(ids), lote):
        r = req(url + '/query', {'objectIds': ','.join(map(str, ids[i:i + lote])), 'outFields': '*', 'outSR': 4326, 'geometryPrecision': 7, 'f': 'geojson'})
        out += r.get('features', [])
        if i // lote % 20 == 0: print(' ', len(out), flush=True)
    return out
utm = Transformer.from_crs(4326, 31982, always_xy=True).transform
def area_m2(g): return transform(utm, g).area
def limpa(v): return v.strip() if isinstance(v, str) else v
os.makedirs('data/urbano', exist_ok=True); tmp = 'data/urbano/_tmp'; os.makedirs(tmp, exist_ok=True)
# zoneamento (Lei 12.236/2015, revisado)
zonas, zgeo = [], []
with open(f'{tmp}/zoneamento.geojsonl', 'w') as fz:
    for f in baixar(ZONA):
        if not f.get('geometry'): continue
        p = f['properties']; g = shape(f['geometry']).buffer(0)
        z = limpa(p.get('ZONEAMENTO')) or ''
        zonas.append(z); zgeo.append(g)
        fz.write(json.dumps({'type': 'Feature', 'geometry': mapping(g), 'properties': {'nome': f'Zona {z}', 'zona': z, 'link': p.get('PARÂMETRO') or p.get('LEI_12236_') or '', 'link_texto': 'Parâmetros da Lei 12.236/2015 ↗'}}, ensure_ascii=False) + '\n')
zarv = STRtree(zgeo)
# loteamentos
lnome, lgeo = [], []
with open(f'{tmp}/loteamentos.geojsonl', 'w') as fl:
    for f in baixar(LOTEAM):
        if not f.get('geometry'): continue
        p = f['properties']; g = shape(f['geometry']).buffer(0)
        n = limpa(p.get('LOTEAMENTO')) or ''
        fl.write(json.dumps({'type': 'Feature', 'geometry': mapping(g), 'properties': {'nome': n, 'Código do loteamento': p.get('CODLOTEAMENTO')}}, ensure_ascii=False) + '\n')
# glebas (lotes rurais/chácaras do cadastro municipal)
with open(f'{tmp}/glebas.geojsonl', 'w') as fg:
    for f in baixar(GLEBAS):
        if not f.get('geometry'): continue
        p = f['properties']; g = shape(f['geometry']).buffer(0)
        fg.write(json.dumps({'type': 'Feature', 'tippecanoe': {'minzoom': 12}, 'geometry': mapping(g), 'properties': {'nome': f"Lote {limpa(p.get('LOTE')) or '?'} – Gleba {limpa(p.get('GLEBA')) or '?'}", 'Gleba': limpa(p.get('GLEBA')), 'Área (m²)': round(area_m2(g))}}, ensure_ascii=False) + '\n')
# lotes urbanos
n = 0; sem_zona = 0
from collections import Counter
cz = Counter()
with open(f'{tmp}/lotes.geojsonl', 'w') as fo:
    for f in baixar(LOTES):
        if not f.get('geometry'): continue
        p = f['properties']; g = shape(f['geometry'])
        if not g.is_valid: g = g.buffer(0)
        c = g.representative_point()
        z = next((zonas[i] for i in zarv.query(c) if zgeo[i].contains(c)), '')
        if not z: sem_zona += 1
        cz[z] += 1
        q, l = limpa(p.get('QUADR_C')) or '?', limpa(p.get('LOTE_C')) or '?'
        props = {'nome': f'Quadra {q}, Lote {l}', 'Loteamento': limpa(p.get('NOME_LOTE')) or '', 'Quadra': q, 'Lote': l,
                 'Código do loteamento': p.get('CODLOT'), 'Área aproximada (m²)': round(area_m2(g)), 'Zoneamento': z}
        fo.write(json.dumps({'type': 'Feature', 'tippecanoe': {'minzoom': 14}, 'geometry': mapping(g), 'properties': {k: v for k, v in props.items() if v not in ('', None)}}, ensure_ascii=False) + '\n')
        n += 1
print('lotes', n, 'sem zona', sem_zona, cz.most_common(15), flush=True)
json.dump({'atualizado': time.strftime('%d/%m/%Y'), 'lotes': n, 'zonas': dict(cz.most_common())}, open('data/urbano/resumo.json', 'w'), ensure_ascii=False)
shutil.rmtree('data/urbano/tiles', ignore_errors=True)
cmd = ['tippecanoe', '-e', 'data/urbano/tiles', '--no-tile-compression', '-Z10', '-z16', '--force',
       '-L', json.dumps({'file': f'{tmp}/lotes.geojsonl', 'layer': 'lotes'}),
       '-L', json.dumps({'file': f'{tmp}/loteamentos.geojsonl', 'layer': 'loteamentos'}),
       '-L', json.dumps({'file': f'{tmp}/glebas.geojsonl', 'layer': 'glebas'}),
       '-L', json.dumps({'file': f'{tmp}/zoneamento.geojsonl', 'layer': 'zoneamento'}),
       '--no-feature-limit', '--no-tile-size-limit', '--detect-shared-borders', '--simplification=4']
print(' '.join(cmd), flush=True)
subprocess.run(cmd, check=True)
shutil.rmtree(tmp)
print('tiles:', sum(len(fs) for _, _, fs in os.walk('data/urbano/tiles')), 'arquivos')
