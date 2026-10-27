"""Indicador de pendências ambientais por imóvel do CAR (indicativo, a partir de bases públicas)."""
import json, re
from collections import Counter
from shapely.geometry import shape
from shapely.strtree import STRtree
imv = json.load(open('data/car/imoveis_londrina.geojson'))
sig = [shape(f['geometry']).buffer(0) for f in json.load(open('data/fundiario/sigef_londrina.geojson'))['features']]
arv = STRtree(sig)
import os
emb = [f for f in json.load(open('data/ibama/embargos_londrina.geojson'))['features'] if f['properties'].get('situacao') == 'Embargo vigente'] if os.path.exists('data/ibama/embargos_londrina.geojson') else []
embg = [shape(f['geometry']).buffer(0) for f in emb]; earv = STRtree(embg) if embg else None
num = lambda t: float(str(t or '0').replace('.', '').replace(',', '.') or 0)
cont = Counter(); classes = Counter()
for f in imv['features']:
    p = f['properties']
    for k in [k for k in p if k.startswith('Pendência') or k in ('pendencia_nivel', 'pendencias_n', 'Georreferenciamento SIGEF', 'Embargo IBAMA')]: p.pop(k)
    if p.get('situacao') == 'Cancelado':
        p['pendencia_nivel'] = 'Cancelado'; classes['Cancelado'] += 1; continue
    g = shape(f['geometry']).buffer(0); a = g.area or 1
    cob = sum(g.intersection(sig[i]).area for i in arv.query(g)) / a
    p['Georreferenciamento SIGEF'] = 'Certificado (≥ 50% da área)' if cob >= 0.5 else ('Parcial' if cob >= 0.1 else 'Não localizado no SIGEF')
    mf = num(p.get('Módulos fiscais')); veg = p.get('veg_nativa_pct')
    pend = []; pontos = 0
    sit = p.get('situacao', '')
    if sit == 'Analisado – regularização ambiental pendente': pend.append('CAR analisado: regularização ambiental pendente (PRA)'); pontos += 3
    elif sit == 'Analisado – notificação pendente': pend.append('CAR analisado: notificação do órgão sem resposta'); pontos += 2
    elif sit in ('Aguardando análise', 'Em análise'): pend.append('CAR ainda sem análise do órgão'); pontos += 0.5
    if earv is not None:
        tem = [emb[i]['properties']['nome'].replace('Embargo IBAMA ', '') for i in earv.query(g) if g.intersection(embg[i]).area > 0.02 * embg[i].area]
        if tem:
            p['Embargo IBAMA'] = 'Vigente: ' + ', '.join(tem[:3])
            pend.append(f"Área embargada pelo IBAMA ({', '.join(tem[:3])})"); pontos += 4
    if p.get('Alertas MapBiomas'): pend.append(f"{p['Alertas MapBiomas']} alerta(s) de desmatamento MapBiomas"); pontos += 3
    if veg is not None and mf > 4 and veg < 20: pend.append(f'Vegetação nativa de {veg:.1f}% (abaixo de 20%) em imóvel acima de 4 módulos – possível déficit de Reserva Legal'.replace('.', ',')); pontos += 2
    if mf > 4 and cob < 0.1: pend.append('Imóvel acima de 4 módulos sem georreferenciamento certificado no SIGEF'); pontos += 1
    nivel = 'Prioridade alta' if pontos >= 4 else ('Prioridade média' if pontos >= 2 else ('Atenção' if pontos > 0 else 'Sem pendência identificada'))
    p['pendencia_nivel'] = nivel; p['pendencias_n'] = len(pend)
    for i, t in enumerate(pend, 1): p[f'Pendência {i}'] = t
    classes[nivel] += 1
    for t in pend: cont[re.sub(r'^\d+ ', '', t.split(' (')[0].split(' de ')[0])] += 1
json.dump(imv, open('data/car/imoveis_londrina.geojson', 'w'), ensure_ascii=False, separators=(',', ':'))
print(classes); print(cont.most_common())
