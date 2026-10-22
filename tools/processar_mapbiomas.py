"""Prepara os dados do MapBiomas para o mapa: alertas por imóvel e faixas de vegetação nativa."""
import json, os
from collections import defaultdict
from shapely.geometry import shape, mapping
from shapely.ops import unary_union

DRIVER = {'agriculture': 'Agropecuária', 'urban_expansion': 'Expansão urbana', 'mining': 'Mineração', 'other': 'Outros',
          'river_lake_ocean': 'Rio/lago', 'natural_cause': 'Causa natural', 'reservoir': 'Reservatório', 'road': 'Estrada'}
limpa = lambda t: (t or '').strip('{}').replace('"', '').replace(',', ', ')
imv = json.load(open('data/car/imoveis_londrina.geojson'))
por_car = defaultdict(lambda: {'n': set(), 'ha': 0.0})
if os.path.exists('data/mapbiomas/alertas_londrina.geojson'):
    a = json.load(open('data/mapbiomas/alertas_londrina.geojson'))
    grupos = defaultdict(list); meta = {}
    for f in a['features']:
        p = f['properties']
        if 'Código do alerta' in p:  # já processado
            grupos[(p['Código do alerta'], p.get('Imóvel (CAR)', ''))].append(shape(f['geometry'])); meta[(p['Código do alerta'], p.get('Imóvel (CAR)', ''))] = p; continue
        k = (str(p['alert_code']), p.get('rural_property_code') or '')
        grupos[k].append(shape(f['geometry']))
        meta[k] = {'nome': f"Alerta {p['alert_code']}", 'Código do alerta': str(p['alert_code']),
                   'Detectado em': '/'.join(reversed((p.get('detected_at') or '').split('-'))),
                   'Publicado em': '/'.join(reversed((p.get('published_at') or '').split('-'))),
                   'Área do alerta (ha)': f"{p.get('area_ha') or 0:.2f}".replace('.', ','),
                   'Área no imóvel (ha)': f"{p.get('alert_car_area') or 0:.2f}".replace('.', ','),
                   'Vetor': DRIVER.get(p.get('deforestation_driver'), p.get('deforestation_driver') or ''),
                   'Fonte': limpa(p.get('sources')), 'Bioma': limpa(p.get('biomes')),
                   'Áreas especiais': limpa(p.get('crossed_special_territories')),
                   'Imóvel (CAR)': p.get('rural_property_code') or '', 'ano': (p.get('detected_at') or '')[:4],
                   'area_car': p.get('alert_car_area') or 0,
                   'link': f"https://plataforma.alerta.mapbiomas.org/alerta/{p['alert_code']}"}
    out = []
    for k, gs in grupos.items():
        p = meta[k]; out.append({'type': 'Feature', 'properties': p, 'geometry': mapping(unary_union(gs).buffer(0))})
        if p['Imóvel (CAR)']:
            por_car[p['Imóvel (CAR)']]['n'].add(p['Código do alerta']); por_car[p['Imóvel (CAR)']]['ha'] += float(p['area_car'])
    json.dump({'type': 'FeatureCollection', 'features': out}, open('data/mapbiomas/alertas_londrina.geojson', 'w'), ensure_ascii=False, separators=(',', ':'))
    print('alertas', len(out), 'pares alerta-imóvel;', len({p['Código do alerta'] for p in meta.values()}), 'alertas únicos')
for f in imv['features']:
    p = f['properties']
    for k in ('Alertas MapBiomas', 'Área de alertas (ha)'): p.pop(k, None)
    al = por_car.get(p['nome'])
    if al:
        p['Alertas MapBiomas'] = str(len(al['n'])); p['Área de alertas (ha)'] = f"{al['ha']:.2f}".replace('.', ',')
    v = p.get('veg_nativa_pct')
    p['faixa_veg'] = 'Sem dado' if v is None else ('Menos de 5%' if v < 5 else '5% a 10%' if v < 10 else '10% a 20%' if v < 20 else '20% ou mais')
json.dump(imv, open('data/car/imoveis_londrina.geojson', 'w'), ensure_ascii=False, separators=(',', ':'))
print('imóveis com alerta', len(por_car))
