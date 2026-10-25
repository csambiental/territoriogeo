"""Barragens cadastradas no IAT (Londrina) -> camada do mapa."""
import json
from collections import Counter
d = json.load(open('data/iat/barragens_0.geojson'))
num = lambda v, casas=2: '' if v in (None, '') or float(v) == 0 else f"{float(v):,.{casas}f}".replace(',', 'X').replace('.', ',').replace('X', '.')
out = []
for f in d['features']:
    p = f['properties']
    risco = (p.get('categoria_risco') or '').strip() or 'Não informado'
    dpa = (p.get('dpa') or '').strip() or 'Não informado'
    out.append({'type': 'Feature', 'geometry': f['geometry'], 'properties': {
        'nome': p.get('nome_barragem') or 'Barragem', 'risco': risco, 'dpa': dpa,
        'Código IAT': p.get('codigo_barragem') or '', 'Categoria de risco': risco, 'Dano potencial associado (DPA)': dpa,
        'Classificação': p.get('classificacao') or '', 'Fase': p.get('fase_vida') or '',
        'Finalidade': (p.get('finalidade_recurso') or '').replace(',', ', '), 'Tipo (material)': p.get('tipo_barragem_material') or '',
        'Altura (m)': num(p.get('altura_m'), 1), 'Área do reservatório (m²)': num(p.get('area_reservatorio_m2'), 0),
        'Volume (hm³)': num(p.get('volume_reservatorio_hm3'), 4)}})
json.dump({'type': 'FeatureCollection', 'features': out}, open('data/iat/barragens_londrina.geojson', 'w'), ensure_ascii=False, separators=(',', ':'))
print(len(out), Counter(x['properties']['risco'] for x in out), Counter(x['properties']['dpa'] for x in out), Counter(x['properties']['Classificação'] for x in out))
